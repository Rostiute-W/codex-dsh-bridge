import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import vm from 'node:vm';
import net from 'node:net';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';
import { registrationState } from '../integration.js';
import { observerSnapshot } from '../observer.js';
import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { defaultSettings, type Task } from '../model.js';
import { servePipe, identity, pipePath, pipeName, pipeRequest } from '../rpc.js';

test('restricted preload forwards DSH installation and native chat focus while rejecting unknown actions', async () => {
  let bridge:{invoke:(method:string,params?:unknown)=>Promise<unknown>}|undefined;
  const calls:{channel:string;payload:{method:string;params?:unknown}}[]=[];
  vm.runInNewContext(await readFile(path.join(root,'src/ui/preload.cjs'),'utf8'),{
    require:(name:string)=>{assert.equal(name,'electron');return {
      contextBridge:{exposeInMainWorld:(name:string,value:typeof bridge)=>{assert.equal(name,'bridge');bridge=value;}},
      ipcRenderer:{invoke:async(channel:string,payload:any)=>{calls.push({channel,payload});return 'forwarded';}},
    };},
  });
  assert.equal(await bridge!.invoke('installDshObserver'),'forwarded');
  const params={taskId:randomUUID()};assert.equal(await bridge!.invoke('openDshChat',params),'forwarded');
  assert.equal(calls[0]!.channel,'bridge:invoke');assert.equal(calls[0]!.payload.method,'installDshObserver');
  assert.equal(calls[1]!.payload.method,'openDshChat');assert.equal(calls[1]!.payload.params,params);
  assert.equal(await bridge!.invoke('dshModels',{dshPath:'test',dshHome:''}),'forwarded');
  await assert.rejects(bridge!.invoke('executeArbitraryCommand'),/未知操作/);assert.equal(calls.length,3);
});

