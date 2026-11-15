import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, type Config } from '../src/config.ts';
import { WorkerClient } from '../src/ipc.ts';
import { managedPath } from '../src/managed/schemas.ts';
import { WorkerJournal } from '../src/runtime/journal.ts';
import { bootId, groupMembers, processStamp } from '../src/runtime/processes.ts';
import { inRuntimeOperation, spawnOwned } from '../src/runtime/operations.ts';
import { Store } from '../src/store.ts';
import { RuntimeReceipts } from '../src/runtime-receipts.ts';

const loader=createRequire(import.meta.url).resolve('tsx');
const workerModule=new URL('../src/worker.ts',import.meta.url).href;
async function waitFor(condition:()=>boolean,message:string,timeoutMs=8000):Promise<void>{
  const deadline=Date.now()+timeoutMs;
  while(!condition()){if(Date.now()>=deadline)throw new Error(message);await new Promise(resolve=>setTimeout(resolve,25));}
}
async function stopProcess(child:ChildProcess,signal:NodeJS.Signals='SIGTERM'){
  if(child.exitCode!==null||child.signalCode!==null)return;
  child.kill(signal);await waitFor(()=>child.exitCode!==null||child.signalCode!==null,'Fixture process did not stop');
}
async function detached(source='setInterval(()=>{},1000)'){
  const child=spawn(process.execPath,['-e',source],{detached:true,stdio:'ignore'});await once(child,'spawn');
  await waitFor(()=>Boolean(child.pid&&processStamp(child.pid)),'Fixture group identity was not observable');
  return {child,pid:child.pid!,start:processStamp(child.pid!)!};
}
async function killFixtureGroup(pid:number){try{process.kill(-pid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}await waitFor(()=>groupMembers(pid).length===0,'Fixture process group survived cleanup');}
function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-runtime-recovery-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'fixture-runtime-recovery-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const configPath=join(stateDir,'worker-fixture.json');writeFileSync(configPath,JSON.stringify(config),{mode:0o600});
  const children=new Set<ChildProcess>(),clients=new Set<WorkerClient>();
  return {stateDir,config,
    async start(){
      const code=`import {EventEmitter} from 'node:events';import {readFileSync} from 'node:fs';import {WorkerServer} from ${JSON.stringify(workerModule)};
        class FixtureAdapter extends EventEmitter {version='fixture';async start(){}async health(){return {authenticated:true,detail:'No real model or host service operations'};}async run(){throw new Error('Model turns are forbidden in recovery fixtures');}async close(){}}
        const worker=new WorkerServer(JSON.parse(readFileSync(process.argv[1],'utf8')),()=>new FixtureAdapter());
        process.once('SIGTERM',()=>void worker.close().then(()=>process.exit(0)));await worker.listen();console.log('fixture-ready');`;
      const child=spawn(process.execPath,['--import',loader,'--input-type=module','-e',code,configPath],{stdio:['ignore','pipe','pipe']});children.add(child);
      let output='';child.stdout!.on('data',chunk=>{output+=chunk.toString();});child.stderr!.on('data',chunk=>{output+=chunk.toString();});
      await waitFor(()=>{if(child.exitCode!==null||child.signalCode!==null)throw new Error(`Fixture worker exited: ${output.slice(-2000)}`);return output.includes('fixture-ready');},'Fixture worker did not start');
      const client=new WorkerClient(config);clients.add(client);await client.connect();return {child,client};
    },
    async close(){for(const client of clients)client.close();for(const child of children)await stopProcess(child);rmSync(stateDir,{recursive:true,force:true});},
  };
}

