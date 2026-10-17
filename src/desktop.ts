import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pipeRequest } from './rpc.js';
import { cleanEnvironment } from './process.js';
import { redact, modelCatalogSchema, type ModelCatalog, type NativeModel, type Task, type Settings } from './model.js';
import type { AgentRun } from './acp.js';

const helper = () => process.env.BRIDGE_JOB_HOST ?? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../build/pipe-host.exe');
export interface NativeState { sessionId: string; status: string; pending: number; cursor: number; endSeq: number; reason?: string; summary: string; guidance:{seq:number;text:string}[] }
export async function nativeRequest(method: string, params: unknown): Promise<unknown> { return pipeRequest(helper(), method, params, '-desktop'); }
async function requireModelSelection(): Promise<void> {
  const capability = await nativeRequest('capabilities', {}) as {modelSelection?: boolean};
  if (!capability.modelSelection) throw new Error('请先升级并安装 DSH 对话连接 0.1.7，然后从托盘完整退出并重启 DSH，才能读取或选择模型。');
}
export async function getDesktopModels(settings: Settings): Promise<ModelCatalog> {
  await ensureDesktopConnection(settings);
  await requireModelSelection();
  const catalog = modelCatalogSchema.parse(await nativeRequest('models', {}));
  if (settings.dshHome && path.resolve(settings.dshHome).toLowerCase() !== path.resolve(catalog.home).toLowerCase())
    throw new Error('当前运行的 DSH 数据目录与设置不一致，请退出 DSH 后再读取所选目录。');
  return catalog;
}
export function validateDesktopModel(selection: NativeModel, catalog: ModelCatalog): void {
  const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model);
  if (!model) throw new Error('所选 DSH 模型当前不可用，请刷新模型列表并检查该供应商或路由。不会改用其他模型。');
  if (selection.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort))
    throw new Error('所选模型不支持此推理强度，请刷新模型列表后重新选择。');
}
const missingPipe = (error:unknown) => ['ENOENT','ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
let desktopStartup: Promise<void> | undefined;
export async function ensureDesktopConnection(settings: Settings, signal?: AbortSignal): Promise<void> {
  if(signal?.aborted)throw new Error('任务已取消。');
  try { await nativeRequest('capabilities', {}); return; }
  catch(error) { if(!missingPipe(error))throw error; }
  if(!desktopStartup) desktopStartup=(async()=>{
    const executable=path.resolve(path.dirname(settings.dshPath),'../../../..','DeepSeek Harness.exe');
    try { await access(executable); } catch { throw new Error('找不到 DSH 桌面程序，请在运行设置中核对 DSH 路径。'); }
    let launchError: Error | undefined;
    const child=spawn(executable,[],{detached:true,windowsHide:true,stdio:'ignore',env:cleanEnvironment(settings.dshHome?{DSH_HOME:settings.dshHome}:{})});
    child.once('error',error=>{launchError=error;});child.unref();
    for(let attempt=0;attempt<60;attempt++) {
      await new Promise(resolve=>setTimeout(resolve,500));
      if(launchError)throw new Error('无法启动 DSH 桌面程序，请检查安装路径。');
      try {await nativeRequest('capabilities',{});return;}catch(error){if(!missingPipe(error))throw error;}
    }
    throw new Error('DSH 原生对话连接未就绪。请在 Codex 接入页安装 DSH 对话连接，并从托盘完整退出后重启 DSH。任务现场已保留。');
  })().finally(()=>{desktopStartup=undefined;});
  const ready=desktopStartup;
  if(!signal) {await ready;return;}
  await new Promise<void>((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new Error('任务已取消。'));};
    signal.addEventListener('abort',abort,{once:true});if(signal.aborted)abort();
    ready.then(()=>{signal.removeEventListener('abort',abort);resolve();},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
export async function openDesktopChat(task: Task, settings: Settings): Promise<void> {
  if(task.executor!=='desktop'||!task.sessionId)throw new Error('此任务没有 DSH 原生对话。');
  // Focus is safe to retry; opening a chat never resubmits its prompt.
  for(let attempt=0;attempt<2;attempt++) {
    await ensureDesktopConnection(settings);
    try{await nativeRequest('focus',{taskId:task.id});return;}
    catch(error){if(!missingPipe(error))throw error;if(attempt===1)throw new Error('DSH 原生对话连接已断开，请完整重启 DSH 后再打开。任务不会重新执行。');}
  }
}
export async function nativeIdle(task: Task, exact = true): Promise<NativeState> {
  const state = await nativeRequest('inspect', { taskId:task.id }) as NativeState;
  task.nativeGuidance=state.guidance.map(item=>({...item,text:redact(item.text)}));
  if (state.status !== 'idle' || state.pending) throw new Error('DSH 原生对话仍在运行或有排队消息，请在 DSH 完成引导后重新验证。');
  if (exact && state.cursor !== task.nativeCursor) throw new Error('DSH 对话已继续，旧审查已失效。请重新验证当前结果。');
  return state;
}
export const runDesktopDsh: AgentRun = async (task, settings, instruction, hooks, signal) => {
  if (!task.worktree) throw new Error('没有任务工作区。');
  // Only the desktop Host creates and writes this ordinary session. No ACP worker is spawned.
  await ensureDesktopConnection(settings,signal);
  if(task.nativeModel)await requireModelSelection();
  if(signal.aborted)throw new Error('任务已取消。');
  const requestId = task.id + '-' + createHash('sha256').update(instruction).digest('hex');
  try {
    const prepared=await nativeRequest('prepare',{taskId:task.id,cwd:task.worktree,title:task.handoff.title,nativeModel:task.nativeModel}) as {sessionId:string};
    await hooks.session(prepared.sessionId,{execution:'desktop',interactive:true});
    if(signal.aborted)throw new Error('任务已取消。');
    const started = await nativeRequest('send', {taskId:task.id,cwd:task.worktree,title:task.handoff.title,prompt:instruction,requestId,nativeModel:task.nativeModel}) as {sessionId:string;beforeSeq:number};
    await hooks.session(started.sessionId,{execution:'desktop',interactive:true});
    hooks.log('desktop','任务已在 DSH 原生聊天创建；可以在那里补充要求、引导方向和处理权限。');
    while(!signal.aborted) {
      const state=await nativeRequest('inspect',{taskId:task.id}) as NativeState;
      task.nativeGuidance=state.guidance.map(item=>({...item,text:redact(item.text)}));
      if(state.status==='idle' && !state.pending && state.endSeq>started.beforeSeq) {
        if(state.reason!=='completed')throw new Error(`DSH 对话未正常完成（${state.reason ?? 'unknown'}），现场已保留。`);
        task.nativeCursor=state.cursor;
        await hooks.session(state.sessionId,{execution:'desktop',interactive:true});
        return redact(state.summary);
      }
      await new Promise(resolve=>setTimeout(resolve,500));
    }
    throw new Error('DSH 原生任务已取消或超时。');
  } finally {
    if(signal.aborted)await nativeRequest('cancel',{taskId:task.id}).catch(()=>hooks.log('error','未确认 DSH 已停止，请在原生聊天检查现场。'));
  }
};
