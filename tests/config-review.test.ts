import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, loadConfig, projectRoot, type Config } from '../src/config.ts';

test('state validation rejects temporary roots and checkout directories beginning with two dots',()=>{
  const previous=process.env;
  try{
    process.env={...previous,APP_ALLOW_TEMP_STATE:'false',APP_STATE_DIR:'/var/tmp'};
    assert.throws(()=>loadConfig(),/persistent/);
    process.env.APP_STATE_DIR=join(projectRoot,'..operator-state');
    assert.throws(()=>loadConfig(),/outside the source checkout/);
  }finally{process.env=previous;}
});

test('unwritable state reports controller initialization and complete worker launch guidance',{skip:process.getuid?.()===0},()=>{
  const parent=mkdtempSync(join(tmpdir(),'operator-state-permission-'));
  try{
    chmodSync(parent,0);
    assert.throws(()=>initState({stateDir:join(parent,'state')} as Config),error=>{
      assert.equal((error as NodeJS.ErrnoException).code,'EACCES');
      assert.match((error as Error).message,/APP_STATE_DIR.*permission denied/);
      assert.match((error as Error).message,/npm run worker:root/);return true;
    });
  }finally{chmodSync(parent,0o700);rmSync(parent,{recursive:true,force:true});}
});

test('root execution ignores obsolete dedicated-account and protection settings',()=>{
  const previous=process.env,stateDir=mkdtempSync(join(tmpdir(),'operator-root-config-'));
  try{
    process.env={...previous,APP_STATE_DIR:stateDir,APP_ALLOW_TEMP_STATE:'true',APP_REQUIRE_ROOT_WORKER:'true',APP_PROTECT_OPERATOR:'true',APP_EXECUTION_USER:'missing-account',APP_EXECUTION_UID:'not-a-uid',APP_EXECUTION_GID:'',APP_EXECUTION_HOME:'/missing/execution-home'};
    delete process.env.APP_PROJECTS_DIR;
    const config=loadConfig();
    assert.equal(config.requireRootWorker,true);assert.equal(config.runtimeHome,join(stateDir,'runtime'));assert.equal(config.projectsDir,join(stateDir,'projects'));
    assert.equal('protectOperator' in config,false);assert.equal('executionUid' in config,false);
    process.env.APP_PROTECT_OPERATOR='false';assert.equal(loadConfig().requireRootWorker,true);
  }finally{process.env=previous;rmSync(stateDir,{recursive:true,force:true});}
});

test('worker execution defaults to the normal user unless root is explicitly configured',()=>{
  const previous=process.env,stateDir=mkdtempSync(join(tmpdir(),'operator-user-config-'));
  try{
    process.env={...previous,APP_STATE_DIR:stateDir,APP_ALLOW_TEMP_STATE:'true',APP_CONTROLLER_UID:String(process.getuid!()),APP_WORKER_ID:'',APP_REQUIRE_ROOT_WORKER:''};delete process.env.APP_PROJECTS_DIR;
    assert.equal(loadConfig().requireRootWorker,false);process.env.APP_REQUIRE_ROOT_WORKER='true';assert.equal(loadConfig().requireRootWorker,true);
  }finally{process.env=previous;rmSync(stateDir,{recursive:true,force:true});}
});