test('SIGKILL during a managed helper preserves durable ownership and blocks replay until reconciliation',async()=>{
  const f=fixture(),independent=await detached();let recorded:number[]=[];
  try{
    const first=await f.start(),id=randomUUID(),marker=join(f.stateDir,'helper-starts.txt');
    const manifest={schemaVersion:1 as const,id,kind:'connector' as const,name:'Crash fixture',description:'',check:{command:process.execPath,args:['-e',`require('node:fs').appendFileSync(${JSON.stringify(marker)},'started');setInterval(()=>{},1000);`]},mcp:{transport:'stdio' as const,command:process.execPath,args:['server.mjs']}};
    const input={project:{id,directory:join(f.config.projectsDir!,id)},source:{commit:'a'.repeat(40),path:managedPath('connector',id)},manifest,files:{'operator-package.json':JSON.stringify(manifest),'server.mjs':'// Fixture source\n'}};
    const request=first.client.request('managed/prepare',input).catch(error=>error);
    await waitFor(()=>existsSync(marker),'Managed helper never started');
    const ledger=new WorkerJournal(f.stateDir);let operationId:string;
    try{
      const operation=ledger.runtimeOperations().find(operation=>operation.method==='managed/prepare');assert(operation);operationId=operation.id;
      const processes=ledger.runtimeProcesses(operationId);assert(processes.length>0,'Helper side effects require a durable process identity first');
      for(const process of processes){assert(process.pid!==null);assert(process.start);assert.equal(process.boot,bootId());assert.equal(process.released,true);recorded.push(process.pid);assert.equal(processStamp(process.pid),process.start);}
    }finally{ledger.close();}
    await stopProcess(first.child,'SIGKILL');first.client.close();await request;
    const restarted=await f.start(),health=await restarted.client.request('health',{});
    assert(health.uncertainRuns.includes(operationId!));assert(health.runtimeOperations.some((operation:{id:string;status:string})=>operation.id===operationId!&&operation.status==='uncertain'));
    await assert.rejects(restarted.client.request('managed/prepare',input),/uncertain|orphan|reconcil|resolve/i);
    await restarted.client.request('resolve',{runId:operationId!,acknowledgeExternalEffects:true});
    for(const pid of recorded)assert.equal(groupMembers(pid).length,0);
    assert.equal(readFileSync(marker,'utf8'),'started','Restart/reconciliation must not repeat the helper');assert.equal(processStamp(independent.pid),independent.start,'An independently deployed process must not be killed');
    assert.equal((await restarted.client.request('health',{})).runtimeOperations.some((operation:{id:string})=>operation.id===operationId!),false);
  }finally{for(const pid of recorded)await killFixtureGroup(pid);await killFixtureGroup(independent.pid);await f.close();}
});

