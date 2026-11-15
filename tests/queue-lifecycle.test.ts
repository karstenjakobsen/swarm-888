import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue } from '../src/queue.ts';
import { Store } from '../src/store.ts';
import type { Brain } from '../src/brain/index.ts';
import type { Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';
import type { ManagedService } from '../src/managed/service.ts';
import type { ConnectorService } from '../src/connectors/service.ts';

class FixtureWorker extends EventEmitter {
  calls:string[]=[];
  health={connected:true,uid:1000,pid:999999,root:false,runtime:{available:true,version:'fixture',authenticated:true,detail:'Lifecycle fixture'},activeRunId:null,uncertainRuns:[]};
  async connect(){return this.health;}
  async request(method:string){this.calls.push(method);if(method==='sync')return {health:this.health,events:[],activeRunId:null};return this.health;}
  close(){}
}

test('closing during asynchronous queue preparation stops dispatch and detaches client listeners',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-queue-close-')),store=new Store(stateDir),client=new FixtureWorker();
  let release!:()=>void,ready!:()=>void;
  const preparation=new Promise<void>(resolve=>{release=resolve;}),preparing=new Promise<void>(resolve=>{ready=resolve;});
  const brain={ensureFoundation:async()=>{ready();await preparation;}} as Brain;
  const queue=new Queue({stateDir,improvementEnabled:false} as Config,store,brain,client as unknown as WorkerClient);
  let databaseClosed=false;
  try{
    store.enqueue(store.newConversation().id,'Do not dispatch after shutdown','close-preparing');
    const tick=queue.tick();await preparing;
    queue.close();const calls=[...client.calls];store.close();databaseClosed=true;
    release();await tick;
    assert.deepEqual(client.calls,calls,'No worker request may be sent after shutdown');
    assert.equal(client.listenerCount('event'),0);assert.equal(client.listenerCount('disconnect'),0);
    client.emit('event',{type:'completed'});
  }finally{release();queue.close();if(!databaseClosed)store.close();rmSync(stateDir,{recursive:true,force:true});}
});

test('maintenance enabled during queue preparation leaves work queued',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-queue-maintenance-')),store=new Store(stateDir),client=new FixtureWorker();
  let release!:()=>void,ready!:()=>void;
  const preparation=new Promise<void>(resolve=>{release=resolve;}),preparing=new Promise<void>(resolve=>{ready=resolve;});
  const brain={ensureFoundation:async()=>{ready();await preparation;}} as Brain;
  const queue=new Queue({stateDir,improvementEnabled:false} as Config,store,brain,client as unknown as WorkerClient);
  try{
    const run=store.enqueue(store.newConversation().id,'Pause before submission','maintenance-preparing');
    const tick=queue.tick();await preparing;store.setSetting('maintenance','true');release();await tick;
    assert.equal(store.run(run.id)?.status,'queued');assert(!client.calls.includes('submit'));
  }finally{release();queue.close();store.close();rmSync(stateDir,{recursive:true,force:true});}
});

test('shutdown drains source recovery before its caller can close persistent state',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-source-drain-')),store=new Store(stateDir),client=new FixtureWorker();
  let release!:()=>void,ready!:()=>void,accessed=false;
  const gate=new Promise<void>(resolve=>{release=resolve;}),entered=new Promise<void>(resolve=>{ready=resolve;});
  const queue=new Queue({stateDir,improvementEnabled:false} as Config,store,{ensureFoundation:async()=>{}} as Brain,client as unknown as WorkerClient);
  queue.setManaged({recoverSource:async()=>{ready();await gate;store.setting('maintenance');accessed=true;}} as ManagedService,{} as ConnectorService);
  try{
    const ticking=queue.tick();await entered;queue.close();let drained=false;
    const draining=queue.drainSource().then(()=>{drained=true;});await Promise.resolve();assert.equal(drained,false);
    release();await Promise.all([ticking,draining]);assert.equal(accessed,true);assert(!client.calls.includes('submit'));
  }finally{release();queue.close();await queue.drainSource();store.close();rmSync(stateDir,{recursive:true,force:true});}
});
