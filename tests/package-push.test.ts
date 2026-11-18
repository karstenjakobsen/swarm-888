import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import { PackageService } from '../src/packages/service.ts';
import { repositoryPushSettingsInput } from '../src/packages/schemas.ts';
import { toolSchemas } from '../src/brain/schemas.ts';

function git(directory:string,...args:string[]):string{return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','commit.gpgSign=false','-c','user.name=Push fixture','-c','user.email=push@example.invalid','-C',directory,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['ignore','pipe','pipe']}).trim();}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-package-push-')),stateDir=join(root,'state'),projectsDir=join(root,'projects'),remote=join(root,'remote.git');
  mkdirSync(stateDir);mkdirSync(projectsDir);mkdirSync(remote);git(remote,'init','--quiet','--bare','--initial-branch=main');
  const store=new Store(stateDir),config={stateDir,projectsDir,controllerUid:process.getuid!(),adminPassword:'push-private-test-password',ipcToken:'b'.repeat(64)} as Config;
  let service=new PackageService(config,store.db);
  return {root,remote,store,config,get service(){return service;},reopen(){service=new PackageService(config,store.db);},
    async repository(){return service.register({name:'Publish fixtures',remoteUrl:remote,mode:'create'});},
    async package(repositoryId:string,name='fixture'){return service.createPackage(repositoryId,{path:`apps/${name}`,manifest:{schemaVersion:1,id:randomUUID(),kind:'project',name,version:'1.0.0',description:'Durable publication fixture'},files:{'app.mjs':'export const value = 1;\n'}});},
    async drain(){for(let i=0;i<20;i++){await service.flushPushes();if(!store.db.prepare("SELECT 1 FROM repository_pushes WHERE state IN ('pending','pushing')").get())return;}throw new Error('Publication did not drain');},
    async close(){await service.closePublishing();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('owner-enabled automatic publishing sends committed package creations and edits to the exact branch',async()=>{
  const f=fixture();try{
    const repository=await f.repository();assert.equal(repository.push?.enabled,false);assert.equal(repository.push?.state,'disabled');
    await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true});await f.drain();
    const record=await f.package(repository.id),created=f.service.source(record.id).commit!;
    assert.equal(f.service.repository(repository.id).push?.state,'pending');await f.drain();
    assert.equal(git(f.remote,'rev-parse',`refs/heads/${repository.branch}`),created);
    const updated=await f.service.writeTextFiles(record.id,{'app.mjs':'export const value = 2;\n'});await f.drain();
    assert.equal(git(f.remote,'rev-parse',`refs/heads/${repository.branch}`),updated.lastImportedCommit);
    assert.equal(git(f.remote,'show',`${repository.branch}:apps/fixture/app.mjs`),'export const value = 2;');
    const status=f.service.repository(repository.id).push!;assert.equal(status.state,'pushed');assert.equal(status.pushedCommit,updated.lastImportedCommit);assert.equal(status.error,null);
  }finally{await f.close();}
});

test('manual publication requires owner opt-in and cannot enable or retarget through the model tool',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await assert.rejects(f.service.requestPush(repository.id),/disabled/);
    assert.equal(toolSchemas.repository_push.safeParse({id:repository.id,pushUrl:'https://other.invalid/repo.git'}).success,false);
    assert.equal(toolSchemas.repository_register.safeParse({name:'Injected',remoteUrl:f.remote,pushEnabled:true}).success,false);
    assert.equal(repositoryPushSettingsInput.safeParse({enabled:false,autoPush:true}).success,false);
    await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false,branch:'release/packages'});
    const record=await f.package(repository.id);assert.equal(f.service.repository(repository.id).push?.state,'idle');
    const pending=await f.service.requestPush(repository.id);assert.equal(pending.push?.state,'pending');await f.drain();
    assert.equal(git(f.remote,'rev-parse','refs/heads/release/packages'),record.lastImportedCommit);
    assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD'),repository.branch);
  }finally{await f.close();}
});

