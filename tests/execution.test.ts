import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { runtimeEnvironment } from '../src/runtime/codex.ts';
import { executionCommand, executionEnvironment, prepareExecutionDirectory } from '../src/runtime/execution.ts';
import { forwardToolRequest } from '../src/runtime/tool-proxy.ts';
import { initState, type Config } from '../src/config.ts';
import { WorkerServer } from '../src/worker.ts';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-root-execution-'));
  const config:Config={stateDir,runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'fixture-password',secureCookie:false,improvementEnabled:false,improvementMaxTurns:1,improvementTimeoutMs:1000,allowTempState:true,projectsDir:join(stateDir,'projects')};
  initState(config);return {config,close:()=>rmSync(stateDir,{recursive:true,force:true})};
}

test('execution commands inherit the actual worker identity without a dedicated account or privilege-drop wrapper',async()=>{
  const f=fixture();
  try{
    const invocation=executionCommand(f.config,process.execPath,['-e','console.log(process.getuid())']);
    assert.equal(invocation.command,process.execPath);
    const child=spawn(invocation.command,invocation.args,{env:executionEnvironment(f.config),stdio:['ignore','pipe','pipe']});
    let output='';child.stdout.on('data',chunk=>{output+=chunk;});
    const [code]=await once(child,'exit');assert.equal(code,0);assert.equal(output.trim(),String(process.getuid!()));
    prepareExecutionDirectory(f.config,join(f.config.projectsDir!,'fixture'));
    assert.equal(statSync(join(f.config.projectsDir!,'fixture')).uid,f.config.controllerUid);
    await assert.rejects(Promise.resolve().then(()=>prepareExecutionDirectory(f.config,join(f.config.stateDir,'outside'))),/workspace/);
  }finally{f.close();}
});

test('workspace preparation rejects symlinked parents before creating files outside the workspace',()=>{
  const f=fixture(),outside=join(f.config.stateDir,'outside');
  try{
    mkdirSync(outside);symlinkSync(outside,join(f.config.projectsDir!,'escape'));
    assert.throws(()=>prepareExecutionDirectory(f.config,join(f.config.projectsDir!,'escape','created')),/canonical/);
    assert.equal(existsSync(join(outside,'created')),false);
  }finally{f.close();}
});

test('root mode retains a dedicated Codex profile and keeps controller credentials out of its child environment',()=>{
  const previous=process.env;
  try{
    process.env={...previous,ADMIN_PASSWORD:'fixture-admin',APP_BRIDGE_TOKEN:'fixture-master',APP_STATE_DIR:'/private/controller',APP_CONTROLLER_UID:'1000'};
    const config={stateDir:'/private/controller',runtimeHome:'/private/controller/runtime'} as Config;
    const env=runtimeEnvironment(config,'fixture-run');
    assert.equal(env.CODEX_HOME,config.runtimeHome);assert.equal(env.OPERATOR_RUN_ID,'fixture-run');
    for(const key of ['ADMIN_PASSWORD','APP_BRIDGE_TOKEN','APP_STATE_DIR','APP_CONTROLLER_UID'])assert.equal(env[key],undefined);
  }finally{process.env=previous;}
});

class ProbeOnlyAdapter extends EventEmitter {
  version='fixture';async start(){}async health(){return {authenticated:false,detail:'No live model run'};}async close(){}
}

test('worker startup no longer requires an execution account and never claims enforced source protection',async()=>{
  const f=fixture();
  // Stale protection settings from an earlier caller cannot re-enable a removed startup constraint.
  Object.assign(f.config,{protectOperator:true,executionUid:undefined,executionGid:undefined,executionUser:'missing-fixture-account'});
  const worker=new WorkerServer(f.config,()=>new ProbeOnlyAdapter() as any);
  try{
    await worker.listen();const health=worker.health();
    assert.equal(health.executionUid,process.getuid!());assert.equal(health.uid,process.getuid!());assert.equal(health.sourceProtected,false);
  }finally{await worker.close();f.close();}
});

test('tool sessions still pin the active run and reject unsupported private methods',async()=>{
  const calls:Array<{method:string;params:unknown}>=[],token='a'.repeat(64);
  const forward=async(method:string,params:unknown)=>{calls.push({method,params});return {ok:true};};
  assert.deepEqual(await forwardToolRequest({id:1,token,method:'tools/call',params:{name:'memory_write',arguments:{content:'fixture'},runId:'forged'}},'active-run',token,forward),{id:1,result:{ok:true}});
  assert.deepEqual(calls,[{method:'tools/call',params:{name:'memory_write',arguments:{content:'fixture'},runId:'active-run'}}]);
  await assert.rejects(forwardToolRequest({id:2,token,method:'submit'},'active-run',token,forward));
  await assert.rejects(forwardToolRequest({id:3,token:'b'.repeat(64),method:'tools/list'},'active-run',token,forward),/Unauthorized/);
});
