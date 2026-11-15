import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { once } from 'node:events';
import { replaceIdleNonRootWorker } from '../src/root-worker.ts';
import { WorkerClient } from '../src/ipc.ts';
import { WorkerServer } from '../src/worker.ts';
import type { Config } from '../src/config.ts';
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