test('publication failure preserves successful local commits and retry publishes without creating commits',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),unavailable=join(f.root,'offline.git');
    await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true,pushUrl:unavailable});
    const record=await f.package(repository.id),count=git(repository.directory,'rev-list','--count','HEAD');await f.drain();
    assert.equal(f.service.repository(repository.id).push?.state,'failed');assert(f.service.repository(repository.id).push?.error);
    assert.equal(f.service.package(record.id).lastImportedCommit,record.lastImportedCommit);assert.equal(readFileSync(join(repository.directory,'apps/fixture/app.mjs'),'utf8'),'export const value = 1;\n');
    mkdirSync(unavailable);git(unavailable,'init','--quiet','--bare','--initial-branch=main');
    await f.service.requestPush(repository.id);await f.drain();
    assert.equal(f.service.repository(repository.id).push?.state,'pushed');assert.equal(git(unavailable,'rev-parse',`refs/heads/${repository.branch}`),record.lastImportedCommit);assert.equal(git(repository.directory,'rev-list','--count','HEAD'),count);
  }finally{await f.close();}
});

test('in-flight publication recovers after restart by confirming the already-pushed remote SHA',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false});
    const record=await f.package(repository.id);await f.service.requestPush(repository.id);await f.drain();
    const count=git(f.remote,'rev-list','--count',repository.branch);
    f.store.db.prepare("UPDATE repository_pushes SET state='pushing',error=NULL WHERE repositoryId=?").run(repository.id);
    f.reopen();assert.equal(f.service.repository(repository.id).push?.state,'pending');await f.drain();
    assert.equal(f.service.repository(repository.id).push?.state,'pushed');assert.equal(git(f.remote,'rev-parse',repository.branch),record.lastImportedCommit);assert.equal(git(f.remote,'rev-list','--count',repository.branch),count);
  }finally{await f.close();}
});

test('publishing waits for task source finalization to release its repository lease',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true});
    const conversation=f.store.newConversation('Lease fixture'),run=f.store.enqueue(conversation.id,'Finish editing',randomUUID());
    f.store.db.prepare('INSERT INTO repository_leases(repositoryId,runId,acquiredAt) VALUES(?,?,?)').run(repository.id,run.id,new Date().toISOString());
    const record=await f.package(repository.id);await f.service.flushPushes();assert.equal(f.service.repository(repository.id).push?.state,'pending');assert.equal(git(f.remote,'for-each-ref','refs/heads/'),'');
    f.store.db.prepare('DELETE FROM repository_leases WHERE repositoryId=?').run(repository.id);await f.drain();
    assert.equal(git(f.remote,'rev-parse',repository.branch),record.lastImportedCommit);
  }finally{await f.close();}
});

test('divergent remote history is rejected without force or discarding either side',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true});await f.drain();
    const rival=join(f.root,'rival');git(f.root,'clone','--quiet','--branch',repository.branch,f.remote,rival);writeFileSync(join(rival,'owner-note.txt'),'Owner remote edit\n');git(rival,'add','.');git(rival,'commit','--quiet','-m','Remote owner edit');git(rival,'push','--quiet','origin',repository.branch);const remote=git(rival,'rev-parse','HEAD');
    const local=await f.package(repository.id);await f.drain();assert.equal(f.service.repository(repository.id).push?.state,'failed');assert.equal(git(f.remote,'rev-parse',repository.branch),remote);assert.equal(git(repository.directory,'rev-parse','HEAD'),local.lastImportedCommit);assert.equal(readFileSync(join(rival,'owner-note.txt'),'utf8'),'Owner remote edit\n');
  }finally{await f.close();}
});

test('disabling or retargeting publication cancels old queued destinations',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true});await f.package(repository.id);
    await f.service.setPushSettings(repository.id,{enabled:false,autoPush:false});await f.drain();assert.equal(git(f.remote,'for-each-ref','refs/heads/'),'');assert.equal(f.service.repository(repository.id).push?.state,'disabled');
    const second=join(f.root,'second.git');mkdirSync(second);git(second,'init','--quiet','--bare');
    await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true,pushUrl:second,branch:'published/packages'});await f.drain();
    assert.equal(git(f.remote,'for-each-ref','refs/heads/'),'');assert.equal(git(second,'rev-parse','refs/heads/published/packages'),git(repository.directory,'rev-parse','HEAD'));
  }finally{await f.close();}
});

test('omitted push URL keeps an existing SSH push URL independently of the fetch URL',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),ssh='git@github.com:owner/package-fixture.git';git(repository.directory,'remote','set-url','--push','origin',ssh);
    const first=await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false});assert.equal(first.push?.pushUrl,ssh);assert.equal(git(repository.directory,'remote','get-url','origin'),f.remote);
    const second=await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false,branch:'release/other'});assert.equal(second.push?.pushUrl,ssh);assert.equal(second.push?.branch,'release/other');
  }finally{await f.close();}
});
