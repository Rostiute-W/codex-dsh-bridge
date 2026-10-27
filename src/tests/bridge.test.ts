import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { Store } from '../store.js';
import { Engine } from '../engine.js';
import { git } from '../git.js';
import { runAcp, type AgentRun } from '../acp.js';
import { runProcess, cleanEnvironment, resolveCodexExecutable } from '../process.js';
import { servePipe, identity, pipeName, pipePath, pipeRequest } from '../rpc.js';
import { type Handoff, type Task } from '../model.js';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const project = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const helper = path.join(project, 'build', 'pipe-host.exe');
if (process.platform === 'win32') process.env.BRIDGE_JOB_HOST = helper;
const mock = path.join(path.dirname(fileURLToPath(import.meta.url)), 'mock-agent.js');
const engines = new Set<Engine>();
afterEach(async () => { for (const engine of engines) await engine.shutdown(); engines.clear(); });
async function fixture(mode = 'success') {
  await mkdir(path.join(project, '.test-data'), { recursive: true });
  const directory = await mkdtemp(path.join(project, '.test-data', 'case-'));
  const repo = path.join(directory, 'repo'); await mkdir(repo);
  await git(repo, ['init']); await git(repo, ['config', 'user.name', 'Bridge Test']); await git(repo, ['config', 'user.email', 'bridge-test@example.invalid']);
  await writeFile(path.join(repo, 'value.txt'), 'before\n'); await writeFile(path.join(repo, '.gitignore'), 'generated/\n');
  await git(repo, ['add', '--', 'value.txt', '.gitignore']); await git(repo, ['commit', '-m', 'test: baseline']);
  const store = new Store(path.join(directory, 'data')); await store.load();
  store.settings.executionMode='acp';
  const execute: AgentRun = (task, settings, instruction, hooks, signal) => runAcp(process.execPath, [mock], cleanEnvironment({ MOCK_MODE: mode }), task, '', instruction, hooks, signal);
  const engine = new Engine(store, execute);
  engines.add(engine);
  const handoff: Handoff = { requestId: randomUUID(), title: 'Mock coding task', repoPath: repo, baseCommit: await git(repo, ['rev-parse', 'HEAD']), ready: true,
    goal: 'Change value to after and verify it.', plan: 'Edit value.txt with the expected content and retain all other files.', constraints: ['No unrelated changes'],
    allowedPaths: ['value.txt'], validationCommands: ["if ((Get-Content -Raw value.txt).Trim() -ne 'after') { throw 'expected after' }"], acceptanceCriteria: ['value.txt equals after'], commitMessage: 'fix: update task value' };
  return { directory, repo, store, engine, handoff };
}
async function waitFor(engine: Engine, task: Task, expected: string): Promise<void> {
  const end = Date.now() + 25000;
  while (Date.now() < end) {
    if (task.status === expected && (expected !== 'awaiting_review' || !engine.isActive())) return;
    if (['needs_attention','failed'].includes(task.status) && expected !== task.status) throw new Error(`${task.status}: ${task.error}`);
    await engine.wait(task.id, 100);
    if (task.status === 'awaiting_review') await new Promise(resolve => setTimeout(resolve, 25));
    if (task.status === 'awaiting_permission') await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error(`Expected ${expected}, received ${task.status}: ${task.error}`);
}

test('ACP execution → independent checks → exact review → one local commit', async () => {
  const f = await fixture();
  const task = await f.engine.submit({ operation: 'execute', handoff: f.handoff });
  const retry = await f.engine.submit({ operation: 'execute', handoff: f.handoff }); assert.equal(retry.id, task.id);
  await waitFor(f.engine, task, 'awaiting_review');
  assert.equal(task.sessionId, 'mock-session'); assert.equal(task.checks[0].exitCode, 0); assert.deepEqual(task.changedFiles, ['value.txt']);
  assert.equal(await readFile(path.join(f.repo, 'value.txt'), 'utf8'), 'before\n');
  await f.engine.submit({ operation: 'review', taskId: task.id, fingerprint: task.fingerprint, review: { verdict: 'approved', summary: 'Verified implementation and check.', issues: [] } });
  assert.equal(task.status, 'completed', task.error); assert.match(task.commit!, /^[a-f0-9]{40}$/);
  assert.equal(task.commitStatus, ''); assert.equal(await git(f.repo, ['status', '--short']), '');
  assert.equal(await git(task.worktree!, ['log', '-1', '--format=%s']), f.handoff.commitMessage);
  const reloaded = new Store(f.store.root); await reloaded.load(); assert.equal(reloaded.tasks[0].commit, task.commit);
  await f.engine.shutdown();
});

test('user changes block preparation and are never staged or overwritten', async () => {
  const f = await fixture(); await writeFile(path.join(f.repo, 'value.txt'), 'user work\n');
  const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'needs_attention');
  assert.match(task.error!, /未提交修改/); assert.equal(await readFile(path.join(f.repo,'value.txt'),'utf8'),'user work\n');
  assert.equal(await git(f.repo,['diff','--cached']), ''); assert.equal(await git(f.repo,['rev-parse','HEAD']), f.handoff.baseCommit);
  await f.engine.shutdown();
});

