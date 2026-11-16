import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { replaceIdleNonRootWorker, verifyWorkerReplacementIdentity, type WorkerReplacementIdentity } from '../src/root-worker.ts';
import { WorkerClient } from '../src/ipc.ts';
import { WorkerServer } from '../src/worker.ts';
import { projectRoot, type Config } from '../src/config.ts';
import { EventEmitter } from 'node:events';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-root-launch-'));
  for(const name of ['worker','skills','workspaces','artifacts','runtime','secrets'])mkdirSync(join(stateDir,name),{mode:0o700});
  const config:Config={stateDir,runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'f'.repeat(64),controllerUid:process.getuid!(),codexBin:join(process.cwd(),'node_modules/.bin/codex'),host:'127.0.0.1',port:3001,origins:[],adminPassword:'root-launch-test-only',secureCookie:false,improvementEnabled:false,improvementMaxTurns:1,improvementTimeoutMs:1000,allowTempState:true,requireRootWorker:false};
  writeFileSync(join(stateDir,'secrets/ipc-token'),config.ipcToken,{mode:0o600});
  return {config,close:()=>rmSync(stateDir,{recursive:true,force:true})};
}
const pause=(ms:number)=>new Promise(ok=>setTimeout(ok,ms));

test('privileged launcher refuses to start as a normal user before touching state', {skip:process.getuid?.()===0},async()=>{
  const f=fixture();
  try{
    const result=await new Promise<{code:number|null;error:string}>(resolve=>{
      const child=spawn(process.execPath,['--import','tsx','src/root-worker.ts'],{env:{...process.env,APP_STATE_DIR:f.config.stateDir,APP_ALLOW_TEMP_STATE:'true'},stdio:['ignore','ignore','pipe']});
      let error='';child.stderr.on('data',chunk=>{error+=chunk;});child.once('close',code=>resolve({code,error}));
    });
    assert.equal(result.code,1);assert.match(result.error,/requires sudo/);assert.equal(existsSync(join(f.config.stateDir,'worker/lock.json')),false);
  }finally{f.close();}
});

test('root launcher reserves and shuts down only the verified idle application child', {timeout:30_000,skip:process.getuid?.()===0},async()=>{
  const f=fixture();
  const child=spawn(process.execPath,['--import','tsx','src/worker.ts'],{
    cwd:process.cwd(),env:{...process.env,APP_STATE_DIR:f.config.stateDir,APP_ALLOW_TEMP_STATE:'true',APP_CONTROLLER_UID:String(process.getuid!()),APP_REQUIRE_ROOT_WORKER:'false',CODEX_BIN:f.config.codexBin},stdio:'ignore',
  });
  const client=new WorkerClient(f.config);
  try{
    const deadline=Date.now()+10_000;
    while(true){try{await client.connect();break;}catch{if(Date.now()>deadline||child.exitCode!==null)throw new Error('Fixture worker did not start');await pause(50);}}
    assert.equal((await client.request('health',{})).uid,process.getuid!());
    assert.equal(await replaceIdleNonRootWorker(f.config),true);
    assert.equal(existsSync(join(f.config.stateDir,'worker/lock.json')),false);
    assert.equal(existsSync(f.config.socketPath),false);
  }finally{client.close();if(child.exitCode===null){child.kill('SIGTERM');await Promise.race([once(child,'exit'),pause(3000)]);}f.close();}
});

class ProbeOnlyAdapter extends EventEmitter {
  version='0.166.0';async start(){}async health(){return {authenticated:false,detail:'Test fixture; no model execution'};}async close(){}
}
test('replacement rejects an unverified process and releases its atomic reservation',async()=>{
  const f=fixture(),worker=new WorkerServer(f.config,()=>new ProbeOnlyAdapter() as any),client=new WorkerClient(f.config);
  try{
    await worker.listen();await client.connect();
    await assert.rejects(replaceIdleNonRootWorker(f.config),/Cannot verify the existing worker process identity/);
    assert.equal((await client.request('health',{})).replacementReserved,false);
    assert.equal(JSON.parse(readFileSync(join(f.config.stateDir,'worker/lock.json'),'utf8')).pid,process.pid);
  }finally{client.close();await worker.close();f.close();}
});


test('launcher does not reuse a former protected broker whose agent still executes as a non-root account',async()=>{
  const f=fixture(),worker=new WorkerServer(f.config,()=>new ProbeOnlyAdapter() as any);
  const health=worker.health.bind(worker);
  worker.health=()=>({...health(),uid:0,root:true,executionUid:1234,sourceProtected:true});
  try{
    await worker.listen();
    await assert.rejects(replaceIdleNonRootWorker(f.config),/separate non-root execution account.*Stop it/);
    assert.equal(existsSync(join(f.config.stateDir,'worker/lock.json')),true);
  }finally{await worker.close();f.close();}
});

