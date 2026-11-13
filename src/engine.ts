import { createHash } from 'node:crypto';
import { writeFile, access } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { z } from 'zod';
import { Store } from './store.js';
import { dsh, parseModel, validateModel, type DshClient, type NativeState } from './dsh.js';
import { prepareWorktree, snapshot, assertScope, finishCommit } from './git.js';
import { cleanEnvironment, runProcess } from './process.js';

export const handoffSchema = z.object({
  requestId: z.string().min(8).max(160), title: z.string().min(1).max(160),
  repoPath: z.string().min(1).max(2000), baseCommit: z.string().regex(/^[a-f0-9]{40,64}$/i), ready: z.literal(true),
  goal: z.string().min(10).max(16000), plan: z.string().min(20).max(64000),
  constraints: z.array(z.string().max(4000)).max(40),
  allowedPaths: z.array(z.string().min(1).max(1000)).min(1).max(80),
  validationCommands: z.array(z.string().min(1).max(4000)).min(1).max(20),
  acceptanceCriteria: z.array(z.string().min(1).max(4000)).min(1).max(40),
  commitMessage: z.string().min(8).max(180), model: z.string().max(800).optional(),
}).strict();
export const reviewSchema = z.object({
  verdict: z.enum(['approved', 'changes_requested']), summary: z.string().min(1).max(16000),
  issues: z.array(z.string().min(1).max(8000)).max(50),
}).strict();
const submitSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('execute'), handoff: handoffSchema }).strict(),
  z.object({ operation: z.literal('review'), taskId: z.string().uuid(), fingerprint: z.string().regex(/^[a-f0-9]{64}$/i), review: reviewSchema }).strict(),
  z.object({ operation: z.literal('resume'), taskId: z.string().uuid(), instruction: z.string().min(1).max(16000) }).strict(),
]);
export type Handoff = z.infer<typeof handoffSchema>;
export type Review = z.infer<typeof reviewSchema>;
export type Status = 'running' | 'validating' | 'awaiting_review' | 'needs_changes' | 'needs_attention' | 'completed' | 'cancelled';
export interface Task {
  id: string; handoff: Handoff; status: Status; deadline: number;
  worktree?: string; branch?: string; sessionId?: string; beforeSeq: number; cursor?: number;
  round: number; summary: string; guidance: { seq: number; text: string }[];
  blocked?: { kind: 'approval' | 'question'; seq: number; text: string; since: string };
  stalledSince?: string;
  checks: { command: string; exitCode: number; output: string; at: string }[];
  changedFiles: string[]; fingerprint?: string; diffPath?: string;
  review?: Review; reviewedFingerprint?: string; commit?: string; error?: string; model?: string;
}
export function redact(text: string): string {
  return text.replace(/\b(?:sk|ds)[-_][a-zA-Z0-9_-]{16,}\b/g, '[已隐藏凭据]')
    .replace(/((?:api[_-]?key|access[_-]?token|authorization)\s*[:=]\s*)([^\s,;]+)/gi, '$1[已隐藏凭据]');
}
export function safeError(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error)).slice(0, 4000);
}
const running = (task: Task) => task.status === 'running' || task.status === 'validating';

export class Engine {
  private readonly drivers = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private readonly reported = new Map<string, string>();
  private readonly timeoutMs: number;
  private readonly stallMs: number;
  constructor(readonly store = new Store(), private readonly client: DshClient = dsh) {
    const minutes = Number(process.env.BRIDGE_TIMEOUT_MINUTES ?? 300);
    if (!Number.isFinite(minutes) || minutes <= 0) throw new Error('BRIDGE_TIMEOUT_MINUTES 必须为正数。');
    this.timeoutMs = minutes * 60_000;
    const stallMinutes = Number(process.env.BRIDGE_STALL_MINUTES ?? 10);
    if (!Number.isFinite(stallMinutes) || stallMinutes <= 0) throw new Error('BRIDGE_STALL_MINUTES 必须为正数。');
    this.stallMs = stallMinutes * 60_000;
  }

  async task(id: string): Promise<Task> {
    const task = await this.store.load(id);
    if (!task) throw new Error('找不到任务。');
    return task;
  }

