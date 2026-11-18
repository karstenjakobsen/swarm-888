import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';
import { Store } from '../src/store.ts';
import { ProjectService } from '../src/projects/service.ts';
import { ManagedService } from '../src/managed/service.ts';

const git=(directory:string,...args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
class NoExecutionWorker extends EventEmitter {async connect(){throw new Error('Source recovery must not contact a worker');}async request(){throw new Error('Source recovery must not run model inference or host commands');}close(){}}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-package-finalize-')),stateDir=join(root,'state'),projectsDir=join(root,'projects');mkdirSync(stateDir);mkdirSync(projectsDir);
  const config={stateDir,projectsDir,repositoryPath:join(root,'unused-operator'),controllerUid:process.getuid!(),adminPassword:'package-finalization-private-password',ipcToken:'f'.repeat(64)} as Config,client=new NoExecutionWorker() as unknown as WorkerClient;
  let store=new Store(stateDir),projects=new ProjectService(config,store,client,()=>false),managed=new ManagedService(config,store,projects,client);
  return {root,config,get store(){return store;},get managed(){return managed;},
    run(){const conversation=store.newConversation('Generic source authoring'),run=store.enqueue(conversation.id,'Author a reusable package',randomUUID());return store.claim(run.id,{id:`fixture-${randomUUID()}`},{uid:process.getuid!(),journalId:randomUUID(),runtime:{}});},
    async repository(name='Source recovery'){return managed.packages.register({name,remoteUrl:`https://example.invalid/${name.replaceAll(' ','-')}.git`});},
    async skill(repositoryId:string,name='source-recovery'){return managed.packages.createPackage(repositoryId,{path:`skills/${name}`,manifest:{schemaVersion:1,id:randomUUID(),kind:'skill',name,version:'0.1.0',description:'Durable source recovery fixture'}});},
    reopen(){projects.close();store.close();store=new Store(stateDir);projects=new ProjectService(config,store,client,()=>false);managed=new ManagedService(config,store,projects,client);},
    close(){projects.close();store.close();rmSync(root,{recursive:true,force:true});},
  };
}

test('a generic task retains a skill repository lease until direct source edits are committed',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),skill=await f.skill(repository.id),run=f.run();f.managed.trackPackage(skill.id,run.id);
    await f.managed.packages.withRun(run.id,()=>f.managed.packages.writeTextFiles(skill.id,{'helper.mjs':'export const value = 1;\n'}));
    const original=f.managed.packages.source(skill.id);f.store.db.prepare('INSERT INTO skill_sources(name,packageId,source) VALUES(?,?,?)').run(skill.name,skill.id,JSON.stringify(original));f.store.db.prepare('INSERT INTO skill_version_sources(name,version,source) VALUES(?,?,?)').run(skill.name,1,JSON.stringify(original));
    writeFileSync(join(original.workspacePath,'helper.mjs'),'export const value = 2;\n');f.store.transition(run.id,'completed');f.store.releaseProject(run.id);
    assert.equal(f.store.projects.forConversation(run.conversationId),undefined);assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,run.id);assert.throws(()=>f.store.removeConversation(run.conversationId),/repository|package source/);
    await f.managed.finishRun(f.store.run(run.id)!);const saved=f.managed.packages.source(skill.id);assert.notEqual(saved.commit,original.commit);assert.equal(f.managed.packages.readTextFiles(skill.id)['helper.mjs'],'export const value = 2;\n');assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=? AND packageId=?').get(run.id,skill.id)?.state,'committed');assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);
    assert.equal(JSON.parse(String(f.store.db.prepare('SELECT source FROM skill_sources WHERE packageId=?').get(skill.id)?.source)).commit,saved.commit);assert.equal(JSON.parse(String(f.store.db.prepare('SELECT source FROM skill_version_sources WHERE name=? AND version=1').get(skill.name)?.source)).commit,original.commit);assert.match(git(repository.directory,'log','-1','--format=%B'),new RegExp(`Operator-Run: ${run.id}`));assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('generic package source finalization recovers after restart exactly once without contacting workers',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),skill=await f.skill(repository.id),run=f.run();f.managed.trackPackage(skill.id,run.id);await f.managed.packages.withRun(run.id,()=>f.managed.packages.commit(skill.id));
    const directory=f.managed.packages.source(skill.id).workspacePath,count=Number(git(repository.directory,'rev-list','--count','HEAD'));writeFileSync(join(directory,'recovered.mjs'),'export const recovered = true;\n');f.store.transition(run.id,'failed','Model stopped after writing source');f.reopen();
    assert.equal(f.store.managed.pendingFinalizations().some(value=>value.id===run.id),true);assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,run.id);
    await f.managed.recoverSource();await f.managed.recoverSource();await f.managed.finishRun(f.store.run(run.id)!);assert.equal(f.managed.packages.readTextFiles(skill.id)['recovered.mjs'],'export const recovered = true;\n');assert.equal(Number(git(repository.directory,'rev-list','--count','HEAD')),count+1);assert.equal(f.store.managed.pendingFinalizations().length,0);assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);
    assert.equal(f.store.events(0,run.conversationId).filter(event=>event.type==='checkpoint'&&event.runId===run.id).length,1);assert.equal(f.store.removeConversation(run.conversationId).ok,true);
  }finally{f.close();}
});

