import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadTrellisContext, trellisLimits } from '../trellis.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const baseCommit = 'a'.repeat(40);
const taskPath = '.trellis/tasks/10-17-demo';

async function worktree(): Promise<string> {
  await mkdir(path.join(project, '.test-data'), { recursive: true });
  const root = await mkdtemp(path.join(project, '.test-data', 'trellis-'));
  await mkdir(path.join(root, taskPath), { recursive: true });
  return root;
}

async function put(root: string, file: string, content: string): Promise<void> {
  const target = path.join(root, file);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, content);
}

function task(root: string): string { return path.join(root, taskPath); }

/** 最小可用任务：task.json + prd.md。 */
async function minimal(root: string): Promise<void> {
  await put(root, `${taskPath}/task.json`, JSON.stringify({ name: 'demo', status: 'in_progress' }));
  await put(root, `${taskPath}/prd.md`, '# PRD\n需求正文\n');
}

test('加载必需与可选任务资料，并给出确定摘要', async () => {
  const root = await worktree();
  await minimal(root);
  await put(root, `${taskPath}/design.md`, '# 设计\n');
  await put(root, `${taskPath}/implement.md`, '- [ ] 实施\n');

  const context = await loadTrellisContext(root, taskPath, baseCommit);
  assert.equal(context.version, 1);
  assert.equal(context.baseCommit, baseCommit);
  assert.equal(context.taskPath, taskPath);
  assert.deepEqual(context.files.map(file => file.path), [
    `${taskPath}/design.md`, `${taskPath}/implement.md`, `${taskPath}/prd.md`, `${taskPath}/task.json`,
  ]);
  assert.deepEqual(context.files.map(file => file.roles), [['shared'], ['shared'], ['shared'], ['shared']]);
  for (const file of context.files) assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.match(context.sha256, /^[a-f0-9]{64}$/);

  const again = await loadTrellisContext(root, taskPath, baseCommit);
  assert.deepEqual(again, context);
  assert.equal((await loadTrellisContext(root, taskPath, baseCommit.toUpperCase())).sha256, context.sha256);
});

test('缺少 prd.md 或 task.json 时明确失败，可选文件缺省时正常加载', async () => {
  const root = await worktree();
  await minimal(root);
  assert.deepEqual((await loadTrellisContext(root, taskPath, baseCommit)).files.map(file => path.basename(file.path)), ['prd.md', 'task.json']);

  const noPrd = await worktree();
  await put(noPrd, `${taskPath}/task.json`, '{"name": "demo"}\n');
  await assert.rejects(loadTrellisContext(noPrd, taskPath, baseCommit), /prd\.md/);

  const noTask = await worktree();
  await put(noTask, `${taskPath}/prd.md`, '# PRD\n');
  await assert.rejects(loadTrellisContext(noTask, taskPath, baseCommit), /task\.json/);
});

test('task.json 必须是合法 JSON 对象', async () => {
  const root = await worktree();
  await minimal(root);
  await put(root, `${taskPath}/task.json`, '{"name": "demo"');
  await assert.rejects(loadTrellisContext(root, taskPath, baseCommit), /不是合法 JSON/);
  await put(root, `${taskPath}/task.json`, '["demo"]');
  await assert.rejects(loadTrellisContext(root, taskPath, baseCommit), /必须是 JSON 对象/);
});

