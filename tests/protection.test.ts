import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chownSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { runtimeEnvironment } from '../src/runtime/codex.ts';
import { executionCommand, executionEnvironment, prepareExecutionDirectory, verifyEffectiveAccess, verifyExecutionProtection, verifyPrivateAccess, verifyProtectedTree } from '../src/runtime/protection.ts';
import { forwardToolRequest } from '../src/runtime/tool-proxy.ts';
import { WorkerServer } from '../src/worker.ts';

test('protected runtime receives no controller token, admin credential or inherited provider secrets',()=>{
  const previous=process.env;
  try{
    process.env={...previous,ADMIN_PASSWORD:'fixture-admin-private',OPENAI_API_KEY:'fixture-provider-private',APP_BRIDGE_TOKEN:'fixture-master-token',NODE_OPTIONS:'--require=/untrusted/file',LD_LIBRARY_PATH:'/fixture/untrusted-libraries'};
    const config={protectOperator:true,executionUid:65534,executionGid:65534,controllerUid:0,executionHome:'/var/lib/fixture-executor',runtimeHome:'/var/lib/fixture-executor/codex',stateDir:'/private/controller',ipcToken:'fixture-master-token'} as Config;
    const environment=runtimeEnvironment(config,'fixture-run');
    assert.equal(environment.CODEX_HOME,config.runtimeHome);assert.equal(environment.HOME,'/var/lib/fixture-executor/user');
    for(const key of ['ADMIN_PASSWORD','OPENAI_API_KEY','APP_BRIDGE_TOKEN','APP_STATE_DIR','NODE_OPTIONS','LD_LIBRARY_PATH'])assert.equal(environment[key],undefined,key);
    assert(!JSON.stringify(environment).includes(config.ipcToken));
    const invocation=executionCommand(config,'/usr/bin/node',[]);
    assert(invocation.args.indexOf('LD_LIBRARY_PATH=/fixture/untrusted-libraries')>invocation.args.indexOf('--'));
    assert(!executionCommand(config,'/bin/sh',[],false).args.some(argument=>argument.startsWith('LD_LIBRARY_PATH=')));
  }finally{process.env=previous;}
});