  async submit(value: unknown): Promise<Task> {
    const request = submitSchema.parse(value);
    if (redact(JSON.stringify(request)) !== JSON.stringify(request)) throw new Error('交接或审查内容可能包含凭据，请移除后提交。');
    if (request.operation === 'execute') return this.create(request.handoff);
    const release = await this.store.lock(request.taskId);
    if (!release) throw new Error('任务正在由其他操作驱动，请稍后重试。');
    let task: Task | undefined;
    let restart = false;
    try {
      task = await this.task(request.taskId);
      if (request.operation === 'review') {
        if (task.status !== 'awaiting_review') throw new Error('任务不在等待审查状态。');
        if (request.fingerprint !== task.fingerprint) throw new Error('审查指纹不符，请审查当前版本。');
        if (request.review.verdict === 'approved' && request.review.issues.length) throw new Error('通过审查不能包含待修复问题。');
        if (request.review.verdict === 'changes_requested' && !request.review.issues.length) throw new Error('要求修改时必须提供具体问题。');
        await this.idle(task);
        const current = await snapshot(task);
        assertScope(task, current.files);
        if (current.fingerprint !== request.fingerprint) throw new Error('当前快照指纹不符，请重新等待验收和审查。');
        if (task.checks.length !== task.handoff.validationCommands.length || task.checks.some(check => check.exitCode !== 0)) throw new Error('验收尚未全部通过。');
        if (request.review.verdict === 'changes_requested') {
          if (task.round >= 2) throw new Error('已达到两轮自动与审查返工上限。');
          task.review = request.review;
          task.round++;
          await this.send(task, '按以下审查意见修复，保持原方案与 allowedPaths，不暂存、不提交：\n' + JSON.stringify(request.review));
          restart = true;
        } else {
          task.review = request.review;
          task.reviewedFingerprint = request.fingerprint;
          try {
            await finishCommit(task);
            task.status = 'completed';
            delete task.error;
          } catch (error) { task.status = 'needs_attention'; task.error = safeError(error); }
        }
      } else {
        if (!['needs_attention', 'needs_changes', 'cancelled'].includes(task.status)) throw new Error('只有待处理、待修改或已取消的任务可以恢复。');
        if (!task.worktree) await prepareWorktree(task, this.store.taskDir(task.id));
        else await snapshot(task);
        task.deadline = Date.now() + this.timeoutMs;
        delete task.review;
        await this.send(task, this.initialPrompt(task) + '\n明确恢复指令：\n' + request.instruction);
        restart = true;
      }
      await this.store.save(task);
      return task;
    } catch (error) {
      // 校验拒绝保持原状态；发送失败则保留现场并停止驱动。
      if (task && running(task)) {
        task.status = 'needs_attention'; task.error = safeError(error); await this.store.save(task);
      }
      throw error;
    } finally {
      await release();
      if (restart && task) await this.start(task.id);
    }
  }

  private async create(handoff: Handoff): Promise<Task> {
    const digest = createHash('sha256').update(handoff.requestId).digest('hex');
    const id = `${digest.slice(0, 8)}-${digest.slice(8, 12)}-4${digest.slice(13, 16)}-a${digest.slice(17, 20)}-${digest.slice(20, 32)}`;
    const existing = await this.store.load(id);
    if (existing) return this.duplicate(existing, handoff);
    const release = await this.store.lock(id);
    if (!release) {
      const concurrent = await this.store.load(id);
      if (concurrent) return this.duplicate(concurrent, handoff);
      throw new Error('同一 requestId 正在创建，请重试原交接。');
    }
    let task: Task | undefined;
    try {
      const concurrent = await this.store.load(id);
      if (concurrent) return this.duplicate(concurrent, handoff);
      task = {
        id, handoff, status: 'running', deadline: Date.now() + this.timeoutMs, beforeSeq: -1,
        round: 0, summary: '', guidance: [], checks: [], changedFiles: [], model: handoff.model ?? process.env.DSH_MODEL,
      };
      const selected = parseModel(task.model ?? '');
      if (selected) validateModel(selected, await this.client.models());
      await prepareWorktree(task, this.store.taskDir(id));
      await this.store.save(task);
      await this.send(task, this.initialPrompt(task));
      return task;
    } catch (error) {
      if (task) { task.status = 'needs_attention'; task.error = safeError(error); await this.store.save(task); }
      throw error;
    } finally {
      await release();
      if (task && running(task)) await this.start(id);
    }
  }

