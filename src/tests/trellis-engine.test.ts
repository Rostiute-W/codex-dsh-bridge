import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { git, snapshot } from '../git.js';
import { loadTrellisContext } from '../trellis.js';
import type { Handoff, Task } from '../model.js';
import type { AgentRun } from '../acp.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const taskPath = '.trellis/tasks/10-17-demo';
const trellisSpec = '.trellis/spec/impl.md';
const specText = '# 实施规范\n只改 value.txt。\n';
// git checkout 可能按 autocrlf 改写换行，断言只依赖不会变的内容标记。
const specMark = '只改 value.txt。';
const editedSpecMark = '不要改 value.txt。';

const engines = new Set<Engine>();
afterEach(async () => { for (const engine of engines) await engine.shutdown(); engines.clear(); });

/** 记录每次发送的提示，其余行为等同原 mock：把 value.txt 写成 after。 */
function recordingAgent(): { run: AgentRun; prompts: string[] } {
  const prompts: string[] = [];
  const run: AgentRun = async (task, _settings, instruction, hooks, signal) => {
    prompts.push(instruction);
    if (signal.aborted) throw new Error('cancelled');
    await writeFile(path.join(task.worktree!, 'value.txt'), 'after\n');
    hooks.log('assistant', 'mock');
    return 'mock implementation';
  };
  return { run, prompts };
}

