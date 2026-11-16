import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { WorkerServer } from '../src/worker.ts';
import { WorkerClient, type WorkerHealth } from '../src/ipc.ts';
import { WorkerRegistry } from '../src/workers/registry.ts';
import { ownWorkerConfig } from '../src/workers/config.ts';
import { loadWorkerConfig, workerArguments } from '../src/workers/startup.ts';
import { workerLaunch } from '../src/worker-launch.ts';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-pool-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'worker-pool-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const store=new Store(stateDir),registry=new WorkerRegistry(config,store.db);
  return {config,store,registry,close(){registry.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}
class Adapter extends EventEmitter {
  version='fixture';turnId='fixture-turn';timer?:NodeJS.Timeout;
  async start(){}async health(){return {authenticated:true,detail:'Fixture without model calls'};}
  async run(submission:{prompt:string}){if(submission.prompt!=='hold')this.timer=setTimeout(()=>{this.emit('event','delta',{text:submission.prompt,itemId:'answer'});this.emit('event','completed',{status:'completed'});},25);}
  async interrupt(){clearTimeout(this.timer);this.emit('event','completed',{status:'interrupted'});}async close(){clearTimeout(this.timer);}
}
async function terminal(client:WorkerClient,id:string):Promise<void>{
  const deadline=Date.now()+5000;while(Date.now()<deadline){const page=await client.request('sync',{after:0});if(page.events.some((event:{runId:string;type:string})=>event.runId===id&&event.type==='completed'))return;await new Promise(ok=>setTimeout(ok,10));}throw new Error('Fixture run did not finish');
}

test('named workers isolate profiles, locks, journals and replay identities while running concurrently',{skip:process.getuid?.()===0},async()=>{
  const f=fixture(),a=f.registry.register({id:'alpha',name:'Alpha',model:'fixture-a',effort:'high'}),b=f.registry.register({id:'beta',name:'Beta',model:'fixture-b'});
  const ca=ownWorkerConfig(f.config,a),cb=ownWorkerConfig(f.config,b),wa=new WorkerServer(ca,()=>new Adapter() as any),wb=new WorkerServer(cb,()=>new Adapter() as any);let restarted:WorkerServer|undefined;
  try{
    writeFileSync(join(ca.runtimeHome,'auth.json'),'isolated Alpha fixture');assert.equal(existsSync(join(cb.runtimeHome,'auth.json')),false);
    await Promise.all([wa.listen(),wb.listen()]);const [ha,hb]=await Promise.all([f.registry.refresh('alpha'),f.registry.refresh('beta')]);assert(ha.connected&&hb.connected);assert.notEqual(ha.health!.journalId,hb.health!.journalId);assert.notEqual(ca.socketPath,cb.socketPath);
    const common={runId:'same_run_id',conversationId:'fixture',bootstrap:'',skills:[],cwd:join(f.config.stateDir,'workspaces','fixture')};
    await Promise.all([f.registry.client('alpha').request('submit',{...common,prompt:'Alpha',workerId:'alpha',journalId:ha.health!.journalId}),f.registry.client('beta').request('submit',{...common,prompt:'Beta',workerId:'beta',journalId:hb.health!.journalId})]);
    await Promise.all([terminal(f.registry.client('alpha'),common.runId),terminal(f.registry.client('beta'),common.runId)]);
    for(const id of ['alpha','beta']){const page=await f.registry.client(id).request('sync',{after:0});assert.equal(page.events[0].cursor,1);assert(page.events.every((event:{workerId:string;journalId:string})=>event.workerId===id&&event.journalId===f.registry.cachedHealth(id)!.journalId));}
    const identity=ha.health!.journalId;await wa.close();f.registry.client('alpha').close();restarted=new WorkerServer(ca,()=>new Adapter() as any);await restarted.listen();const refreshed=await f.registry.refresh('alpha');assert(refreshed.connected,refreshed.error??'Restarted worker disconnected');assert.equal(refreshed.health!.journalId,identity);assert.equal(readFileSync(join(ca.runtimeHome,'auth.json'),'utf8'),'isolated Alpha fixture');
    assert.throws(()=>f.registry.update('beta',{model:'another-model'}),/Unrecognized key/);assert.equal(f.registry.get('beta').model,'fixture-b');
  }finally{await wa.close();await wb.close();await restarted?.close();f.close();}
});

test('selection excludes busy, draining and uncertain workers and rejects stale submission identity',{skip:process.getuid?.()===0},async()=>{
  const f=fixture(),a=f.registry.register({id:'alpha',name:'Alpha',model:'fixture-a'}),b=f.registry.register({id:'beta',name:'Beta',model:'fixture-b'}),wa=new WorkerServer(ownWorkerConfig(f.config,a),()=>new Adapter() as any),wb=new WorkerServer(ownWorkerConfig(f.config,b),()=>new Adapter() as any);
  try{
    await Promise.all([wa.listen(),wb.listen()]);const selection=await f.registry.select();assert.equal(selection.worker.id,'alpha');const client=f.registry.client('alpha');
    const input={runId:'held',conversationId:'fixture',prompt:'hold',bootstrap:'',skills:[],cwd:join(f.config.stateDir,'workspaces','fixture')};
    await assert.rejects(client.request('submit',{...input,workerId:'beta'}),/different worker/);await assert.rejects(client.request('submit',{...input,journalId:randomUUID()}),/journal identity changed/);assert.equal(wa.journal.get(input.runId),undefined);
    await client.request('submit',{...input,workerId:'alpha',journalId:selection.health.journalId});assert.equal((await f.registry.select()).worker.id,'beta');f.registry.drain('beta');await assert.rejects(f.registry.select(),/No eligible idle worker/);
    await client.request('interrupt',{runId:input.runId});await terminal(client,input.runId);
    const id=`runtime_${randomUUID()}`;wa.journal.beginRuntimeOperation(id,'managed/prepare');wa.journal.runtimeStatus(id,'uncertain');await assert.rejects(f.registry.select(),/No eligible idle worker/);await client.request('resolve',{runId:id});assert.equal((await f.registry.select()).worker.id,'alpha');
  }finally{await wa.close();await wb.close();f.close();}
});

class FakeClient extends EventEmitter {
  calls:string[]=[];constructor(readonly healthValue:WorkerHealth){super();}async connect(){return this.healthValue;}async request(method:string){this.calls.push(method);return {owner:this.healthValue.workerId};}close(){}
}
test('closing a registry removes its client listeners and preserves independent listeners',async()=>{
  const f=fixture(),client=new FakeClient({connected:true,uid:f.config.controllerUid,pid:1,root:false,activeRunId:null,uncertainRuns:[],runtime:{available:true,version:'fixture',authenticated:true,detail:'Fixture'}}),external=()=>{};
  client.on('event',external);client.on('disconnect',external);const registry=new WorkerRegistry(f.config,f.store.db,client as any);
  try{await registry.refresh('default');assert.equal(client.listenerCount('event'),2);assert.equal(client.listenerCount('disconnect'),2);registry.close();assert.deepEqual(client.listeners('event'),[external]);assert.deepEqual(client.listeners('disconnect'),[external]);assert.equal(registry.cachedHealth('default'),null);registry.close();assert.deepEqual(client.listeners('event'),[external]);}
  finally{registry.close();f.close();}
});
test('legacy root workers stay visible but are never selected for automatic user tasks',async()=>{
  const f=fixture(),health={connected:true,uid:0,executionUid:0,pid:1,root:true,workerId:'default',journalId:randomUUID(),model:null,activeRunId:null,uncertainRuns:[],runtimeOperations:[],runtime:{available:true,version:'fixture',authenticated:true,detail:'Fixture'}} satisfies WorkerHealth,legacy=new FakeClient(health),registry=new WorkerRegistry(f.config,f.store.db,legacy as any);
  try{assert.equal((await registry.refresh('default')).worker.mode,'root');await assert.rejects(registry.select({mode:'user'}),/No eligible/);assert.equal((await registry.select({mode:'root'})).worker.id,'default');}finally{registry.close();f.close();}
});

test('async worker scopes never fall back to a privileged control worker',async()=>{
  const f=fixture(),record=f.registry.register({id:'user-a',name:'User A',model:'fixture-a'}),user=new FakeClient({connected:true,uid:f.config.controllerUid,executionUid:f.config.controllerUid,root:false,pid:2,workerId:record.id,journalId:randomUUID(),model:record.model,workerMode:'user',activeRunId:'existing-owned-run',uncertainRuns:[],runtimeOperations:[],runtime:{available:true,version:'fixture',authenticated:true,detail:'Fixture'}}),root=new FakeClient({connected:true,uid:0,executionUid:0,root:true,pid:3,workerId:'default',journalId:randomUUID(),model:null,activeRunId:null,uncertainRuns:[],runtimeOperations:[],runtime:{available:true,version:'fixture',authenticated:true,detail:'Fixture'}});
  const registry=new WorkerRegistry(f.config,f.store.db,root as any),original=registry.client.bind(registry);registry.client=id=>id==='user-a'?user as any:original(id);const router=registry.routedClient();
  try{
    const results=await Promise.all([registry.withWorker('user-a',async()=>{const health=await router.connect();await new Promise(ok=>setTimeout(ok,15));return {health,result:await router.request('checkSkill',{})};}),(async()=>{await router.connect();return router.request('projects/inspect',{});})()]);
    assert.equal(results[0].health.workerId,'user-a');assert.equal(results[0].result.owner,'user-a');assert.equal(results[1].owner,'default');assert.deepEqual(user.calls,['checkSkill']);
    await assert.rejects(registry.withWorker('user-a',()=>router.request('managed/deploy',{})),/root worker/);assert(!root.calls.includes('managed/deploy'));
    user.connect=async()=>{throw new Error('Assigned worker offline');};await assert.rejects(registry.withWorker('user-a',()=>router.request('checkSkill',{})),/not routed elsewhere/);
  }finally{registry.close();f.close();}
});

test('CLI manifests register independently, preserve pinned startup settings and generate user commands without sudo',()=>{
  const f=fixture(),previous=process.env;try{
    process.env={...previous,APP_STATE_DIR:f.config.stateDir,APP_PROJECTS_DIR:f.config.projectsDir,APP_ALLOW_TEMP_STATE:'true',APP_CONTROLLER_UID:String(f.config.controllerUid),APP_WORKER_ID:'',CODEX_MODEL:'',CODEX_EFFORT:''};
    const config=loadWorkerConfig(['--id','independent','--model','fixture=model','--effort','high']);assert.equal(config.requireRootWorker,false);assert.equal(config.workerId,'independent');assert.equal(config.model,'fixture=model');assert.equal(config.runtimeHome,join(f.config.stateDir,'workers','independent','runtime'));
    assert.equal(f.registry.get('independent').model,'fixture=model');const command=workerLaunch(config);assert(!command.command.startsWith("'sudo'"));assert(command.args.includes('APP_WORKER_MODE=user'));assert(command.args.includes('CODEX_EFFORT=high'));
    assert.throws(()=>loadWorkerConfig(['--id','independent','--model','changed']),/pinned/);assert.deepEqual(workerArguments(['--id=other','--model=fixture=model']),{id:'other',model:'fixture=model'});assert.throws(()=>workerArguments(['--id','../escape']),/Invalid/);
  }finally{process.env=previous;f.close();}
});

test('worker character budgets fail explicitly before context overflow and stop oversized output',{skip:process.getuid?.()===0},async()=>{
  const f=fixture(),record=f.registry.register({id:'bounded',name:'Bounded',model:'fixture'}),worker=new WorkerServer(ownWorkerConfig(f.config,record),()=>new Adapter() as any),client=f.registry.client(record.id);
  try{
    await worker.listen();await client.connect();const input={runId:'bounded-run',conversationId:'fixture',prompt:'too much output',bootstrap:'context',skills:[],cwd:join(f.config.stateDir,'workspaces','fixture')};
    await assert.rejects(client.request('submit',{...input,maxContextChars:2}),/context character limit/);assert.equal(worker.journal.get(input.runId),undefined);
    await client.request('submit',{...input,maxContextChars:100,maxOutputChars:3});await terminal(client,input.runId);assert.equal(worker.journal.get(input.runId)?.status,'failed');const events=(await client.request('sync',{after:0})).events;assert(events.some((event:{type:string;data:{error?:string}})=>event.type==='completed'&&event.data.error?.includes('output character limit')));
  }finally{await worker.close();f.close();}
});

test('task timeout includes adapter startup and prevents a late startup from beginning a turn',{skip:process.getuid?.()===0},async()=>{
  const f=fixture(),record=f.registry.register({id:'slow',name:'Slow',model:'fixture'});let release!:()=>void,turns=0;const startup=new Promise<void>(ok=>{release=ok;});
  class SlowAdapter extends Adapter {async start(){await startup;}async run(){turns++;}}
  const worker=new WorkerServer(ownWorkerConfig(f.config,record),(_config,id)=>id?new SlowAdapter() as any:new Adapter() as any),client=f.registry.client(record.id);
  try{
    await worker.listen();await client.connect();await client.request('submit',{runId:'slow-start',conversationId:'fixture',prompt:'fixture',bootstrap:'',skills:[],cwd:join(f.config.stateDir,'workspaces','fixture'),timeoutMs:1000});await terminal(client,'slow-start');
    assert.equal(worker.journal.get('slow-start')?.status,'failed');release();await new Promise(ok=>setImmediate(ok));assert.equal(turns,0);
  }finally{release();await worker.close();f.close();}
});
