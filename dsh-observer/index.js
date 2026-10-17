import net from 'node:net';
import { randomUUID, createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { startNativePipe } from './native.js';

export const inject = ['webServer', 'connection', 'sessionController', 'sessionQuery', 'agents'];
export async function observerPipe(pipeHost, instance = '') {
  if (process.platform !== 'win32' || !path.isAbsolute(pipeHost)) throw new Error('观察插件需要 Windows 管道辅助程序的绝对路径');
  const { stdout } = await promisify(execFile)(pipeHost, ['--identity'], { windowsHide: true, timeout: 10000, env: { SystemRoot: process.env.SystemRoot } });
  const sid = stdout.trim();
  if (!/^S-1-[\d-]+$/.test(sid)) throw new Error('无法确定当前 Windows 用户');
  return `\\\\.\\pipe\\codex-dsh-${createHash('sha256').update(sid + instance).digest('hex').slice(0, 24)}`;
}
export function readSnapshot(pipe, taskId, signal) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(pipe), id = randomUUID();
    socket.setEncoding('utf8');
    let data = '', settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort); socket.destroy(); error ? reject(error) : resolve(value); };
    const abort = () => finish(new Error('观察请求已关闭'));
    const timer = setTimeout(() => finish(new Error('Bridge 未响应，请检查 Bridge 软件')), 4000);
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    socket.on('connect', () => socket.write(JSON.stringify({ id, method: 'observe', params: taskId ? { taskId } : {} }) + '\n'));
    socket.on('data', bytes => {
      data += bytes.toString();
      if (data.length > 1000000) return finish(new Error('观察响应过大'));
      const end = data.indexOf('\n'); if (end < 0) return;
      try { const response = JSON.parse(data.slice(0, end)); if (response.id !== id) throw new Error('观察响应 ID 不匹配'); finish(response.error ? new Error('无法读取 Bridge 任务') : undefined, response.result); }
      catch (error) { finish(error); }
    });
    socket.on('error', () => finish(new Error('Bridge 未运行或尚未升级，请启动 Bridge 0.1.2 或更新版本')));
    socket.on('close', () => finish(new Error('Bridge 观察连接已关闭')));
  });
}
export function registerObserver(ctx, pipe) {
  const active = new Set();
  ctx.effect(() => () => { for (const request of active) request.abort(); active.clear(); }, 'bridge-observer:lifetime');
  ctx.effect(() => ctx.webServer.register({ kind: 'exact', path: '/codex-dsh-bridge/state', handler: async (req, res) => {
    const rejection = ctx.connection.requestRejection(req);
    if (rejection !== undefined) { res.writeHead(rejection); res.end(); return; }
    if (req.method !== 'GET') { res.writeHead(405, { Allow: 'GET' }); res.end(); return; }
    const params = new URL(req.url, 'http://localhost').searchParams;
    const taskId = params.get('taskId') || undefined;
    if ([...params.keys()].some(key => key !== 'taskId') || (taskId && !/^[a-f0-9-]{36}$/i.test(taskId))) { res.writeHead(400); res.end(); return; }
    const lifetime = new AbortController(); active.add(lifetime); const close = () => lifetime.abort(); res.on('close', close);
    try {
      const value = await readSnapshot(pipe, taskId, lifetime.signal);
      if (!lifetime.signal.aborted) { res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(value)); }
    } catch (error) {
      if (!lifetime.signal.aborted) { res.writeHead(503, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(JSON.stringify({ error: error.message })); }
    } finally { res.off('close', close); active.delete(lifetime); }
  } }), 'bridge-observer:read-only-route');
}
export async function apply(ctx) {
  const config = JSON.parse(readFileSync(new URL('./bridge-config.json', import.meta.url), 'utf8'));
  const pipe=await observerPipe(config.pipeHost, config.instance);
  registerObserver(ctx, pipe);
  await startNativePipe(ctx,config,pipe);
}
