import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import type { Config } from '../src/config.ts';
import type { Brain } from '../src/brain/index.ts';
import type { WorkerClient } from '../src/ipc.ts';

test('SQLite migration, durable enqueue/idempotency, transitions and ordered replay',()=>{
  const dir=mkdtempSync(join(tmpdir(),'operator-core-'));let store=new Store(dir);
  try{
    assert.equal(store.db.prepare('PRAGMA journal_mode').get()?.journal_mode,'wal');
    assert.equal(store.db.prepare('PRAGMA foreign_keys').get()?.foreign_keys,1);
    const c=store.newConversation(),r=store.enqueue(c.id,'Inspect the fixture','request_1');
    assert.equal(store.enqueue(c.id,'Inspect the fixture','request_1').id,r.id);
    assert.throws(()=>store.enqueue(c.id,'Different request','request_1'),/different input/);
    store.transition(r.id,'running');
    const r2=store.enqueue(c.id,'Second task','request_2');
    assert.throws(()=>store.transition(r2.id,'running'),/UNIQUE/);
    const event=(cursor:number,type:string,data:any)=>({cursor,runId:r.id,type,data,createdAt:'2026-11-01T12:30:00.000Z'});
    store.ingest(event(1,'thread',{threadId:'real_thread_mapping'}));
    store.ingest(event(2,'delta',{text:'Result ',itemId:'m1'}));
    assert.equal(store.ingest(event(2,'delta',{text:'Result ',itemId:'m1'})),false);
    store.ingest(event(3,'clarification',{requestId:'12',questions:[]}));
    assert.equal(store.run(r.id)?.status,'waiting');
    store.transition(r.id,'running');
    store.ingest(event(4,'delta',{text:'recorded.',itemId:'m1'}));
    store.ingest(event(5,'completed',{status:'completed'}));
    assert.equal(store.messages(c.id).filter(m=>m.role==='assistant')[0].content,'Result recorded.');
    assert.equal(store.conversation(c.id)?.threadId,'real_thread_mapping');
    assert.throws(()=>store.transition(r.id,'running'),/Invalid run transition/);
    const events=store.events();assert.equal(new Set(events.map(e=>e.seq)).size,events.length);
    assert.equal(events.find(e=>e.type==='thread')?.createdAt,'2026-11-01T12:30:00.000Z');
    assert.deepEqual(store.events(events[2].seq).map(e=>e.seq),events.slice(3).map(e=>e.seq));
    store.close();store=new Store(dir);
    assert.equal(store.run(r.id)?.status,'completed');assert.equal(store.queued()?.id,r2.id);
    assert.equal(store.messages(c.id).find(m=>m.role==='assistant')?.content,'Result recorded.');
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

test('uncertain worker termination remains an active blocking run until explicitly reconciled',()=>{
  const dir=mkdtempSync(join(tmpdir(),'operator-uncertain-')),store=new Store(dir);
  try{
    const c=store.newConversation(),run=store.enqueue(c.id,'Owned execution','uncertain');store.transition(run.id,'running');
    store.ingest({cursor:1,runId:run.id,type:'completed',data:{status:'failed',uncertain:true,error:{message:'Owned group still exists'}},createdAt:new Date().toISOString()});
    assert.equal(store.active()?.id,run.id);assert.equal(store.run(run.id)?.status,'uncertain');assert.equal(store.run(run.id)?.finishedAt,null);
    assert.match(store.run(run.id)!.error!,/Owned group/);
    const next=store.enqueue(c.id,'Next','following');assert.throws(()=>store.transition(next.id,'running'),/UNIQUE/);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});

class FixtureWorker extends EventEmitter {
  activeRunId:string|null=null;events:any[]=[];submissions:any[]=[];acks:number[]=[];duringSync?:any;
  health(){return {connected:true,uid:1000,pid:999999,root:false,runtime:{available:true,version:'fixture',authenticated:true,detail:'Test double'},activeRunId:this.activeRunId,uncertainRuns:[]};}
  async connect(){return this.health();}
  async request(method:string,params:any):Promise<any>{
    if(method==='health')return this.health();
    if(method==='sync'){if(this.duringSync)this.emit('event',this.duringSync);return {health:this.health(),events:this.events.filter(e=>e.cursor>params.after),activeRunId:this.activeRunId,knownRuns:[]};}
    if(method==='submit'){this.submissions.push(params);this.activeRunId=params.runId;return {accepted:true};}
    if(method==='acknowledge'){this.acks.push(params.cursor);return{};}
    if(method==='interrupt'){this.emitEvent(params.runId,'completed',{status:'interrupted'});return{requested:true};}
    if(method==='resolve'){return{resolved:true};}
    return {};
  }
  emitEvent(runId:string,type:string,data:any){const event={cursor:this.events.length+1,runId,type,data,createdAt:new Date().toISOString()};this.events.push(event);if(type==='completed')this.activeRunId=null;this.emit('event',event);}
  close(){}
}
const brain={ensureFoundation:async()=>{},bootstrap:()=>'',snapshotSkills:()=>[],recordLoadedSkills:()=>{},recordRunOutcome:()=>{}} as unknown as Brain;
function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-queue-')),store=new Store(stateDir),worker=new FixtureWorker();
  const config={stateDir,improvementEnabled:false} as Config,queue=new Queue(config,store,brain,worker as unknown as WorkerClient);
  return {stateDir,store,worker,queue,close(){queue.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}
test('queue serializes two runs, reconnects without resubmission, and observes interruption',async()=>{
  const f=fixture();try{
    const c=f.store.newConversation(),a=f.store.enqueue(c.id,'A','A'),b=f.store.enqueue(c.id,'B','B');
    await f.queue.tick();assert.equal(f.worker.submissions.length,1);assert.equal(f.store.run(b.id)?.status,'queued');
    f.worker.emit('disconnect');await f.queue.tick();assert.equal(f.worker.submissions.length,1);
    f.worker.emitEvent(a.id,'completed',{status:'completed'});await f.queue.tick();
    assert.equal(f.worker.submissions.length,2);assert.equal(f.worker.activeRunId,b.id);
    await f.queue.interrupt(b.id);assert.equal(f.store.run(b.id)?.status,'interrupted');
  }finally{f.close();}
});
test('uncertain runs block queue and are never silently repeated',async()=>{
  const f=fixture();try{
    const c=f.store.newConversation(),a=f.store.enqueue(c.id,'Side effect','lost'),b=f.store.enqueue(c.id,'Next','next');
    f.store.transition(a.id,'running');await f.queue.tick();
    assert.equal(f.store.run(a.id)?.status,'uncertain');assert.equal(f.worker.submissions.length,0);
    await f.queue.tick();assert.equal(f.store.run(b.id)?.status,'queued');
    await f.queue.resolve(a.id);await f.queue.tick();assert.equal(f.worker.submissions.length,1);assert.equal(f.worker.activeRunId,b.id);
  }finally{f.close();}
});
test('reconciliation merges live events and worker replay in cursor order without duplication',async()=>{
  const f=fixture();try{
    const c=f.store.newConversation(),run=f.store.enqueue(c.id,'Live reconnect','merge');f.store.transition(run.id,'running');f.worker.activeRunId=run.id;
    const first={cursor:1,runId:run.id,type:'delta',data:{text:'1',itemId:'i'},createdAt:new Date().toISOString()};
    const second={...first,cursor:2,data:{text:'2',itemId:'i'}};
    f.worker.events=[first,second];f.worker.duringSync=second;
    await f.queue.tick();
    assert.deepEqual(f.store.events().filter(e=>e.type==='delta').map(e=>(e.data as any).text),['1','2']);
    assert.equal(f.worker.submissions.length,0);
  }finally{f.close();}
});

test('reconnect drains paged history before merging live events and acknowledging durable cursor',async()=>{
  const f=fixture();try{
    const c=f.store.newConversation(),run=f.store.enqueue(c.id,'Paged reconnect','paged');f.store.transition(run.id,'running');f.worker.activeRunId=run.id;
    const events=[1,2,3].map(cursor=>({cursor,runId:run.id,type:'delta',data:{text:String(cursor),itemId:'i'},createdAt:new Date().toISOString()}));
    const original=f.worker.request.bind(f.worker);const pages:number[]=[];
    f.worker.request=async(method:string,params:any)=>{
      if(method!=='sync')return original(method,params);
      pages.push(params.after);
      if(params.after===0){f.worker.emit('event',events[2]);return {health:f.worker.health(),events:[events[0]],activeRunId:run.id,hasMore:true,nextCursor:1};}
      return {health:f.worker.health(),events:[events[1],events[2]],activeRunId:run.id,hasMore:false,nextCursor:3};
    };
    await f.queue.tick();
    assert.deepEqual(pages,[0,1]);assert.deepEqual(f.store.events().filter(e=>e.type==='delta').map(e=>(e.data as any).text),['1','2','3']);
    assert.equal(f.store.setting('worker_cursor'),'3');assert.equal(f.worker.acks.at(-1),3);assert.equal(f.worker.submissions.length,0);
  }finally{f.close();}
});
