import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,readFileSync,rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import { initState,type Config } from '../src/config.ts';
import { ProjectService } from '../src/projects/service.ts';
import { TaskService } from '../src/tasks/service.ts';
import { JobService } from '../src/jobs/service.ts';
import { nextScheduledAt,parseCron } from '../src/jobs/schedule.ts';
import type { WorkerClient } from '../src/ipc.ts';

class FixtureWorker extends EventEmitter {
  journalId=randomUUID();activeRunId:string|null=null;submissions:any[]=[];events:any[]=[];calls:Array<{method:string;input:any}>=[];cursor=0;online=true;
  constructor(readonly id:string,readonly model:string){super();}
  health(){return {connected:true as const,uid:process.getuid!(),executionUid:process.getuid!(),pid:1234,root:false,workerId:this.id,journalId:this.journalId,model:this.model,projectsDir:undefined,activeRunId:this.activeRunId,uncertainRuns:[],runtimeOperations:[],runtime:{available:true,authenticated:true,version:'isolated fixture',detail:'No model or broker execution',model:this.model}};}
  async connect(){if(!this.online)throw new Error('Fixture is offline');return this.health();}
  async request(method:string,input:any={}){
    this.calls.push({method,input});if(!this.online)throw new Error('Fixture is offline');
    if(method==='health')return this.health();if(method==='sync')return {health:this.health(),activeRunId:this.activeRunId,events:this.events.filter(event=>event.cursor>input.after),hasMore:false};
    if(method==='acknowledge')return {ok:true};
    if(method==='submit'){this.activeRunId=input.runId;this.submissions.push(input);return {accepted:true};}
    if(method==='interrupt'){this.complete(input.runId,'interrupted');return {interrupted:true};}
    if(method==='resolve')return {resolved:true};throw new Error(`Unexpected fixture method ${method}`);
  }
  complete(runId:string,status='completed') {this.activeRunId=null;const accepted=this.submissions.find(value=>value.runId===runId);const event={cursor:++this.cursor,runId,type:'completed',data:{status},createdAt:new Date().toISOString(),workerId:this.id,journalId:this.journalId,attemptId:accepted?.attemptId};this.events.push(event);this.emit('event',event);}
  close(){}
}
function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-platform-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'fixture-password-only',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};initState(config);
  const store=new Store(stateDir),offline=new FixtureWorker('default','unused');offline.online=false;
  const brain={ensureFoundation:async()=>{},bootstrap:()=> 'Operator source is owner maintained.',projectContext:()=>'',snapshotSkills:()=>[],recordLoadedSkills:()=>{},recordRunOutcome:()=>{}};
  const queue=new Queue(config,store,brain as any,offline as unknown as WorkerClient),projects=new ProjectService(config,store,queue.client,()=>false);
  const workers=['routine','builder'].map((id,index)=>{queue.registry.register({id,name:id,model:index?'strong-fixture':'small-fixture'});const worker=new FixtureWorker(id,index?'strong-fixture':'small-fixture');(queue.registry as any).attach(id,worker);return worker;});
  const connectors={get:(id:string)=>({id}),readiness:()=>({ready:true}),snapshots:async()=>[]} as any;
  const tasks=new TaskService(store,queue,projects,connectors);
  return {stateDir,config,store,queue,projects,workers,tasks,close(){queue.close();projects.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('independent projects run concurrently on chosen models with isolated attempts and replay cursors',async()=>{
  const f=fixture();try{
    const runs=f.workers.map(worker=>{const project=f.projects.create({name:worker.id}),conversation=f.projects.newConversation(project.id);return f.store.enqueue(conversation.id,'Analyze a bounded input',randomUUID(),'user',null,{workerId:worker.id});});
    await f.queue.tick();for(const [index,worker] of f.workers.entries()){const run=f.store.run(runs[index]!.id)!;assert.equal(run.status,'running');assert.equal(run.assignedWorkerId,worker.id);assert.equal(run.model,worker.model);assert(run.attemptId);assert.equal(worker.submissions.length,1);}
    f.workers.forEach((worker,index)=>worker.complete(runs[index]!.id));
    for(const [index,worker] of f.workers.entries()){assert.equal(f.store.run(runs[index]!.id)?.status,'completed');assert.equal(f.store.cursor(worker.id,worker.journalId),1);}
    assert.equal(f.store.events().filter(event=>event.type==='completed').length,2);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_leases').get()?.n,0);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.queue.drainSource();f.close();}
});

test('project writes remain serialized across workers and unknown execution is never reassigned',async()=>{
  const f=fixture();try{
    const project=f.projects.create({name:'Shared source'}),a=f.projects.newConversation(project.id),b=f.projects.newConversation(project.id);
    const first=f.store.enqueue(a.id,'First source edit','first-edit','user',null,{workerId:'routine'}),second=f.store.enqueue(b.id,'Second source edit','second-edit','user',null,{workerId:'builder'});
    await f.queue.tick();assert.equal(f.store.run(first.id)?.status,'running');assert.equal(f.store.run(second.id)?.status,'queued');assert.match(f.store.run(second.id)?.blockedReason??'',/owns this project/);
    f.workers[0]!.online=false;f.store.db.prepare('UPDATE run_attempts SET leaseExpiresAt=? WHERE runId=?').run(new Date(0).toISOString(),first.id);await f.queue.tick();assert.equal(f.store.run(first.id)?.status,'uncertain');assert.equal(f.workers[1]!.submissions.length,0);
    f.workers[0]!.online=true;const journal=f.workers[0]!.journalId;f.workers[0]!.journalId=randomUUID();await assert.rejects(f.queue.resolve(first.id),/journal was replaced/);assert.equal(f.store.run(first.id)?.status,'uncertain');f.workers[0]!.journalId=journal;
    await f.queue.resolve(first.id);await f.queue.tick();assert.equal(f.store.run(second.id)?.status,'running');assert.equal(f.workers[1]!.submissions.length,1);
  }finally{await f.queue.drainSource();f.close();}
});

test('delegation inherits project, connection and execution limits and survives repeated creation requests',async()=>{
  const f=fixture();try{
    const project=f.projects.create({name:'Workflow'}),conversation=f.projects.newConversation(project.id),connection=randomUUID();
    const parent=f.store.enqueue(conversation.id,'Coordinate work','parent','user',null,{workerId:'builder',requiredConnectorIds:[connection],maxToolCalls:8});await f.queue.tick();
    assert.equal(f.store.run(parent.id)?.status,'running');
    const child=f.tasks.create(parent.id,{prompt:'Analyze the prepared snapshot',requestId:'snapshot-1',workerId:'routine'});assert.equal(child.parentRunId,parent.id);assert.equal(child.taskType,'delegated');assert.equal(child.maxToolCalls,8);assert.deepEqual(child.requiredConnectorIds,[connection]);assert.equal(f.store.projects.forConversation(child.conversationId)?.id,project.id);
    assert.equal(f.tasks.create(parent.id,{prompt:'Analyze the prepared snapshot',requestId:'snapshot-1',workerId:'routine'}).id,child.id);
    assert.throws(()=>f.tasks.create(parent.id,{prompt:'Escalate',requestId:'root',requiredRoot:true}),/cannot grant itself root/);
    assert.throws(()=>f.tasks.create(parent.id,{prompt:'More tools',requestId:'budget',maxToolCalls:9}),/increase/);
    assert.throws(()=>f.tasks.create(parent.id,{prompt:'Other secrets',requestId:'secret',requiredConnectorIds:[randomUUID()]}),/cannot add connections/);
    await f.queue.tick();assert.equal(f.store.run(child.id)?.status,'queued');f.workers[1]!.complete(parent.id);await f.queue.tick();assert.equal(f.store.run(child.id)?.status,'running');
  }finally{await f.queue.drainSource();f.close();}
});

test('a task creating its project keeps exclusive source ownership through finalization',async()=>{
  const f=fixture();try{
    const conversation=f.store.newConversation(),parent=f.store.enqueue(conversation.id,'Create a managed application',randomUUID(),'user',null,{workerId:'builder'});
    await f.queue.tick();assert.equal(f.store.run(parent.id)?.status,'running');
    const project=f.projects.createForConversation({name:'Created during execution'},conversation.id),lease=f.store.db.prepare('SELECT * FROM project_leases WHERE projectId=?').get(project.id)!;
    assert.equal(lease.runId,parent.id);assert.equal(lease.attemptId,f.store.run(parent.id)?.attemptId);
    const source={repositoryPath:join(f.stateDir,'fixture-repository'),branch:'operator/generated',path:`generated/projects/${project.id}`,workspacePath:join(f.stateDir,'fixture-source'),commit:'a'.repeat(40),dirty:false};
    f.store.managed.saveSource(project.id,'project',source);
    const nextConversation=f.projects.newConversation(project.id),next=f.store.enqueue(nextConversation.id,'Edit the same source',randomUUID(),'user',null,{workerId:'routine'});
    await f.queue.tick();assert.equal(f.store.run(next.id)?.status,'queued');assert.equal(f.workers[0]!.submissions.length,0);
    f.workers[1]!.complete(parent.id);await f.queue.tick();assert.equal(f.store.run(next.id)?.status,'queued');assert.equal(f.store.managed.pendingFinalizations()[0]?.id,parent.id);
    f.store.sourceFinalized(parent.id,source.commit,source);await f.queue.tick();assert.equal(f.store.run(next.id)?.status,'running');assert.equal(f.workers[0]!.submissions.length,1);
  }finally{await f.queue.drainSource();f.close();}
});

test('linking an executing conversation cannot enter another task project and failed creation rolls back',async()=>{
  const f=fixture();try{
    const project=f.projects.create({name:'Owned project'}),owned=f.projects.newConversation(project.id),generic=f.store.newConversation();
    const owner=f.store.enqueue(owned.id,'Edit source',randomUUID(),'user',null,{workerId:'builder'}),other=f.store.enqueue(generic.id,'Create new work',randomUUID(),'user',null,{workerId:'routine'});
    await f.queue.tick();assert.equal(f.store.run(owner.id)?.status,'running');assert.equal(f.store.run(other.id)?.status,'running');
    assert.throws(()=>f.projects.linkConversation(project.id,generic.id),/Another task owns/);assert.equal(f.store.projects.forConversation(generic.id),undefined);assert.equal(f.store.db.prepare('SELECT runId FROM project_leases WHERE projectId=?').get(project.id)?.runId,owner.id);
    const created=f.projects.createForConversation({name:'Separate project'},generic.id),count=f.projects.list().length;
    assert.throws(()=>f.projects.createForConversation({name:'Rejected duplicate link'},generic.id),/already belongs/);assert.equal(f.projects.list().length,count);assert.equal(f.store.projects.forConversation(generic.id)?.id,created.id);assert.equal(f.store.db.prepare('SELECT runId FROM project_leases WHERE projectId=?').get(created.id)?.runId,other.id);
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.queue.drainSource();f.close();}
});

test('durable jobs deduplicate scheduled and event triggers, avoid overlapping runs, and preserve pause state',()=>{
  const f=fixture();let now=Date.UTC(2026,10,16,12,0);const jobs=new JobService(f.store,f.projects,input=>f.tasks.validate(input),()=>now);
  try{
    const project=f.projects.create({name:'Recurring analysis'}),job=jobs.create({name:'Analyze closed candles',projectId:project.id,prompt:'Analyze prepared data',workerId:'routine',schedule:{type:'interval',seconds:10}});
    now+=10000;jobs.tick();jobs.tick();assert.equal(jobs.get(job.id).history.length,1);const first=jobs.get(job.id).history[0]!,run=f.store.run(first.runId)!;assert.equal(run.taskType,'scheduled');assert.equal(run.workerId,'routine');
    now+=10000;jobs.tick();assert.equal(jobs.get(job.id).history.length,1);assert.match(jobs.get(job.id).blockedReason??'',/previous job run/);
    f.store.transition(run.id,'interrupted');const event=jobs.trigger(job.id,'bar-42',{dataAsOf:'2026-11-16T12:00:00Z',features:{trend:'fixture'}});assert.equal(jobs.trigger(job.id,'bar-42').id,event.id);assert.match(event.prompt,/EVENT DATA/);
    jobs.update(job.id,{enabled:false});now+=10000;jobs.tick();assert.equal(jobs.get(job.id).history.length,2);assert.throws(()=>jobs.trigger(job.id,'bar-43'),/Resume/);
    const reopened=new Store(f.stateDir);try{assert.equal(reopened.db.prepare('SELECT enabled FROM jobs WHERE id=?').get(job.id)?.enabled,0);assert.equal(reopened.runs().length,2);}finally{reopened.close();}
  }finally{jobs.close();f.close();}
});

test('cron scheduling validates expressions and computes calendar/timezone boundaries',()=>{
  assert.equal(nextScheduledAt({type:'cron',expression:'*/15 * * * *',timezone:'UTC'},Date.UTC(2026,10,16,12,7)),'2026-11-16T12:15:00.000Z');
  assert.equal(nextScheduledAt({type:'cron',expression:'0 9 * * MON-FRI',timezone:'Europe/Paris'},Date.UTC(2026,10,16,7,0)),'2026-11-16T08:00:00.000Z');
  for(const expression of ['* * *','80 * * * *','*/0 * * * *','* * * * BAD'])assert.throws(()=>parseCron(expression));
});

test('upgrading legacy state preserves history and receipts and does not restore global serialization on restart',()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-platform-upgrade-')),legacy=new DatabaseSync(join(stateDir,'operator.sqlite')),now=new Date().toISOString();let store:Store|undefined;
  try{
    legacy.exec('PRAGMA foreign_keys=ON');
    for(const [index,file] of ['001-core.sql','002-projects.sql','003-managed-source.sql','004-connector-checks.sql','005-runtime-receipts.sql'].entries()){
      legacy.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));legacy.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,now);
    }
    const conversationId=randomUUID(),runId=randomUUID(),receiptId=`runtime_${randomUUID()}`;
    legacy.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(conversationId,'Existing conversation','legacy-thread',now,now);
    legacy.prepare("INSERT INTO runs(id,conversationId,prompt,status,requestId,createdAt) VALUES(?,?,?,'uncertain',?,?)").run(runId,conversationId,'Retained task','legacy-request',now);
    legacy.prepare('INSERT INTO messages VALUES(?,?,?,?,?,?)').run(randomUUID(),conversationId,runId,'user','Retained task',now);
    legacy.prepare("INSERT INTO events(seq,workerCursor,runId,conversationId,type,data,createdAt) VALUES(17,4,?,?,'delta',?,?)").run(runId,conversationId,JSON.stringify({text:'Retained output'}),now);
    legacy.prepare('INSERT INTO runtime_receipts(operationId,method,projectId,payload,receivedAt,acknowledgedAt) VALUES(?,?,NULL,?,?,?)').run(receiptId,'connectors/call',JSON.stringify({retained:true}),now,now);
    legacy.close();store=new Store(stateDir);
    assert.equal(store.run(runId)?.status,'uncertain');assert.equal(store.messages(conversationId)[0]?.content,'Retained task');assert.equal(store.events()[0]?.seq,17);assert.deepEqual(store.events()[0]?.data,{text:'Retained output'});
    assert.equal(store.ingest({cursor:4,runId,type:'delta',data:{text:'Retained output'},createdAt:now},{workerId:'default',journalId:'upgraded-worker-journal'}),false);assert.equal(store.cursor('default','upgraded-worker-journal'),4);
    const receipt=store.db.prepare('SELECT * FROM runtime_receipts WHERE operationId=?').get(receiptId)!;assert.equal(receipt.workerId,'default');assert.equal(receipt.journalId,'legacy');assert.equal(receipt.acknowledgedAt,now);assert.equal(receipt.payload,JSON.stringify({retained:true}));
    for(const id of ['routine','builder']){
      const conversation=store.newConversation(),run=store.enqueue(conversation.id,'Independent work',`upgraded-${id}`);store.claim(run.id,{id,model:'fixture-model'},{uid:process.getuid!(),journalId:`${id}-journal`,runtime:{model:'fixture-model'}});
    }
    store.close();store=new Store(stateDir);
    assert.equal(store.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n,8);assert.equal(store.db.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name='one_active_run'").get(),undefined);
    assert.equal(store.runs().filter(run=>['running','uncertain'].includes(run.status)).length,3);assert.equal(store.events().filter(event=>event.seq===17).length,1);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{store?.close();if(legacy.isOpen)legacy.close();rmSync(stateDir,{recursive:true,force:true});}
});
