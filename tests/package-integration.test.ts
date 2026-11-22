import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';
import { ManagedRuntime } from '../src/runtime/managed.ts';
import { checkSkill } from '../src/runtime/fixtures.ts';
import type { WorkerClient } from '../src/ipc.ts';

const git=(directory:string,...args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@localhost','-C',directory,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function write(directory:string,path:string,content:string|Buffer){const target=join(directory,path);mkdirSync(dirname(target),{recursive:true});writeFileSync(target,content);}

/** Real controller, Git, SQLite, files and runtime preparation; no inference or service manager. */
class PackageWorker extends EventEmitter {
  readonly requests:Array<{method:string;input:any}>=[];
  readonly runtime:ManagedRuntime;
  constructor(private config:Config){super();this.runtime=new ManagedRuntime(config,async()=>{throw new Error('Package import and preparation must not start host commands');});}
  async connect(){return {connected:true as const,uid:process.getuid!(),root:process.getuid!()===0,pid:process.pid,activeRunId:null,uncertainRuns:[],runtimeOperations:[],projectsDir:this.config.projectsDir,runtime:{available:true,authenticated:true,version:'package fixture',detail:'No inference or service actions'}};}
  async request(method:string,input:any={}){this.requests.push({method,input});if(method==='managed/prepare')return this.runtime.prepare(input);throw new Error(`Unexpected package fixture request ${method}`);}
  close(){}
}
async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-package-integration-')),stateDir=join(root,'state'),repositoryPath=join(root,'operator');mkdirSync(repositoryPath);git(repositoryPath,'init','-q','-b','main');write(repositoryPath,'operator.ts','// Owner maintained operator\n');git(repositoryPath,'add','.');git(repositoryPath,'commit','-qm','Operator baseline');
  const ownerHead=git(repositoryPath,'rev-parse','HEAD');
  const config:Config={stateDir,repositoryPath,projectsDir:join(root,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'package-integration-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const worker=new PackageWorker(config),ctl=await createController(config,{client:worker as unknown as WorkerClient,startQueue:false,startBridge:false});ctl.brain.skillAction('skill-maintenance','disable');
  const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}}),headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  const request=(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:Record<string,unknown>)=>ctl.app.inject({method,url,headers,...(payload===undefined?{}:{payload})});
  const api=async(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:Record<string,unknown>)=>{const response=await request(method,url,payload);assert.equal(response.statusCode,200,`${method} ${url}: ${response.body}`);return response.json();};
  const repository=(name='Local packages')=>api('POST','/api/repositories',{name,remoteUrl:`https://example.test/${name.toLowerCase().replaceAll(' ','-')}.git`,mode:'create'});
  return {root,config,worker,ctl,headers,request,api,repository,ownerHead,async close(){await ctl.close();await worker.runtime.close();assert.equal(git(repositoryPath,'rev-parse','HEAD'),ownerHead);assert.equal(git(repositoryPath,'status','--porcelain'),'');rmSync(root,{recursive:true,force:true});}};
}

/** Persist an installation's pre-existing branch choices without reopening that setup in the new API. */
function legacyRepository(f:Awaited<ReturnType<typeof fixture>>,remoteUrl:string,sourceBranch:string){
  const id=randomUUID(),directory=join(f.config.projectsDir!,'repositories',id),now=new Date().toISOString();
  mkdirSync(dirname(directory),{recursive:true});git(f.root,'clone','--quiet','--no-local','--single-branch','--branch',sourceBranch,remoteUrl,directory);git(directory,'checkout','-qb','operator/work');
  f.ctl.managed.packages.store.saveRepository({id,name:'Existing branch repository',remoteUrl,directory,branch:'operator/work',sourceBranch,syncMode:'legacy',status:'ready',error:null,createdAt:now,updatedAt:now});
  return f.ctl.managed.packages.repository(id);
}

function externalPackages(root:string){
  const directory=join(root,'remote'),sentinel=join(root,'must-not-execute');mkdirSync(directory);git(directory,'init','-q','-b','main');
  const command={command:process.execPath,args:['-e',`require('node:fs').writeFileSync(${JSON.stringify(sentinel)},'executed')`]},ids={project:randomUUID(),connector:randomUUID(),skill:randomUUID()};
  const project={schemaVersion:1,id:ids.project,kind:'project',name:'Imported site',version:'1.2.3',description:'A source package',check:command,run:command};
  const connector={schemaVersion:1,id:ids.connector,kind:'connector',name:'Imported connector',version:'0.4.0',description:'Imported MCP package',check:command,mcp:{transport:'stdio',command:process.execPath,args:['server.mjs']}};
  const skill={schemaVersion:1,id:ids.skill,kind:'skill',name:'imported-report',version:'2.0.0',description:'A reusable imported report'};
  write(directory,'apps/site/operator-package.json',JSON.stringify(project));write(directory,'apps/site/server.mjs','console.log("source only");\n');
  const binary=Buffer.alloc(9_000_001,255);write(directory,'apps/site/assets/image.bin',binary);
  write(directory,'connectors/provider/operator-package.json',JSON.stringify(connector));write(directory,'connectors/provider/server.mjs','console.log("source only");\n');
  write(directory,'skills/report/operator-package.json',JSON.stringify(skill));write(directory,'skills/report/SKILL.md','---\nname: imported-report\ndescription: Produce a reproducible imported report.\n---\nRun the helper when asked for a report.\n');write(directory,'skills/report/report.mjs','console.log("report");\n');write(directory,'skills/report/skill-checks.json',JSON.stringify({checks:[{name:'import must not execute this check',...command,fixtures:{},expectedStdout:''}]}));
  git(directory,'add','.');git(directory,'commit','-qm','Three portable packages');return {directory,sentinel,ids,project,connector,skill,binary,commit:git(directory,'rev-parse','HEAD')};
}

