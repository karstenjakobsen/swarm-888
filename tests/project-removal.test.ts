import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';
import { bridgeRequest } from '../src/mcp.ts';
import type { ManagedSource } from '../src/managed/schemas.ts';

class OfflineWorker extends EventEmitter {
  calls=0;
  async connect():Promise<never>{this.calls++;throw new Error('Project removal must not connect to the worker');}
  async request():Promise<never>{this.calls++;throw new Error('Project removal must not issue worker actions');}
  close(){}
}
async function fixture(startBridge=false){
  const root=mkdtempSync(join(tmpdir(),'operator-project-removal-')),stateDir=join(root,'state');
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'project-removal-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const worker=new OfflineWorker(),ctl=await createController(config,{client:worker as any,startQueue:false,startBridge});
  const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
  const headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  return {root,config,worker,ctl,headers,async close(){await ctl.close();rmSync(root,{recursive:true,force:true});}};
}
type Fixture=Awaited<ReturnType<typeof fixture>>;
function project(f:Fixture,name='Local MCP example',directory=join(f.root,'obsolete-projects',randomUUID())){
  const now=new Date().toISOString();return f.ctl.store.projects.create({id:randomUUID(),name,description:'Obsolete registration fixture',directory,origin:'created',createdAt:now,updatedAt:now});
}
function source(f:Fixture,id:string):ManagedSource{return {repositoryPath:join(f.root,'retained-repository'),branch:'operator/generated',path:`generated/connectors/${id}`,workspacePath:join(f.root,'retained-source',id),commit:'a'.repeat(40),dirty:false};}
function ownedConnector(f:Fixture,id:string,name='Owned fixture'){return f.ctl.connectors.create({name,projectId:id,transport:'stdio',command:'node',args:['server.mjs']});}
function remove(f:Fixture,id:string){return f.ctl.app.inject({method:'DELETE',url:`/api/projects/${id}`,headers:f.headers});}

test('project removal enforces session, Origin, CSRF, maintenance and an empty body without needing a worker',async()=>{
  const f=await fixture();try{
    const p=project(f),url=`/api/projects/${p.id}`;
    assert.equal((await f.ctl.app.inject({method:'DELETE',url,headers:{origin:f.headers.origin}})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'DELETE',url,headers:{cookie:f.headers.cookie,'x-csrf-token':f.headers['x-csrf-token']}})).statusCode,403);
    assert.equal((await f.ctl.app.inject({method:'DELETE',url,headers:{...f.headers,origin:'https://untrusted.example'}})).statusCode,403);
    assert.equal((await f.ctl.app.inject({method:'DELETE',url,headers:{origin:f.headers.origin,cookie:f.headers.cookie}})).statusCode,403);
    for(const payload of [{deleteFiles:true},null,[]])assert.equal((await f.ctl.app.inject({method:'DELETE',url,headers:{...f.headers,'content-type':'application/json'},payload:JSON.stringify(payload)})).statusCode,400);
    f.ctl.store.setSetting('maintenance','true');assert.equal((await remove(f,p.id)).statusCode,503);f.ctl.store.setSetting('maintenance','false');
    const result=await remove(f,p.id);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{ok:true});
    assert.equal((await remove(f,p.id)).statusCode,404);assert.equal((await remove(f,'invalid-id')).statusCode,400);assert.equal(f.worker.calls,0);
  }finally{await f.close();}
});

