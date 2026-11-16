import { EventEmitter } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import type { DatabaseSync } from 'node:sqlite';
import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import { WorkerClient, type WorkerEvent, type WorkerHealth } from '../ipc.ts';
import { workerLaunch } from '../worker-launch.ts';
import { ownWorkerConfig } from './config.ts';
import { workerManifests, writeWorkerManifest } from './manifest.ts';
import { workerCreateInput, workerId, workerRecordSchema, workerUpdateInput, type WorkerRecord, type WorkerStatus } from './schemas.ts';

const failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
type Row=Omit<WorkerRecord,'enabled'|'draining'|'effort'>&{enabled:number;draining:number;effort:string|null};
export interface WorkerSelection {worker:WorkerRecord;client:WorkerClient;health:WorkerHealth}

/** Registry metadata never starts, signals, or changes the identity of a live worker. */
export class WorkerRegistry extends EventEmitter {
  private clients=new Map<string,WorkerClient>();
  private clientCleanups=new Map<string,()=>void>();
  private healths=new Map<string,WorkerHealth>();
  private errors=new Map<string,string>();
  private router?:RoutedWorkerClient;
  private operationOwners=new Map<string,{workerId:string;journalId?:string}>();
  private scope=new AsyncLocalStorage<string>();
  constructor(readonly config:Config,private db:DatabaseSync,legacyClient?:WorkerClient){super();if(legacyClient)this.attach('default',legacyClient);}
  private defaultRecord():WorkerRecord{const health=this.healths.get('default'),effort=health?health.effort:this.config.effort;return {id:'default',name:'Default worker',model:health&&Object.hasOwn(health,'model')?health.model??null:this.config.model??null,...(effort?{effort}:{}),mode:health?(health.uid===0?'root':'user'):this.config.requireRootWorker?'root':'user',enabled:true,draining:false,createdAt:new Date(0).toISOString(),updatedAt:new Date(0).toISOString()};}
  private expand(row:Row):WorkerRecord {return workerRecordSchema.parse({...row,enabled:row.enabled===1,draining:row.draining===1,...(row.effort?{effort:row.effort}:{effort:undefined})});}
  private importManifests():void {
    for(const record of workerManifests(this.config))if(!this.db.prepare('SELECT id FROM workers WHERE id=?').get(record.id))this.insert(record);
  }
  private insert(record:WorkerRecord):void {this.db.prepare('INSERT INTO workers(id,name,model,effort,mode,enabled,draining,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?)').run(record.id,record.name,record.model,record.effort??null,record.mode,record.enabled?1:0,record.draining?1:0,record.createdAt,record.updatedAt);}
  list():WorkerRecord[]{this.importManifests();const records=(this.db.prepare('SELECT * FROM workers ORDER BY createdAt,id').all() as Row[]).map(row=>{const record=this.expand(row);return record.id==='default'&&this.healths.has('default')?{...record,mode:this.defaultRecord().mode,model:this.defaultRecord().model,effort:this.defaultRecord().effort}:record;});return records.some(record=>record.id==='default')?records:[this.defaultRecord(),...records];}
  get(id:string):WorkerRecord {workerId.parse(id);let record=this.list().find(item=>item.id===id);if(!record)throw failure('Worker not found',404);if(id==='default'&&this.healths.has(id)){const observed=this.defaultRecord();record={...record,mode:observed.mode,model:observed.model,effort:observed.effort};}return record;}
  register(raw:unknown):WorkerRecord {
    const input=workerCreateInput.parse(raw);if(this.list().some(record=>record.id===input.id))throw failure('That worker ID is already registered. Use a new ID for different startup settings.');
    const now=new Date().toISOString(),record={...input,draining:false,createdAt:now,updatedAt:now};writeWorkerManifest(this.config,record);this.insert(record);return record;
  }
  update(id:string,raw:unknown):WorkerRecord {
    const input=workerUpdateInput.parse(raw),record={...this.get(id),...input,updatedAt:new Date().toISOString()};writeWorkerManifest(this.config,record);
    if(this.db.prepare('SELECT id FROM workers WHERE id=?').get(id))this.db.prepare('UPDATE workers SET name=?,enabled=?,draining=?,updatedAt=? WHERE id=?').run(record.name,record.enabled?1:0,record.draining?1:0,record.updatedAt,id);else this.insert(record);
    return record;
  }
  drain(id:string,draining=true):WorkerRecord{return this.update(id,{draining});}
  command(id:string):string{return workerLaunch(ownWorkerConfig(this.config,this.get(id))).command;}
  status(id:string):WorkerStatus{return {worker:this.get(id),connected:this.healths.has(id),health:this.healths.get(id)??null,error:this.errors.get(id)??null,command:this.command(id)};}
  cachedHealth(id:string):WorkerHealth|null{return this.healths.get(id)??null;}
  private attach(id:string,client:WorkerClient):WorkerClient {
    const event=(event:WorkerEvent)=>{const health=this.healths.get(id);this.emit('event',{...event,workerId:event.workerId??id,...(event.journalId||health?.journalId?{journalId:event.journalId??health?.journalId}:{})},id);};
    const disconnect=()=>{this.healths.delete(id);this.emit('disconnect',id);};
    this.clientCleanups.get(id)?.();this.clients.set(id,client);client.on('event',event);client.on('disconnect',disconnect);
    this.clientCleanups.set(id,()=>{client.off('event',event);client.off('disconnect',disconnect);});return client;
  }
  client(id:string):WorkerClient {return this.clients.get(id)??this.attach(id,new WorkerClient(ownWorkerConfig(this.config,this.get(id))));}
  private compatible(record:WorkerRecord,health:WorkerHealth):void {
    if(record.id!=='default'&&(health.workerId!==record.id||!health.journalId||health.model!==record.model||(health.effort??null)!==(record.effort??null)))throw failure('Running worker identity/model/effort differs from its registration. Stop it and start the registered command.');
    if(record.id!=='default'&&health.workerMode&&health.workerMode!==record.mode)throw failure('Running worker permission mode differs from its registration.');
    if(health.workerId&&health.workerId!==record.id)throw failure('A different worker owns this socket.');
    if(health.uid===0&&(!health.root||(health.executionUid??health.uid)!==0))throw failure('This worker does not execute its agent as the reported root identity.');
    if(record.id!=='default'&&record.mode==='root'&&(health.uid!==0||!health.root))throw failure('This worker registration requires actual root execution.');
    if(record.id!=='default'&&record.mode==='user'&&(health.uid===0||health.uid!==this.config.controllerUid))throw failure('This worker registration requires the normal controller user.');
    if(health.projectsDir&&resolve(health.projectsDir)!==resolve(this.config.projectsDir??`${this.config.stateDir}/projects`))throw failure('Worker and controller projects roots differ; restart the worker with its registered command.');
  }
  async refresh(id:string):Promise<WorkerStatus>{
    const record=this.get(id);try{const health=await this.client(id).connect();this.compatible(record,health);this.healths.set(id,health);this.errors.delete(id);}catch(error){this.healths.delete(id);this.errors.set(id,String((error as Error).message));}
    return this.status(id);
  }
  async refreshAll():Promise<WorkerStatus[]>{return await Promise.all(this.list().map(record=>this.refresh(record.id)));}
  async select(options:{workerId?:string;mode?:WorkerRecord['mode'];model?:string}={}):Promise<WorkerSelection>{
    const records=options.workerId?[this.get(options.workerId)]:this.list();
    for(const record of records){
      if(!record.enabled||record.draining||(record.id!=='default'&&record.mode!==(options.mode??'user'))||(record.id!=='default'&&options.model&&record.model!==options.model))continue;
      const status=await this.refresh(record.id),health=status.health;
      if(status.worker.mode!==(options.mode??'user')||((options.mode??'user')==='user'&&health?.uid===0)||((options.mode??'user')==='root'&&health?.uid!==0))continue;
      if(options.model&&status.worker.model!==options.model)continue;
      if(!health||!health.runtime.available||!health.runtime.authenticated||health.runtime.authenticating||health.activeRunId||health.uncertainRuns.length||health.runtimeOperations?.length||health.replacementReserved)continue;
      return {worker:status.worker,client:this.client(record.id),health};
    }
    throw failure('No eligible idle worker is available for the requested permission and model.');
  }
  async control():Promise<WorkerSelection>{
    const scoped=this.scope.getStore();
    if(scoped){const status=await this.refresh(scoped);if(!status.health)throw failure(`Assigned worker ${scoped} is unavailable. Its operation was not routed elsewhere.`,503);return {worker:status.worker,client:this.client(scoped),health:status.health};}
    const records=this.list().filter(record=>record.enabled&&!record.draining).sort((a,b)=>Number(b.mode==='root')-Number(a.mode==='root'));
    for(const worker of records){const status=await this.refresh(worker.id);if(status.health)return {worker:status.worker,client:this.client(worker.id),health:status.health};}
    throw failure('No connected compatible worker is available.',503);
  }
  withWorker<T>(id:string,operation:()=>Promise<T>):Promise<T>{this.get(id);return this.scope.run(id,operation);}
  scopedWorker():string|undefined{return this.scope.getStore();}
  rememberOperation(id:string,workerId:string,journalId?:string){this.operationOwners.set(id,{workerId,journalId});}
  async operationOwner(id:string):Promise<WorkerSelection>{
    const known=this.operationOwners.get(id);
    if(known){const status=await this.refresh(known.workerId);if(!status.health)throw failure('The runtime operation owner is unavailable.',503);if(known.journalId&&status.health.journalId!==known.journalId)throw failure('Runtime operation journal changed; reconcile ownership before acknowledging.');return {worker:status.worker,client:this.client(known.workerId),health:status.health};}
    for(const status of await this.refreshAll())if(status.health?.runtimeOperations?.some(operation=>operation.id===id))return {worker:status.worker,client:this.client(status.worker.id),health:status.health};
    throw failure('Runtime operation owner is unknown; its acknowledgement was not sent.');
  }
  routedClient():RoutedWorkerClient{return this.router??=new RoutedWorkerClient(this);}
  close(){for(const cleanup of this.clientCleanups.values())cleanup();this.clientCleanups.clear();for(const client of this.clients.values())client.close();this.clients.clear();this.healths.clear();this.errors.clear();this.operationOwners.clear();this.router=undefined;this.removeAllListeners();}
}

