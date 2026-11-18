import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState,type Config } from '../src/config.ts';
import { createController } from '../src/controller.ts';
import { bridgeRequest } from '../src/mcp.ts';
import { JobService } from '../src/jobs/service.ts';
import { nextScheduledAt } from '../src/jobs/schedule.ts';
import type { TaskOptions } from '../src/tasks/schemas.ts';

class PolicyWorker extends EventEmitter {
  journalId=randomUUID();activeRunId:string|null=null;submissions:any[]=[];syncError=false;
  constructor(private config:Config){super();}
  health(){return {connected:true as const,uid:this.config.controllerUid,executionUid:this.config.controllerUid,pid:1234,root:false,workerId:'default',journalId:this.journalId,model:null,activeRunId:this.activeRunId,uncertainRuns:[],runtimeOperations:[],projectsDir:this.config.projectsDir,runtime:{available:true,authenticated:true,model:'fixture',version:'policy fixture',detail:'No host or model operations'}};}
  async connect(){return this.health();}
  async request(method:string,input:any={}){
    if(method==='health')return this.health();
    if(method==='sync'){if(this.syncError)throw new Error('Fixture replay cannot prove journal ownership');return {health:this.health(),activeRunId:this.activeRunId,events:[],hasMore:false};}
    if(method==='acknowledge')return {ok:true};
    if(method==='submit'){this.activeRunId=input.runId;this.submissions.push(input);return {accepted:true};}
    throw new Error(`Unexpected fixture method ${method}`);
  }
  close(){}
}
async function fixture(bridge=false){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-policy-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'policy-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const worker=new PolicyWorker(config),ctl=await createController(config,{client:worker as any,startQueue:false,startBridge:bridge});
  ctl.brain.skillAction('skill-maintenance','disable');
  function active(options:TaskOptions={requiredConnectorIds:[],timeoutMs:5000,maxToolCalls:4,maxContextChars:2000,maxOutputChars:2000}){
    const project=ctl.projects.create({name:'Policy project'}),conversation=ctl.projects.newConversation(project.id),run=ctl.store.enqueue(conversation.id,'Coordinate bounded work',randomUUID(),'user',null,options);
    const claimed=ctl.store.claim(run.id,{id:'default',model:null},worker.health());worker.activeRunId=run.id;return {project,conversation,run:claimed};
  }
  const tool=(runId:string,name:string,args:unknown)=>bridgeRequest('tools/call',{runId,name,arguments:args},{socketPath:config.bridgeSocket,token:config.ipcToken,timeoutMs:3000});
  return {config,worker,ctl,active,tool,async close(){await ctl.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('model job triggers cannot acquire saved root, connection, or larger execution grants',async()=>{
  const f=await fixture();try{
    const {project,run:parent}=f.active(),connection=f.ctl.connectors.create({name:'Owner-only connection',transport:'http',url:'http://127.0.0.1:1/mcp'});
    const base={projectId:project.id,prompt:'Inspect a prepared input',schedule:{type:'interval' as const,seconds:60}};
    for(const [name,options,pattern] of [
      ['Privileged job',{requiredRoot:true},/root access/i],
      ['Connected job',{requiredConnectorIds:[connection.id]},/connections/i],
      ['Expensive job',{maxToolCalls:5},/limits|increase/i],
    ] as const){
      const job=f.ctl.jobs.create({...base,name,...options});await assert.rejects(f.ctl.brain.callTool('job_trigger',{id:job.id},{runId:parent.id,conversationId:parent.conversationId}),pattern);assert.equal(f.ctl.jobs.get(job.id).history.length,0);
    }
    const job=f.ctl.jobs.create({...base,name:'Bounded job'}),child:any=await f.ctl.brain.callTool('job_trigger',{id:job.id},{runId:parent.id,conversationId:parent.conversationId});
    assert.equal(child.parentRunId,parent.id);assert.equal(child.requiredRoot,false);assert.deepEqual(child.requiredConnectorIds,[]);
    for(const key of ['timeoutMs','maxToolCalls','maxContextChars','maxOutputChars'] as const)assert(child[key]<=parent[key]!);
    assert.equal(f.ctl.jobs.get(job.id).maxToolCalls,undefined,'A model trigger must not rewrite the owner job definition');
  }finally{await f.close();}
});

test('model project assignments cannot expand an accepted connection grant',async()=>{
  const f=await fixture(true);try{
    const {project,run}=f.active({maxToolCalls:8}),foreign=f.ctl.projects.create({name:'Other project'}),connection=f.ctl.connectors.create({name:'Foreign authorized connection',projectId:foreign.id,transport:'http',url:'http://127.0.0.1:1/mcp'}),credential=f.ctl.vault.create({name:'Owner token',values:{token:'policy-fixture-private-token'}});
    f.ctl.vault.grant(credential.id,connection.id);f.ctl.connectors.setAuth(connection.id,{type:'bearer',credentialId:credential.id,field:'token'});
    await assert.rejects(f.tool(run.id,'project_connectors',{id:project.id,connectorIds:[connection.id]}),/grant|outside|connection/i);
    assert.deepEqual(f.ctl.projects.get(project.id).connectorIds??[],[]);
    // An owner change affects later tasks, not the running task's frozen grant.
    f.ctl.connectors.assign(project.id,{connectorIds:[connection.id]});
    await assert.rejects(f.tool(run.id,'connector_test',{id:connection.id}),/grant|outside/i);
    assert.deepEqual((f.ctl.store.run(run.id) as any).grantedConnectorIds,[]);
  }finally{await f.close();}
});

test('model job updates accept inheritance reset while preserving the accepted parent connection scope',async()=>{
  const f=await fixture();try{
    const {project,run:parent}=f.active(),connection=f.ctl.connectors.create({name:'Later owner connection',transport:'http',url:'http://127.0.0.1:1/mcp'});
    f.ctl.connectors.assign(project.id,{connectorIds:[connection.id]});
    const job=f.ctl.jobs.create({name:'Owner job',projectId:project.id,prompt:'Inspect data',schedule:{type:'interval',seconds:60},requiredConnectorIds:[connection.id]});
    const updated:any=await f.ctl.brain.callTool('job_update',{id:job.id,name:'Updated by parent',requiredConnectorIds:null},{runId:parent.id,conversationId:parent.conversationId});
    assert.equal(updated.name,'Updated by parent');assert.deepEqual(updated.requiredConnectorIds,[]);assert.equal(updated.requiredRoot,false);assert.deepEqual(f.ctl.store.run(parent.id)?.grantedConnectorIds,[]);
    // The owner API keeps its distinct ability to restore dynamic project inheritance.
    assert.equal(f.ctl.jobs.update(job.id,{requiredConnectorIds:null}).requiredConnectorIds,undefined);
  }finally{await f.close();}
});

test('parallel connector registrations preserve both additions to the accepted task grant',async()=>{
  const f=await fixture(true);let release=()=>{};try{
    const {run}=f.active({maxToolCalls:8}),original=f.ctl.brain.callTool.bind(f.ctl.brain);let entered=0;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    f.ctl.brain.callTool=async(name,input,context)=>{if(name==='connector_register'){if(++entered===2)release();await gate;}return original(name,input,context);};
    const results=await Promise.all(['First','Second'].map(name=>f.tool(run.id,'connector_register',{name,transport:'http',url:'http://127.0.0.1:1/mcp'})));
    assert.equal(entered,2);assert.deepEqual(new Set(f.ctl.store.run(run.id)?.grantedConnectorIds),new Set(results.map((connection:any)=>connection.id)));
  }finally{release();await f.close();}
});

test('chat-created connector packages use the same task grants as newly registered connections',async()=>{
  const f=await fixture(true);
  try{
    const repository=await f.ctl.managed.packages.register({name:'Task connectors',remoteUrl:'https://example.test/task.git',mode:'create'});
    for(const explicit of [false,true]){
      const conversation=f.ctl.store.newConversation();
      const run=f.ctl.store.enqueue(conversation.id,'Create a connector',randomUUID(),'user',null,explicit?{requiredConnectorIds:[]}:{});
      f.ctl.store.claim(run.id,{id:'default'},f.worker.health());
      const path=explicit?'explicit':'inherited';
      const record=await f.tool(run.id,'package_create',{repositoryId:repository.id,path,kind:'connector',name:path}) as {connection:{id:string}};
      assert.deepEqual(f.ctl.store.run(run.id)?.grantedConnectorIds,explicit?[]:[record.connection.id]);
      f.ctl.store.transition(run.id,'interrupted');
      await f.ctl.managed.finishRun(f.ctl.store.run(run.id)!);
    }
  }finally{await f.close();}
});

test('failed journal synchronization expires the owning attempt without reassigning it',async()=>{
  const f=await fixture();try{
    const conversation=f.ctl.store.newConversation(),run=f.ctl.store.enqueue(conversation.id,'Bounded fixture',randomUUID());await f.ctl.queue.tick();assert.equal(f.ctl.store.run(run.id)?.status,'running');
    f.worker.emit('disconnect');f.worker.syncError=true;f.ctl.store.db.prepare('UPDATE run_attempts SET leaseExpiresAt=? WHERE runId=?').run(new Date(0).toISOString(),run.id);
    await f.ctl.queue.tick();assert.equal(f.ctl.store.run(run.id)?.status,'uncertain');assert.equal(f.worker.submissions.length,1);assert.match(f.ctl.queue.workerError??'',/replay|journal|ownership/i);
    const workers:any=await f.ctl.brain.callTool('worker_list',{});assert.match(workers[0].error,/replay|journal|ownership/i);
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);
  }finally{await f.close();}
});

test('request IDs reject changed connection scope and execution budgets',async()=>{
  const f=await fixture();try{
    const conversation=f.ctl.store.newConversation(),enqueue=(id:string,options:TaskOptions={})=>f.ctl.store.enqueue(conversation.id,'Same task',id,'user',null,options);
    enqueue('scope');assert.throws(()=>enqueue('scope',{requiredConnectorIds:[]}),/different input/i);
    enqueue('explicit',{requiredConnectorIds:[]});assert.throws(()=>enqueue('explicit'),/different input/i);
    for(const [key,value] of [['timeoutMs',1000],['maxToolCalls',1],['maxContextChars',1000],['maxOutputChars',1000]] as const){enqueue(key);assert.throws(()=>enqueue(key,{[key]:value}),/different input/i);}
    const original=enqueue('same',{maxToolCalls:3});assert.equal(enqueue('same',{maxToolCalls:3}).id,original.id);
  }finally{await f.close();}
});

test('intrinsic job prompt and event budget errors reject before creating durable task history',async()=>{
  const f=await fixture();try{
    const project=f.ctl.projects.create({name:'Bounded jobs'}),base={name:'Small context',projectId:project.id,prompt:'Inspect data',maxContextChars:2000,schedule:{type:'interval' as const,seconds:60}},before={jobs:f.ctl.jobs.list().length,conversations:f.ctl.store.conversations().length,runs:f.ctl.store.runs().length};
    assert.throws(()=>f.ctl.jobs.create({...base,prompt:'x'.repeat(5000)}),/context budget/i);assert.equal(f.ctl.jobs.list().length,before.jobs);
    const job=f.ctl.jobs.create(base);assert.throws(()=>f.ctl.jobs.update(job.id,{prompt:'x'.repeat(5000)}),/context budget/i);assert.equal(f.ctl.jobs.get(job.id).prompt,base.prompt);
    assert.throws(()=>f.ctl.jobs.trigger(job.id,'bounded-event',{data:'x'.repeat(1500)}),/context budget/i);assert.equal(f.ctl.store.conversations().length,before.conversations);assert.equal(f.ctl.store.runs().length,before.runs);assert.equal(f.ctl.jobs.get(job.id).history.length,0);
    const accepted=f.ctl.jobs.trigger(job.id,'bounded-event',{data:'small snapshot'});assert.equal(accepted.status,'queued');assert.equal(f.ctl.jobs.get(job.id).history.length,1);assert.equal(f.ctl.jobs.trigger(job.id,'bounded-event').id,accepted.id);
  }finally{await f.close();}
});

test('dispatch rechecks admission after its final asynchronous health read',async t=>{
  for(const change of ['maintenance','draining','authentication','journal'] as const)await t.test(change,async()=>{
    const f=await fixture();let enter!:()=>void,release!:()=>void,prepared=false,paused=false,releaseAuthentication:undefined|(()=>void);
    const entered=new Promise<void>(ok=>{enter=ok;}),gate=new Promise<void>(ok=>{release=ok;}),connect=f.worker.connect.bind(f.worker);
    f.ctl.connectors.snapshots=async()=>{prepared=true;return [];};
    f.worker.connect=async()=>{if(prepared&&!paused){paused=true;enter();await gate;}return connect();};
    try{
      const conversation=f.ctl.store.newConversation(),run=f.ctl.store.enqueue(conversation.id,'Bounded preparation',randomUUID()),pending=f.ctl.queue.tick();await entered;
      if(change==='maintenance')f.ctl.store.setSetting('maintenance','true');
      if(change==='draining')f.ctl.queue.registry.drain('default');
      if(change==='authentication')releaseAuthentication=f.ctl.queue.holdAuthentication();
      if(change==='journal')f.worker.journalId=randomUUID();
      release();await pending;assert.equal(f.worker.submissions.length,0);assert.equal(f.ctl.store.run(run.id)?.status,'queued');assert.equal(f.ctl.store.run(run.id)?.attemptId,null);
    }finally{release();releaseAuthentication?.();await f.close();}
  });
});

test('a cron next-occurrence failure blocks its job and lets other jobs continue',async()=>{
  const f=await fixture();let now=Date.UTC(2027,2,1),jobs=new JobService(f.ctl.store,f.ctl.projects,()=>{},()=>now);
  try{
    const project=f.ctl.projects.create({name:'Calendar jobs'}),leap=jobs.create({name:'Leap-day job',projectId:project.id,prompt:'Inspect leap-day input',schedule:{type:'cron',expression:'0 0 29 FEB *',timezone:'UTC'}}),routine=jobs.create({name:'Routine job',projectId:project.id,prompt:'Inspect routine input',schedule:{type:'interval',seconds:10}});
    assert.equal(nextScheduledAt({type:'cron',expression:'0 0 29 FEB *',timezone:'UTC'},Date.UTC(2028,1,29)),'2032-02-29T00:00:00.000Z');
    // A stale or corrupt persisted definition must not escape the scheduler timer.
    f.ctl.store.db.prepare('UPDATE jobs SET schedule=? WHERE id=?').run(JSON.stringify({type:'cron',expression:'80 * * * *',timezone:'UTC'}),leap.id);
    now=Date.UTC(2028,1,29);assert.doesNotThrow(()=>jobs.tick());assert.equal(jobs.get(leap.id).history.length,1);assert.match(jobs.get(leap.id).blockedReason??'',/cron|occurrence|schedule/i);assert.equal(jobs.get(routine.id).history.length,1);assert.doesNotThrow(()=>jobs.tick());assert.equal(jobs.get(leap.id).history.length,1);
  }finally{jobs.close();await f.close();}
});
