import net from 'node:net';
import { createHash, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { runProcess, cleanEnvironment } from './process.js';
import { safeError } from './model.js';
import type { Engine } from './engine.js';
import { z } from 'zod';
import { observerSnapshot } from './observer.js';

const envelopeSchema = z.object({ id: z.string().uuid(), method: z.enum(['submit', 'wait', 'result', 'cancel', 'ping', 'observe']), params: z.unknown() }).strict();
// Read the shipped manifest instead of a hardcoded version so ping matches package.json.
const version: string = (JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version;
export async function identity(host: string): Promise<string> {
  const output = await runProcess(host, ['--identity'], { env: cleanEnvironment(), timeoutMs: 10_000 });
  if (output.code !== 0 || !/^S-1-[0-9-]+$/.test(output.stdout.trim())) throw new Error('无法获取 Windows 用户标识。');
  return output.stdout.trim();
}
export function pipeName(sid: string): string {
  return 'codex-dsh-' + createHash('sha256').update(sid + (process.env.BRIDGE_INSTANCE ?? '')).digest('hex').slice(0, 24);
}
export function pipePath(name: string): string { return `\\\\.\\pipe\\${name}`; }
export async function servePipe(host: string, engine: Engine, onCall: () => void): Promise<() => void> {
  const name = pipeName(await identity(host));
  // Spawn directly: this host owns only the ACL-protected IPC server, not an agent process.
  const child = spawn(host, [name], { stdio: 'pipe', windowsHide: true, env: cleanEnvironment() });
  child.stdin.on('error', error => engine.emit('persistence-error', safeError(error)));
  const reader = createInterface({ input: child.stdout });
  let readyResolve: () => void;
  let readyReject: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  child.on('error', error => readyReject(error));
  child.on('exit', () => { readyReject(new Error('命名管道服务退出。')); engine.emit('persistence-error', 'MCP 管道已关闭，请重启软件。'); });
  reader.on('line', line => {
    void (async () => {
      const message = JSON.parse(line);
      if (message.ready) { readyResolve(); return; }
      if (typeof message.client !== 'string' || typeof message.payload !== 'string') return;
      let id: string | undefined;
      try {
        const request = envelopeSchema.parse(JSON.parse(message.payload)); id = request.id;
        if (request.method !== 'observe') onCall();
        let result: unknown;
        if (request.method === 'submit') result = engine.result((await engine.submit(request.params)).id);
        else if (request.method === 'ping') result = { name: 'Codex DSH Bridge', version };
        else if (request.method === 'observe') {
          const params = z.object({ taskId: z.string().uuid().optional() }).strict().parse(request.params);
          result = observerSnapshot(engine.store.tasks, params.taskId);
        }
        else {
          const params = z.object({ taskId: z.string().uuid(), timeoutMs: z.number().int().min(0).max(600000).optional() }).strict().parse(request.params);
          if (request.method === 'wait') result = await engine.wait(params.taskId, params.timeoutMs ?? 600000, true);
          else if (request.method === 'cancel') result = engine.result((await engine.cancel(params.taskId)).id);
          else result = engine.result(params.taskId);
        }
        child.stdin.write(JSON.stringify({ client: message.client, payload: JSON.stringify({ id, result }) }) + '\n');
      } catch (error) {
        child.stdin.write(JSON.stringify({ client: message.client, payload: JSON.stringify({ id, error: safeError(error) }) }) + '\n');
      }
    })().catch(error => engine.emit('persistence-error', safeError(error)));
  });
  let timer: NodeJS.Timeout | undefined;
  try { await Promise.race([ready, new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('命名管道启动超时。')), 10000); })]); }
  catch (error) { child.kill(); throw error; }
  finally { clearTimeout(timer); }
  return () => { reader.close(); child.stdin.end(); child.kill(); };
}
export async function pipeRequest(host: string, method: string, params: unknown, suffix = ''): Promise<unknown> {
  const name = pipeName(await identity(host)) + suffix;
  const once = () => new Promise<unknown>((resolve, reject) => {
    const socket = net.connect(pipePath(name));
    socket.setEncoding('utf8');
    const id = randomUUID(); let data = '';
    const timer = setTimeout(() => { socket.destroy(); reject(new Error('桌面服务响应超时，任务现场仍保存在软件中。')); }, suffix ? 15000 : 620000);
    const finish = () => { clearTimeout(timer); socket.destroy(); };
    socket.on('connect', () => socket.write(JSON.stringify({ id, method, params }) + '\n'));
    socket.on('data', bytes => {
      data += bytes.toString();
      if (data.length > 8_000_000) { finish(); reject(new Error('服务响应过大。')); return; }
      const end = data.indexOf('\n');
      if (end < 0) return;
      try { const response = JSON.parse(data.slice(0, end)); if (response.id !== id) throw new Error('响应标识不匹配。'); finish(); if (response.error) reject(new Error(response.error)); else resolve(response.result); }
      catch (error) { finish(); reject(error); }
    });
    socket.on('error', error => { finish(); reject(error); });
    socket.on('end', () => { if (!data.includes('\n')) { finish(); reject(new Error('桌面服务断开。')); } });
  });
  try { return await once(); }
  catch (error) {
    if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
    if (suffix) throw error;
    const executable = process.env.BRIDGE_APP_EXECUTABLE;
    if (!executable) throw new Error('桌面软件未运行，请先打开软件，或重新安装 Codex 接入配置。');
    const root = process.env.BRIDGE_APP_ROOT ?? path.dirname(path.dirname(fileURLToPath(import.meta.url)));
    const args = process.env.BRIDGE_DEVELOPMENT === '1' ? [root, '--background'] : ['--background'];
    const child = spawn(executable, args, { detached: true, windowsHide: true, stdio: 'ignore', env: cleanEnvironment() });
    child.unref();
    // Startup polling does not involve Codex and never repeats a task after a response is lost.
    for (let attempt = 0; attempt < 40; attempt++) {
      await new Promise(resolve => setTimeout(resolve, 250));
      try { return await once(); }
      catch (error) { if (!['ENOENT', 'ECONNREFUSED'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error; }
    }
    throw new Error('桌面软件未能启动，请从开始菜单打开并查看错误。');
  }
}
