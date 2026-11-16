import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState,type Config } from '../src/config.ts';
import type { Submission,WorkerHealth } from '../src/ipc.ts';

class ImprovementWorker extends EventEmitter {
  readonly journalId=randomUUID();readonly submissions:Submission[]=[];
  activeRunId:string|null=null;private cursor=0;
  constructor(private config:Config,private root=false){super();}
  health():WorkerHealth{return {connected:true,uid:this.root?0:this.config.controllerUid,executionUid:this.root?0:this.config.controllerUid,root:this.root,pid:1234,workerId:'default',journalId:this.journalId,model:null,projectsDir:this.config.projectsDir,activeRunId:this.activeRunId,uncertainRuns:[],runtimeOperations:[],runtime:{available:true,authenticated:true,version:'fixture',detail:'No model or host operations'}};}
  async connect(){return this.health();}
  async request(method:string,input:any={}){
    if(method==='health')return this.health();
    if(method==='sync')return {health:this.health(),activeRunId:this.activeRunId,events:[],hasMore:false};
    if(method==='acknowledge')return {acknowledged:input.cursor};
    if(method==='submit'){assert.equal(this.activeRunId,null);this.activeRunId=input.runId;this.submissions.push(input);return {accepted:true};}
    if(method==='projects/prepare')return {directory:input.project.directory,ready:true};
    throw new Error(`Unexpected fixture request ${method}`);
  }
  finish(){const runId=this.activeRunId;assert(runId);this.activeRunId=null;this.emit('event',{cursor:++this.cursor,workerId:'default',journalId:this.journalId,runId,type:'completed',data:{status:'completed'},createdAt:new Date().toISOString()});}
  close(){}
}

async function fixture(root=false){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-improvement-policy-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'improvement-policy-fixture-password',secureCookie:false,improvementEnabled:true,improvementTimeoutMs:90_000,improvementMaxTurns:3,allowTempState:true,requireRootWorker:root};
  initState(config);const worker=new ImprovementWorker(config,root),ctl=await createController(config,{client:worker as any,startQueue:false,startBridge:false});ctl.brain.skillAction('skill-maintenance','disable');
  return {ctl,config,worker,async close(){await ctl.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('automatic improvement inherits an explicit empty connection grant and cannot increase task budgets',async()=>{
  const f=await fixture();try{
    const project=f.ctl.projects.create({name:'Restricted project'}),connection=f.ctl.connectors.create({name:'Owner connection',transport:'http',url:'http://127.0.0.1:1/mcp'});f.ctl.connectors.assign(project.id,{connectorIds:[connection.id]});
    const conversation=f.ctl.projects.newConversation(project.id),parent=f.ctl.store.enqueue(conversation.id,'Inspect a prepared input',randomUUID(),'user',null,{requiredConnectorIds:[],timeoutMs:1000,maxToolCalls:1,maxContextChars:2000,maxOutputChars:1000});
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);f.worker.finish();
    const child=f.ctl.store.runs().find(run=>run.parentRunId===parent.id)!;assert(child);assert.equal(child.kind,'improvement');assert.equal(child.connectionScope,'explicit');assert.deepEqual(child.requiredConnectorIds,[]);
    for(const key of ['timeoutMs','maxToolCalls','maxContextChars','maxOutputChars'] as const)assert(child[key]!<=parent[key]!,key);
    assert.match(child.prompt,/Maximum 1 tool calls/);await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,2);assert.equal(f.worker.submissions[1]?.runId,child.id);assert.deepEqual(f.worker.submissions[1]?.connectors,[]);
  }finally{await f.close();}
});

test('automatic improvement keeps the accepted connection snapshot after project assignments change',async()=>{
  const f=await fixture();try{
    const project=f.ctl.projects.create({name:'Frozen grants'}),accepted=randomUUID(),later=randomUUID();
    // Readiness and transport are simulated; actual assignment snapshots and inheritance are persisted.
    f.ctl.connectors.readiness=()=>({ready:true});f.ctl.connectors.snapshots=async()=>[];
    const now=new Date().toISOString();for(const id of [accepted,later])f.ctl.store.connectors.create({id,name:id,description:'Fixture connection',enabled:true,transport:'http',url:'http://127.0.0.1:1/mcp',projectId:null,tools:[],status:'untested',detail:'Fixture',checkedAt:null,createdAt:now,updatedAt:now});
    f.ctl.store.connectors.assign(project.id,[accepted]);const conversation=f.ctl.projects.newConversation(project.id),parent=f.ctl.store.enqueue(conversation.id,'Inspect assigned data',randomUUID());
    await f.ctl.queue.tick();assert.deepEqual(f.ctl.store.run(parent.id)?.grantedConnectorIds,[accepted]);f.ctl.store.connectors.assign(project.id,[later]);f.worker.finish();
    const child=f.ctl.store.runs().find(run=>run.parentRunId===parent.id)!;assert(child);assert.equal(child.connectionScope,'explicit');assert.deepEqual(child.requiredConnectorIds,[accepted]);assert.equal(f.ctl.store.run(parent.id)?.status,'completed');
  }finally{await f.close();}
});

