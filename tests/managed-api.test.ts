import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';
import { ManagedRuntime } from '../src/runtime/managed.ts';
import { testConnector, callConnector } from '../src/connectors/client.ts';

const git=(cwd:string,...args:string[])=>execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();

/** Real Git/files/MCP, with only systemd and the model boundary simulated. */
class ManagedWorker extends EventEmitter {
  activeRunId:string|null=null;submissions:any[]=[];deployments=new Map<string,any>();
  runtime:ManagedRuntime;
  constructor(private config:Config){super();this.runtime=new ManagedRuntime(config);}
  health(){return {connected:true,uid:0,executionUid:0,root:true,pid:1234,activeRunId:this.activeRunId,uncertainRuns:[],runtimeOperations:[],projectsDir:this.config.projectsDir,runtime:{available:true,authenticated:true,version:'fixture',detail:'No model or real systemd operations'}};}
  async connect(){return this.health();}
  async request(method:string,input:any={}){
    if(method==='health')return this.health();
    if(method==='sync')return {health:this.health(),events:[],hasMore:false,activeRunId:this.activeRunId};
    if(method==='acknowledge')return {ok:true};
    if(method==='submit'){this.activeRunId=input.runId;this.submissions.push(input);return {accepted:true};}
    if(method==='managed/prepare')return this.runtime.prepare(input);
    if(method==='managed/deploy'){
      const release=await this.runtime.prepare(input),value={...release,unitName:`vps-ai-project-${input.project.id}.service`,status:'running',detail:'Simulated service manager confirmed running.'};
      this.deployments.set(input.project.id,value);return value;
    }
    if(method==='managed/status')return this.deployments.get(input.project.id);
    if(method==='managed/stop'){const value={...this.deployments.get(input.project.id),status:'stopped'};this.deployments.set(input.project.id,value);return value;}
    if(method==='managed/logs')return {text:'Simulated service log',truncated:false,checkedAt:new Date().toISOString()};
    if(method==='projects/inspect')return {observations:input.components.map((component:any)=>({componentId:component.id,status:'running',detail:'Simulated managed service observation.',checkedAt:new Date().toISOString()}))};
    if(method==='connectors/test')return testConnector(this.config,input.connector);
    if(method==='connectors/call')return callConnector(this.config,input.connector,input.name,input.arguments??{});
    throw new Error(`Unexpected fixture RPC ${method}`);
  }
  close(){}
}

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-managed-api-')),stateDir=join(root,'state'),repositoryPath=join(root,'repo');mkdirSync(stateDir,{mode:0o700});mkdirSync(repositoryPath);
  git(repositoryPath,'init','--quiet');writeFileSync(join(repositoryPath,'owner.txt'),'committed owner source\n');git(repositoryPath,'add','owner.txt');git(repositoryPath,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','Initialize');
  writeFileSync(join(repositoryPath,'owner.txt'),'owner staged work\n');git(repositoryPath,'add','owner.txt');writeFileSync(join(repositoryPath,'owner.txt'),'owner unstaged work\n');
  const ownerStatus=git(repositoryPath,'status','--porcelain'),ownerHead=git(repositoryPath,'rev-parse','HEAD'),ownerIndex=git(repositoryPath,'diff','--cached');
  const config:Config={stateDir,repositoryPath,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'managed-api-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:true};
  initState(config);const worker=new ManagedWorker(config),ctl=await createController(config,{client:worker as unknown as WorkerClient,startQueue:false,startBridge:false});
  ctl.brain.skillAction('skill-maintenance','disable');
  const repository=await ctl.managed.packages.register({name:'Fixture packages',remoteUrl:'https://example.test/managed-api.git',mode:'create'});
  const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}}),headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  return {root,config,worker,ctl,repository,headers,ownerStatus,ownerHead,ownerIndex,async close(){await ctl.close();await worker.runtime.close();rmSync(root,{recursive:true,force:true});}};
}

