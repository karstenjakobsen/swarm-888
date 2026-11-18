import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Store } from '../store.ts';
import type { WorkerClient } from '../ipc.ts';
import type { ManagedService } from '../managed/service.ts';
import type { ProjectService } from '../projects/service.ts';
import { RuntimeReceipts } from '../runtime-receipts.ts';
import type { CredentialVault } from '../credentials/vault.ts';
import { connectorAuthSchema,type ConnectorAuth } from '../credentials/schemas.ts';
import { packageManifestSchema } from '../packages/schemas.ts';
import { connectorSnapshotSchema, connectorToolsResult, connectorCallResult, connectorInput, connectorPackageInput, connectorAdoptInput, connectorPatchInput, connectorAssignmentInput, connectorCall, type ConnectorSnapshot, type Connector, type ConnectorTransport } from './schemas.ts';

const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type ResolvedConnector={connector:ConnectorSnapshot;updatedAt:string;sourceCommit:string|null};
function portableTransport(value:ConnectorTransport):ConnectorTransport {
  if(value.transport==='http')return {transport:'http',url:value.url};
  return {transport:'stdio',command:value.command,args:value.args};
}

function snapshotKey(value:ResolvedConnector){const {name,...configuration}=value.connector;return JSON.stringify({configuration,sourceCommit:value.sourceCommit});}