test('a failed generic package commit keeps its lease through restart until the source is repaired',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),skill=await f.skill(repository.id),run=f.run();f.managed.trackPackage(skill.id,run.id);await f.managed.packages.withRun(run.id,()=>f.managed.packages.commit(skill.id));const directory=f.managed.packages.source(skill.id).workspacePath;
    writeFileSync(join(directory,'private.key'),'Credential files never belong in source\n');f.store.transition(run.id,'interrupted');await assert.rejects(f.managed.finishRun(f.store.run(run.id)!));
    const journal=f.store.db.prepare('SELECT state,error FROM package_finalizations WHERE runId=? AND packageId=?').get(run.id,skill.id);assert.equal(journal?.state,'pending');assert.match(String(journal?.error),/Credentials|runtime files/);f.store.releaseProject(run.id);f.reopen();assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,run.id);await assert.rejects(f.managed.packages.writeTextFiles(skill.id,{'owner-edit.txt':'Must wait\n'}),/owns this repository/);
    rmSync(join(directory,'private.key'));writeFileSync(join(directory,'safe.mjs'),'export const safe = true;\n');await f.managed.recoverSource();assert.equal(f.store.db.prepare('SELECT state,error FROM package_finalizations WHERE runId=? AND packageId=?').get(run.id,skill.id)?.state,'committed');assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);assert.equal(f.managed.packages.readTextFiles(skill.id)['safe.mjs'],'export const safe = true;\n');
  }finally{f.close();}
});

test('one generic task finalizes every tracked package in a shared repository before releasing ownership',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),one=await f.skill(repository.id,'first-skill'),two=await f.skill(repository.id,'second-skill'),run=f.run();f.managed.trackPackage(one.id,run.id);f.managed.trackPackage(two.id,run.id);await f.managed.packages.withRun(run.id,()=>f.managed.packages.commit(one.id));
    writeFileSync(join(f.managed.packages.source(one.id).workspacePath,'first.mjs'),'First source\n');writeFileSync(join(f.managed.packages.source(two.id).workspacePath,'second.mjs'),'Second source\n');f.store.transition(run.id,'completed');await f.managed.finishRun(f.store.run(run.id)!);
    assert.equal(f.store.managed.pendingPackages(run.id).length,0);assert.equal(f.store.db.prepare('SELECT COUNT(*) AS count FROM package_finalizations WHERE runId=? AND state=\'committed\'').get(run.id)?.count,2);assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);assert.equal(f.managed.packages.readTextFiles(one.id)['first.mjs'],'First source\n');assert.equal(f.managed.packages.readTextFiles(two.id)['second.mjs'],'Second source\n');assert.equal(readFileSync(join(f.managed.packages.source(one.id).workspacePath,'first.mjs'),'utf8'),'First source\n');
  }finally{f.close();}
});

