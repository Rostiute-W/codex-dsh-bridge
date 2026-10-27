import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { Engine } from '../engine.js';
import { Store } from '../store.js';
import type { Task } from '../model.js';
import { servePipe } from '../rpc.js';
import { cleanEnvironment } from '../process.js';

function fixture() {
  const store = new Store('unused-wait-fixture');
  const task: Task = {
    id: randomUUID(), status: 'running', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    handoff: { requestId: randomUUID(), title: '等待交接', repoPath: 'unused', baseCommit: '0'.repeat(40), ready: true,
      goal: 'Wait for the existing task.', plan: 'Never submit a duplicate task.', constraints: [], allowedPaths: ['result.json'],
      validationCommands: ['exit 0'], acceptanceCriteria: ['checks pass'], commitMessage: 'test: verify task handoff' },
    round: 0, summary: '', checks: [], changedFiles: [], log: [],
  };
  store.tasks.push(task);
  return { task, engine: new Engine(store) };
}

test('wait timeout explicitly instructs continuation of the same task', async () => {
  const { engine, task } = fixture();
  const result = await engine.wait(task.id, 0);
  assert.equal(result.status, 'running');
  assert.equal((result.wait as { reason: string }).reason, 'timeout');
  assert.deepEqual(result.nextAction, {
    type: 'wait', tool: 'wait_task', arguments: { taskId: task.id, timeoutMs: 600000 },
  });
  assert.equal(engine.listenerCount('change'), 0);
});

test('a later wait receives review evidence without resubmitting execution', async () => {
  const { engine, task } = fixture();
  await engine.wait(task.id, 0);
  const pending = engine.wait(task.id, 1000);
  task.status = 'awaiting_review'; task.summary = 'DSH 已完成'; task.fingerprint = 'a'.repeat(64);
  task.checks.push({ command: 'exit 0', exitCode: 0, output: '通过', at: task.updatedAt });
  engine.emit('change');
  const result = await pending;
  assert.equal((result.wait as { reason: string }).reason, 'ready');
  assert.equal((result.nextAction as { type: string }).type, 'review');
  assert.equal(result.summary, 'DSH 已完成'); assert.equal(result.fingerprint, task.fingerprint);
  assert.equal(engine.listenerCount('change'), 0);
});

test('DSH completion and each finished check notify a progress waiter immediately', async () => {
  const { engine, task } = fixture();
  for (const advance of [
    () => { task.status = 'validating'; task.summary = 'DSH 已完成，正在验收'; },
    () => { task.checks.push({ command: 'check', exitCode: 0, output: '通过', at: task.updatedAt }); },
  ]) {
    const pending = engine.wait(task.id, 1000, true);
    let delivered = false;
    void pending.then(() => { delivered = true; });
    advance(); engine.emit('change');
    await new Promise<void>(resolve => setImmediate(resolve));
    try {
      assert.equal(delivered, true, 'progress must arrive on the change event, not after the timeout');
      const result = await pending;
      assert.equal((result.wait as { reason: string }).reason, 'progress');
      assert.equal((result.nextAction as { type: string }).type, 'wait');
      assert.equal(result.summary, 'DSH 已完成，正在验收');
    } finally { task.status = 'running'; engine.emit('change'); await pending; }
    assert.equal(engine.listenerCount('change'), 0);
    task.status = 'validating';
  }
});

test('unrelated events do not wake a waiter and legacy direct waits still await review', async () => {
  const { engine, task } = fixture();
  for (const reportProgress of [false, true]) {
    task.status = 'running';
    const pending = engine.wait(task.id, 1000, reportProgress);
    let delivered = false;
    void pending.then(() => { delivered = true; });
    if (!reportProgress) task.status = 'validating';
    engine.emit('change');
    await new Promise<void>(resolve => setImmediate(resolve));
    try { assert.equal(delivered, false); }
    finally { task.status = 'awaiting_review'; engine.emit('change'); await pending; }
    assert.equal(engine.listenerCount('change'), 0);
  }
});

test('permission, interruption and completion stop automatic waiting', async () => {
  const { engine, task } = fixture();
  for (const status of ['awaiting_permission', 'needs_attention', 'needs_changes', 'failed', 'cancelled', 'completed'] as const) {
    task.status = status;
    const result = await engine.wait(task.id, 1000, true);
    assert.equal((result.wait as { reason: string }).reason, 'ready');
    assert.equal((result.nextAction as { type: string }).type, status === 'completed' ? 'done' : 'attention');
  }
  await assert.rejects(engine.wait(randomUUID(), 1000), /找不到任务/);
  assert.equal(engine.listenerCount('change'), 0);
});

test('official MCP client continues one task from timeout through validation progress to review', { skip: process.platform !== 'win32' }, async () => {
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
  await mkdir(path.join(root, '.test-data'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.test-data', 'handoff-'));
  const { task } = fixture();
  const store = new Store(directory); store.tasks.push(task);
  const engine = new Engine(store);
  engine.submit = async () => { throw new Error('wait must never resubmit execution'); };
  const previous = process.env.BRIDGE_INSTANCE;
  process.env.BRIDGE_INSTANCE = randomUUID();
  const helper = path.join(root, 'build', 'pipe-host.exe');
  const stop = await servePipe(helper, engine, () => {});
  const client = new Client({ name: 'handoff-regression', version: '1.0.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'dist', 'mcp.js')],
    env: cleanEnvironment({ BRIDGE_PIPE_HOST: helper }) as Record<string, string> });
  const read = (response: Awaited<ReturnType<Client['callTool']>>) => {
    assert.equal(response.isError, undefined);
    const content = response.content as { type: string; text: string }[];
    return JSON.parse(content[0]!.text);
  };
  try {
    await client.connect(transport);
    let result = read(await client.callTool({ name: 'wait_task', arguments: { taskId: task.id, timeoutMs: 0 } }));
    assert.equal(result.wait.reason, 'timeout');
    assert.equal(result.nextAction.arguments.taskId, task.id);
    for (const [advance, reason, action] of [
      [() => { task.status = 'validating'; task.summary = '真实管道：DSH 已完成'; }, 'progress', 'wait'],
      [() => { task.checks.push({ command: 'check', exitCode: 0, output: '验证通过', at: task.updatedAt }); }, 'progress', 'wait'],
      [() => { task.status = 'awaiting_review'; task.fingerprint = 'b'.repeat(64); }, 'ready', 'review'],
    ] as const) {
      const pending = client.callTool({ name: result.nextAction.tool, arguments: result.nextAction.arguments });
      const deadline = Date.now() + 10000;
      while (engine.listenerCount('change') === 0 && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
      assert.equal(engine.listenerCount('change'), 1, 'the MCP call must register its existing-task waiter');
      advance(); engine.emit('change');
      result = read(await pending);
      assert.equal(result.taskId, task.id); assert.equal(result.wait.reason, reason);
      assert.equal(result.nextAction.type, action);
      assert.equal(engine.listenerCount('change'), 0);
    }
    assert.equal(result.summary, '真实管道：DSH 已完成');
    assert.equal(result.fingerprint, task.fingerprint);
    assert.equal(result.checks[0].output, '验证通过');
    assert.equal(store.tasks.length, 1);
  } finally {
    task.status = 'cancelled'; engine.emit('change');
    await client.close(); stop(); await engine.shutdown();
    if (previous === undefined) delete process.env.BRIDGE_INSTANCE; else process.env.BRIDGE_INSTANCE = previous;
  }
});