/** Shared host operations stay pinned to one client; effect failures are never retried elsewhere. */
export class RoutedWorkerClient extends WorkerClient {
  private current?:WorkerSelection;
  constructor(private registry:WorkerRegistry){super(registry.config);registry.on('event',(event:WorkerEvent)=>{if(event.workerId===this.current?.worker.id)this.emit('event',event);});registry.on('disconnect',(id:string)=>{if(id===this.current?.worker.id){this.current=undefined;this.emit('disconnect');}});}
  async connect():Promise<WorkerHealth>{const selected=await this.registry.control();if(!this.registry.scopedWorker())this.current=selected;return {...selected.health,workerId:selected.worker.id};}
  async request(method:string,params:unknown={}):Promise<any>{
    if(method==='runtime/acknowledge'){const id=(params as {operationId?:string}).operationId;if(!id)throw failure('Runtime acknowledgement requires an operation ID.');const owner=await this.registry.operationOwner(id);return owner.client.request(method,params);}
    const selected=this.registry.scopedWorker()?await this.registry.control():this.current??await this.registry.control();if(!this.registry.scopedWorker())this.current=selected;
    if(['managed/deploy','managed/stop'].includes(method)&&selected.worker.mode!=='root')throw failure('This operation requires an explicitly registered root worker.');
    const result=await selected.client.request(method,params);if(result&&typeof result==='object'&&typeof result.__runtimeOperationId==='string')this.registry.rememberOperation(result.__runtimeOperationId,selected.worker.id,selected.health.journalId);return result;
  }
  close(){this.current?.client.close();this.current=undefined;}
}
