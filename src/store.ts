import { mkdir, readFile, writeFile, rename, open, unlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Task } from './engine.js';

export const dataRoot = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'CodexDshBridge');

export class Store {
  constructor(readonly root = dataRoot) {}

  taskDir(id: string): string {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw new Error('无效任务 ID。');
    return path.join(this.root, 'tasks', id);
  }

  async load(id: string): Promise<Task | undefined> {
    try { return JSON.parse(await readFile(path.join(this.taskDir(id), 'state.json'), 'utf8')) as Task; }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return; throw error; }
  }

  async save(task: Task): Promise<void> {
    const directory = this.taskDir(task.id);
    await mkdir(directory, { recursive: true });
    const temporary = path.join(directory, `state.${randomUUID()}.tmp`);
    try {
      await writeFile(temporary, JSON.stringify(task, null, 2), { encoding: 'utf8', mode: 0o600 });
      await rename(temporary, path.join(directory, 'state.json'));
    } finally {
      await unlink(temporary).catch(error => { if (error.code !== 'ENOENT') throw error; });
    }
  }

  async lock(id: string): Promise<(() => Promise<void>) | undefined> {
    const file = path.join(this.taskDir(id), 'lock');
    await mkdir(path.dirname(file), { recursive: true });
    for (let attempt = 0; attempt < 3; attempt++) {
      let handle;
      try { handle = await open(file, 'wx', 0o600); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
      if (handle) {
        try { await handle.writeFile(String(process.pid)); }
        catch (error) { await handle.close(); await unlink(file); throw error; }
        await handle.close();
        return () => unlink(file);
      }
      let owner: string;
      try { owner = await readFile(file, 'utf8'); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue; throw error; }
      // 空文件可能是另一个进程刚创建的锁，不能把尚未写入 PID 的锁抢走。
      if (!/^[1-9]\d*$/.test(owner)) return;
      try { process.kill(Number(owner), 0); return; }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') return; }
      try { if (await readFile(file, 'utf8') === owner) await unlink(file); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }
}
