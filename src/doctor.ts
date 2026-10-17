import { client, ndJsonStream, PROTOCOL_VERSION } from '@agentclientprotocol/sdk';
import { Readable, Writable } from 'node:stream';
import { mkdir, mkdtemp } from 'node:fs/promises';
import path from 'node:path';
import { configureDsh } from './acp.js';
import { startProcess, terminateTree } from './process.js';
import { defaultSettings, safeError } from './model.js';

// Explicit local diagnostic. Never sends session/prompt or invokes a model.
process.env.BRIDGE_JOB_HOST = path.resolve('build/pipe-host.exe');
await mkdir('.test-data', {recursive:true});
const folder = await mkdtemp(path.resolve('.test-data','handshake-'));
const worktree = path.join(folder,'workspace'); await mkdir(worktree);
const settings = {...defaultSettings, ...(process.argv[2] ? {dshPath:process.argv[2]} : {})};
const controller = new AbortController();
const timer = setTimeout(()=>controller.abort(),30000);
let child: Awaited<ReturnType<typeof startProcess>> | undefined;
let connection: ReturnType<ReturnType<typeof client>['connect']> | undefined;
try {
  const {args,env} = await configureDsh(worktree,settings,controller.signal);
  child = await startProcess(settings.dshPath,args,{cwd:worktree,env});
  child.stdin.on('error',()=>{}); child.stderr.resume();
  connection = client({name:'bridge-handshake-diagnostic'}).connect(ndJsonStream(Writable.toWeb(child.stdin),Readable.toWeb(child.stdout) as ReadableStream<Uint8Array>));
  const stopped = new Promise<never>((_,reject)=> {
    child!.on('error',reject); child!.on('exit',code=>reject(new Error(`DSH exited (${code})`)));
    controller.signal.addEventListener('abort',()=>reject(new Error('ACP handshake timeout')),{once:true});
  });
  void stopped.catch(()=>{});
  const race = <T>(value:Promise<T>)=>Promise.race([value,stopped]);
  const info = await race(connection.agent.request('initialize',{protocolVersion:PROTOCOL_VERSION,clientCapabilities:{},clientInfo:{name:'bridge-doctor',version:'0.1.0'}}));
  const session = await race(connection.agent.request('session/new',{cwd:worktree,mcpServers:[]}));
  let resumed = false;
  if (info.agentCapabilities?.sessionCapabilities?.close) await race(connection.agent.request('session/close',{sessionId:session.sessionId}));
  if (info.agentCapabilities?.sessionCapabilities?.resume) {
    await race(connection.agent.request('session/resume',{sessionId:session.sessionId,cwd:worktree,mcpServers:[]})); resumed=true;
  }
  if (info.agentCapabilities?.sessionCapabilities?.close) await race(connection.agent.request('session/close',{sessionId:session.sessionId}));
  console.log(JSON.stringify({protocolVersion:info.protocolVersion,agent:info.agentInfo,capabilities:info.agentCapabilities,newSession:true,resume:resumed,modelOptions:session.configOptions?.filter(o=>o.category==='model').map(o=>({id:o.id,currentValue:o.currentValue,...(o.type==='select'?{options:o.options}:{})})),promptSent:false},null,2));
} catch (error) { console.error(safeError(error)); process.exitCode=1; }
finally {clearTimeout(timer);connection?.close();if(child) {child.stdin.end();await terminateTree(child);}}
