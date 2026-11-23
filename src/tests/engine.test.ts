import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Engine, redact, type Handoff, type Task } from '../engine.js';
import { Store } from '../store.js';
import { git } from '../git.js';
import type { DshClient, Send, NativeState } from '../dsh.js';

async function fixture(
  t: TestContext,
  modify: (params: Send, round: number, options?: { signal?: AbortSignal; timeoutMs?: number }) => Promise<void>,
  command: string | string[] = "if (-not (Test-Path 'value.txt')) { exit 1 }",
  onInspect?: (taskId: string, base: NativeState) => Promise<NativeState> | NativeState,
  options?: {
    onCancel?: (taskId: string, store: Store) => Promise<unknown> | unknown;
    store?: (dataDir: string) => Store;
    setupRepo?: (repo: string) => Promise<void>;
  },
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
  if (options?.setupRepo) await options.setupRepo(repo);
  const sent: Send[] = [];
  let cursor = 0;
  const dataDir = path.join(temporary, 'data');
  const store = options?.store ? options.store(dataDir) : new Store(dataDir);
  const client: DshClient = {
    async models() { return { home: temporary, default: { provider: 'test', model: 'test' }, groups: [], failures: [] }; },
    async send(params, sendOptions?: { signal?: AbortSignal; timeoutMs?: number }) {
      const beforeSeq = cursor;
      sent.push(params);
      await modify(params, sent.length, sendOptions);
      cursor += 2;
      return { sessionId: `session-codex-${params.taskId}`, beforeSeq };
    },
    async inspect(taskId): Promise<NativeState> {
      const base: NativeState = { sessionId: `session-codex-${taskId}`, status: 'idle', pending: 0, cursor, endSeq: cursor, reason: 'completed', summary: '假 DSH 已完成修改。', guidance: [] };
      return onInspect ? await onInspect(taskId, base) : base;
    },
    async cancel(taskId) { return options?.onCancel ? await options.onCancel(taskId, store) : { ok: true }; },
  };
  const engine = new Engine(store, client);
  const handoff: Handoff = {
    requestId: 'engine-test-request', title: '临时仓库交接', repoPath: repo, baseCommit: await git(repo, ['rev-parse', 'HEAD']), ready: true,
    goal: '在允许范围内完成文件修改并验收。', plan: '修改 value.txt，执行给定验收，保留变更等待 Codex 审查。', constraints: [],
    allowedPaths: ['value.txt'], validationCommands: Array.isArray(command) ? command : [command], acceptanceCriteria: ['允许范围内的变更通过验收。'],
    commitMessage: 'feat: update allowed value', model: '',
  };
  return { engine, handoff, sent, repo, store };
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

test('允许范围内的文件重命名可以通过审查并提交', async t => {
  const { engine, handoff } = await fixture(
    t,
    async params => { await rename(path.join(params.cwd, 'baseline.txt'), path.join(params.cwd, 'renamed.txt')); },
    "if (-not (Test-Path 'renamed.txt') -or (Test-Path 'baseline.txt')) { exit 1 }",
  );
  const task = await engine.submit({ operation: 'execute', handoff: { ...handoff, allowedPaths: ['baseline.txt', 'renamed.txt'] } });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: result.fingerprint, review: { verdict: 'approved', summary: '重命名符合方案。', issues: [] } });
  assert.equal(completed.status, 'completed', completed.error);
  assert.equal(completed.commit, await git(completed.worktree!, ['rev-parse', 'HEAD']));
  assert.equal(await git(completed.worktree!, ['status', '--short']), '');
  assert.equal(await git(completed.worktree!, ['ls-tree', '--name-only', 'HEAD']), 'renamed.txt');
});

