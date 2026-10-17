import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { access } from 'node:fs/promises';
import path from 'node:path';

export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/key|token|secret|password|authorization|electron_run_as_node|node_options|codex_home|dsh_permission_mode/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}
export async function resolveExecutable(command: string): Promise<string> {
  if (path.isAbsolute(command)) { await access(command); return command; }
  if (!/^[\w.-]+$/.test(command)) throw new Error('可执行命令应为绝对路径或简单命令名。');
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const ext of process.platform === 'win32' ? ['', '.exe', '.cmd'] : ['']) {
      const candidate = path.join(dir.replace(/^"|"$/g, ''), command + ext);
      try { await access(candidate); return candidate; } catch { /* try next PATH entry */ }
    }
  }
  throw new Error(`找不到命令 ${command}，请在设置中填写绝对路径。`);
}
export async function resolveCodexExecutable(configured = 'codex'): Promise<string> {
  const command = await resolveExecutable(configured);
  if (process.platform !== 'win32' || /\.exe$/i.test(command)) return command;
  const directory = path.dirname(command);
  for (const candidate of [
    path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe'),
    path.join(directory, 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
    path.join(directory, 'node_modules', '@openai', 'codex', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
    path.join(directory, 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'codex', 'codex.exe'),
  ]) { try { await access(candidate); return candidate; } catch { /* next supported npm layout */ } }
  try { return await resolveExecutable('codex.exe'); }
  catch { throw new Error('找不到 Windows 原生 codex.exe，请在运行设置中选择 Codex 原生执行文件。'); }
}
export async function startProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv } = {}): Promise<ChildProcessWithoutNullStreams> {
  const executable = await resolveExecutable(command);
  const managed = (file: string, argv: string[], rawArguments?: string) => {
    const jobHost = process.env.BRIDGE_JOB_HOST;
    if (process.platform === 'win32' && jobHost) {
      const host = spawn(jobHost, ['--run'], { windowsHide: true, stdio: 'pipe' });
      host.stdin.write(JSON.stringify({ file, args: argv, rawArguments, cwd: options.cwd, env: options.env ?? cleanEnvironment(), parentPid: process.pid }) + '\n');
      return host;
    }
    return spawn(file, argv, { ...options, windowsHide: true, stdio: 'pipe' });
  };
  if (process.platform === 'win32' && /\.(cmd|bat)$/i.test(executable)) {
    // Batch launch is a shell boundary. Reject cmd metacharacters, including those in user-selected paths.
    const values = [executable, ...args];
    if (values.some(s => /["%\r\n&|<>^!]/.test(s))) throw new Error('批处理路径或参数包含不支持的 CMD 特殊字符。');
    const line = '"' + values.map(s => `"${s}"`).join(' ') + '"';
    const cmd = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    if (process.env.BRIDGE_JOB_HOST) return managed(cmd, [], `/d /s /c ${line}`);
    return spawn(cmd, ['/d', '/s', '/c', line], { ...options, windowsHide: true, windowsVerbatimArguments: true, stdio: 'pipe' });
  }
  return managed(executable, args);
}
export async function terminateTree(child: ChildProcessWithoutNullStreams): Promise<void> {
  if (!child.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise<void>(resolve => {
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.on('error', () => { child.kill(); resolve(); });
      killer.on('close', () => resolve());
    });
  } else { child.kill('SIGTERM'); }
}
export async function runProcess(command: string, args: string[], options: { cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal } = {}): Promise<{ code: number; output: string; stdout: string; stderr: string; truncated: boolean }> {
  if (options.signal?.aborted) throw new Error('操作已取消。');
  const child = await startProcess(command, args, options);
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  let output = '', stdout = '', stderr = ''; let truncated = false;
  const capture = (data: Buffer | string, stream: 'stdout' | 'stderr') => {
    const value = data.toString();
    if (output.length + value.length > 2_000_000) truncated = true;
    output = (output + value).slice(-2_000_000);
    if (stream === 'stdout') stdout = (stdout + value).slice(-2_000_000);
    else stderr = (stderr + value).slice(-2_000_000);
  };
  child.stdout.on('data', data => capture(data, 'stdout')); child.stderr.on('data', data => capture(data, 'stderr'));
  child.stdin.on('error', () => { /* exit/error is reported by the child */ });
  child.stdin.end();
  const abort = () => { void terminateTree(child); };
  const timer = setTimeout(abort, options.timeoutMs ?? 120_000);
  options.signal?.addEventListener('abort', abort, { once: true });
  if (options.signal?.aborted) abort();
  return new Promise((resolve, reject) => {
    child.on('error', error => { clearTimeout(timer); options.signal?.removeEventListener('abort', abort); reject(error); });
    child.on('close', code => {
      clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
      if (options.signal?.aborted) reject(new Error('操作已取消。'));
      else resolve({ code: code ?? -1, output, stdout, stderr, truncated });
    });
  });
}