test('Chinese handoff survives the real Windows pipe host and returns without mojibake', {skip:process.platform!=='win32'}, async () => {
  const previous=process.env.BRIDGE_INSTANCE; process.env.BRIDGE_INSTANCE=randomUUID();
  const helper=path.join(root,'build','pipe-host.exe'); const store=new Store(path.join(root,'.test-data',randomUUID()));
  const task=mockTask();store.tasks.push(task);const engine=new Engine(store);
  const payload={title:'中文任务：新建对话 🧪',plan:'只读原文，不删除文件。'};
  let received:unknown;
  engine.submit=async value=>{received=value;return task;};
  const stop=await servePipe(helper,engine,()=>{});
  try {
    await pipeRequest(helper,'submit',payload);
    assert.deepEqual(received,payload);
  } finally {stop();await engine.shutdown();if(previous===undefined)delete process.env.BRIDGE_INSTANCE;else process.env.BRIDGE_INSTANCE=previous;}
});
test('MCP response retains Chinese characters when a pipe packet ends inside a UTF-8 character', {skip:process.platform!=='win32'}, async () => {
  const previous=process.env.BRIDGE_INSTANCE;process.env.BRIDGE_INSTANCE=randomUUID();const helper=path.join(root,'build','pipe-host.exe');
  const address=pipePath(pipeName(await identity(helper))),title='连续中文 🧪';
  const server=net.createServer(socket=>{let input='';socket.on('data',bytes=>{input+=bytes.toString();if(!input.includes('\n'))return;const request=JSON.parse(input);const response=Buffer.from(JSON.stringify({id:request.id,result:{title}})+'\n');const cut=response.indexOf(Buffer.from('中'))+1;socket.write(response.subarray(0,cut));setTimeout(()=>socket.end(response.subarray(cut)),20);});});
  await new Promise<void>(resolve=>server.listen(address,resolve));
  try {assert.deepEqual(await pipeRequest(helper,'result',{}),{title});}
  finally{await new Promise<void>(resolve=>server.close(()=>resolve()));if(previous===undefined)delete process.env.BRIDGE_INSTANCE;else process.env.BRIDGE_INSTANCE=previous;}
});

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const expected = { command:'E:\\Codex DSH Bridge\\Codex DSH Bridge.exe', args:['E:\\Codex DSH Bridge\\resources\\app.asar\\dist\\mcp.js'], env:{ELECTRON_RUN_AS_NODE:'1'} };
const text = `theme = 'dark'\n[mcp_servers."codex-dsh-bridge"]\ncommand = ${JSON.stringify(expected.command)}\nargs = ${JSON.stringify(expected.args)}\ntool_timeout_sec = 660\n[mcp_servers."codex-dsh-bridge".env]\nELECTRON_RUN_AS_NODE = '1'\n`;
test('existing matching MCP is registered before first call; disabled, malformed and differing configurations remain distinct', () => {
  assert.equal(registrationState(text, expected).status, 'registered');
  assert.equal(registrationState(text.replace('660','60'), expected).status,'conflict');
  assert.equal(registrationState(text.replace('tool_timeout_sec = 660','enabled = false\ntool_timeout_sec = 660'), expected).status,'conflict');
  assert.equal(registrationState(text,{...expected,args:['E:\\other\\mcp.js']}).status,'conflict');
  assert.equal(registrationState('theme = "dark"',expected).status,'missing');
  assert.equal(registrationState('[mcp_servers',expected).status,'error');
});
function mockTask(): Task {
  return { id:randomUUID(),handoff:{requestId:'observer-only',title:'观察测试',repoPath:'test',baseCommit:'0'.repeat(40),ready:true,goal:'测试观察数据读取',plan:'只读观察，不执行任何代码',constraints:[],allowedPaths:['test'],validationCommands:['mock'],acceptanceCriteria:['readonly'],commitMessage:'test: observe'},status:'running',createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),round:0,summary:'',checks:[],changedFiles:[],log:[{at:new Date().toISOString(),kind:'tool',text:'<img src=x onerror=alert(1)> sk-syntheticcredential123456789'}] };
}
test('observer projection contains live evidence, scrubs secrets and has no settings or permission operations', () => {
  const task=mockTask();task.summary='api_key=synthetic-secret-without-trailing-space';
  const snapshot=observerSnapshot([task]) as {detail: {logs:string;summary:string};tasks:unknown[]};
  assert.match(snapshot.detail.logs,/<img/); assert.ok(!JSON.stringify(snapshot).includes('syntheticcredential'));
  assert.ok(!('settings' in snapshot)); assert.equal(snapshot.tasks.length,1);
  assert.ok(!snapshot.detail.summary.includes('synthetic-secret'));
});
test('official DSH loader opens the native conversation once per focus request without a separate pane', async () => {
  let registration: { id:string;factory:(require:(name:string)=>unknown)=>{inject:string[];apply:(ctx:unknown)=>void} } | undefined;
  const opened:string[]=[],disposers:(()=>void)[]=[];let refresh:(()=>Promise<void>)|undefined;
  const focus={seq:1,sessionId:'session-codex-test'};
  vm.runInNewContext(await readFile(path.join(root,'dsh-observer','client.js'),'utf8'),{window:{__ModuleLoader__:{load:(value:typeof registration)=>{registration=value;}}},AbortController,fetch:async()=>({ok:true,json:async()=>focus}),setTimeout:(fn:typeof refresh)=>{refresh=fn;return 1;},clearTimeout:()=>{}});
  assert.equal(registration?.id,'@codex-dsh/desktop-observer');
  const plugin=registration!.factory(()=>{throw new Error('No framework dependency expected');});
  plugin.apply({effect:(effect:()=>()=>void)=>disposers.push(effect()),uiWorkspace:{openSession:(id:string)=>opened.push(id)}});
  await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(opened,[focus.sessionId]);
  await refresh!();assert.equal(opened.length,1);
  focus.seq++;await refresh!();assert.equal(opened.length,2);disposers.forEach(dispose=>dispose());
});
test('DSH observer enforces host authentication and GET-only access, follows live IPC and never marks Codex connected', {skip:process.platform!=='win32'}, async () => {
  const previous=process.env.BRIDGE_INSTANCE; process.env.BRIDGE_INSTANCE=randomUUID();
  const helper=path.join(root,'build','pipe-host.exe'); const store=new Store(path.join(root,'.test-data',randomUUID()));store.settings={...defaultSettings};
  const task=mockTask(); store.tasks.push(task); const engine=new Engine(store);let calls=0;
  const stop=await servePipe(helper,engine,()=>{calls++;});
  // JS addon remains dependency-free so the DSH runtime owns its plugin lifecycle.
  const addon = await import(pathToFileURL(path.join(root,'dsh-observer','index.js')).href);
  let route: {handler:(req:unknown,res:unknown)=>Promise<void>}; const disposers:(()=>void)[]=[];
  addon.registerObserver({effect:(effect:()=>()=>void)=>disposers.push(effect()),webServer:{register:(value:typeof route)=>{route=value;return ()=>{};}},connection:{requestRejection:(req:{headers:Record<string,string>})=>req.headers.authorization==='test-only'?undefined:401}},pipePath(pipeName(await identity(helper))));
  const server=createServer((req,res)=>{void route.handler(req,res);}); await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  const address=server.address() as {port:number};const url=`http://127.0.0.1:${address.port}/codex-dsh-bridge/state`;
  try {
    assert.equal((await fetch(url)).status,401);
    assert.equal((await fetch(url,{method:'POST',headers:{authorization:'test-only'}})).status,405);
    assert.equal((await fetch(url+'?method=cancel',{headers:{authorization:'test-only'}})).status,400);
    const first=await (await fetch(url,{headers:{authorization:'test-only'}})).json() as {detail:{status:string;logs:string}};
    assert.equal(first.detail.status,'running');assert.match(first.detail.logs,/<img/);assert.equal(calls,0);
    task.status='awaiting_review'; task.log.push({at:new Date().toISOString(),kind:'check',text:'实际验证完成'});
    const next=await (await fetch(url,{headers:{authorization:'test-only'}})).json() as {detail:{status:string;logs:string}};
    assert.equal(next.detail.status,'awaiting_review');assert.match(next.detail.logs,/实际验证完成/);assert.equal(calls,0);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve=>server.close(()=>resolve()));disposers.reverse().forEach(dispose=>dispose());stop();await engine.shutdown();if(previous===undefined)delete process.env.BRIDGE_INSTANCE;else process.env.BRIDGE_INSTANCE=previous; }
});
