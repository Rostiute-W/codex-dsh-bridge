/**
 * Trellis 0.6.17 只读任务上下文加载器。
 *
 * 只读取调用方显式给出的任务目录（不猜当前任务），不执行项目脚本、不写 worktree、
 * 不碰 .runtime 与 workspace 日志。所有路径逐层校验并限制在 worktree 内。
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readFile, readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type TrellisRole = 'implementation' | 'review' | 'shared';

export interface TrellisFile {
  /** worktree 相对的 POSIX 路径。 */
  path: string;
  content: string;
  sha256: string;
  /** 按 implementation、review、shared 顺序排列；同一文件被多处引用时合并。 */
  roles: TrellisRole[];
}

export interface TrellisContext {
  version: 1;
  baseCommit: string;
  taskPath: string;
  files: TrellisFile[];
  /** 对 version/baseCommit/taskPath 与每个文件的 path+sha256+roles 求 sha256。 */
  sha256: string;
}

/** 上限取自 Trellis 0.6.17 context_injection 默认值；超出即报错，绝不截断。 */
export const trellisLimits = { maxFiles: 64, maxFileBytes: 65_536, maxTotalBytes: 131_072 } as const;

const ROLE_ORDER: TrellisRole[] = ['implementation', 'review', 'shared'];
const SHARED = 'shared';
const OPTIONAL_TASK_FILES = ['design.md', 'implement.md'];
const MANIFESTS = [
  { name: 'implement.jsonl', role: 'implementation' },
  { name: 'check.jsonl', role: 'review' },
] as const;
const CREDENTIAL_NAME = /^(?:\.env(?:\..+)?|\.npmrc|\.netrc|\.pgpass|\.git-credentials|id_(?:rsa|dsa|ecdsa|ed25519)|credentials?(?:\..+)?|auth\.json)$/i;
const CREDENTIAL_EXTENSION = /\.(?:pem|key|p12|pfx|keystore|jks)$/i;
const DENIED_PATH = /(?:^|\/)\.runtime(?:\/|$)|(?:^|\/)\.trellis\/workspace(?:\/|$)/i;

const hash = (data: string | Uint8Array): string => createHash('sha256').update(data).digest('hex');
const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException)?.code === 'ENOENT';

function missingError(message: string): NodeJS.ErrnoException {
  const error = new Error(message) as NodeJS.ErrnoException;
  error.code = 'ENOENT';
  return error;
}

/** 把仓库相对引用拆成安全路径段；绝对路径、上级路径、.git、盘符与 Windows 数据流一律拒绝。 */
function splitPath(value: string, label: string): string[] {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 不能为空`);
  const cleaned = value.replace(/\\/g, '/').replace(/^(?:\.\/)+/, '').replace(/\/+$/, '');
  if (!cleaned || cleaned.length > 1000) throw new Error(`${label} 为空或过长：${value}`);
  if (/[\0-\x1f]/.test(cleaned)) throw new Error(`${label} 含控制字符：${value}`);
  if (path.isAbsolute(cleaned) || /^[A-Za-z]:/.test(cleaned) || cleaned.startsWith('/')) throw new Error(`${label} 必须是 worktree 相对路径：${value}`);
  const segments = cleaned.split('/');
  for (const segment of segments) {
    if (!segment || segment === '.' || segment === '..') throw new Error(`${label} 含无效路径段：${value}`);
    if (segment.includes(':')) throw new Error(`${label} 含盘符或 Windows 数据流：${value}`);
    if (/[. ]$/.test(segment)) throw new Error(`${label} 路径段不能以点或空格结尾：${value}`);
    if (segment.toLowerCase() === '.git') throw new Error(`${label} 不能指向 .git：${value}`);
  }
  return segments;
}

function assertReadable(key: string): void {
  const name = key.slice(key.lastIndexOf('/') + 1);
  if (CREDENTIAL_NAME.test(name) || CREDENTIAL_EXTENSION.test(name)) throw new Error(`拒绝读取可能的凭据文件：${key}`);
  if (DENIED_PATH.test(key)) throw new Error(`拒绝读取运行时状态或用户日志：${key}`);
}

interface Located { abs: string; info: Stats }

/** 逐层 lstat 拒绝符号链接与目录联接，再用 realpath 复核是否仍在 worktree 内。 */
async function locate(root: string, segments: string[], label: string): Promise<Located> {
  const key = segments.join('/');
  let current = root;
  let info: Stats | undefined;
  for (const segment of segments) {
    current = path.join(current, segment);
    try { info = await lstat(current); }
    catch (error) { if (isMissing(error)) throw missingError(`${label} 不存在：${key}`); throw error; }
    if (info.isSymbolicLink()) throw new Error(`${label} 经过符号链接或目录联接：${key}`);
  }
  if (!info) throw new Error(`${label} 不是有效路径：${key}`);
  const base = root.endsWith(path.sep) ? root : root + path.sep;
  const real = (await realpath(current)).toLowerCase();
  if (real !== root.toLowerCase() && !real.startsWith(base.toLowerCase())) throw new Error(`${label} 越出 worktree：${key}`);
  return { abs: current, info };
}

function decode(buffer: Buffer, key: string): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { throw new Error(`上下文文件不是有效的 UTF-8 文本：${key}`); }
}

function assertTaskObject(text: string, key: string): void {
  let data: unknown;
  try { data = JSON.parse(text); }
  catch { throw new Error(`${key} 不是合法 JSON`); }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${key} 必须是 JSON 对象`);
}

