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
      assert.match((error as Error).message,/APP_CONTROLLER_UID/);return true;
    });
  }finally{chmodSync(parent,0o700);rmSync(parent,{recursive:true,force:true});}
});

test('operator protection is on by default and cannot be disabled for persistent state',()=>{
  const previous=process.env,stateDir=mkdtempSync(join(tmpdir(),'operator-protection-config-'));
  try{
    process.env={...previous,APP_STATE_DIR:stateDir,APP_ALLOW_TEMP_STATE:'true',APP_CONTROLLER_UID:String(process.getuid!())};
    delete process.env.APP_PROTECT_OPERATOR;delete process.env.APP_EXECUTION_UID;delete process.env.APP_EXECUTION_GID;delete process.env.APP_PROJECTS_DIR;delete process.env.APP_EXECUTION_HOME;
    const config=loadConfig();
    assert.equal(config.protectOperator,true);assert.equal(config.requireRootWorker,true);
    assert.equal(config.runtimeHome,join(config.executionHome!,'codex'));
    process.env.APP_EXECUTION_UID=String(process.getuid!());assert.throws(()=>loadConfig(),/differ from the controller/);
    delete process.env.APP_EXECUTION_UID;process.env.APP_PROJECTS_DIR=projectRoot;assert.throws(()=>loadConfig(),/separate from/);
    delete process.env.APP_PROJECTS_DIR;process.env.APP_STATE_DIR='/var/lib/operator-protection-test';process.env.APP_ALLOW_TEMP_STATE='false';process.env.APP_PROTECT_OPERATOR='false';
    assert.throws(()=>loadConfig(),/only be disabled.*temporary test state/);
  }finally{process.env=previous;rmSync(stateDir,{recursive:true,force:true});}
});

test('explicit unprotected temporary fixtures may retain the current process identity',()=>{
  const previous=process.env,stateDir=mkdtempSync(join(tmpdir(),'operator-unprotected-fixture-'));
  try{
    process.env={...previous,APP_STATE_DIR:stateDir,APP_ALLOW_TEMP_STATE:'true',APP_PROTECT_OPERATOR:'false',APP_CONTROLLER_UID:String(process.getuid!()),APP_EXECUTION_UID:String(process.getuid!()),APP_EXECUTION_GID:String(process.getgid!())};
    const config=loadConfig();assert.equal(config.protectOperator,false);assert.equal(config.executionUid,process.getuid!());
  }finally{process.env=previous;rmSync(stateDir,{recursive:true,force:true});}
});