  private duplicate(task: Task, handoff: Handoff): Task {
    if (JSON.stringify(task.handoff) !== JSON.stringify(handoff)) throw new Error('requestId 已用于不同的交接内容。');
    return task;
  }

  private initialPrompt(task: Task): string {
    return [
      '你是 Codex 委派的执行者。完成交接方案，读取并遵循工作目录内适用的 AGENTS.md。只编写代码、运行检查和修复；Codex 审查，Bridge 最终提交。',
      '不要 git add、git commit、切换分支、改写历史、push、部署或修改原始项目目录。当前目录是独立 worktree。不要启动子 agent；遇到方案矛盾或必须改变架构时停止并报告。',
      '凭据使用已有 DSH 配置，不能输出凭据。不要访问任务不需要的个人文件。保持变更在 allowedPaths 范围内。',
      JSON.stringify(task.handoff, null, 2), '结束前说明实际修改、验证结果和未解决问题。不要把未通过检查的任务称为完成。',
    ].join('\n');
  }

  private async send(task: Task, prompt: string, persist = () => this.store.save(task)): Promise<void> {
    const model = parseModel(task.model ?? '');
    if (model) validateModel(model, await this.client.models());
    // 先持久化运行状态，响应丢失时接管者只观察原会话，不自动重发提示词。
    task.status = 'running';
    delete task.error; delete task.fingerprint; delete task.reviewedFingerprint;
    delete task.blocked; delete task.stalledSince;
    task.checks = [];
    await persist();
    const requestId = task.id + '-' + createHash('sha256').update(`${task.round}\n${prompt}`).digest('hex');
    const started = await this.client.send({ taskId: task.id, cwd: task.worktree!, title: task.handoff.title, prompt, requestId, model });
    task.sessionId = started.sessionId; task.beforeSeq = started.beforeSeq;
    await persist();
  }

  private observe(task: Task, state: NativeState): void {
    task.summary = redact(state.summary);
    task.guidance = state.guidance.map(item => ({ seq: item.seq, text: redact(item.text) }));
    if (state.blocked) {
      const same = task.blocked?.kind === state.blocked.kind && task.blocked?.seq === state.blocked.seq;
      task.blocked = {
        kind: state.blocked.kind,
        seq: state.blocked.seq,
        text: redact(state.blocked.text),
        since: same ? task.blocked!.since : new Date().toISOString(),
      };
    } else {
      delete task.blocked;
    }
  }

  private async idle(task: Task): Promise<NativeState> {
    const state = await this.client.inspect(task.id);
    this.observe(task, state);
    if (state.status !== 'idle' || state.pending) throw new Error('DSH 会话仍在运行或有排队消息，请继续 wait_task。');
    if (state.cursor !== task.cursor) throw new Error('DSH 对话已继续，旧审查失效，请继续 wait_task 重新验收。');
    return state;
  }

  private async start(id: string): Promise<void> {
    if (this.drivers.has(id)) return;
    const release = await this.store.lock(id);
    if (!release) return;
    let handedOff = false;
    try {
      const task = await this.task(id);
      if (task.status === 'awaiting_review') {
        const state = await this.client.inspect(id);
        if (state.cursor === task.cursor && state.status === 'idle' && !state.pending) return;
        this.observe(task, state);
        task.beforeSeq = task.cursor ?? -1;
        task.cursor = state.cursor;
        task.status = state.status === 'idle' && !state.pending ? 'validating' : 'running';
        if (task.status === 'validating') { delete task.blocked; delete task.stalledSince; }
        delete task.fingerprint; delete task.review; delete task.reviewedFingerprint;
        await this.store.save(task);
      }
      if (!running(task)) return;
      const controller = new AbortController();
      const done = this.drive(task, controller).finally(async () => {
        try { await release(); } finally { this.drivers.delete(id); }
      });
      this.drivers.set(id, { controller, done });
      handedOff = true;
      void done.catch(error => console.error(safeError(error)));
    } catch (error) {
      const task = await this.task(id);
      task.status = 'needs_attention'; task.error = safeError(error); await this.store.save(task);
    } finally { if (!handedOff) await release(); }
  }