test('repository APIs require a remote and every new project or package gets a canonical v1 manifest and local Git commit',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.request('POST','/api/repositories',{name:'Missing remote'})).statusCode,400);
    assert.equal((await f.request('POST','/api/repositories',{name:'Embedded credential',remoteUrl:'https://secret@example.test/repo.git'})).statusCode,400);
    assert.equal((await f.request('POST','/api/projects',{name:'Missing source repository'})).statusCode,400);
    assert.equal(f.ctl.projects.list().length,0);
    const repository=await f.repository();assert(repository.directory.startsWith(`${f.config.projectsDir}/repositories/`));assert.equal(git(repository.directory,'remote','get-url','origin'),repository.remoteUrl);assert.equal(repository.branch,'main');assert.equal(repository.sourceBranch,'main');assert.equal(repository.syncMode,'main');assert.equal(repository.push.enabled,true);assert.equal(repository.push.autoPush,true);assert.equal(repository.push.branch,'main');assert.equal(repository.push.pushUrl,repository.remoteUrl);
    const project=await f.api('POST','/api/projects',{name:'Registered website',repositoryId:repository.id,packagePath:'apps/website',template:'service'});assert.equal(project.source.repositoryId,repository.id);assert.equal(project.source.path,'apps/website');
    const connector=await f.api('POST',`/api/repositories/${repository.id}/packages`,{kind:'connector',name:'Registered connector',path:'connectors/echo',version:'0.2.0',template:'connector'});
    const skill=await f.api('POST',`/api/repositories/${repository.id}/packages`,{kind:'skill',name:'registered-report',path:'skills/report',version:'0.3.0'});
    const packages=await f.api('GET','/api/packages');assert.equal(packages.length,3);assert.equal(f.ctl.connectors.list().find(value=>value.projectId===connector.id)?.source?.packageId,connector.id);
    for(const value of packages){const manifest=JSON.parse(readFileSync(join(repository.directory,value.path,'operator-package.json'),'utf8'));assert.equal(manifest.schemaVersion,1);assert.equal(manifest.id,value.id);assert.equal(manifest.kind,value.kind);assert.equal(manifest.version,value.version);assert.match(value.lastImportedCommit,/^[0-9a-f]{40,64}$/);}
    assert(existsSync(join(repository.directory,skill.path,'SKILL.md')));assert.equal(git(repository.directory,'status','--porcelain'),'');assert.equal(f.worker.requests.length,0);
    const history=await f.api('GET',`/api/repositories/${repository.id}/imports`);assert.equal(history.length,3);assert(history.every((value:any)=>value.status==='imported'&&value.finishedAt&&value.schemaVersion===1));
    assert.equal((await f.request('POST',`/api/repositories/${repository.id}/packages`,{kind:'project',name:'Traversal',path:'../escape',version:'1.0.0'})).statusCode,400);
  }finally{await f.close();}
});

test('connection APIs require package source and publish portable metadata edits as Git commits',async()=>{
  const f=await fixture();try{
    const remote=join(f.root,'connections.git');mkdirSync(remote);git(remote,'init','--quiet','--bare');
    const repository=await f.api('POST','/api/repositories',{name:'Connection packages',remoteUrl:remote,mode:'create'});
    await f.api('PATCH',`/api/repositories/${repository.id}/push-settings`,{enabled:true,autoPush:true,branch:'main'});
    const definition={name:'HTTP tools',description:'Portable service endpoint',transport:'http',url:'https://tools.example.test/mcp',repositoryId:repository.id,packagePath:'connectors/http'};
    assert.equal((await f.ctl.app.inject({method:'POST',url:'/api/connectors',headers:{origin:f.headers.origin},payload:definition})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'POST',url:'/api/connectors',headers:{...f.headers,'x-csrf-token':'invalid'},payload:definition})).statusCode,403);
    assert.equal((await f.request('POST','/api/connectors',{name:'No source',transport:'http',url:definition.url})).statusCode,400);
    assert.equal(f.ctl.connectors.list().length,0);
    const connection=await f.api('POST','/api/connectors',definition),packageId=connection.source.packageId;
    assert.equal(connection.packageId,packageId);assert.equal(connection.source.repositoryId,repository.id);
    const source=await f.api('GET',`/api/projects/${packageId}/source`);
    assert.deepEqual(source.manifest.mcp,{transport:'http',url:definition.url});assert.equal(source.manifest.kind,'connector');
    assert.equal(source.manifest.build,undefined);assert.equal(source.manifest.check,undefined);assert.equal(source.files['server.mjs'],undefined);
    const updated=await f.api('PATCH',`/api/connectors/${connection.id}`,{name:'Renamed HTTP tools',description:'Updated portable endpoint'});
    assert.notEqual(updated.source.commit,connection.source.commit);
    const manifest=JSON.parse(readFileSync(join(repository.directory,'connectors/http/operator-package.json'),'utf8'));
    assert.equal(manifest.name,updated.name);assert.equal(manifest.description,updated.description);
    const disabled=await f.api('PATCH',`/api/connectors/${connection.id}`,{enabled:false});assert.equal(disabled.enabled,false);assert.equal(disabled.source.commit,updated.source.commit);
    await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:['connectors/http']});
    assert.equal(f.ctl.connectors.list().length,1);assert.equal(f.ctl.connectors.get(connection.id).enabled,false);
    for(let attempt=0;attempt<3;attempt++)await f.ctl.managed.packages.flushPushes();
    assert.equal(git(remote,'rev-parse','refs/heads/main'),updated.source.commit);
    assert.equal(JSON.parse(git(remote,'show','main:connectors/http/operator-package.json')).name,updated.name);
    assert.equal(f.worker.requests.length,0);
  }finally{await f.close();}
});