interface ManifestEntry { file: string; type: 'file' | 'directory'; line: number }

/** 与本机 0.6.17 common/task_context.py 一致：一行一个对象；旧 _example 占位行忽略，其余非法行报错。 */
function parseManifest(text: string, name: string): ManifestEntry[] {
  const entries: ManifestEntry[] = [];
  text.split(/\r?\n/).forEach((line, index) => {
    if (!line.trim()) return;
    const label = `${name}:${index + 1}`;
    let data: unknown;
    try { data = JSON.parse(line); }
    catch { throw new Error(`${label} 不是合法 JSON`); }
    if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${label} 必须是 JSON 对象`);
    const record = data as Record<string, unknown>;
    if ('_example' in record) return;
    const file = record.file;
    if (typeof file !== 'string' || !file.trim()) throw new Error(`${label} 缺少字符串 file 路径`);
    const rawType = record.type === undefined ? 'file' : record.type;
    if (rawType !== 'file' && rawType !== 'directory') throw new Error(`${label} 未知条目类型：${JSON.stringify(record.type)}`);
    entries.push({ file: file.trim(), type: rawType, line: index + 1 });
  });
  return entries;
}

interface Entry { content: string; sha256: string; roles: Set<TrellisRole> }

class Collector {
  readonly files = new Map<string, Entry>();
  private bytes = 0;

  constructor(private readonly root: string) {}

  async read(segments: string[], role: TrellisRole, required: boolean): Promise<boolean> {
    const key = segments.join('/');
    assertReadable(key);
    const existing = this.files.get(key);
    if (existing) { existing.roles.add(role); return true; }
    let located: Located;
    try { located = await locate(this.root, segments, '上下文路径'); }
    catch (error) { if (!required && isMissing(error)) return false; throw error; }
    if (!located.info.isFile()) throw new Error(`上下文路径不是普通文件：${key}`);
    if (this.files.size >= trellisLimits.maxFiles) throw new Error(`上下文文件数超过上限 ${trellisLimits.maxFiles}：${key}`);
    if (located.info.size > trellisLimits.maxFileBytes) throw new Error(`上下文文件超过单文件上限 ${trellisLimits.maxFileBytes} 字节：${key}`);
    const buffer = await readFile(located.abs);
    if (buffer.length > trellisLimits.maxFileBytes) throw new Error(`上下文文件超过单文件上限 ${trellisLimits.maxFileBytes} 字节：${key}`);
    if (this.bytes + buffer.length > trellisLimits.maxTotalBytes) throw new Error(`上下文总字节超过上限 ${trellisLimits.maxTotalBytes}：${key}`);
    if (buffer.includes(0)) throw new Error(`上下文文件疑似二进制：${key}`);
    this.bytes += buffer.length;
    this.files.set(key, { content: decode(buffer, key), sha256: hash(buffer), roles: new Set([role]) });
    return true;
  }

  async readManifest(taskSegments: string[], name: string, role: TrellisRole): Promise<void> {
    const segments = [...taskSegments, name];
    const manifest = segments.join('/');
    if (!(await this.read(segments, role, false))) return;
    for (const entry of parseManifest(this.files.get(manifest)!.content, name)) {
      const target = splitPath(entry.file, `${name}:${entry.line}`);
      if (entry.type === 'directory') { await this.readDirectory(target, `${name}:${entry.line}`, role); continue; }
      await this.read(target, role, true);
    }
  }

  /** 目录条目只展开本层、排序后的 Markdown 文档。 */
  private async readDirectory(segments: string[], label: string, role: TrellisRole): Promise<void> {
    const key = segments.join('/');
    assertReadable(key);
    const located = await locate(this.root, segments, label);
    if (!located.info.isDirectory()) throw new Error(`${label} 引用的不是目录：${key}`);
    const names = (await readdir(located.abs)).filter(name => /\.md$/i.test(name)).sort();
    if (!names.length) throw new Error(`${label} 目录内没有 Markdown 文档：${key}`);
    for (const name of names) await this.read([...segments, name], role, true);
  }

  snapshot(baseCommit: string, taskPath: string): TrellisContext {
    const files: TrellisFile[] = [...this.files.entries()]
      .map(([file, value]) => ({ path: file, content: value.content, sha256: value.sha256, roles: ROLE_ORDER.filter(role => value.roles.has(role)) }))
      .sort((left, right) => (left.path < right.path ? -1 : left.path > right.path ? 1 : 0));
    const version: 1 = 1;
    const digest = hash(JSON.stringify({ version, baseCommit, taskPath, files: files.map(file => [file.path, file.sha256, file.roles]) }));
    return { version, baseCommit, taskPath, files, sha256: digest };
  }
}

/**
 * 加载一个显式指定的 Trellis 任务上下文。
 *
 * @param worktree 仓库 worktree 根目录（绝对或相对当前进程）。
 * @param taskPath 仓库相对的任务目录，形如 .trellis/tasks/<name>（允许 archive/<yyyy-mm>/<name>）。
 * @param baseCommit 该快照对应的 40-64 位十六进制提交号。
 */
export async function loadTrellisContext(worktree: string, taskPath: string, baseCommit: string): Promise<TrellisContext> {
  if (typeof worktree !== 'string' || !worktree.trim()) throw new Error('worktree 不能为空');
  if (typeof baseCommit !== 'string' || !/^[0-9a-f]{40,64}$/i.test(baseCommit)) throw new Error(`baseCommit 必须是 40-64 位十六进制提交号：${String(baseCommit)}`);
  const taskSegments = splitPath(taskPath, 'taskPath');
  if (taskSegments.length < 3 || taskSegments[0].toLowerCase() !== '.trellis' || taskSegments[1].toLowerCase() !== 'tasks') {
    throw new Error(`taskPath 必须是仓库相对的 .trellis/tasks/<name> 任务目录：${taskPath}`);
  }
  const normalizedTaskPath = taskSegments.join('/');
  let root: string;
  try { root = await realpath(path.resolve(worktree)); }
  catch { throw new Error(`无法解析 worktree：${worktree}`); }
  if (!(await stat(root)).isDirectory()) throw new Error(`worktree 不是目录：${worktree}`);
  const taskDir = await locate(root, taskSegments, `taskPath ${normalizedTaskPath}`);
  if (!taskDir.info.isDirectory()) throw new Error(`taskPath 不是目录：${normalizedTaskPath}`);

  const collector = new Collector(root);
  const taskFile = (name: string): string[] => [...taskSegments, name];
  const read = (name: string, role: TrellisRole, required: boolean) => collector.read(taskFile(name), role, required);

  await read('task.json', SHARED, true);
  assertTaskObject(collector.files.get(taskFile('task.json').join('/'))!.content, 'task.json');
  await read('prd.md', SHARED, true);
  for (const name of OPTIONAL_TASK_FILES) await read(name, SHARED, false);
  for (const manifest of MANIFESTS) await collector.readManifest(taskSegments, manifest.name, manifest.role);

  return collector.snapshot(baseCommit.toLowerCase(), normalizedTaskPath);
}
