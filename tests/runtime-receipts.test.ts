import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { RuntimeReceipts } from '../src/runtime-receipts.ts';
import type { WorkerClient } from '../src/ipc.ts';
import type { WorkerRegistry } from '../src/workers/registry.ts';

class ReceiptWorker {
  capability=true;online=true;ackFails=false;connects=0;calls:Array<{method:string;input:any}>=[];
  projectsDir?:string;
  id=`runtime_${randomUUID()}`;payload:Record<string,unknown>={status:'running',detail:'Confirmed fixture effect'};ackId?:string;
  beforeAck?:()=>void;beforeConnect?:()=>Promise<void>;
  async connect(){this.connects++;await this.beforeConnect?.();if(!this.online)throw new Error('Fixture disconnected');return this.capability?{runtimeOperations:[],...(this.projectsDir?{projectsDir:this.projectsDir}:{})}:{uid:0};}
  async request(method:string,input:any){this.calls.push({method,input});if(method==='runtime/acknowledge'){this.beforeAck?.();if(this.ackFails)throw new Error('Fixture ACK lost');return {acknowledged:true,operationId:this.ackId??input.operationId};}return {...this.payload,__runtimeOperationId:this.id};}
}
function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'operator-runtime-receipts-'));let store=new Store(directory);const worker=new ReceiptWorker();
  return {directory,worker,get store(){return store;},get receipts(){return new RuntimeReceipts(store.db,worker as unknown as WorkerClient);},reopen(){store.close();store=new Store(directory);},close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}

test('runtime result receipts are durably stored before ACK and transport metadata is removed',async()=>{
  const f=fixture();
  try{
    const projectId=randomUUID();f.worker.beforeAck=()=>{const row=f.store.db.prepare('SELECT * FROM runtime_receipts WHERE operationId=?').get(f.worker.id) as {payload:string;projectId:string;acknowledgedAt:null};assert.equal(row.projectId,projectId);assert.deepEqual(JSON.parse(row.payload),f.worker.payload);assert.equal(row.acknowledgedAt,null);};
    const result=await f.receipts.request('managed/deploy',{project:{id:projectId}});assert.deepEqual(result,f.worker.payload);assert.equal(Object.hasOwn(result as object,'__runtimeOperationId'),false);
    const receipt=f.receipts.get(f.worker.id);assert.equal(receipt.method,'managed/deploy');assert.equal(receipt.projectId,projectId);assert(receipt.acknowledgedAt);assert.deepEqual(receipt.payload,f.worker.payload);assert.equal(Object.hasOwn(f.receipts.list()[0],'payload'),false);
    assert.deepEqual(f.worker.calls.map(call=>call.method),['managed/deploy','runtime/acknowledge']);
  }finally{f.close();}
});

test('lost ACKs return confirmed results and restart recovery ACKs receipts without repeating effects',async()=>{
  const f=fixture();
  try{
    f.worker.ackFails=true;assert.deepEqual(await f.receipts.request('connectors/call',{name:'mutate'}),f.worker.payload);assert.equal(f.receipts.list()[0].acknowledgedAt,null);
    f.reopen();f.worker.ackFails=false;const effects=f.worker.calls.filter(call=>call.method==='connectors/call').length;const receipts=f.receipts;
    assert.equal(await receipts.recover(),true);assert.equal(await receipts.recover(),false);assert.equal(f.worker.calls.filter(call=>call.method==='connectors/call').length,effects);assert.equal(effects,1);assert(receipts.list()[0].acknowledgedAt);
  }finally{f.close();}
});

test('receipt recovery ACKs healthy owners despite offline or changed journals and never repeats effects',async()=>{
  const f=fixture();
  class OwnedWorker extends ReceiptWorker {
    journalId=randomUUID();constructor(readonly workerId:string){super();}
    async connect(){return {...await super.connect(),workerId:this.workerId,journalId:this.journalId};}
  }
  const offline=new OwnedWorker('offline'),healthy=new OwnedWorker('healthy'),replaced=new OwnedWorker('replaced'),workers=[offline,healthy,replaced],clients=new Map(workers.map(worker=>[worker.workerId,worker]));let selected=offline;
  const control={connect:()=>selected.connect()} as unknown as WorkerClient,registry={client:(id:string)=>{const worker=clients.get(id);assert(worker,`Unexpected worker owner ${id}`);return worker;}} as unknown as WorkerRegistry;
  try{
    let receipts=new RuntimeReceipts(f.store.db,control,undefined,registry);
    for(const [index,worker] of workers.entries()){
      selected=worker;worker.ackFails=true;await receipts.request('connectors/call',{name:'mutate'});
      f.store.db.prepare('UPDATE runtime_receipts SET receivedAt=? WHERE operationId=?').run(new Date(index*1000).toISOString(),worker.id);
      assert.equal(receipts.get(worker.id).workerId,worker.workerId);assert.equal(receipts.get(worker.id).journalId,worker.journalId);
    }
    f.reopen();receipts=new RuntimeReceipts(f.store.db,control,undefined,registry);offline.online=false;healthy.ackFails=false;replaced.ackFails=false;const originalJournal=replaced.journalId;replaced.journalId=randomUUID();
    const recovery=receipts.recover();assert.equal(receipts.recover(),recovery,'Concurrent recovery must share the same ACK pass');
    await assert.rejects(recovery,error=>{assert(error instanceof AggregateError);assert.equal(error.errors.length,2);assert.equal((error as AggregateError&{statusCode:number}).statusCode,503);assert.match(error.message,/offline.*Fixture disconnected/);assert.match(error.message,/replaced.*journal owner changed/);return true;});
    assert(receipts.get(healthy.id).acknowledgedAt);assert.equal(receipts.get(offline.id).acknowledgedAt,null);assert.equal(receipts.get(replaced.id).acknowledgedAt,null);
    assert.equal(offline.calls.filter(call=>call.method==='runtime/acknowledge').length,1,'No ACK may be sent while its owner is unavailable');
    assert.equal(replaced.calls.filter(call=>call.method==='runtime/acknowledge').length,1,'A new journal cannot ACK the original journal receipt');
    const healthyCalls=healthy.calls.length,healthyConnects=healthy.connects;await assert.rejects(receipts.recover(),/ACK recovery incomplete/);assert.equal(healthy.calls.length,healthyCalls);assert.equal(healthy.connects,healthyConnects);
    offline.online=true;offline.ackFails=false;replaced.journalId=originalJournal;assert.equal(await receipts.recover(),true);assert.equal(await receipts.recover(),false);
    for(const worker of workers){assert(receipts.get(worker.id).acknowledgedAt);assert.equal(worker.calls.filter(call=>call.method==='connectors/call').length,1);assert(worker.calls.filter(call=>call.method==='runtime/acknowledge').every(call=>call.input.operationId===worker.id));}
  }finally{f.close();}
});

