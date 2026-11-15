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
