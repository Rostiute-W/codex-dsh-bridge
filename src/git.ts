import { readFile, mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess, cleanEnvironment } from './process.js';
import type { Task } from './engine.js';

export async function git(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess('git', ['-C', cwd, ...args], { env: cleanEnvironment(), timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Git 操作失败 (${args[0]}): ${result.output.slice(-3000)}`);
  if (result.truncated) throw new Error('Git 输出超过安全上限，请拆分任务；不会使用截断结果。');
  return result.stdout.trimEnd();
}
export function validateRelative(file: string): string {
  const normalized = file.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized || path.isAbsolute(file) || normalized.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git' || /[. ]$/.test(part)) || /[:\0-\x1f]/.test(file)) throw new Error(`无效的任务相对路径：${file}`);
  return normalized;
}
export async function prepareWorktree(task: Task, taskDir: string): Promise<void> {
  const repo = await realpath(task.handoff.repoPath);
  const root = await realpath(await git(repo, ['rev-parse', '--show-toplevel']));
  if (repo.toLowerCase() !== root.toLowerCase()) throw new Error('repoPath 必须是项目 Git 根目录。');
  const dirty = await git(repo, ['status', '--porcelain']);
  if (dirty) throw new Error('项目存在未提交修改。请先保留或提交用户修改，再重新提交任务；软件不会自动暂存它们。');
  const head = await git(repo, ['rev-parse', 'HEAD']);
  if (head !== task.handoff.baseCommit) throw new Error('代码基准与当前 HEAD 不一致，请让 Codex 重新核对方案。');
  task.handoff.allowedPaths.forEach(validateRelative);
  await mkdir(taskDir, { recursive: true });
  task.worktree = path.join(taskDir, 'workspace');
  task.branch = `agent/dsh-${task.id.slice(0, 8)}`;
  await git(repo, ['worktree', 'add', '-b', task.branch, task.worktree, head]);
}
export async function snapshot(task: Task, allowStaged = false): Promise<{ files: string[]; fingerprint: string; diff: string }> {
  if (!task.worktree) throw new Error('任务尚未建立 worktree。');
  if (await git(task.worktree, ['rev-parse', 'HEAD']) !== task.handoff.baseCommit) throw new Error('执行者改变了任务 HEAD。保留现场，请人工检查，不会重写历史。');
  if (!allowStaged && await git(task.worktree, ['diff', '--name-only', '--cached'])) throw new Error('执行者暂存了文件。请人工核对索引，软件不会覆盖已有暂存内容。');
  const tracked = await git(task.worktree, ['diff', '--name-only', '-z', 'HEAD']);
  const untracked = await git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set((tracked + '\0' + untracked).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  let diff = await git(task.worktree, ['diff', '--binary', 'HEAD']);
  for (const file of untracked.split('\0').filter(Boolean)) {
    const extra = await runProcess('git', ['-C', task.worktree, 'diff', '--no-index', '--binary', '--', '/dev/null', file], {env:cleanEnvironment(),timeoutMs:60000});
    if (![0,1].includes(extra.code) || extra.truncated) throw new Error('无法完整记录新增文件差异，请拆分或检查任务。');
    diff += extra.stdout;
    if (diff.length > 2_000_000) throw new Error('变更超过安全上限，请拆分任务。');
  }
  // 指纹绑定文件系统内容，暂存新增文件不会改变其身份。
  hash.update(task.handoff.baseCommit);
  for (const file of files) {
    validateRelative(file);
    const target = path.join(task.worktree, file);
    try {
      const info = await lstat(target);
      if (info.isSymbolicLink()) throw new Error(`任务变更包含符号链接：${file}，请人工检查。`);
      hash.update(JSON.stringify([file, info.mode, info.size]));
      hash.update(await readFile(target));
    } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') hash.update(JSON.stringify([file,'deleted'])); else throw error; }
  }
  return { files, fingerprint: hash.digest('hex'), diff };
}
export function assertScope(task: Task, files: string[]): void {
  const roots = task.handoff.allowedPaths.map(validateRelative);
  for (const file of files) {
    if (!roots.some(root => file === root || file.startsWith(root + '/'))) throw new Error(`变更超出方案范围：${file}`);
    if (/(^|\/)(\.env(?:\..*)?|auth\.json|\.?credentials?(?:\..*)?|\.npmrc|\.netrc|\.git-credentials|id_(?:rsa|ed25519|ecdsa|dsa))$|\.(pem|p12|pfx|key|keystore|jks)$/i.test(file)) throw new Error(`拒绝提交可能的凭据文件：${file}`);
  }
}
export async function finishCommit(task: Task): Promise<void> {
  const current = await snapshot(task);
  if (!current.files.length) throw new Error('任务没有可提交的代码变更。');
  if (current.fingerprint !== task.reviewedFingerprint) throw new Error('代码在审查后发生变化，必须重新验证和审查。');
  assertScope(task, current.files);
  for (const file of current.files) {
    try {
      const bytes = await readFile(path.join(task.worktree!, file));
      if (/\b(?:sk|ds)[-_][A-Za-z0-9_-]{24,}\b/.test(bytes.toString('utf8'))) throw new Error(`文件可能包含真实 API 凭据：${file}，请人工核对。`);
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  }
  const stagedPreview = await git(task.worktree!, ['diff', 'HEAD']);
  if (stagedPreview.length > 10_000_000) throw new Error('变更过大，请拆分任务。');
  await git(task.worktree!, ['add', '--', ...current.files]);
  const stagedFiles = (await git(task.worktree!, ['diff', '--cached', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
  if (JSON.stringify(stagedFiles) !== JSON.stringify(current.files)) throw new Error('暂存文件与审查范围不一致，保留索引供人工检查。');
  if ((await snapshot(task, true)).fingerprint !== task.reviewedFingerprint) throw new Error('暂存期间代码发生变化，必须重新验证和审查。');
  await git(task.worktree!, ['diff', '--cached', '--check']);
  await git(task.worktree!, ['diff', '--cached']);
  const expectedTree = await git(task.worktree!, ['write-tree']);
  await git(task.worktree!, ['commit', '-m', task.handoff.commitMessage]);
  task.commit = await git(task.worktree!, ['rev-parse', 'HEAD']);
  const commitStatus = await git(task.worktree!, ['status', '--short']);
  if (await git(task.worktree!, ['rev-parse', 'HEAD^{tree}']) !== expectedTree) throw new Error('Git hook 修改了已审查的提交内容。提交哈希已保留，请人工检查。');
  if (commitStatus) throw new Error('提交后工作区还有修改，请人工检查。');
}
