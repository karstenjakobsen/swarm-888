import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { projectRoot, type Config } from '../src/config.ts';
import { workerLaunch } from '../src/worker-launch.ts';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'operator-worker-launch-')),capture=join(directory,'argv.json'),captureScript=join(directory,'capture.mjs');
  writeFileSync(captureScript,"import { writeFileSync } from 'node:fs'; writeFileSync(process.env.WORKER_LAUNCH_TEST_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
  writeFileSync(join(directory,'sudo'),'#!/bin/sh\nexec "$WORKER_LAUNCH_TEST_NODE" "$WORKER_LAUNCH_TEST_CAPTURE_SCRIPT" "$@"\n',{mode:0o700});
  const env={...process.env,PATH:`${directory}:${process.env.PATH}`,WORKER_LAUNCH_TEST_NODE:process.execPath,WORKER_LAUNCH_TEST_CAPTURE_SCRIPT:captureScript,WORKER_LAUNCH_TEST_CAPTURE:capture};
  return {directory,capture,env,close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('browser and terminal launch arguments carry explicit controller settings safely through sudo',()=>{
  const f=fixture();
  try{
    const config={stateDir:join(f.directory,"state 'quoted' $USER `pwd`"),controllerUid:1234,codexBin:'/fixture/codex',allowTempState:true,model:'test-model',requireRootWorker:true} as Config;
    const fallback=workerLaunch(config);assert(fallback.args.includes(`APP_PROJECTS_DIR=${join(config.stateDir,'projects')}`));
    config.projectsDir=join(f.directory,"projects 'quoted' $USER `pwd`");
    const launch=workerLaunch(config),result=spawnSync('/bin/sh',['-c',launch.command],{env:f.env,encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);
    assert.deepEqual(JSON.parse(readFileSync(f.capture,'utf8')),['--',...launch.args]);
    assert(launch.args.includes(`APP_PROJECTS_DIR=${config.projectsDir}`));assert(launch.args.includes('APP_CONTROLLER_UID=1234'));assert(launch.args.includes('APP_REQUIRE_ROOT_WORKER=true'));assert(launch.args.includes('APP_ALLOW_TEMP_STATE=true'));assert(launch.args.includes('CODEX_MODEL=test-model'));
    assert.equal(launch.args.at(-1),join(projectRoot,'src/root-worker.ts'));
    assert(launch.args.includes(`--env-file-if-exists=${join(projectRoot,'.env')}`));
    config.model=undefined;config.allowTempState=false;
    const cleared=workerLaunch(config);assert(cleared.args.includes('CODEX_MODEL='));assert(cleared.args.includes('APP_ALLOW_TEMP_STATE=false'));
  }finally{f.close();}
});

test('worker:root captures normal-user configuration before requesting sudo without starting a worker',{skip:process.getuid?.()===0},()=>{
  const f=fixture();
  try{
    const inherited=Object.fromEntries(Object.entries(f.env).filter(([key])=>!key.startsWith('APP_')));
    const stateDir=join(f.directory,'state'),projectsDir=join(f.directory,'projects');
    const result=spawnSync(process.execPath,['--import','tsx','scripts/root-worker.ts'],{cwd:projectRoot,env:{...inherited,APP_STATE_DIR:stateDir,APP_PROJECTS_DIR:projectsDir,APP_CONTROLLER_UID:String(process.getuid!()),APP_ALLOW_TEMP_STATE:'true'},encoding:'utf8'});
    assert.equal(result.status,0,result.stderr);assert(result.stdout.includes(`APP_PROJECTS_DIR=${projectsDir}`));
    const args=JSON.parse(readFileSync(f.capture,'utf8')) as string[];
    assert.equal(args[0],'--');assert.equal(args[1],'env');assert(args.includes(`APP_STATE_DIR=${stateDir}`));assert(args.includes(`APP_PROJECTS_DIR=${projectsDir}`));assert(args.includes(`APP_CONTROLLER_UID=${process.getuid!()}`));assert.equal(args.at(-1),join(projectRoot,'src/root-worker.ts'));
  }finally{f.close();}
});
