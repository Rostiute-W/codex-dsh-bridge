import assert from 'node:assert/strict';
import { mkdir, cp, writeFile, readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const project=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const {Store}=await import(pathToFileURL(path.join(project,'dist/store.js')));
const {Engine}=await import(pathToFileURL(path.join(project,'dist/engine.js')));
const {servePipe,pipeRequest}=await import(pathToFileURL(path.join(project,'dist/rpc.js')));
const {startProcess,runProcess,terminateTree,cleanEnvironment}=await import(pathToFileURL(path.join(project,'dist/process.js')));
const helper=path.join(project,'build/pipe-host.exe'),home=path.join(project,'.test-data/observer-'+randomUUID()),addon=path.join(home,'addon');
const dsh=process.env.DSH_PATH ?? 'E:/DeepSeek Harness/resources/runtime/cli/bin/dsh.cmd';
process.env.BRIDGE_INSTANCE=randomUUID();
await mkdir(addon,{recursive:true});await cp(path.join(project,'dsh-observer'),addon,{recursive:true});
// Exercise real Host prompt admission without model/network calls. This gate
// exists only in the isolated fixture, never in the shipped desktop plugin.
const entry=path.join(addon,'index.js');
await writeFile(entry,(await readFile(entry,'utf8')).replace('export async function apply(ctx) {',"export async function apply(ctx) {\n  ctx.on('agent/pre-step', () => Promise.resolve({kind:'reject'}));"));
await writeFile(path.join(addon,'bridge-config.json'),JSON.stringify({pipeHost:helper,instance:process.env.BRIDGE_INSTANCE,dataRoot:path.join(home,'bridge-fixture')}));
const env=cleanEnvironment({DSH_HOME:home});
const install=await runProcess(dsh,['plugin','--profile','web','add',addon],{env,timeoutMs:60000});
assert.equal(install.code,0,'isolated profile installation failed');
const modelOverlay=path.join(home,'models.patch.yml');
await writeFile(modelOverlay,[
  '\n- id: llm-pi-ai',
  '  config:',
  '    providers:',
  '      magpie:',
  '        displayName: Magpie fixture',
  '        api: openai-completions',
  '        baseURL: http://127.0.0.1:9/v1',
  '        models:',
  '          - id: group/cheap-first',
  '            name: 便宜优先-主用deepseek',
  '            reasoningEfforts:',
  '              high: high',
  '              max: max',
].join('\n')+'\n');
const store=new Store(path.join(home,'bridge-fixture'));
const task={id:randomUUID(),status:'running',handoff:{title:'官方 Host 观察测试',goal:'只读模拟任务，不调用模型',plan:'实际 Host / UI 插件读取 Bridge 测试管道'},createdAt:new Date().toISOString(),updatedAt:new Date().toISOString(),round:0,summary:'',checks:[],changedFiles:[],log:[{at:new Date().toISOString(),kind:'tool',text:'执行阶段 A'}]};
store.tasks.push(task);const engine=new Engine(store);let calls=0;const stop=await servePipe(helper,engine,()=>calls++);
let child, diagnostics='';
try{
  child=await startProcess(dsh,['--profile','web','--patch',modelOverlay,'--no-open','--port','0'],{env,cwd:project});
  child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');let logs='';
  const url=await new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('official Host startup timed out')),45000);let settled=false;
    const capture=bytes=>{logs=(logs+bytes).slice(-100000);diagnostics=logs.replace(/https?:\/\/\S+/g,'[URL hidden]');const match=logs.match(/https?:\/\/(?:localhost|127\.0\.0\.1):\d+\/[^\s\x1b]*/);if(match&&!settled){settled=true;clearTimeout(timer);resolve(match[0]);}};
    child.stdout.on('data',capture);child.stderr.on('data',capture);child.on('error',error=>{clearTimeout(timer);reject(error);});child.on('exit',code=>{if(!settled){clearTimeout(timer);reject(new Error('official Host exited '+code+' '+logs.replace(/https?:\/\/\S+/g,'[URL hidden]').slice(-2200)));}});
  });
  const exchange=await fetch(url,{redirect:'manual'});assert.equal(exchange.status,303);
  const cookie=exchange.headers.get('set-cookie')?.split(';')[0];assert.ok(cookie);
  const origin=new URL(url).origin;
  const headers={cookie,origin};
  assert.equal((await fetch(origin+'/codex-dsh-bridge/state')).status,401);
  const first=await fetch(origin+'/codex-dsh-bridge/state',{headers});assert.equal(first.status,200);
  assert.equal((await first.json()).detail.status,'running');
  task.status='awaiting_review';task.log.push({at:new Date().toISOString(),kind:'check',text:'独立验证完成'});
  const second=await (await fetch(origin+'/codex-dsh-bridge/state',{headers})).json();assert.equal(second.detail.status,'awaiting_review');assert.match(second.detail.logs,/独立验证完成/);assert.equal(calls,0);
  const index=await (await fetch(origin+'/',{headers})).text();assert.ok(index.includes('@codex-dsh/desktop-observer'),'addon absent from actual client boot graph');
  assert.equal((await fetch(origin+'/codex-dsh-bridge/native-focus')).status,401);
  assert.equal((await pipeRequest(helper,'capabilities',{},'-desktop')).nativeChat,true);
  const catalog=await pipeRequest(helper,'models',{},'-desktop');
  const model=catalog.groups.find(group=>group.id==='magpie')?.models.find(model=>model.id==='group/cheap-first');
  assert.equal(model?.name,'便宜优先-主用deepseek');
  assert.ok(model.reasoning.efforts.some(effort=>effort.id==='max'));
  const nativeId=randomUUID();
  await mkdir(path.join(home,'bridge-fixture','tasks',nativeId,'workspace'),{recursive:true});
  const nativeModel={provider:'magpie',model:'group/cheap-first',reasoningEffort:'max'};
  const prepare={taskId:nativeId,cwd:path.join(home,'bridge-fixture','tasks',nativeId,'workspace'),title:'Codex 原生对话创建测试',nativeModel};
  const created=await pipeRequest(helper,'prepare',prepare,'-desktop');
  const native=await pipeRequest(helper,'inspect',{taskId:nativeId},'-desktop');
  assert.equal(native.sessionId,created.sessionId);assert.equal(native.status,'idle');
  // Official selectModel persists the selection as the desktop default too.
  assert.deepEqual((await pipeRequest(helper,'models',{},'-desktop')).default,nativeModel);
  await pipeRequest(helper,'prepare',prepare,'-desktop');
  assert.equal((await pipeRequest(helper,'inspect',{taskId:nativeId},'-desktop')).cursor,native.cursor);
  const focus=await (await fetch(origin+'/codex-dsh-bridge/native-focus',{headers})).json();assert.equal(focus.sessionId,created.sessionId);
  const send={taskId:nativeId,cwd:path.join(home,'bridge-fixture','tasks',nativeId,'workspace'),title:'Codex 原生对话创建测试',prompt:'仅回复测试成功，不读写文件，不调用工具。',requestId:nativeId+'-'+'a'.repeat(64)};
  const admitted=await pipeRequest(helper,'send',send,'-desktop');assert.equal(admitted.sessionId,created.sessionId);
  assert.equal((await pipeRequest(helper,'send',send,'-desktop')).sessionId,created.sessionId);
  await pipeRequest(helper,'cancel',{taskId:nativeId},'-desktop');
  const result={officialHost:true,authenticatedRoute:true,liveUpdates:true,clientGraph:true,nativeSessionCreated:true,nativeFocus:true,nativePromptAdmitted:true,repeatedPromptAccepted:true,nativeModelCatalog:true,customModelSelected:true,reasoningMaxSelected:true,repeatedPreparationPreserved:true,generationBlocked:true,noCodexActivityFromObserver:true,modelPromptsSent:false};
  await writeFile(path.join(project,'.test-data','dsh-observer-host-smoke.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result));
}catch(error){await writeFile(path.join(home,'observer-host-diagnostics.txt'),diagnostics);throw error;}
finally{if(child)await terminateTree(child);stop();await engine.shutdown();}