test('redact 隐藏 Header、key=value、JSON 与 sk/ds 凭据且不泄露 token', () => {
  const header = redact('Authorization: Bearer abcdef123456TOKENVALUE');
  assert.equal(header, 'Authorization: [已隐藏凭据]');
  assert.equal(header.includes('TOKENVALUE'), false);

  assert.equal(redact('Authorization: Basic dXNlcjpwYXNz=='), 'Authorization: [已隐藏凭据]');
  assert.equal(redact('curl -H "Authorization: Bearer tok987654" https://example.com'), 'curl -H "Authorization: [已隐藏凭据]" https://example.com');
  assert.equal(redact('{"authorization":"Bearer abcdef123456TOKENVALUE"}'), '{"authorization":"[已隐藏凭据]"}');
  assert.equal(redact('{"api_key": "my-secret-key", "access_token": "tok_xyz"}'), '{"api_key": "[已隐藏凭据]", "access_token": "[已隐藏凭据]"}');
  assert.equal(redact('api_key=rawSecret123&access_token=rawTok456'), 'api_key=[已隐藏凭据]&access_token=[已隐藏凭据]');
  const escaped = redact(JSON.stringify({ msg: '{"authorization":"Bearer nestedSecret999"}' }));
  assert.equal(escaped.includes('nestedSecret999'), false);
  assert.equal(redact('key sk-1234567890abcdef1234 and ds_1234567890abcdef1234'), 'key [已隐藏凭据] and [已隐藏凭据]');
  assert.equal(redact('{"api_key": ""}'), '{"api_key": ""}');
});

test('验收命令重复修改工作区时拒绝发布并报错', async t => {
  const { engine, handoff } = await fixture(
    t,
    async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'init\n'); },
    "Add-Content -Path 'value.txt' -Value 'mutated'",
  );
  const task = await engine.submit({ operation: 'execute', handoff });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'needs_attention');
  assert.equal(result.fingerprint, undefined);
  assert.match(String(result.error), /验收命令/);
});

test('验收命令一次性修改工作区后重跑全套验收，不放行旧树上的误通过', async t => {
  const { engine, handoff, sent } = await fixture(
    t,
    async (params, round) => { await writeFile(path.join(params.cwd, 'value.txt'), round === 1 ? 'raw' : 'formatted'); },
    [
      "if ((Get-Content -Raw 'value.txt').Trim() -ne 'raw') { exit 1 }",
      "Set-Content -Path 'value.txt' -Value 'formatted' -NoNewline",
    ],
  );
  const task = await engine.submit({ operation: 'execute', handoff });
  const result = await engine.wait(task.id, 60_000);
  // 第一轮 cmd2 把 raw 改成了 formatted，重跑时 cmd1 在 formatted 上失败，不应直接进入 awaiting_review。
  assert.equal(result.status, 'needs_changes');
  assert.ok(sent.length >= 2);
});

test('cancel 时若 DSH 取消失败则标为 needs_attention 而非 cancelled', async t => {
  const { engine, handoff } = await fixture(
    t,
    async () => {},
    undefined,
    (_taskId, base) => ({ ...base, status: 'running', cursor: 1, endSeq: 0 }),
    { onCancel: async () => { throw new Error('pipe unavailable'); } },
  );
  const task = await engine.submit({ operation: 'execute', handoff });
  const cancelled = await engine.cancel(task.id);
  assert.equal(cancelled.status, 'needs_attention');
  assert.match(String(cancelled.error), /未能确认.*取消|DSH/);
});

test('drive 超时时调用 DSH cancel 并在 error 中记录停止是否已确认', async t => {
  const previous = process.env.BRIDGE_TIMEOUT_MINUTES;
  process.env.BRIDGE_TIMEOUT_MINUTES = '0.002';
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_TIMEOUT_MINUTES;
    else process.env.BRIDGE_TIMEOUT_MINUTES = previous;
  });

  const confirmedCalls: string[] = [];
  const okFixture = await fixture(
    t,
    async () => {},
    undefined,
    (_taskId, base) => ({ ...base, status: 'running', cursor: 1, endSeq: 0 }),
    { onCancel: async id => { confirmedCalls.push(id); return { ok: true }; } },
  );
  const task1 = await okFixture.engine.submit({ operation: 'execute', handoff: okFixture.handoff });
  const res1 = await okFixture.engine.wait(task1.id, 60_000);
  assert.equal(res1.status, 'needs_attention');
  assert.deepEqual(confirmedCalls, [task1.id]);
  assert.match(String(res1.error), /超时|总运行时限/);
  assert.match(String(res1.error), /已确认.*停止/);

  const failedCalls: string[] = [];
  const failFixture = await fixture(
    t,
    async () => {},
    undefined,
    (_taskId, base) => ({ ...base, status: 'running', cursor: 1, endSeq: 0 }),
    { onCancel: async id => { failedCalls.push(id); throw new Error('cancel timeout'); } },
  );
  const task2 = await failFixture.engine.submit({ operation: 'execute', handoff: { ...failFixture.handoff, requestId: 'engine-timeout-cancel-fail' } });
  const res2 = await failFixture.engine.wait(task2.id, 60_000);
  assert.equal(res2.status, 'needs_attention');
  assert.deepEqual(failedCalls, [task2.id]);
  assert.match(String(res2.error), /超时|总运行时限/);
  assert.match(String(res2.error), /未能确认.*停止/);
});

