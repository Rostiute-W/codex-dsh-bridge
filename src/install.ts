import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { dsh, dshHome, dshPath } from './dsh.js';
import { dataRoot } from './store.js';
import { cleanEnvironment, runProcess } from './process.js';
import { safeError } from './engine.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')) as { version: string };
const pluginName = '@codex-dsh/bridge';
const files = ['index.js', 'client.js', 'package.json', 'cordis.patch.yml'];

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

async function install(selectedDsh: string): Promise<void> {
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

  const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
  const configPath = path.join(codexHome, 'config.toml');
  let original: string | undefined;
  try { original = await readFile(configPath, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  const section = /(^\[mcp_servers\.codex-dsh-bridge\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
  const existingSection = section.exec(original ?? '')?.[0];
  const mcpPath = path.join(root, 'dist', 'mcp.js');
  // TOML 基本字符串会转义反斜杠，字面量字符串则保留原路径。
  if (existingSection?.includes(mcpPath) || existingSection?.includes(mcpPath.replace(/\\/g, '\\\\'))) console.log('MCP 已指向当前入口，跳过。');
  else {
    if (original !== undefined) await copyFile(configPath, `${configPath}.bak-${Date.now()}`);
    const command = process.platform === 'win32' ? 'codex.cmd' : 'codex';
    const codexEnv = cleanEnvironment({ CODEX_HOME: codexHome });
    if (existingSection !== undefined) {
      const result = await runProcess(command, ['mcp', 'remove', 'codex-dsh-bridge'], { env: codexEnv });
      if (result.code !== 0) throw new Error('旧 Codex MCP 注册移除失败：' + safeError(result.output).slice(-1500));
    }
    const args = ['mcp', 'add', 'codex-dsh-bridge', '--env', `DSH_PATH=${selectedDsh}`];
    if (process.env.DSH_HOME) args.push('--env', `DSH_HOME=${dshHome}`);
    args.push('--', process.execPath, mcpPath);
    const result = await runProcess(command, args, { env: codexEnv });
    if (result.code !== 0) throw new Error('Codex MCP 注册失败：' + safeError(result.output).slice(-1500));
    const text = await readFile(configPath, 'utf8');
    if (!section.test(text)) throw new Error('无法定位新注册的 MCP 段，请手动设置 tool_timeout_sec = 660。');
    await writeFile(configPath, text.replace(section, (_match, heading: string, body: string) => heading + body.replace(/^tool_timeout_sec\s*=.*\r?\n/gm, '') + 'tool_timeout_sec = 660\n\n'), 'utf8');
    console.log('Codex MCP 已注册。');
  }

  const skillTarget = path.join(os.homedir(), '.agents', 'skills', 'codex-dsh-bridge', 'SKILL.md');
  const content = await readFile(path.join(root, 'skill', 'codex-dsh-bridge', 'SKILL.md'), 'utf8');
  let existing: string | undefined;
  try { existing = await readFile(skillTarget, 'utf8'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (existing !== content) {
    if (existing !== undefined) await copyFile(skillTarget, `${skillTarget}.bak-${Date.now()}`);
    await mkdir(path.dirname(skillTarget), { recursive: true });
    await writeFile(skillTarget, content, 'utf8');
  }
  console.log('Skill 已安装。请从托盘完整退出并重启 DSH，在 Codex 重载 MCP。');
  console.log('可选设置 MCP 环境变量 DSH_MODEL；运行 node dist/install.js models 查找 provider/model 路由 ID。');
}

try {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === 'models') {
    const catalog = await dsh.models();
    for (const group of catalog.groups) {
      for (const model of group.models) {
        const efforts = model.reasoning?.efforts.map(effort => effort.id).join(', ') ?? '';
        const isDefault = group.id === catalog.default.provider && model.id === catalog.default.model;
        console.log(`${group.id}/${model.id}  [${efforts}]${isDefault ? '  (DSH 默认)' : ''}`);
      }
    }
    for (const failure of catalog.failures) console.error(`${failure.id}: ${failure.message}`);
  } else if (!args.length || args.length === 2 && args[0] === '--dsh') {
    await install(path.resolve(args[1] ?? dshPath));
  } else throw new Error('用法：node dist/install.js [--dsh <dsh.cmd 路径>] 或 node dist/install.js models');
} catch (error) { console.error(safeError(error)); process.exitCode = 1; }
