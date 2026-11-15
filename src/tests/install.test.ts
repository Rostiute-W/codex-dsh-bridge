import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanEnvironment, runProcess } from '../process.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const installScript = path.join(repoRoot, 'dist', 'install.js');

const fakeHelperSource = `
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

const [,, kind, ...args] = process.argv;
const logPath = process.env.TEST_CALL_LOG;
if (logPath) await appendFile(logPath, JSON.stringify({ kind, args }) + '\\n', 'utf8');

if (kind === 'dsh') {
  if (args[0] === 'plugin' && args[1] === '--profile' && args[2] === 'desktop') {
    const profilePath = path.join(process.env.DSH_HOME, 'profiles', 'desktop', 'package.json');
    await mkdir(path.dirname(profilePath), { recursive: true });
    let profile = { dependencies: {}, dsh: { profile: { bundles: [] } } };
    try { profile = JSON.parse(await readFile(profilePath, 'utf8')); } catch {}
    profile.dependencies ??= {};
    profile.dsh ??= {};
    profile.dsh.profile ??= {};
    profile.dsh.profile.bundles ??= [];
    if (args[3] === 'add') {
      const target = args[4];
      profile.dependencies['@codex-dsh/bridge'] = 'link:' + target;
      if (!profile.dsh.profile.bundles.includes('@codex-dsh/bridge')) profile.dsh.profile.bundles.push('@codex-dsh/bridge');
    } else if (args[3] === 'remove') {
      delete profile.dependencies[args[4]];
      profile.dsh.profile.bundles = profile.dsh.profile.bundles.filter(item => item !== args[4]);
    }
    await writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf8');
  }
} else if (kind === 'codex') {
  const configPath = path.join(process.env.CODEX_HOME, 'config.toml');
  await mkdir(path.dirname(configPath), { recursive: true });
  let text = '';
  try { text = await readFile(configPath, 'utf8'); } catch {}
  const section = /(^\\[mcp_servers\\.codex-dsh-bridge\\]\\r?\\n)([\\s\\S]*?)(?=^\\[|$(?![\\s\\S]))/m;
  if (args[0] === 'mcp' && args[1] === 'remove') {
    await writeFile(configPath, text.replace(section, ''), 'utf8');
  } else if (args[0] === 'mcp' && args[1] === 'add') {
    const sep = args.indexOf('--');
    const cmd = args[sep + 1];
    const cmdArgs = args.slice(sep + 2);
    const envs = [];
    for (let index = 3; index < sep; index++) {
      if (args[index] === '--env') {
        const kv = args[++index];
        const eq = kv.indexOf('=');
        envs.push(kv.slice(0, eq) + ' = ' + JSON.stringify(kv.slice(eq + 1)));
      }
    }
    const block = [
      '[mcp_servers.codex-dsh-bridge]',
      'command = ' + JSON.stringify(cmd),
      'args = ' + JSON.stringify(cmdArgs),
      'env = { ' + envs.join(', ') + ' }',
      '',
    ].join('\\n');
    await writeFile(configPath, (text ? text.trimEnd() + '\\n\\n' : '') + block, 'utf8');
  }
}
`;

async function exists(target: string): Promise<boolean> {
  try { await access(target); return true; } catch { return false; }
}

