import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdir,mkdtemp,writeFile,readFile} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {Store} from '../store.js';
import {Engine} from '../engine.js';
import {git} from '../git.js';
import {identity,pipeName,pipePath} from '../rpc.js';
import {type Handoff,defaultSettings,settingsSchema} from '../model.js';
import {runDesktopDsh,openDesktopChat,ensureDesktopConnection,getDesktopModels,validateDesktopModel} from '../desktop.js';
import type {Task} from '../model.js';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'../..');
const addon=await import(pathToFileURL(path.join(root,'dsh-observer/native.js')).href);

test('native connector restores a lost pipe helper without recreating sessions or sending prompts', {skip:process.platform!=='win32'},async()=>{
  const previous=process.env.BRIDGE_INSTANCE;process.env.BRIDGE_INSTANCE=randomUUID();
  const h=host(),helper=path.join(root,'build/pipe-host.exe'),name=pipeName(await identity(helper)),dataRoot=path.join(root,'.test-data',randomUUID());
  const {nativeRequest}=await import('../desktop.js');process.env.BRIDGE_JOB_HOST=helper;
  try {
    await addon.startNativePipe(h.ctx,{pipeHost:helper,dataRoot},pipePath(name));
    assert.equal((await nativeRequest('capabilities',{}) as any).nativeChat,true);
    const script=`Get-CimInstance Win32_Process -Filter "ParentProcessId = ${process.pid} AND Name = 'pipe-host.exe'" | Where-Object { $_.CommandLine.EndsWith('${name}-desktop') } | ForEach-Object { $_.ProcessId }`;
    const output=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-Command',script]);
    const ids=output.stdout.trim().split(/\s+/).map(Number);assert.equal(ids.length,1);assert.ok(ids[0]!>0);process.kill(ids[0]!);
    let restored=false;
    for(let attempt=0;attempt<40&&!restored;attempt++){
      await new Promise(resolve=>setTimeout(resolve,100));
      try{restored=(await nativeRequest('capabilities',{}) as any).nativeChat;}catch{}
    }
    assert.equal(restored,true,'原生连接管道在辅助进程退出后未恢复');
    const taskId=randomUUID();
    await Promise.all([openDesktopChat({id:taskId,executor:'desktop',sessionId:'session-codex-'+taskId} as Task,defaultSettings),openDesktopChat({id:taskId,executor:'desktop',sessionId:'session-codex-'+taskId} as Task,defaultSettings)]);
    assert.deepEqual(h.counts(),{promptCalls:0,createCalls:0});
    h.close();await new Promise(resolve=>setTimeout(resolve,1200));
    await assert.rejects(nativeRequest('capabilities',{}),/ENOENT|ECONNREFUSED/);
  }finally{h.close();if(previous===undefined)delete process.env.BRIDGE_INSTANCE;else process.env.BRIDGE_INSTANCE=previous;}
});

test('opening DSH without a desktop installation gives an actionable message instead of a raw pipe error', {skip:process.platform!=='win32'},async()=>{
  const previous=process.env.BRIDGE_INSTANCE;process.env.BRIDGE_INSTANCE=randomUUID();
  try{
    const settings={...defaultSettings,dshPath:path.join(root,'.test-data','absent-'+randomUUID(),'resources/runtime/cli/bin/dsh.cmd')};
    const taskId=randomUUID();await assert.rejects(openDesktopChat({id:taskId,executor:'desktop',sessionId:'session-codex-'+taskId} as Task,settings),/找不到 DSH 桌面程序/);
    const aborted=new AbortController();aborted.abort();await assert.rejects(ensureDesktopConnection(settings,aborted.signal),/取消/);
  }finally{if(previous===undefined)delete process.env.BRIDGE_INSTANCE;else process.env.BRIDGE_INSTANCE=previous;}
});

test('native failure reports operation and known workspace codes without exposing arbitrary diagnostics',()=>{
  const privateText='private-prompt-and-credential';
  assert.match(addon.nativeFailureMessage('send',{code:'session/cwd-conflict',message:privateText,details:{reason:privateText}}),/send \/ session\/cwd-conflict.*工作区/);
  assert.match(addon.nativeFailureMessage('send',new TypeError(privateText)),/interface\/type-error/);
  for(const error of [{code:privateText,message:privateText},new Error(privateText),null])assert.doesNotMatch(addon.nativeFailureMessage(privateText,error),/private-prompt-and-credential/);
});

