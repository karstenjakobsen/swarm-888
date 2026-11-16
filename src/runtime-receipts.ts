import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import type { WorkerClient, WorkerHealth } from './ipc.ts';
import type { WorkerRegistry } from './workers/registry.ts';

const operationId=z.string().refine(value=>value.startsWith('runtime_')&&z.string().uuid().safeParse(value.slice(8)).success,'Invalid runtime operation receipt ID');
const acknowledgement=z.object({acknowledged:z.literal(true),operationId}).strict();
const failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const maxPayloadBytes=16*1024*1024;
type ReceiptRow={operationId:string;method:string;projectId:string|null;payload:string;receivedAt:string;acknowledgedAt:string|null;workerId:string;journalId:string};

/** Effect results become durable controller evidence before the worker forgets them. */
export class RuntimeReceipts {
  private recovering?:Promise<boolean>;
  constructor(private db:DatabaseSync,private client:WorkerClient,private projectsDir?:string,private registry?:WorkerRegistry){}
  private async connect():Promise<WorkerHealth>{
    let health;
    try{health=await this.client.connect();}catch{throw failure('The worker is unavailable. Reconnect it before running a runtime operation.',503);}
    if(!Array.isArray(health.runtimeOperations))throw failure('Restart the older worker before running runtime operations; durable result receipts are required.');
    return health;
  }
  private projectRoot(health:WorkerHealth,input:unknown){
    if(!input||typeof input!=='object'||Array.isArray(input)||!('project' in input))return;
    const project=(input as {project?:unknown}).project;
    if(!project||typeof project!=='object'||!('directory' in project)||typeof project.directory!=='string')return;
    const expected=this.projectsDir?resolve(this.projectsDir):undefined;
    if(!health.projectsDir)throw failure(`The running worker does not report its APP_PROJECTS_DIR. Restart it with its current command from Workers${expected?` to use ${expected}`:''}.`);
    const actual=resolve(health.projectsDir);
    if(expected&&actual!==expected)throw failure(`Controller APP_PROJECTS_DIR is ${expected}, but the running worker uses ${actual}. Restart it with its current command from Workers. Existing projects have not been moved.`);
    const directory=resolve(project.directory),path=relative(actual,directory);
    if(!path||isAbsolute(path)||path==='..'||path.startsWith(`..${sep}`))throw failure(`Registered project directory ${directory} is outside APP_PROJECTS_DIR ${actual}. Use the original configured projects root or explicitly import the project into the current root; its saved path has not been changed.`);
  }
  private async acknowledge(id:string):Promise<void>{
    const row=this.db.prepare('SELECT workerId,journalId FROM runtime_receipts WHERE operationId=?').get(id);
    if(!row)throw failure('The runtime receipt owner is missing');
    const client=this.registry?this.registry.client(String(row.workerId)):this.client;
    const health=await client.connect();
    if(row.journalId!=='legacy'&&health.journalId!==row.journalId||health.workerId&&health.workerId!==row.workerId)throw failure('The runtime receipt journal owner changed. Reconcile the original operation before acknowledging it.');
    const result=acknowledgement.parse(await client.request('runtime/acknowledge',{operationId:id}));
    if(result.operationId!==id)throw failure('The worker acknowledged a different runtime operation; the receipt remains pending.');
    this.db.prepare('UPDATE runtime_receipts SET acknowledgedAt=? WHERE operationId=? AND acknowledgedAt IS NULL').run(new Date().toISOString(),id);
  }
  async request(method:string,input:unknown,beforeDispatch?:()=>void):Promise<unknown>{
    z.string().min(1).max(100).refine(value=>!value.includes('\0')).parse(method);
    const health=await this.connect();this.projectRoot(health,input);beforeDispatch?.();
    const workerId=health.workerId??'default',journalId=health.journalId??'legacy',client=this.registry?this.registry.client(workerId):this.client;
    const raw:unknown=await client.request(method,input);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.hasOwn(raw,'__runtimeOperationId'))return raw;
    const {__runtimeOperationId,...payload}=raw as Record<string,unknown>;
    const id=operationId.parse(__runtimeOperationId),serialized=JSON.stringify(payload);
    if(Buffer.byteLength(serialized)>maxPayloadBytes)throw failure('Runtime result exceeds the durable receipt size limit; its worker operation still requires reconciliation.');
    const project=input&&typeof input==='object'&&!Array.isArray(input)?(input as Record<string,unknown>).project:undefined;
    const projectId=project&&typeof project==='object'&&!Array.isArray(project)?z.string().uuid().safeParse((project as Record<string,unknown>).id):undefined;
    const prior=this.db.prepare('SELECT * FROM runtime_receipts WHERE operationId=?').get(id) as ReceiptRow|undefined;
    if(prior&&(prior.method!==method||prior.projectId!==(projectId?.success?projectId.data:null)||prior.payload!==serialized||prior.workerId!==workerId||prior.journalId!==journalId))throw failure('Runtime operation ID was reused with different receipt data; it has not been acknowledged.');
    this.db.prepare('INSERT OR IGNORE INTO runtime_receipts(operationId,method,projectId,payload,receivedAt,workerId,journalId) VALUES(?,?,?,?,?,?,?)').run(id,method,projectId?.success?projectId.data:null,serialized,new Date().toISOString(),workerId,journalId);
    // Receipt persistence failures escape above: never ACK an outcome we cannot recover.
    if(!prior?.acknowledgedAt)try{await this.acknowledge(id);}catch{/* The confirmed payload is durable; recovery will retry only its ACK. */}
    return payload;
  }
  recover():Promise<boolean>{
    if(this.recovering)return this.recovering;
    const recover=(async()=>{
      const pending=this.db.prepare('SELECT operationId,workerId FROM runtime_receipts WHERE acknowledgedAt IS NULL ORDER BY receivedAt,operationId').all() as {operationId:string;workerId:string}[];
      if(!pending.length)return false;
      let recovered=false;const errors:Error[]=[];
      for(const row of pending)try{await this.acknowledge(operationId.parse(row.operationId));recovered=true;}
      catch(error){errors.push(new Error(`${row.workerId}/${row.operationId}: ${error instanceof Error?error.message:String(error)}`,{cause:error}));}
      if(errors.length)throw Object.assign(new AggregateError(errors,`Runtime receipt ACK recovery incomplete: ${errors.map(error=>error.message).join('; ')}`),{statusCode:503});
      return recovered;
    })();
    this.recovering=recover;void recover.finally(()=>{if(this.recovering===recover)this.recovering=undefined;}).catch(()=>{});return recover;
  }
  list(limit=50){
    z.number().int().min(1).max(100).parse(limit);
    return this.db.prepare('SELECT operationId,method,projectId,workerId,journalId,receivedAt,acknowledgedAt,length(CAST(payload AS BLOB)) AS payloadBytes FROM runtime_receipts ORDER BY receivedAt DESC,operationId DESC LIMIT ?').all(limit) as Array<Omit<ReceiptRow,'payload'>&{payloadBytes:number}>;
  }
  get(id:string){
    operationId.parse(id);const row=this.db.prepare('SELECT * FROM runtime_receipts WHERE operationId=?').get(id) as ReceiptRow|undefined;
    if(!row)throw failure('Runtime result receipt not found',404);
    return {...row,payload:JSON.parse(row.payload) as unknown};
  }
}