test('broken validation is repaired in the resumed ACP session', async () => {
  const f = await fixture('repair'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff});
  await waitFor(f.engine,task,'awaiting_review'); assert.equal(task.round,1); assert.equal(task.checks[0].exitCode,0);
  assert.equal(await readFile(path.join(path.dirname(task.worktree!),'mock-count.txt'),'utf8'),'2'); await f.engine.shutdown();
});

test('review feedback is sent to DSH and then requires a new review', async () => {
  const f = await fixture(); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'awaiting_review');
  await f.engine.submit({operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'changes_requested',summary:'Clarify implementation.',issues:['Recheck the expected content.']}});
  assert.equal(task.status,'needs_changes'); assert.equal(task.commit,undefined);
  await f.engine.submit({operation:'revise',taskId:task.id}); await waitFor(f.engine,task,'awaiting_review'); assert.equal(task.round,1); await f.engine.shutdown();
});

test('modified code invalidates an otherwise approved fingerprint', async () => {
  const f = await fixture(); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'awaiting_review');
  await writeFile(path.join(task.worktree!,'value.txt'),'changed after review\n');
  await assert.rejects(f.engine.submit({operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'approved',summary:'approve',issues:[]}}),/不一致/);
  assert.equal(task.commit,undefined); assert.equal(await git(task.worktree!,['rev-parse','HEAD']),f.handoff.baseCommit); await f.engine.shutdown();
});

test('out-of-scope changes stop before review or commit', async () => {
  const f = await fixture('scope'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'needs_attention');
  assert.match(task.error!,/超出方案范围/); assert.equal(task.commit,undefined); await f.engine.shutdown();
});

test('permissions are explicit, one-time, and cancellation settles pending requests', async () => {
  const f = await fixture('permission'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'awaiting_permission');
  assert.ok(task.permission); assert.ok(task.permission.options.every(o => o.kind !== 'allow_always'));
  await f.engine.answerPermission(task.id,task.permission.id,'yes'); await waitFor(f.engine,task,'awaiting_review'); await f.engine.shutdown();
  const g = await fixture('permission'); const cancelled = await g.engine.submit({operation:'execute',handoff:g.handoff}); await waitFor(g.engine,cancelled,'awaiting_permission');
  await g.engine.cancel(cancelled.id); await waitFor(g.engine,cancelled,'cancelled'); assert.equal(cancelled.permission,undefined); await g.engine.shutdown();
});

test('process crash preserves files and restart does not replay a prompt', async () => {
  const f = await fixture('crash'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'needs_attention'); assert.match(task.error!,/退出|关闭|closed/i);
  const countFile = path.join(path.dirname(task.worktree!),'mock-count.txt'); const before = await readFile(countFile,'utf8');
  await f.engine.shutdown(); const loaded = new Store(f.store.root); await loaded.load(); const recovered = new Engine(loaded); await recovered.recover();
  assert.equal(loaded.tasks[0].status,'needs_attention'); assert.equal(await readFile(countFile,'utf8'),before); await recovered.shutdown();
});

test('max-token stop is never treated as task success', async () => {
  const f = await fixture('max-tokens'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'needs_attention');
  assert.match(task.error!,/max_tokens/); assert.equal(task.commit,undefined); await f.engine.shutdown();
});

test('request IDs cannot be reused for different handoffs; incomplete plans are rejected', async () => {
  const f = await fixture('slow'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff});
  await assert.rejects(f.engine.submit({operation:'execute',handoff:{...f.handoff,title:'Different'}}),/不同/);
  await assert.rejects(f.engine.submit({operation:'execute',handoff:{...f.handoff,ready:false}}));
  await f.engine.cancel(task.id); await f.engine.shutdown();
});

