import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dsh, dshHome, dshPath } from './dsh.js';
import { dataRoot } from './store.js';
import { cleanEnvironment, runProcess } from './process.js';
import { safeError } from './engine.js';

type Client = 'codex' | 'antigravity';
type CliCommand =
  | { kind: 'models' }
  | { kind: 'install'; client: Client; selectedDsh: string };

const usage = '用法：node dist/install.js [--client codex|antigravity] [--dsh <dsh.cmd 路径>] 或 node dist/install.js models';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const pluginName = '@codex-dsh/bridge';
const files = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml'];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCliArgs(argv: string[]): CliCommand {
  if (argv.length === 1 && argv[0] === 'models') return { kind: 'models' };
  let client: Client | undefined;
  let dshArg: string | undefined;
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === '--client') {
      if (client !== undefined) throw new Error(`重复指定 --client 参数。\n${usage}`);
      const value = argv[++index];
      if (value !== 'codex' && value !== 'antigravity') throw new Error(`无效客户端：${value ?? '(空)'}。\n${usage}`);
      client = value;
    } else if (arg === '--dsh') {
      if (dshArg !== undefined) throw new Error(`重复指定 --dsh 参数。\n${usage}`);
      const value = argv[++index];
      if (!value || !value.trim() || value.startsWith('--')) throw new Error(`--dsh 必须提供非空路径。\n${usage}`);
      dshArg = value;
    } else {
      throw new Error(usage);
    }
  }
  return { kind: 'install', client: client ?? 'codex', selectedDsh: path.resolve(dshArg ?? dshPath) };
}

async function connectorCurrent(target: string, contents: Map<string, string>): Promise<boolean> {
  for (const [file, expected] of contents) {
    try { if (await readFile(path.join(target, file), 'utf8') !== expected) return false; }
    catch { return false; }
  }
  // 文件一致还不足以证明安装完成，desktop profile 必须链接该目录并挂载 bundle。
  const profileDir = path.join(dshHome, 'profiles', 'desktop');
  try {
    const profile = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>; dsh?: { profile?: { bundles?: string[] } };
    };
    const dependency = profile.dependencies?.[pluginName];
    if (typeof dependency !== 'string' || !dependency.startsWith('link:')) return false;
    const linked = path.resolve(profileDir, dependency.slice('link:'.length));
    return linked.toLowerCase() === target.toLowerCase() && Array.isArray(profile.dsh?.profile?.bundles) && profile.dsh.profile.bundles.includes(pluginName);
  } catch { return false; }
}

