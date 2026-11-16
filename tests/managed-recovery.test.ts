import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';

const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
class RecoveryWorker extends EventEmitter {
  activeRunId:string|null=null;submissions:any[]=[];beforeSubmit?:(input:any)=>void;
  health(){return {connected:true,uid:0,executionUid:0,root:true,pid:1234,activeRunId:this.activeRunId,uncertainRuns:[],runtimeOperations:[],runtime:{available:true,authenticated:true,version:'fixture',detail:'No model, service manager or provider actions'}};}
  async connect(){return this.health();}
  async request(method:string,input:any={}){
    if(method==='health')return this.health();
    if(method==='sync')return {health:this.health(),events:[],hasMore:false,activeRunId:this.activeRunId};
    if(method==='acknowledge')return {ok:true};
    if(method==='submit'){this.beforeSubmit?.(input);this.submissions.push(input);this.activeRunId=input.runId;return {accepted:true};}
    throw new Error(`Unexpected recovery fixture RPC ${method}`);
  }
  close(){}
}
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-managed-recovery-')),repositoryPath=join(root,'owner'),stateDir=join(root,'state');mkdirSync(repositoryPath);mkdirSync(stateDir,{mode:0o700});
  git(repositoryPath,'init','--quiet','-b','main');writeFileSync(join(repositoryPath,'owner.txt'),'Owner baseline\n');git(repositoryPath,'add','owner.txt');git(repositoryPath,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','Owner baseline');
  writeFileSync(join(repositoryPath,'owner.txt'),'Owner staged work\n');git(repositoryPath,'add','owner.txt');writeFileSync(join(repositoryPath,'owner.txt'),'Owner unstaged work\n');writeFileSync(join(repositoryPath,'notes.txt'),'Owner untracked work\n');
  const owner={head:git(repositoryPath,'rev-parse','HEAD'),status:git(repositoryPath,'status','--porcelain=v1'),index:readFileSync(join(repositoryPath,'.git','index')),staged:git(repositoryPath,'diff','--cached')};
  const config:Config={stateDir,repositoryPath,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'recovery-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:true};
  initState(config);let worker=new RecoveryWorker();
  let ctl=await createController(config,{client:worker as unknown as WorkerClient,startQueue:false,startBridge:false});ctl.brain.skillAction('skill-maintenance','disable');
  return {root,config,owner,get ctl(){return ctl;},get worker(){return worker;},
    async reopen(){await ctl.close();worker=new RecoveryWorker();ctl=await createController(config,{client:worker as unknown as WorkerClient,startQueue:false,startBridge:false});return ctl;},
    verifyOwner(){assert.equal(git(repositoryPath,'rev-parse','HEAD'),owner.head);assert.equal(git(repositoryPath,'status','--porcelain=v1'),owner.status);assert.deepEqual(readFileSync(join(repositoryPath,'.git','index')),owner.index);assert.equal(git(repositoryPath,'diff','--cached'),owner.staged);assert.equal(readFileSync(join(repositoryPath,'owner.txt'),'utf8'),'Owner unstaged work\n');},
    async close(){await ctl.close();rmSync(root,{recursive:true,force:true});},
  };
}
function deferred(){let resolve!:()=>void;return {promise:new Promise<void>(ready=>{resolve=ready;}),resolve:()=>resolve()};}
async function entered(promise:Promise<void>){let timeout:NodeJS.Timeout|undefined;try{await Promise.race([promise,new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Fixture did not reach connector snapshot')),5000);})]);}finally{if(timeout)clearTimeout(timeout);}}

test('terminal source finalization survives controller restart and commits before another task is submitted',async()=>{
  const f=await fixture();
  try{
    const project=await f.ctl.managed.createProject({name:'Recover generated edits',managed:true}),conversation=f.ctl.projects.newConversation(project.id);
    const run=f.ctl.store.enqueue(conversation.id,'Write a source module','recovery-first');f.ctl.store.transition(run.id,'running');
    const original=await f.ctl.managed.readSource(project.id),count=git(original.source.workspacePath,'rev-list','--count','operator/generated');
    writeFileSync(join(original.source.workspacePath,'recovered.mjs'),'export const recovered = true;\n');
    const terminal={cursor:1,runId:run.id,type:'completed',data:{status:'completed'},createdAt:new Date().toISOString()};
    // Simulate durable completion/ACK followed by a crash before Queue.receive can finalize Git.
    assert.equal(f.ctl.store.ingest(terminal),true);assert.equal(f.ctl.store.setting('worker_cursor'),'1');
    assert.equal((f.ctl.store.db.prepare('SELECT state FROM source_finalizations WHERE runId=?').get(run.id) as {state:string}).state,'pending');
    await f.reopen();
    assert.equal((f.ctl.store.db.prepare('SELECT state FROM source_finalizations WHERE runId=?').get(run.id) as {state:string}).state,'pending');
    assert.equal(f.ctl.store.ingest(terminal),false);
    const next=f.ctl.store.enqueue(conversation.id,'Continue after recovery','recovery-next');
    f.worker.beforeSubmit=()=>assert.equal((f.ctl.store.db.prepare('SELECT state FROM source_finalizations WHERE runId=?').get(run.id) as {state:string}).state,'committed');
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);assert.equal(f.worker.submissions[0].runId,next.id);
    const saved=await f.ctl.managed.readSource(project.id);assert.equal(saved.files['recovered.mjs'],'export const recovered = true;\n');assert.equal(saved.source.dirty,false);assert.notEqual(saved.source.commit,original.source.commit);
    assert.equal(Number(git(saved.source.workspacePath,'rev-list','--count','operator/generated')),Number(count)+1);assert.match(git(saved.source.workspacePath,'log','-1','--format=%B'),new RegExp(run.id));
    const checkpoints=()=>f.ctl.store.events(0,conversation.id).filter(event=>event.runId===run.id&&event.type==='checkpoint'&&event.data&&typeof event.data==='object'&&'source' in event.data).length;
    assert.equal(checkpoints(),1);await f.ctl.managed.recoverSource();await f.ctl.managed.recoverSource();await f.ctl.managed.finishRun(f.ctl.store.run(run.id)!);
    assert.equal(checkpoints(),1);assert.equal(git(saved.source.workspacePath,'rev-list','--count','operator/generated'),String(Number(count)+1));f.verifyOwner();
  }finally{await f.close();}
});

test('source association recovers a committed package without a database row or an extra Git commit',async()=>{
  const f=await fixture();
  try{
    const project=f.ctl.projects.create({name:'Recover connector source',description:'Commit succeeded before database association'});
    const created=await f.ctl.managed.repository.create({id:project.id,kind:'connector',name:project.name,description:project.description,template:'connector'});
    assert.equal(f.ctl.store.db.prepare('SELECT 1 FROM project_sources WHERE projectId=?').get(project.id),undefined);
    const count=git(created.source.workspacePath,'rev-list','--count','operator/generated');await f.reopen();
    const attached=await f.ctl.managed.createSource(project.id,{kind:'connector',template:'connector'});
    assert.equal(attached.source.commit,created.source.commit);assert.equal(attached.manifest.kind,'connector');assert.deepEqual(attached.files,created.files);assert.equal(f.ctl.projects.get(project.id).source?.commit,created.source.commit);
    const again=await f.ctl.managed.createSource(project.id,{kind:'connector',template:'connector'});assert.equal(again.source.commit,created.source.commit);assert.equal(git(created.source.workspacePath,'rev-list','--count','operator/generated'),count);f.verifyOwner();
  }finally{await f.close();}
});

test('cancelling a queued task while connector snapshots are loading prevents submission without disconnecting',async()=>{
  const f=await fixture(),ready=deferred(),release=deferred();
  try{
    const conversation=f.ctl.store.newConversation('Queued cancellation'),run=f.ctl.store.enqueue(conversation.id,'A queued fixture task','cancel-during-snapshot');
    f.ctl.connectors.snapshots=async()=>{ready.resolve();await release.promise;return [];};
    const tick=f.ctl.queue.tick();await entered(ready.promise);await f.ctl.queue.interrupt(run.id);release.resolve();await tick;
    assert.equal(f.worker.submissions.length,0);assert.equal(f.ctl.store.run(run.id)?.status,'interrupted');assert.equal(f.ctl.queue.status().worker?.uid,0);assert.equal(f.ctl.queue.status().workerError,null);
  }finally{release.resolve();await f.close();}
});

test('a completed authentication cycle during connector snapshots defers dispatch until refreshed health',async()=>{
  const f=await fixture(),ready=deferred(),release=deferred();
  try{
    const conversation=f.ctl.store.newConversation('Authentication generation'),run=f.ctl.store.enqueue(conversation.id,'A queued fixture task','auth-during-snapshot');
    f.ctl.connectors.snapshots=async()=>{ready.resolve();await release.promise;return [];};
    const tick=f.ctl.queue.tick();await entered(ready.promise);const releaseAuthentication=f.ctl.queue.holdAuthentication();releaseAuthentication();release.resolve();await tick;
    assert.equal(f.worker.submissions.length,0);assert.equal(f.ctl.store.run(run.id)?.status,'queued');assert.equal(f.ctl.queue.status().worker?.uid,0);assert.equal(f.ctl.queue.status().workerError,null);
    f.ctl.connectors.snapshots=async()=>[];await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);assert.equal(f.worker.submissions[0].runId,run.id);
  }finally{release.resolve();await f.close();}
});
