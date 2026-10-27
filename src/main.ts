import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage, clipboard, nativeTheme } from 'electron';
import { mkdir, readFile, writeFile, copyFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { settingsSchema, safeError } from './model.js';
import { servePipe } from './rpc.js';
import { runSmoke } from './smoke.js';
import { runProcess, resolveCodexExecutable, cleanEnvironment } from './process.js';
import { readRegistration, registrationState } from './integration.js';
import { exportObserver } from './observer.js';
import { openDesktopChat, getDesktopModels, validateDesktopModel } from './desktop.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const smoke = process.argv.includes('--smoke-test');
const smokeOutput = process.env.BRIDGE_SMOKE_OUTPUT ?? path.resolve(root, '..');
const dataRoot = smoke ? (process.env.BRIDGE_SMOKE_DATA ?? path.join(app.isPackaged ? path.dirname(process.execPath) : root, '.test-data', `smoke-${process.pid}`)) : path.join(process.env.LOCALAPPDATA ?? app.getPath('appData'), 'CodexDshBridge');
app.setPath('userData', dataRoot);
if (smoke) process.env.BRIDGE_INSTANCE = `smoke-${process.pid}`;
const helper = app.isPackaged ? path.join(process.resourcesPath, 'pipe-host.exe') : path.join(root, 'build', 'pipe-host.exe');
process.env.BRIDGE_JOB_HOST = helper;
let win: BrowserWindow | undefined;
let tray: Tray | undefined;
let exiting = false;
let engine: Engine;
let stopPipe: (() => void) | undefined;
let mcpLastCall: string | undefined;
let serviceError: string | undefined;
let integrationBusy = false;
let observerInstallBusy = false;
let secondInstances = 0;
const page = path.join(here, 'ui', 'index.html');
const pageUrl = pathToFileURL(page).href;

async function nativeCodexPath(configured = 'codex'): Promise<string> {
  try { return await resolveCodexExecutable(configured); } catch { return configured; }
}
function showWindow(): void { if (!win) return; win.show(); if (win.isMinimized()) win.restore(); win.focus(); }
function createWindow(): void {
  win = new BrowserWindow({ width: 1240, height: 830, minWidth: 960, minHeight: 680, show: false,
    title: 'Codex DSH Bridge', backgroundColor: nativeTheme.shouldUseDarkColors ? '#0c0e13' : '#f4f5f8', icon: path.join(here, 'ui', 'icon.png'),
    webPreferences: { preload: path.join(here, 'ui', 'preload.cjs'), nodeIntegration: false, contextIsolation: true, sandbox: true, webSecurity: true },
  });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('will-navigate', (event, url) => { if (url !== pageUrl) event.preventDefault(); });
  win.webContents.session.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false));
  win.on('close', event => { if (!exiting) { event.preventDefault(); win!.hide(); } });
  win.once('ready-to-show', () => { if (!process.argv.includes('--background') && !smoke) showWindow(); });
  void win.loadFile(page);
}
function integration(): { toml: string; launch: string[]; env: Record<string, string>; skillSource: string } {
  const launch = [path.join(here, 'mcp.js')];
  const env = { ELECTRON_RUN_AS_NODE: '1', BRIDGE_PIPE_HOST: helper, BRIDGE_APP_EXECUTABLE: process.execPath, BRIDGE_APP_ROOT: root,
    ...(app.isPackaged ? {} : { BRIDGE_DEVELOPMENT: '1' }) };
  const quoted = (text: string) => JSON.stringify(text);
  return { toml: `[mcp_servers.codex-dsh-bridge]\ncommand = ${quoted(process.execPath)}\nargs = [${launch.map(quoted).join(', ')}]\ntool_timeout_sec = 660\n\n[mcp_servers.codex-dsh-bridge.env]\n${Object.entries(env).map(([key, value]) => `${key} = ${quoted(value)}`).join('\n')}\n`, launch, env,
    skillSource: path.join(root, 'skill', 'codex-dsh-bridge', 'SKILL.md') };
}
async function state(): Promise<unknown> {
  const config = integration();
  const registration = await readRegistration(path.join(codexHome(), 'config.toml'), { command: process.execPath, args: config.launch, env: config.env });
  const shownRoot = await realpath(dataRoot).catch(() => dataRoot);
  return { tasks: engine.store.tasks, settings: engine.store.settings,
    busy: engine.isActive(), mcpLastCall, registration, serviceError, dataRoot: shownRoot, version: app.getVersion(), integration: config.toml };
}
// Only lifecycle surfaces the installed DSH actually documents; nothing here may force an end.
/**
 * Lifecycle evidence, existing install, 2026-10-17, DeepSeek Harness 0.2.0-rc.2 (build 04f392c9):
 * - No `dsh` lifecycle/quit/restart subcommand exists. `dsh --help` lists only profiles and `dsh plugin`;
 *   `dsh --profile desktop --help` answers `profile "desktop" is managed exclusively by the Electron
 *   application`. That profile's launcher (@deepseek-ai/dsh-desktop-host lib/index.js) accepts only
 *   `shutdown`, `quit-inspection` and `update-tasks`, and only over stdout IPC from the shell that
 *   spawned it, so no external caller can reach them.
 * - The Electron shell (lib/main.js of @deepseek-ai/dsh-desktop) is the only owner of quit and restart.
 *   Quit runs once behind its own native confirmation fed by the Host's task inspection; there is no
 *   quit/restart IPC channel and no quit command-line flag, `dsh://open` and a second launch only focus
 *   the window, and `app.relaunch()` is reached only by update, crash recovery and the development menu.
 * - So no supported external restart exists and none is invented: the result states the manual step
 *   instead of ending a process or answering a DSH dialog on the user's behalf.
 */
