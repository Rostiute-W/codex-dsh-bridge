import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { RequestPermissionRequest, RequestPermissionResponse } from '@agentclientprotocol/sdk';
import { Store } from './store.js';
import { runDsh, type AgentRun } from './acp.js';
import { runDesktopDsh, nativeIdle, nativeRequest } from './desktop.js';
import { git, prepareWorktree, snapshot, assertScope, finishCommit } from './git.js';
import { runProcess, cleanEnvironment } from './process.js';
import { apiReview } from './reviewer.js';
import { handoffSchema, submitSchema, busyStatuses, redact, safeError, validateReview, type Task, type Handoff, type Submit, type Review } from './model.js';

const runAgent: AgentRun = (...args) => (args[0].executor === 'desktop' ? runDesktopDsh : runDsh)(...args);
export class Engine extends EventEmitter {
  private active?: { id: string; controller: AbortController };
  private permissionAnswers = new Map<string, (response: RequestPermissionResponse) => void>();
  private instructions = new Map<string, string>();
  private persistenceTimer?: NodeJS.Timeout;
  private stopping = false;
  constructor(readonly store: Store, private readonly agentRun: AgentRun = runAgent) { super(); }
  async recover(): Promise<void> {
    for (const task of this.store.tasks) {
      if (busyStatuses.has(task.status) || task.status === 'queued') {
        task.status = 'needs_attention'; task.error = '上次运行中断。现场已保留；请明确选择恢复或重新验证，未自动重发任务。';
        delete task.permission;
        if (task.worktree) {
          try {
            const head = await git(task.worktree, ['rev-parse', 'HEAD']);
            if (head !== task.handoff.baseCommit) task.error += ` 当前 HEAD 为 ${head}；若提交已经产生，请人工核对，勿重复提交。`;
          } catch { task.error += ' 工作目录不可用，请检查磁盘或 Git worktree。'; }
        }
      }
    }
    await this.store.save();
  }
  task(id: string): Task {
    const task = this.store.tasks.find(t => t.id === id);
    if (!task) throw new Error('找不到任务。');
    return task;
  }
  isActive(): boolean { return !!this.active || this.store.tasks.some(t => t.status === 'queued' || t.status === 'committing'); }
  private async changed(task: Task): Promise<void> {
    task.updatedAt = new Date().toISOString(); this.emit('change'); await this.store.save();
  }
  log(task: Task, kind: string, text: string): void {
    const record = { at: new Date().toISOString(), kind, text: redact(text).slice(0, 16000) };
    task.log.push(record); if (task.log.length > 800) task.log.splice(0, task.log.length - 800);
    void mkdir(this.store.taskDir(task.id), { recursive: true }).then(() => appendFile(path.join(this.store.taskDir(task.id), 'execution.jsonl'), JSON.stringify(record) + '\n')).catch(() => {});
    this.emit('change');
    if (!this.persistenceTimer) this.persistenceTimer = setTimeout(() => { this.persistenceTimer = undefined; void this.store.save().catch(error => this.emit('persistence-error', safeError(error))); }, 400);
  }
  async submit(value: unknown): Promise<Task> {
    if (this.stopping) throw new Error('软件正在退出，请稍后重新连接。');
    const request = submitSchema.parse(value);
    if (request.operation === 'execute') return this.create(request.handoff);
    const task = this.task(request.taskId);
    if (request.operation === 'review') return this.acceptReview(task, request.fingerprint, request.review, 'codex');
    if (request.operation === 'revise') return this.revise(task);
    if (request.operation === 'revalidate') return this.revalidate(task.id);
    return this.resume(task, request.instruction);
  }
  private async create(handoff: Handoff): Promise<Task> {
    const duplicate = this.store.tasks.find(t => t.handoff.requestId === handoff.requestId);
    if (duplicate) {
      if (JSON.stringify(duplicate.handoff) !== JSON.stringify(handoff)) throw new Error('requestId 已用于不同的交接内容。请使用新的 ID。');
      return duplicate;
    }
    const serialized = JSON.stringify(handoff);
    if (redact(serialized) !== serialized) throw new Error('交接内容可能包含凭据，请移除后提交。');
    const task: Task = {
      id: randomUUID(), handoff, status: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      round: 0, summary: '', checks: [], changedFiles: [], log: [], executor: this.store.settings.executionMode,
      ...(this.store.settings.executionMode === 'desktop' ? { nativeModel: this.store.settings.nativeModel ? {...this.store.settings.nativeModel} : null } : {}),
    };
    this.store.tasks.unshift(task); await this.changed(task); void this.pump(); return task;
  }
  private async pump(): Promise<void> {
    if (this.active || this.stopping) return;
    const task = [...this.store.tasks].reverse().find(t => t.status === 'queued');
    if (!task) return;
    const controller = new AbortController(); this.active = { id: task.id, controller };
    const timer = setTimeout(() => controller.abort('timeout'), this.store.settings.timeoutMinutes * 60_000);
    try {
      task.status = 'preparing'; delete task.error; await this.changed(task);
      if (!task.worktree) await prepareWorktree(task, this.store.taskDir(task.id));
      let instruction = this.instructions.get(task.id) ?? this.initialPrompt(task);
      this.instructions.delete(task.id);
      for (let attempt = 0; ; attempt++) {
        task.status = 'running'; await this.changed(task);
        task.summary = await this.agentRun(task, this.store.settings, instruction, {
          log: (kind, text) => this.log(task, kind, text),
          session: async (id, capabilities) => { task.sessionId = id; task.capabilities = capabilities; await this.changed(task); },
          permission: params => this.requestPermission(task, params),
        }, controller.signal);
        if (controller.signal.aborted) throw new Error('执行已取消或超时。');
        const passed = await this.validate(task, controller.signal);
        if (passed) { task.status = 'awaiting_review'; await this.changed(task); break; }
        if(task.executor==='desktop'&&task.nativeGuidance?.length){task.status='needs_changes';task.error='DSH 中已有用户引导，当前验收未通过。已停止自动返工，请 Codex 结合 nativeGuidance 判断方案与验收是否需要调整。';await this.changed(task);break;}
        if (attempt >= 2 || task.round >= 2) { task.status = 'needs_changes'; task.error = '自动验证仍未通过。请查看检查记录并人工决定下一步。'; await this.changed(task); break; }
        task.round++; instruction = '修复以下真实验证失败，保持原方案范围，不提交、不暂存、不更改 Git 历史：\n' + JSON.stringify(task.checks.filter(c => c.exitCode !== 0));
      }
    } catch (error) {
      task.status = controller.signal.aborted ? (controller.signal.reason === 'timeout' ? 'needs_attention' : 'cancelled') : 'needs_attention';
      task.error = (controller.signal.reason === 'timeout' ? '任务超过运行时限，现场已保留。' : '') + safeError(error); this.log(task, 'error', task.error); await this.changed(task);
    } finally {
      clearTimeout(timer); this.cancelPermissions(task); this.active = undefined; this.emit('change'); void this.pump();
    }
  }
  private initialPrompt(task: Task): string {
    return [
      '你是 Codex 委派的执行者。完成下面的交接方案，读取并遵循工作目录内适用的 AGENTS.md。只编写代码、运行检查和修复；Codex 负责审查，协调软件负责最终 Git 提交。',
      '不要 git add、git commit、切换分支、改写历史、push、部署或修改原始项目目录。当前目录是独立任务 worktree。不要启动子 agent；遇到方案矛盾或必须更改架构时停止并报告。',
      '凭据使用已有 DSH 配置，不能输出凭据。不要访问任务不需要的个人文件。保持变更在 allowedPaths 范围内。',
      '以下内容是任务规格：', JSON.stringify(task.handoff, null, 2),
      '结束前说明实际修改、验证结果和未解决问题。不要把未通过检查的任务称为完成。',
    ].join('\n');
  }
  private async validate(task: Task, signal: AbortSignal): Promise<boolean> {
    if(task.executor==='desktop')await nativeIdle(task);
    task.status = 'validating'; task.checks = []; await this.changed(task);
    const before = await snapshot(task); assertScope(task, before.files);
    if (!before.files.length) throw new Error('执行者没有产生可审查的代码修改。');
    for (const command of task.handoff.validationCommands) {
      if (/\bgit\s+(push|reset|clean|restore|checkout|switch|commit|add|rebase|merge)\b/i.test(command)) throw new Error('验收命令包含 Git 修改或远程操作，已停止。');
      const script = `$ErrorActionPreference = 'Stop'; $ProgressPreference = 'SilentlyContinue'; [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); $OutputEncoding = [Console]::OutputEncoding; $global:LASTEXITCODE = 0;\n${command}\nif ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }`;
      const result = await runProcess(process.platform === 'win32' ? 'powershell.exe' : 'pwsh', ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], {
        cwd: task.worktree, env: cleanEnvironment(), signal, timeoutMs: this.store.settings.timeoutMinutes * 60_000,
      });
      task.checks.push({ command, exitCode: result.code, output: redact(result.output).slice(-16000), at: new Date().toISOString() });
      this.log(task, 'validation', `${command}\nexit=${result.code}\n${result.output}`); await this.changed(task);
    }
    const after = await snapshot(task); assertScope(task, after.files);
    if(task.executor==='desktop')await nativeIdle(task);
    task.changedFiles = after.files; task.fingerprint = after.fingerprint;
    task.diffPath = path.join(this.store.taskDir(task.id), 'changes.diff');
    await writeFile(task.diffPath, after.diff, 'utf8');
    await writeFile(path.join(this.store.taskDir(task.id), 'validation.json'), JSON.stringify(task.checks, null, 2));
    return task.checks.every(c => c.exitCode === 0);
  }
  private async requestPermission(task: Task, request: RequestPermissionRequest): Promise<RequestPermissionResponse> {
    if (this.active?.controller.signal.aborted) return { outcome: { outcome: 'cancelled' } };
    const id = randomUUID();
    task.permission = { id, title: request.toolCall.title ?? 'DSH 请求额外权限', detail: redact(JSON.stringify(request.toolCall, null, 2)),
      options: request.options.filter(o => o.kind !== 'allow_always').map(o => ({ id: o.optionId, name: o.name, kind: o.kind })) };
    const answer = new Promise<RequestPermissionResponse>(resolve => this.permissionAnswers.set(id, resolve));
    task.status = 'awaiting_permission'; await this.changed(task);
    return answer;
  }
  async answerPermission(taskId: string, permissionId: string, optionId: string | null): Promise<void> {
    const task = this.task(taskId); const permission = task.permission;
    if (!permission || permission.id !== permissionId) throw new Error('权限请求已失效。');
    if (optionId && !permission.options.some(o => o.id === optionId)) throw new Error('无效权限选项。');
    const resolve = this.permissionAnswers.get(permissionId); if (!resolve) throw new Error('原执行进程已退出。');
    this.permissionAnswers.delete(permissionId); delete task.permission;
    task.status = 'running'; await this.changed(task);
    resolve({ outcome: optionId ? { outcome: 'selected', optionId } : { outcome: 'cancelled' } });
  }
  private cancelPermissions(task: Task): void {
    if (task.permission) { this.permissionAnswers.get(task.permission.id)?.({ outcome: { outcome: 'cancelled' } }); this.permissionAnswers.delete(task.permission.id); delete task.permission; }
  }
  async cancel(id: string): Promise<Task> {
    const task = this.task(id);
    if (task.status === 'committing') throw new Error('Git 提交正在完成，请等待，不能在提交中途取消。');
    if (task.status === 'completed') return task;
    this.cancelPermissions(task);
    if (this.active?.id === id) this.active.controller.abort('user');
    else { task.status = 'cancelled'; delete task.error; await this.changed(task); }
    return task;
  }
  private async revise(task: Task): Promise<Task> {
    if (task.status !== 'needs_changes' || !task.review || task.review.verdict !== 'changes_requested') throw new Error('当前任务没有可执行的审查修改意见。');
    if (task.round >= 2) throw new Error('已达到两轮自动返工上限，请人工处理或提交新的明确方案。');
    task.round++; this.instructions.set(task.id, '按以下审查意见修复，保持原方案与目录边界，不提交或暂存：\n' + JSON.stringify(task.review));
    task.status = 'queued'; delete task.reviewedFingerprint; await this.changed(task); void this.pump(); return task;
  }
  private async resume(task: Task, instruction: string): Promise<Task> {
    if (!['needs_attention', 'cancelled', 'failed', 'needs_changes'].includes(task.status)) throw new Error('只有中断或待处理任务可以明确恢复。');
    if (task.worktree) await snapshot(task);
    this.instructions.set(task.id, this.initialPrompt(task) + '\n明确的恢复指令：\n' + instruction);
    task.status = 'queued'; delete task.review; delete task.reviewedFingerprint;
    await this.changed(task); void this.pump(); return task;
  }
  async revalidate(id: string): Promise<Task> {
    const task = this.task(id);
    if (this.isActive() || !task.worktree || !['needs_attention', 'awaiting_review', 'needs_changes', 'cancelled'].includes(task.status)) throw new Error('当前无法重新验证，请等待执行结束。');
    const controller = new AbortController(); this.active = { id, controller };
    const timer = setTimeout(() => controller.abort('timeout'), this.store.settings.timeoutMinutes * 60_000);
    try { if(task.executor==='desktop')task.nativeCursor=(await nativeIdle(task,false)).cursor; task.status = await this.validate(task, controller.signal) ? 'awaiting_review' : 'needs_changes'; delete task.review; delete task.reviewedFingerprint; }
    catch (error) { task.status = 'needs_attention'; task.error = safeError(error); }
    finally { clearTimeout(timer); this.active = undefined; await this.changed(task); void this.pump(); }
    return task;
  }
  async acceptReview(task: Task, fingerprint: string, review: Review, source: 'api' | 'codex'): Promise<Task> {
    if (task.status !== 'awaiting_review') throw new Error('任务不在等待审查状态。');
    validateReview(review);
    // Reserve synchronously: concurrent approvals must not race through snapshot and commit.
    task.status = 'committing';
    let current;
    try {
    if(task.executor==='desktop')await nativeIdle(task);
    current = await snapshot(task);
    if (fingerprint !== task.fingerprint || current.fingerprint !== fingerprint) throw new Error('审查版本与当前代码不一致，请重新验证并审查。');
    if (!task.checks.length || task.checks.some(c => c.exitCode !== 0)) throw new Error('验证尚未全部通过，不能完成审查。');
    } catch (error) { task.status = 'awaiting_review'; await this.changed(task); throw error; }
    task.review = review; task.reviewSource = source;
    if (review.verdict === 'changes_requested') { task.status = 'needs_changes'; await this.changed(task); return task; }
    task.reviewedFingerprint = fingerprint; task.status = 'committing'; await this.changed(task);
    let token: string | undefined;
    try {
      if(task.executor==='desktop')token=(await nativeRequest('lock',{taskId:task.id,cursor:task.nativeCursor}) as {token:string}).token;
      await finishCommit(task); task.status = 'completed'; delete task.error;
    }
    catch (error) { task.status = 'needs_attention'; task.error = safeError(error); }
    finally {if(token)await nativeRequest('unlock',{taskId:task.id,token}).catch(()=>this.log(task,'error','DSH 提交保护未确认释放，将在五分钟内自动过期。'));}
    await this.changed(task); return task;
  }
  async paidReview(id: string, getKey: () => Promise<string>): Promise<Task> {
    const task = this.task(id);
    if (task.status !== 'awaiting_review' || this.isActive()) throw new Error('请等待其他执行结束，且任务必须在等待审查状态。');
    // Reserve before awaiting key retrieval so double-clicks cannot create duplicate paid runs.
    task.status = 'review_running'; const controller = new AbortController(); this.active = { id, controller };
    const timer = setTimeout(() => controller.abort('timeout'), this.store.settings.timeoutMinutes * 60_000);
    try {
      await this.changed(task);
      if(task.executor==='desktop')await nativeIdle(task);
      const current = await snapshot(task); if (current.fingerprint !== task.fingerprint) throw new Error('代码已变更，请重新验证。');
      const key = await new Promise<string>((resolve, reject) => {
        const abort = () => reject(new Error('API 审查已取消或超时。'));
        controller.signal.addEventListener('abort', abort, { once: true });
        if (controller.signal.aborted) abort();
        getKey().then(resolve, reject).finally(() => controller.signal.removeEventListener('abort', abort));
      });
      const result = await apiReview(task, this.store.settings, this.store.taskDir(id), key, controller.signal, text => this.log(task, 'api', text));
      task.apiUsage = result.usage; task.status = 'awaiting_review';
      await this.acceptReview(task, current.fingerprint, result.review, 'api');
    } catch (error) {
      task.status = controller.signal.aborted ? 'cancelled' : 'awaiting_review'; task.error = safeError(error); await this.changed(task);
    } finally { clearTimeout(timer); this.active = undefined; this.emit('change'); void this.pump(); }
    return task;
  }
  result(id: string): Record<string, unknown> {
    const task = this.task(id);
    return { taskId: task.id, status: task.status, title: task.handoff.title, worktree: task.worktree, branch: task.branch,
      executor: task.executor ?? 'acp', nativeCursor:task.nativeCursor,
      nativeGuidance:task.nativeGuidance,
      nativeModel:task.nativeModel,
      baseCommit: task.handoff.baseCommit, sessionId: task.sessionId, round: task.round, summary: task.summary,
      checks: task.checks, changedFiles: task.changedFiles, fingerprint: task.fingerprint, diffPath: task.diffPath,
      handoff: task.handoff, review: task.review, reviewSource: task.reviewSource, apiUsage: task.apiUsage,
      commit: task.commit, commitMessage: task.handoff.commitMessage, gitStatus: task.commitStatus,
      localOnly: true, error: task.error, permission: task.permission ? { title: task.permission.title, action: '在桌面软件中处理' } : undefined };
  }
  async wait(id: string, timeoutMs: number): Promise<Record<string, unknown>> {
    const waiting = () => ['queued', 'preparing', 'running', 'validating', 'review_running', 'committing'].includes(this.task(id).status);
    if (!waiting()) return this.result(id);
    await new Promise<void>(resolve => {
      const finish = () => { clearTimeout(timer); this.removeListener('change', listener); resolve(); };
      const listener = () => { if (!waiting()) finish(); };
      const timer = setTimeout(finish, Math.min(Math.max(timeoutMs, 0), 600_000));
      this.on('change', listener); if (!waiting()) finish();
    });
    return this.result(id);
  }
  async shutdown(): Promise<void> {
    this.stopping = true;
    for (const task of this.store.tasks) if (task.status === 'queued' || this.active?.id === task.id && task.status !== 'committing') await this.cancel(task.id);
    while (this.isActive()) await new Promise<void>(resolve => setTimeout(resolve, 100));
    clearTimeout(this.persistenceTimer); await this.store.save();
  }
}
