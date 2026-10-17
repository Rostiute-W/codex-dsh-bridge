import { mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { defaultSettings, safeError, settingsSchema, type Settings, type Task } from './model.js';

export async function atomicWrite(file: string, value: unknown): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${randomUUID()}.tmp`;
  await writeFile(temporary, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 });
  await rename(temporary, file);
}
export class Store {
  tasks: Task[] = [];
  settings: Settings = { ...defaultSettings };
  private writes: Promise<void> = Promise.resolve();
  constructor(readonly root: string) {}
  async load(): Promise<void> {
    await mkdir(this.root, { recursive: true });
    let legacy: Record<string, unknown> | undefined;
    try {
      const parsed: unknown = JSON.parse(await readFile(path.join(this.root, 'settings.json'), 'utf8'));
      this.settings = settingsSchema.parse(parsed);
      // Unmarked settings predate the 300-minute default, so they may still hold the old 30.
      if (this.settings.timeoutDefaultVersion !== 1) legacy = parsed as Record<string, unknown>;
    }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('设置文件损坏，请备份后检查 settings.json。'); }
    // Outside the parse above: a failed backup or write must not be reported as corrupt settings.
    if (legacy) {
      try {
        await atomicWrite(path.join(this.root, 'backups', `settings-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}.json`), legacy);
        await this.saveSettings({ ...this.settings, timeoutMinutes: this.settings.timeoutMinutes === 30 ? 300 : this.settings.timeoutMinutes, timeoutDefaultVersion: 1 });
      } catch (error) { throw new Error(`设置默认时限迁移失败，原设置未覆盖：${safeError(error)}`); }
    }
    try {
      const data: unknown = JSON.parse(await readFile(path.join(this.root, 'tasks.json'), 'utf8'));
      if (!Array.isArray(data)) throw new Error('Invalid tasks');
      this.tasks = data as Task[];
      if (this.tasks.some(t => !t || typeof t.id !== 'string' || !t.handoff || !Array.isArray(t.log))) throw new Error('Invalid task records');
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new Error('任务文件损坏：未覆盖原文件，请备份 tasks.json 后恢复。'); }
  }
  save(): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(this.tasks));
    // ponytail: one serialized JSON file; migrate to SQLite if task history becomes large.
    this.writes = this.writes.catch(() => {}).then(async () => {
      for (const task of snapshot as Task[]) await atomicWrite(path.join(this.taskDir(task.id), 'state.json'), task);
      await atomicWrite(path.join(this.root, 'tasks.json'), snapshot);
    });
    return this.writes;
  }
  async saveSettings(settings: Settings): Promise<void> {
    this.settings = settingsSchema.parse(settings);
    await atomicWrite(path.join(this.root, 'settings.json'), this.settings);
  }
  taskDir(id: string): string {
    if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('无效任务 ID。');
    return path.join(this.root, 'tasks', id);
  }
}
