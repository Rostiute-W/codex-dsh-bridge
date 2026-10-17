import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';

const uuid=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
const modelUnavailable = () => Object.assign(new Error('所选模型或推理强度不可用。'), {code:'session/model-unavailable'});
function modelSelection(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).some(key => !['provider','model','reasoningEffort'].includes(key)) ||
      !['provider','model'].every(key => typeof value[key] === 'string' && value[key].trim() && value[key].length <= 300) ||
      value.reasoningEffort !== undefined && (typeof value.reasoningEffort !== 'string' || !value.reasoningEffort.trim() || value.reasoningEffort.length > 100))
    throw modelUnavailable();
  return {provider:value.provider,model:value.model,...value.reasoningEffort === undefined ? {} : {reasoningEffort:value.reasoningEffort}};
}
export async function modelCatalog(ctx) {
  const catalog = await ctx.sessionController.modelCatalog();
  // Only model metadata crosses the pipe; provider errors can contain secrets.
  return {
    home:path.resolve(process.env.DSH_HOME?.trim() || path.join(os.homedir(),'.dsh')),
    default:modelSelection(catalog.default),
    groups:catalog.groups.map(group => ({
      id:group.id,name:group.name,
      models:group.models.map(model => ({
        id:model.id,name:model.name,
        ...model.reasoning ? {reasoning:{
          efforts:model.reasoning.efforts.map(effort => ({id:effort.id,name:effort.name})),
          ...model.reasoning.defaultEffort === undefined ? {} : {defaultEffort:model.reasoning.defaultEffort},
        }} : {},
      })),
    })),
    failures:catalog.failures.map(group => ({id:group.id,name:group.name,message:'该供应商模型读取失败，请在 DSH 中检查配置或连接。'})),
  };
}
export function nativeFailureMessage(method,error) {
  const operation=['prepare','send','inspect','focus','cancel','lock','unlock','capabilities','models'].includes(method)?method:'request';
  const reasons={
    'session/cwd-conflict':'会话工作目录与任务工作区不一致。',
    'workspace/not-found':'DSH 工作区不存在。',
    'session/workspace-attach-failed':'DSH 会话无法附着到工作区。',
    'session/writer-held':'会话写锁被其他进程占用。',
    'session/not-found':'会话未附着或已关闭，请明确恢复任务。',
    'session/agent-busy':'DSH 拒绝受理消息，请检查原生对话状态。',
    'session/model-unavailable':'所选模型或推理强度不可用，请刷新模型列表并检查 DSH 路由。未改用其他模型。',
    'session/attachment-invalid':'DSH 拒绝消息附件。',
    'gateway/bad-request':'DSH 拒绝请求参数。',
    'gateway/internal':'DSH 内部服务失败。',
  };
  const code=Object.hasOwn(reasons,error?.code)?error.code:error?.name==='TypeError'?'interface/type-error':'unknown';
  return `DSH 原生操作失败（${operation} / ${code}）：${reasons[code] ?? '请检查连接插件与 DSH 版本及会话状态。'}`;
}
export function nativeController(ctx, dataRoot) {
  const guards=new Map();let focus={seq:0};
  const sessionId=taskId=>'session-codex-'+taskId;
  const state=async taskId=>{
    const id=sessionId(taskId),agent=ctx.agents.get(id);
    if(!agent)throw new Error('DSH 原生会话未附着，请明确恢复任务。');
    const observation=await ctx.sessionQuery.observeSession(id);
    try {
      const events=observation.events;
      const end=events.findLast(event=>event.type==='turn/end');
      const message=events.findLast(event=>event.type==='assistant/message');
      return {sessionId:id,status:agent.status,pending:agent.inbox.nextTurn.length+agent.inbox.nextStep.length,
        cursor:events.at(-1)?.seq ?? -1,endSeq:end?.seq ?? -1,reason:end?.data.reason?.kind ?? end?.data.reason,
        guidance:events.filter(event=>event.type==='user/message'&&event.data.source?.kind==='user'&&!event.data.source.rpcId?.startsWith(taskId+'-')).slice(-20).map(event=>({seq:event.seq,text:(event.data.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('').slice(-8000)})),
        summary:(message?.data.message?.content ?? message?.data.content ?? []).filter(part=>part.type==='text').map(part=>part.text).join('').slice(-128000)};
    } finally {observation[Symbol.dispose]();}
  };
  ctx.on('agent/pre-step',(payload,next)=>{
    const guard=guards.get(payload.agent.id);
    return guard && guard.until>Date.now() ? Promise.resolve({kind:'reject'}) : next();
  });
  return {focus:()=>focus,async call(method,params) {
    if(method==='capabilities')return {protocol:1,nativeChat:true,modelSelection:typeof ctx.sessionController.modelCatalog === 'function' && typeof ctx.sessionController.selectModel === 'function'};
    if(method==='models')return modelCatalog(ctx);
    if(!params||!uuid.test(params.taskId))throw new Error('无效的任务 ID。');
    const id=sessionId(params.taskId);
    if(method==='send'||method==='prepare') {
      const expected=path.join(dataRoot,'tasks',params.taskId,'workspace');
      if(typeof params.cwd!=='string'||path.resolve(params.cwd).toLowerCase()!==path.resolve(expected).toLowerCase()
        ||typeof params.title!=='string'||!params.title.trim()||params.title.length>160)throw new Error('原生交接参数超出范围。');
      if(method==='send'&&(typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>256000
        ||typeof params.requestId!=='string'||params.requestId.length>160))throw new Error('原生提示词超出范围。');
      if(guards.has(id)&&guards.get(id).until>Date.now())throw new Error('会话正在提交审查结果。');
      const selected = params.nativeModel == null ? undefined : modelSelection(params.nativeModel);
      const attached=ctx.agents.get(id);
      await ctx.sessionController.create({sessionId:id,cwd:expected});
      if(!attached)await ctx.sessionController.rename({sessionId:id,title:params.title});
      if (selected) {
        const observation = await ctx.sessionQuery.observeSession(id);
        let alreadySelected;
        try {
          // Durable events survive connector restarts and preserve human model changes.
          alreadySelected = observation.events.some(event => event.type === 'model/selection' || event.type === 'user/message');
        } finally {observation[Symbol.dispose]();}
        if (!alreadySelected) {
          const catalog = await modelCatalog(ctx);
          const model = catalog.groups.find(group => group.id === selected.provider)?.models.find(model => model.id === selected.model);
          if (!model || selected.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selected.reasoningEffort)) throw modelUnavailable();
          const current = await state(params.taskId);
          if (current.status !== 'idle' || current.pending) throw Object.assign(new Error('会话正在运行。'),{code:'session/agent-busy'});
          await ctx.sessionController.selectModel({sessionId:id,...selected});
        }
      }
      const before=await state(params.taskId);
      // Public Host service admission requires the caller's AbortSignal (not
      // just the request consumed by its internal command implementation).
      if(method==='send')await ctx.sessionController.prompt({sessionId:id,requestId:params.requestId,content:[{type:'text',text:params.prompt}],mode:'followup',clientTimeZone:'Asia/Shanghai'},new AbortController().signal);
      focus={seq:focus.seq+1,sessionId:id};
      return {sessionId:id,beforeSeq:before.cursor};
    }
    if(method==='inspect')return state(params.taskId);
    if(method==='focus'){focus={seq:focus.seq+1,sessionId:id};return {ok:true};}
    if(method==='cancel'){ctx.sessionController.cancel({sessionId:id});return {ok:true};}
    if(method==='lock') {
      const current=await state(params.taskId);
      if(guards.has(id)&&guards.get(id).until>Date.now())throw new Error('会话正在提交审查结果。');
      if(current.status!=='idle'||current.pending||current.cursor!==params.cursor)throw new Error('DSH 已继续执行，必须重新验证。');
      const token=randomUUID();guards.set(id,{token,until:Date.now()+300000});return {token};
    }
    if(method==='unlock'){if(guards.get(id)?.token===params.token)guards.delete(id);return {ok:true};}
    throw new Error('无效的原生会话操作。');
  }};
}
export async function startNativePipe(ctx, config, pipe) {
  const controller=nativeController(ctx,config.dataRoot);
  let child,reader,retryTimer,stopped=false,initialized=false;
  const stop=()=>{stopped=true;clearTimeout(retryTimer);reader?.close();child?.stdin.end();child?.kill();};
  const retry=()=>{
    if(stopped||retryTimer)return;
    retryTimer=setTimeout(()=>{retryTimer=undefined;void connect().catch(()=>retry());},1000);
  };
  const connect=async()=>{
    const server=spawn(config.pipeHost,[pipe.split('\\').at(-1)+'-desktop'],{stdio:'pipe',windowsHide:true,env:{SystemRoot:process.env.SystemRoot}});
    child=server;server.stdin.on('error',()=>{});
    const lines=createInterface({input:server.stdout});reader=lines;
    await new Promise((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error('DSH 原生连接启动超时')),10000);
    const lost=error=>{clearTimeout(timer);lines.close();reject(error);if(initialized&&!stopped)retry();};
    server.once('error',lost);
    server.once('exit',()=>lost(new Error('DSH 原生连接退出')));
    lines.on('line',line=>{
      let packet;try{packet=JSON.parse(line);}catch{return;}
      if(packet.ready){clearTimeout(timer);initialized=true;resolve();return;}
      if(typeof packet.payload!=='string')return;
      void(async()=>{
        let id,method;
        try{const request=JSON.parse(packet.payload);id=request.id;method=request.method;if(!uuid.test(id))throw new Error('无效请求');const result=await controller.call(method,request.params);server.stdin.write(JSON.stringify({client:packet.client,payload:JSON.stringify({id,result})})+'\n');}
        catch(error){server.stdin.write(JSON.stringify({client:packet.client,payload:JSON.stringify({id,error:nativeFailureMessage(method,error)})})+'\n');}
      })();
    });
    }).catch(error=>{server.kill();throw error;});
  };
  ctx.effect(()=>stop,'bridge-native:pipe');
  await connect().catch(error=>{stop();throw error;});
  ctx.effect(()=>ctx.webServer.register({kind:'exact',path:'/codex-dsh-bridge/native-focus',handler:(req,res)=>{
    const rejection=ctx.connection.requestRejection(req);if(rejection!==undefined){res.writeHead(rejection);res.end();return;}
    if(req.method!=='GET'){res.writeHead(405);res.end();return;}
    res.writeHead(200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(controller.focus()));
  }}),'bridge-native:focus');
}
