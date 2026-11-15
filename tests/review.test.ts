import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import { Brain } from '../src/brain/index.ts';
import { WorkerServer } from '../src/worker.ts';
import { WorkerClient } from '../src/ipc.ts';
import { initState, type Config } from '../src/config.ts';
import { createController } from '../src/controller.ts';

function config(stateDir:string):Config{
  for(const dir of ['secrets','worker','skills','workspaces','runtime','artifacts'])mkdirSync(join(stateDir,dir),{recursive:true,mode:0o700});
  return{stateDir,runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'d'.repeat(64),controllerUid:process.getuid!(),codexBin:'',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'review-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
}
class FixtureAdapter extends EventEmitter{
  version='0.166.0';threadId='fixture-thread';turnId='fixture-turn';
  async start(){} async health(){return{authenticated:true,detail:'Protocol fixture adapter; no model run'};}
  async run(){this.emit('event','thread',{threadId:this.threadId});}
  async interrupt(){this.emit('event','completed',{status:'interrupted'});}reply(){}async close(){}
}

test('real worker ledger permits explicit reconciliation when controller crashed before submission',async()=>{
  const state=mkdtempSync(join(tmpdir(),'operator-review-recovery-')),cfg=config(state),store=new Store(state),brain=new Brain(store.db,state);await brain.initialize();
  const worker=new WorkerServer(cfg,()=>new FixtureAdapter() as any),client=new WorkerClient(cfg),queue=new Queue(cfg,store,brain,client);brain.setExecutor(spec=>client.request('checkSkill',spec));
  try{
    const conversation=store.newConversation(),lost=store.enqueue(conversation.id,'Never repeat this uncertain request','lost-before-submit'),next=store.enqueue(conversation.id,'Next independently queued request','next-after-resolve');
    store.transition(lost.id,'running'); // Durable controller state, no worker acceptance: crash window.
    await worker.listen();await queue.tick();assert.equal(store.run(lost.id)?.status,'uncertain');assert.equal(worker.journal.get(lost.id),undefined);
    await queue.resolve(lost.id);await queue.tick();assert.equal(store.run(lost.id)?.status,'interrupted');assert.equal(worker.journal.get(lost.id),undefined);assert.equal(worker.journal.get(next.id)?.id,next.id);
  }finally{queue.close();await worker.close();store.close();rmSync(state,{recursive:true,force:true});}
});

test('reconnect acknowledges already durable history even when worker replay has no newer events',async()=>{
  const state=mkdtempSync(join(tmpdir(),'operator-review-ack-')),cfg=config(state),store=new Store(state),acknowledged:number[]=[];
  const health={connected:true,uid:process.getuid!(),pid:process.pid,root:process.getuid!()===0,runtime:{available:true,version:'fixture',authenticated:true,detail:'No model execution'},activeRunId:null,uncertainRuns:[]};
  class LedgerFixture extends EventEmitter{
    async connect(){return health;}
    async request(method:string,params:any){if(method==='sync')return{health,events:[],activeRunId:null,knownRuns:[]};if(method==='acknowledge'){acknowledged.push(params.cursor);return{};}if(method==='health')return health;throw new Error('Unexpected fixture method '+method);}
    close(){}
  }
  const brain={ensureFoundation:async()=>{}} as Brain,client=new LedgerFixture(),queue=new Queue(cfg,store,brain,client as unknown as WorkerClient);
  try{
    const conversation=store.newConversation(),run=store.enqueue(conversation.id,'Already persisted completion','ack-before-crash');store.transition(run.id,'running');store.ingest({cursor:42,runId:run.id,type:'completed',data:{status:'completed'},createdAt:new Date().toISOString()});
    // The durable database advanced but the old controller died before sending this ACK.
    await queue.tick();assert.ok(acknowledged.includes(42),'Replay must ACK the durable cursor even when it contains zero newer events');
  }finally{queue.close();store.close();rmSync(state,{recursive:true,force:true});}
});

test('state initialization refuses top-level symlinks that could reuse an unrelated Codex profile',()=>{
  const root=mkdtempSync(join(tmpdir(),'operator-review-path-')),cfg=config(join(root,'state')),unrelated=join(root,'unrelated-profile');mkdirSync(unrelated);
  try{
    rmSync(cfg.runtimeHome,{recursive:true});symlinkSync(unrelated,cfg.runtimeHome);
    assert.throws(()=>initState(cfg),/symlink|canonical|real directory/i);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('web artifact root cannot be redirected by a symlink outside the allowed state root',async()=>{
  const root=mkdtempSync(join(tmpdir(),'operator-review-artifact-')),cfg=config(join(root,'state')),outside=join(root,'outside');mkdirSync(outside);writeFileSync(join(outside,'private.txt'),'private-outside-file');
  const ctl=await createController(cfg,{startQueue:false,startBridge:false});
  try{
    const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:cfg.origins[0]},payload:{password:cfg.adminPassword}});
    const cookie=String(login.headers['set-cookie']).split(';')[0];rmSync(join(cfg.stateDir,'artifacts'),{recursive:true});symlinkSync(outside,join(cfg.stateDir,'artifacts'));
    const result=await ctl.app.inject({method:'GET',url:'/api/artifacts/private.txt',headers:{cookie}});assert.equal(result.statusCode,403);assert.ok(!result.body.includes('private-outside-file'));
  }finally{await ctl.close();rmSync(root,{recursive:true,force:true});}
});
