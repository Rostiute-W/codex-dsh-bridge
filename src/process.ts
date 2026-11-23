import { spawn } from 'node:child_process';

export function cleanEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!/key|token|secret|password|authorization|electron_run_as_node|node_options|codex_home|dsh_permission_mode/i.test(key)) env[key] = value;
  }
  return { ...env, ...extra };
}

export async function runProcess(command: string, args: string[], options: {
  cwd?: string; env?: NodeJS.ProcessEnv; timeoutMs?: number; signal?: AbortSignal;
} = {}): Promise<{ code: number; output: string; stdout: string; stderr: string; truncated: boolean }> {
  if (options.signal?.aborted) throw new Error('操作已取消。');
  let executable = command;
  let argv = args;
  const batch = process.platform === 'win32' && /\.(cmd|bat)$/i.test(command);
  if (batch) {
    // 批处理经过 CMD，拒绝能逃逸引号或触发变量展开的参数。
    const values = [command, ...args];
    if (values.some(value => /["%\r\n&|<>^!]/.test(value))) throw new Error('批处理路径或参数包含不支持的 CMD 特殊字符。');
    executable = process.env.ComSpec ?? 'C:\\Windows\\System32\\cmd.exe';
    argv = ['/d', '/s', '/c', '"' + values.map(value => `"${value}"`).join(' ') + '"'];
  }
  const child = spawn(executable, argv, {
    cwd: options.cwd, env: options.env ?? cleanEnvironment(), windowsHide: true,
    windowsVerbatimArguments: batch, stdio: 'pipe',
  });
  let output = '', stdout = '', stderr = '';
  let truncated = false, timedOut = false;
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  const capture = (value: string, stream: 'stdout' | 'stderr') => {
    if (output.length + value.length > 2_000_000) truncated = true;
    output = (output + value).slice(-2_000_000);
    if (stream === 'stdout') stdout = (stdout + value).slice(-2_000_000);
    else stderr = (stderr + value).slice(-2_000_000);
  };
  child.stdout.on('data', value => capture(value, 'stdout'));
  child.stderr.on('data', value => capture(value, 'stderr'));
  child.stdin.on('error', () => {});
  child.stdin.end();
  return new Promise((resolve, reject) => {
    let settled = false;
    let stopped = false;
    let graceTimer: NodeJS.Timeout | undefined;
    const cleanup = () => {
      clearTimeout(timer);
      if (graceTimer) clearTimeout(graceTimer);
      options.signal?.removeEventListener('abort', onAbort);
    };
    const settleReject = (error: unknown) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    };
    const settleResolve = (value: { code: number; output: string; stdout: string; stderr: string; truncated: boolean }) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(value);
    };
    const abortOrTimeoutError = () =>
      options.signal?.aborted ? new Error('操作已取消。') : new Error('命令运行超时，已终止进程树。');
    const scheduleGrace = () => {
      if (settled || graceTimer) return;
      // 子进程已退出但孙进程仍占用 stdio 时，宽限期后主动销毁管道并结束等待。
      graceTimer = setTimeout(() => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
        settleReject(abortOrTimeoutError());
      }, 5_000);
    };
    const stop = () => {
      if (settled) return;
      stopped = true;
      scheduleGrace();
      if (!child.pid) return;
      if (process.platform !== 'win32') {
        if (child.exitCode === null) child.kill('SIGTERM');
        return;
      }
      const fallbackKill = () => { try { child.kill(); } catch { /* 忽略已退出进程 */ } };
      const killer = spawn('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
      killer.once('error', fallbackKill);
      killer.once('close', code => { if (code !== 0) fallbackKill(); });
    };
    const onAbort = () => stop();
    const timer = setTimeout(() => { timedOut = true; stop(); }, options.timeoutMs ?? 120_000);
    options.signal?.addEventListener('abort', onAbort, { once: true });
    if (options.signal?.aborted) stop();
    child.once('exit', () => { if (stopped) scheduleGrace(); });
    child.once('error', error => settleReject(error));
    child.once('close', code => {
      if (options.signal?.aborted || timedOut) settleReject(abortOrTimeoutError());
      else settleResolve({ code: code ?? -1, output, stdout, stderr, truncated });
    });
  });
}
