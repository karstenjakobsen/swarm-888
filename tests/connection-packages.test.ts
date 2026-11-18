import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ProjectService } from '../src/projects/service.ts';
import { ManagedService } from '../src/managed/service.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { CredentialVault } from '../src/credentials/vault.ts';
import type { WorkerClient } from '../src/ipc.ts';
import type { RuntimeReceipts } from '../src/runtime-receipts.ts';

async function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-connection-packages-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'connection-packages-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const store=new Store(stateDir),client=new EventEmitter() as WorkerClient,projects=new ProjectService(config,store,client,()=>false),managed=new ManagedService(config,store,projects,client),vault=new CredentialVault(stateDir,store.db),connectors=new ConnectorService(store,client,projects,managed,undefined,vault);
  managed.packages.setSecretGuard(value=>vault.assertSafe(value));
  const repository=await managed.packages.register({name:'Connection packages',remoteUrl:'https://example.test/connections.git',mode:'create'});
  const git=(...args:string[])=>execFileSync('git',['-C',repository.directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
  return {store,client,projects,managed,vault,connectors,repository,git,async close(){await managed.packages.closePublishing();projects.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('adoption recovers a committed package after interrupted materialization without changing local identity or authorization',async()=>{
  const f=await fixture();try{
    const owner=await f.managed.createProject({name:'Owning site',repositoryId:f.repository.id,packagePath:'apps/site'});
    const connection=f.connectors.create({name:'Existing HTTP tools',description:'Owner configuration',transport:'http',url:'https://tools.example.test/mcp',projectId:owner.id,enabled:false});
    f.connectors.assign(owner.id,{connectorIds:[connection.id]});
    const credential=f.vault.create({name:'Private token',values:{token:'connection-package-private-secret'}}),auth={type:'bearer' as const,credentialId:credential.id,field:'token'};
    f.vault.grant(credential.id,connection.id);f.connectors.setAuth(connection.id,auth);
    assert.equal(f.connectors.get(connection.id).source,undefined,'A related ordinary project does not supply connector source');
    const materialize=f.managed.materializePackage.bind(f.managed);let interrupted=true;
    f.managed.materializePackage=async record=>{if(interrupted){interrupted=false;throw new Error('Simulated stop after Git commit');}return materialize(record);};
    const location={repositoryId:f.repository.id,packagePath:'connectors/existing'};
    await assert.rejects(f.connectors.adoptPackage(connection.id,location),/Simulated stop/);
    const committed=f.git('rev-parse','HEAD');assert.equal(f.connectors.get(connection.id).packageId,null);
    const adopted=await f.connectors.adoptPackage(connection.id,location);
    assert.equal(adopted.id,connection.id);assert.equal(adopted.projectId,owner.id);assert.equal(adopted.enabled,false);assert.deepEqual(adopted.auth,auth);assert.equal(adopted.packageId,connection.id);assert.equal(adopted.source?.packageId,connection.id);
    assert.deepEqual(f.store.connectors.assigned(owner.id),[connection.id]);assert.equal(f.git('rev-parse','HEAD'),committed);
    const repeated=await f.connectors.adoptPackage(connection.id,location);assert.equal(repeated.id,connection.id);
    const registered=await f.connectors.registerProject(adopted.packageId!);assert.equal(registered.id,connection.id);assert.equal(f.connectors.list().length,1);
    const manifest=readFileSync(join(f.repository.directory,location.packagePath,'operator-package.json'),'utf8');assert(!manifest.includes(credential.id));assert(!manifest.includes('connection-package-private-secret'));assert.equal(JSON.parse(manifest).mcp.url,'https://tools.example.test/mcp');
  }finally{await f.close();}
});

test('unsafe local directory adoption and failed package creation leave the installed connection intact',async()=>{
  const f=await fixture();try{
    const local=f.connectors.create({name:'Local source',transport:'stdio',command:'node',args:['server.mjs'],cwd:'/local/private-source'}),before=f.git('rev-parse','HEAD');
    await assert.rejects(f.connectors.adoptPackage(local.id,{repositoryId:f.repository.id,packagePath:'connectors/local'}),/local working directory/);
    assert.equal(f.git('rev-parse','HEAD'),before);assert.equal(f.managed.packages.listPackages().length,0);assert.equal(f.connectors.get(local.id).packageId,null);
    const legacy=f.connectors.create({name:'Legacy remote',transport:'http',url:'https://legacy.example.test/mcp'});
    await assert.rejects(f.connectors.adoptPackage(legacy.id,{repositoryId:f.repository.id,packagePath:'../escape'}));
    assert.equal(f.git('rev-parse','HEAD'),before);assert.equal(f.connectors.get(legacy.id).packageId,null);
    await assert.rejects(f.connectors.updatePackaged(legacy.id,{name:'Uncommitted rename'}),/Adopt this connection/);
    assert.equal(f.connectors.get(legacy.id).name,legacy.name);
    assert.equal((await f.connectors.updatePackaged(legacy.id,{enabled:false})).enabled,false);
  }finally{await f.close();}
});

test('a new connection cannot bypass repository requirements through legacy project registration',async()=>{
  const f=await fixture();try{
    const project=f.projects.create({name:'Legacy connector'}),source={repositoryPath:f.repository.directory,branch:'legacy',path:'legacy/connector',workspacePath:f.repository.directory,commit:'a'.repeat(40),dirty:false};
    f.store.managed.saveSource(project.id,'connector',source);
    f.managed.readReleaseSource=async()=>({source,manifest:{schemaVersion:1,id:project.id,kind:'connector',name:project.name,description:'',mcp:{transport:'http',url:'https://legacy.example.test/mcp'}}});
    await assert.rejects(f.connectors.registerProject(project.id),/Migrate this connector source/);
    assert.equal(f.connectors.list().length,0);
    const installed=f.connectors.create({name:project.name,projectId:project.id,transport:'http',url:'https://legacy.example.test/mcp'});
    assert.equal((await f.connectors.registerProject(project.id)).id,installed.id,'Existing legacy registrations remain usable during migration');
  }finally{await f.close();}
});

test('packaged creation retries after an interrupted registration without committing or creating a duplicate',async()=>{
  const f=await fixture();try{
    const input={name:'Interrupted HTTP registration',transport:'http',url:'https://new.example.test/mcp',repositoryId:f.repository.id,packagePath:'connectors/retry'};
    const materialize=f.managed.materializePackage.bind(f.managed);let interrupted=true;
    f.managed.materializePackage=async record=>{if(interrupted){interrupted=false;throw new Error('Interrupted registration');}return materialize(record);};
    await assert.rejects(f.connectors.createPackaged(input),/Interrupted registration/);
    const committed=f.git('rev-parse','HEAD'),created=await f.connectors.createPackaged(input),retried=await f.connectors.createPackaged(input);
    assert.equal(retried.id,created.id);assert.equal(f.git('rev-parse','HEAD'),committed);assert.equal(f.connectors.list().length,1);assert.equal(f.managed.packages.listPackages().length,1);
  }finally{await f.close();}
});

test('direct service calls keep explicit task ownership while creating and updating a package',async()=>{
  const f=await fixture();try{
    const project=f.projects.create({name:'Task context'}),conversation=f.projects.newConversation(project.id),run=f.store.enqueue(conversation.id,'Create portable tools',randomUUID());
    f.store.db.prepare("UPDATE runs SET status='running' WHERE id=?").run(run.id);
    const input={name:'Task-owned HTTP tools',transport:'http',url:'https://task.example.test/mcp',repositoryId:f.repository.id,packagePath:'connectors/task-owned'};
    const connection=await f.connectors.createPackaged(input,run.id);
    assert.equal((f.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(f.repository.id) as {runId:string}).runId,run.id);
    const edited=await f.connectors.updatePackaged(connection.id,{description:'Written by the same task'},run.id);
    assert.equal(edited.description,'Written by the same task');assert(f.store.managed.pendingPackages(run.id).some(value=>value.packageId===connection.packageId));
    await assert.rejects(f.connectors.createPackaged({...input,name:'Other owner',packagePath:'connectors/other-owner'}),/Another task owns/);
  }finally{await f.close();}
});

test('packaged registration serializes duplicate names and failed metadata writes do not change installed details',async()=>{
  const f=await fixture();try{
    const input={name:'New HTTP tools',description:'Portable definition',transport:'http',url:'https://new.example.test/mcp',repositoryId:f.repository.id,packagePath:'connectors/new'};
    const results=await Promise.allSettled([f.connectors.createPackaged(input),f.connectors.createPackaged({...input,packagePath:'connectors/duplicate'})]);
    assert.equal(results.filter(value=>value.status==='fulfilled').length,1);assert.equal(f.connectors.list().length,1);assert.equal(f.managed.packages.listPackages().length,1);
    const connection=f.connectors.list()[0],manifest=f.managed.packages.manifest(connection.packageId!);
    assert.equal(manifest.check,undefined);assert.equal(manifest.build,undefined);assert.equal(manifest.run,undefined);assert.deepEqual(manifest.mcp,{transport:'http',url:input.url});
    const update=f.managed.updateProject.bind(f.managed);f.managed.updateProject=async()=>{throw new Error('Simulated rejected source write');};
    await assert.rejects(f.connectors.updatePackaged(connection.id,{description:'Uncommitted details'}),/rejected source write/);
    assert.equal(f.connectors.get(connection.id).description,input.description);assert.equal(f.managed.packages.manifest(connection.packageId!).description,input.description);
    f.managed.updateProject=update;
    const edited=await f.connectors.updatePackaged(connection.id,{name:'Renamed tools',description:'Shared details'});
    assert.equal(edited.name,'Renamed tools');assert.equal(f.managed.packages.manifest(connection.packageId!).description,'Shared details');assert.equal(f.projects.get(connection.packageId!).name,'Renamed tools');
    const path=join(f.repository.directory,input.packagePath,'operator-package.json'),pending=JSON.stringify({...f.managed.packages.manifest(connection.packageId!),mcp:{transport:'http',url:'https://pending.example.test/mcp'}},null,2)+'\n',commit=f.git('rev-parse','HEAD');
    writeFileSync(path,pending);
    await assert.rejects(f.connectors.updatePackaged(connection.id,{description:'Clobber pending transport'}),/resolve pending source changes/);
    assert.equal(readFileSync(path,'utf8'),pending);assert.equal(f.git('rev-parse','HEAD'),commit);assert.equal(f.connectors.get(connection.id).description,'Shared details');
  }finally{await f.close();}
});

test('reimporting an unchanged connector preserves an in-flight discovery and registry timestamps',async()=>{
  const f=await fixture();let release=()=>{};let testing:Promise<unknown>|undefined;
  try{
    const connection=await f.connectors.createPackaged({name:'Stable HTTP tools',transport:'http',url:'https://stable.example.test/mcp',repositoryId:f.repository.id,packagePath:'connectors/stable'});
    const unchangedAt='2026-01-01T00:00:00.000Z';
    f.store.db.prepare('UPDATE connectors SET updatedAt=? WHERE id=?').run(unchangedAt,connection.id);
    f.store.db.prepare('UPDATE projects SET updatedAt=? WHERE id=?').run(unchangedAt,connection.packageId!);
    let started=()=>{};const entered=new Promise<void>(resolve=>{started=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    const receipts={request:async(_method:string,_input:unknown,guard?:()=>void)=>{guard?.();started();await gate;return {tools:[{name:'echo',inputSchema:{type:'object'}}],checkedAt:new Date().toISOString()};}} as unknown as RuntimeReceipts;
    const connectors=new ConnectorService(f.store,f.client,f.projects,f.managed,receipts,f.vault);
    testing=connectors.test(connection.id);await entered;
    await f.managed.materializePackage(f.managed.packages.package(connection.packageId!));
    await connectors.registerProject(connection.packageId!);
    await connectors.updatePackaged(connection.id,{enabled:true,name:connection.name,description:connection.description});
    assert.equal(connectors.get(connection.id).updatedAt,unchangedAt);
    assert.equal(f.projects.get(connection.packageId!).updatedAt,unchangedAt);
    release();const tested=await testing as {status:string;tools:{name:string}[]};
    assert.equal(tested.status,'connected');assert.equal(tested.tools[0].name,'echo');
  }finally{release();await testing?.catch(()=>{});await f.close();}
});