test('queued tasks are cancelled on shutdown without starting another agent', async () => {
  const f = await fixture('slow'); const task = await f.engine.submit({operation:'execute',handoff:f.handoff});
  const next = await f.engine.submit({operation:'execute',handoff:{...f.handoff,requestId:randomUUID()}});
  await f.engine.shutdown(); assert.equal(task.status,'cancelled'); assert.equal(next.status,'cancelled'); assert.equal(next.sessionId,undefined);
});

test('Windows job runner handles quoted arguments and timeouts', {skip:process.platform !== 'win32'}, async () => {
  const result = await runProcess(process.execPath,['-e','process.stdout.write(process.argv[1])','text with spaces " quotes'],{env:cleanEnvironment()});
  assert.equal(result.code,0,result.output); assert.equal(result.output,'text with spaces " quotes');
  const unicode = await runProcess(process.execPath,['-e',"const b=Buffer.from('中文');process.stdout.write(b.subarray(0,1));setTimeout(()=>process.stdout.write(b.subarray(1)),30)"],{env:cleanEnvironment()});
  assert.equal(unicode.stdout,'中文');
  const timeout = await runProcess(process.execPath,['-e','setTimeout(()=>{},30000)'],{env:cleanEnvironment(),timeoutMs:200}); assert.notEqual(timeout.code,0);
});

test('Windows native Codex discovery handles extensionless npm shims and saved wrapper paths', {skip:process.platform !== 'win32'}, async () => {
  await mkdir(path.join(project,'.test-data'),{recursive:true});
  const folder=await mkdtemp(path.join(project,'.test-data','codex-path-'));
  const shim=path.join(folder,'codex'); await writeFile(shim,'#!/bin/sh\n');
  const exe=path.join(folder,'node_modules','@openai','codex','node_modules','@openai','codex-win32-x64','vendor','x86_64-pc-windows-msvc','bin','codex.exe');
  await mkdir(path.dirname(exe),{recursive:true}); await writeFile(exe,'native path fixture, never executed');
  assert.equal(await resolveCodexExecutable(shim),exe);
  const batch=shim+'.cmd'; await writeFile(batch,'@echo off');
  assert.equal(await resolveCodexExecutable(batch),exe);
  assert.equal(await resolveCodexExecutable(exe),exe);
});

test('ACL named pipe serves isolated RPC, rejects paid methods, and survives client disconnect', {skip:process.platform !== 'win32'}, async () => {
  const f = await fixture(); const previous = process.env.BRIDGE_INSTANCE; process.env.BRIDGE_INSTANCE = randomUUID();
  const stop = await servePipe(helper,f.engine,()=>{});
  try {
    assert.deepEqual(await pipeRequest(helper,'ping',{}),{name:'Codex DSH Bridge',version:JSON.parse(await readFile(path.join(project,'package.json'),'utf8')).version});
    await assert.rejects(pipeRequest(helper,'paidReview',{}));
    const result = await pipeRequest(helper,'submit',{operation:'execute',handoff:f.handoff}) as {taskId:string};
    const client = net.connect(pipePath(pipeName(await identity(helper)))); await new Promise<void>(resolve=>client.once('connect',resolve)); client.end();
    const task=f.engine.task(result.taskId); await waitFor(f.engine,task,'awaiting_review'); assert.equal(task.checks[0].exitCode,0);
  } finally { stop(); process.env.BRIDGE_INSTANCE=previous ?? ''; await f.engine.shutdown(); }
});

test('concurrent review approvals produce exactly one commit', async () => {
  const f = await fixture(); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'awaiting_review');
  const request = {operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'approved',summary:'Checked actual implementation.',issues:[]}};
  const results = await Promise.allSettled([f.engine.submit(request),f.engine.submit(request)]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length,1);
  assert.equal(task.status,'completed',task.error);
  assert.equal(await git(task.worktree!,['rev-list','--count',`${f.handoff.baseCommit}..HEAD`]),'1');
});