async function setupFixture(t: TestContext, options: { withCodex?: boolean } = {}) {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-install-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const homeDir = path.join(tempRoot, 'User Home');
  const localAppData = path.join(tempRoot, 'Local AppData');
  const appData = path.join(tempRoot, 'Roaming AppData');
  const dshDir = path.join(tempRoot, 'DSH App');
  const binDir = path.join(tempRoot, 'Fake Bin');
  const dshHomeDir = path.join(tempRoot, 'DSH Home');
  const codexHomeDir = path.join(homeDir, '.codex');
  await Promise.all([
    mkdir(homeDir, { recursive: true }),
    mkdir(localAppData, { recursive: true }),
    mkdir(appData, { recursive: true }),
    mkdir(dshDir, { recursive: true }),
    mkdir(binDir, { recursive: true }),
  ]);

  const helperPath = path.join(tempRoot, 'fake-helper.mjs');
  await writeFile(helperPath, fakeHelperSource, 'utf8');
  const dshCmd = path.join(dshDir, 'dsh.cmd');
  await writeFile(dshCmd, `@echo off\r\n"${process.execPath}" "${helperPath}" dsh %*\r\n`, 'utf8');
  if (options.withCodex) {
    const codexCmd = path.join(binDir, 'codex.cmd');
    await writeFile(codexCmd, `@echo off\r\n"${process.execPath}" "${helperPath}" codex %*\r\n`, 'utf8');
  }

  const callLog = path.join(tempRoot, 'calls.log');
  const system32 = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  const env = cleanEnvironment({
    USERPROFILE: homeDir,
    HOME: homeDir,
    LOCALAPPDATA: localAppData,
    APPDATA: appData,
    TEST_CALL_LOG: callLog,
    PATH: [binDir, path.dirname(process.execPath), system32].join(path.delimiter),
  });
  delete env.DSH_PATH;
  delete env.DSH_HOME;
  delete env.DSH_MODEL;
  delete env.BRIDGE_TIMEOUT_MINUTES;
  delete env.BRIDGE_STALL_MINUTES;
  delete env.CODEX_HOME;

  const runInstall = (args: string[], extraEnv: NodeJS.ProcessEnv = {}) =>
    runProcess(process.execPath, [installScript, ...args], { cwd: repoRoot, env: { ...env, ...extraEnv } });

  return { tempRoot, homeDir, localAppData, dshCmd, dshHomeDir, codexHomeDir, callLog, runInstall };
}

test('参数错误在任何安装副作用前被拒绝', async t => {
  const { homeDir, localAppData, dshCmd, callLog, runInstall } = await setupFixture(t, { withCodex: true });

  for (const badArgs of [
    ['--client', 'unknown'],
    ['--client'],
    ['--dsh'],
    ['--dsh', '--client'],
    ['--dsh', '--unknown'],
    ['--unknown'],
    ['models', '--client', 'antigravity'],
    ['--client', 'codex', '--client', 'antigravity'],
    ['--dsh', dshCmd, '--dsh', dshCmd],
  ]) {
    const res = await runInstall(badArgs);
    assert.notEqual(res.code, 0, `预期失败参数未报错: ${badArgs.join(' ')}`);
  }

  assert.equal(await exists(callLog), false);
  assert.equal(await exists(path.join(localAppData, 'CodexDshBridge')), false);
  assert.equal(await exists(path.join(homeDir, '.codex')), false);
  assert.equal(await exists(path.join(homeDir, '.gemini')), false);
  assert.equal(await exists(path.join(homeDir, '.agents')), false);
});

test('默认安装兼容 Codex：备份并保留既有配置与无关技能', async t => {
  const { homeDir, dshCmd, dshHomeDir, codexHomeDir, runInstall } = await setupFixture(t, { withCodex: true });

  await mkdir(codexHomeDir, { recursive: true });
  const codexConfig = path.join(codexHomeDir, 'config.toml');
  const initialToml = 'model = "gpt-5"\n\n[mcp_servers.other]\ncommand = "echo"\n';
  await writeFile(codexConfig, initialToml, 'utf8');

  const codexSkill = path.join(homeDir, '.agents', 'skills', 'codex-dsh-bridge', 'SKILL.md');
  const otherSkill = path.join(homeDir, '.agents', 'skills', 'other-skill', 'SKILL.md');
  await mkdir(path.dirname(codexSkill), { recursive: true });
  await mkdir(path.dirname(otherSkill), { recursive: true });
  await writeFile(codexSkill, 'old codex skill\n', 'utf8');
  await writeFile(otherSkill, 'keep codex other skill\n', 'utf8');

  const res = await runInstall(['--dsh', dshCmd], { CODEX_HOME: codexHomeDir, DSH_HOME: dshHomeDir });
  assert.equal(res.code, 0, res.output);

  const updatedToml = await readFile(codexConfig, 'utf8');
  assert.match(updatedToml, /model = "gpt-5"/);
  assert.match(updatedToml, /\[mcp_servers\.other\]/);
  assert.match(updatedToml, /\[mcp_servers\.codex-dsh-bridge\]/);
  assert.match(updatedToml, /tool_timeout_sec = 660/);
  assert.ok(updatedToml.includes(dshCmd) || updatedToml.includes(dshCmd.replace(/\\/g, '\\\\')));
  assert.ok(updatedToml.includes(dshHomeDir) || updatedToml.includes(dshHomeDir.replace(/\\/g, '\\\\')));

  const codexBackups = (await readdir(codexHomeDir)).filter(name => name.startsWith('config.toml.bak-'));
  assert.equal(codexBackups.length, 1);
  assert.equal(await readFile(path.join(codexHomeDir, codexBackups[0]), 'utf8'), initialToml);

  const skillBackups = (await readdir(path.dirname(codexSkill))).filter(name => name.startsWith('SKILL.md.bak-'));
  assert.equal(skillBackups.length, 1);
  assert.equal(await readFile(path.join(path.dirname(codexSkill), skillBackups[0]), 'utf8'), 'old codex skill\n');
  assert.equal(await readFile(otherSkill, 'utf8'), 'keep codex other skill\n');
  assert.equal(await exists(path.join(homeDir, '.gemini')), false);
});

