import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { access } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { cleanEnvironment } from './process.js';

export const dshPath = process.env.DSH_PATH || 'E:\\DeepSeek Harness\\resources\\runtime\\cli\\bin\\dsh.cmd';
export const dshHome = path.resolve(process.env.DSH_HOME?.trim() || path.join(os.homedir(), '.dsh'));
export interface Model { provider: string; model: string; reasoningEffort?: string }
export interface ModelCatalog {
  home: string; default: Model;
  groups: { id: string; name: string; models: { id: string; name: string; reasoning?: { efforts: { id: string; name: string }[]; defaultEffort?: string } }[] }[];
  failures: { id: string; name: string; message: string }[];
}
export interface NativeState {
  sessionId: string; status: string; pending: number; cursor: number; endSeq: number;
  reason?: string; summary: string; guidance: { seq: number; text: string }[];
  blocked?: { kind: 'approval' | 'question'; seq: number; text: string };
}
export interface Send {
  taskId: string; cwd: string; title: string; prompt: string; requestId: string; model?: Model;
}
export interface DshClient {
  models(): Promise<ModelCatalog>;
  send(params: Send): Promise<{ sessionId: string; beforeSeq: number }>;
  inspect(taskId: string): Promise<NativeState>;
  cancel(taskId: string): Promise<unknown>;
}

export function parseModel(value: string): Model | undefined {
  if (!value.trim()) return;
  const slash = value.indexOf('/');
  const at = value.lastIndexOf('@');
  const end = at > slash ? at : value.length;
  if (slash < 1 || end <= slash + 1 || at >= 0 && (at <= slash || at === value.length - 1)) throw new Error('模型格式应为 provider/model 或 provider/model@reasoningEffort。');
  const selected: Model = { provider: value.slice(0, slash), model: value.slice(slash + 1, end) };
  if (at > slash) selected.reasoningEffort = value.slice(at + 1);
  if (selected.provider.length > 300 || selected.model.length > 300 || (selected.reasoningEffort?.length ?? 0) > 100) throw new Error('模型标识过长。');
  return selected;
}

export function validateModel(selection: Model, catalog: ModelCatalog): void {
  const model = catalog.groups.find(group => group.id === selection.provider)?.models.find(model => model.id === selection.model);
  if (!model) throw new Error('所选 DSH 模型或路由当前不可用，不会改用其他模型。');
  if (selection.reasoningEffort && !model.reasoning?.efforts.some(effort => effort.id === selection.reasoningEffort)) throw new Error('所选模型不支持此推理强度。');
}

function request(method: string, params: unknown): Promise<unknown> {
  const normalizedHome = path.normalize(dshHome).toLowerCase();
  const name = createHash('sha256').update(os.userInfo().username + normalizedHome).digest('hex').slice(0, 24);
  return new Promise((resolve, reject) => {
    const socket = net.connect(`\\\\.\\pipe\\codex-dsh-${name}`);
    const id = randomUUID();
    let data = '', size = 0, settled = false;
    const finish = (error?: unknown, result?: unknown) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy();
      if (error) reject(error); else resolve(result);
    };
    const timer = setTimeout(() => finish(new Error('DSH 管道请求超过 15 秒，现场已保留。')), 15_000);
    socket.setEncoding('utf8');
    socket.once('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', (chunk: string) => {
      size += Buffer.byteLength(chunk);
      if (size > 8 * 1024 * 1024) { finish(new Error('DSH 响应超过 8MB。')); return; }
      data += chunk;
      const end = data.indexOf('\n');
      if (end < 0) return;
      try {
        const response = JSON.parse(data.slice(0, end));
        if (response.id !== id) throw new Error('DSH 响应 ID 不匹配。');
        finish(response.error ? new Error(String(response.error)) : undefined, response.result);
      } catch (error) { finish(error); }
    });
    socket.once('error', error => finish(error));
    socket.once('close', () => finish(new Error('DSH 管道连接已关闭。')));
  });
}

const missingPipe = (error: unknown) => ['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '');
let startup: Promise<void> | undefined;
async function ensureConnection(): Promise<void> {
  if (!startup) startup = (async () => {
    const executable = path.resolve(path.dirname(dshPath), '../../../..', 'DeepSeek Harness.exe');
    try { await access(executable); } catch { throw new Error('找不到 DeepSeek Harness.exe，请核对 DSH_PATH。'); }
    let launchError: Error | undefined;
    const child = spawn(executable, [], { detached: true, windowsHide: true, stdio: 'ignore', env: cleanEnvironment({ DSH_HOME: dshHome }) });
    child.once('error', error => { launchError = error; });
    child.unref();
    for (let attempt = 0; attempt < 60; attempt++) {
      await delay(500);
      if (launchError) throw new Error('无法启动 DSH 桌面程序。');
      try { await request('models', {}); return; }
      catch (error) { if (!missingPipe(error)) throw error; }
    }
    throw new Error('DSH 插件未就绪，请安装插件后从托盘完整退出并重启 DSH。');
  })().finally(() => { startup = undefined; });
  await startup;
}

async function nativeRequest(method: string, params: unknown): Promise<unknown> {
  try { return await request(method, params); }
  catch (error) { if (!missingPipe(error)) throw error; }
  // 只有尚未建立连接时才启动 DSH；已发出的请求超时不能自动重发。
  await ensureConnection();
  return request(method, params);
}

export const dsh: DshClient = {
  async models() { return await nativeRequest('models', {}) as ModelCatalog; },
  async send(params) { return await nativeRequest('send', params) as { sessionId: string; beforeSeq: number }; },
  async inspect(taskId) { return await nativeRequest('inspect', { taskId }) as NativeState; },
  async cancel(taskId) { return nativeRequest('cancel', { taskId }); },
};