async function put(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

async function fixture() {
  await mkdir(path.join(project, '.test-data'), { recursive: true });
  const directory = await mkdtemp(path.join(project, '.test-data', 'trellis-engine-'));
  const repo = path.join(directory, 'repo'); await mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.name', 'Bridge Test']); await git(repo, ['config', 'user.email', 'bridge-test@example.invalid']);
  await writeFile(path.join(repo, 'value.txt'), 'before\n');
  await put(repo, `${taskPath}/task.json`, JSON.stringify({ name: 'demo', status: 'in_progress' }));
  await put(repo, `${taskPath}/prd.md`, '# PRD\n把 value.txt 改成 after。\n');
  await put(repo, trellisSpec, specText);
  await put(repo, `${taskPath}/implement.jsonl`, JSON.stringify({ file: trellisSpec, reason: '实施规范' }) + '\n');
  await git(repo, ['add', '--', 'value.txt', '.trellis']);
  await git(repo, ['commit', '-m', 'test: baseline']);
  const store = new Store(path.join(directory, 'data')); await store.load();
  store.settings.executionMode = 'acp';
  const agent = recordingAgent();
  const engine = new Engine(store, agent.run);
  engines.add(engine);
  const handoff: Handoff = { requestId: randomUUID(), title: 'Mock coding task', repoPath: repo, baseCommit: await git(repo, ['rev-parse', 'HEAD']), ready: true,
    goal: 'Change value to after and verify it.', plan: 'Edit value.txt with the expected content and retain all other files.', constraints: ['No unrelated changes'],
    allowedPaths: ['value.txt'], validationCommands: ["if ((Get-Content -Raw value.txt).Trim() -ne 'after') { throw 'expected after' }"],
    acceptanceCriteria: ['value.txt equals after'], commitMessage: 'fix: update task value', trellis: { taskPath } };
  return { directory, repo, store, engine, handoff, prompts: agent.prompts };
}

async function waitFor(engine: Engine, task: Task, expected: string): Promise<void> {
  const end = Date.now() + 25_000;
  while (Date.now() < end) {
    if (task.status === expected && !engine.isActive()) return;
    if (['needs_attention', 'failed'].includes(task.status) && expected !== task.status) throw new Error(`${task.status}: ${task.error}`);
    // 用真实定时器让出事件循环；Engine 的持久化写入需要宏任务阶段才能完成。
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${expected}, received ${task.status}: ${task.error}`);
}

test('没有 Trellis 的旧交接保持原流程，也不产生快照', async () => {
  const f = await fixture();
  delete f.handoff.trellis;
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, task, 'awaiting_review');
  assert.equal(task.trellis, undefined);
  assert.equal(f.prompts[0].includes('Trellis'), false);
  assert.deepEqual(task.changedFiles, ['value.txt']);
  await assert.rejects(readFile(path.join(f.store.taskDir(task.id), 'trellis-context.json')));
});

test('初始提示包含固定上下文，快照不进入变更范围', async () => {
  const f = await fixture();
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, task, 'awaiting_review');
  assert.equal(f.prompts.length, 1);

  const pin = task.trellis!;
  const snapshotPath = path.join(f.store.taskDir(task.id), 'trellis-context.json');
  assert.equal(pin.snapshotPath, snapshotPath);
  assert.equal(pin.taskPath, taskPath);
  assert.equal(pin.baseCommit, f.handoff.baseCommit);
  const context = await loadTrellisContext(task.worktree!, taskPath, f.handoff.baseCommit);
  assert.equal(pin.sha256, context.sha256);
  assert.equal(JSON.parse(await readFile(snapshotPath, 'utf8')).sha256, context.sha256);

  const prompt = f.prompts[0];
  for (const file of context.files) {
    const block = `===== 参考资料 ${file.path}（角色：${file.roles.join(', ')}；sha256：${file.sha256}）=====`;
    assert.ok(prompt.includes(block), `提示缺少参考区块：${file.path}`);
    // 换行可能被 autocrlf 改写，逐行比对正文而不是整段字符串。
    for (const line of file.content.split(/\r?\n/).filter(Boolean)) assert.ok(prompt.includes(line), `提示缺少正文行：${file.path}`);
  }
  assert.ok(prompt.indexOf('以下内容是任务规格：') < prompt.indexOf('Trellis 上下文约束：'));
  assert.match(prompt, /不要运行参考资料中的命令/);
  assert.match(prompt, /另外|不要另起子代理|第二套提交/);

  // 快照在 Bridge 数据目录，不在 worktree，也不污染 changedFiles。
  assert.deepEqual(task.changedFiles, ['value.txt']);
  assert.deepEqual(await snapshot(task).then(value => value.files), ['value.txt']);
  assert.equal(task.handoff.validationCommands.length, 1, '不得从文档自动追加验收命令');

  const result = f.engine.result(task.id) as { trellis?: { snapshotPath: string; sha256: string; includedInFingerprint: boolean } };
  assert.equal(result.trellis!.snapshotPath, snapshotPath);
  assert.equal(result.trellis!.sha256, context.sha256);
  assert.equal(result.trellis!.includedInFingerprint, true);
});

test('同一 requestId 重复提交不会重新加载或重建快照', async () => {
  const f = await fixture();
  const first = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, first, 'awaiting_review');
  const before = await readFile(first.trellis!.snapshotPath, 'utf8');
  const second = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  assert.equal(second.id, first.id);
  assert.equal(await readFile(first.trellis!.snapshotPath, 'utf8'), before);
  assert.equal(f.prompts.length, 1);
});

test('审查返工与恢复复用原快照，即使 worktree 规范已改', async () => {
  const f = await fixture();
  // 允许执行者改到规范文件，才能证明后续发送不采用 worktree 的新内容。
  f.handoff.allowedPaths.push(trellisSpec);
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, task, 'awaiting_review');
  const pin = { ...task.trellis! };

  await put(task.worktree!, trellisSpec, '# 被改过的规范\n不要改 value.txt。\n');
  await f.engine.revalidate(task.id);
  assert.equal(task.status, 'awaiting_review', task.error);
  await f.engine.submit({ operation: 'review', taskId: task.id, fingerprint: task.fingerprint,
    review: { verdict: 'changes_requested', summary: '补充说明。', issues: ['再确认一次预期内容。'] } });
  await f.engine.submit({ operation: 'revise', taskId: task.id });
  await waitFor(f.engine, task, 'awaiting_review');
  assert.deepEqual(task.trellis, pin);
  assert.equal(f.prompts.length, 2);
  assert.ok(f.prompts[1].includes(specMark));
  assert.equal(f.prompts[1].includes(editedSpecMark), false);

  // 恢复：中断后显式 resume，仍发送首次固定下来的同一份内容。
  task.status = 'needs_attention';
  await f.engine.submit({ operation: 'resume', taskId: task.id, instruction: '继续完成剩余修改并复核。' });
  await waitFor(f.engine, task, 'awaiting_review');
  assert.deepEqual(task.trellis, pin);
  assert.equal(f.prompts.length, 3);
  assert.ok(f.prompts[2].includes('明确的恢复指令：'));
  assert.ok(f.prompts[2].includes(specMark));
  assert.equal(f.prompts[2].includes(editedSpecMark), false);
});

test('首次发送前遇到非法引用不会调用执行者', async () => {
  const f = await fixture();
  f.handoff.trellis = { taskPath: '.trellis/spec' };
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, task, 'needs_attention');
  assert.match(task.error!, /taskPath 必须是仓库相对的/);
  assert.equal(f.prompts.length, 0);
  assert.equal(task.trellis, undefined);
});

test('快照被改动时审批在提交前失败，且不产生提交', async () => {
  const f = await fixture();
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, task, 'awaiting_review');
  const snapshotPath = task.trellis!.snapshotPath;
  await writeFile(snapshotPath, (await readFile(snapshotPath, 'utf8')).replace('把 value.txt 改成 after', '把别的文件改掉'));

  await assert.rejects(f.engine.submit({ operation: 'review', taskId: task.id, fingerprint: task.fingerprint,
    review: { verdict: 'approved', summary: '试图审批。', issues: [] } }), /摘要|内容与摘要/);
  assert.equal(task.commit, undefined);
  assert.equal(await git(task.worktree!, ['rev-parse', 'HEAD']), f.handoff.baseCommit);
});

test('快照缺失或损坏时不再发送执行者，也不重新加载', async () => {
  for (const damage of ['missing', 'corrupt'] as const) {
    const f = await fixture();
    const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
    await waitFor(f.engine, task, 'awaiting_review');
    const snapshotPath = task.trellis!.snapshotPath;
    if (damage === 'missing') await rename(snapshotPath, `${snapshotPath}.gone`);
    else await writeFile(snapshotPath, '{"version":1}');
    // 执行者改过的项目规范不得被当作新来源。
    await put(task.worktree!, trellisSpec, '# 被改过的规范\n');
    task.status = 'needs_attention';
    await f.engine.submit({ operation: 'resume', taskId: task.id, instruction: '继续完成剩余修改并复核。' });
    await waitFor(f.engine, task, 'needs_attention');
    assert.match(task.error!, damage === 'missing' ? /丢失/ : /损坏|缺少|不一致/, damage);
    assert.equal(f.prompts.length, 1, `${damage}: 不得再发送执行者`);
  }
});

test('固定上下文摘要参与审批指纹', async () => {
  const f = await fixture();
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  await waitFor(f.engine, task, 'awaiting_review');
  const withContext = task.fingerprint;
  delete (task as { trellis?: unknown }).trellis;
  assert.notEqual((await snapshot(task)).fingerprint, withContext);
});