for(const mode of ['different','missing'] as const)test(`root launcher requires privileged access before replacing ${mode} project-root configuration`,{skip:process.getuid?.()===0},async()=>{
  const f=fixture(),worker=new WorkerServer(f.config,()=>new ProbeOnlyAdapter() as any),health=worker.health.bind(worker),expected=join(f.config.stateDir,'projects'),reported=join(f.config.stateDir,'older-projects');
  worker.health=()=>{const {projectsDir:_directory,...value}=health();return {...value,uid:0,root:true,executionUid:0,...(mode==='different'?{projectsDir:reported}:{})};};
  try{
    await worker.listen();const lock=readFileSync(join(f.config.stateDir,'worker/lock.json'),'utf8');
    await assert.rejects(replaceIdleNonRootWorker(f.config),error=>{const message=String((error as Error).message);assert(message.includes(expected));assert(message.includes(mode==='different'?reported:'unknown (older worker)'));assert.match(message,/Root access is required.*fresh root-worker launch command/);return true;});
    assert.equal(readFileSync(join(f.config.stateDir,'worker/lock.json'),'utf8'),lock);assert.equal(existsSync(f.config.socketPath),true);assert.equal(worker.health().replacementReserved,false);
  }finally{await worker.close();f.close();}
});

test('root replacement verifies both supported entrypoints, UIDs, lock and process identity before signalling',()=>{
  const config={controllerUid:1234},health={pid:4321,uid:0,root:true},base:WorkerReplacementIdentity={lock:{pid:4321,start:'123456'},start:'123456',args:[process.execPath,join(projectRoot,'src/root-worker.ts')],cwd:process.cwd(),realUid:0,effectiveUid:0,callerUid:0,callerEffectiveUid:0};
  assert.doesNotThrow(()=>verifyWorkerReplacementIdentity(config,health,base));
  assert.doesNotThrow(()=>verifyWorkerReplacementIdentity(config,health,{...base,args:[process.execPath,join(projectRoot,'src/worker.ts')]}));
  assert.doesNotThrow(()=>verifyWorkerReplacementIdentity(config,health,{...base,args:[process.execPath,'--env-file-if-exists=/fixture/.env','--import','/fixture/loader.mjs',join(projectRoot,'src/root-worker.ts')]}));
  assert.doesNotThrow(()=>verifyWorkerReplacementIdentity(config,health,{...base,cwd:projectRoot.replace(/\/$/,''),args:[process.execPath,'src/root-worker.ts']}));
  for(const patch of [
    {start:'654321'}, {lock:{pid:9999,start:'123456'}}, {lock:{pid:4321,start:null}},
    {args:[process.execPath,'unrelated.ts']}, {cwd:'/tmp',args:[process.execPath,'src/root-worker.ts']},
    {args:[process.execPath,'unrelated.ts',join(projectRoot,'src/root-worker.ts')]},
    {args:[process.execPath,'-e','console.log("unrelated")',join(projectRoot,'src/worker.ts')]},
    {realUid:1234}, {effectiveUid:1234}, {callerUid:1234}, {callerEffectiveUid:1234},
  ])assert.throws(()=>verifyWorkerReplacementIdentity(config,health,{...base,...patch}),/not been stopped/);
  assert.throws(()=>verifyWorkerReplacementIdentity(config,{...health,root:false},base),/reported identity/);
  assert.throws(()=>verifyWorkerReplacementIdentity(config,{...health,uid:9999,root:false},{...base,realUid:9999,effectiveUid:9999}),/controller/);
});

for(const busy of ['run','uncertain','login','operation'] as const)test(`a mismatched root worker with ${busy} activity is never reserved or replaced`,async()=>{
  const f=fixture(),worker=new WorkerServer(f.config,()=>new ProbeOnlyAdapter() as any),health=worker.health.bind(worker);
  worker.health=()=>({...health(),uid:0,root:true,executionUid:0,projectsDir:join(f.config.stateDir,'old-projects'),...(busy==='run'?{activeRunId:'active-run'}:{}),...(busy==='uncertain'?{uncertainRuns:['uncertain-operation']}:{}),...(busy==='login'?{runtime:{...health().runtime,authenticating:true}}:{}),...(busy==='operation'?{runtimeOperations:[{id:'runtime_fixture',method:'managed/prepare',status:'running' as const,requiresExternalInspection:false}]}:{})});
  try{await worker.listen();const before=readFileSync(join(f.config.stateDir,'worker/lock.json'),'utf8');await assert.rejects(replaceIdleNonRootWorker(f.config),/busy or uncertain/);assert.equal(readFileSync(join(f.config.stateDir,'worker/lock.json'),'utf8'),before);assert.equal(worker.health().replacementReserved,false);}finally{await worker.close();f.close();}
});

test('root launcher reuses a root worker only when its effective project root matches',async()=>{
  const f=fixture(),worker=new WorkerServer(f.config,()=>new ProbeOnlyAdapter() as any),health=worker.health.bind(worker);
  worker.health=()=>({...health(),uid:0,root:true,executionUid:0,projectsDir:join(f.config.stateDir,'projects')});
  try{await worker.listen();assert.equal(await replaceIdleNonRootWorker(f.config),false);assert.equal(existsSync(f.config.socketPath),true);}finally{await worker.close();f.close();}
});