/** Provider-neutral registrations, immutable task snapshots, and authorization readiness. */
export class ConnectorService {
  private receipts:RuntimeReceipts;
  private operations=new Map<string,Promise<unknown>>();
  constructor(private store:Store,client:WorkerClient,private projects:ProjectService,private managed:ManagedService,receipts?:RuntimeReceipts,private vault?:CredentialVault){this.receipts=receipts??new RuntimeReceipts(store.db,client);}
  private exclusive<T>(key:string,operation:()=>Promise<T>):Promise<T>{
    const pending=(this.operations.get(key)??Promise.resolve()).catch(()=>{}).then(operation);
    this.operations.set(key,pending);
    void pending.finally(()=>{if(this.operations.get(key)===pending)this.operations.delete(key);}).catch(()=>{});
    return pending;
  }
  private authored<T>(runId:string|undefined,operation:()=>Promise<T>):Promise<T>{return runId?this.managed.packages.withRun(runId,operation):operation();}
  private sourceProject(row:Connector):string|null{return row.packageId??(row.projectId&&this.store.managed.source(row.projectId)?.kind==='connector'?row.projectId:null);}
  list():Connector[]{return this.store.connectors.list().map(row=>this.expand(row));}
  get(id:string):Connector{z.string().uuid().parse(id);const row=this.store.connectors.get(id);if(!row)throw failure('Connection not found',404);return this.expand(row);}
  private expand(row:Connector):Connector{
    row={...row,readiness:this.vault?.readiness(row.auth,row.id)??{ready:!row.auth,...(row.auth?{reason:'Configure connection credentials in Connections.'}:{})}};
    const sourceProject=this.sourceProject(row);
    const source=sourceProject?this.projects.get(sourceProject).source??null:undefined;
    if(row.status==='connected'){
      const saved=this.store.connectors.testedSnapshot(row.id);
      const checked=saved?JSON.parse(saved) as {sourceCommit:string|null;configuration?:{credentialRevision?:number}}:undefined;
      let authChanged=false;if(row.auth)try{authChanged=this.vault?.get(row.auth.credentialId).revision!==checked?.configuration?.credentialRevision;}catch{authChanged=true;}
      if(!checked||checked.sourceCommit!==(source?.commit??null)||authChanged||!row.readiness?.ready)return {...row,source,status:'untested',tools:[],detail:'Connection source or authorization changed. Test the current configuration before calling tools.'};
    }
    return {...row,...(sourceProject?{source}:{})};
  }
  create(raw:unknown){
    const input=connectorInput.parse(raw),id=randomUUID(),now=new Date().toISOString();
    if(input.projectId)this.projects.get(input.projectId);
    if(this.store.connectors.nameExists(input.name))throw failure('That connection name is already registered',409);
    const definition=connectorSnapshotSchema.parse(input.transport==='stdio'?{id,name:input.name,transport:input.transport,command:input.command,args:input.args,...(input.cwd?{cwd:input.cwd}:{})}:{id,name:input.name,transport:input.transport,url:input.url});
    this.store.connectors.create({...definition,description:input.description,enabled:input.enabled,projectId:input.projectId??null,tools:[],status:'untested',detail:'Connection has not been tested.',checkedAt:null,createdAt:now,updatedAt:now});
    return this.get(id);
  }
  async createPackaged(raw:unknown,runId?:string){
    const input=connectorPackageInput.parse(raw);
    return this.authored(runId,()=>this.exclusive(`name:${input.name}`,async()=>{
      const prior=this.managed.packages.store.atPath(input.repositoryId,input.packagePath);
      const existing=prior?this.list().find(value=>value.packageId===prior.id||!value.packageId&&value.projectId===prior.id):undefined;
      if(this.store.connectors.nameExists(input.name,existing?.id))throw failure('That connection name is already registered',409);
      if(prior&&(prior.kind!=='connector'||prior.name!==input.name||prior.description!==input.description||JSON.stringify(prior.manifest.mcp)!==JSON.stringify(portableTransport(input))||prior.manifest.check||prior.manifest.build||prior.manifest.run))throw failure('This package folder already has a different source definition. Import it from Repositories or choose another folder.',409);
      const record=prior??await this.managed.createPackage(input.repositoryId,{path:input.packagePath,kind:'connector',name:input.name,description:input.description,template:'empty',mcp:portableTransport(input)});
      this.managed.trackPackage(record.id,runId);
      await this.managed.materializePackage(record);
      const connection=await this.registerProject(record.id);
      return input.enabled===connection.enabled?connection:this.update(connection.id,{enabled:input.enabled});
    }));
  }
  async adoptPackage(id:string,raw:unknown,runId?:string){
    const input=connectorAdoptInput.parse(raw);
    return this.authored(runId,()=>this.exclusive(`connection:${id}`,async()=>{
      const current=this.get(id);
      if(current.source?.repositoryId){
        if(current.source.repositoryId!==input.repositoryId||current.source.path!==input.packagePath)throw failure('This connection already belongs to another package folder.',409);
        this.managed.trackPackage(current.source.packageId??current.packageId??current.projectId!,runId);
        if(!current.packageId&&current.source.packageId)this.store.transaction(()=>this.store.connectors.attachPackage(id,current.source!.packageId!));
        return this.get(id);
      }
      if(current.source)throw failure('Migrate this connection’s existing source project into a registered repository first.',409);
      if(current.transport==='stdio'&&current.cwd)throw failure('This connection uses a local working directory. Move its code into a connector package before adopting it; a metadata package cannot preserve that directory.',409);
      // The existing connection UUID makes a committed adoption recoverable if materialization is interrupted.
      return this.exclusive(`package:${id}`,async()=>{
        let record=this.managed.packages.store.package(id);
        if(record){
          if(record.kind!=='connector'||record.repositoryId!==input.repositoryId||record.path!==input.packagePath||JSON.stringify(record.manifest.mcp)!==JSON.stringify(portableTransport(current)))throw failure('The connection UUID already belongs to another package definition.',409);
        }else{
          const manifest=packageManifestSchema.parse({schemaVersion:1,id,kind:'connector',name:current.name,description:current.description,version:'0.1.0',mcp:portableTransport(current)});
          record=await this.managed.packages.createPackage(input.repositoryId,{path:input.packagePath,manifest});
        }
        this.managed.trackPackage(record.id,runId);
        await this.managed.materializePackage(record);
        this.store.transaction(()=>this.store.connectors.attachPackage(id,record!.id));
        return this.get(id);
      });
    }));
  }
  async updatePackaged(id:string,raw:unknown,runId?:string){
    const input=connectorPatchInput.parse(raw);
    return this.authored(runId,()=>this.exclusive(`connection:${id}`,async()=>{
      const current=this.get(id),name=input.name??current.name,description=input.description??current.description;
      if(this.store.connectors.nameExists(name,id))throw failure('That connection name is already registered',409);
      if(name!==current.name||description!==current.description){
        const sourceProject=this.sourceProject(current);
        if(!sourceProject||!current.source?.repositoryId)throw failure('Adopt this connection into a package before editing its shared details.',409);
        this.managed.trackProject(sourceProject,runId);
        const value=await this.managed.readReleaseSource(sourceProject);
        if(value.source.dirty||value.source.workspaceDiverged)throw failure('Commit or resolve package source changes before editing connection details.',409);
        const manifest=packageManifestSchema.parse({...value.manifest,name,description});
        await this.managed.writeSource(sourceProject,{files:{'operator-package.json':JSON.stringify(manifest,null,2)+'\n'},expectedCommit:value.source.commit,message:'Update connection details'});
      }
      return this.update(id,input);
    }));
  }
  update(id:string,raw:unknown){
    const current=this.get(id),input=connectorPatchInput.parse(raw);
    if(input.name&&this.store.connectors.nameExists(input.name,id))throw failure('That connection name is already registered',409);
    this.store.connectors.update(id,{name:input.name??current.name,description:input.description??current.description,enabled:input.enabled??current.enabled});
    return this.get(id);
  }
  setAuth(id:string,raw:ConnectorAuth|null){
    const connector=this.get(id),auth=raw===null?null:connectorAuthSchema.parse(raw);
    if(auth&&(connector.transport==='stdio')!==(auth.type==='env'))throw failure('Credential binding does not match connection transport');
    if(connector.auth&&connector.auth.credentialId!==auth?.credentialId&&this.vault)try{this.vault.revoke(connector.auth.credentialId,id);}catch(error){if((error as {statusCode?:number}).statusCode!==404&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    this.store.transaction(()=>this.store.connectors.setAuth(id,auth));return this.get(id);
  }
  readiness(ids:string[]){for(const id of z.array(z.string().uuid()).max(20).parse(ids)){const value=this.get(id);if(!value.enabled)return {ready:false,reason:`Connection ${value.name} is disabled.`,connectorId:id};if(!value.readiness?.ready)return {ready:false,reason:value.readiness?.reason??'Connection credentials are required',connectorId:id};if(value.status!=='connected')return {ready:false,reason:`Test connection ${value.name} in Connections before running tasks that require it.`,connectorId:id};}return {ready:true};}
  async createExample(raw:unknown={}){
    const input=z.object({repositoryId:z.string().uuid(),packagePath:z.string().min(1).max(1000)}).strict().parse(raw);
    const record=await this.managed.createPackage(input.repositoryId,{
      kind:'connector',name:`Local example ${randomUUID().slice(0,8)}`,path:input.packagePath,template:'connector',
      description:'Managed local echo connector for verifying source, Git, and MCP.',
    });
    await this.managed.materializePackage(record);
    return this.registerProject(record.id);
  }
  private synchronizeTransport(id:string,manifest:ConnectorTransport){
    const record=this.get(id);
    const transport=portableTransport(manifest);
    if(JSON.stringify(portableTransport(record))===JSON.stringify(transport))return record;
    if(record.auth)throw failure('The package changed its MCP destination or command. Remove the credential binding, review and register the new transport, then authorize it in Connections.',409);
    this.store.transaction(()=>this.store.connectors.updatePortableTransport(record.id,transport));
    return this.get(record.id);
  }
  async registerProject(id:string,name?:string){
    return this.exclusive(`package:${id}`,async()=>{
      const project=this.projects.get(id),value=await this.managed.readReleaseSource(id);
      if(!value.manifest.mcp)throw failure('The package manifest needs an mcp configuration.');
      const existing=this.list().find(item=>item.packageId===id||!item.packageId&&item.projectId===id);
      if(!existing&&!value.source.repositoryId)throw failure('Migrate this connector source into a registered repository before registering a new connection.',409);
      const connectionName=name??project.name;
      if(this.store.connectors.nameExists(connectionName,existing?.id))throw failure('That connection name is already registered',409);
      let connection:Connector;
      if(existing){this.synchronizeTransport(existing.id,value.manifest.mcp);connection=this.update(existing.id,{name:connectionName,description:project.description});}
      else connection=this.create({name:connectionName,description:project.description,projectId:id,...value.manifest.mcp});
      if(!connection.packageId&&value.source.repositoryId&&this.managed.packages?.store.package(id))this.store.transaction(()=>this.store.connectors.attachPackage(connection.id,id));
      return this.get(connection.id);
    });
  }
  private async resolve(id:string):Promise<ResolvedConnector>{
    let record=this.get(id);if(!record.enabled)throw failure('Enable this connection before using its tools.',409);
    let connector:ConnectorSnapshot,sourceCommit:string|null=null;
    const projectId=this.sourceProject(record);
    if(projectId&&this.projects.get(projectId).source){
      const value=await this.managed.readReleaseSource(projectId),mcp=value.manifest.mcp;
      if(!mcp)throw failure('The managed package no longer declares an MCP server.');
      record=this.synchronizeTransport(id,mcp);
      if(!record.enabled)throw failure('Enable this connection before using its tools.',409);
      if(mcp.transport==='stdio'){
        const release=await this.managed.prepareExport(projectId,value);
        connector=connectorSnapshotSchema.parse({id,name:record.name,transport:'stdio',command:mcp.command,args:mcp.args,cwd:release.releaseDirectory});
      }else{
        connector=connectorSnapshotSchema.parse({id,name:record.name,transport:'http',url:mcp.url});
      }
      sourceCommit=value.source.commit;
    }else{
      connector=connectorSnapshotSchema.parse({id,name:record.name,...(record.transport==='stdio'?{transport:'stdio',command:record.command,args:record.args??[],...(record.cwd?{cwd:record.cwd}:{})}:{transport:'http',url:record.url})});
    }
    if(record.auth){
      if(!this.vault)throw failure('Configure connection credentials in Connections.',409);
      await this.vault.ensure(record.auth,id);
      connector=connectorSnapshotSchema.parse({...connector,auth:record.auth,credentialRevision:this.vault.get(record.auth.credentialId).revision});
    }
    return {connector,sourceCommit,updatedAt:record.updatedAt};
  }
  private current(value:ResolvedConnector){
    const record=this.get(value.connector.id);
    let sameCredential=true;if(value.connector.auth)try{sameCredential=this.vault?.get(value.connector.auth.credentialId).revision===value.connector.credentialRevision;}catch{sameCredential=false;}
    return sameCredential&&record.enabled&&record.updatedAt===value.updatedAt&&(record.source?.commit??null)===value.sourceCommit;
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
  async snapshots(conversationId:string,ids?:string[]):Promise<ConnectorSnapshot[]>{
    const project=this.store.projects.forConversation(conversationId);const selected=ids??(project?this.store.connectors.assigned(project.id,true):[]);
    const snapshots:ResolvedConnector[]=[];for(const id of z.array(z.string().uuid()).max(20).parse(selected))snapshots.push(await this.resolve(id));
    if(snapshots.some(value=>!this.current(value)))throw failure('Project connections changed while preparing the task. Retry with the current configuration.',409);
    return snapshots.map(value=>value.connector);
  }
}