test('adopting a legacy connection retains identity, credentials and assignments through reimport',async()=>{
  const f=await fixture();try{
    const repository=await f.repository(),owner=f.ctl.projects.create({name:'Existing association'}),consumer=f.ctl.projects.create({name:'Connection consumer'});
    const connection=f.ctl.connectors.create({name:'Existing HTTP connection',transport:'http',url:'https://tools.example.test/mcp',projectId:owner.id,enabled:false});
    const credential=f.ctl.vault.create({name:'Connection secret',values:{token:'legacy-adoption-private-token'}});
    f.ctl.connectors.setAuth(connection.id,{type:'bearer',credentialId:credential.id,field:'token'});
    f.ctl.connectors.assign(consumer.id,{connectorIds:[connection.id]});
    const url=`/api/connectors/${connection.id}/package`,location={repositoryId:repository.id,packagePath:'connectors/existing'};
    assert.equal((await f.ctl.app.inject({method:'POST',url,headers:{...f.headers,'x-csrf-token':'invalid'},payload:location})).statusCode,403);
    const adopted=await f.api('POST',url,location);
    assert.equal(adopted.id,connection.id);assert.equal(adopted.projectId,owner.id);assert.equal(adopted.enabled,false);
    assert.deepEqual(adopted.auth,{type:'bearer',credentialId:credential.id,field:'token'});
    assert.deepEqual(f.ctl.projects.get(consumer.id).connectorIds,[connection.id]);
    assert.equal((await f.api('POST',url,location)).source.commit,adopted.source.commit);
    assert.equal((await f.request('POST',url,{...location,packagePath:'connectors/elsewhere'})).statusCode,409);
    await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:[location.packagePath]});
    const current=f.ctl.connectors.get(connection.id);assert.equal(f.ctl.connectors.list().length,1);assert.equal(current.id,connection.id);assert.deepEqual(current.auth,adopted.auth);
    const committed=git(repository.directory,'show',`HEAD:${location.packagePath}/operator-package.json`);
    for(const value of ['legacy-adoption-private-token',credential.id,'auth','enabled','projectId'])assert(!committed.includes(value),value);
    assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    // Removing the source registration must also remove its connection even when its original project association differs.
    f.ctl.projects.remove(adopted.source.packageId);assert.equal(f.ctl.connectors.list().length,0);
    assert.deepEqual(f.ctl.projects.get(consumer.id).connectorIds??[],[]);assert.equal(f.ctl.projects.get(owner.id).id,owner.id);
    assert(existsSync(join(repository.directory,location.packagePath,'operator-package.json')));
  }finally{await f.close();}
});

test('main publication starts automatically and owner-authenticated settings pause it without letting model tools retarget it',async()=>{
  const f=await fixture();try{
    const remote=join(f.root,'publish-api.git');mkdirSync(remote);git(remote,'init','--quiet','--bare');
    const repository=await f.api('POST','/api/repositories',{name:'Publish API',remoteUrl:remote,mode:'create'}),url=`/api/repositories/${repository.id}/push-settings`,settings={enabled:true,autoPush:true};
    assert.equal(repository.push.enabled,true);assert.equal(repository.push.autoPush,true);assert.equal(repository.push.branch,'main');assert.equal(repository.push.pushUrl,remote);
    await f.api('PATCH',url,{enabled:false,autoPush:false});
    await assert.rejects(f.ctl.brain.callTool('repository_push',{id:repository.id}),/disabled/);
    assert.equal((await f.ctl.app.inject({method:'PATCH',url,headers:{origin:f.config.origins[0]},payload:settings})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'PATCH',url,headers:{...f.headers,'x-csrf-token':'invalid'},payload:settings})).statusCode,403);
    const enabled=await f.api('PATCH',url,settings);assert.equal(enabled.push.enabled,true);assert.equal(enabled.push.pushUrl,remote);assert.equal(enabled.push.branch,'main');
    assert.equal((await f.request('PATCH',url,{...settings,branch:'release/api'})).statusCode,409);
    assert.equal((await f.request('PATCH',url,{...settings,pushUrl:'https://other.invalid/repo.git'})).statusCode,409);
    await assert.rejects(f.ctl.brain.callTool('repository_push',{id:repository.id,pushUrl:'https://other.invalid/repo.git'}));
    assert.equal((await f.request('POST',`/api/repositories/${repository.id}/push`,{branch:'another-branch'})).statusCode,400);
    const record=await f.api('POST',`/api/repositories/${repository.id}/packages`,{kind:'project',name:'Published package',path:'apps/published',version:'1.0.0',template:'empty'});
    const queued=await f.ctl.brain.callTool('repository_push',{id:repository.id});assert.equal(queued.push.state,'pending');
    await f.ctl.managed.packages.flushPushes();await f.ctl.managed.packages.flushPushes();
    const observed=await f.api('GET',`/api/repositories/${repository.id}`);assert.equal(observed.push.state,'pushed');assert.equal(observed.push.pushedCommit,record.lastImportedCommit);assert.equal(git(remote,'rev-parse','refs/heads/main'),record.lastImportedCommit);
    assert.equal(git(repository.directory,'remote','get-url','origin'),remote);
  }finally{await f.close();}
});