async function installDshPlugin(selectedDsh: string): Promise<void> {
  const target = path.join(dataRoot, `dsh-plugin-${version}`);
  const contents = new Map<string, string>();
  for (const file of files) contents.set(file, await readFile(path.join(root, 'dsh-plugin', file), 'utf8'));
  contents.set('bridge-config.json', JSON.stringify({ dataRoot }));
  const env = cleanEnvironment({ DSH_HOME: dshHome });
  const profilePath = path.join(dshHome, 'profiles', 'desktop', 'package.json');
  let profileText: string | undefined;
  try { profileText = await readFile(profilePath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (profileText !== undefined) {
    const legacyPluginName = '@codex-dsh/desktop-observer';
    const profile = JSON.parse(profileText) as { dependencies?: Record<string, string> };
    if (Object.hasOwn(profile.dependencies ?? {}, legacyPluginName)) {
      const result = await runProcess(selectedDsh, ['plugin', '--profile', 'desktop', 'remove', legacyPluginName], { env });
      if (result.code !== 0) throw new Error('旧 DSH 插件卸载失败：' + safeError(result.output).slice(-1500));
      const updatedProfile = JSON.parse(await readFile(profilePath, 'utf8')) as { dsh?: { profile?: { bundles?: string[] } } };
      if (updatedProfile.dsh?.profile?.bundles?.includes(legacyPluginName)) {
        console.warn('警告：DSH desktop profile 的 bundles 仍包含旧插件 @codex-dsh/desktop-observer，请通过 DSH 检查配置。');
      }
    }
  }
  if (await connectorCurrent(target, contents)) console.log('DSH 插件已安装，跳过。');
  else {
    await mkdir(target, { recursive: true });
    for (const [file, content] of contents) await writeFile(path.join(target, file), content, 'utf8');
    const result = await runProcess(selectedDsh, ['plugin', '--profile', 'desktop', 'add', target], { env });
    if (result.code !== 0) throw new Error('DSH 插件安装失败：' + safeError(result.output).slice(-1500));
    console.log('DSH 插件已安装。');
  }
}

async function installCodexMcp(selectedDsh: string, mcpPath: string): Promise<void> {
  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  let original: string | undefined;
  try { original = await readFile(configPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const section = /(^\[mcp_servers\.codex-dsh-bridge\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  const existingSection = section.exec(original ?? '')?.[0];
  // TOML 基本字符串会转义反斜杠，字面量字符串则保留原路径。
  if (existingSection?.includes(mcpPath) || existingSection?.includes(mcpPath.replace(/\\/g, '\\\\'))) {
    console.log('MCP 已指向当前入口，跳过。');
    return;
  }
  if (original !== undefined) await copyFile(configPath, `${configPath}.bak-${Date.now()}`);
  const command = process.platform === 'win32' ? 'codex.cmd' : 'codex';
  const codexEnv = cleanEnvironment({ CODEX_HOME: codexHome });
  if (existingSection !== undefined) {
    const result = await runProcess(command, ['mcp', 'remove', 'codex-dsh-bridge'], { env: codexEnv });
    if (result.code !== 0) throw new Error('旧 Codex MCP 注册移除失败：' + safeError(result.output).slice(-1500));
  }
  const args = ['mcp', 'add', 'codex-dsh-bridge', '--env', `DSH_PATH=${selectedDsh}`];
  if (process.env.DSH_HOME?.trim()) args.push('--env', `DSH_HOME=${dshHome}`);
  args.push('--', process.execPath, mcpPath);
  const result = await runProcess(command, args, { env: codexEnv });
  if (result.code !== 0) throw new Error('Codex MCP 注册失败：' + safeError(result.output).slice(-1500));
  const text = await readFile(configPath, 'utf8');
  if (!section.test(text)) throw new Error('无法定位新注册的 MCP 段，请手动设置 tool_timeout_sec = 660。');
  await writeFile(configPath, text.replace(section, (_match, heading: string, body: string) => heading + body.replace(/^tool_timeout_sec\s*=.*\r?\n/gm, '') + 'tool_timeout_sec = 660\n\n'), 'utf8');
  console.log('Codex MCP 已注册。');
}

async function installAntigravityMcp(selectedDsh: string, mcpPath: string): Promise<void> {
  const configPath = path.join(os.homedir(), '.gemini', 'config', 'mcp_config.json');
  let original: string | undefined;
  try { original = await readFile(configPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }

  // 拒绝含 BOM、注释、尾逗号或非对象结构的配置文件，避免静默覆盖用户配置。
  let parsed: Record<string, unknown> = {};
  if (original !== undefined) {
    let raw: unknown;
    try { raw = JSON.parse(original); }
    catch { throw new Error(`Antigravity MCP 配置文件解析失败（不支持 BOM、注释、尾逗号或无效 JSON），已保留原文件未修改：${configPath}`); }
    if (!isPlainObject(raw)) throw new Error(`Antigravity MCP 配置文件顶层必须是 JSON 对象，已保留原文件未修改：${configPath}`);
    parsed = raw;
  }

  const rawServers = parsed.mcpServers;
  if (rawServers !== undefined && !isPlainObject(rawServers)) {
    throw new Error(`Antigravity MCP 配置的 mcpServers 必须是对象，已保留原文件未修改：${configPath}`);
  }
  const existingServers = rawServers ?? {};
  const rawEntry = existingServers['codex-dsh-bridge'];
  if (rawEntry !== undefined && !isPlainObject(rawEntry)) {
    throw new Error(`Antigravity MCP 配置的 mcpServers.codex-dsh-bridge 必须是对象，已保留原文件未修改：${configPath}`);
  }
  const existingEntry = rawEntry ?? {};
  if (existingEntry.env !== undefined && !isPlainObject(existingEntry.env)) {
    throw new Error(`Antigravity MCP 配置的 codex-dsh-bridge.env 必须是对象，已保留原文件未修改：${configPath}`);
  }
  const existingEnv = (existingEntry.env ?? {}) as Record<string, unknown>;

  const hasDshHome = Boolean(process.env.DSH_HOME?.trim());
  const dshHomeMatches = hasDshHome
    ? existingEnv.DSH_HOME === dshHome
    : !Object.hasOwn(existingEnv, 'DSH_HOME');
  const hasConflictingTransport = ['url', 'serverUrl', 'headers', 'type'].some(key => Object.hasOwn(existingEntry, key));
  const alreadyCurrent = !hasConflictingTransport
    && existingEntry.command === process.execPath
    && Array.isArray(existingEntry.args)
    && existingEntry.args.length === 1
    && existingEntry.args[0] === mcpPath
    && existingEntry.disabled === false
    && existingEnv.DSH_PATH === selectedDsh
    && dshHomeMatches;

  if (alreadyCurrent) {
    console.log('Antigravity MCP 已指向当前配置，跳过。');
    return;
  }

  // 直接合并 JSON 保留同名条目的无关字段（如 timeoutSeconds、enabledTools、env.DSH_MODEL），同时清除冲突传输字段并同步 DSH_HOME。
  if (original !== undefined) await copyFile(configPath, `${configPath}.bak-${Date.now()}`);
  const mergedEnv: Record<string, unknown> = { ...existingEnv, DSH_PATH: selectedDsh };
  if (hasDshHome) mergedEnv.DSH_HOME = dshHome;
  else delete mergedEnv.DSH_HOME;
  const nextEntry: Record<string, unknown> = {
    ...existingEntry,
    command: process.execPath,
    args: [mcpPath],
    disabled: false,
    env: mergedEnv,
  };
  delete nextEntry.url;
  delete nextEntry.serverUrl;
  delete nextEntry.headers;
  delete nextEntry.type;
  const nextConfig: Record<string, unknown> = {
    ...parsed,
    mcpServers: {
      ...existingServers,
      'codex-dsh-bridge': nextEntry,
    },
  };
  await mkdir(path.dirname(configPath), { recursive: true });
  await writeFile(configPath, JSON.stringify(nextConfig, null, 2) + '\n', 'utf8');
  console.log('Antigravity MCP 已注册。');
}

async function installSkill(skillTarget: string): Promise<void> {
  const content = await readFile(path.join(root, 'skill', 'codex-dsh-bridge', 'SKILL.md'), 'utf8');
  let existing: string | undefined;
  try { existing = await readFile(skillTarget, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing !== content) {
    if (existing !== undefined) await copyFile(skillTarget, `${skillTarget}.bak-${Date.now()}`);
    await mkdir(path.dirname(skillTarget), { recursive: true });
    await writeFile(skillTarget, content, 'utf8');
  }
}

async function install(client: Client, selectedDsh: string): Promise<void> {
  await installDshPlugin(selectedDsh);
  const mcpPath = path.join(root, 'dist', 'mcp.js');
  if (client === 'codex') {
    await installCodexMcp(selectedDsh, mcpPath);
    await installSkill(path.join(os.homedir(), '.agents', 'skills', 'codex-dsh-bridge', 'SKILL.md'));
    console.log('Skill 已安装。请从托盘完整退出并重启 DSH，在 Codex 重载 MCP。');
  } else {
    await installAntigravityMcp(selectedDsh, mcpPath);
    await installSkill(path.join(os.homedir(), '.gemini', 'skills', 'codex-dsh-bridge', 'SKILL.md'));
    console.log('Skill 已安装。请从托盘完整退出并重启 DSH，在 Antigravity CLI（agy）重启会话或通过 /mcp 重载 MCP。');
  }
  console.log('可选设置 MCP 环境变量 DSH_MODEL；运行 node dist/install.js models 查找 provider/model 路由 ID。');
}

async function listModels(): Promise<void> {
  const catalog = await dsh.models();
  for (const group of catalog.groups) {
    for (const model of group.models) {
      const efforts = model.reasoning?.efforts.map(effort => effort.id).join(', ') ?? '';
      const isDefault = group.id === catalog.default.provider && model.id === catalog.default.model;
      console.log(`${group.id}/${model.id}  [${efforts}]${isDefault ? '  (DSH 默认)' : ''}`);
    }
  }
  for (const failure of catalog.failures) console.error(`${failure.id}: ${failure.message}`);
}

try {
  const command = parseCliArgs(process.argv.slice(2));
  if (command.kind === 'models') await listModels();
  else await install(command.client, command.selectedDsh);
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
