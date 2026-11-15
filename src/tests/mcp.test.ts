import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { cleanEnvironment } from '../process.js';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const mcpScript = path.join(repoRoot, 'dist', 'mcp.js');

test('MCP stdio 服务器正常完成 initialize、listTools 并处理隔离 callTool', async t => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'codex-dsh-mcp-'));
  t.after(() => rm(tempRoot, { recursive: true, force: true }));

  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(cleanEnvironment({
    USERPROFILE: tempRoot,
    HOME: tempRoot,
    LOCALAPPDATA: path.join(tempRoot, 'LocalAppData'),
    DSH_HOME: path.join(tempRoot, 'DshHome'),
    DSH_PATH: path.join(tempRoot, 'missing-dsh.cmd'),
  }))) {
    if (value !== undefined) env[key] = value;
  }

  const client = new Client({ name: 'mcp-smoke-test', version: '0.0.1' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [mcpScript],
    env,
    stderr: 'pipe',
  });

  t.after(() => client.close());
  await client.connect(transport);

  const listed = await client.listTools();
  const names = listed.tools.map(tool => tool.name).sort();
  assert.deepEqual(names, ['cancel_task', 'submit_task', 'wait_task']);

  const call = await client.callTool({
    name: 'wait_task',
    arguments: { taskId: '00000000-0000-4000-a000-000000000000', timeoutMs: 0 },
  });
  assert.equal(call.isError, true);
  assert.match(JSON.stringify(call.content), /找不到任务/);
});