test('审查通过提交后先持久化 completed 与未确认 pushError，再执行 push 并持久化结果', async t => {
  const saves: Task[] = [];
  class RecordingStore extends Store {
    override async save(task: Task): Promise<void> {
      saves.push(structuredClone(task));
      await super.save(task);
    }
  }
  const { engine, handoff, repo } = await fixture(
    t,
    async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); },
    undefined,
    undefined,
    { store: dataDir => new RecordingStore(dataDir) },
  );
  await bareRemote(repo);
  const orphan = await git(repo, ['commit-tree', 'HEAD^{tree}', '-m', 'test: unrelated history']);
  await git(repo, ['push', 'origin', `${orphan}:refs/heads/main`]);
  const task = await engine.submit({ operation: 'execute', handoff: { ...handoff, push: { remote: 'origin', branch: 'main' } } });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  saves.length = 0;
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: result.fingerprint, review: { verdict: 'approved', summary: '代码与验收符合方案。', issues: [] } });
  assert.equal(completed.status, 'completed');
  const completedSaves = saves.filter(item => item.status === 'completed');
  assert.ok(completedSaves.length >= 2, `期望在 push 前后各保存一次 completed，实际保存次数：${completedSaves.length}`);
  assert.equal(completedSaves[0].commit, completed.commit);
  assert.equal(completedSaves[0].pushed, undefined);
  assert.match(String(completedSaves[0].pushError), /未确认/);
  assert.equal((engine.result(completedSaves[0]).nextAction as { type: string }).type, 'attention');
  assert.match(String(completedSaves.at(-1)?.pushError), /推送失败/);

  // 成功推送路径：推送前也先写入未确认 pushError，推送成功后清除并给出 done。
  saves.length = 0;
  const okFixture = await fixture(
    t,
    async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'ok\n'); },
    undefined,
    undefined,
    { store: dataDir => new RecordingStore(dataDir) },
  );
  await bareRemote(okFixture.repo);
  const task2 = await okFixture.engine.submit({ operation: 'execute', handoff: { ...okFixture.handoff, requestId: 'engine-push-ok-order', push: { remote: 'origin', branch: 'feature/ok' } } });
  const res2 = await okFixture.engine.wait(task2.id, 60_000);
  saves.length = 0;
  const done2 = await okFixture.engine.submit({ operation: 'review', taskId: task2.id, fingerprint: res2.fingerprint, review: { verdict: 'approved', summary: '通过。', issues: [] } });
  const okSaves = saves.filter(item => item.status === 'completed');
  assert.ok(okSaves.length >= 2);
  assert.match(String(okSaves[0].pushError), /未确认/);
  assert.equal((okFixture.engine.result(okSaves[0]).nextAction as { type: string }).type, 'attention');
  assert.equal(done2.pushError, undefined);
  assert.ok(done2.pushed);
  assert.deepEqual(okFixture.engine.result(done2).nextAction, { type: 'done' });
});

test('awaiting_review 后手动修改工作区文件，wait_task 自动重新验收并更新指纹', async t => {
  const { engine, handoff } = await fixture(t, async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'first\n'); });
  const task = await engine.submit({ operation: 'execute', handoff });
  const first = await engine.wait(task.id, 60_000);
  assert.equal(first.status, 'awaiting_review');

  await writeFile(path.join(task.worktree!, 'value.txt'), 'manual edit\n');
  await assert.rejects(engine.submit({ operation: 'review', taskId: task.id, fingerprint: first.fingerprint, review: { verdict: 'approved', summary: '旧指纹应被拒绝。', issues: [] } }), /指纹不符/);

  const refreshed = await engine.wait(task.id, 60_000);
  assert.equal(refreshed.status, 'awaiting_review');
  assert.notEqual(refreshed.fingerprint, first.fingerprint);
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: refreshed.fingerprint, review: { verdict: 'approved', summary: '新指纹通过。', issues: [] } });
  assert.equal(completed.status, 'completed');
  assert.equal(await readFile(path.join(completed.worktree!, 'value.txt'), 'utf8'), 'manual edit\n');
});