test('legacy repository fetch API retains selected non-main previews and exact imports',async()=>{
  const f=await fixture();
  try{
    const remote=join(f.root,'branch-remote');mkdirSync(remote);git(remote,'init','-q','-b','release/stable');const manifest={schemaVersion:1,id:randomUUID(),kind:'project',name:'Branch package',version:'1.0.0',description:'Package without a main branch'};
    write(remote,'app/operator-package.json',JSON.stringify(manifest));git(remote,'add','.');git(remote,'commit','-qm','Stable package');const initial=git(remote,'rev-parse','HEAD');
    git(remote,'checkout','-qb','feature/new-package');write(remote,'app/operator-package.json',JSON.stringify({...manifest,version:'1.1.0'}));git(remote,'add','.');git(remote,'commit','-qm','Feature package');const feature=git(remote,'rev-parse','HEAD');
    const repository=legacyRepository(f,remote,'release/stable');assert.equal(repository.sourceBranch,'release/stable');assert.equal(repository.head,initial);
    const preview=await f.api('POST',`/api/repositories/${repository.id}/discover`,{refresh:true,branch:'feature/new-package'});assert.equal(preview.commit,feature);assert.equal(preview.remoteBranch,'feature/new-package');assert.equal(preview.packages[0].manifest.version,'1.1.0');assert.equal(preview.repository.sourceBranch,'release/stable');assert.equal(git(repository.directory,'rev-parse','HEAD'),initial);
    assert.equal((await f.request('POST',`/api/repositories/${repository.id}/discover`,{refresh:true,branch:'release/../escape'})).statusCode,400);assert.equal((await f.request('POST',`/api/repositories/${repository.id}/discover`,{refresh:true,branch:'missing'})).statusCode,409);assert.equal(git(repository.directory,'rev-parse','HEAD'),initial);assert.equal(git(repository.directory,'status','--porcelain'),'');
    const imported=await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:['app'],expectedCommit:preview.commit});assert.equal(imported.packages[0].lastImportedCommit,feature);assert.equal(imported.packages[0].version,'1.1.0');assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD'),repository.branch);
    const local=await f.api('GET',`/api/repositories/${repository.id}/discover`);assert.equal(local.remoteBranch,undefined);assert.equal(local.repository.sourceBranch,'release/stable');assert.equal(local.commit,feature);
  }finally{await f.close();}
});

test('switching an existing repository to main requires an owner request and preserves its accepted package source',async()=>{
  const f=await fixture();try{
    const remote=join(f.root,'legacy-api.git'),seed=join(f.root,'legacy-seed');mkdirSync(remote);git(remote,'init','-q','--bare');mkdirSync(seed);git(seed,'init','-q','-b','main');
    write(seed,'README.md','Existing repository\n');git(seed,'add','.');git(seed,'commit','-qm','Existing history');git(seed,'push','--quiet',remote,'main');
    const repository=legacyRepository(f,remote,'main'),record=await f.api('POST',`/api/repositories/${repository.id}/packages`,{kind:'project',name:'Existing package',path:'apps/existing',version:'1.0.0',template:'empty'});
    const url=`/api/repositories/${repository.id}/use-main`,head=git(repository.directory,'rev-parse','HEAD');
    assert.equal(f.ctl.managed.packages.repository(repository.id).push?.enabled,false);
    assert.equal((await f.ctl.app.inject({method:'POST',url,headers:{origin:f.config.origins[0]},payload:{}})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'POST',url,headers:{...f.headers,'x-csrf-token':'invalid'},payload:{}})).statusCode,403);
    assert.equal((await f.request('POST',url,{branch:'other'})).statusCode,400);
    assert.equal(f.ctl.managed.packages.repository(repository.id).syncMode,'legacy');
    const converted=await f.api('POST',url,{});
    assert.equal(converted.syncMode,'main');assert.equal(converted.sourceBranch,'main');assert.equal(converted.branch,'operator/work');assert.equal(converted.push.branch,'main');assert.equal(converted.push.pushUrl,remote);assert.equal(converted.push.autoPush,true);
    assert.equal(git(repository.directory,'rev-parse','HEAD'),head);assert.equal(f.ctl.managed.packages.package(record.id).lastImportedCommit,record.lastImportedCommit);
    await f.ctl.managed.packages.flushPushes();assert.equal(git(remote,'rev-parse','refs/heads/main'),head);
    assert.equal(f.ctl.projects.get(record.id).source?.commit,record.lastImportedCommit);assert.equal(f.worker.requests.length,0);
  }finally{await f.close();}
});

