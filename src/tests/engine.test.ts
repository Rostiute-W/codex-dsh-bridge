import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, type Handoff } from '../engine.js';
import { Store } from '../store.js';
import { git } from '../git.js';
import type { DshClient, Send, NativeState } from '../dsh.js';

async function fixture(
  t: TestContext,
  modify: (params: Send, round: number) => Promise<void>,
  command = "if (-not (Test-Path 'value.txt')) { exit 1 }",
  onInspect?: (taskId: string, base: NativeState) => Promise<NativeState> | NativeState,
) {
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
      const base: NativeState = { sessionId: `session-codex-${taskId}`, status: 'idle', pending: 0, cursor, endSeq: cursor, reason: 'completed', summary: '假 DSH 已完成修改。', guidance: [] };
      return onInspect ? await onInspect(taskId, base) : base;
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

test('blocked 时立即以 reason blocked 返回，完成后再 wait 到 awaiting_review', async t => {
  let stage: 'blocked' | 'done' = 'blocked';
  let worktree = '';
  const { engine, handoff } = await fixture(
    t,
    async params => { worktree = params.cwd; },
    undefined,
    (_taskId, base) => {
      if (stage === 'blocked') {
        return {
          ...base,
          status: 'running',
          cursor: 1,
          endSeq: 0,
          blocked: { kind: 'approval', seq: 1, text: 'pwsh: escalate sandbox' },
        };
      }
      return { ...base, cursor: 3, endSeq: 3 };
    },
  );
  const task = await engine.submit({ operation: 'execute', handoff });
  const blockedResult = await engine.wait(task.id, 60_000);
  assert.equal(blockedResult.status, 'running');
  assert.equal((blockedResult.wait as { reason: string }).reason, 'blocked');
  assert.equal((blockedResult.blocked as { kind: string; seq: number }).kind, 'approval');
  assert.match(String((blockedResult.nextAction as { notice?: string }).notice), /权限审批.*pwsh: escalate sandbox/);

  await writeFile(path.join(worktree, 'value.txt'), 'done\n');
  stage = 'done';
  const readyResult = await engine.wait(task.id, 60_000);
  assert.equal(readyResult.status, 'awaiting_review');
  assert.equal((readyResult.wait as { reason: string }).reason, 'ready');
  assert.equal(readyResult.blocked, undefined);
});

test('cursor 长时间不变且无 blocked 时以 reason stalled 返回', async t => {
  const previous = process.env.BRIDGE_STALL_MINUTES;
  process.env.BRIDGE_STALL_MINUTES = '0.002';
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_STALL_MINUTES;
    else process.env.BRIDGE_STALL_MINUTES = previous;
  });
  const { engine, handoff } = await fixture(
    t,
    async () => {},
    undefined,
    (_taskId, base) => ({ ...base, status: 'running', cursor: 1, endSeq: 0 }),
  );
  const task = await engine.submit({ operation: 'execute', handoff });
  const stalledResult = await engine.wait(task.id, 60_000);
  assert.equal(stalledResult.status, 'running');
  assert.equal((stalledResult.wait as { reason: string }).reason, 'stalled');
  assert.equal(typeof stalledResult.stalledSince, 'string');
  assert.match(String((stalledResult.nextAction as { notice?: string }).notice), /没有新进展/);
  await engine.cancel(task.id);
});

async function bareRemote(repo: string): Promise<string> {
  const remote = path.join(path.dirname(repo), 'remote.git');
  await git(path.dirname(repo), ['init', '--bare', remote]);
  await git(repo, ['remote', 'add', 'origin', remote]);
  return remote;
}

test('审查通过后由 Bridge 推送到 handoff.push 指定分支', async t => {
  const { engine, handoff, repo } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); });
  const remote = await bareRemote(repo);
  const task = await engine.submit({ operation: 'execute', handoff: { ...handoff, push: { remote: 'origin', branch: 'feature/done' } } });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: result.fingerprint, review: { verdict: 'approved', summary: '代码与验收符合方案。', issues: [] } });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.pushError, undefined);
  assert.equal(completed.pushed?.remoteCommit, completed.commit);
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/feature/done']), completed.commit);
  assert.deepEqual(engine.result(completed).nextAction, { type: 'done' });
  assert.equal(await git(repo, ['rev-parse', 'HEAD']), handoff.baseCommit);
});

test('审查后推送被拒绝时保留本地提交并要求处理', async t => {
  const { engine, handoff, repo } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); });
  const remote = await bareRemote(repo);
  const orphan = await git(repo, ['commit-tree', 'HEAD^{tree}', '-m', 'test: unrelated history']);
  await git(repo, ['push', 'origin', `${orphan}:refs/heads/main`]);
  const task = await engine.submit({ operation: 'execute', handoff: { ...handoff, push: { remote: 'origin', branch: 'main' } } });
  const result = await engine.wait(task.id, 60_000);
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: result.fingerprint, review: { verdict: 'approved', summary: '代码与验收符合方案。', issues: [] } });
  assert.equal(completed.status, 'completed');
  assert.ok(completed.commit);
  assert.match(String(completed.pushError), /推送失败/);
  assert.equal((engine.result(completed).nextAction as { type: string }).type, 'attention');
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), orphan);
});

test('push 操作不经过 DSH 推送已有提交，且不强制覆盖分叉历史', async t => {
  const { engine, handoff, sent, repo } = await fixture(t, async () => {});
  const remote = await bareRemote(repo);
  const pushed = await engine.push({ operation: 'push', repoPath: repo, commit: handoff.baseCommit, push: { remote: 'origin', branch: 'main' } });
  assert.equal(pushed.remoteCommit, handoff.baseCommit);
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), handoff.baseCommit);
  assert.equal(sent.length, 0);
  const orphan = await git(repo, ['commit-tree', 'HEAD^{tree}', '-m', 'test: unrelated history']);
  await assert.rejects(engine.push({ operation: 'push', repoPath: repo, commit: orphan, push: { remote: 'origin', branch: 'main' } }), /推送失败/);
  assert.equal(await git(remote, ['rev-parse', 'refs/heads/main']), handoff.baseCommit);
});

test('推送目标拒绝凭据地址、非 https 地址、未知 remote 和非法分支', async t => {
  const { engine, handoff, sent, repo } = await fixture(t, async () => {});
  await bareRemote(repo);
  const attempt = (remote: string, branch = 'main') => engine.push({ operation: 'push', repoPath: repo, commit: handoff.baseCommit, push: { remote, branch } });
  await assert.rejects(attempt('https://user:secret@example.invalid/a/b.git'), /不能包含用户名或凭据/);
  await assert.rejects(attempt('http://example.invalid/a/b.git'), /只支持 https/);
  await assert.rejects(attempt('git@example.invalid:a/b.git'), /只支持 https/);
  await assert.rejects(attempt('upstream'), /没有名为 upstream/);
  for (const branch of ['-f', '+main', 'a..b', 'main:other', 'x.lock']) await assert.rejects(attempt('origin', branch), /无效的推送分支/);
  await assert.rejects(engine.submit({ operation: 'execute', handoff: { ...handoff, push: { remote: 'upstream', branch: 'main' } } }), /没有名为 upstream/);
  assert.equal(sent.length, 0);
});