test('a failed durable PID capture never releases the helper executable',async()=>{
  const f=fixture(),ledger=new WorkerJournal(f.stateDir),id=`runtime_${randomUUID()}`,launch=`launch_${randomUUID()}`,marker=join(f.stateDir,'must-not-execute');let pid:number|undefined,releaseCalls=0,cleanupFailed=false;
  try{
    ledger.beginRuntimeOperation(id,'managed/prepare');
    await assert.rejects(inRuntimeOperation({reserve:()=>{ledger.reserveRuntimeProcess(id,launch);return launch;},capture:(_launch,captured)=>{pid=captured;throw new Error('Fixture durable identity capture failed');},release:()=>{releaseCalls++;},external:()=>{},cleanupFailed:()=>{cleanupFailed=true;}},async()=>{spawnOwned(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(marker)},'executed')`],{env:process.env,cwd:f.stateDir});}),/durably recorded/);
    assert.equal(releaseCalls,0);assert.equal(cleanupFailed,true);assert.equal(ledger.runtimeProcesses(id)[0].released,false);assert.equal(ledger.runtimeProcesses(id)[0].pid,null);
    if(pid)await waitFor(()=>groupMembers(pid!).length===0,'Gated supervisor survived a failed identity capture');assert.equal(existsSync(marker),false);
  }finally{ledger.close();if(pid)await killFixtureGroup(pid);await f.close();}
});

test('an in-flight HTTP mutation needs explicit external inspection after SIGKILL and is never replayed',async()=>{
  const f=fixture();let mutations=0;
  const server=createServer(async(request,response)=>{
    let text='';for await(const chunk of request)text+=chunk.toString();
    if(request.method==='DELETE'){response.writeHead(200).end();return;}
    const message=JSON.parse(text);
    if(message.id===undefined){response.writeHead(202).end();return;}
    if(message.method==='tools/call'){mutations++;return;}
    const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'recovery-http-fixture',version:'1'}}:{tools:[]};
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const first=await f.start(),address=server.address() as {port:number},connector={id:randomUUID(),name:'HTTP mutation fixture',transport:'http',url:`http://127.0.0.1:${address.port}/mcp`};
    const request=first.client.request('connectors/call',{connector,name:'mutate',arguments:{}}).catch(error=>error);
    await waitFor(()=>mutations===1,'Fixture HTTP mutation was not received');
    const ledger=new WorkerJournal(f.stateDir);let operationId:string;
    try{const operation=ledger.runtimeOperations().find(operation=>operation.method==='connectors/call');assert(operation);operationId=operation.id;assert.equal(operation.requiresExternalInspection,true);}finally{ledger.close();}
    await stopProcess(first.child,'SIGKILL');first.client.close();await request;
    const restarted=await f.start();assert((await restarted.client.request('health',{})).uncertainRuns.includes(operationId!));
    await assert.rejects(restarted.client.request('resolve',{runId:operationId!}),/acknowledge|inspect|external/i);assert.equal(mutations,1);
    await restarted.client.request('resolve',{runId:operationId!,acknowledgeExternalEffects:true});assert.equal(mutations,1);
    assert.equal((await restarted.client.request('health',{})).runtimeOperations.some((operation:{id:string})=>operation.id===operationId!),false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await f.close();}
});

test('SIGKILL during a stdio MCP mutation retains its helper identity and requires inspection without replay',async()=>{
  const f=fixture(),marker=join(f.stateDir,'stdio-mutation'),serverFile=join(f.stateDir,'stdio-server.mjs');let groups:number[]=[];
  writeFileSync(serverFile,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;
      if(message.method==='tools/call'){appendFileSync(${JSON.stringify(marker)},'mutation');return;}
      const result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'stdio-recovery-fixture',version:'1'}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+String.fromCharCode(10));});`);
  try{
    const first=await f.start(),connector={id:randomUUID(),name:'Stdio mutation fixture',transport:'stdio',command:process.execPath,args:[serverFile],cwd:f.stateDir};
    const request=first.client.request('connectors/call',{connector,name:'mutate',arguments:{}}).catch(error=>error);await waitFor(()=>existsSync(marker),'Fixture stdio mutation did not execute');
    const ledger=new WorkerJournal(f.stateDir);let operationId:string;
    try{const operation=ledger.runtimeOperations().find(operation=>operation.method==='connectors/call');assert(operation);operationId=operation.id;assert.equal(operation.requiresExternalInspection,true);const processes=ledger.runtimeProcesses(operation.id);assert(processes.length>0);for(const process of processes){assert(process.pid!==null);assert(process.start);assert.equal(process.released,true);assert.equal(processStamp(process.pid),process.start);groups.push(process.pid);}}finally{ledger.close();}
    await stopProcess(first.child,'SIGKILL');first.client.close();await request;const restarted=await f.start();assert((await restarted.client.request('health',{})).uncertainRuns.includes(operationId!));
    await assert.rejects(restarted.client.request('resolve',{runId:operationId!}),/acknowledge|inspect|external/i);await restarted.client.request('resolve',{runId:operationId!,acknowledgeExternalEffects:true});
    for(const pid of groups)assert.equal(groupMembers(pid).length,0);assert.equal(readFileSync(marker,'utf8'),'mutation');assert.equal((await restarted.client.request('health',{})).uncertainRuns.includes(operationId!),false);
  }finally{for(const pid of groups)await killFixtureGroup(pid);await f.close();}
});

test('runtime recovery reconciles every recorded group and rejects reused process identities',async()=>{
  const f=fixture(),first=await detached(),second=await detached(),independent=await detached();
  try{
    const id=`runtime_${randomUUID()}`,wrong=`runtime_${randomUUID()}`,ledger=new WorkerJournal(f.stateDir);
    try{
      ledger.beginRuntimeOperation(id,'managed/prepare');ledger.runtimeProcess(id,first.pid,first.start,bootId());ledger.runtimeProcess(id,second.pid,second.start,bootId());
      ledger.beginRuntimeOperation(wrong,'connectors/test');ledger.runtimeProcess(wrong,independent.pid,String(BigInt(independent.start)+1n),bootId());assert.equal(ledger.runtimeProcesses(id).length,2);
    }finally{ledger.close();}
    const worker=await f.start();await worker.client.request('resolve',{runId:id,acknowledgeExternalEffects:true});assert.equal(groupMembers(first.pid).length,0);assert.equal(groupMembers(second.pid).length,0);
    await assert.rejects(worker.client.request('resolve',{runId:wrong,acknowledgeExternalEffects:true}),/ownership|reused|verify|identity/i);assert.equal(processStamp(independent.pid),independent.start);assert((await worker.client.request('health',{})).uncertainRuns.includes(wrong));
  }finally{await killFixtureGroup(first.pid);await killFixtureGroup(second.pid);await killFixtureGroup(independent.pid);await f.close();}
});

test('a missing session leader cannot authorize killing newer unrelated group members',async()=>{
  const f=fixture(),descendantFile=join(f.stateDir,'descendant.pid');
  const leader=await detached(`const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});require('node:fs').writeFileSync(${JSON.stringify(descendantFile)},String(child.pid));child.unref();setInterval(()=>{},1000);`);
  try{
    await waitFor(()=>existsSync(descendantFile),'Fixture descendant did not start');const descendant=Number(readFileSync(descendantFile,'utf8'));await waitFor(()=>Boolean(processStamp(descendant)),'Fixture descendant identity not available');const descendantStart=processStamp(descendant)!;
    await stopProcess(leader.child,'SIGKILL');assert.equal(processStamp(leader.pid),null);assert(groupMembers(leader.pid).some(member=>member.pid===descendant));
    const ledger=new WorkerJournal(f.stateDir),id=`runtime_${randomUUID()}`;
    try{ledger.beginRuntimeOperation(id,'connectors/test');ledger.runtimeProcess(id,leader.pid,String(BigInt(leader.start)-1n),bootId());}finally{ledger.close();}
    const worker=await f.start();await assert.rejects(worker.client.request('resolve',{runId:id,acknowledgeExternalEffects:true}),/ownership|leader|verify|identity/i);assert.equal(processStamp(descendant),descendantStart);assert((await worker.client.request('health',{})).uncertainRuns.includes(id));
  }finally{await killFixtureGroup(leader.pid);await f.close();}
});

test('a durable confirmed HTTP receipt closes the result-delivery crash gap without repeating mutation',async()=>{
  const f=fixture(),store=new Store(f.stateDir);let mutations=0;
  const server=createServer(async(request,response)=>{
    let text='';for await(const chunk of request)text+=chunk.toString();if(request.method==='DELETE'){response.writeHead(200).end();return;}
    const message=JSON.parse(text);if(message.id===undefined){response.writeHead(202).end();return;}
    const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'receipt-gap-fixture',version:'1'}}:{content:[{type:'text',text:`mutation ${++mutations}`}]};
    response.writeHead(200,{'content-type':'application/json'}).end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });
  await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const first=await f.start(),address=server.address() as {port:number},connector={id:randomUUID(),name:'Receipt fixture',transport:'http',url:`http://127.0.0.1:${address.port}/mcp`};
    const lostAck={connect:()=>first.client.connect(),request:(method:string,input:unknown)=>method==='runtime/acknowledge'?Promise.reject(new Error('Fixture lost ACK')):first.client.request(method,input)} as unknown as WorkerClient;
    const receipts=new RuntimeReceipts(store.db,lostAck),result=await receipts.request('connectors/call',{connector,name:'mutate',arguments:{}}) as {content:Array<{text:string}>};assert.equal(result.content[0].text,'mutation 1');assert.equal(mutations,1);
    const receipt=receipts.list()[0];assert.equal(receipt.acknowledgedAt,null);const ledger=new WorkerJournal(f.stateDir);try{assert.equal(ledger.runtimeOperations().find(operation=>operation.id===receipt.operationId)?.completed,true);}finally{ledger.close();}
    await stopProcess(first.child,'SIGKILL');first.client.close();const restarted=await f.start(),recovered=new RuntimeReceipts(store.db,restarted.client);
    assert((await restarted.client.request('health',{})).uncertainRuns.includes(receipt.operationId));assert.equal(await recovered.recover(),true);assert.equal(await recovered.recover(),false);assert.equal(mutations,1);assert(recovered.get(receipt.operationId).acknowledgedAt);assert.equal((await restarted.client.request('health',{})).uncertainRuns.includes(receipt.operationId),false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));store.close();await f.close();}
});

