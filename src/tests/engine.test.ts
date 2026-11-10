import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, type Handoff } from '../engine.js';
import { Store } from '../store.js';
import { git } from '../git.js';
import type { DshClient, Send, NativeState } from '../dsh.js';

async function fixture(t: TestContext, modify: (params: Send, round: number) => Promise<void>, command = "if (-not (Test-Path 'value.txt')) { exit 1 }") {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-engine-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const repo = path.join(temporary, 'repo');
  await mkdir(repo);
  await git(repo, ['init']);
  await git(repo, ['config', 'user.name', 'Bridge Test']);
  await git(repo, ['config', 'user.email', 'bridge-test@example.invalid']);
  await git(repo, ['config', 'core.autocrlf', 'false']);
  await writeFile(path.join(repo, 'baseline.txt'), 'baseline\n');
  await git(repo, ['add', '--', 'baseline.txt']);
  await git(repo, ['commit', '-m', 'test: create baseline']);
  const sent: Send[] = [];
  let cursor = 0;
  const client: DshClient = {
    async models() { return { home: temporary, default: { provider: 'test', model: 'test' }, groups: [], failures: [] }; },
    async send(params) {
      const beforeSeq = cursor;
      sent.push(params);
      await modify(params, sent.length);
      cursor += 2;
      return { sessionId: `session-codex-${params.taskId}`, beforeSeq };
    },
    async inspect(taskId): Promise<NativeState> {
      return { sessionId: `session-codex-${taskId}`, status: 'idle', pending: 0, cursor, endSeq: cursor, reason: 'completed', summary: '假 DSH 已完成修改。', guidance: [] };
    },
    async cancel() { return { ok: true }; },
  };
  const engine = new Engine(new Store(path.join(temporary, 'data')), client);
  const handoff: Handoff = {
    requestId: 'engine-test-request', title: '临时仓库交接', repoPath: repo, baseCommit: await git(repo, ['rev-parse', 'HEAD']), ready: true,
    goal: '在允许范围内完成文件修改并验收。', plan: '修改 value.txt，执行给定验收，保留变更等待 Codex 审查。', constraints: [],
    allowedPaths: ['value.txt'], validationCommands: [command], acceptanceCriteria: ['允许范围内的变更通过验收。'],
    commitMessage: 'feat: update allowed value', model: '',
  };
  return { engine, handoff, sent, repo };
}

test('execute、验收和批准后仅提交允许的文件', async t => {
  const { engine, handoff, repo } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); });
  const task = await engine.submit({ operation: 'execute', handoff });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: result.fingerprint, review: { verdict: 'approved', summary: '代码与验收符合方案。', issues: [] } });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.commit, await git(completed.worktree!, ['rev-parse', 'HEAD']));
  assert.equal(await git(completed.worktree!, ['show', '--format=', '--name-only', 'HEAD']), 'value.txt');
  assert.equal(await git(completed.worktree!, ['status', '--short']), '');
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), handoff.baseCommit);
  assert.equal(await git(repo, ['status', '--short']), '');
});

test('验收失败发送自动返工提示，第二轮通过', async t => {
  const { engine, handoff, sent } = await fixture(t, async (params, round) => {
    await writeFile(path.join(params.cwd, 'value.txt'), round === 1 ? 'wrong' : 'fixed');
  }, "if ((Get-Content -Raw 'value.txt') -ne 'fixed') { exit 1 }");
  const task = await engine.submit({ operation: 'execute', handoff });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  assert.equal(result.round, 1);
  assert.equal(sent.length, 2);
  assert.match(sent[1].prompt, /真实验收失败/);
  assert.match(sent[1].prompt, /exitCode.*1/);
  assert.ok((await engine.task(task.id)).checks.every(check => check.exitCode === 0));
});

test('改动超出 allowedPaths 不进入 awaiting_review', async t => {
  const { engine, handoff } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'outside.txt'), 'outside\n'); });
  const task = await engine.submit({ operation: 'execute', handoff });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'needs_attention');
  assert.match(String(result.error), /超出方案范围/);
});

test('拒绝指纹不符的 review', async t => {
  const { engine, handoff } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); });
  const task = await engine.submit({ operation: 'execute', handoff });
  assert.equal((await engine.wait(task.id, 60_000)).status, 'awaiting_review');
  await assert.rejects(engine.submit({ operation: 'review', taskId: task.id, fingerprint: '0'.repeat(64), review: { verdict: 'approved', summary: '错误指纹。', issues: [] } }), /指纹不符/);
  assert.equal((await engine.task(task.id)).status, 'awaiting_review');
  assert.equal(await git(task.worktree!, ['rev-parse', 'HEAD']), handoff.baseCommit);
});

test('同 requestId 同内容幂等，不同内容报错', async t => {
  const { engine, handoff, sent } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); });
  const task = await engine.submit({ operation: 'execute', handoff });
  const duplicate = await engine.submit({ operation: 'execute', handoff: { ...handoff } });
  assert.equal(duplicate.id, task.id);
  assert.equal(duplicate.worktree, task.worktree);
  assert.equal((await engine.wait(task.id, 60_000)).status, 'awaiting_review');
  await assert.rejects(engine.submit({ operation: 'execute', handoff: { ...handoff, title: '不同内容' } }), /requestId 已用于不同/);
  assert.equal(sent.length, 1);
});
