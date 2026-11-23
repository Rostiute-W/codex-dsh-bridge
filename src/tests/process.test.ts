import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, copyFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runProcess } from '../process.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('runProcess 在直接子进程退出但孙进程仍占用 stdio 时按时超时退出而不挂起', { timeout: 15_000 }, async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-proc-'));
  const pidFile = path.join(tempDir, 'grandchild.pid');
  t.after(async () => {
    try {
      const pid = Number((await readFile(pidFile, 'utf8')).trim());
      if (Number.isInteger(pid) && pid > 0) {
        try { process.kill(pid); } catch { /* 已退出 */ }
      }
    } catch { /* 文件未生成 */ }
    await rm(tempDir, { recursive: true, force: true });
  });

  const parentScript = [
    "const { spawn } = require('node:child_process');",
    "const { writeFileSync } = require('node:fs');",
    `const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 60000)'], { stdio: 'inherit', detached: true, windowsHide: true });`,
    `writeFileSync(${JSON.stringify(pidFile)}, String(child.pid), 'utf8');`,
    'child.unref();',
    'process.exit(0);',
  ].join('\n');

  const started = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', parentScript], { timeoutMs: 300 }),
    /命令运行超时，已终止进程树/,
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 12_000, `超时后未在宽限期内结束，耗时 ${elapsed}ms`);
});

test('dsh-plugin 在请求已中止时不调用 prompt，未中止时传递同一 AbortSignal', async () => {
  const pluginUrl = pathToFileURL(path.join(repoRoot, 'dsh-plugin', 'index.js')).href;
  const plugin = await import(pluginUrl) as {
    nativeController: (ctx: unknown, dataRoot: string) => { call: (method: string, params: unknown, signal?: AbortSignal) => Promise<unknown> };
    nativeFailureMessage: (method: string, error: unknown) => string;
  };

  const dataRoot = path.join(os.tmpdir(), 'codex-dsh-plugin-unit');
  const taskId = '11111111-1111-4111-a111-111111111111';
  const cwd = path.join(dataRoot, 'tasks', taskId, 'workspace');
  let promptCalls = 0;
  let capturedSignal: AbortSignal | undefined;
  let enteredCreate = () => {};
  let releaseCreate = () => {};
  const nextGate = () => {
    const entered = new Promise<void>(resolve => { enteredCreate = resolve; });
    const proceed = new Promise<void>(resolve => { releaseCreate = resolve; });
    return { entered, proceed, release: () => releaseCreate() };
  };
  let gate = nextGate();

  const ctx = {
    agents: new Map([[`session-codex-${taskId}`, { status: 'idle', inbox: { nextTurn: [], nextStep: [] } }]]),
    sessionQuery: {
      async observeSession() { return { events: [], [Symbol.dispose]() {} }; },
    },
    sessionController: {
      async create() {
        enteredCreate();
        await gate.proceed;
      },
      async rename() {},
      async prompt(_params: unknown, signal: AbortSignal) {
        promptCalls++;
        capturedSignal = signal;
      },
    },
  };

  const controller = plugin.nativeController(ctx, dataRoot);
  const abort1 = new AbortController();
  const pending1 = controller.call('send', { taskId, cwd, title: 'test', prompt: 'hello', requestId: 'req-1' }, abort1.signal);
  await gate.entered;
  abort1.abort('timeout');
  gate.release();
  await assert.rejects(pending1, (err: { code?: string }) => err?.code === 'request/aborted-before-submit');
  assert.equal(promptCalls, 0);
  assert.match(plugin.nativeFailureMessage('send', { code: 'request/aborted-before-submit' }), /request\/aborted-before-submit/);

  gate = nextGate();
  const abort2 = new AbortController();
  const pending2 = controller.call('send', { taskId, cwd, title: 'test', prompt: 'hello', requestId: 'req-2' }, abort2.signal);
  await gate.entered;
  gate.release();
  await pending2;
  assert.equal(promptCalls, 1);
  assert.equal(capturedSignal, abort2.signal);
});

test('dsh-plugin 管道客户端断开时中止 in-flight send，不再触发 prompt', async t => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-pipe-'));
  const previousDshHome = process.env.DSH_HOME;
  const cleanups: (() => void)[] = [];
  t.after(async () => {
    for (const fn of cleanups) fn();
    if (previousDshHome === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previousDshHome;
    await rm(tempDir, { recursive: true, force: true });
  });

  const dataRoot = path.join(tempDir, 'data');
  const dshHome = path.join(tempDir, 'dsh-home');
  process.env.DSH_HOME = dshHome;
  await copyFile(path.join(repoRoot, 'dsh-plugin', 'index.js'), path.join(tempDir, 'index.js'));
  await copyFile(path.join(repoRoot, 'dsh-plugin', 'package.json'), path.join(tempDir, 'package.json'));
  await writeFile(path.join(tempDir, 'bridge-config.json'), JSON.stringify({ dataRoot }), 'utf8');

  const taskId = '22222222-2222-4222-a222-222222222222';
  const cwd = path.join(dataRoot, 'tasks', taskId, 'workspace');
  let promptCalls = 0;
  let enteredCreate = () => {};
  let releaseCreate = () => {};
  const entered = new Promise<void>(resolve => { enteredCreate = resolve; });
  const proceed = new Promise<void>(resolve => { releaseCreate = resolve; });
  const ctx = {
    agents: new Map([[`session-codex-${taskId}`, { status: 'idle', inbox: { nextTurn: [], nextStep: [] } }]]),
    sessionQuery: { async observeSession() { return { events: [], [Symbol.dispose]() {} }; } },
    sessionController: {
      async create() { enteredCreate(); await proceed; },
      async rename() {},
      async prompt() { promptCalls++; },
    },
    webServer: { register() { return () => {}; } },
    connection: { requestRejection() { return undefined; } },
    effect(fn: () => (() => void) | void) {
      const dispose = fn();
      if (typeof dispose === 'function') cleanups.push(dispose);
    },
  };

  const plugin = await import(pathToFileURL(path.join(tempDir, 'index.js')).href) as { apply: (c: unknown) => Promise<void> };
  await plugin.apply(ctx);

  const normalizedHome = path.normalize(path.resolve(dshHome)).toLowerCase();
  const pipeName = `\\\\.\\pipe\\codex-dsh-${createHash('sha256').update(os.userInfo().username + normalizedHome).digest('hex').slice(0, 24)}`;
  const socket = net.connect(pipeName);
  await new Promise<void>((resolve, reject) => {
    socket.once('connect', resolve);
    socket.once('error', reject);
  });
  socket.write(JSON.stringify({ id: randomUUID(), method: 'send', params: { taskId, cwd, title: 'pipe test', prompt: 'hello', requestId: 'req-pipe' } }) + '\n');
  await entered;
  socket.destroy();
  await new Promise(resolve => setTimeout(resolve, 50));
  releaseCreate();
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(promptCalls, 0);
});