test('清单引用合并角色、跨清单去重且忽略 _example 占位行', async () => {
  const root = await worktree();
  await minimal(root);
  await put(root, '.trellis/spec/shared.md', '# 规范\n');
  await put(root, '.trellis/spec/impl.md', '# 实施规范\n');
  await put(root, `${taskPath}/research/note.md`, '# 研究\n');
  await put(root, `${taskPath}/implement.jsonl`, [
    '{"_example": "用真实条目替换我"}',
    '{"file": ".trellis/spec/shared.md", "reason": "共用规范"}',
    '{"file": ".trellis/spec/shared.md", "reason": "重复条目"}',
    '{"file": ".trellis/spec/impl.md", "reason": "实施规范"}',
    '{"file": ".trellis/tasks/10-17-demo/research/note.md", "reason": "研究资料"}',
    '',
  ].join('\n'));
  await put(root, `${taskPath}/check.jsonl`, '{"file": ".trellis/spec/shared.md", "reason": "复核也读"}\n');

  const context = await loadTrellisContext(root, taskPath, baseCommit);
  const byPath = new Map(context.files.map(file => [file.path, file]));
  assert.deepEqual(byPath.get('.trellis/spec/shared.md')!.roles, ['implementation', 'review']);
  assert.deepEqual(byPath.get('.trellis/spec/impl.md')!.roles, ['implementation']);
  assert.deepEqual(byPath.get(`${taskPath}/research/note.md`)!.roles, ['implementation']);
  assert.equal(context.files.filter(file => file.path === '.trellis/spec/shared.md').length, 1);
  // task.json、prd.md、两个清单与三个被引用文档。
  assert.deepEqual(context.files.map(file => file.path), [
    '.trellis/spec/impl.md',
    '.trellis/spec/shared.md',
    `${taskPath}/check.jsonl`,
    `${taskPath}/implement.jsonl`,
    `${taskPath}/prd.md`,
    `${taskPath}/research/note.md`,
    `${taskPath}/task.json`,
  ]);

  const reordered = await worktree();
  await minimal(reordered);
  await put(reordered, '.trellis/spec/shared.md', '# 规范\n');
  await put(reordered, '.trellis/spec/impl.md', '# 实施规范\n');
  await put(reordered, `${taskPath}/research/note.md`, '# 研究\n');
  await put(reordered, `${taskPath}/implement.jsonl`, ['{"file": ".trellis/spec/impl.md", "reason": "实施规范"}',
    '{"file": ".trellis/spec/shared.md", "reason": "共用规范"}',
    '{"file": ".trellis/tasks/10-17-demo/research/note.md", "reason": "研究资料"}'].join('\n'));
  await put(reordered, `${taskPath}/check.jsonl`, '{"file": ".trellis/spec/shared.md", "reason": "复核也读"}\n');
  // 清单行序不同：清单文件自身的字节不同，但被引用文档的集合、角色与内容必须一致。
  const reorderedContext = await loadTrellisContext(reordered, taskPath, baseCommit);
  const referenced = (value: typeof context) => value.files
    .filter(file => !/\.jsonl$/.test(file.path))
    .map(file => [file.path, file.sha256, file.roles]);
  assert.deepEqual(referenced(reorderedContext), referenced(context));

  const changed = await worktree();
  await minimal(changed);
  await put(changed, '.trellis/spec/shared.md', '# 规范\n');
  await put(changed, `${taskPath}/implement.jsonl`, '{"file": ".trellis/spec/shared.md", "reason": "共用规范"}\n');
  assert.notEqual((await loadTrellisContext(changed, taskPath, baseCommit)).sha256, context.sha256);
});

test('目录条目只展开排序后的 Markdown 文档', async () => {
  const root = await worktree();
  await minimal(root);
  await put(root, '.trellis/spec/b.md', '# B\n');
  await put(root, '.trellis/spec/a.md', '# A\n');
  await put(root, '.trellis/spec/raw.txt', '忽略');
  await put(root, '.trellis/spec/nested/c.md', '# C\n');
  await put(root, `${taskPath}/implement.jsonl`, '{"file": ".trellis/spec/", "type": "directory", "reason": "整个规范目录"}\n');

  const context = await loadTrellisContext(root, taskPath, baseCommit);
  const spec = context.files.filter(file => file.path.startsWith('.trellis/spec/')).map(file => file.path);
  assert.deepEqual(spec, ['.trellis/spec/a.md', '.trellis/spec/b.md']);

  await put(root, `${taskPath}/check.jsonl`, '{"file": ".trellis/spec", "type": "directory", "reason": "复核也读"}\n');
  const shared = await loadTrellisContext(root, taskPath, baseCommit);
  assert.deepEqual(shared.files.filter(file => file.path.startsWith('.trellis/spec/')).map(file => file.roles), [['implementation', 'review'], ['implementation', 'review']]);
});

test('畸形清单、未知条目类型与缺失引用一律报错', async () => {
  const cases: [string, RegExp][] = [
    ['{"file": ".trellis/spec/x.md", "reason": "x"}\n{"file": ', /implement\.jsonl:2 不是合法 JSON/],
    ['[]\n', /implement\.jsonl:1 必须是 JSON 对象/],
    ['{"reason": "没有路径"}\n', /缺少字符串 file 路径/],
    ['{"file": 7, "reason": "非字符串"}\n', /缺少字符串 file 路径/],
    ['{"file": ".trellis/spec/x.md", "type": "glob", "reason": "未知类型"}\n', /未知条目类型/],
    ['{"file": ".trellis/spec/absent.md", "reason": "缺失"}\n', /不存在：\.trellis\/spec\/absent\.md/],
    ['{"file": ".trellis/spec/empty/", "type": "directory", "reason": "空目录"}\n', /没有 Markdown 文档/],
  ];
  for (const [line, pattern] of cases) {
    const root = await worktree();
    await minimal(root);
    await put(root, '.trellis/spec/x.md', '# X\n');
    await mkdir(path.join(root, '.trellis/spec/empty'), { recursive: true });
    await put(root, `${taskPath}/implement.jsonl`, line);
    await assert.rejects(loadTrellisContext(root, taskPath, baseCommit), pattern);
  }
});