test('legacy root acceptance preserves request idempotency and allows its bounded follow-up from recorded execution identity',async()=>{
  const f=await fixture(true);try{
    const conversation=f.ctl.store.newConversation(),input={prompt:'Inspect the root host fixture',requestId:randomUUID()},parent=f.ctl.tasks.submit(conversation.id,input);await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);
    const accepted=f.ctl.store.run(parent.id)!;assert.equal(accepted.requiredRoot,false);assert.equal(f.ctl.store.attempt(accepted.attemptId!)?.uid,0);assert.equal(f.ctl.tasks.rootGranted(accepted),true);assert.equal(f.ctl.tasks.submit(conversation.id,input).id,parent.id);assert.equal(f.ctl.store.runs().length,1);
    f.worker.finish();const child=f.ctl.store.runs().find(run=>run.parentRunId===parent.id)!;assert(child);assert.equal(child.workerId,'default');assert.equal(child.requiredRoot,true);
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,2);assert.equal(f.ctl.store.run(child.id)?.status,'running');assert.equal(f.worker.submissions[1]?.runId,child.id);
  }finally{await f.close();}
});

test('a follow-up admission failure leaves the completed task and owning worker synchronized',async()=>{
  const f=await fixture();try{
    const conversation=f.ctl.store.newConversation(),parent=f.ctl.store.enqueue(conversation.id,'Inspect data',randomUUID());await f.ctl.queue.tick();f.ctl.queue.setTaskInheritance(()=>{throw new Error('Fixture inheritance unavailable');});f.worker.finish();
    assert.equal(f.ctl.store.run(parent.id)?.status,'completed');assert.equal(f.ctl.store.runs().filter(run=>run.parentRunId===parent.id).length,0);assert.match(JSON.stringify(f.ctl.store.events().filter(event=>event.runId===parent.id&&event.type==='error')),/Fixture inheritance unavailable/);
    await f.ctl.queue.tick();assert.equal(f.ctl.queue.workerStatuses()[0]?.error,null);assert.equal(f.worker.submissions.length,1);
  }finally{await f.close();}
});

test('automatic improvement cannot exceed the task-tree limit after the parent delegates its remaining slots',async()=>{
  const f=await fixture();try{
    const conversation=f.ctl.store.newConversation(),parent=f.ctl.store.enqueue(conversation.id,'Coordinate bounded children',randomUUID());await f.ctl.queue.tick();
    for(let index=0;index<31;index++)f.ctl.store.enqueue(f.ctl.store.newConversation().id,`Delegated fixture ${index}`,randomUUID(),'user',parent.id,{taskType:'delegated',requiredConnectorIds:[]});
    f.worker.finish();assert.equal(f.ctl.store.runs().length,32);assert.equal(f.ctl.store.runs().some(run=>run.kind==='improvement'),false);assert.equal(f.ctl.store.run(parent.id)?.status,'completed');assert.match(JSON.stringify(f.ctl.store.events().filter(event=>event.runId===parent.id&&event.type==='error')),/32 tasks/);
  }finally{await f.close();}
});

test('automatic improvement truncates its summary within the inherited prompt capacity',async()=>{
  const f=await fixture();try{
    const conversation=f.ctl.store.newConversation(),parent=f.ctl.store.enqueue(conversation.id,'Inspect data',randomUUID(),'user',null,{maxContextChars:2000});await f.ctl.queue.tick();f.ctl.store.db.prepare('UPDATE runs SET summary=? WHERE id=?').run('Detailed observation '.repeat(300),parent.id);f.worker.finish();
    const child=f.ctl.store.runs().find(run=>run.parentRunId===parent.id)!;assert(child);assert.equal(child.maxContextChars,2000);assert.equal(child.prompt.length,1000);assert.match(child.prompt,/Detailed observation/);assert.match(child.prompt,/Do not repeat host actions/);assert(child.prompt.endsWith('then finish.'));
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,2);assert.equal(f.ctl.store.run(child.id)?.status,'running');
  }finally{await f.close();}
});

test('a context budget too small for improvement instructions skips the optional follow-up',async()=>{
  const f=await fixture();try{
    const conversation=f.ctl.store.newConversation(),parent=f.ctl.tasks.submit(conversation.id,{prompt:'Inspect data',requestId:randomUUID(),maxContextChars:1100});await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);f.worker.finish();
    assert.equal(f.ctl.store.run(parent.id)?.status,'completed');assert.equal(f.ctl.store.runs().length,1);assert.match(JSON.stringify(f.ctl.store.events().filter(event=>event.runId===parent.id&&event.type==='error')),/too small for an improvement prompt/);assert.equal(f.ctl.queue.workerStatuses()[0]?.error,null);
  }finally{await f.close();}
});