test('managed project API commits source, separates runtime revisions, and preserves owner Git work',async()=>{
  const f=await fixture();
  try{
    assert.equal((await f.ctl.app.inject({method:'GET',url:'/api/connectors'})).statusCode,401);
    let response=await f.ctl.app.inject({method:'POST',url:'/api/projects',headers:f.headers,payload:{name:'Managed service',managed:true,template:'service',repositoryId:f.repository.id,packagePath:'apps/service'}});
    assert.equal(response.statusCode,200,response.body);const project=response.json();assert.equal(project.source.path,'apps/service');assert.match(project.source.commit,/^[a-f0-9]{40,64}$/);
    assert.notEqual(project.source.workspacePath,project.directory);
    response=await f.ctl.app.inject({method:'GET',url:`/api/projects/${project.id}/source`,headers:f.headers});assert.equal(response.statusCode,200,response.body);const original=response.json();
    response=await f.ctl.app.inject({method:'PUT',url:`/api/projects/${project.id}/source`,headers:f.headers,payload:{files:{'README.md':'Updated source\n'},message:'Document generated service'}});assert.equal(response.statusCode,200,response.body);assert.notEqual(response.json().source.commit,original.source.commit);
    writeFileSync(join(project.source.workspacePath,'README.md'),'Pending direct edit\n');
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/deploy`,headers:f.headers,payload:{}});assert.equal(response.statusCode,409,response.body);
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/source/commit`,headers:f.headers,payload:{message:'Commit direct edit'}});assert.equal(response.statusCode,200,response.body);const source=response.json();
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/deploy`,headers:f.headers,payload:{}});assert.equal(response.statusCode,200,response.body);const deployment=response.json();assert.equal(deployment.commit,source.commit);assert(deployment.releaseDirectory.startsWith(`${project.directory}/releases/`));
    assert.equal(readFileSync(join(deployment.releaseDirectory,'README.md'),'utf8'),'Pending direct edit\n');
    response=await f.ctl.app.inject({method:'GET',url:`/api/projects/${project.id}`,headers:f.headers});assert.equal(response.json().deployment.commit,source.commit);assert.equal(response.json().components[0].unitName,deployment.unitName);
    // A service can be confirmed after the controller missed the deployment response.
    f.ctl.store.db.prepare('DELETE FROM project_deployments WHERE projectId=?').run(project.id);
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/refresh`,headers:f.headers,payload:{}});
    assert.equal(response.statusCode,200,response.body);assert.equal(response.json().deployment.commit,source.commit);
    response=await f.ctl.app.inject({method:'GET',url:`/api/projects/${project.id}/deployment`,headers:f.headers});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().commit,source.commit);
    assert.equal(f.ctl.projects.get(project.id).deployment?.commit,source.commit);
    assert.equal(git(f.config.repositoryPath!,'status','--porcelain'),f.ownerStatus);assert.equal(git(f.config.repositoryPath!,'rev-parse','HEAD'),f.ownerHead);assert.equal(git(f.config.repositoryPath!,'diff','--cached'),f.ownerIndex);
    assert.equal((await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/deployment/stop`,headers:f.headers,payload:{}})).json().status,'stopped');
    writeFileSync(join(project.source.workspacePath,'operator-package.json'),'{"schemaVersion":99}');
    git(f.repository.directory,'add','.');
    git(f.repository.directory,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','Unimportable revision');
    const failed=await f.ctl.managed.packages.importPackages(f.repository.id,{paths:[project.source.path]});
    assert.equal(failed.imports[0]?.status,'failed');
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/deploy`,headers:f.headers,payload:{}});
    assert.equal(response.statusCode,200,response.body);
    assert.equal(response.json().commit,deployment.commit,'Redeployment uses the last successfully imported revision');
  }finally{await f.close();}
});

test('managed connector source is committed, real MCP discovery/calls work, and project tasks receive snapshots',async()=>{
  const f=await fixture();
  try{
    let response=await f.ctl.app.inject({method:'POST',url:'/api/connectors/examples',headers:f.headers,payload:{repositoryId:f.repository.id,packagePath:'connectors/echo'}});assert.equal(response.statusCode,200,response.body);const connector=response.json();assert(connector.source.commit);assert.equal(connector.status,'untested');
    response=await f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/test`,headers:f.headers,payload:{}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().tools[0].name,'echo');
    response=await f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/call`,headers:f.headers,payload:{name:'echo',arguments:{text:'Verified through operator UI API'}}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().content[0].text,'Verified through operator UI API');
    response=await f.ctl.app.inject({method:'POST',url:'/api/projects',headers:f.headers,payload:{name:'Task source',managed:true,template:'empty',repositoryId:f.repository.id,packagePath:'apps/task'}});assert.equal(response.statusCode,200,response.body);const project=response.json();
    response=await f.ctl.app.inject({method:'PUT',url:`/api/projects/${project.id}/connectors`,headers:f.headers,payload:{connectorIds:[connector.id]}});assert.equal(response.statusCode,200,response.body);
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/conversations`,headers:f.headers,payload:{}});const conversation=response.json();
    const run=f.ctl.store.enqueue(conversation.id,'Write a generated module','managed-fixture-request');await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);const submission=f.worker.submissions[0];assert.equal(submission.cwd,project.source.workspacePath);assert.equal(submission.connectors[0].id,connector.id);assert.match(submission.connectors[0].cwd,/\/releases\//);
    writeFileSync(join(project.source.workspacePath,'generated.mjs'),'export const verified = true;\n');f.worker.activeRunId=null;
    f.worker.emit('event',{cursor:1,runId:run.id,type:'completed',data:{status:'completed'},createdAt:new Date().toISOString()});await f.ctl.queue.drainSource();
    const saved=await f.ctl.managed.readSource(project.id);assert.equal(saved.files['generated.mjs'],'export const verified = true;\n');assert.equal(saved.source.dirty,false);assert.match(git(saved.source.workspacePath,'log','-1','--format=%B'),new RegExp(run.id));
    response=await f.ctl.app.inject({method:'PATCH',url:`/api/connectors/${connector.id}`,headers:f.headers,payload:{enabled:false}});assert.equal(response.statusCode,200,response.body);
    assert.deepEqual(await f.ctl.connectors.snapshots(conversation.id),[]);
    response=await f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/call`,headers:f.headers,payload:{name:'echo',arguments:{text:'disabled'}}});assert.equal(response.statusCode,409,response.body);
  }finally{await f.close();}
});

