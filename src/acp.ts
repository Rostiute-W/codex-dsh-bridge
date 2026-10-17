import { client, ndJsonStream, PROTOCOL_VERSION, type RequestPermissionRequest, type RequestPermissionResponse, type ClientConnection } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { startProcess, runProcess, terminateTree, cleanEnvironment } from './process.js';
import { redact, type Settings, type Task } from './model.js';

export interface AgentHooks {
  log(kind: string, text: string): void;
  session(id: string, capabilities: unknown): Promise<void>;
  permission(request: RequestPermissionRequest): Promise<RequestPermissionResponse>;
}
export type AgentRun = (task: Task, settings: Settings, instruction: string, hooks: AgentHooks, signal: AbortSignal) => Promise<string>;

export const runDsh: AgentRun = async (task, settings, instruction, hooks, signal) => {
  if (!task.worktree) throw new Error('没有执行目录。');
  const {args, env} = await configureDsh(task.worktree, settings, signal);
  return runAcp(settings.dshPath, args, env, task, settings.dshModel, instruction, hooks, signal);
};

export async function configureDsh(worktree: string, settings: Settings, signal: AbortSignal): Promise<{args:string[];env:NodeJS.ProcessEnv}> {
  const overlay = path.join(path.dirname(worktree), 'bridge.cordis.patch.yml');
  await writeFile(overlay, [
    "- id: sandbox-policy", "  name: '@deepseek-ai/dsh-sandbox-policy'", '  config:', '    mode: workspace-write', '    workspaceRoot: !!js process.cwd()',
    "- id: fs-sandbox", "  name: '@deepseek-ai/dsh-fs-sandbox'", '  disabled: false',
    "- id: pwsh-sandbox", "  name: '@deepseek-ai/dsh-pwsh-sandbox'", '  disabled: false',
    "- id: approval", "  name: '@deepseek-ai/dsh-user-approval'", '  config:', '    policy: ask',
    '- id: tool-subagent', '  disabled: true', '- id: tool-subagent-control', '  disabled: true',
  ].join('\n') + '\n', 'utf8');
  const env = cleanEnvironment({ DSH_PERMISSION_MODE: 'workspace-write', ...(settings.dshHome ? { DSH_HOME: settings.dshHome } : {}) });
  const args = ['--profile', 'acp', '--patch', overlay];
  const config = await runProcess(settings.dshPath, [...args, '--dump-config'], { cwd: worktree, env, signal, timeoutMs: 30_000 });
  if (config.code !== 0) throw new Error('DSH ACP profile 配置检查失败。请在 DSH 中配置模型，并核对安装路径。');
  for (const required of ['dsh-fs-sandbox', 'dsh-pwsh-sandbox', 'dsh-sandbox-policy']) {
    if (!config.output.includes(`@deepseek-ai/${required}`)) throw new Error(`DSH 缺少 ${required}，不会退回无约束执行。`);
  }
  if (/@deepseek-ai\/dsh-(?:fs-local|pwsh-local|bash-local)['"]/.test(config.output)) throw new Error('ACP 配置包含不受约束的文件或 shell 后端，请检查 acp profile。');
  return {args, env};
}

export async function runAcp(command: string, args: string[], env: NodeJS.ProcessEnv, task: Task, model: string, instruction: string, hooks: AgentHooks, signal: AbortSignal): Promise<string> {
  let child: ChildProcessWithoutNullStreams | undefined;
  let connection: ClientConnection | undefined;
  let sessionId = task.sessionId;
  let finalText = '';
  let cancelled = false;
  let rejectAbort: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAbort = reject; });
  const onAbort = () => {
    cancelled = true;
    if (connection && sessionId) void connection.agent.notify('session/cancel', { sessionId }).catch(() => {});
    rejectAbort(new Error('DSH 执行已取消或超时。'));
  };
  // Attach a rejection handler before any await; cancellation can occur during startup.
  void aborted.catch(() => {});
  signal.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal.aborted) throw new Error('DSH 执行已取消。');
    child = await startProcess(command, args, { cwd: task.worktree, env });
    child.stdin.on('error', () => {});
    if (signal.aborted) onAbort();
    child.stderr.on('data', bytes => hooks.log('diagnostic', redact(bytes.toString()).slice(-8000)));
    const app = client({ name: 'codex-dsh-bridge' })
      .onNotification('session/update', ({ params }) => {
        const update = params.update;
        if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') {
          finalText = (finalText + update.content.text).slice(-128_000);
          hooks.log('assistant', update.content.text);
        } else if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
          hooks.log('tool', JSON.stringify(update).slice(0, 16000));
        }
      })
      .onRequest('session/request_permission', async ({ params }) => cancelled ? { outcome: { outcome: 'cancelled' } } : hooks.permission(params));
    connection = app.connect(ndJsonStream(Writable.toWeb(child.stdin), Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
    const failed = new Promise<never>((_, reject) => {
      child!.on('error', error => reject(error));
      child!.on('exit', code => reject(new Error(`DSH 进程退出，状态 ${code}。`)));
      void connection!.closed.then(() => reject(new Error('ACP 连接已关闭。')));
    });
    void failed.catch(() => {});
    const race = <T>(promise: Promise<T>): Promise<T> => Promise.race([promise, aborted, failed]);
    const info = await race(connection.agent.request('initialize', {
      protocolVersion: PROTOCOL_VERSION, clientInfo: { name: 'codex-dsh-bridge', version: '0.1.0' }, clientCapabilities: {},
    }));
    if (info.protocolVersion !== PROTOCOL_VERSION) throw new Error('DSH ACP 协议版本不兼容。');
    let session;
    if (sessionId) {
      if (!info.agentCapabilities?.sessionCapabilities?.resume) throw new Error('此 DSH 版本不支持恢复会话。保留现场，请更新或人工检查。');
      session = await race(connection.agent.request('session/resume', { sessionId, cwd: task.worktree!, mcpServers: [] }));
    } else {
      const created = await race(connection.agent.request('session/new', { cwd: task.worktree!, mcpServers: [] }));
      sessionId = created.sessionId; session = created;
    }
    await hooks.session(sessionId!, info.agentCapabilities);
    if (model) {
      const option = session.configOptions?.find(o => o.category === 'model' || o.id === 'model');
      if (!option || option.type !== 'select') throw new Error('DSH 没有提供模型选择选项。');
      const values = option.options.flatMap(o => 'group' in o ? o.options : [o]);
      const choice = values.find(o => o.value === model || o.name === model);
      if (!choice) throw new Error('设置中的 DSH 模型不在 ACP 提供的选项中。请清空以使用 profile 默认值，或填写有效选项 ID。');
      await race(connection.agent.request('session/set_config_option', { sessionId: sessionId!, configId: option.id, value: choice.value }));
    }
    const result = await race(connection.agent.request('session/prompt', { sessionId: sessionId!, prompt: [{ type: 'text', text: instruction }] }));
    if (result.stopReason !== 'end_turn') throw new Error(`DSH 未正常结束任务：${result.stopReason}`);
    return redact(finalText);
  } finally {
    signal.removeEventListener('abort', onAbort);
    if (connection && sessionId) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        connection.agent.request('session/close', { sessionId }).catch(() => {}),
        new Promise<void>(resolve => { timer = setTimeout(resolve, 1500); }),
      ]);
      clearTimeout(timer);
    }
    connection?.close();
    if (child) { child.stdin.end(); await terminateTree(child); }
  }
}