function host(delay=20) {
  const agents=new Map<string,any>(),disposers:(()=>void)[]=[],gates:((payload:any,next:()=>Promise<any>)=>Promise<any>)[]=[];
  let promptCalls=0,createCalls=0,guidance:string|undefined;const requests=new Set<string>();
  const selections:any[]=[];
  const catalog={default:{provider:'deepseek-account',model:'deepseek-flash'},groups:[
    {id:'deepseek-account',name:'DeepSeek 账号',models:[{id:'deepseek-flash',name:'Flash'}]},
    {id:'magpie',name:'Magpie',apiKey:'synthetic-private-key',models:[{id:'group/cheap-first',name:'便宜优先-主用deepseek',reasoning:{efforts:[{id:'high',name:'High'},{id:'max',name:'Max'}],defaultEffort:'high'}}]},
  ],failures:[{id:'deepseek',name:'DeepSeek',message:'synthetic-private-key https://private.invalid'}]};
  let startedResolve:()=>void;const started=new Promise<void>(resolve=>{startedResolve=resolve;});
  const ctx={effect:(effect:()=>()=>void)=>disposers.push(effect()),on:(_event:string,handler:any)=>gates.push(handler),
    agents:{get:(id:string)=>agents.get(id)},webServer:{register:()=>()=>{}},connection:{requestRejection:()=>undefined},
    sessionQuery:{observeSession:async(id:string)=>({events:agents.get(id).events,[Symbol.dispose]:()=>{}})},
    sessionController:{create:async({sessionId,cwd}:any)=>{if(!agents.has(sessionId)){createCalls++;agents.set(sessionId,{id:sessionId,cwd,status:'idle',inbox:{nextTurn:[],nextStep:[]},events:[{seq:0,type:'session/start',data:{}}]});}return {sessionId};},
      modelCatalog:async()=>catalog,
      selectModel:async({sessionId,...selection}:any)=>{selections.push(selection);agents.get(sessionId).events.push({seq:agents.get(sessionId).events.length,type:'model/selection',data:selection});return {selected:selection};},
      rename:async()=>({}),prompt:async(request:any,signal:AbortSignal)=>{
        // The public DSH Host service requires cancellation before admission.
        signal.throwIfAborted();
        if(requests.has(request.requestId))return {accepted:true};requests.add(request.requestId);promptCalls++;
        const agent=agents.get(request.sessionId);agent.status='running';
        agent.events.push({seq:agent.events.length,type:'user/message',data:{source:{kind:'user',rpcId:request.requestId},content:request.content}});
        if(guidance)agent.events.push({seq:agent.events.length,type:'user/message',data:{source:{kind:'user',rpcId:'human-direction'},content:[{type:'text',text:guidance}]}});startedResolve();
        agent.timer=setTimeout(()=>{void(async()=>{await writeFile(path.join(agent.cwd,'value.txt'),'after\n');agent.events.push({seq:agent.events.length,type:'assistant/message',data:{turn:0,step:0,message:{content:[{type:'text',text:'中文任务已完成 🧪'}]},stream:[]}});agent.events.push({seq:agent.events.length,type:'turn/end',data:{turn:0,reason:{kind:'completed'}}});agent.status='idle';})().catch(()=>{});},delay);
        return {accepted:true};
      },cancel:({sessionId}:any)=>{const agent=agents.get(sessionId);clearTimeout(agent.timer);agent.status='idle';agent.events.push({seq:agent.events.length,type:'turn/end',data:{turn:0,reason:{kind:'aborted',reason:{kind:'user'}}}});return {accepted:true};}},
  };
  return {ctx,agents,gates,started,catalog,selections,guide:(text:string)=>{guidance=text;},counts:()=>({promptCalls,createCalls}),close:()=>{agents.forEach(agent=>clearTimeout(agent.timer));disposers.reverse().forEach(dispose=>dispose());}};
}
test('native catalog exposes custom routes and reasoning metadata without provider secrets or error details',async()=>{
  const h=host(),controller=addon.nativeController(h.ctx,root);
  const catalog=await controller.call('models',{});
  assert.equal(catalog.groups[1].models[0].name,'便宜优先-主用deepseek');
  assert.equal(catalog.groups[1].models[0].reasoning.efforts[1].id,'max');
  assert.doesNotMatch(JSON.stringify(catalog),/synthetic-private-key|private\.invalid|apiKey/);
  validateDesktopModel({provider:'magpie',model:'group/cheap-first',reasoningEffort:'max'},catalog);
  assert.throws(()=>validateDesktopModel({provider:'magpie',model:'missing'},catalog),/不可用/);
  assert.throws(()=>validateDesktopModel({provider:'magpie',model:'group/cheap-first',reasoningEffort:'ultra'},catalog),/不支持/);
  h.close();
});
test('selected route is applied before prompting and durable events preserve manual changes after connector restart',async()=>{
  const h=host(),taskId=randomUUID(),dataRoot=path.join(root,'.test-data',randomUUID()),cwd=path.join(dataRoot,'tasks',taskId,'workspace');
  await mkdir(cwd,{recursive:true});
  const params={taskId,cwd,title:'route selection',nativeModel:{provider:'magpie',model:'group/cheap-first',reasoningEffort:'max'}};
  try {
    const first=addon.nativeController(h.ctx,dataRoot);
    const prepared=await first.call('prepare',params);
    assert.deepEqual(h.selections,[params.nativeModel]);
    const agent=h.agents.get(prepared.sessionId);
    agent.events.push({seq:agent.events.length,type:'model/selection',data:{provider:'deepseek-account',model:'deepseek-flash'}});
    const restored=addon.nativeController(h.ctx,dataRoot);
    await restored.call('prepare',params);
    await restored.call('send',{...params,prompt:'test',requestId:'one-route-task'});
    await restored.call('send',{...params,prompt:'test',requestId:'one-route-task'});
    assert.equal(h.selections.length,1);assert.equal(h.counts().promptCalls,1);
    assert.equal(agent.events.find((event:any)=>event.type==='model/selection').data.reasoningEffort,'max');
  }finally{h.close();}
});
test('missing route, invalid effort and failed model application never send a prompt; preparation can retry',async()=>{
  const h=host(),taskId=randomUUID(),dataRoot=path.join(root,'.test-data',randomUUID()),cwd=path.join(dataRoot,'tasks',taskId,'workspace');
  const controller=addon.nativeController(h.ctx,dataRoot),params={taskId,cwd,title:'invalid route',prompt:'test',requestId:'invalid-task'};
  try {
    await assert.rejects(controller.call('send',{...params,nativeModel:{provider:'magpie',model:'missing'}}),/不可用/);
    await assert.rejects(controller.call('send',{...params,nativeModel:{provider:'magpie',model:'group/cheap-first',reasoningEffort:'ultra'}}),/不可用/);
    const select=h.ctx.sessionController.selectModel;
    h.ctx.sessionController.selectModel=async()=>{throw new Error('synthetic-private-key');};
    const nativeModel={provider:'magpie',model:'group/cheap-first'};
    await assert.rejects(controller.call('prepare',{...params,nativeModel}),/synthetic-private-key/);
    assert.equal(h.counts().promptCalls,0);
    h.ctx.sessionController.selectModel=select;
    await controller.call('prepare',{...params,nativeModel});
    assert.equal(h.selections.length,1);
  }finally{h.close();}
});
test('native controller limits workspaces and uses one desktop-owned ordinary session with an idempotent prompt',async()=>{
  const h=host(),dataRoot=path.join(root,'.test-data',randomUUID()),taskId=randomUUID();
  const controller=addon.nativeController(h.ctx,dataRoot),cwd=path.join(dataRoot,'tasks',taskId,'workspace');await mkdir(cwd,{recursive:true});
  const params={taskId,cwd,title:'中文任务',prompt:'在原生对话完成任务',requestId:'one-accepted-message'};
  try {
    await assert.rejects(controller.call('send',{...params,cwd:root}),/范围/);
    const first=await controller.call('send',params);await controller.call('send',params);
    assert.match(first.sessionId,/^session-codex-/);assert.equal(h.counts().createCalls,1);assert.equal(h.counts().promptCalls,1);
    assert.equal(h.agents.get(first.sessionId).events[1].data.content[0].text,params.prompt);
    await controller.call('cancel',{taskId});assert.equal((await controller.call('inspect',{taskId})).reason,'aborted');
    await assert.rejects(controller.call('inspect',{taskId:'other-session'}),/ID/);
  }finally{h.close();}
});
test('native commit guard rejects stale conversation revisions and blocks agent steps until matching unlock',async()=>{
  const h=host(),taskId=randomUUID(),dataRoot=path.join(root,'.test-data',randomUUID()),controller=addon.nativeController(h.ctx,dataRoot);
  try{
    const prepared=await controller.call('prepare',{taskId,cwd:path.join(dataRoot,'tasks',taskId,'workspace'),title:'guard'});
    const state=await controller.call('inspect',{taskId});
    await assert.rejects(controller.call('lock',{taskId,cursor:state.cursor+1}),/验证/);
    const guard=await controller.call('lock',{taskId,cursor:state.cursor});
    await assert.rejects(controller.call('lock',{taskId,cursor:state.cursor}),/提交/);
    assert.equal((await h.gates[0]!({agent:h.agents.get(prepared.sessionId)},async()=>({kind:'accept'}))).kind,'reject');
    await controller.call('unlock',{taskId,token:'wrong'});assert.equal((await h.gates[0]!({agent:h.agents.get(prepared.sessionId)},async()=>({kind:'accept'}))).kind,'reject');
    await controller.call('unlock',{taskId,token:guard.token});assert.equal((await h.gates[0]!({agent:h.agents.get(prepared.sessionId)},async()=>({kind:'accept'}))).kind,'accept');
  }finally{h.close();}
});
async function fixture(delay=20){
  await mkdir(path.join(root,'.test-data'),{recursive:true});const dir=await mkdtemp(path.join(root,'.test-data','native-')),repo=path.join(dir,'repo');await mkdir(repo);
  await git(repo,['init']);await git(repo,['config','user.name','Bridge Test']);await git(repo,['config','user.email','bridge-test@example.invalid']);
  await writeFile(path.join(repo,'value.txt'),'before\n');await git(repo,['add','--','value.txt']);await git(repo,['commit','-m','test: baseline']);
  const store=new Store(path.join(dir,'data'));store.settings={...defaultSettings,executionMode:'desktop'};const engine=new Engine(store),h=host(delay);
  const previous=process.env.BRIDGE_INSTANCE;process.env.BRIDGE_INSTANCE=randomUUID();const helper=path.join(root,'build/pipe-host.exe');process.env.BRIDGE_JOB_HOST=helper;
  await addon.startNativePipe(h.ctx,{pipeHost:helper,dataRoot:store.root},pipePath(pipeName(await identity(helper))));
  const handoff:Handoff={requestId:randomUUID(),title:'中文原生交接 🧪',repoPath:repo,baseCommit:await git(repo,['rev-parse','HEAD']),ready:true,goal:'Change value to after through desktop chat.',plan:'Change only value.txt and let Codex review.',constraints:[],allowedPaths:['value.txt'],validationCommands:["if ((Get-Content -Raw value.txt).Trim() -ne 'after') {throw 'failed'}; Write-Output '中文验证通过'"],acceptanceCriteria:['after'],commitMessage:'test: complete native task'};
  return {engine,store,repo,h,handoff,close:async()=>{await engine.shutdown();h.close();if(previous===undefined)delete process.env.BRIDGE_INSTANCE;else process.env.BRIDGE_INSTANCE=previous;}};
}
test('new tasks persist a model snapshot while legacy settings still follow the DSH default',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture(10000);
  try {
    const legacy={...defaultSettings} as Record<string,unknown>;delete legacy.nativeModel;
    assert.equal(settingsSchema.parse(legacy).nativeModel,null);
    f.store.settings.nativeModel={provider:'magpie',model:'group/cheap-first',reasoningEffort:'max'};
    const task=await f.engine.submit({operation:'execute',handoff:f.handoff});
    f.store.settings.nativeModel.model='changed-after-submission';
    await f.h.started;
    assert.equal(task.nativeModel?.model,'group/cheap-first');
    assert.equal(f.h.selections[0].model,'group/cheap-first');
    const disk=JSON.parse(await readFile(path.join(f.store.taskDir(task.id),'state.json'),'utf8'));
    assert.equal(disk.nativeModel.reasoningEffort,'max');
  }finally{await f.close();}
});
test('model reader detects old connector and wrong DSH home without sending a task',{skip:process.platform!=='win32'},async()=>{
  const f=await fixture();
  try {
    const catalog=await getDesktopModels(f.store.settings);
    assert.equal(catalog.groups[1]!.id,'magpie');
    await assert.rejects(getDesktopModels({...f.store.settings,dshHome:path.join(root,'.test-data','different-home')}),/目录与设置不一致/);
    const controller=f.h.ctx.sessionController as any;
    controller.modelCatalog=undefined;
    await assert.rejects(getDesktopModels(f.store.settings),/升级.*0.1.7/);
    assert.equal(f.h.counts().promptCalls,0);
  }finally{await f.close();}
});
test('native execution returns Chinese evidence, rejects review after user steering, revalidates and commits', {skip:process.platform!=='win32'},async()=>{
  const f=await fixture();
  try{
    const task=await f.engine.submit({operation:'execute',handoff:f.handoff});await f.engine.wait(task.id,30000);
    assert.equal(task.status,'awaiting_review',task.error);assert.equal(task.executor,'desktop');assert.match(task.summary,/中文任务已完成 🧪/);assert.match(task.checks[0]!.output,/中文验证通过/);
    const agent=f.h.agents.get(task.sessionId!);agent.events.push({seq:agent.events.length,type:'user/message',data:{source:{kind:'user',rpcId:'human-direction'},content:[{type:'text',text:'新的用户方向'}]}});
    await assert.rejects(f.engine.submit({operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'approved',summary:'approved',issues:[]}}),/旧审查/);
    assert.equal(task.commit,undefined);await f.engine.submit({operation:'revalidate',taskId:task.id});assert.equal(task.status,'awaiting_review');assert.equal(task.nativeGuidance?.[0]?.text,'新的用户方向');
    await f.engine.submit({operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'approved',summary:'reviewed current native result',issues:[]}});
    assert.equal(task.status,'completed',task.error);assert.match(task.commit!,/^[a-f0-9]{40}$/);assert.equal(await git(task.worktree!,['status','--short']),'');
    assert.equal(await readFile(path.join(f.repo,'value.txt'),'utf8'),'before\n');assert.equal(f.h.counts().createCalls,1);assert.equal(f.h.counts().promptCalls,1);
  }finally{await f.close();}
});
test('user guidance is returned to Codex and validation conflicts do not trigger an automatic opposing prompt', {skip:process.platform!=='win32'},async()=>{
  const f=await fixture();f.h.guide('保留当前实现，验收条件需要 Codex 根据新方向调整。');f.handoff.validationCommands=["throw 'acceptance conflicts with user guidance'"];
  try{
    const task=await f.engine.submit({operation:'execute',handoff:f.handoff});await f.engine.wait(task.id,30000);
    assert.equal(task.status,'needs_changes',task.error);assert.match(task.error!,/用户引导/);assert.equal(task.nativeGuidance?.[0]?.text,'保留当前实现，验收条件需要 Codex 根据新方向调整。');assert.equal(f.h.counts().promptCalls,1);assert.equal(task.commit,undefined);
  }finally{await f.close();}
});
test('native cancellation stops the desktop-owned task without deleting its worktree', {skip:process.platform!=='win32'},async()=>{
  const f=await fixture(10000);
  try{
    const task=await f.engine.submit({operation:'execute',handoff:f.handoff});await f.h.started;
    await f.engine.cancel(task.id);await f.engine.wait(task.id,30000);
    assert.equal(task.status,'cancelled');assert.equal(task.commit,undefined);assert.equal(f.h.agents.get(task.sessionId!).status,'idle');assert.equal((await readFile(path.join(task.worktree!,'value.txt'),'utf8')).trim(),'before');
  }finally{await f.close();}
});

test('cancellation while persisting a prepared native session never submits its prompt', {skip:process.platform!=='win32'},async()=>{
  const f=await fixture(),id=randomUUID(),controller=new AbortController();
  const task={id,handoff:f.handoff,worktree:path.join(f.store.root,'tasks',id,'workspace')} as Task;
  await mkdir(task.worktree!,{recursive:true});
  try{
    await assert.rejects(runDesktopDsh(task,f.store.settings,'Explicit test handoff',{
      log:()=>{},permission:async()=>({outcome:{outcome:'cancelled'}}),
      session:async(sessionId)=>{task.sessionId=sessionId;controller.abort('user');},
    },controller.signal),/取消/);
    assert.equal(f.h.counts().promptCalls,0);assert.equal(f.h.agents.get(task.sessionId!).status,'idle');
    assert.equal(f.h.agents.get(task.sessionId!).events.at(-1).data.reason.kind,'aborted');
  }finally{await f.close();}
});
