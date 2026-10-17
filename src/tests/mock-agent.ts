import { agent, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

let workspace = '';
let cancelled = false;
const mode = process.env.MOCK_MODE ?? 'success';
const app = agent({ name: 'mock-dsh' })
  .onRequest('initialize', () => ({ protocolVersion: PROTOCOL_VERSION, agentInfo: { name: 'mock-dsh', version: '1.0.0' }, agentCapabilities: { sessionCapabilities: { resume: {}, close: {}, list: {} } } }))
  .onRequest('authenticate', () => ({}))
  .onRequest('session/new', ({ params }) => { workspace = params.cwd; return { sessionId: 'mock-session', configOptions: [{ id: 'model', category: 'model', name: 'Model', type: 'select', currentValue: 'mock', options: [{ value: 'mock', name: 'Mock' }] }] }; })
  .onRequest('session/resume', ({ params }) => { workspace = params.cwd; return {}; })
  .onRequest('session/close', () => ({}))
  .onRequest('session/set_config_option', () => ({ configOptions: [] }))
  .onNotification('session/cancel', () => { cancelled = true; })
  .onRequest('session/prompt', async ({ params, client }) => {
    const countFile = path.join(path.dirname(workspace), 'mock-count.txt');
    let count = 0; try { count = Number(await readFile(countFile, 'utf8')); } catch { /* first prompt */ }
    count++; await writeFile(countFile, String(count));
    if (mode === 'permission') {
      const result = await client.request('session/request_permission', { sessionId: params.sessionId,
        toolCall: { toolCallId: 'permission-tool', title: 'Mock narrow permission', kind: 'execute', rawInput: { command: 'test command' } },
        options: [{ optionId: 'yes', name: 'Allow once', kind: 'allow_once' }, { optionId: 'forever', name: 'Allow always', kind: 'allow_always' }, { optionId: 'no', name: 'Reject', kind: 'reject_once' }],
      });
      if (result.outcome.outcome === 'cancelled' || result.outcome.optionId !== 'yes') return { stopReason: 'cancelled' as const };
    }
    if (mode === 'slow') {
      for (let i = 0; i < 300 && !cancelled; i++) await new Promise(resolve => setTimeout(resolve, 100));
      if (cancelled) return { stopReason: 'cancelled' as const };
    }
    if (mode === 'crash') process.exit(7);
    await writeFile(path.join(workspace, 'value.txt'), mode === 'repair' && count === 1 ? 'broken\n' : 'after\n');
    if (mode === 'scope') await writeFile(path.join(workspace, 'outside.txt'), 'unplanned');
    if (mode === 'new-file') await writeFile(path.join(workspace, 'added.txt'), 'new implementation\n');
    await client.notify('session/update', { sessionId: params.sessionId, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: `Mock implementation ${count} completed.` } } });
    return { stopReason: mode === 'max-tokens' ? 'max_tokens' as const : 'end_turn' as const };
  });
app.connect(ndJsonStream(Writable.toWeb(process.stdout), Readable.toWeb(process.stdin) as ReadableStream<Uint8Array>));
