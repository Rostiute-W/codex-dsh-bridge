import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from '../store.js';
import { defaultSettings, settingsSchema } from '../model.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
async function dataRoot(): Promise<string> {
  await mkdir(path.join(project, '.test-data'), { recursive: true });
  return mkdtemp(path.join(project, '.test-data', 'settings-'));
}
async function writeLegacy(root: string, timeoutMinutes: number): Promise<void> {
  const legacy: Record<string, unknown> = { ...defaultSettings };
  delete legacy.timeoutDefaultVersion;
  await mkdir(root, { recursive: true });
  await writeFile(path.join(root, 'settings.json'), JSON.stringify({ ...legacy, timeoutMinutes }, null, 2));
}
const backups = (root: string) => readdir(path.join(root, 'backups')).catch(() => [] as string[]);

test('new installation defaults to 300 minutes and validates the new ceiling', async () => {
  assert.equal(defaultSettings.timeoutMinutes, 300);
  const store = new Store(await dataRoot()); await store.load();
  assert.equal(store.settings.timeoutMinutes, 300);
  assert.equal(store.settings.timeoutDefaultVersion, 1);
  assert.equal(settingsSchema.parse({ ...defaultSettings, timeoutMinutes: 300 }).timeoutMinutes, 300);
  assert.throws(() => settingsSchema.parse({ ...defaultSettings, timeoutMinutes: 301 }));
});

test('legacy 30 is backed up once and upgraded, while a custom value is kept', async () => {
  const root = await dataRoot();
  await writeLegacy(root, 30);
  const store = new Store(root); await store.load();
  assert.equal(store.settings.timeoutMinutes, 300);
  const saved = JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8'));
  assert.equal(saved.timeoutMinutes, 300); assert.equal(saved.timeoutDefaultVersion, 1);
  const first = await backups(root);
  assert.equal(first.length, 1);
  // The backup must still be the untouched pre-migration settings.
  assert.equal(JSON.parse(await readFile(path.join(root, 'backups', first[0]!), 'utf8')).timeoutMinutes, 30);

  const reloaded = new Store(root); await reloaded.load();
  assert.equal(reloaded.settings.timeoutMinutes, 300);
  assert.equal((await backups(root)).length, 1, '第二次加载不应再写备份。');

  const custom = await dataRoot();
  await writeLegacy(custom, 90);
  const kept = new Store(custom); await kept.load();
  assert.equal(kept.settings.timeoutMinutes, 90);
  assert.equal((await backups(custom)).length, 1);
});

test('a failed migration backup is not reported as a corrupt settings file', async () => {
  const root = await dataRoot();
  await writeLegacy(root, 30);
  // A file where the backup directory belongs makes the backup step fail.
  await writeFile(path.join(root, 'backups'), 'occupied');
  await assert.rejects(new Store(root).load(), /迁移失败/);
  assert.equal(JSON.parse(await readFile(path.join(root, 'settings.json'), 'utf8')).timeoutMinutes, 30);
});

test('a manual 30 saved after migration survives a restart', async () => {
  const root = await dataRoot();
  await writeLegacy(root, 30);
  const store = new Store(root); await store.load();
  await store.saveSettings({ ...store.settings, timeoutMinutes: 30 });
  const reloaded = new Store(root); await reloaded.load();
  assert.equal(reloaded.settings.timeoutMinutes, 30);
  assert.equal((await backups(root)).length, 1);
});