test('Antigravity 安装不依赖 codex、安全合并保留用户字段、备份并支持幂等重复安装', async t => {
  const { homeDir, dshCmd, dshHomeDir, callLog, runInstall } = await setupFixture(t, { withCodex: false });

  const mcpConfigPath = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  await mkdir(path.dirname(mcpConfigPath), { recursive: true });
  const initialConfig = {
    customTopField: { keep: 'yes' },
    mcpServers: {
      'other-server': { command: 'python', args: ['-m', 'http.server'] },
      'codex-dsh-bridge': {
        command: 'old-node',
        args: ['C:\\old\\mcp.js'],
        type: 'http',
        url: 'https://old.invalid/mcp',
        serverUrl: 'https://old.invalid/mcp',
        headers: { Authorization: 'Bearer old' },
        disabled: true,
        timeoutSeconds: 120,
        enabledTools: ['wait_task'],
        env: {
          DSH_PATH: 'C:\\old\\dsh.cmd',
          DSH_MODEL: 'magpie/custom-model',
        },
      },
    },
  };
  const initialText = JSON.stringify(initialConfig, null, 2) + '\n';
  await writeFile(mcpConfigPath, initialText, 'utf8');

  const agySkill = path.join(homeDir, '.gemini', 'skills', 'codex-dsh-bridge', 'SKILL.md');
  const otherAgySkill = path.join(homeDir, '.gemini', 'skills', 'other-skill', 'SKILL.md');
  await mkdir(path.dirname(otherAgySkill), { recursive: true });
  await writeFile(otherAgySkill, 'keep agy other skill\n', 'utf8');

  const first = await runInstall(['--client', 'antigravity', '--dsh', dshCmd], { DSH_HOME: dshHomeDir });
  assert.equal(first.code, 0, first.output);

  const merged = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
    customTopField: { keep: string };
    mcpServers: Record<string, {
      command: string; args: string[]; disabled?: boolean;
      timeoutSeconds?: number; enabledTools?: string[]; env?: Record<string, string>;
    }>;
  };
  assert.deepEqual(merged.customTopField, { keep: 'yes' });
  assert.deepEqual(merged.mcpServers['other-server'], { command: 'python', args: ['-m', 'http.server'] });

  const bridge = merged.mcpServers['codex-dsh-bridge'] as Record<string, unknown> & {
    command: string; args: string[]; disabled?: boolean;
    timeoutSeconds?: number; enabledTools?: string[]; env?: Record<string, string>;
  };
  assert.equal(bridge.command, process.execPath);
  assert.deepEqual(bridge.args, [path.join(repoRoot, 'dist', 'mcp.js')]);
  assert.equal(bridge.disabled, false);
  assert.equal(Object.hasOwn(bridge, 'url'), false);
  assert.equal(Object.hasOwn(bridge, 'serverUrl'), false);
  assert.equal(Object.hasOwn(bridge, 'headers'), false);
  assert.equal(Object.hasOwn(bridge, 'type'), false);
  assert.equal(bridge.timeoutSeconds, 120);
  assert.deepEqual(bridge.enabledTools, ['wait_task']);
  assert.equal(bridge.env?.DSH_PATH, dshCmd);
  assert.equal(bridge.env?.DSH_HOME, dshHomeDir);
  assert.equal(bridge.env?.DSH_MODEL, 'magpie/custom-model');

  const configBackups = (await readdir(path.dirname(mcpConfigPath))).filter(name => name.startsWith('mcp_config.json.bak-'));
  assert.equal(configBackups.length, 1);
  assert.equal(await readFile(path.join(path.dirname(mcpConfigPath), configBackups[0]), 'utf8'), initialText);

  const installedSkill = await readFile(agySkill, 'utf8');
  assert.match(installedSkill, /name:\s*codex-dsh-bridge/);
  assert.match(installedSkill, /timeoutMs:\s*10000/);
  assert.equal(await readFile(otherAgySkill, 'utf8'), 'keep agy other skill\n');
  assert.equal(await exists(path.join(homeDir, '.codex')), false);
  assert.equal(await exists(path.join(homeDir, '.agents')), false);

  const callsAfterFirst = (await readFile(callLog, 'utf8')).trim().split(/\r?\n/);
  assert.equal(callsAfterFirst.length, 1);

  // 重复安装应完全幂等：跳过 DSH/MCP/Skill 写入，不生成额外备份。
  const second = await runInstall(['--client', 'antigravity', '--dsh', dshCmd], { DSH_HOME: dshHomeDir });
  assert.equal(second.code, 0, second.output);
  assert.match(second.output, /跳过/);

  const backupsAfterSecond = (await readdir(path.dirname(mcpConfigPath))).filter(name => name.startsWith('mcp_config.json.bak-'));
  assert.equal(backupsAfterSecond.length, 1);
  const callsAfterSecond = (await readFile(callLog, 'utf8')).trim().split(/\r?\n/);
  assert.equal(callsAfterSecond.length, 1);

  // 取消 DSH_HOME 再重装时应同步移除旧 env.DSH_HOME，避免与默认 DSH 插件管道不一致。
  const third = await runInstall(['--client', 'antigravity', '--dsh', dshCmd]);
  assert.equal(third.code, 0, third.output);
  const afterUnset = JSON.parse(await readFile(mcpConfigPath, 'utf8')) as {
    mcpServers: { 'codex-dsh-bridge': { env: Record<string, string> } };
  };
  assert.equal(Object.hasOwn(afterUnset.mcpServers['codex-dsh-bridge'].env, 'DSH_HOME'), false);
  assert.equal(afterUnset.mcpServers['codex-dsh-bridge'].env.DSH_PATH, dshCmd);
  assert.equal(afterUnset.mcpServers['codex-dsh-bridge'].env.DSH_MODEL, 'magpie/custom-model');
});

test('Antigravity 拒绝含 BOM、注释或非法结构的 mcp_config.json 且不覆盖原文件', async t => {
  const { homeDir, dshCmd, dshHomeDir, runInstall } = await setupFixture(t, { withCodex: false });
  const mcpConfigPath = path.join(homeDir, '.gemini', 'config', 'mcp_config.json');
  await mkdir(path.dirname(mcpConfigPath), { recursive: true });

  for (const invalidContent of [
    '// comment\n{"mcpServers": {}}\n',
    '\uFEFF{"mcpServers": {}}\n',
    '{"mcpServers": []}\n',
  ]) {
    await writeFile(mcpConfigPath, invalidContent, 'utf8');
    const res = await runInstall(['--client', 'antigravity', '--dsh', dshCmd], { DSH_HOME: dshHomeDir });
    assert.notEqual(res.code, 0);
    assert.match(res.output, /已保留原文件未修改/);
    assert.equal(await readFile(mcpConfigPath, 'utf8'), invalidContent);
    const backups = (await readdir(path.dirname(mcpConfigPath))).filter(name => name.startsWith('mcp_config.json.bak-'));
    assert.equal(backups.length, 0);
  }
});
