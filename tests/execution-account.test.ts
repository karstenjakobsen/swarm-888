import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveExecutionIdentity } from '../src/config.ts';

const accounts='root:x:0:0:root:/root:/bin/bash\nvps-ai-projects:x:987:986:Project execution:/var/lib/vps-ai-executor/user:/usr/sbin/nologin\ncontroller:x:1000:1000:Controller:/home/controller:/bin/bash\n';

test('the default dedicated account resolves its UID and primary GID without numeric configuration',()=>{
  assert.deepEqual(resolveExecutionIdentity({},1000,accounts),{executionUser:'vps-ai-projects',executionUid:987,executionGid:986});
});

test('missing account setup leaves the controller usable and never falls back to its own identity',()=>{
  assert.deepEqual(resolveExecutionIdentity({},1000,''),{executionUser:'vps-ai-projects',executionUid:undefined,executionGid:undefined});
});

test('explicit numeric account configuration is retained and must be complete',()=>{
  assert.deepEqual(resolveExecutionIdentity({APP_EXECUTION_UID:'2001',APP_EXECUTION_GID:'2002'},1000,accounts),{executionUser:undefined,executionUid:2001,executionGid:2002});
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_UID:'2001'},1000,accounts),/together/);
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_GID:'2002'},1000,accounts),/together/);
});

test('account names cannot contradict numeric IDs or resolve to the controller or root',()=>{
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_USER:'vps-ai-projects',APP_EXECUTION_UID:'2001',APP_EXECUTION_GID:'2002'},1000,accounts),/do not match/);
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_USER:'missing',APP_EXECUTION_UID:'2001',APP_EXECUTION_GID:'2002'},1000,accounts),/not an existing local account/);
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_USER:'controller'},1000,accounts),/differ from the controller/);
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_USER:'root'},1000,accounts));
  assert.throws(()=>resolveExecutionIdentity({APP_EXECUTION_USER:'invalid/name'},1000,accounts),/valid local account name/);
});