test('protected startup fails before acquiring worker state when identity separation is unavailable',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-protection-start-'));
  try{
    const config={stateDir:directory,protectOperator:true,controllerUid:process.getuid!(),executionUid:process.getuid!(),executionGid:process.getgid!()} as Config;
    const worker=new WorkerServer(config);
    await assert.rejects(worker.listen(),/broker must run as root|dedicated non-root/);
    assert.equal(existsSync(join(directory,'worker/lock.json')),false);
    assert.throws(()=>verifyExecutionProtection(config),/broker must run as root|dedicated non-root/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('an execution account owning the release is rejected even when write bits were removed',()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-protection-owner-'));
  try{
    writeFileSync(join(directory,'operator.js'),'fixture');chmodSync(directory,0o555);
    assert.throws(()=>verifyProtectedTree(directory,process.getuid!(),process.getgid!()),/execution UID can modify/);
  }finally{chmodSync(directory,0o700);rmSync(directory,{recursive:true,force:true});}
});

test('tool sessions pin the current run and reject unsupported broker methods and other credentials',async()=>{
  const calls:Array<{method:string;params:unknown}>=[],token='a'.repeat(64);
  const forward=async(method:string,params:unknown)=>{calls.push({method,params});return {ok:true};};
  const response=await forwardToolRequest({id:1,token,method:'tools/call',params:{name:'memory_write',arguments:{content:'fixture'},runId:'forged-other-run'}},'owned-active-run',token,forward);
  assert.deepEqual(response,{id:1,result:{ok:true}});
  assert.deepEqual(calls,[{method:'tools/call',params:{name:'memory_write',arguments:{content:'fixture'},runId:'owned-active-run'}}]);
  await assert.rejects(forwardToolRequest({id:2,token:'b'.repeat(64),method:'tools/list'},'owned-active-run',token,forward),/Unauthorized/);
  await assert.rejects(forwardToolRequest({id:3,token,method:'submit',params:{command:'root shell'}},'owned-active-run',token,forward));
  await assert.rejects(forwardToolRequest({id:4,token,method:'tools/call',params:{name:'memory_write'}},undefined,token,forward),/active task/);
  assert.equal(calls.length,1);
});

test('a protected executor cannot alter release files and cannot regain groups or capabilities',{skip:process.getuid?.()!==0||!existsSync('/usr/bin/setpriv')},()=>{
  // Requires a real root test runner. Only isolated temporary fixtures are changed.
  const directory=mkdtempSync(join(tmpdir(),'operator-executor-permission-')),source=join(directory,'operator.js'),project=join(directory,'project');
  try{
    chmodSync(directory,0o755);writeFileSync(source,'original',{mode:0o644});mkdirSync(project,{mode:0o700});chownSync(project,65534,65534);
    const config={protectOperator:true,executionUid:65534,executionGid:65534,controllerUid:0,executionHome:directory} as Config;
    const script=`const fs=require('node:fs');let denied=false;try{fs.appendFileSync(process.argv[1],'changed');}catch(error){denied=error.code==='EACCES'||error.code==='EPERM';}fs.writeFileSync(process.argv[2],'project output');console.log(JSON.stringify({denied,uid:process.getuid(),groups:process.getgroups(),status:fs.readFileSync('/proc/self/status','utf8')}));`;
    const command=executionCommand(config,existsSync('/usr/bin/node')?'/usr/bin/node':process.execPath,['-e',script,source,join(project,'output')]);
    const result=spawnSync(command.command,command.args,{encoding:'utf8',env:executionEnvironment(config),timeout:5000});
    assert.equal(result.status,0,result.stderr);const evidence=JSON.parse(result.stdout);
    assert.equal(evidence.uid,65534);assert.equal(evidence.denied,true);assert.deepEqual(evidence.groups,[]);
    assert.match(evidence.status,/^NoNewPrivs:\s+1$/m);assert.match(evidence.status,/^CapBnd:\s+0+$/m);
    assert.equal(readFileSync(source,'utf8'),'original');assert.equal(readFileSync(join(project,'output'),'utf8'),'project output');
    const secret=join(directory,'.env');writeFileSync(secret,'PRIVATE_FIXTURE=true',{mode:0o600});
    assert.doesNotThrow(()=>verifyPrivateAccess(config,[secret]));chmodSync(secret,0o644);
    assert.throws(()=>verifyPrivateAccess(config,[secret]),/must be private/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('a read-only execution-owned workspace parent is never treated as privileged broker territory',{skip:process.getuid?.()!==0},()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-parent-owner-')),parent=join(directory,'owned');
  try{
    chmodSync(directory,0o755);mkdirSync(parent,{mode:0o555});chownSync(parent,65534,65534);
    const config={protectOperator:true,executionUid:65534,executionGid:65534,controllerUid:0,executionHome:directory,projectsDir:directory} as Config;
    assert.throws(()=>prepareExecutionDirectory(config,join(parent,'child')),/as the execution account/);
    assert.equal(existsSync(join(parent,'child')),false);
  }finally{chmodSync(parent,0o755);rmSync(directory,{recursive:true,force:true});}
});

test('effective access checks reject named ACL write grants missed by ordinary owner/group mode checks',{skip:process.getuid?.()!==0||!existsSync('/usr/bin/setfacl')},()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-effective-acl-')),file=join(directory,'release.js');
  try{
    chmodSync(directory,0o755);writeFileSync(file,'release',{mode:0o644});
    const granted=spawnSync('/usr/bin/setfacl',['-m','u:65534:rw',file],{encoding:'utf8'});assert.equal(granted.status,0,granted.stderr);
    const config={protectOperator:true,executionUid:65534,executionGid:65534,controllerUid:0,executionHome:directory} as Config;
    assert.throws(()=>verifyEffectiveAccess(config,[file]),/effective execution-account write access or ACL/);
  }finally{rmSync(directory,{recursive:true,force:true});}
});