test('unregistering an outside-root project removes every association while retaining files, services and history',async()=>{
  const f=await fixture();try{
    const p=project(f),consumer=project(f,'Consumer'),unrelated=project(f,'Unrelated');mkdirSync(p.directory,{recursive:true});writeFileSync(join(p.directory,'live.txt'),'Retained runtime');
    const src=source(f,p.id);mkdirSync(src.workspacePath,{recursive:true});writeFileSync(join(src.workspacePath,'source.mjs'),'Retained source');writeFileSync(join(src.workspacePath,'.git'),'Retained Git reference');
    const conversation=f.ctl.projects.newConversation(p.id),run=f.ctl.store.enqueue(conversation.id,'Historical task',randomUUID());f.ctl.store.transition(run.id,'running');f.ctl.store.transition(run.id,'completed');f.ctl.store.addEvent('tool',{projectId:p.id,evidence:'Retained history'},run.id);
    f.ctl.store.managed.saveSource(p.id,'connector',src);f.ctl.store.managed.beginFinalization(run.id,p.id);f.ctl.store.managed.finalized(run.id,src.commit!);
    f.ctl.store.managed.saveDeployment(p.id,{commit:src.commit!,releaseDirectory:join(p.directory,'releases',src.commit!),unitName:'retained-running.service',status:'running',detail:'Previously observed running',checkedAt:new Date().toISOString()});
    f.ctl.projects.addComponent(p.id,{name:'Retained running service',kind:'service',unitName:'retained-running.service'});
    const owned=ownedConnector(f,p.id),second=ownedConnector(f,p.id,'Second owned fixture'),external=f.ctl.connectors.create({name:'Retained external connection',transport:'http',url:'http://127.0.0.1/mcp'});
    for(const id of [owned.id,second.id])f.ctl.store.connectors.observed(id,[],new Date().toISOString(),JSON.stringify({sourceCommit:src.commit,configuration:{}}));
    f.ctl.connectors.assign(consumer.id,{connectorIds:[owned.id,second.id,external.id]});f.ctl.connectors.assign(p.id,{connectorIds:[external.id]});
    const unrelatedConversation=f.ctl.projects.newConversation(unrelated.id),queued=f.ctl.store.enqueue(unrelatedConversation.id,'Unrelated queued task',randomUUID());
    const receipt=`runtime_${randomUUID()}`,now=new Date().toISOString();f.ctl.store.db.prepare('INSERT INTO runtime_receipts VALUES(?,?,?,?,?,?)').run(receipt,'managed/deploy',p.id,JSON.stringify({evidence:'Retained receipt'}),now,now);
    const before={conversations:f.ctl.store.conversations(),runs:f.ctl.store.runs(),messages:f.ctl.store.messages(conversation.id),events:f.ctl.store.events()};
    const result=await remove(f,p.id);assert.equal(result.statusCode,200,result.body);
    for(const table of ['projects','project_components','project_conversations','project_sources','project_deployments','source_finalizations']){
      const column=table==='projects'?'id':'projectId';assert.equal(f.ctl.store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(p.id)?.n,0);
    }
    for(const id of [owned.id,second.id])for(const [table,column] of [['connectors','id'],['connector_checks','connectorId'],['project_connectors','connectorId']])assert.equal(f.ctl.store.db.prepare(`SELECT count(*) AS n FROM ${table} WHERE ${column}=?`).get(id)?.n,0);
    assert.deepEqual(f.ctl.projects.get(consumer.id).connectorIds,[external.id]);assert.equal(f.ctl.connectors.get(external.id).id,external.id);
    assert.deepEqual(f.ctl.store.conversations(),before.conversations);assert.deepEqual(f.ctl.store.runs(),before.runs);assert.deepEqual(f.ctl.store.messages(conversation.id),before.messages);assert.deepEqual(f.ctl.store.events(),before.events);assert.equal(f.ctl.store.run(queued.id)?.status,'queued');
    assert.equal(f.ctl.store.db.prepare('SELECT projectId FROM runtime_receipts WHERE operationId=?').get(receipt)?.projectId,p.id);assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
    assert.equal(readFileSync(join(p.directory,'live.txt'),'utf8'),'Retained runtime');assert.equal(readFileSync(join(src.workspacePath,'source.mjs'),'utf8'),'Retained source');assert.equal(readFileSync(join(src.workspacePath,'.git'),'utf8'),'Retained Git reference');assert.equal(f.worker.calls,0);
    const missing=project(f,'Missing old-root example');assert.equal((await remove(f,missing.id)).statusCode,200);
  }finally{await f.close();}
});

test('removal blocks nonterminal tasks in the project and consumers of its owned connectors',async()=>{
  const f=await fixture();try{
    const p=project(f),consumer=project(f,'Consumer'),connector=ownedConnector(f,p.id);f.ctl.connectors.assign(consumer.id,{connectorIds:[connector.id]});
    for(const owner of [p,consumer]){
      const conversation=f.ctl.projects.newConversation(owner.id);
      for(const state of ['queued','running','waiting','uncertain'] as const){
        const run=f.ctl.store.enqueue(conversation.id,`${state} task`,randomUUID());if(state!=='queued')f.ctl.store.transition(run.id,'running');if(state==='waiting'||state==='uncertain')f.ctl.store.transition(run.id,state);
        assert.equal((await remove(f,p.id)).statusCode,409);assert(f.ctl.store.projects.get(p.id));f.ctl.store.transition(run.id,'interrupted');
      }
    }
    assert.equal((await remove(f,p.id)).statusCode,200);assert.equal(f.worker.calls,0);
  }finally{await f.close();}
});

