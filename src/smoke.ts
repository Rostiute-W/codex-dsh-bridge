import { app, nativeImage, type BrowserWindow } from 'electron';
import { mkdir, readFile, writeFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import { randomUUID } from 'node:crypto';
import type { Engine } from './engine.js';
import { pipeRequest, identity, pipeName, pipePath } from './rpc.js';
import { runProcess, cleanEnvironment } from './process.js';
import { exportObserver } from './observer.js';

export interface SmokeContext {
  win: BrowserWindow; engine: Engine; dataRoot: string; root: string; here: string; helper: string; smokeOutput: string;
  showWindow: () => void; secondInstances: () => number;
}
/**
 * `--smoke-test` self-check: drives the real window through the restricted IPC against isolated data and
 * mock DSH endpoints, then writes screenshots and desktop-smoke.json to smokeOutput. Throws on the first failure.
 */
export async function runSmoke(ctx: SmokeContext): Promise<void> {
  const { win, engine, dataRoot, root, here, helper, smokeOutput, showWindow } = ctx;
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
  if (second.code !== 0 || ctx.secondInstances() !== 1) throw new Error('重复启动单实例验证失败。');
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
}
