import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';
import type { WorkerClient, WorkerEvent, Submission } from '../src/ipc.ts';
import { ManagedRuntime } from '../src/runtime/managed.ts';
import { callConnector, testConnector } from '../src/connectors/client.ts';
import { bridgeRequest } from '../src/mcp.ts';

const git = (cwd:string,...args:string[]) => execFileSync('git',['-C',cwd,...args],{encoding:'utf8'}).trim();
const usage = {inputTokens:1200,outputTokens:80,totalTokens:1280};
const snapshot = {instrument:'FICTIONAL',dataAsOf:'2026-11-16T12:00:00Z',timeframes:['M5','M15','H1'],features:{regime:'fixture'}};

/** Only inference/worker IPC is simulated; Git, credentials, MCP, and controller persistence are real. */
class ScenarioWorker extends EventEmitter {
  readonly id='routine';
  readonly model='fixture-small-model';
  readonly journalId=randomUUID();
  readonly submissions:Submission[]=[];
  readonly events:WorkerEvent[]=[];
  activeRunId:string|null=null;
  private cursor=0;
  readonly runtime:ManagedRuntime;
  constructor(private config:Config){super();this.runtime=new ManagedRuntime(config);}
  health(){return {connected:true as const,uid:process.getuid!(),executionUid:process.getuid!(),root:false,pid:1234,workerId:this.id,workerMode:'user' as const,journalId:this.journalId,model:this.model,projectsDir:this.config.projectsDir,activeRunId:this.activeRunId,uncertainRuns:[],runtimeOperations:[],runtime:{available:true,authenticated:true,version:'scenario fixture',detail:'No inference, provider account, broker, or service-manager actions',model:this.model}};}
  async connect(){return this.health();}
  async request(method:string,input:any={}){
    if(method==='health')return this.health();
    if(method==='sync')return {health:this.health(),activeRunId:this.activeRunId,events:this.events.filter(event=>event.cursor>input.after),hasMore:false};
    if(method==='acknowledge')return {ok:true};
    if(method==='submit'){assert.equal(this.activeRunId,null);this.activeRunId=input.runId;this.submissions.push(input);return {accepted:true};}
    if(method==='managed/prepare')return this.runtime.prepare(input);
    if(method==='connectors/test')return testConnector(this.config,input.connector);
    if(method==='connectors/call')return callConnector(this.config,input.connector,input.name,input.arguments??{});
    throw new Error(`Unexpected scenario worker method ${method}`);
  }
  private emitEvent(runId:string,type:string,data:unknown){
    const submission=this.submissions.find(value=>value.runId===runId);assert(submission,'Events must belong to an accepted submission');
    const event={cursor:++this.cursor,workerId:this.id,journalId:this.journalId,attemptId:submission.attemptId,runId,type,data,createdAt:new Date().toISOString()};
    this.events.push(event);this.emit('event',event);
  }
  finish(runId:string,result:unknown){
    assert.equal(this.activeRunId,runId);
    this.emitEvent(runId,'thread',{threadId:`fixture-thread-${runId}`,model:this.model});
    this.emitEvent(runId,'activity',{method:'thread/tokenUsage/updated',tokenUsage:usage});
    this.emitEvent(runId,'delta',{text:JSON.stringify(result)});
    this.activeRunId=null;this.emitEvent(runId,'completed',{status:'completed',usage});
  }
  async analyze(runId:string){
    const submission=this.submissions.find(value=>value.runId===runId)!;assert.equal(submission.connectors?.length,1);
    const result=await callConnector(this.config,submission.connectors![0],'snapshot',{});
    const data=result.structuredContent;assert(data);assert.deepEqual(data.snapshot,snapshot);assert.equal(data.authorization,'[REDACTED]');
    const signal={action:'WAIT',reason:'Deterministic acceptance fixture; no trading decision or order.',dataAsOf:snapshot.dataAsOf,timeframes:snapshot.timeframes};
    this.finish(runId,signal);return signal;
  }
  close(){}
}

class OfflineDefault extends EventEmitter {
  async connect():Promise<never>{throw new Error('Default worker is intentionally offline in this scenario');}
  close(){}
}