  private async drive(task: Task, controller: AbortController): Promise<void> {
    const remaining = task.deadline - Date.now();
    const timer = setTimeout(() => controller.abort('timeout'), Math.max(1, Math.min(remaining, 2_147_483_647)));
    const persist = async () => {
      if (controller.signal.aborted || (await this.task(task.id)).status === 'cancelled') throw new Error('执行已取消或超时。');
      await this.store.save(task);
    };
    try {
      if (remaining <= 0) throw new Error('任务超过总运行时限，现场已保留。');
      let lastCursor: number | undefined;
      let lastCursorAt = Date.now();
      while (running(task)) {
        if ((await this.task(task.id)).status === 'cancelled') return;
        if (controller.signal.aborted) throw new Error('执行已取消或超时。');
        if (task.status === 'running') {
          const prevBlocked = task.blocked ? `${task.blocked.kind}:${task.blocked.seq}` : undefined;
          const prevStalled = task.stalledSince;
          const state = await this.client.inspect(task.id);
          this.observe(task, state);
          if (state.status !== 'idle' || state.pending || state.endSeq <= task.beforeSeq) {
            if (state.cursor !== lastCursor) {
              lastCursor = state.cursor;
              lastCursorAt = Date.now();
              delete task.stalledSince;
            } else if (task.blocked) {
              lastCursorAt = Date.now();
              delete task.stalledSince;
            } else if (Date.now() - lastCursorAt >= this.stallMs) {
              task.stalledSince ??= new Date(lastCursorAt).toISOString();
            }
            const nextBlocked = task.blocked ? `${task.blocked.kind}:${task.blocked.seq}` : undefined;
            if (nextBlocked !== prevBlocked || task.stalledSince !== prevStalled) await persist();
            await delay(1500, undefined, { signal: controller.signal }); continue;
          }
          if (state.reason !== 'completed') throw new Error(`DSH 未正常完成（${state.reason ?? 'unknown'}），现场已保留。`);
          task.cursor = state.cursor; task.status = 'validating';
          delete task.blocked; delete task.stalledSince;
          await persist();
        }
        const passed = await this.validate(task, controller.signal, persist);
        if (passed) { task.status = 'awaiting_review'; await persist(); return; }
        if (task.guidance.length) {
          task.status = 'needs_changes'; task.error = 'DSH 中已有用户引导，验收未通过。请结合 guidance 判断方向与验收要求，已停止自动返工。';
        } else if (task.round >= 2) {
          task.status = 'needs_changes'; task.error = '已达到两轮自动与审查返工上限，验收仍未通过。';
        } else {
          task.round++;
          await persist();
          await this.send(task, '修复以下真实验收失败，保持原方案与 allowedPaths，不暂存、不提交：\n' + JSON.stringify(task.checks.filter(check => check.exitCode !== 0)), persist);
          lastCursor = undefined; lastCursorAt = Date.now();
          continue;
        }
        await persist();
      }
    } catch (error) {
      if (controller.signal.reason === 'cancelled' || (await this.task(task.id)).status === 'cancelled') return;
      task.status = 'needs_attention';
      task.error = controller.signal.reason === 'timeout' ? '任务超过总运行时限，现场已保留。' : safeError(error);
      await this.store.save(task);
    } finally { clearTimeout(timer); }
  }

