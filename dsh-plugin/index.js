import net from 'node:net';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
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
  // 管道仅传模型元数据，供应商原始错误可能含凭据。
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
  const operation=['send','inspect','cancel','models'].includes(method)?method:'request';
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
  let focus={seq:0};
  const sessionId=taskId=>'session-codex-'+taskId;
  const questionText=raw=>{
    try {
      const parsed=typeof raw==='string'?JSON.parse(raw):raw;
      const parts=Array.isArray(parsed?.questions)
        ?parsed.questions.map(q=>[q?.header,q?.question].filter(v=>typeof v==='string'&&v.trim()).join(': ')).filter(Boolean)
        :[];
      if(parts.length)return parts.join('；');
    } catch {}
    return '等待用户回答问题';
  };
  const state=async taskId=>{
    const id=sessionId(taskId),agent=ctx.agents.get(id);
    if(!agent)throw new Error('DSH 原生会话未附着，请明确恢复任务。');
    const observation=await ctx.sessionQuery.observeSession(id);
    try {
      const events=observation.events;
      let end,message;
      const guidance=[],unresolved=new Map();
      for(const event of events) {
        if(event.type==='turn/end')end=event;
        else if(event.type==='assistant/message')message=event;
        else if(event.type==='user/message'&&event.data.source?.kind==='user'&&!event.data.source.rpcId?.startsWith(taskId+'-'))guidance.push(event);
        else if(event.type==='approval/asked'&&event.data?.id)unresolved.set('a:'+event.data.id,{kind:'approval',seq:event.seq,text:([event.data.toolName,event.data.reason].filter(v=>typeof v==='string'&&v.trim()).join(': ')||'等待权限审批').slice(0,2000)});
        else if(event.type==='approval/decided'&&event.data?.id)unresolved.delete('a:'+event.data.id);
        else if(event.type==='tool/call'&&event.data?.name==='ask_user_question'&&event.data?.callId)unresolved.set('q:'+event.data.callId,{kind:'question',seq:event.seq,text:questionText(event.data.arguments).slice(0,2000)});
        else if(event.type==='tool/result'&&event.data?.message?.toolCallId)unresolved.delete('q:'+event.data.message.toolCallId);
      }
      let blocked;
      for(const item of unresolved.values())if(!blocked||item.seq>blocked.seq)blocked=item;
      return {sessionId:id,status:agent.status,pending:agent.inbox.nextTurn.length+agent.inbox.nextStep.length,
        cursor:events.at(-1)?.seq ?? -1,endSeq:end?.seq ?? -1,reason:end?.data.reason?.kind ?? end?.data.reason,
        guidance:guidance.slice(-20).map(event=>({seq:event.seq,text:(event.data.content??[]).filter(part=>part.type==='text').map(part=>part.text).join('').slice(-8000)})),
        summary:(message?.data.message?.content ?? message?.data.content ?? []).filter(part=>part.type==='text').map(part=>part.text).join('').slice(-128000),
        ...(blocked?{blocked}:{})};
    } finally {observation[Symbol.dispose]();}
  };
  return {focus:()=>focus,async call(method,params) {
    if(method==='models')return modelCatalog(ctx);
    if(!params||!uuid.test(params.taskId))throw new Error('无效的任务 ID。');
    const id=sessionId(params.taskId);
    if(method==='send') {
      const expected=path.join(dataRoot,'tasks',params.taskId,'workspace');
      if(typeof params.cwd!=='string'||path.resolve(params.cwd).toLowerCase()!==path.resolve(expected).toLowerCase()
        ||typeof params.title!=='string'||!params.title.trim()||params.title.length>160)throw new Error('原生交接参数超出范围。');
      if((typeof params.prompt!=='string'||!params.prompt.trim()||params.prompt.length>256000
        ||typeof params.requestId!=='string'||!params.requestId.trim()||params.requestId.length>160))throw new Error('原生提示词超出范围。');
      const selected = params.model == null ? undefined : modelSelection(params.model);
      const attached=ctx.agents.get(id);
      await ctx.sessionController.create({sessionId:id,cwd:expected});
      if(!attached)await ctx.sessionController.rename({sessionId:id,title:params.title});
      if (selected) {
        const observation = await ctx.sessionQuery.observeSession(id);
        let alreadySelected;
        try {
          // 持久事件跨插件重启保留，避免覆盖用户后续选择的模型。
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
      // Host 公共服务入口要求调用方提供 AbortSignal。
      await ctx.sessionController.prompt({sessionId:id,requestId:params.requestId,content:[{type:'text',text:params.prompt}],mode:'followup',clientTimeZone:'Asia/Shanghai'},new AbortController().signal);
      focus={seq:focus.seq+1,sessionId:id};
      return {sessionId:id,beforeSeq:before.cursor};
    }
    if(method==='inspect')return state(params.taskId);
    if(method==='cancel'){await ctx.sessionController.cancel({sessionId:id});return {ok:true};}
    throw new Error('无效的原生会话操作。');
  }};
}

export const inject = ['webServer', 'connection', 'sessionController', 'sessionQuery', 'agents'];
export async function apply(ctx) {
  const config = JSON.parse(readFileSync(new URL('./bridge-config.json', import.meta.url), 'utf8'));
  if (typeof config.dataRoot !== 'string' || !path.isAbsolute(config.dataRoot)) throw new Error('插件 dataRoot 必须为绝对路径。');
  const home = path.normalize(path.resolve(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'))).toLowerCase();
  const name = createHash('sha256').update(os.userInfo().username + home).digest('hex').slice(0, 24);
  const controller = nativeController(ctx, config.dataRoot);
  const sockets = new Set();
  const server = net.createServer(socket => {
    sockets.add(socket);
    socket.setEncoding('utf8');
    socket.setTimeout(15000, () => socket.destroy());
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
    let data = '', size = 0, received = false;
    socket.on('data', chunk => {
      if (received) return;
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) { socket.destroy(); return; }
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      received = true;
      void (async () => {
        let id, method;
        try {
          const packet = JSON.parse(data.slice(0, end));
          id = packet.id; method = packet.method;
          if (!uuid.test(id) || !['models', 'send', 'inspect', 'cancel'].includes(method)) throw new Error('无效管道请求。');
          const result = await controller.call(method, packet.params);
          const response = JSON.stringify({ id, result }) + '\n';
          if (Buffer.byteLength(response) > 8 * 1024 * 1024) throw new Error('响应过大。');
          if (!socket.destroyed) socket.end(response);
        } catch (error) {
          if (!socket.destroyed) socket.end(JSON.stringify({ id, error: nativeFailureMessage(method, error) }) + '\n');
        }
      })();
    });
  });
  ctx.effect(() => () => { for (const socket of sockets) socket.destroy(); server.close(); }, 'bridge-native:pipe');
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(`\\\\.\\pipe\\codex-dsh-${name}`, () => { server.off('error', reject); resolve(); });
  });
  server.on('error', () => {});
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/codex-dsh-bridge/native-focus', handler: (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405); res.end(); return; }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(controller.focus()));
  } }), 'bridge-native:focus');
}
