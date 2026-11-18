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
import { RepositoryPublisher } from '../src/packages/publishing.ts';
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

test('restart confirms an accepted commit when the remote has advanced without changing checkout or fetch preview',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false});
    const record=await f.package(repository.id);await f.service.requestPush(repository.id);
    git(repository.directory,'push','--quiet',f.remote,`${record.lastImportedCommit}:refs/heads/${repository.branch}`);
    git(repository.directory,'fetch','--quiet',f.remote,`refs/heads/${repository.branch}`);
    const preview=readFileSync(join(repository.directory,'.git','FETCH_HEAD'),'utf8');
    const rival=join(f.root,'rival');git(f.root,'clone','--quiet','--branch',repository.branch,f.remote,rival);
    writeFileSync(join(rival,'owner-note.txt'),'A subsequent accepted owner commit\n');git(rival,'add','.');git(rival,'commit','--quiet','-m','Advance remote after publication');git(rival,'push','--quiet','origin',repository.branch);
    const remote=git(rival,'rev-parse','HEAD');assert.throws(()=>git(repository.directory,'cat-file','-e',remote));
    f.store.db.prepare("UPDATE repository_pushes SET state='pushing' WHERE repositoryId=?").run(repository.id);
    f.reopen();await f.drain();
    const status=f.service.repository(repository.id).push!;assert.equal(status.state,'pushed');assert.equal(status.pushedCommit,record.lastImportedCommit);assert.equal(status.error,null);
    assert.equal(git(f.remote,'rev-parse',repository.branch),remote);assert.equal(git(repository.directory,'rev-parse','HEAD'),record.lastImportedCommit);
    assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD'),repository.branch);assert.equal(readFileSync(join(repository.directory,'.git','FETCH_HEAD'),'utf8'),preview);assert.equal(git(repository.directory,'status','--porcelain'),'');
  }finally{await f.close();}
});

test('startup recovers every accepted package revision when import timestamps do not reflect Git order',async()=>{
  const f=fixture();try{
    const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:true});
    const first=await f.package(repository.id,'first'),second=await f.package(repository.id,'second');
    const latest=await f.service.writeTextFiles(first.id,{'app.mjs':'export const value = 3;\n'});
    // Simulate a crash between accepted source/catalog commits and outbox inserts.
    f.store.db.prepare('DELETE FROM repository_pushes WHERE repositoryId=?').run(repository.id);
    f.store.db.prepare('UPDATE packages SET lastImportedAt=? WHERE repositoryId=?').run('2026-11-18T12:00:00.000Z',repository.id);
    f.service.startPublishing();await f.drain();
    assert.equal(git(f.remote,'rev-parse',repository.branch),latest.lastImportedCommit);
    const rows=f.store.db.prepare('SELECT commitSha,state FROM repository_pushes WHERE repositoryId=?').all(repository.id);
    assert.deepEqual(new Set(rows.map(row=>row.commitSha)),new Set([latest.lastImportedCommit,second.lastImportedCommit]));assert(rows.every(row=>row.state==='pushed'));
    const status=f.service.repository(repository.id).push!;assert.equal(status.state,'pushed');assert.equal(status.commit,latest.lastImportedCommit);assert.equal(status.pushedCommit,latest.lastImportedCommit);
  }finally{await f.close();}
});

test('a concurrent remote advance before or after a push is acknowledged when it contains the queued revision',async t=>{
  for(const phase of ['before','after'])await t.test(phase,async()=>{
    const f=fixture();let publisher:RepositoryPublisher|undefined;try{
      const repository=await f.repository();await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false});
      const record=await f.package(repository.id);await f.service.requestPush(repository.id);
      let remote='',pushes=0;
      const advance=()=>{
        const rival=join(f.root,'rival');git(f.root,'clone','--quiet','--branch',repository.branch,f.remote,rival);
        writeFileSync(join(rival,'owner-note.txt'),'Preserve the concurrent owner commit\n');git(rival,'add','.');git(rival,'commit','--quiet','-m','Concurrent remote advance');git(rival,'push','--quiet','origin',repository.branch);remote=git(rival,'rev-parse','HEAD');
      };
      publisher=new RepositoryPublisher(f.store.db,{
        repository:id=>f.service.repository(id),exclusive:async(_id,operation)=>operation(),
        git:(directory,args,allowFailure)=>{try{return git(directory,...args);}catch(error){if(allowFailure)return '';throw error;}},
        remoteGit:async(directory,args)=>{
          if(args[0]==='push'){
            pushes++;
            if(phase==='before'){git(repository.directory,'push','--quiet',f.remote,`${record.lastImportedCommit}:refs/heads/${repository.branch}`);advance();}
          }
          const result=git(directory,...args);if(args[0]==='push'&&phase==='after')advance();return result;
        },assertSafe:()=>{},error:error=>(error as Error).message,
      });
      await publisher.flush();assert.equal(pushes,1);assert.equal(publisher.status(repository.id).state,'pushed');assert.equal(publisher.status(repository.id).error,null);
      assert.equal(git(f.remote,'rev-parse',repository.branch),remote);assert.equal(git(repository.directory,'rev-parse','HEAD'),record.lastImportedCommit);
    }finally{await publisher?.close();await f.close();}
  });
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

test('an explicit null push URL resets an override to the current Git push destination',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),ssh='git@github.com:owner/current-package-fixture.git',override='git@github.com:owner/previous-package-fixture.git';
    git(repository.directory,'remote','set-url','--push','origin',ssh);
    await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false,pushUrl:override});
    const retained=await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false});assert.equal(retained.push?.pushUrl,override);
    const reset=await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false,pushUrl:null});assert.equal(reset.push?.pushUrl,ssh);
    assert.equal(git(repository.directory,'remote','get-url','origin'),f.remote);assert.equal(git(repository.directory,'remote','get-url','--push','origin'),ssh);
  }finally{await f.close();}
});

test('resolved Git push destinations are checked for known credentials before they are persisted',async()=>{
  const f=fixture();try{
    const repository=await f.repository(),unsafe=`https://example.invalid/${f.config.adminPassword}/packages.git`;
    git(repository.directory,'remote','set-url','--push','origin',unsafe);
    await assert.rejects(f.service.setPushSettings(repository.id,{enabled:true,autoPush:false}),/known credentials/);
    assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM repository_push_settings').get()?.n,0);
    await f.service.setPushSettings(repository.id,{enabled:true,autoPush:false,pushUrl:f.remote});
    await assert.rejects(f.service.setPushSettings(repository.id,{enabled:true,autoPush:false,pushUrl:null}),/known credentials/);
    assert.equal(f.service.repository(repository.id).push?.pushUrl,f.remote);assert.equal(f.service.repository(repository.id).push?.enabled,true);
  }finally{await f.close();}
});