test('operator tools register main and fetch its exact new revision without changing the working checkout',async()=>{
  const f=await fixture();try{
    const remote=join(f.root,'operator-branch-remote');mkdirSync(remote);git(remote,'init','-q','-b','main');
    const manifest={schemaVersion:1,id:randomUUID(),kind:'project',name:'Operator branch package',version:'1.0.0',description:'Imported through operator tools'};
    write(remote,'apps/report/operator-package.json',JSON.stringify(manifest));git(remote,'add','.');git(remote,'commit','-qm','Stable source');
    const initial=git(remote,'rev-parse','HEAD'),repository=await f.ctl.brain.callTool('repository_register',{name:'Operator source',remoteUrl:remote,mode:'clone'});
    assert.equal(repository.syncMode,'main');assert.equal(repository.push.autoPush,true);assert.equal(repository.branch,'main');
    write(remote,'apps/report/operator-package.json',JSON.stringify({...manifest,version:'1.1.0'}));git(remote,'add','.');git(remote,'commit','-qm','New remote package revision');
    const latest=git(remote,'rev-parse','HEAD');
    const local=await f.ctl.brain.callTool('repository_discover',{id:repository.id});assert.equal(local.commit,initial);assert.equal(local.remoteBranch,undefined);
    await assert.rejects(f.ctl.brain.callTool('repository_discover',{id:repository.id,branch:'feature/operator-import'}),/refresh|branch/i);
    await assert.rejects(f.ctl.brain.callTool('repository_discover',{id:repository.id,refresh:true,branch:'release/../escape'}));
    await assert.rejects(f.ctl.brain.callTool('repository_discover',{id:repository.id,refresh:true,branch:'feature/operator-import'}),/main/);
    const preview=await f.ctl.brain.callTool('repository_discover',{id:repository.id,refresh:true});
    assert.equal(preview.commit,latest);assert.equal(preview.remoteBranch,'main');assert.equal(preview.packages[0].manifest.version,'1.1.0');
    assert.equal(git(repository.directory,'rev-parse','HEAD'),initial);assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD'),repository.branch);
    const imported=await f.ctl.brain.callTool('repository_import',{id:repository.id,paths:['apps/report'],expectedCommit:preview.commit});
    assert.equal(imported.packages[0].lastImportedCommit,latest);assert.equal(imported.packages[0].version,'1.1.0');
    assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD'),repository.branch);assert.equal(f.ctl.managed.packages.repository(repository.id).sourceBranch,'main');
    assert.equal(f.ctl.projects.get(manifest.id).source?.commit,latest);assert.equal(f.worker.requests.length,0);assert.equal(git(repository.directory,'status','--porcelain'),'');
  }finally{await f.close();}
});

test('clone, discovery and selected import register all package kinds without executing code, retain failed import history and prepare binary releases',async()=>{
  const f=await fixture();let executed=0;
  try{
    const remote=externalPackages(f.root);f.ctl.brain.setExecutor(async()=>{executed++;throw new Error('Import must not run checks');});
    const repository=await f.api('POST','/api/repositories',{name:'Imported packages',remoteUrl:remote.directory,branch:'main',mode:'clone'}),discovery=await f.api('GET',`/api/repositories/${repository.id}/discover`);
    assert.equal(discovery.commit,remote.commit);assert.deepEqual(discovery.packages.map((value:any)=>value.manifest.kind).sort(),['connector','project','skill']);assert.equal((await f.api('GET','/api/packages')).length,0);
    const paths=['apps/site','connectors/provider','skills/report'],imported=await f.api('POST',`/api/repositories/${repository.id}/import`,{paths,expectedCommit:discovery.commit});assert.equal(imported.packages.length,3);assert(imported.imports.every((value:any)=>value.status==='imported'));
    assert.equal(f.ctl.projects.get(remote.ids.project).source?.packageId,remote.ids.project);assert.equal(f.ctl.connectors.list().find(value=>value.projectId===remote.ids.connector)?.source?.packageId,remote.ids.connector);
    const skill=f.ctl.brain.skillGet('imported-report');assert.equal(skill.versions.length,1);assert.equal(skill.versions[0]?.state,'candidate');assert.equal(skill.activeVersion,null);assert.equal(executed,0);assert.equal(f.worker.requests.length,0);assert.equal(existsSync(remote.sentinel),false);
    const firstHistory=await f.api('GET',`/api/repositories/${repository.id}/imports`);assert.equal(firstHistory.length,3);
    await f.api('POST',`/api/repositories/${repository.id}/import`,{paths,expectedCommit:discovery.commit});assert.equal((await f.api('GET',`/api/repositories/${repository.id}/imports`)).length,3);assert.equal(f.ctl.brain.skillGet('imported-report').versions.length,1);
    const release=await f.ctl.managed.prepare(remote.ids.project);assert.deepEqual(readFileSync(join(release.releaseDirectory,'assets/image.bin')),remote.binary);assert.equal(existsSync(remote.sentinel),false);assert.equal(executed,0);
    // A malformed update remains visible in history while the prior package revision stays usable.
    write(repository.directory,'apps/site/operator-package.json',JSON.stringify({...remote.project,schemaVersion:99,version:'2.0.0'}));git(repository.directory,'add','.');git(repository.directory,'commit','-qm','Invalid next manifest');
    const invalid=await f.api('GET',`/api/repositories/${repository.id}/discover`),failed=await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:['apps/site'],expectedCommit:invalid.commit});assert.equal(failed.packages.length,0);assert.equal(failed.imports[0].status,'failed');assert(failed.imports[0].error);assert.equal(failed.imports[0].schemaVersion,99);assert.equal(failed.imports[0].packageVersion,'2.0.0');
    const retained=(await f.api('GET','/api/packages')).find((value:any)=>value.id===remote.ids.project);assert.equal(retained.lastImportedCommit,remote.commit);assert.equal(retained.version,'1.2.3');assert.equal((await f.api('GET',`/api/repositories/${repository.id}/imports`)).length,4);assert.equal(executed,0);assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.close();}
});

