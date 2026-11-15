import type { DatabaseSync } from 'node:sqlite';
import { z } from 'zod';
import type { WorkerClient } from './ipc.ts';

const operationId=z.string().refine(value=>value.startsWith('runtime_')&&z.string().uuid().safeParse(value.slice(8)).success,'Invalid runtime operation receipt ID');
const acknowledgement=z.object({acknowledged:z.literal(true),operationId}).strict();
const failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const maxPayloadBytes=16*1024*1024;
type ReceiptRow={operationId:string;method:string;projectId:string|null;payload:string;receivedAt:string;acknowledgedAt:string|null};

/** Effect results become durable controller evidence before the worker forgets them. */
export class RuntimeReceipts {
  private recovering?:Promise<boolean>;
  constructor(private db:DatabaseSync,private client:WorkerClient){}
  private async connect():Promise<void>{
    let health;
    try{health=await this.client.connect();}catch{throw failure('The worker is unavailable. Reconnect it before running a runtime operation.',503);}
    if(!Array.isArray(health.runtimeOperations))throw failure('Restart the older worker before running runtime operations; durable result receipts are required.');
  }
  private async acknowledge(id:string):Promise<void>{
    const result=acknowledgement.parse(await this.client.request('runtime/acknowledge',{operationId:id}));
    if(result.operationId!==id)throw failure('The worker acknowledged a different runtime operation; the receipt remains pending.');
    this.db.prepare('UPDATE runtime_receipts SET acknowledgedAt=? WHERE operationId=? AND acknowledgedAt IS NULL').run(new Date().toISOString(),id);
  }
  async request(method:string,input:unknown,beforeDispatch?:()=>void):Promise<unknown>{
    z.string().min(1).max(100).refine(value=>!value.includes('\0')).parse(method);
    await this.connect();beforeDispatch?.();
    const raw:unknown=await this.client.request(method,input);
    if(!raw||typeof raw!=='object'||Array.isArray(raw)||!Object.hasOwn(raw,'__runtimeOperationId'))return raw;
    const {__runtimeOperationId,...payload}=raw as Record<string,unknown>;
    const id=operationId.parse(__runtimeOperationId),serialized=JSON.stringify(payload);
    if(Buffer.byteLength(serialized)>maxPayloadBytes)throw failure('Runtime result exceeds the durable receipt size limit; its worker operation still requires reconciliation.');
    const project=input&&typeof input==='object'&&!Array.isArray(input)?(input as Record<string,unknown>).project:undefined;
    const projectId=project&&typeof project==='object'&&!Array.isArray(project)?z.string().uuid().safeParse((project as Record<string,unknown>).id):undefined;
    const prior=this.db.prepare('SELECT * FROM runtime_receipts WHERE operationId=?').get(id) as ReceiptRow|undefined;
    if(prior&&(prior.method!==method||prior.projectId!==(projectId?.success?projectId.data:null)||prior.payload!==serialized))throw failure('Runtime operation ID was reused with different receipt data; it has not been acknowledged.');
    this.db.prepare('INSERT OR IGNORE INTO runtime_receipts(operationId,method,projectId,payload,receivedAt) VALUES(?,?,?,?,?)').run(id,method,projectId?.success?projectId.data:null,serialized,new Date().toISOString());
    // Receipt persistence failures escape above: never ACK an outcome we cannot recover.
    if(!prior?.acknowledgedAt)try{await this.acknowledge(id);}catch{/* The confirmed payload is durable; recovery will retry only its ACK. */}
    return payload;
  }
  recover():Promise<boolean>{
    if(this.recovering)return this.recovering;
    const recover=(async()=>{
      const pending=this.db.prepare('SELECT operationId FROM runtime_receipts WHERE acknowledgedAt IS NULL ORDER BY receivedAt,operationId').all() as {operationId:string}[];
      if(!pending.length)return false;
      await this.connect();let recovered=false;
      for(const row of pending){await this.acknowledge(operationId.parse(row.operationId));recovered=true;}
      return recovered;
    })();
    this.recovering=recover;void recover.finally(()=>{if(this.recovering===recover)this.recovering=undefined;}).catch(()=>{});return recover;
  }
  list(limit=50){
    z.number().int().min(1).max(100).parse(limit);
    return this.db.prepare('SELECT operationId,method,projectId,receivedAt,acknowledgedAt,length(CAST(payload AS BLOB)) AS payloadBytes FROM runtime_receipts ORDER BY receivedAt DESC,operationId DESC LIMIT ?').all(limit) as Array<Omit<ReceiptRow,'payload'>&{payloadBytes:number}>;
  }
  get(id:string){
    operationId.parse(id);const row=this.db.prepare('SELECT * FROM runtime_receipts WHERE operationId=?').get(id) as ReceiptRow|undefined;
    if(!row)throw failure('Runtime result receipt not found',404);
    return {...row,payload:JSON.parse(row.payload) as unknown};
  }
}
