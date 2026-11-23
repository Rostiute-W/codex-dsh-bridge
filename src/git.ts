import { readFile, mkdir, realpath, lstat } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { runProcess, cleanEnvironment } from './process.js';
import type { Task } from './engine.js';

async function gitRaw(cwd: string, args: string[]): Promise<string> {
  const result = await runProcess('git', ['-C', cwd, ...args], { env: cleanEnvironment(), timeoutMs: 60_000 });
  if (result.code !== 0) throw new Error(`Git 操作失败 (${args[0]}): ${result.output.slice(-3000)}`);
  if (result.truncated) throw new Error('Git 输出超过安全上限，请拆分任务；不会使用截断结果。');
  return result.stdout;
}
export async function git(cwd: string, args: string[]): Promise<string> {
  return (await gitRaw(cwd, args)).trimEnd();
}
export function validateRelative(file: string): string {
  const normalized = file.replace(/\\/g, '/').replace(/\/$/, '');
  if (!normalized || path.isAbsolute(file) || normalized.split('/').some(part => !part || part === '..' || part === '.' || part.toLowerCase() === '.git' || /[. ]$/.test(part)) || /[:\0-\x1f]/.test(file)) throw new Error(`无效的任务相对路径：${file}`);
  return normalized;
}
export async function gitRoot(repoPath: string): Promise<string> {
  const repo = await realpath(repoPath);
  const root = await realpath(await git(repo, ['rev-parse', '--show-toplevel']));
  if (repo.toLowerCase() !== root.toLowerCase()) throw new Error('repoPath 必须是项目 Git 根目录。');
  return repo;
}
export async function prepareWorktree(task: Task, taskDir: string): Promise<void> {
  const repo = await gitRoot(task.handoff.repoPath);
  const dirty = await git(repo, ['status', '--porcelain']);
  if (dirty) throw new Error('项目存在未提交修改。请先保留或提交用户修改，再重新提交任务；软件不会自动暂存它们。');
  const head = await git(repo, ['rev-parse', 'HEAD']);
  if (head !== task.handoff.baseCommit) throw new Error('代码基准与当前 HEAD 不一致，请重新核对方案。');
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
  const tracked = await git(task.worktree, ['diff', '--no-renames', '--name-only', '-z', 'HEAD']);
  const untracked = await git(task.worktree, ['ls-files', '--others', '--exclude-standard', '-z']);
  const files = [...new Set((tracked + '\0' + untracked).split('\0').filter(Boolean))].sort();
  const hash = createHash('sha256');
  let diff = await gitRaw(task.worktree, ['diff', '--no-ext-diff', '--no-textconv', '--binary', 'HEAD']);
  for (const file of untracked.split('\0').filter(Boolean)) {
    const extra = await runProcess('git', ['-C', task.worktree, 'diff', '--no-index', '--no-ext-diff', '--no-textconv', '--binary', '--', '/dev/null', file], { env: cleanEnvironment(), timeoutMs: 60_000 });
    if (![0, 1].includes(extra.code) || extra.truncated) throw new Error('无法完整记录新增文件差异，请拆分或检查任务。');
    if (diff && extra.stdout && !diff.endsWith('\n')) diff += '\n';
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
  const stagedFiles = (await git(task.worktree!, ['diff', '--cached', '--no-renames', '--name-only', '-z'])).split('\0').filter(Boolean).sort();
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
export interface PushTarget { remote: string; branch: string }
export async function validatePushTarget(cwd: string, target: PushTarget): Promise<void> {
  const { remote, branch } = target;
  if (/^https:\/\//i.test(remote)) {
    let url: URL;
    try { url = new URL(remote); } catch { throw new Error(`无效的推送地址：${remote}`); }
    if (url.username || url.password) throw new Error('推送地址不能包含用户名或凭据，请通过 Git 凭据管理器登录。');
    if (url.search || url.hash || !url.hostname) throw new Error(`无效的推送地址：${remote}`);
  } else if (/^[a-z][a-z0-9+.-]*:/i.test(remote) || remote.includes('@')) {
    throw new Error('推送地址只支持 https://，或仓库中已配置的 remote 名称。');
  } else if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(remote) || !(await git(cwd, ['remote'])).split(/\r?\n/).includes(remote)) {
    throw new Error(`仓库中没有名为 ${remote} 的 remote，可以改传 https 地址。`);
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/.test(branch)) throw new Error(`无效的推送分支：${branch}`);
  await git(cwd, ['check-ref-format', `refs/heads/${branch}`]).catch(() => { throw new Error(`无效的推送分支：${branch}`); });
}
// 只做快进推送：refspec 不带 +、不加 --force，远程已有分叉提交时由 Git 拒绝。
export async function pushCommit(cwd: string, commit: string, target: PushTarget): Promise<{ remoteCommit: string; output: string }> {
  await validatePushTarget(cwd, target);
  if (!/^[a-f0-9]{40,64}$/i.test(commit)) throw new Error('commit 必须是完整提交号。');
  const resolved = await git(cwd, ['rev-parse', '--verify', `${commit}^{commit}`]).catch(() => { throw new Error(`仓库中找不到提交 ${commit}。`); });
  if (resolved.toLowerCase() !== commit.toLowerCase()) throw new Error(`仓库中找不到提交 ${commit}。`);
  const ref = `refs/heads/${target.branch}`;
  // 关闭终端提示，避免无人值守时卡在命令行输入；凭据管理器的图形登录不受影响。
  const env = cleanEnvironment({ GIT_TERMINAL_PROMPT: '0' });
  const pushed = await runProcess('git', ['-C', cwd, 'push', '--porcelain', '--no-follow-tags', target.remote, `${resolved}:${ref}`], { env, timeoutMs: 300_000 });
  if (pushed.code !== 0) throw new Error(`推送失败（不会强制推送）：${pushed.output.slice(-3000)}`);
  const listed = await runProcess('git', ['-C', cwd, 'ls-remote', target.remote, ref], { env, timeoutMs: 120_000 });
  if (listed.code !== 0) throw new Error(`推送后读取远程分支失败：${listed.output.slice(-3000)}`);
  const remoteCommit = listed.stdout.split(/\s+/)[0] ?? '';
  if (remoteCommit.toLowerCase() !== resolved.toLowerCase()) throw new Error(`推送后远程 ${ref} 为 ${remoteCommit || '(不存在)'}，与 ${resolved} 不一致。`);
  return { remoteCommit, output: pushed.output.slice(-4000) };
}