test('explicit migration preserves canonical project identity, runtime files, deployment and conversations',async()=>{
  const f=await fixture();
  try{
    const project=f.ctl.projects.create({name:'Legacy service'}),source=await f.ctl.managed.repository.create({id:project.id,kind:'project',name:project.name,template:'service'});f.ctl.store.managed.saveSource(project.id,'project',source.source);
    const conversation=f.ctl.projects.newConversation(project.id);mkdirSync(project.directory,{recursive:true});write(project.directory,'runtime-data.txt','keep runtime data');
    const deployment={commit:source.source.commit!,releaseDirectory:join(project.directory,'releases',source.source.commit!),unitName:`vps-ai-project-${project.id}.service`,status:'running' as const,detail:'Previously observed service',checkedAt:new Date().toISOString()};f.ctl.store.managed.saveDeployment(project.id,deployment);f.ctl.projects.addComponent(project.id,{name:'Live service',kind:'service',unitName:deployment.unitName});
    assert.equal((await f.request('PUT',`/api/projects/${project.id}/source`,{files:{'README.md':'Require explicit migration'}})).statusCode,409);
    const repository=await f.repository('Migrated packages'),migrated=await f.api('POST',`/api/projects/${project.id}/source`,{kind:'project',repositoryId:repository.id,packagePath:'apps/legacy'});
    assert.equal(migrated.manifest.id,project.id);assert.equal(migrated.source.repositoryId,repository.id);assert.equal(migrated.source.path,'apps/legacy');
    const retained=await f.api('GET',`/api/projects/${project.id}`);assert.equal(retained.directory,project.directory);assert.deepEqual(retained.deployment,deployment);assert.deepEqual(retained.conversationIds,[conversation.id]);assert.equal(retained.components[0].unitName,deployment.unitName);assert.equal(readFileSync(join(project.directory,'runtime-data.txt'),'utf8'),'keep runtime data');
    await f.api('PUT',`/api/projects/${project.id}/source`,{files:{'README.md':'Migrated source edit\n'}});assert.equal(readFileSync(join(migrated.source.workspacePath,'README.md'),'utf8'),'Migrated source edit\n');assert.equal(f.worker.requests.length,0);
  }finally{await f.close();}
});

test('different projects in one repository share a durable writer lease while separate repositories can run concurrently',async()=>{
  const f=await fixture();
  try{
    const shared=await f.repository('Shared repository'),separate=await f.repository('Independent repository');
    const create=(repositoryId:string,name:string)=>f.api('POST','/api/projects',{name,repositoryId,packagePath:`apps/${name}`});
    const a=await create(shared.id,'first'),b=await create(shared.id,'second'),c=await create(separate.id,'third');
    const workerA=f.ctl.queue.registry.register({id:'builder-a',name:'Builder A',mode:'user',model:'fixture-builder-a'}),workerB=f.ctl.queue.registry.register({id:'builder-b',name:'Builder B',mode:'user',model:'fixture-builder-b'}),health={uid:process.getuid!(),journalId:randomUUID(),runtime:{}};
    const task=(id:string)=>{const conversation=f.ctl.projects.newConversation(id);return f.ctl.store.enqueue(conversation.id,'Edit source',randomUUID());};
    const runA=task(a.id),runB=task(b.id),runC=task(c.id);f.ctl.store.claim(runA.id,workerA,health);
    assert.throws(()=>f.ctl.store.claim(runB.id,workerB,health),/owns this repository/);assert.equal(f.ctl.store.run(runB.id)?.status,'queued');assert.equal(f.ctl.store.attempt(f.ctl.store.run(runB.id)?.attemptId??''),undefined);
    assert.equal((await f.request('PUT',`/api/projects/${b.id}/source`,{files:{'README.md':'Conflicting UI edit'}})).statusCode,409);
    f.ctl.store.claim(runC.id,workerB,health);assert.equal(f.ctl.store.run(runA.id)?.status,'running');assert.equal(f.ctl.store.run(runC.id)?.status,'running');assert.equal(f.ctl.store.db.prepare('SELECT count(*) AS n FROM repository_leases').get()?.n,2);
    write(a.source.workspacePath,'task-result.mjs','export const saved = true;\n');f.ctl.store.transition(runA.id,'completed');assert.equal(f.ctl.store.db.prepare('SELECT state FROM source_finalizations WHERE runId=?').get(runA.id)?.state,'pending');f.ctl.store.releaseProject(runA.id);assert.throws(()=>f.ctl.store.claim(runB.id,workerA,health),/owns this repository/);
    await f.ctl.managed.finishRun(f.ctl.store.run(runA.id)!);assert.equal(f.ctl.store.db.prepare('SELECT state FROM source_finalizations WHERE runId=?').get(runA.id)?.state,'committed');assert.equal(f.ctl.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(shared.id),undefined);
    f.ctl.store.claim(runB.id,workerA,health);assert.equal(f.ctl.store.run(runB.id)?.status,'running');assert.equal((await f.ctl.managed.readSource(a.id)).files['task-result.mjs'],'export const saved = true;\n');
    f.ctl.store.transition(runB.id,'interrupted');f.ctl.store.transition(runC.id,'interrupted');await f.ctl.managed.finishRun(f.ctl.store.run(runB.id)!);await f.ctl.managed.finishRun(f.ctl.store.run(runC.id)!);assert.equal(f.ctl.store.db.prepare('SELECT count(*) AS n FROM repository_leases').get()?.n,0);assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.close();}
});