test('new files have reviewable diffs and retain their fingerprint while staging', async () => {
  const f=await fixture('new-file'); f.handoff.allowedPaths.push('added.txt');
  const task=await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'awaiting_review');
  assert.deepEqual(task.changedFiles,['added.txt','value.txt']);
  assert.match(await readFile(task.diffPath!,'utf8'),/new implementation/);
  await f.engine.submit({operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'approved',summary:'Reviewed tracked and new files.',issues:[]}});
  assert.equal(task.status,'completed',task.error);
  assert.equal(await git(task.worktree!,['show','HEAD:added.txt']),'new implementation');
});

test('a Git hook changing reviewed content preserves commit hash and requires attention', async () => {
  const f = await fixture(); const task = await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'awaiting_review');
  const hooks = path.join(f.directory,'hooks'); await mkdir(hooks);
  await writeFile(path.join(hooks,'pre-commit'), '#!/bin/sh\nprintf "hook changed\\n" > value.txt\ngit add -- value.txt\n');
  await git(task.worktree!,['config','core.hooksPath',hooks.replace(/\\/g,'/')]);
  await f.engine.submit({operation:'review',taskId:task.id,fingerprint:task.fingerprint,review:{verdict:'approved',summary:'Review before hook mutation.',issues:[]}});
  assert.equal(task.status,'needs_attention'); assert.match(task.error!,/hook/); assert.ok(task.commit);
});

test('official MCP client lists four tools and submits/reads task through Windows pipe', {skip:process.platform !== 'win32'}, async () => {
  const f=await fixture(); const previous=process.env.BRIDGE_INSTANCE; process.env.BRIDGE_INSTANCE=randomUUID();
  const stop=await servePipe(helper,f.engine,()=>{});
  const transport=new StdioClientTransport({command:process.execPath,args:[path.join(project,'dist','mcp.js')],env:cleanEnvironment({BRIDGE_PIPE_HOST:helper}) as Record<string,string>});
  const client=new Client({name:'bridge-integration-test',version:'1.0.0'});
  try {
    await client.connect(transport);
    assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['cancel_task','get_task_result','submit_task','wait_task']);
    const response=await client.callTool({name:'submit_task',arguments:{operation:'execute',handoff:f.handoff}});
    const content=response.content as {type:string;text:string}[]; assert.equal(response.isError,undefined);
    const submitted=JSON.parse(content[0].text); await waitFor(f.engine,f.engine.task(submitted.taskId),'awaiting_review');
    const result=await client.callTool({name:'get_task_result',arguments:{taskId:submitted.taskId}});
    assert.equal(JSON.parse((result.content as {text:string}[])[0].text).status,'awaiting_review');
  } finally { await client.close(); stop(); process.env.BRIDGE_INSTANCE=previous ?? ''; }
});

test('task deadline preserves worktree without a completion commit', async () => {
  const f=await fixture('slow');
  // Shorten the engine clock in this fixture only; production settings require whole minutes.
  f.store.settings.timeoutMinutes=0.001;
  const task=await f.engine.submit({operation:'execute',handoff:f.handoff}); await waitFor(f.engine,task,'needs_attention');
  assert.match(task.error!,/运行时限/); assert.equal(task.commit,undefined);
  assert.equal(await git(task.worktree!,['rev-parse','HEAD']),f.handoff.baseCommit);
});

test('packaged Electron executable runs MCP from app.asar using its bundled pipe helper', {skip:!process.env.BRIDGE_PACKAGED_EXECUTABLE}, async () => {
  const executable=process.env.BRIDGE_PACKAGED_EXECUTABLE!;
  const packagedHelper=path.join(path.dirname(executable),'resources','pipe-host.exe');
  const f=await fixture(); const previous=process.env.BRIDGE_INSTANCE; process.env.BRIDGE_INSTANCE=randomUUID();
  const stop=await servePipe(packagedHelper,f.engine,()=>{});
  const client=new Client({name:'packaged-mcp-test',version:'1.0.0'});
  try {
    await client.connect(new StdioClientTransport({command:executable,args:[path.join(path.dirname(executable),'resources','app.asar','dist','mcp.js')],env:cleanEnvironment({ELECTRON_RUN_AS_NODE:'1',BRIDGE_PIPE_HOST:packagedHelper}) as Record<string,string>}));
    assert.equal((await client.listTools()).tools.length,4);
    const response=await client.callTool({name:'get_task_result',arguments:{taskId:randomUUID()}});
    assert.equal(response.isError,true); assert.match((response.content as {text:string}[])[0].text,/找不到任务/);
  } finally {await client.close();stop();process.env.BRIDGE_INSTANCE=previous ?? '';}
});
