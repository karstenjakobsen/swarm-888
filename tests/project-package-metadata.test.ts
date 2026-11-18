import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ProjectService } from '../src/projects/service.ts';
import { ManagedService } from '../src/managed/service.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import type { WorkerClient } from '../src/ipc.ts';

const git=(directory:string,...args:string[])=>execFileSync('git',['-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-project-metadata-')),stateDir=join(root,'state');
  const config:Config={stateDir,projectsDir:join(root,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'metadata-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const store=new Store(stateDir),worker=new EventEmitter() as WorkerClient;
  const projects=new ProjectService(config,store,worker,()=>false),managed=new ManagedService(config,store,projects,worker);
  const connectors=new ConnectorService(store,worker,projects,managed);
  const repository=await managed.packages.register({name:'Project packages',remoteUrl:'https://example.test/project-metadata.git',mode:'create'});
  return {root,store,projects,managed,connectors,repository,close(){projects.close();store.close();rmSync(root,{recursive:true,force:true});}};
}

test('project details become package commits while runtime identity and settings stay local',async()=>{
  const f=await fixture();
  try{
    const project=await f.managed.createProject({name:'Before',description:'Original',repositoryId:f.repository.id,packagePath:'apps/website'});
    const component=f.projects.addComponent(project.id,{name:'Site',kind:'website',url:'https://example.test'}),conversation=f.projects.newConversation(project.id);
    mkdirSync(project.directory,{recursive:true});writeFileSync(join(project.directory,'.env'),'TOKEN=local-runtime-secret\n');
    const updated=await f.managed.updateProject(project.id,{name:'After',description:'Reusable package',defaultWorkerId:'default'});
    assert.equal(updated.id,project.id);assert.equal(updated.directory,project.directory);assert.equal(updated.components[0].id,component.id);assert.deepEqual(updated.conversationIds,[conversation.id]);assert.equal(updated.defaultWorkerId,'default');
    assert.notEqual(updated.source?.commit,project.source?.commit);
    const manifest=f.managed.packages.manifest(project.id);assert.equal(manifest.id,project.id);assert.equal(manifest.name,'After');assert.equal(manifest.description,'Reusable package');assert.equal(manifest.version,'0.1.0');
    assert.equal(readFileSync(join(project.directory,'.env'),'utf8'),'TOKEN=local-runtime-secret\n');
    assert(!git(f.repository.directory,'ls-tree','-r','--name-only','HEAD').includes('.env'));
    const commit=updated.source?.commit;
    await f.managed.updateProject(project.id,{defaultWorkerId:null});assert.equal(f.projects.get(project.id).source?.commit,commit,'Worker selection does not create a portable source revision');
    await f.managed.updateProject(project.id,{name:'After',description:'Reusable package'});assert.equal(f.projects.get(project.id).source?.commit,commit,'Unchanged details do not create source revisions');
  }finally{f.close();}
});

test('failed project metadata writes preserve registry and committed package metadata',async()=>{
  const f=await fixture();
  try{
    const project=await f.managed.createProject({name:'Original',repositoryId:f.repository.id,packagePath:'apps/safe'});
    await assert.rejects(f.managed.updateProject(project.id,{name:'Rejected',defaultWorkerId:'missing-worker'}),/Default worker is not registered/);
    assert.equal(f.projects.get(project.id).name,'Original');assert.equal(f.managed.packages.manifest(project.id).name,'Original');
    await assert.rejects(f.managed.updateProject(project.id,{description:'metadata-fixture-password'}),/credential|secret/i);
    assert.equal(f.projects.get(project.id).description,'');assert.equal(f.managed.packages.manifest(project.id).description,'');assert.equal(git(f.repository.directory,'rev-parse','HEAD'),project.source?.commit);
    writeFileSync(join(project.source!.workspacePath,'README.md'),'Pending authored work\n');
    await assert.rejects(f.managed.updateProject(project.id,{name:'Rejected'}),/Commit or resolve pending source changes/);
    assert.equal(f.projects.get(project.id).name,'Original');assert.equal(f.projects.get(project.id).source?.commit,project.source?.commit);
    assert.equal(readFileSync(join(project.source!.workspacePath,'README.md'),'utf8'),'Pending authored work\n');
    const legacy=f.projects.create({name:'Legacy registry entry'});
    await assert.rejects(f.managed.updateProject(legacy.id,{description:'Must be portable'}),/Adopt this project/);
    assert.equal((await f.managed.updateProject(legacy.id,{defaultWorkerId:'default'})).defaultWorkerId,'default');
  }finally{f.close();}
});

test('editing committed package metadata refreshes project details without replacing its runtime',async()=>{
  const f=await fixture();
  try{
    const project=await f.managed.createProject({name:'Editor original',repositoryId:f.repository.id,packagePath:'apps/editor'});
    const value=await f.managed.readSource(project.id),manifest={...value.manifest,name:'Edited in source',description:'The manifest owns these details'};
    await f.managed.writeSource(project.id,{files:{'operator-package.json':JSON.stringify(manifest,null,2)+'\n'},expectedCommit:value.source.commit});
    assert.equal(f.projects.get(project.id).name,manifest.name);assert.equal(f.projects.get(project.id).description,manifest.description);assert.equal(f.projects.get(project.id).directory,project.directory);
    const disk={...manifest,name:'Edited by a task'};writeFileSync(join(project.source!.workspacePath,'operator-package.json'),JSON.stringify(disk,null,2)+'\n');
    await f.managed.commitSource(project.id);assert.equal(f.projects.get(project.id).name,disk.name);
  }finally{f.close();}
});

test('accepted connector source metadata stays consistent across project and connection editors',async()=>{
  const f=await fixture();
  try{
    const connection=await f.connectors.createPackaged({name:'Original connection',description:'Old description',transport:'http',url:'https://example.test/mcp',enabled:false,repositoryId:f.repository.id,packagePath:'connectors/metadata'});
    const packageId=connection.packageId!,auth={type:'bearer' as const,credentialId:randomUUID(),field:'token'};
    f.connectors.setAuth(connection.id,auth);
    const source=await f.managed.readSource(packageId),manifest={...source.manifest,name:'Source-edited connection',description:'Source description'};
    await f.managed.writeSource(packageId,{files:{'operator-package.json':JSON.stringify(manifest,null,2)+'\n'},expectedCommit:source.source.commit});
    assert.equal(f.connectors.get(connection.id).name,manifest.name);assert.equal(f.connectors.get(connection.id).description,manifest.description);
    assert.deepEqual(f.connectors.get(connection.id).auth,auth);assert.equal(f.connectors.get(connection.id).enabled,false);
    await f.connectors.updatePackaged(connection.id,{name:'Connection editor rename'});
    assert.equal(f.managed.packages.manifest(packageId).description,'Source description','A connection rename must preserve the latest source description');
    await f.managed.updateProject(packageId,{description:'Project editor description'});
    assert.equal(f.connectors.get(connection.id).description,'Project editor description');
    const disk={...f.managed.packages.manifest(packageId),name:'Task-edited connection'};
    writeFileSync(join(connection.source!.workspacePath,'operator-package.json'),JSON.stringify(disk,null,2)+'\n');
    await f.managed.commitSource(packageId);assert.equal(f.connectors.get(connection.id).name,disk.name);
  }finally{f.close();}
});

test('source metadata name conflicts fail before modifying source or accepting a Git commit',async()=>{
  const f=await fixture();
  try{
    const connection=await f.connectors.createPackaged({name:'Source connection',transport:'http',url:'https://example.test/mcp',repositoryId:f.repository.id,packagePath:'connectors/conflicts'});
    f.connectors.create({name:'Reserved connection',transport:'http',url:'https://example.test/other'});
    const packageId=connection.packageId!,original=await f.managed.readSource(packageId),manifest={...original.manifest,name:'Reserved connection'},file=join(connection.source!.workspacePath,'operator-package.json');
    await assert.rejects(f.managed.updateProject(packageId,{name:manifest.name}),/already registered/);
    await assert.rejects(f.managed.writeSource(packageId,{files:{'operator-package.json':JSON.stringify(manifest)}}),/already registered/);
    assert.equal(readFileSync(file,'utf8'),original.files['operator-package.json']);assert.equal(git(f.repository.directory,'rev-parse','HEAD'),original.source.commit);
    writeFileSync(file,JSON.stringify(manifest,null,2)+'\n');
    await assert.rejects(f.managed.commitSource(packageId),/already registered/);
    assert.equal(git(f.repository.directory,'rev-parse','HEAD'),original.source.commit);assert.equal(f.connectors.get(connection.id).name,'Source connection');
  }finally{f.close();}
});

test('concurrent connector name changes reject conflicts before committing across repositories',async context=>{
  for(const mode of ['project','source','commit'])await context.test(mode,async()=>{
    const f=await fixture();try{
      const second=await f.managed.packages.register({name:'Independent repository',remoteUrl:'https://example.test/independent.git',mode:'create'});
      const connections=await Promise.all([f.repository,second].map((repository,index)=>f.connectors.createPackaged({name:`Connection ${index}`,transport:'http',url:'https://example.test/mcp',repositoryId:repository.id,packagePath:'connectors/service'})));
      const initial=connections.map(connection=>({name:connection.name,commit:connection.source!.commit}));
      const operations=connections.map(connection=>{
        const id=connection.packageId!,manifest={...f.managed.packages.manifest(id),name:'Concurrent target'};
        if(mode==='project')return f.managed.updateProject(id,{name:manifest.name});
        if(mode==='source')return f.managed.writeSource(id,{files:{'operator-package.json':JSON.stringify(manifest,null,2)+'\n'}});
        writeFileSync(join(connection.source!.workspacePath,'operator-package.json'),JSON.stringify(manifest,null,2)+'\n');
        return f.managed.commitSource(id);
      });
      const results=await Promise.allSettled(operations);assert.equal(results.filter(result=>result.status==='fulfilled').length,1);
      for(const [index,result] of results.entries()){
        const connection=connections[index],id=connection.packageId!,accepted=f.managed.packages.manifest(id);
        if(result.status==='rejected'){
          assert.match(result.reason.message,/already registered/);assert.equal(result.reason.statusCode,409);
          assert.equal(f.managed.packages.source(id).commit,initial[index].commit,'A rejected metadata edit must not create a Git commit');
          assert.equal(accepted.name,initial[index].name);
        }else assert.equal(accepted.name,'Concurrent target');
        assert.equal(f.connectors.get(connection.id).name,accepted.name);assert.equal(f.projects.get(id).name,accepted.name);
      }
    }finally{f.close();}
  });
});

test('connector name coordination covers creation and registration while independent names remain parallel',async()=>{
  const f=await fixture();let release=()=>{};const operations:Promise<unknown>[]=[];
  try{
    const second=await f.managed.packages.register({name:'Independent names',remoteUrl:'https://example.test/independent-names.git',mode:'create'}),third=await f.managed.packages.register({name:'Incoming packages',remoteUrl:'https://example.test/incoming.git',mode:'create'});
    const connections=await Promise.all([f.repository,second].map((repository,index)=>f.connectors.createPackaged({name:`Original ${index}`,transport:'http',url:'https://example.test/mcp',repositoryId:repository.id,packagePath:'connectors/service'})));
    const pending=await f.managed.createPackage(third.id,{name:'Reserved target',kind:'connector',template:'empty',path:'connectors/imported',mcp:{transport:'http',url:'https://example.test/mcp'}});
    await f.managed.materializePackage(pending);
    let started=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const write=f.managed.packages.writeTextFiles.bind(f.managed.packages);
    f.managed.packages.writeTextFiles=async(id,...args)=>{if(id===connections[0].packageId){started();await gate;}return write(id,...args);};
    const rename=f.managed.updateProject(connections[0].packageId!,{name:pending.name});operations.push(rename);await entered;
    let independentFinished=false;
    const independent=f.managed.updateProject(connections[1].packageId!,{name:'Independent target'}).then(value=>{independentFinished=true;return value;});operations.push(independent);
    const competing=Promise.allSettled([
      f.connectors.registerProject(pending.id),
      f.connectors.createPackaged({name:pending.name,transport:'http',url:'https://example.test/mcp',repositoryId:third.id,packagePath:'connectors/new'}),
    ]);operations.push(competing);
    await new Promise<void>(resolve=>setImmediate(resolve));
    assert(independentFinished,'An unrelated connector name in another repository must not wait for the blocked edit');
    assert.equal(f.connectors.list().length,2);assert.equal(f.managed.packages.listPackages(third.id).length,1);
    release();await Promise.all([rename,independent]);
    const results=await competing;assert(results.every(result=>result.status==='rejected'&&result.reason.statusCode===409));
    assert.equal(f.connectors.get(connections[0].id).name,pending.name);assert.equal(f.connectors.get(connections[1].id).name,'Independent target');
    assert.equal(f.managed.packages.listPackages(third.id).length,1,'Rejected connection creation must not leave a committed package');
  }finally{release();await Promise.allSettled(operations);f.close();}
});

test('queued description edits and adoptions reject a changed implicit connector name before committing',async()=>{
  const f=await fixture();let release=()=>{};const operations:Promise<unknown>[]=[];
  try{
    const connection=await f.connectors.createPackaged({name:'Original name',transport:'http',url:'https://example.test/mcp',repositoryId:f.repository.id,packagePath:'connectors/renamed'});
    let started=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const held=f.managed.withConnectorName(connection.name,async()=>{started();await gate;});operations.push(held);await entered;
    const description=f.managed.updateProject(connection.packageId!,{description:'Queued description'});operations.push(description);
    const rejected=assert.rejects(description,error=>error instanceof Error&&/source changed/.test(error.message)&&(error as {statusCode?:number}).statusCode===409);
    const adoption=f.connectors.adoptPackage(connection.id,{repositoryId:f.repository.id,packagePath:connection.source!.path});operations.push(adoption);
    const rejectedAdoption=assert.rejects(adoption,error=>error instanceof Error&&/source changed/.test(error.message)&&(error as {statusCode?:number}).statusCode===409);
    await f.managed.updateProject(connection.packageId!,{name:'New name'});
    const renamedCommit=f.managed.packages.source(connection.packageId!).commit;
    release();await Promise.all([held,rejected,rejectedAdoption]);
    assert.equal(f.managed.packages.source(connection.packageId!).commit,renamedCommit);
    assert.equal(f.managed.packages.manifest(connection.packageId!).description,'');assert.equal(f.connectors.get(connection.id).name,'New name');
  }finally{release();await Promise.allSettled(operations);f.close();}
});