test('skill packages without representative checks expose a runtime-registration notice without creating a partial candidate',async()=>{
  const f=await fixture();
  try{
    const repository=await f.repository('Skill metadata only'),skill=await f.api('POST',`/api/repositories/${repository.id}/packages`,{kind:'skill',name:'metadata-only-skill',path:'skills/metadata',version:'1.0.0'});
    assert.equal(typeof skill.notice,'string');assert.match(skill.notice,/representative checks/);assert.equal(skill.skill.notice,skill.notice);assert.throws(()=>f.ctl.brain.skillGet(skill.name),/Skill not found/);
    const imported=await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:[skill.path],expectedCommit:skill.lastImportedCommit});assert.equal(imported.packages[0].id,skill.id);assert.match(imported.registrations[0].notice,/representative checks/);assert.equal(f.worker.requests.length,0);
    assert.equal((await f.api('GET',`/api/packages/${skill.id}`)).lastImportedCommit,skill.lastImportedCommit);
  }finally{await f.close();}
});

test('renaming an imported canonical skill creates a new candidate while retaining its previously published runtime and immutable history',async()=>{
  const f=await fixture();
  try{
    const remote=externalPackages(f.root);write(remote.directory,'skills/report/skill-checks.json',JSON.stringify({checks:[{name:'deterministic report',command:process.execPath,args:['{skill}/report.mjs'],fixtures:{},expectedStdout:'report\n'}]}));git(remote.directory,'add','.');git(remote.directory,'commit','-qm','Add deterministic skill check');
    const repository=await f.api('POST','/api/repositories',{name:'Renamed skill',remoteUrl:remote.directory,mode:'clone'}),discovery=await f.api('GET',`/api/repositories/${repository.id}/discover`);
    await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:['skills/report'],expectedCommit:discovery.commit});f.ctl.brain.setExecutor(spec=>checkSkill(f.config.stateDir,spec,{config:f.config,spawned:()=>{}}));
    await f.ctl.brain.callTool('skill_validate',{name:'imported-report',version:1});await f.ctl.brain.callTool('skill_publish',{name:'imported-report',version:1});
    const published=f.ctl.brain.skillGet('imported-report'),original=published.versions[0]!,contents=readFileSync(join(original.path,'report.mjs'),'utf8'),source=original.source;
    const staleRecord=f.ctl.managed.packages.package(remote.ids.skill);
    write(repository.directory,'skills/report/operator-package.json',JSON.stringify({...remote.skill,name:'renamed-report',version:'2.1.0'}));write(repository.directory,'skills/report/SKILL.md','---\nname: renamed-report\ndescription: Produce the renamed reproducible imported report.\n---\nRun the helper when asked for a report.\n');git(repository.directory,'add','.');git(repository.directory,'commit','-qm','Rename canonical skill');
    const renamed=await f.api('GET',`/api/repositories/${repository.id}/discover`),imported=await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:['skills/report'],expectedCommit:renamed.commit});
    assert.equal(imported.packages[0].id,remote.ids.skill);assert.equal(imported.packages[0].name,'renamed-report');assert.match(imported.registrations[0].notice,/Previous runtime skill imported-report.*retained/);
    const candidate=f.ctl.brain.skillGet('renamed-report');assert.equal(candidate.activeVersion,null);assert.equal(candidate.versions.length,1);assert.equal(candidate.versions[0]?.state,'candidate');assert.equal(candidate.versions[0]?.source?.packageId,remote.ids.skill);
    await assert.rejects(f.ctl.brain.importPackage(staleRecord),/newer package revision/);
    assert.equal(f.ctl.brain.skillGet('renamed-report').versions.length,1,'A delayed registration cannot mix an older manifest with newer source files');
    const retained=f.ctl.brain.skillGet('imported-report');assert.equal(retained.activeVersion,1);assert.equal(retained.versions.length,1);assert.deepEqual(retained.versions[0]?.source,source);assert.equal(readFileSync(join(retained.versions[0]!.path,'report.mjs'),'utf8'),contents);
    assert.equal(f.ctl.store.db.prepare('SELECT name FROM skill_sources WHERE packageId=?').get(remote.ids.skill)?.name,'renamed-report');assert.equal(existsSync(remote.sentinel),false);assert.equal(f.worker.requests.length,0);assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.close();}
});

test('imported skills with binary helpers remain registered source packages and never become truncated runtime candidates',async()=>{
  const f=await fixture();
  try{
    const remote=externalPackages(f.root);write(remote.directory,'skills/report/helper.bin',Buffer.from([0,255,1,254]));git(remote.directory,'add','.');git(remote.directory,'commit','-qm','Include binary skill helper');
    const repository=await f.api('POST','/api/repositories',{name:'Binary skill',remoteUrl:remote.directory,mode:'clone'}),discovery=await f.api('GET',`/api/repositories/${repository.id}/discover`),imported=await f.api('POST',`/api/repositories/${repository.id}/import`,{paths:['skills/report'],expectedCommit:discovery.commit});
    assert.equal(imported.packages[0].id,remote.ids.skill);assert.equal(imported.imports[0].status,'imported');assert.match(imported.registrations[0].notice,/binary|UTF-8|complete|unsupported/i);assert.throws(()=>f.ctl.brain.skillGet('imported-report'),/Skill not found/);assert.equal(f.ctl.store.db.prepare('SELECT count(*) AS n FROM skill_version_sources WHERE json_extract(source,\'$.packageId\')=?').get(remote.ids.skill)?.n,0);
    assert.deepEqual(readFileSync(join(repository.directory,'skills/report/helper.bin')),Buffer.from([0,255,1,254]));assert.equal(f.worker.requests.length,0);assert.equal(existsSync(remote.sentinel),false);
  }finally{await f.close();}
});