const connectorFiles = ['package.json', 'index.js', 'native.js', 'client.js', 'cordis.patch.yml'];
const dshHome = (settings: { dshHome: string }) => settings.dshHome || process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
/** Same files exportObserver writes, compared so a repeat request installs nothing again. */
async function connectorCurrent(target: string, home: string): Promise<boolean> {
  const expected: [string, string][] = [];
  for (const file of connectorFiles) expected.push([file, await readFile(path.join(root, 'dsh-observer', file), 'utf8')]);
  expected.push(['bridge-config.json', JSON.stringify({ pipeHost: helper, dataRoot: path.dirname(target) })]);
  for (const [file, content] of expected) {
    try { if (await readFile(path.join(target, file), 'utf8') !== content) return false; }
    catch { return false; }
  }
  // Matching files alone cannot prove the profile still links this exact target and mounts the bundle.
  const profileDir = path.join(home, 'profiles', 'desktop');
  try {
    const profile = JSON.parse(await readFile(path.join(profileDir, 'package.json'), 'utf8')) as
      { dependencies?: Record<string, unknown>; dsh?: { profile?: { bundles?: unknown } } };
    const dependency = profile.dependencies?.['@codex-dsh/desktop-observer'];
    if (typeof dependency !== 'string' || !dependency.startsWith('link:')) return false;
    // A relative link resolves against the desktop profile, never the Bridge process directory.
    const linked = path.resolve(profileDir, dependency.slice('link:'.length));
    if (linked.toLowerCase() !== path.resolve(target).toLowerCase()) return false;
    const bundles = profile.dsh?.profile?.bundles;
    return Array.isArray(bundles) && bundles.includes('@codex-dsh/desktop-observer');
  } catch { return false; }
}
async function installDshObserver(): Promise<string> {
  if (observerInstallBusy) throw new Error('DSH 原生对话连接正在安装，请等待。');
  observerInstallBusy = true;
  try {
    const settings = engine.store.settings;
    const target = path.join(dataRoot, `dsh-desktop-connector-${app.getVersion()}`);
    const current = await connectorCurrent(target, dshHome(settings));
    if (!current) {
      await exportObserver(root, target, helper);
      const result = await runProcess(settings.dshPath, ['plugin', '--profile', 'desktop', 'add', target], { env: cleanEnvironment(settings.dshHome ? { DSH_HOME:settings.dshHome } : {}), timeoutMs:120000 });
      if (result.code !== 0) throw new Error(`DSH 原生对话连接安装失败：${safeError(result.output).slice(-1500)}`);
    }
    return `${current ? 'DSH 原生对话连接已安装，无需重复安装。' : 'DSH 原生对话连接已安装。'}Bridge 目前不会自动退出或重启 DSH：所检查的 DSH 0.2.0-rc.2 没有可从外部调用的正常退出或重启接口。请在有任务运行时先完成或取消任务，再从 DSH 托盘完整退出并重新打开；Bridge 不会强制结束进程，也不会替你确认 DSH 的退出提示。新连接在 DSH 重新打开后生效。`;
  } finally { observerInstallBusy = false; }
}
async function quit(): Promise<void> {
  if (exiting) return;
  if (engine?.isActive()) {
    const response = await dialog.showMessageBox(win!, { type: 'question', title: '退出软件', message: '有任务正在运行。取消执行并保存现场后退出？', buttons: ['继续运行', '取消并退出'], defaultId: 0, cancelId: 0 });
    if (response.response !== 1) return;
  }
  exiting = true; await engine?.shutdown(); stopPipe?.(); tray?.destroy(); app.quit();
}
const codexHome = () => process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
// sha256 (LF line endings) of shipped Skill originals that may be backed up and replaced: 0.1.9 and one verified earlier release.
const knownSkillOriginals = new Set([
  '7072ae3ec20c25b6609f659df3731d012712d100e73f7025e204aa0f838f0df3',
  '2ee799b5dbd64d98cb877f35cab7def1210ef89561b2cc6ec3e0ef93afdc580c',
]);
/** Writes the shipped Skill. A different existing file is replaced only when it is a known original; user edits and links are refused. */
async function installSkill(target: string, content: string): Promise<void> {
  try {
    const existing = await readFile(target, 'utf8');
    if (existing !== content) {
      const info = await lstat(target);
      const previous = createHash('sha256').update(existing.replace(/\r\n/g, '\n')).digest('hex');
      if (info.isSymbolicLink() || info.nlink > 1 || !knownSkillOriginals.has(previous)) throw new Error('已有同名 Skill 且内容不同。请先备份或更名，不会覆盖用户文件。');
      await copyFile(target, `${target}.bridge-backup-${Date.now()}`);
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content);
}
async function installCodex(): Promise<string> {
  if (integrationBusy) throw new Error('接入配置正在安装，请等待。');
  integrationBusy = true;
  try {
    const config = integration();
    const configPath = path.join(codexHome(), 'config.toml');
    let originalConfig = '';
    try { originalConfig = await readFile(configPath, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    const registration = registrationState(originalConfig, { command: process.execPath, args: config.launch, env: config.env });
    if (registration.status === 'conflict' || registration.status === 'error') throw new Error(registration.message);
    const skillTarget = path.join(smoke ? dataRoot : os.homedir(), '.agents', 'skills', 'codex-dsh-bridge', 'SKILL.md');
    await installSkill(skillTarget, await readFile(config.skillSource, 'utf8'));
    if (registration.status === 'registered') return 'MCP 已注册，Skill 已核对，无需重复安装。请重载 Codex MCP；连接后这里会显示最近调用时间。';
    if (originalConfig) await copyFile(configPath, `${configPath}.bridge-backup-${Date.now()}`);
    const args = ['mcp', 'add', 'codex-dsh-bridge'];
    for (const [key, value] of Object.entries(config.env)) args.push('--env', `${key}=${value}`);
    args.push('--', process.execPath, ...config.launch);
    const result = await runProcess(await resolveCodexExecutable(engine.store.settings.codexPath), args, { env: cleanEnvironment({ CODEX_HOME: codexHome() }), timeoutMs: 30000 });
    if (result.code !== 0) throw new Error('Codex MCP 注册失败。请使用接入页中的手动配置。');
    // codex mcp add has no timeout flag. Update only the bridge's own new section.
    const text = await readFile(configPath, 'utf8');
    const section = /(^\[mcp_servers\.codex-dsh-bridge\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
    if (!section.test(text)) throw new Error('MCP 已注册，但没有定位到超时设置。请在手动配置中设置 tool_timeout_sec = 660。');
    await writeFile(configPath, text.replace(section, (_match, heading: string, body: string) => heading + body.replace(/^tool_timeout_sec\s*=.*\r?\n/gm, '') + 'tool_timeout_sec = 660\n\n'));
    return '已安装 MCP 与 Skill。请重新打开 Codex 聊天或重载 MCP，然后使用 $codex-dsh-bridge。';
  } finally { integrationBusy = false; }
}
const taskParams = z.object({ taskId: z.string().uuid(), permissionId: z.string().uuid().optional(), optionId: z.string().nullable().optional(), instruction: z.string().max(16000).optional() }).strict();
const taskOf = (params: unknown) => engine.task(taskParams.parse(params).taskId);
/** Every renderer operation. The keys are the allowlist; preload.cjs repeats it because the sandboxed preload cannot import this module. */
const handlers: Record<string, (params: unknown) => unknown> = {
  state: () => state(),
  integration: () => integration().toml,
  copyIntegration: () => { clipboard.writeText(integration().toml); return 'MCP 配置已复制'; },
  dshModels: params => getDesktopModels({ ...engine.store.settings, ...settingsSchema.pick({ dshPath: true, dshHome: true }).parse(params) }),
  saveSettings: async params => {
    if (engine.isActive()) throw new Error('请等待任务结束后修改运行设置。');
    const { settings } = z.object({ settings: settingsSchema }).strict().parse(params);
    if (settings.executionMode === 'desktop' && settings.nativeModel) validateDesktopModel(settings.nativeModel, await getDesktopModels(settings));
    await engine.store.saveSettings(settings); return state();
  },
  pick: async params => {
    const kind = z.enum(['dsh', 'home']).parse(params);
    const selected = await dialog.showOpenDialog(win!, { title: kind === 'home' ? '选择 DSH 数据目录（可选）' : '选择 DSH 命令入口', properties: kind === 'home' ? ['openDirectory'] : ['openFile'] });
    return selected.canceled ? '' : selected.filePaths[0];
  },
  installDshObserver: () => installDshObserver(),
  installCodex: () => installCodex(),
  permission: async params => {
    const { taskId, permissionId, optionId } = taskParams.parse(params);
    await engine.answerPermission(taskId, z.string().uuid().parse(permissionId), z.string().nullable().parse(optionId)); return '已处理权限请求';
  },
  resume: params => { const { taskId, instruction } = taskParams.parse(params); return engine.submit({ operation: 'resume', taskId, instruction }); },
  revise: params => engine.submit({ operation: 'revise', taskId: taskParams.parse(params).taskId }),
  cancel: params => engine.cancel(taskParams.parse(params).taskId),
  revalidate: params => engine.revalidate(taskParams.parse(params).taskId),
  copyTaskId: params => { clipboard.writeText(taskParams.parse(params).taskId); return '任务 ID 已复制'; },
  openWorktree: async params => {
    const task = taskOf(params);
    if (!task.worktree) throw new Error('尚未创建工作目录。');
    await shell.openPath(task.worktree); return '已打开工作目录';
  },
  openDshChat: async params => { await openDesktopChat(taskOf(params), engine.store.settings); return '已请求 DSH 打开原生对话。'; },
};
function installIpc(): void {
  ipcMain.handle('bridge:invoke', async (event, input: unknown) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith(pageUrl)) throw new Error('非法界面请求。');
    const { method, params } = z.object({ method: z.string(), params: z.unknown().optional() }).strict().parse(input);
    if (!Object.hasOwn(handlers, method)) throw new Error('未知操作。');
    try { return await handlers[method]!(params); }
    catch (error) { throw new Error(safeError(error)); }
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', (_event, args) => { secondInstances++; if (!args.includes('--background')) showWindow(); });
  app.on('before-quit', event => { if (!exiting) { event.preventDefault(); void quit(); } });
  app.on('window-all-closed', () => {});
  app.whenReady().then(async () => {
    try {
      if (process.platform !== 'win32') throw new Error('第一版仅支持 Windows。');
      const store = new Store(dataRoot); await store.load();
      const codexPath = await nativeCodexPath(store.settings.codexPath);
      if (codexPath !== store.settings.codexPath) await store.saveSettings({ ...store.settings, codexPath });
      engine = new Engine(store); await engine.recover();
      engine.on('persistence-error', error => { serviceError = String(error); });
      await mkdir(dataRoot, { recursive: true });
      if (smoke) {
        process.env.CODEX_HOME = path.join(dataRoot, 'codex-home');
        await mkdir(process.env.CODEX_HOME, { recursive: true });
        await writeFile(path.join(process.env.CODEX_HOME, 'config.toml'), integration().toml);
      }
      stopPipe = await servePipe(helper, engine, () => { mcpLastCall = new Date().toISOString(); });
      installIpc(); createWindow();
      tray = new Tray(nativeImage.createFromPath(path.join(here, 'ui', 'icon.png')));
      tray.setToolTip('Codex DSH Bridge'); tray.on('click', showWindow);
      tray.setContextMenu(Menu.buildFromTemplate([{ label: '打开任务窗口', click: showWindow }, { label: '退出', click: () => { void quit(); } }]));
      Menu.setApplicationMenu(null);
      if (smoke) {
        await runSmoke({ win: win!, engine, dataRoot, root, here, helper, smokeOutput, showWindow, secondInstances: () => secondInstances });
        await engine.shutdown(); stopPipe(); exiting = true; app.exit(0);
      }
    } catch (error) {
      if (smoke) { console.error(safeError(error)); exiting = true; app.exit(1); }
      else { dialog.showErrorBox('Codex DSH Bridge 启动失败', safeError(error)); exiting = true; app.quit(); }
    }
  });
}