test('同时修改已跟踪文件和新增未跟踪文件时 changes.diff 每个 diff --git 都在行首', async t => {
  const { engine, handoff } = await fixture(t, async params => {
    await writeFile(path.join(params.cwd, 'baseline.txt'), 'baseline\nmodified\n');
    await writeFile(path.join(params.cwd, 'value.txt'), 'brand new\n');
  });
  const task = await engine.submit({ operation: 'execute', handoff: { ...handoff, allowedPaths: ['baseline.txt', 'value.txt'] } });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  const diff = await readFile(String(result.diffPath), 'utf8');
  const allHeaders = diff.match(/diff --git /g) ?? [];
  const lineStartHeaders = diff.match(/(?:^|\n)diff --git /g) ?? [];
  assert.equal(allHeaders.length, 2, diff);
  assert.equal(lineStartHeaders.length, 2, diff);
});

test('redact 支持前缀变量名、跨行分隔、未闭合引号及多参数 Authorization 方案', () => {
  assert.equal(redact('OPENAI_API_KEY=abc123secret'), 'OPENAI_API_KEY=[已隐藏凭据]');
  assert.equal(redact('GITHUB_ACCESS_TOKEN=ghp_x'), 'GITHUB_ACCESS_TOKEN=[已隐藏凭据]');
  assert.equal(redact('$env:DEEPSEEK_API_KEY = "v"'), '$env:DEEPSEEK_API_KEY = "[已隐藏凭据]"');
  assert.equal(redact('ProxyAuthorization: v'), 'ProxyAuthorization: [已隐藏凭据]');
  assert.equal(redact('"api_key":\n  "secret"'), '"api_key":\n  "[已隐藏凭据]"');
  assert.equal(redact('Authorization:\n  Bearer secret'), 'Authorization:\n  [已隐藏凭据]');
  assert.equal(redact('api_key="secret'), 'api_key="[已隐藏凭据]');
  assert.equal(redact("api_key='secret\nnext=ok"), "api_key='[已隐藏凭据]\nnext=ok");
  const digest = redact('Authorization: Digest username="Mufasa", realm="test", response="6629fae4"');
  assert.equal(digest, 'Authorization: [已隐藏凭据]');
  assert.equal(digest.includes('6629fae4'), false);
  const aws = redact('Authorization: AWS4-HMAC-SHA256 Credential=AKIA/2025/s3, SignedHeaders=host;x-amz-date, Signature=deadbeef');
  assert.equal(aws, 'Authorization: [已隐藏凭据]');
  assert.equal(aws.includes('deadbeef'), false);
  assert.equal(
    redact(`curl -H 'Authorization: Digest username="Mufasa", response="6629"' https://example.com`),
    `curl -H 'Authorization: [已隐藏凭据]' https://example.com`,
  );
});

