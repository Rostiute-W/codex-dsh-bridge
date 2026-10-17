import { redact, type Task } from './model.js';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

/** Explicit file reads also work inside Electron ASAR; recursive fs.cp does not. */
export async function exportObserver(root: string, target: string, pipeHost: string): Promise<void> {
  await mkdir(target, { recursive: true });
  for (const file of ['package.json', 'index.js', 'native.js', 'client.js', 'cordis.patch.yml']) {
    await writeFile(path.join(target, file), await readFile(path.join(root, 'dsh-observer', file)));
  }
  await writeFile(path.join(target, 'bridge-config.json'), JSON.stringify({ pipeHost, dataRoot:path.dirname(target) }));
}

/** Read-only projection: no credentials, settings, execution or approval controls. */
export function observerSnapshot(tasks: Task[], taskId?: string): unknown {
  const task = taskId ? tasks.find(task => task.id === taskId) : tasks[0];
  const snapshot = {
    at: new Date().toISOString(),
    tasks: tasks.slice(0, 100).map(task => ({ id: task.id, title: task.handoff.title, status: task.status, updatedAt: task.updatedAt })),
    detail: task ? { id: task.id, title: task.handoff.title, status: task.status, worktree: task.worktree, sessionId: task.sessionId,
      goal: task.handoff.goal, plan: task.handoff.plan, round: task.round, error: task.error,
      changedFiles: task.changedFiles, checks: task.checks.map(check => ({ ...check, output: check.output.slice(-6000) })),
      review: task.review, commit: task.commit, summary: task.summary.slice(-16000),
      permission: task.permission ? { title: task.permission.title, detail: task.permission.detail.slice(-4000) } : undefined,
      logs: task.log.slice(-150).map(line => `[${line.at}] ${line.kind}\n${line.text}`).join('\n\n').slice(-64000),
    } : undefined,
  };
  return JSON.parse(JSON.stringify(snapshot, (_key, value: unknown) => typeof value === 'string' ? redact(value) : value));
}