test('a confirmed stdio MCP mutation is durably receipted before its worker ledger is acknowledged',async()=>{
  const f=fixture(),store=new Store(f.stateDir),serverFile=join(f.stateDir,'confirmed-stdio.mjs'),marker=join(f.stateDir,'confirmed-stdio-effect');
  writeFileSync(serverFile,`import {createInterface} from 'node:readline';import {appendFileSync} from 'node:fs';
    createInterface({input:process.stdin}).on('line',line=>{const message=JSON.parse(line);if(message.id===undefined)return;
      let result;if(message.method==='tools/call'){appendFileSync(${JSON.stringify(marker)},'mutation');result={content:[{type:'text',text:'Confirmed stdio fixture result'}]};}
      else result={protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'confirmed-stdio-fixture',version:'1'}};
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+String.fromCharCode(10));});`);
  try{
    const worker=await f.start(),receipts=new RuntimeReceipts(store.db,worker.client),connector={id:randomUUID(),name:'Confirmed stdio fixture',transport:'stdio',command:process.execPath,args:[serverFile],cwd:f.stateDir};
    const result=await receipts.request('connectors/call',{connector,name:'mutate',arguments:{}}) as {content:Array<{text:string}>};assert.equal(result.content[0].text,'Confirmed stdio fixture result');assert.equal(Object.hasOwn(result,'__runtimeOperationId'),false);
    const receipt=receipts.list()[0];assert(receipt);assert(receipt.acknowledgedAt);assert.equal(receipt.method,'connectors/call');assert.equal(readFileSync(marker,'utf8'),'mutation');
    const ledger=new WorkerJournal(f.stateDir);try{assert.equal(ledger.runtimeOperations().some(operation=>operation.id===receipt.operationId),false);}finally{ledger.close();}
    assert.deepEqual(await worker.client.request('runtime/acknowledge',{operationId:receipt.operationId}),{acknowledged:true,operationId:receipt.operationId});assert.equal(readFileSync(marker,'utf8'),'mutation');
  }finally{store.close();await f.close();}
});
