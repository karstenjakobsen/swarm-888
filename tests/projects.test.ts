import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { ProjectService } from '../src/projects/service.ts';
import { componentInput } from '../src/projects/schemas.ts';
import { projectRoot, type Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';

class ObservationWorker extends EventEmitter {
  online=true;protected=true;observations:any[]=[];calls:Array<{method:string;params:any}>=[];
  async connect(){if(!this.online)throw new Error('Fixture worker offline');return {sourceProtected:this.protected};}
  async request(method:string,params:any){this.calls.push({method,params});if(method==='projects/prepare')return {directory:params.project.directory,ready:true};if(method==='projects/inspect')return {observations:this.observations};if(method==='projects/logs')return {text:'Fixture service log',truncated:false,checkedAt:new Date().toISOString()};throw new Error('Unexpected method');}
}
function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-projects-')),store=new Store(stateDir),worker=new ObservationWorker();
  const config={stateDir,projectsDir:join(stateDir,'projects')} as Config;
  const projects=new ProjectService(config,store,worker as unknown as WorkerClient,()=>false);
  return {stateDir,store,worker,config,projects,close(){projects.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('project registry persists independently of tasks and creates no host files',()=>{
  const f=fixture();
  try{
    const project=f.projects.create({name:'Observatory',description:'A personal website'});
    assert.equal(project.origin,'created');assert.equal(project.status,'unknown');assert.equal(existsSync(project.directory),false);
    const website=f.projects.addComponent(project.id,{name:'Public website',kind:'website',url:'https://example.test'});
    const timer=f.projects.addComponent(project.id,{name:'Nightly backup',kind:'scheduled_job',unitName:'operator-fixture-backup.timer',timezone:'Europe/Paris'});
    const conversation=f.projects.newConversation(project.id);
    const run=f.store.enqueue(conversation.id,'Deploy this project','project-deploy');
    assert.equal(f.store.projects.forConversation(conversation.id)?.id,project.id);
    assert.throws(()=>f.projects.createForConversation({name:'Conflicting project'},conversation.id),/already belongs/);assert.equal(f.projects.list().length,1);
    assert.match(f.projects.contextForConversation(conversation.id),/Never modify the operator/);
    assert.equal(f.projects.get(project.id).runs[0].id,run.id);
    const opened=new Store(f.stateDir);
    try{const restored=opened.projects.get(project.id);assert.equal(restored?.components.length,2);assert.equal(restored?.components.find(item=>item.id===website.id)?.url,'https://example.test');assert.equal(restored?.components.find(item=>item.id===timer.id)?.timezone,'Europe/Paris');assert.deepEqual(restored?.conversationIds,[conversation.id]);}
    finally{opened.close();}
  }finally{f.close();}
});

test('status is based only on bounded fresh worker observations and becomes unknown offline',async()=>{
  const f=fixture();
  try{
    const project=f.projects.create({name:'A deployed site'}),component=f.projects.addComponent(project.id,{name:'Site',kind:'website',url:'https://example.test'});
    f.worker.observations=[{componentId:component.id,status:'healthy',healthStatus:'healthy',serviceState:'active',detail:'HTTP 200',checkedAt:new Date().toISOString()}];
    const prepared=await f.projects.prepare(project.id);assert.equal(prepared.directory,project.directory);assert.equal(prepared.ready,true);
    const observed=await f.projects.refresh(project.id);assert.equal(observed.status,'healthy');assert.equal(observed.components[0].stale,false);
    assert.equal(f.worker.calls[0].method,'projects/prepare');assert.equal(f.worker.calls[1].method,'projects/inspect');assert.equal(f.worker.calls[1].params.project.directory,project.directory);
    assert.equal((await f.projects.logs(project.id,component.id)).text,'Fixture service log');
    f.worker.emit('disconnect');
    const disconnected=f.projects.get(project.id);assert.equal(disconnected.status,'unknown');assert.equal(disconnected.components[0].observation?.status,'healthy');assert.equal(disconnected.components[0].stale,true);
    assert.equal(f.store.projects.get(project.id,true,Date.now()+65_000)?.status,'unknown');
    f.worker.online=false;await assert.rejects(f.projects.refresh(project.id),/could not be checked/);assert.equal(f.projects.get(project.id).status,'unknown');
  }finally{f.close();}
});

test('project directory and component contracts reject escapes, source overlap and claimed status',()=>{
  const f=fixture();
  try{
    assert.throws(()=>f.projects.create({name:'Outside',origin:'adopted',directory:'/etc'}),/inside the configured projects directory/);
    assert.throws(()=>f.projects.create({name:'Root',origin:'adopted',directory:f.config.projectsDir}),/inside the configured projects directory/);
    assert.throws(()=>f.projects.create({name:'Claimed healthy',status:'healthy'}));
    const project=f.projects.create({name:'Safe project'});
    assert.throws(()=>f.projects.addComponent(project.id,{name:'Escape',kind:'script',scriptPath:'../../operator/src/worker.ts'}));
    assert.throws(()=>f.projects.addComponent(project.id,{name:'Shell injection',kind:'service',unitName:'site.service; rm -rf /'}));
    assert.throws(()=>f.projects.addComponent(project.id,{name:'Wrong timer',kind:'scheduled_job',unitName:'site.service'}));
    assert.throws(()=>f.projects.addComponent(project.id,{name:'Secret URL',kind:'website',url:'https://user:secret@example.test'}));
    assert.throws(()=>f.projects.addComponent(project.id,{name:'Claimed status',kind:'website',url:'https://example.test',observation:{status:'healthy'}}));
    assert(componentInput.safeParse({name:'Cron report',kind:'scheduled_job',scriptPath:'scripts/report.sh',schedule:'0 2 * * *'}).success);
    assert(!componentInput.safeParse({name:'Bad cron report',kind:'scheduled_job',scriptPath:'scripts/report.sh',schedule:'@sometimes'}).success);
    assert.throws(()=>componentInput.parse({name:'Not a website',kind:'service',unitName:'site.service',url:'https://example.test'}));
    mkdirSync(f.config.projectsDir!,{mode:0o700});symlinkSync(f.stateDir,join(f.config.projectsDir!,'redirect'));
    assert.throws(()=>f.projects.create({name:'Symlink',origin:'adopted',directory:join(f.config.projectsDir!,'redirect','nested')}),/symlinks/);
    const sourceConfig={...f.config,projectsDir:join(projectRoot,'..')},sourceService=new ProjectService(sourceConfig,f.store,f.worker as unknown as WorkerClient,()=>false);
    try{assert.throws(()=>sourceService.create({name:'Operator',origin:'adopted',directory:projectRoot}),/operator source/);}finally{sourceService.close();}
  }finally{f.close();}
});

test('changing a component invalidates observations and incomplete worker samples do not overwrite state',async()=>{
  const f=fixture();
  try{
    const project=f.projects.create({name:'A service'}),component=f.projects.addComponent(project.id,{name:'Worker',kind:'service',unitName:'operator-fixture.service'});
    f.worker.observations=[{componentId:component.id,status:'running',detail:'Service active',checkedAt:new Date().toISOString()}];
    await f.projects.refresh(project.id);
    const changed=f.projects.updateComponent(project.id,component.id,{unitName:'operator-new-fixture.service'});assert.equal(changed.observation,null);
    f.worker.observations=[];await assert.rejects(f.projects.refresh(project.id),/incomplete or invalid/);assert.equal(f.projects.get(project.id).components[0].observation,null);
    f.worker.observations=[{componentId:component.id,status:'healthy',detail:'Not a valid time',checkedAt:'tomorrow'}];
    await assert.rejects(f.projects.refresh(project.id),/invalid project observation/);
    f.config.protectOperator=true;f.worker.protected=false;
    await assert.rejects(f.projects.refresh(project.id),/protected worker/);
    assert.equal(f.projects.get(project.id).status,'unknown');
  }finally{f.close();}
});

test('an inspection cannot mark changed component configuration healthy',async()=>{
  const f=fixture();let release!:()=>void,requested!:()=>void;
  const response=new Promise<void>(resolve=>{release=resolve;}),ready=new Promise<void>(resolve=>{requested=resolve;});
  try{
    const project=f.projects.create({name:'Changing website'}),component=f.projects.addComponent(project.id,{name:'Website',kind:'website',url:'https://old.example.test'});
    f.worker.request=async()=>{requested();await response;return {observations:[{componentId:component.id,status:'healthy',detail:'Old URL responded',checkedAt:new Date().toISOString()}]};};
    const refresh=f.projects.refresh(project.id);await ready;
    f.projects.updateComponent(project.id,component.id,{url:'https://new.example.test'});release();
    await assert.rejects(refresh,/changed during inspection/);
    assert.equal(f.projects.get(project.id).components[0].observation,null);
    assert.equal(f.projects.get(project.id).status,'unknown');
  }finally{release();f.close();}
});