test('自动返工 send 传递任务 AbortSignal 和剩余超时上限，cancel 立即中止在途 send', async t => {
  const previous = process.env.BRIDGE_TIMEOUT_MINUTES;
  process.env.BRIDGE_TIMEOUT_MINUTES = '0.5';
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_TIMEOUT_MINUTES;
    else process.env.BRIDGE_TIMEOUT_MINUTES = previous;
  });

  let enteredSecondSend = () => {};
  const secondSendEntered = new Promise<void>(resolve => { enteredSecondSend = resolve; });
  let releaseSecondSend = () => {};
  const secondSendBlocked = new Promise<void>(resolve => { releaseSecondSend = resolve; });
  let secondSignal: AbortSignal | undefined;
  let secondTimeoutMs: number | undefined;

  const { engine, handoff } = await fixture(
    t,
    async (params, round, sendOptions) => {
      if (round === 1) {
        await writeFile(path.join(params.cwd, 'value.txt'), 'wrong');
        return;
      }
      secondSignal = sendOptions?.signal;
      secondTimeoutMs = sendOptions?.timeoutMs;
      enteredSecondSend();
      await secondSendBlocked;
    },
    "if ((Get-Content -Raw 'value.txt') -ne 'fixed') { exit 1 }",
  );

  const task = await engine.submit({ operation: 'execute', handoff });
  await secondSendEntered;
  assert.ok(secondSignal, '自动返工 send 应收到任务 AbortSignal');
  assert.equal(secondSignal.aborted, false);
  assert.ok(typeof secondTimeoutMs === 'number' && secondTimeoutMs > 0 && secondTimeoutMs <= 30_000, `send timeoutMs 应受剩余时限约束，实际：${secondTimeoutMs}`);

  const cancelled = await engine.cancel(task.id);
  assert.equal(cancelled.status, 'cancelled');
  assert.equal(secondSignal.aborted, true);
  releaseSecondSend();
});

test('仓库配置失效 textconv 时仍可正常通过审查并提交', async t => {
  const { engine, handoff } = await fixture(
    t,
    async params => { await writeFile(path.join(params.cwd, 'value.txt'), 'done\n'); },
    undefined,
    undefined,
    {
      async setupRepo(repo) {
        await writeFile(path.join(repo, '.gitattributes'), '*.txt diff=broken\n');
        await git(repo, ['add', '--', '.gitattributes']);
        await git(repo, ['commit', '-m', 'test: add textconv gitattributes']);
        await git(repo, ['config', 'diff.broken.textconv', 'false']);
      },
    },
  );
  const task = await engine.submit({ operation: 'execute', handoff });
  const result = await engine.wait(task.id, 60_000);
  assert.equal(result.status, 'awaiting_review');
  const completed = await engine.submit({ operation: 'review', taskId: task.id, fingerprint: result.fingerprint, review: { verdict: 'approved', summary: '通过。', issues: [] } });
  assert.equal(completed.status, 'completed', completed.error);
});

test('drive 超时先落盘 needs_attention 再取消 DSH，且不覆盖期间的外部状态变更', async t => {
  const previous = process.env.BRIDGE_TIMEOUT_MINUTES;
  process.env.BRIDGE_TIMEOUT_MINUTES = '0.002';
  t.after(() => {
    if (previous === undefined) delete process.env.BRIDGE_TIMEOUT_MINUTES;
    else process.env.BRIDGE_TIMEOUT_MINUTES = previous;
  });

  let statusDuringCancel: Task['status'] | undefined;
  const f1 = await fixture(
    t,
    async () => {},
    undefined,
    (_taskId, base) => ({ ...base, status: 'running', cursor: 1, endSeq: 0 }),
    {
      async onCancel(id, store) {
        statusDuringCancel = (await store.load(id))?.status;
        return { ok: true };
      },
    },
  );
  const task1 = await f1.engine.submit({ operation: 'execute', handoff: { ...f1.handoff, requestId: 'engine-timeout-persist-first' } });
  const res1 = await f1.engine.wait(task1.id, 60_000);
  assert.equal(statusDuringCancel, 'needs_attention');
  assert.equal(res1.status, 'needs_attention');
  assert.match(String(res1.error), /已确认.*停止/);

  const f2 = await fixture(
    t,
    async () => {},
    undefined,
    (_taskId, base) => ({ ...base, status: 'running', cursor: 1, endSeq: 0 }),
    {
      async onCancel(id, store) {
        const current = await store.load(id);
        assert.equal(current?.status, 'needs_attention');
        // 模拟取消期间外部修改了任务状态，drive 结束后不应覆盖。
        await store.save({ ...current!, status: 'needs_changes', error: '外部已接管' });
        return { ok: true };
      },
    },
  );
  const task2 = await f2.engine.submit({ operation: 'execute', handoff: { ...f2.handoff, requestId: 'engine-timeout-no-clobber' } });
  await f2.engine.wait(task2.id, 60_000);
  const final2 = await f2.store.load(task2.id);
  assert.equal(final2?.status, 'needs_changes');
  assert.equal(final2?.error, '外部已接管');
});
