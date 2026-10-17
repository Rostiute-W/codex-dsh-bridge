import { app, BrowserWindow, Tray, Menu, dialog, ipcMain, shell, nativeImage, clipboard } from 'electron';
import { mkdir, readFile, writeFile, copyFile, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { z } from 'zod';
import { randomUUID, createHash } from 'node:crypto';
import { Store } from './store.js';
import { Engine } from './engine.js';
import { settingsSchema, safeError } from './model.js';
import { servePipe, pipeRequest, identity, pipeName, pipePath } from './rpc.js';
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
    title: 'Codex DSH Bridge', backgroundColor: '#fafafa', icon: path.join(here, 'ui', 'icon.png'),
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
  const registration = await readRegistration(path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex'), 'config.toml'), { command: process.execPath, args: config.launch, env: config.env });
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
const methods = new Set(['state', 'saveSettings', 'dshModels', 'pick', 'permission', 'resume', 'revalidate', 'revise', 'cancel', 'openWorktree', 'openDshChat', 'integration', 'installCodex', 'installDshObserver', 'copyTaskId', 'copyIntegration']);
function installIpc(): void {
  ipcMain.handle('bridge:invoke', async (event, input: unknown) => {
    if (!win || event.sender !== win.webContents || event.senderFrame !== win.webContents.mainFrame || !event.senderFrame.url.startsWith(pageUrl)) throw new Error('非法界面请求。');
    const { method, params } = z.object({ method: z.string(), params: z.unknown().optional() }).strict().parse(input);
    if (!methods.has(method)) throw new Error('未知操作。');
    try {
      if (method === 'state') return await state();
      if (method === 'integration') return integration().toml;
      if (method === 'copyIntegration') { clipboard.writeText(integration().toml); return 'MCP 配置已复制'; }
      if (method === 'dshModels') {
        const paths = settingsSchema.pick({dshPath:true,dshHome:true}).parse(params);
        return await getDesktopModels({...engine.store.settings,...paths});
      }
      if (method === 'saveSettings') {
        if (engine.isActive()) throw new Error('请等待任务结束后修改运行设置。');
        const { settings } = z.object({ settings: settingsSchema }).strict().parse(params);
        if (settings.executionMode === 'desktop' && settings.nativeModel)
          validateDesktopModel(settings.nativeModel, await getDesktopModels(settings));
        await engine.store.saveSettings(settings); return await state();
      }
      if (method === 'pick') {
        const kind = z.enum(['dsh', 'home']).parse(params);
        const selected = await dialog.showOpenDialog(win!, { title: kind === 'home' ? '选择 DSH 数据目录（可选）' : '选择 DSH 命令入口', properties: kind === 'home' ? ['openDirectory'] : ['openFile'] });
        return selected.canceled ? '' : selected.filePaths[0];
      }
      if (method === 'installDshObserver') return await installDshObserver();
      if (method === 'installCodex') {
        if (integrationBusy) throw new Error('接入配置正在安装，请等待。');
        integrationBusy = true;
        try {
          const config = integration();
          const codexHome = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
          const configPath = path.join(codexHome, 'config.toml');
          let originalConfig = '';
          try { originalConfig = await readFile(configPath, 'utf8'); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          const registration = registrationState(originalConfig, { command:process.execPath, args:config.launch, env:config.env });
          if (registration.status === 'conflict' || registration.status === 'error') throw new Error(registration.message);
          const skillTarget = path.join(smoke ? dataRoot : os.homedir(), '.agents', 'skills', 'codex-dsh-bridge', 'SKILL.md');
          const content = await readFile(config.skillSource, 'utf8');
          try {
            const existing = await readFile(skillTarget, 'utf8');
            if (existing !== content) {
              const info=await lstat(skillTarget);
              const previous=createHash('sha256').update(existing.replace(/\r\n/g,'\n')).digest('hex');
              if(info.isSymbolicLink()||info.nlink>1||previous!=='7072ae3ec20c25b6609f659df3731d012712d100e73f7025e204aa0f838f0df3')throw new Error('已有同名 Skill 且内容不同。请先备份或更名，不会覆盖用户文件。');
              await copyFile(skillTarget,`${skillTarget}.bridge-backup-${Date.now()}`);
            }
          }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
          await mkdir(path.dirname(skillTarget), { recursive: true }); await writeFile(skillTarget, content);
          if (registration.status === 'registered') return 'MCP 已注册，Skill 已核对，无需重复安装。请重载 Codex MCP；连接后这里会显示最近调用时间。';
          if (originalConfig) await copyFile(configPath, `${configPath}.bridge-backup-${Date.now()}`);
          const args = ['mcp', 'add', 'codex-dsh-bridge'];
          for (const [key, value] of Object.entries(config.env)) args.push('--env', `${key}=${value}`);
          args.push('--', process.execPath, ...config.launch);
          const result = await runProcess(await resolveCodexExecutable(engine.store.settings.codexPath), args, { env: cleanEnvironment({ CODEX_HOME: codexHome }), timeoutMs: 30000 });
          if (result.code !== 0) throw new Error('Codex MCP 注册失败。请使用接入页中的手动配置。');
          // codex mcp add has no timeout flag. Update only the bridge's own new section.
          const text = await readFile(configPath, 'utf8');
          const section = /(^\[mcp_servers\.codex-dsh-bridge\]\r?\n)([\s\S]*?)(?=^\[|$(?![\s\S]))/m;
          if (!section.test(text)) throw new Error('MCP 已注册，但没有定位到超时设置。请在手动配置中设置 tool_timeout_sec = 660。');
          await writeFile(configPath, text.replace(section, (_match, heading: string, body: string) => heading + body.replace(/^tool_timeout_sec\s*=.*\r?\n/gm, '') + 'tool_timeout_sec = 660\n\n'));
          return '已安装 MCP 与 Skill。请重新打开 Codex 聊天或重载 MCP，然后使用 $codex-dsh-bridge。';
        } finally { integrationBusy = false; }
      }
      const payload = z.object({ taskId: z.string().uuid(), permissionId: z.string().uuid().optional(), optionId: z.string().nullable().optional(), instruction: z.string().max(16000).optional() }).strict().parse(params);
      if (method === 'permission') {
        await engine.answerPermission(payload.taskId, z.string().uuid().parse(payload.permissionId), z.string().nullable().parse(payload.optionId)); return '已处理权限请求';
      }
      if (method === 'resume') return await engine.submit({ operation: 'resume', taskId: payload.taskId, instruction: payload.instruction });
      if (method === 'revise') return await engine.submit({ operation: 'revise', taskId: payload.taskId });
      if (method === 'cancel') return await engine.cancel(payload.taskId);
      if (method === 'revalidate') return await engine.revalidate(payload.taskId);
      if (method === 'copyTaskId') { clipboard.writeText(payload.taskId); return '任务 ID 已复制'; }
      const task = engine.task(payload.taskId);
      if (method === 'openWorktree') { if (!task.worktree) throw new Error('尚未创建工作目录。'); await shell.openPath(task.worktree); return '已打开工作目录'; }
      if (method === 'openDshChat') { await openDesktopChat(task,engine.store.settings); return '已请求 DSH 打开原生对话。'; }
      throw new Error('未知操作。');
    } catch (error) { throw new Error(safeError(error)); }
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
        if (win!.webContents.isLoadingMainFrame()) await new Promise<void>(resolve => win!.webContents.once('did-finish-load', resolve));
        await new Promise(resolve => setTimeout(resolve, 500));
        const result = await win!.webContents.executeJavaScript('({title:document.title, bridge:typeof window.bridge.invoke, text:document.body.innerText})');
        if (result.bridge !== 'function' || !result.text.includes('任务')) throw new Error('界面启动验证失败。');
        if (!await win!.webContents.executeJavaScript("document.querySelector('#connection-state').textContent.includes('MCP 已注册')")) throw new Error('已注册 MCP 仍然显示等待接入。');
        const configFile = path.join(process.env.CODEX_HOME!, 'config.toml');
        const beforeInstall = await readFile(configFile, 'utf8');
        const repeated = await win!.webContents.executeJavaScript("window.bridge.invoke('installCodex')");
        if (!repeated.includes('无需重复安装') || await readFile(configFile, 'utf8') !== beforeInstall) throw new Error('重复接入改写了现有配置。');
        Object.assign(result, { registeredBeforeCall:true, idempotentInstallation:true });
        const addonTarget = path.join(dataRoot, 'observer-export');
        await exportObserver(root, addonTarget, helper);
        if (JSON.parse(await readFile(path.join(addonTarget, 'package.json'), 'utf8')).name !== '@codex-dsh/desktop-observer') throw new Error('观察插件导出失败。');
        Object.assign(result, { observerExport:true });
        const image = await win!.webContents.capturePage();
        await writeFile(path.join(smokeOutput, 'desktop-preview.png'), image.toPNG());
        await win!.webContents.executeJavaScript("document.querySelector('[data-page=settings]').click()");
        if (!await win!.webContents.executeJavaScript("!document.querySelector('#settings-page').classList.contains('hidden')")) throw new Error('设置页面验证失败。');
        if (!await win!.webContents.executeJavaScript("!document.querySelector('#dshModel,#apiModel,#apiKey,#codexPath,#key-state') && !document.querySelector('#settings-page').textContent.includes('独立付费审查') && !!document.querySelector('#timeoutMinutes')"))
          throw new Error('设置页仍包含已移除的旧 ACP 模型或付费审查输入。');
        const physicalRoot = await realpath(dataRoot);
        if (String(await win!.webContents.executeJavaScript("window.bridge.invoke('state').then(state=>state.dataRoot)")) !== physicalRoot ||
            !await win!.webContents.executeJavaScript(`document.querySelector('#data-root').textContent.includes(${JSON.stringify(physicalRoot)})`))
          throw new Error('设置页没有显示数据目录的真实路径。');
        Object.assign(result, { dataRootResolved:true });
        const brand = await win!.webContents.executeJavaScript("const mark=document.querySelector('.brand-mark');({tag:mark.tagName,src:mark.getAttribute('src'),width:mark.naturalWidth})");
        if (brand.tag !== 'IMG' || brand.src !== 'icon.png' || brand.width !== 256) throw new Error('页面品牌图标未使用 icon.png。');
        const iconPng = await readFile(path.join(here, 'ui', 'icon.png'));
        const sameIcon = app.isPackaged
          ? !nativeImage.createFromPath(path.join(here, 'ui', 'icon.png')).isEmpty()
          : iconPng.equals(await readFile(path.join(root, 'assets', 'icon.png'))) && (await readFile(path.join(root, 'assets', 'icon.ico'))).includes(iconPng);
        if (!sameIcon) throw new Error(app.isPackaged ? '打包图标无法加载。' : '窗口、托盘与安装包图标不是同一份 PNG 源。');
        Object.assign(result, { settingsPruned:true, brandIcon:true, singleIconSource:true });
        const testCatalog = {home:dataRoot,default:{provider:'magpie',model:'group/cheap-first'},groups:[
          {id:'magpie',name:'Magpie',models:[{id:'group/cheap-first',name:'便宜优先-主用deepseek',reasoning:{efforts:[{id:'high',name:'High'},{id:'max',name:'Max'}],defaultEffort:'high'}}]},
        ],failures:[]};
        let unavailableModel = false;
        const modelPipe = net.createServer(socket => {
          let input = '';
          socket.on('data', bytes => {
            input += bytes.toString(); if (!input.includes('\n')) return;
            const request = JSON.parse(input);
            const result = request.method === 'capabilities' ? {nativeChat:true,modelSelection:true} : {...testCatalog,groups:unavailableModel?[]:testCatalog.groups};
            socket.end(JSON.stringify({id:request.id,result})+'\n');
          });
        });
        const modelPipeAddress = pipePath(pipeName(await identity(helper))+'-desktop');
        await new Promise<void>((resolve,reject) => {modelPipe.once('error',reject);modelPipe.listen(modelPipeAddress,resolve);});
        try {
          const readModels = "(async()=>{const button=document.querySelector('#read-dsh-models');button.click();for(let i=0;i<200&&button.disabled;i++)await new Promise(resolve=>setTimeout(resolve,25));return !button.disabled;})()";
          await win!.webContents.executeJavaScript(readModels);
          await win!.webContents.executeJavaScript("const provider=document.querySelector('#nativeProvider');provider.value='magpie';provider.dispatchEvent(new Event('change'));");
          if(!await win!.webContents.executeJavaScript("document.querySelector('#nativeModelId').value==='group/cheap-first' && document.querySelector('#nativeEffort').value==='max'"))
            throw new Error('自定义路由或 max 推理强度未正确加载。');
          const saveModels = "(async()=>{document.querySelector('#toast').textContent='';document.querySelector('#settings-form').requestSubmit();for(let i=0;i<200&&!document.querySelector('#toast').textContent;i++)await new Promise(resolve=>setTimeout(resolve,25));return document.querySelector('#toast').textContent;})()";
          if(!String(await win!.webContents.executeJavaScript(saveModels)).includes('设置已保存') ||
              engine.store.settings.nativeModel?.model !== 'group/cheap-first' || engine.store.settings.nativeModel.reasoningEffort !== 'max')
            throw new Error('模型选择未通过真实界面和受限 IPC 保存。');
          await writeFile(path.join(smokeOutput,'desktop-model-settings.png'),(await win!.webContents.capturePage()).toPNG());
          unavailableModel=true;
          await win!.webContents.executeJavaScript(readModels);
          if(!await win!.webContents.executeJavaScript("document.querySelector('#nativeModelId').value==='group/cheap-first' && document.querySelector('#dsh-model-status').textContent.includes('不可用')"))
            throw new Error('已失效模型被静默替换。');
          if(!String(await win!.webContents.executeJavaScript(saveModels)).includes('不可用'))throw new Error('无效路由未在保存时拒绝。');
          await win!.webContents.executeJavaScript("document.querySelector('#nativeProvider').value='';document.querySelector('#nativeProvider').dispatchEvent(new Event('change'));");
          if(!String(await win!.webContents.executeJavaScript(saveModels)).includes('设置已保存') || engine.store.settings.nativeModel !== null)
            throw new Error('跟随 DSH 默认选项未保存。');
          Object.assign(result,{modelCatalogIpc:true,customRouteSaved:true,maxEffortSelected:true,unavailableModelPreserved:true,unavailableModelRejected:true,followDefaultSaved:true});
        } finally {await new Promise<void>(resolve=>modelPipe.close(()=>resolve()));}
        await win!.webContents.executeJavaScript("document.querySelector('[data-page=integration]').click()");
        if (!await win!.webContents.executeJavaScript("document.querySelector('#mcp-config').textContent.includes('ELECTRON_RUN_AS_NODE')")) throw new Error('接入页面配置验证失败。');
        const realDshPath=engine.store.settings.dshPath;
        const realDshHome=engine.store.settings.dshHome;
        const mockDshPath=path.join(dataRoot,'mock-dsh.cmd');
        // Counts plugin runs so a repeated request can be proven not to reinstall.
        const mockCalls=path.join(dataRoot,'mock-dsh-calls.txt');
        await writeFile(mockCalls,'');
        await writeFile(mockDshPath,`@echo off\r\n>>"${mockCalls}" echo call\r\nif not "%~1"=="plugin" exit /b 11\r\nif not "%~2"=="--profile" exit /b 12\r\nif not "%~3"=="desktop" exit /b 13\r\nif not "%~4"=="add" exit /b 14\r\nif not exist "%~5\\native.js" exit /b 15\r\nexit /b 0\r\n`);
        const calls=async()=> (await readFile(mockCalls,'utf8')).split(/\r?\n/).filter(Boolean).length;
        const clickInstall="(async()=>{const button=document.querySelector('#install-dsh-observer');button.disabled=false;button.click();for(let i=0;i<200&&button.disabled;i++)await new Promise(resolve=>setTimeout(resolve,25));return !button.disabled&&document.querySelector('#toast').textContent;})()";
        try {
          engine.store.settings.dshPath=mockDshPath;
          const first=String(await win!.webContents.executeJavaScript(clickInstall));
          if(!first.includes('原生对话连接已安装')||await calls()!==1)throw new Error('DSH 安装按钮未通过受限 IPC 完成一次模拟 CLI 安装。');
          // Only the wording is checked here: no automatic quit, restart or connection wait is exercised.
          if(!first.includes('不会自动退出或重启 DSH')||!first.includes('不会强制结束进程'))throw new Error('安装结果未说明不支持自动重启或不强制结束。');
          // Simulate what `dsh plugin add` leaves behind, then prove the repeat request installs nothing.
          const connectorTarget=path.join(dataRoot,`dsh-desktop-connector-${app.getVersion()}`);
          const profileFile=path.join(dataRoot,'mock-dsh-home','profiles','desktop','package.json');
          engine.store.settings.dshHome=path.join(dataRoot,'mock-dsh-home');
          await mkdir(path.dirname(profileFile),{recursive:true});
          const manifest=(bundles:boolean)=>JSON.stringify({dependencies:{'@codex-dsh/desktop-observer':`link:${connectorTarget.replace(/\\/g,'/')}`},
            ...bundles?{dsh:{profile:{bundles:['@deepseek-ai/dsh-base','@codex-dsh/desktop-observer']}}}:{}});
          await writeFile(profileFile,manifest(true));
          const again=String(await win!.webContents.executeJavaScript(clickInstall));
          if(!again.includes('无需重复安装')||await calls()!==1)throw new Error('重复点击仍重新导出或重新运行插件安装。');
          // The dependency alone is not an install: a missing bundle entry must fall back to plugin add.
          await writeFile(profileFile,manifest(false));
          if(!String(await win!.webContents.executeJavaScript(clickInstall)).includes('已安装')||await calls()!==2)
            throw new Error('缺少 dsh.profile.bundles 声明时没有恢复安装。');
          // A damaged file must also be repaired rather than skipped as installed.
          await writeFile(profileFile,manifest(true));
          await writeFile(path.join(connectorTarget,'index.js'),'stale');
          if(!String(await win!.webContents.executeJavaScript(clickInstall)).includes('已安装')||await calls()!==3)
            throw new Error('已损坏的连接没有被重新安装。');
          Object.assign(result,{dshInstallButton:true,dshInstallMessageChecked:true,dshReinstallSkipped:true,
            dshMissingBundleReinstalled:true,dshDamagedConnectorRepaired:true,
            dshAutoQuitTested:false,dshBusyHostRefusalTested:false,dshRestartTested:false,dshConnectorReadyAfterRestartTested:false});
        } finally {engine.store.settings.dshPath=realDshPath;engine.store.settings.dshHome=realDshHome;}
        showWindow(); win!.close();
        if (win!.isDestroyed() || win!.isVisible()) throw new Error('关闭窗口未正确收起到托盘。');
        await pipeRequest(helper, 'ping', {}); showWindow();
        if (!win!.isVisible()) throw new Error('托盘恢复窗口失败。');
        const second = await runProcess(process.execPath, [...(app.isPackaged ? [] : [root]), '--smoke-test', '--background'], { env: cleanEnvironment({ BRIDGE_SMOKE_OUTPUT: smokeOutput, BRIDGE_SMOKE_DATA: dataRoot }), timeoutMs: 20000 });
        if (second.code !== 0 || secondInstances !== 1) throw new Error('重复启动单实例验证失败。');
        const credentialFields = await win!.webContents.executeJavaScript("(async()=>Object.keys(await window.bridge.invoke('state')).filter(key=>/apiConfigured|encryptionAvailable|apiKey/.test(key)))()");
        if (credentialFields.length) throw new Error('界面状态仍包含凭据相关字段。');
        Object.assign(result,{noCredentialState:true});
        engine.store.tasks.push({id:randomUUID(),status:'awaiting_review',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),round:0,
          handoff:{requestId:'smoke-only',title:'模拟任务：验证与审查展示',repoPath:'隔离测试目录',baseCommit:'0'.repeat(40),ready:true,goal:'仅用于窗口显示测试',plan:'此记录没有调用模型，也未修改真实项目',constraints:[],allowedPaths:['value.txt'],validationCommands:['模拟验收命令'],acceptanceCriteria:['界面正确显示报告'],commitMessage:'test: demonstrate task window'},
          summary:'模拟 ACP 执行完成，等待 Codex 审查。',changedFiles:['value.txt'],checks:[{command:'模拟验收命令',exitCode:0,output:'通过',at:new Date().toISOString()}],
          review:{verdict:'changes_requested',summary:'模拟审查报告：请核对验收条件。',issues:['此记录仅测试显示效果']},reviewSource:'codex',log:[{at:new Date().toISOString(),kind:'mock',text:'<img src=x onerror="window.__unsafe=true"> 日志应作为纯文本显示'}]});
        await win!.webContents.executeJavaScript("document.querySelector('[data-page=tasks]').click()");
        await new Promise(resolve => setTimeout(resolve, 1700));
        if (!await win!.webContents.executeJavaScript("document.querySelector('#detail').textContent.includes('模拟审查报告') && !window.__unsafe && !document.querySelector('#detail img')")) throw new Error('任务详情或日志安全显示失败。');
        if (!await win!.webContents.executeJavaScript("!document.querySelector('#detail .actions').textContent.includes('付费') && document.querySelector('#detail').textContent.includes('审查报告')")) throw new Error('任务操作仍包含独立付费审查入口，或历史审查报告未显示。');
        await writeFile(path.join(smokeOutput,'desktop-task-preview.png'),(await win!.webContents.capturePage()).toPNG());
        const previewTask=engine.store.tasks.at(-1)!;previewTask.executor='desktop';previewTask.sessionId='session-codex-'+previewTask.id;previewTask.handoff.title='中文原生任务 🧪';
        await new Promise(resolve=>setTimeout(resolve,1700));
        await win!.webContents.executeJavaScript("document.querySelector('#detail details summary').click()");
        await win!.webContents.executeJavaScript("document.querySelector('#detail details pre').scrollTop=60");
        await new Promise(resolve=>setTimeout(resolve,1700));
        if(!await win!.webContents.executeJavaScript("document.querySelector('#detail details').open && document.querySelector('#detail details pre').scrollTop===60"))throw new Error('查看交接方案在定时刷新后丢失展开或滚动状态。');
        await win!.webContents.executeJavaScript("document.querySelector('#detail details summary').click()");
        await new Promise(resolve=>setTimeout(resolve,1700));
        if(await win!.webContents.executeJavaScript("document.querySelector('#detail details').open"))throw new Error('手动收起交接方案后被定时刷新重新打开。');
        Object.assign(result,{handoffRemainsOpen:true,handoffScrollPreserved:true,handoffRemainsClosed:true});
        if(!await win!.webContents.executeJavaScript("document.querySelector('#detail').textContent.includes('中文原生任务 🧪') && document.querySelector('#detail').textContent.includes('打开 DSH 对话') && !document.querySelector('#detail .logs')"))throw new Error('原生任务界面仍展示聊天日志或中文错误。');
        let focusError: string;
        try {
          engine.store.settings.dshPath=path.join(dataRoot,'absent-dsh','resources/runtime/cli/bin/dsh.cmd');
          focusError=await win!.webContents.executeJavaScript(`window.bridge.invoke('openDshChat',{taskId:${JSON.stringify(previewTask.id)}}).then(()=>'',error=>error.message)`);
        } finally {engine.store.settings.dshPath=realDshPath;}
        if(!focusError.includes('找不到 DSH 桌面程序')||/ENOENT|ECONNREFUSED/.test(focusError))throw new Error('打开 DSH 对话未显示可操作的连接提示。');
        Object.assign(result,{nativeChatFocusIpc:true});
        await writeFile(path.join(smokeOutput,'desktop-native-preview.png'),(await win!.webContents.capturePage()).toPNG());
        Object.assign(result,{nativeTaskUi:true,bridgeChatRemoved:true});
        if (!String(await win!.webContents.executeJavaScript(`window.bridge.invoke('paidReview',{taskId:${JSON.stringify(previewTask.id)}}).then(()=>'',error=>error.message)`)).includes('未知操作'))
          throw new Error('受限 IPC 仍允许付费审查入口。');
        Object.assign(result,{paidReviewRemoved:true,historyReviewVisible:true});
        Object.assign(result,{settings:true,integration:true,closeToTray:true,restore:true,singleInstance:true,taskDetail:true,textOnlyLogs:true});
        await writeFile(path.join(smokeOutput, 'desktop-smoke.json'), JSON.stringify(result, null, 2));
        await engine.shutdown(); stopPipe(); exiting = true; app.exit(0);
      }
    } catch (error) {
      if (smoke) { console.error(safeError(error)); exiting = true; app.exit(1); }
      else { dialog.showErrorBox('Codex DSH Bridge 启动失败', safeError(error)); exiting = true; app.quit(); }
    }
  });
}