test('taskPath 与清单路径都不能越出 worktree', async () => {
  const root = await worktree();
  await minimal(root);
  await put(root, 'secret.md', '# 仓库外不存在的邻居\n');
  await mkdir(path.join(root, '.git'), { recursive: true });
  await put(root, '.git/config', '[core]\n');
  const cases: [string, string, RegExp][] = [
    ['taskPath 绝对路径', 'C:/tmp/10-17-demo', /taskPath 必须是 worktree 相对路径|taskPath 必须是仓库相对/],
    ['taskPath 上级路径', '.trellis/tasks/../../etc', /含无效路径段/],
    ['taskPath 非任务目录', '.trellis/spec', /taskPath 必须是仓库相对的/],
    ['清单绝对路径', '{"file": "C:/Windows/win.ini"}\n', /必须是 worktree 相对路径/],
    ['清单上级路径', '{"file": ".trellis/tasks/../../secret.md"}\n', /含无效路径段/],
    ['清单 .git', '{"file": ".git/config"}\n', /不能指向 \.git/],
    ['清单数据流', '{"file": ".trellis/spec/x.md:stream", "reason": "ADS"}\n', /含盘符或 Windows 数据流/],
  ];
  for (const [name, value, pattern] of cases) {
    if (name.startsWith('taskPath')) {
      await assert.rejects(loadTrellisContext(root, value, baseCommit), pattern, name);
      continue;
    }
    const caseRoot = await worktree();
    await minimal(caseRoot);
    await put(caseRoot, `${taskPath}/implement.jsonl`, value);
    await assert.rejects(loadTrellisContext(caseRoot, taskPath, baseCommit), pattern, name);
  }

  await assert.rejects(loadTrellisContext(root, taskPath, 'not-a-commit'), /baseCommit/);
});

test('符号链接指向 worktree 之外时拒绝读取', async () => {
  const root = await worktree();
  await minimal(root);
  const outside = await mkdtemp(path.join(project, '.test-data', 'outside-'));
  await writeFile(path.join(outside, 'leak.md'), '# 外部文件\n');
  const link = path.join(root, '.trellis/spec/link.md');
  await mkdir(path.dirname(link), { recursive: true });
  try {
    await symlink(path.join(outside, 'leak.md'), link, 'file');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EPERM') return; // Windows 未开开发者模式时无法创建链接
    throw error;
  }
  await put(root, `${taskPath}/implement.jsonl`, '{"file": ".trellis/spec/link.md", "reason": "链接"}\n');
  await assert.rejects(loadTrellisContext(root, taskPath, baseCommit), /符号链接或目录联接/);
});

test('凭据文件与运行时状态不会被读取', async () => {
  const cases: [string, RegExp][] = [
    ['.trellis/spec/.env.local', /凭据文件/],
    ['.trellis/spec/server.pem', /凭据文件/],
    ['.trellis/.runtime/session.json', /运行时状态/],
  ];
  for (const [file, pattern] of cases) {
    const root = await worktree();
    await minimal(root);
    await put(root, file, 'secret');
    await put(root, `${taskPath}/implement.jsonl`, `{"file": "${file}", "reason": "不该读"}\n`);
    await assert.rejects(loadTrellisContext(root, taskPath, baseCommit), pattern, file);
  }
});

test('超过单文件与总字节上限时报错而不是截断', async () => {
  const single = await worktree();
  await minimal(single);
  await put(single, '.trellis/spec/big.md', 'x'.repeat(trellisLimits.maxFileBytes + 1));
  await put(single, `${taskPath}/implement.jsonl`, '{"file": ".trellis/spec/big.md", "reason": "过大"}\n');
  await assert.rejects(loadTrellisContext(single, taskPath, baseCommit), /单文件上限/);

  // 单文件都在限内、累计超限：三个文件各 3/4 单文件上限，合计约 1.1 倍总上限。
  const chunk = Math.floor(trellisLimits.maxFileBytes * 0.75);
  assert.ok(chunk * 3 > trellisLimits.maxTotalBytes, '三个分块必须超过总字节上限');
  const total = await worktree();
  await minimal(total);
  const lines: string[] = [];
  for (const name of ['a', 'b', 'c']) {
    await put(total, `.trellis/spec/${name}.md`, name.repeat(chunk));
    lines.push(JSON.stringify({ file: `.trellis/spec/${name}.md`, reason: '大块' }));
  }
  await put(total, `${taskPath}/implement.jsonl`, lines.join('\n'));
  await assert.rejects(loadTrellisContext(total, taskPath, baseCommit), /总字节超过上限/);

  const files = await worktree();
  await minimal(files);
  const many: string[] = [];
  for (let index = 0; index <= trellisLimits.maxFiles; index += 1) {
    const file = `.trellis/spec/doc-${String(index).padStart(2, '0')}.md`;
    await put(files, file, '# doc\n');
    many.push(JSON.stringify({ file, reason: '文件数上限' }));
  }
  await put(files, `${taskPath}/implement.jsonl`, many.join('\n'));
  await assert.rejects(loadTrellisContext(files, taskPath, baseCommit), /文件数超过上限/);
});
