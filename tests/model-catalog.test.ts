import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync,symlinkSync,truncateSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { cachedModels,readCachedModels,WorkerModelCatalogService } from '../src/workers/models.ts';
import { CodexAdapter } from '../src/runtime/codex.ts';
import { WorkerServer } from '../src/worker.ts';
import { WorkerClient } from '../src/ipc.ts';
import { initState,type Config } from '../src/config.ts';
import type { WorkerRegistry } from '../src/workers/registry.ts';
import type { WorkerRecord } from '../src/workers/schemas.ts';
import type { WorkerModel } from '../src/workers/models-schema.ts';

const model:WorkerModel={id:'fixture-model',name:'Fixture model',description:'Public model description',supportedEfforts:['low','medium','max','ultra'],defaultEffort:'low',isDefault:true};
const cached=(id='fixture-model',visibility='list')=>({slug:id,display_name:'Fixture model',description:'Public model description',visibility,supported_reasoning_levels:[{effort:'low'},{effort:'medium'},{effort:'max'},{effort:'ultra'}],default_reasoning_level:'low',model_messages:{instructions_template:'Never publish this private instruction'},privateToken:'Never publish this token'});
const record:WorkerRecord={id:'default',name:'Default worker',model:null,mode:'user',enabled:true,draining:false,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()};
function setup(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-models-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:join(process.cwd(),'node_modules/.bin/codex'),host:'127.0.0.1',port:3001,origins:[],adminPassword:'',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);return {config,close(){rmSync(stateDir,{recursive:true,force:true});}};
}

test('cached model metadata excludes hidden models, instructions and account data while keeping supported effort values',()=>{
  const models=cachedModels({identity:{token:'private account data'},models:[cached(),cached('internal','hide'),null,{broken:true},cached()]});
  assert.equal(models.length,1);assert.deepEqual(models[0],{...model,isDefault:false});assert.equal(JSON.stringify(models).includes('Never publish'),false);assert.equal(JSON.stringify(models).includes('private account'),false);
  const future=cached();future.supported_reasoning_levels.push({effort:'future-unsupported'});assert.deepEqual(cachedModels({models:[future]})[0]?.supportedEfforts,['low','medium','max','ultra']);
});

test('model caches reject malformed, oversized, linked and unowned profile data',()=>{
  const f=setup(),path=join(f.config.runtimeHome,'models_cache.json');try{
    writeFileSync(path,JSON.stringify({models:[cached()]}));assert.equal(readCachedModels(f.config.runtimeHome,f.config.controllerUid).length,1);assert.deepEqual(readCachedModels(f.config.runtimeHome,f.config.controllerUid+1),[]);
    writeFileSync(path,'{bad json');assert.deepEqual(readCachedModels(f.config.runtimeHome,f.config.controllerUid),[]);
    truncateSync(path,4*1024*1024+1);assert.deepEqual(readCachedModels(f.config.runtimeHome,f.config.controllerUid),[]);rmSync(path);
    const other=join(f.config.stateDir,'outside.json');writeFileSync(other,JSON.stringify({models:[cached()]}));symlinkSync(other,path);assert.deepEqual(readCachedModels(f.config.runtimeHome,f.config.controllerUid),[]);
    const linked=join(f.config.stateDir,'linked-profile');symlinkSync(f.config.runtimeHome,linked);assert.deepEqual(readCachedModels(linked,f.config.controllerUid),[]);
  }finally{f.close();}
});

test('adapter discovery uses bounded read-only pagination and publishes only visible model metadata',async()=>{
  const adapter=new CodexAdapter({} as Config),calls:Array<{method:string;params:any}>=[];
  const entry=(hidden=false)=>({id:'fixture-id',model:'fixture-model',displayName:'Fixture model',description:model.description,hidden,supportedReasoningEfforts:model.supportedEfforts.map(reasoningEffort=>({reasoningEffort})),defaultReasoningEffort:'low',isDefault:true,modelInstructions:'Never publish this instruction',accountToken:'Never publish this token'});
  adapter.request=async(method,params)=>{calls.push({method,params});return (params as {cursor?:string}).cursor?{data:[entry()],nextCursor:null}:{data:[{...entry(true),id:'hidden',model:'internal-model'}],nextCursor:'second'};};
  assert.deepEqual(await adapter.listModels(),[model]);assert.equal(calls.length,2);assert(calls.every(call=>call.method==='model/list'&&call.params.includeHidden===false));assert.equal(JSON.stringify(await adapter.listModels()).includes('Never publish'),false);
  adapter.request=async()=>({data:[],nextCursor:'repeated'});await assert.rejects(adapter.listModels(),/repeated.*cursor/);
  let pages=0;adapter.request=async()=>({data:[],nextCursor:`page-${++pages}`});await assert.rejects(adapter.listModels(),/pagination limit/);assert.equal(pages,20);await adapter.close();
});

test('catalog lookup is single-flight, prefers live metadata and falls back without closing a timed-out worker',async t=>{
  const f=setup();let requests=0,closed=0,release!:(value:WorkerModel[])=>void;
  const registry={list:()=>[record],cachedHealth:()=>({runtime:{authenticating:false}}),client:()=>({request:async()=>{requests++;return new Promise<WorkerModel[]>(ok=>{release=ok;});},close(){closed++;}})} as unknown as WorkerRegistry;
  try{
    const service=new WorkerModelCatalogService(f.config,registry),first=service.list(),second=service.list();assert.equal(first,second);assert.equal(requests,1);release([model]);assert.deepEqual(await first,{models:[model],source:'worker',detail:'Available models from a connected worker. The new worker confirms availability after sign-in.'});
    writeFileSync(join(f.config.runtimeHome,'models_cache.json'),JSON.stringify({models:[cached()]}));
    t.mock.timers.enable({apis:['setTimeout']});const pending=service.list();t.mock.timers.tick(1250);
    const fallback=await pending;assert.equal(fallback.source,'cache');assert.equal(fallback.models[0]?.id,model.id);assert.equal(closed,0);
  }finally{f.close();}
});