test('source API rejects a stale editor save and runtime responses cannot claim a different deployed revision',async()=>{
  const f=await fixture();
  try{
    const project=await f.ctl.managed.createProject({name:'Reviewed source',managed:true,template:'service',repositoryId:f.repository.id,packagePath:'apps/reviewed'});
    const initial=await f.ctl.managed.readSource(project.id);
    const saved=await f.ctl.managed.writeSource(project.id,{files:{'README.md':'Newer owner source\n'},expectedCommit:initial.source.commit});
    let response=await f.ctl.app.inject({method:'PUT',url:`/api/projects/${project.id}/source`,headers:f.headers,payload:{files:{'README.md':'Stale editor source\n'},expectedCommit:initial.source.commit}});
    assert.equal(response.statusCode,409,response.body);const unchanged=await f.ctl.managed.readSource(project.id);assert.equal(unchanged.source.commit,saved.source.commit);assert.equal(unchanged.files['README.md'],'Newer owner source\n');
    const request=f.worker.request.bind(f.worker),wrongCommit='b'.repeat(40);
    f.worker.request=async(method,input={})=>method==='managed/deploy'?{commit:wrongCommit,releaseDirectory:join(project.directory,'releases',wrongCommit),unitName:`vps-ai-project-${project.id}.service`,status:'running',detail:'Wrong revision fixture',checkedAt:new Date().toISOString()}:request(method,input);
    response=await f.ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/deploy`,headers:f.headers,payload:{}});assert.equal(response.statusCode,502,response.body);assert.equal(f.ctl.projects.get(project.id).deployment,undefined);assert.equal(f.ctl.projects.get(project.id).components.length,0);
    f.worker.request=request;
    const deployed=await f.ctl.managed.deploy(project.id);
    f.worker.deployments.set(project.id,{...deployed,commit:wrongCommit,releaseDirectory:join(project.directory,'releases',wrongCommit),checkedAt:new Date(Date.parse(deployed.checkedAt)-1000).toISOString()});
    await f.ctl.managed.deploymentAction(project.id,'status');assert.equal(f.ctl.projects.get(project.id).deployment?.commit,deployed.commit,'A late old observation cannot replace the newer deployment');
    const conversation=f.ctl.projects.newConversation(project.id),active=f.ctl.store.enqueue(conversation.id,'Long-running source task','active-source-review');f.ctl.store.transition(active.id,'running');
    for(let index=0;index<21;index++)f.ctl.store.enqueue(conversation.id,`Later queued task ${index}`,`later-source-review-${index}`);
    response=await f.ctl.app.inject({method:'PUT',url:`/api/projects/${project.id}/source`,headers:f.headers,payload:{files:{'README.md':'Do not overwrite active task files'}}});assert.equal(response.statusCode,409,response.body);
  }finally{await f.close();}
});

test('connector calls require testing the exact source revision and disabled connections ignore late test results',async()=>{
  const f=await fixture();
  let release=()=>{};
  try{
    const connector=await f.ctl.connectors.createExample({repositoryId:f.repository.id,packagePath:'connectors/echo'});await f.ctl.connectors.test(connector.id);
    await f.ctl.managed.writeSource(connector.projectId!,{files:{'README.md':'Connector revision changed\n'}});
    assert.equal(f.ctl.connectors.get(connector.id).status,'untested');assert.deepEqual(f.ctl.connectors.get(connector.id).tools,[]);
    const request=f.worker.request.bind(f.worker);let calls=0;
    f.worker.request=async(method,input={})=>{if(method==='connectors/call')calls++;return request(method,input);};
    let response=await f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/call`,headers:f.headers,payload:{name:'echo',arguments:{text:'stale'}}});assert.equal(response.statusCode,409,response.body);assert.equal(calls,0);
    await f.ctl.connectors.test(connector.id);
    response=await f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/call`,headers:f.headers,payload:{name:'echo',arguments:{text:'new source verified'}}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().content[0].text,'new source verified');
    let ready!:()=>void;const entered=new Promise<void>(resolve=>{ready=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
    f.worker.request=async(method,input={})=>{if(method==='connectors/test'){const value=await request(method,input);ready();await gate;return value;}return request(method,input);};
    const testing=f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/test`,headers:f.headers,payload:{}}).then(value=>value);await entered;
    await f.ctl.connectors.updatePackaged(connector.id,{enabled:false});release();response=await testing;assert.equal(response.statusCode,409,response.body);assert.equal(f.ctl.connectors.get(connector.id).enabled,false);
  }finally{release();await f.close();}
});