  private async validate(task: Task, signal: AbortSignal, persist: () => Promise<void>): Promise<boolean> {
    await this.idle(task);
    task.checks = [];
    const before = await snapshot(task);
    assertScope(task, before.files);
    if (!before.files.length) throw new Error('执行者没有产生可审查的代码修改。');
    let pwsh: string | undefined;
    for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
      const candidate = path.join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'pwsh.exe' : 'pwsh');
      try { await access(candidate); pwsh = candidate; break; } catch { /* 继续查找 PATH。 */ }
    }
    if (!pwsh) throw new Error('验收需要 PowerShell 7（pwsh），请安装并加入 PATH，不会回退到 PowerShell 5.1。');
    for (const command of task.handoff.validationCommands) {
      if (/\bgit\s+(push|reset|clean|restore|checkout|switch|commit|add|rebase|merge)\b/i.test(command)) throw new Error('验收命令包含 Git 修改或远程操作，已停止。');
      const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $global:LASTEXITCODE = 0;\n${command}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
      const result = await runProcess(pwsh, ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        cwd: task.worktree, env: cleanEnvironment(), signal, timeoutMs: Math.max(1, task.deadline - Date.now()),
      });
      task.checks.push({ command, exitCode: result.code, output: redact(result.output).slice(-16000), at: new Date().toISOString() });
      await persist();
    }
    const after = await snapshot(task);
    assertScope(task, after.files);
    if (!after.files.length) throw new Error('验收后没有可审查的代码修改。');
    await this.idle(task);
    task.changedFiles = after.files; task.fingerprint = after.fingerprint;
    task.diffPath = path.join(this.store.taskDir(task.id), 'changes.diff');
    await writeFile(task.diffPath, redact(after.diff), 'utf8');
    return task.checks.every(check => check.exitCode === 0);
  }

  async wait(id: string, timeoutMs = 600_000): Promise<Record<string, unknown>> {
    const started = Date.now();
    if (!Number.isInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 600_000) throw new Error('timeoutMs 必须在 0..600000 之间。');
    let task = await this.task(id);
    let reason: 'timeout' | 'blocked' | 'stalled' = 'timeout';
    const key = (t: Task) => t.blocked ? `b:${t.blocked.kind}:${t.blocked.seq}` : t.stalledSince ? `s:${t.stalledSince}` : undefined;
    if (timeoutMs > 0) {
      await this.start(id);
      task = await this.task(id);
      while (running(task)) {
        const current = key(task);
        if (current && current !== this.reported.get(id)) {
          this.reported.set(id, current);
          reason = current.startsWith('b:') ? 'blocked' : 'stalled';
          break;
        }
        if (Date.now() - started >= timeoutMs) break;
        await delay(Math.min(250, Math.max(1, timeoutMs - (Date.now() - started))));
        task = await this.task(id);
      }
      if (!running(task)) {
        await this.drivers.get(id)?.done;
        task = await this.task(id);
      }
    }
    return { ...this.result(task), wait: { reason: running(task) ? reason : 'ready', elapsedMs: Date.now() - started } };
  }

  async cancel(id: string): Promise<Task> {
    let task = await this.task(id);
    if (task.status === 'completed' || task.status === 'cancelled') return task;
    // 审查和提交持有同一把任务锁，不能在提交中途改写终态。
    const release = await this.store.lock(id);
    task = await this.task(id);
    if (!release && !running(task)) throw new Error('任务正在审查或提交，请稍后重试。');
    try {
      if (task.status === 'completed' || task.status === 'cancelled') return task;
      this.drivers.get(id)?.controller.abort('cancelled');
      try { await this.client.cancel(id); }
      catch (error) { task.error = safeError(error); }
      task.status = 'cancelled';
      await this.store.save(task);
      return task;
    } finally { await release?.(); }
  }

  result(task: Task): Record<string, unknown> {
    let nextAction: Record<string, unknown> = { type: 'attention' };
    if (running(task)) {
      const notice = task.blocked
        ? `请在 DSH 对话中处理${task.blocked.kind === 'approval' ? '权限审批' : '提问'}：${task.blocked.text}`
        : task.stalledSince
          ? `DSH 自 ${task.stalledSince} 起没有新进展，请到 DSH 对话中查看`
          : undefined;
      nextAction = {
        type: 'wait', tool: 'wait_task', arguments: { taskId: task.id, timeoutMs: 600000 },
        ...(notice ? { notice } : {}),
      };
    }
    else if (task.status === 'awaiting_review') nextAction = { type: 'review' };
    else if (task.status === 'completed') nextAction = { type: 'done' };
    return {
      taskId: task.id, status: task.status, nextAction, title: task.handoff.title,
      worktree: task.worktree, branch: task.branch, baseCommit: task.handoff.baseCommit,
      round: task.round, summary: task.summary, guidance: task.guidance,
      blocked: task.blocked, stalledSince: task.stalledSince,
      checks: task.checks, changedFiles: task.changedFiles, fingerprint: task.fingerprint, diffPath: task.diffPath,
      review: task.review, commit: task.commit, error: task.error, model: task.model,
    };
  }
}
