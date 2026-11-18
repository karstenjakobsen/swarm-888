import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureRelease, release } from '../src/release.ts';
import { createController } from '../src/controller.ts';
import { loadConfig } from '../src/config.ts';

function git(directory:string,...args:string[]):string {
  return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Release fixture','-c','user.email=release@example.invalid','-C',directory,...args],{
    encoding:'utf8',stdio:['ignore','pipe','pipe'],env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},
  }).trim();
}

test('release identity is a startup snapshot of the actual source commit',()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-release-'));
  try{
    git(directory,'init','-q','-b','main');writeFileSync(join(directory,'source.txt'),'First release\n');git(directory,'add','.');git(directory,'commit','-qm','First release');
    const first=git(directory,'rev-parse','HEAD'),captured=captureRelease(directory);
    assert.deepEqual(captured,{commit:first});assert.equal(Object.isFrozen(captured),true);
    writeFileSync(join(directory,'source.txt'),'Second release\n');git(directory,'add','.');git(directory,'commit','-qm','Second release');
    const second=git(directory,'rev-parse','HEAD');assert.notEqual(second,first);
    assert.equal(captured.commit,first,'Changing files or Git HEAD must not relabel an already running controller');
    assert.equal(captureRelease(directory).commit,second,'A restarted controller observes the new release');
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('source without Git metadata and nested directories do not claim another release',()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-release-no-git-'));
  try{
    assert.deepEqual(captureRelease(directory),{commit:null});
    git(directory,'init','-q','-b','main');writeFileSync(join(directory,'source.txt'),'Release\n');git(directory,'add','.');git(directory,'commit','-qm','Release');
    const child=join(directory,'nested');mkdirSync(child);assert.deepEqual(captureRelease(child),{commit:null});
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('inherited Git overrides cannot substitute the reported source release',()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-release-env-')),previous={...process.env};
  try{
    git(directory,'init','-q','-b','main');writeFileSync(join(directory,'source.txt'),'Release\n');git(directory,'add','.');git(directory,'commit','-qm','Release');
    const commit=git(directory,'rev-parse','HEAD');
    Object.assign(process.env,{GIT_DIR:join(directory,'missing-git-dir'),GIT_WORK_TREE:'/missing-tree',APP_RELEASE_COMMIT:'f'.repeat(40)});
    assert.equal(captureRelease(directory).commit,commit);
  }finally{process.env=previous;rmSync(directory,{recursive:true,force:true});}
});

test('deployment health exposes only the captured startup commit without a login',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-release-http-')),previous={...process.env};
  let controller:Awaited<ReturnType<typeof createController>>|undefined;
  try{
    Object.assign(process.env,{APP_STATE_DIR:directory,APP_PROJECTS_DIR:join(directory,'projects'),APP_ALLOW_TEMP_STATE:'true',APP_CONTROLLER_UID:String(process.getuid!()),APP_WORKER_ID:'',ADMIN_PASSWORD:'release-health-fixture-password'});
    const config=loadConfig({requireAdmin:true});process.env=previous;
    controller=await createController(config,{startQueue:false,startBridge:false});
    const response=await controller.app.inject({method:'GET',url:'/api/version'});
    assert.equal(response.statusCode,200);assert.deepEqual(response.json(),release);
    assert.deepEqual(Object.keys(response.json()),['commit']);assert.equal(response.headers['cache-control'],'no-store');
    assert.equal((await controller.app.inject({method:'GET',url:'/api/status'})).statusCode,401);
  }finally{process.env=previous;await controller?.close();rmSync(directory,{recursive:true,force:true});}
});
