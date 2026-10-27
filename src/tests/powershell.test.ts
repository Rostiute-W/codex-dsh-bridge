import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { Engine } from '../engine.js';
import { Store } from '../store.js';
import { git } from '../git.js';
import type { Task } from '../model.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const previousHost = process.env.BRIDGE_JOB_HOST;
let engine: Engine;
let task: Task;
let repo: string;
const message = 'DSH 实际调用验证通过。🧪';

before(async () => {
  if (process.platform === 'win32') process.env.BRIDGE_JOB_HOST = path.join(root, 'build', 'pipe-host.exe');
  await mkdir(path.join(root, '.test-data'), { recursive: true });
  const directory = await mkdtemp(path.join(root, '.test-data', 'powershell-'));
  repo = path.join(directory, 'repo'); await mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.name', 'Bridge Test']);
  await git(repo, ['config', 'user.email', 'bridge-test@example.invalid']);
  await writeFile(path.join(repo, 'seed.txt'), 'baseline\n');
  await git(repo, ['add', '--', 'seed.txt']); await git(repo, ['commit', '-m', 'test: seed validation fixture']);
  await writeFile(path.join(repo, 'input.json'), JSON.stringify({ message }), 'utf8');
  const store = new Store(path.join(directory, 'data'));
  task = { id: randomUUID(), status: 'needs_attention', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    executor: 'acp', worktree: repo, round: 0, summary: '', checks: [], changedFiles: [], log: [],
    handoff: { requestId: randomUUID(), title: 'PowerShell 验收回归', repoPath: repo, baseCommit: await git(repo, ['rev-parse', 'HEAD']), ready: true,
      goal: 'Validate UTF-8 input through the real Engine.', plan: 'Run each check once using public revalidation, without any agent or repair loop.',
      constraints: [], allowedPaths: ['input.json'], validationCommands: ['exit 0'], acceptanceCriteria: ['exact Unicode input'], commitMessage: 'test: validate modern PowerShell' } };
  store.tasks.push(task); engine = new Engine(store);
});

after(async () => {
  await engine?.shutdown();
  if (previousHost === undefined) delete process.env.BRIDGE_JOB_HOST; else process.env.BRIDGE_JOB_HOST = previousHost;
});

async function validate(command: string) {
  task.status = 'needs_attention'; task.handoff.validationCommands = [command];
  await engine.revalidate(task.id);
}

test('real Engine reads BOM-less Chinese and emoji JSON with PowerShell 7', async () => {
  const bytes = await readFile(path.join(repo, 'input.json'));
  assert.equal(bytes[0], 0x7b, 'fixture must be UTF-8 without a BOM');
  await validate(`$value = Get-Content -Raw input.json | ConvertFrom-Json; if ($value.message -cne '${message}') { throw 'Unicode mismatch' }; if ($PSVersionTable.PSVersion.Major -lt 7) { throw 'Expected PowerShell 7' }; Write-Output $value.message`);
  assert.equal(task.status, 'awaiting_review', task.error ?? task.checks[0]?.output);
  assert.equal(task.checks[0]?.exitCode, 0);
  assert.equal(task.checks[0]?.output.trim(), message);
});

test('missing pwsh gives an actionable error without falling back to Windows PowerShell', async () => {
  const previousPath = process.env.PATH;
  try {
    process.env.PATH = (previousPath ?? '').split(path.delimiter)
      .filter(dir => !['pwsh', 'pwsh.exe', 'pwsh.cmd'].some(file => existsSync(path.join(dir.replace(/^"|"$/g, ''), file))))
      .join(path.delimiter);
    await validate('exit 0');
    assert.equal(task.status, 'needs_attention');
    assert.match(task.error ?? '', /PowerShell 7/); assert.match(task.error ?? '', /不会回退/);
    assert.equal(task.checks.length, 0);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
  }
});

test('script throw remains a failed Engine validation', async () => {
  await validate("throw 'validation-boom'");
  assert.equal(task.status, 'needs_changes', task.error);
  assert.notEqual(task.checks[0]?.exitCode, 0); assert.match(task.checks[0]?.output ?? '', /validation-boom/);
});

test('native nonzero exit code survives the Engine PowerShell wrapper', async () => {
  await validate(`& '${process.execPath.replace(/'/g, "''")}' -e 'process.exit(7)'`);
  assert.equal(task.status, 'needs_changes', task.error);
  assert.equal(task.checks[0]?.exitCode, 7);
});