test('offline lookup uses only configured profile caches and explains an empty catalog',async()=>{
  const f=setup(),registry={list:()=>[record],cachedHealth:()=>null,client:()=>{throw new Error('Offline model lookup must not contact a worker');}} as unknown as WorkerRegistry;
  try{
    const service=new WorkerModelCatalogService(f.config,registry);assert.equal((await service.list()).source,'unavailable');
    writeFileSync(join(f.config.runtimeHome,'models_cache.json'),JSON.stringify({models:[cached()]}));assert.equal((await service.list()).source,'cache');
  }finally{f.close();}
});

test('model discovery remains serialized with submission when both wait for an older health probe',async()=>{
  const f=setup();let index=0,turns=0,healthEntered!:()=>void,modelEntered!:()=>void,releaseHealth=()=>{},releaseModels=()=>{};
  const healthStarted=new Promise<void>(ok=>{healthEntered=ok;}),modelsStarted=new Promise<void>(ok=>{modelEntered=ok;}),healthGate=new Promise<void>(ok=>{releaseHealth=ok;}),modelsGate=new Promise<void>(ok=>{releaseModels=ok;});
  class Adapter extends EventEmitter {
    version='fixture';readonly index=++index;
    async start(){}async health(){if(this.index===2){healthEntered();await healthGate;}return {authenticated:true,detail:'Model list fixture'};}
    async listModels(){modelEntered();await modelsGate;return [model];}
    async run(){turns++;this.emit('event','completed',{status:'completed'});}
    async interrupt(){this.emit('event','completed',{status:'interrupted'});}async close(){}
  }
  const worker=new WorkerServer(f.config,()=>new Adapter() as any),client=new WorkerClient(f.config);let health:Promise<void>|undefined,listing:Promise<any>|undefined,submission:Promise<any>|undefined;
  try{
    await worker.listen();await client.connect();(worker as any).healthCheckedAt=0;health=(worker as any).probe();await healthStarted;
    listing=client.request('models/list',{});await new Promise(ok=>setImmediate(ok));
    submission=client.request('submit',{runId:'catalog-race',conversationId:'fixture',prompt:'Fixture',bootstrap:'',skills:[],cwd:join(f.config.stateDir,'workspaces','fixture')});await new Promise(ok=>setImmediate(ok));
    releaseHealth();await modelsStarted;await new Promise(ok=>setImmediate(ok));assert.equal(turns,0);assert.equal(worker.journal.get('catalog-race'),undefined);
    releaseModels();assert.deepEqual(await listing,[model]);assert.equal((await submission).accepted,true);
    for(let count=0;count<10&&turns===0;count++)await new Promise(ok=>setImmediate(ok));assert.equal(turns,1);
    assert.deepEqual(worker.journal.runtimeOperations(),[]);
  }finally{releaseHealth();releaseModels();await Promise.allSettled([health,listing,submission]);client.close();await worker.close();f.close();}
});

test('the pinned app-server lists actual model IDs and efforts without creating a thread or inference turn',{timeout:30_000},async()=>{
  const f=setup(),adapter=new CodexAdapter(f.config),calls:string[]=[],request=adapter.request.bind(adapter);
  adapter.request=(method,params,timeout)=>{calls.push(method);return request(method,params,timeout);};
  try{
    await adapter.start();const models=await adapter.listModels();assert(models.length>0);assert(models.some(model=>model.isDefault));assert(models.every(model=>model.id&&model.name&&Array.isArray(model.supportedEfforts)));assert.deepEqual(calls,['initialize','model/list']);assert.equal(adapter.threadId,undefined);
  }finally{await adapter.close();f.close();}
});

test('submission rechecks discovery started while it waits for representative checks',async()=>{
  const f=setup();let turns=0,entered!:()=>void,releaseModels=()=>{},releaseChecks=()=>{};
  const started=new Promise<void>(ok=>{entered=ok;}),modelGate=new Promise<void>(ok=>{releaseModels=ok;}),checkGate=new Promise<void>(ok=>{releaseChecks=ok;});
  class Adapter extends EventEmitter {
    version='fixture';async start(){}async health(){return {authenticated:true,detail:'Fixture'};}
    async listModels(){entered();await modelGate;return [model];}
    async run(){turns++;this.emit('event','completed',{status:'completed'});}async interrupt(){this.emit('event','completed',{status:'interrupted'});}async close(){}
  }
  const worker=new WorkerServer(f.config,()=>new Adapter() as any),client=new WorkerClient(f.config);let listing:Promise<any>|undefined,submission:Promise<any>|undefined;
  try{
    await worker.listen();await client.connect();(worker as any).checks=checkGate;
    submission=client.request('submit',{runId:'catalog-check-race',conversationId:'fixture',prompt:'Fixture',bootstrap:'',skills:[],cwd:join(f.config.stateDir,'workspaces','fixture')});await new Promise(ok=>setImmediate(ok));
    listing=client.request('models/list',{});await started;releaseChecks();await new Promise(ok=>setImmediate(ok));assert.equal(turns,0);assert.equal(worker.journal.get('catalog-check-race'),undefined);
    releaseModels();assert.deepEqual(await listing,[model]);assert.equal((await submission).accepted,true);
    for(let count=0;count<10&&turns===0;count++)await new Promise(ok=>setImmediate(ok));assert.equal(turns,1);
  }finally{releaseChecks();releaseModels();await Promise.allSettled([listing,submission]);client.close();await worker.close();f.close();}
});