test('failed source initialization during an active generic task rolls back the provisional project and association without changing an existing package',async()=>{
  const f=await fixture();
  try{
    const repository=await f.repository('Existing package'),existing=await f.api('POST','/api/projects',{name:'Existing source',repositoryId:repository.id,packagePath:'apps/existing'}),head=git(repository.directory,'rev-parse','HEAD');
    const conversation=f.ctl.store.newConversation('Generic task'),run=f.ctl.store.enqueue(conversation.id,'Create a source project',randomUUID());f.ctl.store.claim(run.id,{id:'default'},{uid:process.getuid!(),journalId:randomUUID(),runtime:{}});
    await assert.rejects(f.ctl.brain.callTool('project_create',{name:'Conflicting new project',repositoryId:repository.id,packagePath:'apps/existing'},{runId:run.id,conversationId:conversation.id}),/already registered|already has a package/);
    assert.equal(f.ctl.projects.list().length,1);assert.equal(f.ctl.projects.get(existing.id).source?.commit,existing.source.commit);assert.equal(f.ctl.store.projects.forConversation(conversation.id),undefined);assert.equal(f.ctl.store.db.prepare('SELECT count(*) AS n FROM project_leases WHERE runId=?').get(run.id)?.n,0);assert.equal(f.ctl.store.db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repository.id)?.runId,run.id);
    assert.equal(git(repository.directory,'rev-parse','HEAD'),head);assert.equal(git(repository.directory,'status','--porcelain'),'');assert.equal((await f.api('GET','/api/packages')).length,1);assert.equal(f.ctl.store.run(run.id)?.status,'running');assert.equal(f.worker.requests.length,0);assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    f.ctl.store.transition(run.id,'interrupted');await f.ctl.managed.finishRun(f.ctl.store.run(run.id)!);assert.equal(f.ctl.store.db.prepare('SELECT count(*) AS n FROM repository_leases WHERE runId=?').get(run.id)?.n,0);
  }finally{await f.close();}
});

test('chat and HTTP create and import the same connector registration without running its code',async()=>{
  const f=await fixture();
  try{
    const repository=await f.repository();
    const invalid=await f.request('POST',`/api/repositories/${repository.id}/packages`,{
      path:'connectors/report',kind:'connector',name:'Report connector',mcp:{transport:'http',url:'missing-host'},
    });
    assert.equal(invalid.statusCode,400);
    const created=await f.ctl.brain.callTool('package_create',{
      repositoryId:repository.id,kind:'connector',name:'Report connector',path:'connectors/report',
    });
    assert.equal(created.connection.projectId,created.id);
    const preview=await f.api('GET',`/api/repositories/${repository.id}/discover`);
    const selection={paths:['connectors/report'],expectedCommit:preview.commit};
    const fromChat=await f.ctl.brain.callTool('repository_import',{id:repository.id,...selection});
    const fromUi=await f.api('POST',`/api/repositories/${repository.id}/import`,selection);
    assert.equal(fromChat.registrations[0].connection.id,created.connection.id);
    assert.equal(fromUi.registrations[0].connection.id,created.connection.id);
    assert.equal(f.ctl.connectors.list().length,1);
    assert.equal(f.worker.requests.length,0);
    const before=f.ctl.projects.list().map(project=>project.id);
    const conflict=await f.request('POST','/api/connectors/examples',{repositoryId:repository.id,packagePath:'connectors/report'});
    assert.equal(conflict.statusCode,409);
    assert.deepEqual(f.ctl.projects.list().map(project=>project.id),before);
    const remote=externalPackages(f.root);
    const cloned=await f.api('POST','/api/repositories',{name:'Existing connector',remoteUrl:remote.directory,mode:'clone'});
    const externalSelection={paths:['connectors/provider'],expectedCommit:remote.commit};
    const firstImport=await f.ctl.brain.callTool('repository_import',{id:cloned.id,...externalSelection});
    const connection=firstImport.registrations[0].connection;
    assert.equal(connection.projectId,remote.ids.connector);
    const repeated=await f.api('POST',`/api/repositories/${cloned.id}/import`,externalSelection);
    assert.equal(repeated.registrations[0].connection.id,connection.id);
    assert.equal(f.ctl.connectors.list().length,2);
    assert.equal(f.worker.requests.length,0);
    assert.equal(existsSync(remote.sentinel),false);
  }finally{await f.close();}
});

test('remote discovery requires an authenticated write request and local discovery reads the checkout',async()=>{
  const f=await fixture();
  try{
    const remote=externalPackages(f.root);
    const repository=await f.api('POST','/api/repositories',{name:'Preview',remoteUrl:remote.directory,mode:'clone'});
    write(remote.directory,'README.md','A later revision');git(remote.directory,'add','README.md');git(remote.directory,'commit','-qm','Update preview');
    const url=`/api/repositories/${repository.id}/discover`;
    assert.equal((await f.request('GET',`${url}?refresh=true`)).statusCode,405);
    assert.equal((await f.ctl.app.inject({method:'POST',url,headers:{origin:f.headers.origin,cookie:f.headers.cookie},payload:{refresh:true}})).statusCode,403);
    assert.equal((await f.api('GET',url)).commit,remote.commit);
    assert.equal((await f.api('POST',url,{refresh:true})).commit,git(remote.directory,'rev-parse','HEAD'));
    assert.equal((await f.api('GET',url)).commit,remote.commit);
  }finally{await f.close();}
});