test('pending source commits, null-project receipts and known worker uncertainty block removal without worker calls',async()=>{
  const f=await fixture();try{
    const p=project(f),conversation=f.ctl.projects.newConversation(p.id),run=f.ctl.store.enqueue(conversation.id,'Finished task',randomUUID());f.ctl.store.transition(run.id,'interrupted');
    f.ctl.store.managed.beginFinalization(run.id,p.id);let result=await remove(f,p.id);assert.equal(result.statusCode,409);assert.match(result.json().error,/source commits/);f.ctl.store.managed.finalized(run.id,'a'.repeat(40));
    const receipt=`runtime_${randomUUID()}`;f.ctl.store.db.prepare('INSERT INTO runtime_receipts VALUES(?,?,?,?,?,NULL)').run(receipt,'connectors/call',null,'{}',new Date().toISOString());result=await remove(f,p.id);assert.equal(result.statusCode,409);assert.match(result.json().error,/receipts/);f.ctl.store.db.prepare('UPDATE runtime_receipts SET acknowledgedAt=? WHERE operationId=?').run(new Date().toISOString(),receipt);
    f.ctl.queue.health={runtimeOperations:[{id:`runtime_${randomUUID()}`,method:'managed/deploy',status:'uncertain',requiresExternalInspection:true}]} as any;assert.equal((await remove(f,p.id)).statusCode,409);f.ctl.queue.health=null;
    assert.equal((await remove(f,p.id)).statusCode,200);assert.equal(f.worker.calls,0);assert(f.ctl.store.db.prepare('SELECT operationId FROM runtime_receipts WHERE operationId=?').get(receipt));
  }finally{await f.close();}
});

test('an asynchronous source GET prevents removal until its final metadata write completes',async()=>{
  const f=await fixture();let release!:()=>void,pending:Promise<{statusCode:number}>|undefined;
  const gate=new Promise<void>(ok=>{release=ok;});let started!:()=>void;const entered=new Promise<void>(ok=>{started=ok;});
  try{
    const p=project(f),src=source(f,p.id);
    f.ctl.managed.readSource=async id=>{f.ctl.projects.get(id);started();await gate;f.ctl.store.managed.saveSource(id,'connector',src);return {source:src,manifest:{schemaVersion:1,id,kind:'connector',name:'Fixture',description:''},files:{}};};
    const response=f.ctl.app.inject({method:'GET',url:`/api/projects/${p.id}/source`,headers:f.headers});pending=response;await entered;
    const blocked=await remove(f,p.id);assert.equal(blocked.statusCode,409);assert.match(blocked.json().error,/requests to finish/);release();assert.equal((await response).statusCode,200);
    assert.equal((await remove(f,p.id)).statusCode,200);assert.equal(f.ctl.store.managed.source(p.id),undefined);
  }finally{release();if(pending)await pending;await f.close();}
});

test('an asynchronous owned-connector request blocks removal and releases its guard after failure',async()=>{
  const f=await fixture();let release!:()=>void,pending:Promise<{statusCode:number}>|undefined;
  const gate=new Promise<void>(ok=>{release=ok;});let started!:()=>void;const entered=new Promise<void>(ok=>{started=ok;});
  try{
    const p=project(f),connector=ownedConnector(f,p.id);
    f.ctl.connectors.test=async id=>{f.ctl.connectors.get(id);started();await gate;throw new Error('Fixture delayed connector failure');};
    const response=f.ctl.app.inject({method:'POST',url:`/api/connectors/${connector.id}/test`,headers:f.headers,payload:{}});pending=response;await entered;
    assert.equal((await remove(f,p.id)).statusCode,409);release();assert.equal((await response).statusCode,400);assert.equal((await remove(f,p.id)).statusCode,200);
  }finally{release();if(pending)await pending;await f.close();}
});

test('an accepted bridge tool remains protected after its parent run reaches a terminal state',async()=>{
  const f=await fixture(true);let release!:()=>void,pending:Promise<unknown>|undefined;
  const gate=new Promise<void>(ok=>{release=ok;});let started!:()=>void;const entered=new Promise<void>(ok=>{started=ok;});
  try{
    const p=project(f),conversation=f.ctl.projects.newConversation(p.id),run=f.ctl.store.enqueue(conversation.id,'Bridge fixture task',randomUUID());f.ctl.store.transition(run.id,'running');
    f.ctl.brain.callTool=async()=>{started();await gate;return {ok:true};};
    pending=bridgeRequest('tools/call',{name:'memory_search',arguments:{query:'fixture'},runId:run.id},{socketPath:f.config.bridgeSocket,token:f.config.ipcToken});await entered;f.ctl.store.transition(run.id,'completed');
    assert.equal(f.ctl.pendingTools,1);const result=await remove(f,p.id);assert.equal(result.statusCode,409);assert.match(result.json().error,/tool operations/);release();await pending;assert.equal(f.ctl.pendingTools,0);assert.equal((await remove(f,p.id)).statusCode,200);
  }finally{release();if(pending)await pending;await f.close();}
});