async function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-scenario-')),stateDir=join(root,'state'),repositoryPath=join(root,'owner');mkdirSync(stateDir,{mode:0o700});mkdirSync(repositoryPath);
  git(repositoryPath,'init','--quiet','-b','main');writeFileSync(join(repositoryPath,'owner.txt'),'Owner baseline\n');git(repositoryPath,'add','owner.txt');git(repositoryPath,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','--quiet','-m','Initialize fixture');
  writeFileSync(join(repositoryPath,'owner.txt'),'Owner staged change\n');git(repositoryPath,'add','owner.txt');writeFileSync(join(repositoryPath,'owner.txt'),'Owner unstaged change\n');
  const owner={head:git(repositoryPath,'rev-parse','HEAD'),index:readFileSync(join(repositoryPath,'.git','index')),status:git(repositoryPath,'status','--porcelain=v1')};
  const config:Config={stateDir,repositoryPath,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'scenario-fixture-admin-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const worker=new ScenarioWorker(config);
  const open=async()=>{const ctl=await createController(config,{client:new OfflineDefault() as unknown as WorkerClient,startQueue:false,startBridge:true});ctl.brain.skillAction('skill-maintenance','disable');return ctl;};
  let ctl=await open();
  const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
  assert.equal(login.statusCode,200,login.body);
  const headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  const api=async(method:'GET'|'POST'|'PUT'|'PATCH',url:string,payload?:Record<string,unknown>)=>{const response=await ctl.app.inject({method,url,headers,...(payload===undefined?{}:{payload})});assert.equal(response.statusCode,200,`${method} ${url}: ${response.body}`);return response.json();};
  const attach=()=>{(ctl.queue.registry as any).attach(worker.id,worker);};
  return {root,config,worker,api,attach,get ctl(){return ctl;},
    async reopen(){await ctl.close();ctl=await open();attach();},
    verifyOwner(){assert.equal(git(repositoryPath,'rev-parse','HEAD'),owner.head);assert.deepEqual(readFileSync(join(repositoryPath,'.git','index')),owner.index);assert.equal(git(repositoryPath,'status','--porcelain=v1'),owner.status);},
    async close(){await ctl.close();await worker.runtime.close();rmSync(root,{recursive:true,force:true});},
  };
}

test('a named small-model worker resumes a credential-blocked recurring analysis and preserves source, task lineage, and job history after restart',{timeout:30_000},async()=>{
  const f=await fixture(),token='fixture-scenario-provider-secret';
  try{
    await f.api('POST','/api/workers',{id:f.worker.id,name:'Routine analysis',model:f.worker.model,mode:'user'});f.attach();
    const repository=await f.api('POST','/api/repositories',{name:'Scenario packages',remoteUrl:'https://example.test/scenario.git',mode:'create'});
    const connector=await f.api('POST','/api/connectors/examples',{repositoryId:repository.id,packagePath:'connectors/timeframes'});
    const provider=`import{createInterface}from'node:readline';const token=process.env.PROVIDER_TOKEN;createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'scenario',version:'1'}}:m.method==='tools/list'?{tools:[{name:'snapshot',description:'Read deterministic fixture timeframes',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'Prepared local fixture data'}],structuredContent:{snapshot:${JSON.stringify(snapshot)},authorization:token??'missing'}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));});`;
    const check=`import test from'node:test';import assert from'node:assert/strict';import{spawnSync}from'node:child_process';test('prepared timeframe snapshot uses the MCP contract',()=>{const messages=[{id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{id:2,method:'tools/list'},{id:3,method:'tools/call',params:{name:'snapshot',arguments:{}}}];const child=spawnSync(process.execPath,['server.mjs'],{input:messages.map(value=>JSON.stringify({jsonrpc:'2.0',...value})).join(String.fromCharCode(10))+String.fromCharCode(10),encoding:'utf8',timeout:5000});assert.equal(child.status,0,child.stderr);const replies=child.stdout.trim().split(String.fromCharCode(10)).map(value=>JSON.parse(value));assert.equal(replies[1].result.tools[0].name,'snapshot');assert.equal(replies[2].result.structuredContent.snapshot.dataAsOf,'2026-11-16T12:00:00Z');});`;
    const source=await f.api('PUT',`/api/projects/${connector.projectId}/source`,{files:{'server.mjs':provider,'connector.test.mjs':check},message:'Add local deterministic snapshot fixture'});
    assert.equal(source.source.path,'connectors/timeframes');
    const credential=await f.api('POST','/api/credentials',{name:'Local account',values:{accountId:'fixture-account-identifier'}});
    const project=await f.api('POST','/api/projects',{name:'Fictional analysis application',managed:true,template:'empty',repositoryId:repository.id,packagePath:'apps/analysis'});
    await f.api('PATCH',`/api/projects/${project.id}`,{defaultWorkerId:f.worker.id});
    await f.api('PUT',`/api/projects/${project.id}/connectors`,{connectorIds:[connector.id]});
    const job=await f.api('POST','/api/jobs',{name:'Analyze prepared timeframes',projectId:project.id,prompt:'Read the local snapshot and produce a bounded observation. Do not place orders or change source.',schedule:{type:'interval',seconds:3600},workerId:f.worker.id,requiredConnectorIds:[connector.id],timeoutMs:30_000,maxToolCalls:8,maxContextChars:12_000,maxOutputChars:4000});
    const run=await f.api('POST',`/api/jobs/${job.id}/trigger`,{eventId:'fixture-bar-42',input:{dataAsOf:snapshot.dataAsOf}});
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,0);assert.equal(f.ctl.store.run(run.id)?.status,'queued');assert.match(f.ctl.store.run(run.id)?.blockedReason??'',/Test connection/);
    await f.api('PUT',`/api/connectors/${connector.id}/auth`,{auth:{type:'env',credentialId:credential.id,bindings:{PROVIDER_TOKEN:'token'}}});
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,0);assert.match(f.ctl.store.run(run.id)?.blockedReason??'',/Configure|credential|authorize/i);
    assert.equal((await f.api('GET',`/api/jobs/${job.id}`)).history.length,1);
    await f.api('PUT',`/api/credentials/${credential.id}`,{values:{token}});
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,0);assert.match(f.ctl.store.run(run.id)?.blockedReason??'',/Test connection/);
    const tested=await f.api('POST',`/api/connectors/${connector.id}/test`,{});assert.equal(tested.status,'connected');assert.equal(tested.tools[0].name,'snapshot');
    await f.ctl.queue.tick();assert.equal(f.worker.submissions.length,1);
    const accepted=f.worker.submissions[0]!;assert.equal(accepted.runId,run.id);assert.equal(accepted.cwd,project.source.workspacePath);assert.match(accepted.connectors![0]!.transport==='stdio'?accepted.connectors![0]!.cwd??'':'',/\/releases\//);assert.equal(JSON.stringify(accepted).includes(token),false);
    const signal=await f.worker.analyze(run.id);await f.ctl.queue.drainSource();
    let detail=await f.api('GET',`/api/runs/${run.id}`);assert.equal(detail.status,'completed');assert.equal(detail.model,f.worker.model);assert.equal(detail.assignedWorkerId,f.worker.id);assert.deepEqual(detail.usage,usage);
    const history=await f.api('GET',`/api/conversations/${run.conversationId}`);assert.deepEqual(JSON.parse(history.messages.find((message:any)=>message.role==='assistant').content),signal);assert.equal(JSON.stringify(history).includes(token),false);
    const conversation=await f.api('POST',`/api/projects/${project.id}/conversations`,{});
    const parent=await f.api('POST',`/api/conversations/${conversation.id}/runs`,{prompt:'Delegate one bounded follow-up using the prepared snapshot.',requestId:'scenario-parent',workerId:f.worker.id,requiredConnectorIds:[connector.id],maxToolCalls:8});await f.ctl.queue.tick();assert.equal(f.ctl.store.run(parent.id)?.status,'running');
    const child=await bridgeRequest('tools/call',{name:'task_create',arguments:{prompt:'Read the prepared snapshot and record one observation.',requestId:'scenario-child',workerId:f.worker.id,requiredConnectorIds:[connector.id],maxToolCalls:4},runId:parent.id},{socketPath:f.config.bridgeSocket,token:f.config.ipcToken});
    assert.equal(child.parentRunId,parent.id);assert.equal(child.taskType,'delegated');assert.equal(f.ctl.store.projects.forConversation(child.conversationId)?.id,project.id);
    f.worker.finish(parent.id,{delegatedTask:child.id});await f.ctl.queue.drainSource();await f.ctl.queue.tick();assert.equal(f.ctl.store.run(child.id)?.status,'running');await f.worker.analyze(child.id);await f.ctl.queue.drainSource();
    const runsBefore=f.ctl.store.runs().length,eventsBefore=f.ctl.store.events().filter(event=>event.type==='completed').length,submissionsBefore=f.worker.submissions.length;
    await f.reopen();
    const registered=await f.api('GET','/api/workers');assert.equal(registered.find((item:any)=>item.worker.id===f.worker.id).worker.model,f.worker.model);
    const resumed=await f.api('GET',`/api/jobs/${job.id}`);assert.equal(resumed.enabled,true);assert.equal(resumed.history.length,1);assert.equal(resumed.history[0].status,'completed');assert.equal(resumed.history[0].model,f.worker.model);assert.equal(resumed.history[0].workerId,f.worker.id);
    detail=await f.api('GET',`/api/runs/${child.id}`);assert.equal(detail.parentRunId,parent.id);assert.equal(detail.status,'completed');assert.equal(detail.model,f.worker.model);assert.deepEqual(detail.usage,usage);
    const duplicate=await f.api('POST',`/api/jobs/${job.id}/trigger`,{eventId:'fixture-bar-42',input:{dataAsOf:snapshot.dataAsOf}});assert.equal(duplicate.id,run.id);await f.ctl.queue.tick();assert.equal(f.ctl.store.runs().length,runsBefore);assert.equal(f.worker.submissions.length,submissionsBefore);assert.equal(f.ctl.store.events().filter(event=>event.type==='completed').length,eventsBefore);
    const exported=await f.api('GET',`/api/projects/${connector.projectId}/source`);assert.equal(exported.source.commit,source.source.commit);assert.equal(exported.source.dirty,false);assert.equal(JSON.stringify(exported).includes(token),false);assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);f.verifyOwner();
  }finally{await f.close();}
});