test('authoring tracking acquires a repository atomically and failed tracking leaves no journal row',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),skill=await f.skill(repository.id),first=f.run(),second=f.run();f.managed.trackPackage(skill.id,first.id);
    assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,first.id);assert.throws(()=>f.managed.trackPackage(skill.id,second.id),/owns this repository/);assert.equal(f.store.managed.pendingPackages(second.id).length,0);
    f.store.transition(first.id,'completed');await f.managed.finishRun(f.store.run(first.id)!);f.managed.trackPackage(skill.id,second.id);assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,second.id);assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('precreation journals recover as aborted without inventing package records or leaking repository leases',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),run=f.run(),packageId=randomUUID();f.managed.trackPackage(packageId,run.id,repository.id);f.store.transition(run.id,'failed','Creation stopped before source was written');f.reopen();await f.managed.recoverSource();
    assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=? AND packageId=?').get(run.id,packageId)?.state,'aborted');assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);assert.equal(f.managed.packages.listPackages().length,0);assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('one blocked repository does not prevent recovery of an independent task repository',async()=>{
  const f=fixture();try{
    const blockedRepository=await f.repository('Blocked source'),readyRepository=await f.repository('Independent source'),blocked=await f.skill(blockedRepository.id,'blocked-skill'),ready=await f.skill(readyRepository.id,'ready-skill'),first=f.run(),second=f.run();f.managed.trackPackage(blocked.id,first.id);f.managed.trackPackage(ready.id,second.id);
    writeFileSync(join(f.managed.packages.source(blocked.id).workspacePath,'private.key'),'Do not commit credential files\n');writeFileSync(join(f.managed.packages.source(ready.id).workspacePath,'recovered.mjs'),'Independent recovery\n');f.store.transition(first.id,'completed');f.store.transition(second.id,'completed');f.reopen();
    await assert.rejects(f.managed.recoverSource(),/Source recovery needs attention/);assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=?').get(first.id)?.state,'pending');assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=?').get(second.id)?.state,'committed');assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(blockedRepository.id)?.runId,first.id);assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(readyRepository.id),undefined);assert.equal(f.managed.packages.readTextFiles(ready.id)['recovered.mjs'],'Independent recovery\n');
  }finally{f.close();}
});

test('a crash between package completion and lease release rolls back the journal and recovers without a duplicate Git commit',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),skill=await f.skill(repository.id),run=f.run();f.managed.trackPackage(skill.id,run.id);const original=f.managed.packages.source(skill.id);f.store.db.prepare('INSERT INTO skill_sources(name,packageId,source) VALUES(?,?,?)').run(skill.name,skill.id,JSON.stringify(original));writeFileSync(join(original.workspacePath,'crash-window.mjs'),'Committed before controller crash\n');f.store.transition(run.id,'completed');const count=Number(git(repository.directory,'rev-list','--count','HEAD'));
    f.store.releaseProject=()=>{throw new Error('Simulated crash before lease deletion');};await assert.rejects(f.managed.finishRun(f.store.run(run.id)!),/Simulated crash/);
    assert.equal(Number(git(repository.directory,'rev-list','--count','HEAD')),count+1);assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=?').get(run.id)?.state,'pending');assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,run.id);assert.equal(JSON.parse(String(f.store.db.prepare('SELECT source FROM skill_sources WHERE packageId=?').get(skill.id)?.source)).commit,original.commit);
    f.reopen();await f.managed.recoverSource();assert.equal(Number(git(repository.directory,'rev-list','--count','HEAD')),count+1);assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=?').get(run.id)?.state,'committed');assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);assert.equal(f.managed.packages.readTextFiles(skill.id)['crash-window.mjs'],'Committed before controller crash\n');assert.equal(f.store.events(0,run.conversationId).filter(event=>event.type==='checkpoint').length,1);
  }finally{f.close();}
});

test('aborting an unwritten package and releasing its repository lease are one durable transaction',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),run=f.run(),packageId=randomUUID();f.managed.trackPackage(packageId,run.id,repository.id);f.store.transition(run.id,'failed','No source was written');const count=git(repository.directory,'rev-list','--count','HEAD');f.store.releaseProject=()=>{throw new Error('Simulated abort crash before lease deletion');};await assert.rejects(f.managed.finishRun(f.store.run(run.id)!),/Simulated abort crash/);
    assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=?').get(run.id)?.state,'pending');assert.equal(f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,run.id);f.reopen();await f.managed.recoverSource();assert.equal(f.store.db.prepare('SELECT state FROM package_finalizations WHERE runId=?').get(run.id)?.state,'aborted');assert.equal(f.store.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repository.id),undefined);assert.equal(git(repository.directory,'rev-list','--count','HEAD'),count);assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});