test('a persistence error never ACKs an external result',async()=>{
  const f=fixture();
  try{
    f.store.db.exec("CREATE TRIGGER reject_receipt BEFORE INSERT ON runtime_receipts BEGIN SELECT RAISE(ABORT,'Fixture durable storage failure'); END;");
    await assert.rejects(f.receipts.request('connectors/call',{}),/durable storage failure/);assert.deepEqual(f.worker.calls.map(call=>call.method),['connectors/call']);assert.equal(f.receipts.list().length,0);
  }finally{f.close();}
});

test('old workers and stale pre-dispatch guards cannot start effects, while empty recovery stays offline',async()=>{
  const f=fixture();
  try{
    assert.equal(await f.receipts.recover(),false);assert.equal(f.worker.connects,0);
    f.worker.capability=false;await assert.rejects(f.receipts.request('managed/stop',{}),error=>(error as {statusCode:number}).statusCode===409);assert.equal(f.worker.calls.length,0);
    f.worker.capability=true;let current=true;f.worker.beforeConnect=async()=>{current=false;};
    await assert.rejects(f.receipts.request('connectors/call',{},()=>{if(!current)throw new Error('Connection changed during connect');}),/changed during connect/);assert.equal(f.worker.calls.length,0);
    f.worker.beforeConnect=undefined;f.worker.online=false;await assert.rejects(f.receipts.request('managed/deploy',{}),error=>(error as {statusCode:number}).statusCode===503);
  }finally{f.close();}
});

test('invalid or conflicting receipt identities never ACK, and mismatched ACKs remain recoverable',async()=>{
  const f=fixture();
  try{
    f.worker.id='not-a-runtime-id';await assert.rejects(f.receipts.request('connectors/call',{}));assert.equal(f.worker.calls.filter(call=>call.method==='runtime/acknowledge').length,0);
    f.worker.id=`runtime_${randomUUID()}`;f.worker.ackId=`runtime_${randomUUID()}`;assert.deepEqual(await f.receipts.request('connectors/call',{}),f.worker.payload);assert.equal(f.receipts.list()[0].acknowledgedAt,null);
    f.worker.payload={status:'changed'};await assert.rejects(f.receipts.request('managed/stop',{}),/reused/);assert.equal(f.worker.calls.filter(call=>call.method==='runtime/acknowledge').length,1);
    f.worker.ackId=undefined;assert.equal(await f.receipts.recover(),true);assert(f.receipts.list()[0].acknowledgedAt);
  }finally{f.close();}
});

test('project-root mismatches and older workers are rejected before any runtime request or receipt',async()=>{
  const f=fixture();
  try{
    const controllerRoot=join(f.directory,'controller-projects'),workerRoot=join(f.directory,'worker-projects');
    const receipts=new RuntimeReceipts(f.store.db,f.worker as unknown as WorkerClient,controllerRoot);
    const input={project:{id:randomUUID(),directory:join(controllerRoot,'local-connector')}};
    f.worker.projectsDir=workerRoot;
    await assert.rejects(receipts.request('managed/prepare',input),error=>{assert.equal((error as {statusCode:number}).statusCode,409);assert((error as Error).message.includes(controllerRoot));assert((error as Error).message.includes(workerRoot));return true;});
    f.worker.projectsDir=undefined;await assert.rejects(receipts.request('managed/prepare',input),/running worker does not report.*APP_PROJECTS_DIR/);
    f.worker.projectsDir=controllerRoot;
    await assert.rejects(receipts.request('managed/prepare',{project:{id:randomUUID(),directory:join(workerRoot,'old-registered-project')}}),/saved path has not been changed/);
    assert.equal(f.worker.calls.length,0);assert.equal(receipts.list().length,0);
    await receipts.request('managed/prepare',input);assert.equal(f.worker.calls[0].method,'managed/prepare');
  }finally{f.close();}
});
