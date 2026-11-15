import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import type { ComponentReference } from '../src/projects/schemas.ts';
import { inspectProject, projectLogs, type ProjectCommand } from '../src/runtime/projects.ts';
import { publishArtifact } from '../src/runtime/artifacts.ts';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'operator-project-runtime-')),projectsDir=join(directory,'projects'),project={id:'11111111-1111-4111-8111-111111111111',directory:join(projectsDir,'fixture')};
  mkdirSync(project.directory,{recursive:true});mkdirSync(join(directory,'artifacts'));
  return {directory,project,config:{stateDir:directory,projectsDir,controllerUid:process.getuid!()} as Config,close:()=>rmSync(directory,{recursive:true,force:true})};
}
function component(kind:ComponentReference['kind'],overrides:Partial<ComponentReference>={}):ComponentReference{return {id:'22222222-2222-4222-8222-222222222222',kind,unitName:null,url:null,scriptPath:null,schedule:null,timezone:null,...overrides};}

test('website probes and service observations distinguish HTTP health from service state',async()=>{
  const f=fixture(),server=createServer((_request,response)=>{response.statusCode=503;response.end('fixture unavailable');});
  await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));
  try{
    const command:ProjectCommand=async()=>({stdout:`LoadState=loaded\nActiveState=active\nSubState=running\nWorkingDirectory=${f.project.directory}\n`,truncated:false});
    const address=server.address() as {port:number};
    const result=await inspectProject(f.config,f.project,[component('website',{unitName:'fixture.service',url:`http://127.0.0.1:${address.port}`})],command);
    assert.equal(result.observations[0].status,'failed');assert.equal(result.observations[0].healthStatus,'unhealthy');assert.equal(result.observations[0].serviceState,'active/running');
  }finally{await new Promise<void>(ok=>server.close(()=>ok()));f.close();}
});

test('timer observations retain the last execution result without labelling an idle schedule stopped',async()=>{
  const f=fixture();
  try{
    const command:ProjectCommand=async(_command,args)=>({stdout:args.at(-1)==='fixture.timer'?'LoadState=loaded\nActiveState=active\nSubState=waiting\nUnit=fixture.service\nNextElapseUSecRealtime=Mon 2026-11-16 02:00:00 UTC\n':`LoadState=loaded\nActiveState=failed\nWorkingDirectory=${f.project.directory}\nResult=exit-code\nExecMainStatus=1\nExecMainExitTimestamp=Sun 2026-11-15 02:00:00 UTC\n`,truncated:false});
    const result=await inspectProject(f.config,f.project,[component('scheduled_job',{unitName:'fixture.timer'})],command),observation=result.observations[0];
    assert.equal(observation.status,'scheduled');assert.equal(observation.lastExitCode,1);assert.equal(observation.nextRunAt,'2026-11-16T02:00:00.000Z');assert.match(observation.detail,/exit-code/);
  }finally{f.close();}
});

test('a never-run timer has no invented last exit code and its logs come from the verified target service',async()=>{
  const f=fixture();
  try{
    const calls:Array<{path:string;args:string[]}>=[];
    const command:ProjectCommand=async(path,args)=>{
      calls.push({path,args});
      return {stdout:path.endsWith('journalctl')?'actual job output':args.at(-1)==='fixture.timer'?'LoadState=loaded\nActiveState=active\nSubState=waiting\nUnit=fixture.service\n':`LoadState=loaded\nActiveState=inactive\nWorkingDirectory=${f.project.directory}\nExecMainStatus=0\n`,truncated:false};
    };
    const reference=component('scheduled_job',{unitName:'fixture.timer'}),result=await inspectProject(f.config,f.project,[reference],command);
    assert.equal(result.observations[0].status,'scheduled');assert.equal(result.observations[0].lastExitCode,null);assert.equal(result.observations[0].lastRunAt,null);
    assert.equal((await projectLogs(f.config,f.project,reference,command)).text,'actual job output');
    assert(calls.find(call=>call.path.endsWith('journalctl'))?.args.includes('--unit=fixture.service'));
    assert(calls.every(call=>!call.args.includes('--user')));
  }finally{f.close();}
});

test('operator service references cannot expose logs and script symlinks cannot escape a project',async()=>{
  const f=fixture();
  try{
    const calls:string[]=[];
    const command:ProjectCommand=async(path)=>{calls.push(path);return {stdout:'LoadState=loaded\nActiveState=active\nWorkingDirectory=/opt/operator\n',truncated:false};};
    await assert.rejects(projectLogs(f.config,f.project,component('service',{unitName:'operator.service'}),command),/inside this project/);
    assert.deepEqual(calls,['/usr/bin/systemctl']);
    writeFileSync(join(f.directory,'outside.sh'),'private fixture');symlinkSync(join(f.directory,'outside.sh'),join(f.project.directory,'escape.sh'));
    const result=await inspectProject(f.config,f.project,[component('script',{scriptPath:'escape.sh'})],command);
    assert.equal(result.observations[0].status,'unknown');assert.match(result.observations[0].detail,/canonical/);
  }finally{f.close();}
});

test('cron status verifies the exact registered script and schedule without inventing execution history',async()=>{
  const f=fixture();
  try{
    const script=join(f.project.directory,'daily.mjs');writeFileSync(script,'console.log("fixture")');
    const command:ProjectCommand=async(path,args)=>{
      if(path.endsWith('crontab'))assert.deepEqual(args,['-l']);
      return {stdout:path.endsWith('crontab')?`0 2 * * * /usr/bin/node ${script}\n`:'1\n',truncated:false};
    };
    const result=await inspectProject(f.config,f.project,[component('scheduled_job',{scriptPath:'daily.mjs',schedule:'0 2 * * *'})],command),observation=result.observations[0];
    assert.equal(observation.status,'scheduled');assert.equal(observation.nextRunAt,null);assert.equal(observation.lastRunAt,null);assert.equal(observation.lastExitCode,null);
    const complex:ProjectCommand=async()=>({stdout:`0 2 * * * /usr/bin/node ${script} && touch /tmp/not-inferred\n`,truncated:false});
    assert.equal((await inspectProject(f.config,f.project,[component('scheduled_job',{scriptPath:'daily.mjs',schedule:'0 2 * * *'})],complex)).observations[0].status,'unknown');
  }finally{f.close();}
});

test('artifact publishing copies an owned project file but rejects symlink escape',async()=>{
  const f=fixture();
  try{
    const source=join(f.project.directory,'report.txt');writeFileSync(source,'project artifact');
    const published=await publishArtifact(f.config,{path:source});
    assert.match(published.url,/^\/api\/artifacts\//);assert.equal(readFileSync(join(f.directory,'artifacts',published.path),'utf8'),'project artifact');
    const outside=join(f.directory,'private.txt');writeFileSync(outside,'private');symlinkSync(outside,join(f.project.directory,'escape.txt'));
    await assert.rejects(publishArtifact(f.config,{path:join(f.project.directory,'escape.txt')}),/could not be read/);
    await assert.rejects(publishArtifact(f.config,{path:outside}),/APP_PROJECTS_DIR/);
  }finally{f.close();}
});
