import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.ts';
import type { WorkerClient } from '../ipc.ts';
import type { ManagedService } from '../managed/service.ts';
import type { ProjectService } from '../projects/service.ts';
import { RuntimeReceipts } from '../runtime-receipts.ts';
import { connectorSnapshotSchema, connectorToolsResult, connectorCallResult, connectorInput, connectorPatchInput, connectorAssignmentInput, connectorCall, type ConnectorSnapshot, type Connector } from './schemas.ts';

const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type ResolvedConnector={connector:ConnectorSnapshot;updatedAt:string;sourceCommit:string|null};
function snapshotKey(value:ResolvedConnector){const {name,...configuration}=value.connector;return JSON.stringify({configuration,sourceCommit:value.sourceCommit});}

/** Provider-neutral registrations. Credential storage/authorization is a later slice. */
export class ConnectorService {
  private receipts:RuntimeReceipts;
  constructor(private store:Store,client:WorkerClient,private projects:ProjectService,private managed:ManagedService,receipts?:RuntimeReceipts){this.receipts=receipts??new RuntimeReceipts(store.db,client);}
  list():Connector[]{return this.store.connectors.list().map(row=>this.expand(row));}
  get(id:string):Connector{z.string().uuid().parse(id);const row=this.store.connectors.get(id);if(!row)throw failure('Connection not found',404);return this.expand(row);}
  private expand(row:Connector):Connector{
    const source=row.projectId?this.projects.get(row.projectId).source??null:undefined;
    if(row.status==='connected'){
      const saved=this.store.connectors.testedSnapshot(row.id);
      if(!saved||(JSON.parse(saved) as {sourceCommit:string|null}).sourceCommit!==(source?.commit??null))return {...row,source,status:'untested',tools:[],detail:'Connection source changed or its previous test needs refreshing. Test the current revision before calling tools.'};
    }
    return {...row,...(row.projectId?{source}:{})};
  }
  create(raw:unknown){
    const input=connectorInput.parse(raw),id=randomUUID(),now=new Date().toISOString();
    if(input.projectId)this.projects.get(input.projectId);
    if(this.store.connectors.nameExists(input.name))throw failure('That connection name is already registered',409);
    const definition=connectorSnapshotSchema.parse(input.transport==='stdio'?{id,name:input.name,transport:input.transport,command:input.command,args:input.args,...(input.cwd?{cwd:input.cwd}:{})}:{id,name:input.name,transport:input.transport,url:input.url});
    this.store.connectors.create({...definition,description:input.description,enabled:input.enabled,projectId:input.projectId??null,tools:[],status:'untested',detail:'Connection has not been tested.',checkedAt:null,createdAt:now,updatedAt:now});
    return this.get(id);
  }
  update(id:string,raw:unknown){
    const current=this.get(id),input=connectorPatchInput.parse(raw);
    if(input.name&&this.store.connectors.nameExists(input.name,id))throw failure('That connection name is already registered',409);
    this.store.connectors.update(id,{name:input.name??current.name,description:input.description??current.description,enabled:input.enabled??current.enabled});
    return this.get(id);
  }
  async createExample(){
    const project=this.projects.create({name:'Local MCP example',description:'Managed local echo connector for verifying source, Git, and MCP.',origin:'created'});
    const value=await this.managed.createSource(project.id,{kind:'connector',template:'connector'});
    if(!value.manifest.mcp||value.manifest.mcp.transport!=='stdio')throw failure('The local example did not declare a stdio MCP server.');
    return this.create({name:`Local example ${project.id.slice(0,8)}`,description:project.description,projectId:project.id,...value.manifest.mcp});
  }
  async registerProject(id:string){
    const project=this.projects.get(id),value=await this.managed.readSource(id);
    if(!value.manifest.mcp)throw failure('The package manifest needs an mcp configuration.');
    const existing=this.list().find(item=>item.projectId===id);
    if(existing)return existing;
    return this.create({name:project.name,description:project.description,projectId:id,...value.manifest.mcp});
  }
  private async resolve(id:string):Promise<ResolvedConnector>{
    const record=this.get(id);if(!record.enabled)throw failure('Enable this connection before using its tools.',409);
    let connector:ConnectorSnapshot,sourceCommit:string|null=null;
    if(record.projectId&&this.projects.get(record.projectId).source){
      const value=await this.managed.readSource(record.projectId),mcp=value.manifest.mcp;
      if(!mcp)throw failure('The managed package no longer declares an MCP server.');
      if(mcp.transport==='stdio'){
        const release=await this.managed.prepareExport(record.projectId,value);
        connector=connectorSnapshotSchema.parse({id,name:record.name,...mcp,cwd:release.releaseDirectory});
      }else{
        connector=connectorSnapshotSchema.parse({id,name:record.name,...mcp});
      }
      sourceCommit=value.source.commit;
    }else{
      connector=connectorSnapshotSchema.parse({id,name:record.name,...(record.transport==='stdio'?{transport:'stdio',command:record.command,args:record.args??[],...(record.cwd?{cwd:record.cwd}:{})}:{transport:'http',url:record.url})});
    }
    return {connector,sourceCommit,updatedAt:record.updatedAt};
  }
  private current(value:ResolvedConnector){
    const record=this.get(value.connector.id);
    return record.enabled&&record.updatedAt===value.updatedAt&&(record.source?.commit??null)===value.sourceCommit;
  }
  async test(id:string){
    this.get(id);
    let resolved:ResolvedConnector|undefined;
    try{
      resolved=await this.resolve(id);
      const checked=connectorToolsResult.safeParse(await this.receipts.request('connectors/test',{connector:resolved.connector},()=>{if(!this.current(resolved!))throw failure('Connection changed before its test started. Test it again.',409);}));
      if(!checked.success)throw failure('The worker returned an invalid MCP discovery response.',502);
      const result=checked.data;
      if(!this.current(resolved))throw failure('Connection changed while its tools were being tested. Test it again.',409);
      this.store.transaction(()=>this.store.connectors.observed(id,result.tools,result.checkedAt,snapshotKey(resolved!)));
    }catch(error){
      if(!resolved||this.current(resolved))this.store.transaction(()=>this.store.connectors.failed(id,String((error as Error).message)));
      throw error;
    }
    return this.get(id);
  }
  async call(id:string,raw:unknown){
    const input=connectorCall.parse(raw),record=this.get(id);
    if(!record.tools.some((tool:{name:string})=>tool.name===input.name))throw failure('Test the connection and choose one of its discovered tools.',409);
    const resolved=await this.resolve(id);
    const current=()=>{if(!this.current(resolved)||this.store.connectors.testedSnapshot(id)!==snapshotKey(resolved))throw failure('Connection source or configuration changed. Test its tools again before calling them.',409);};
    current();
    const result=connectorCallResult.safeParse(await this.receipts.request('connectors/call',{connector:resolved.connector,name:input.name,arguments:input.arguments},current));
    if(!result.success)throw failure('The worker returned an invalid MCP tool result.',502);return result.data;
  }
  assign(projectId:string,raw:unknown){
    this.projects.get(projectId);const {connectorIds}=connectorAssignmentInput.parse(raw);
    for(const id of connectorIds)this.get(id);
    this.store.transaction(()=>this.store.connectors.assign(projectId,connectorIds));
    return this.projects.get(projectId);
  }
  async snapshots(conversationId:string):Promise<ConnectorSnapshot[]>{
    const project=this.store.projects.forConversation(conversationId);if(!project)return [];
    const snapshots:ResolvedConnector[]=[];for(const id of this.store.connectors.assigned(project.id,true))snapshots.push(await this.resolve(id));
    if(snapshots.some(value=>!this.current(value)))throw failure('Project connections changed while preparing the task. Retry with the current configuration.',409);
    return snapshots.map(value=>value.connector);
  }
}
