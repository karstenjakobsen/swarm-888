import { z } from 'zod';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { WorkerClient } from '../ipc.ts';
import type { ProjectService } from '../projects/service.ts';
import { projectCreateInput, projectId } from '../projects/schemas.ts';
import { ManagedRepository } from './repository.ts';
import { RuntimeReceipts } from '../runtime-receipts.ts';
import {sourceCreateInput,sourceWriteInput,sourceCommitInput,managedPreparedResult,managedDeploymentResult,managedStatusResult,managedLogsResult,type ManagedExport} from './schemas.ts';

const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});

/** Source/Git belongs to the controller; builds and deployments belong to the worker. */
export class ManagedService {
  readonly repository:ManagedRepository;
  private sourceCreations=new Map<string,Promise<ManagedExport>>();
  private receipts:RuntimeReceipts;
  constructor(config:Config,private store:Store,private projects:ProjectService,client:WorkerClient,receipts?:RuntimeReceipts){this.repository=new ManagedRepository(config);this.receipts=receipts??new RuntimeReceipts(store.db,client,config.projectsDir??join(config.stateDir,'projects'));}
  async createProject(raw:unknown,conversationId?:string){
    const input=projectCreateInput.parse(raw);
    if(input.origin==='adopted'&&input.managed)throw fail('Register an existing project first, then add managed source explicitly.');
    const project=conversationId?this.projects.createForConversation(input,conversationId):this.projects.create(input);
    if(input.managed)await this.createSource(project.id,{kind:'project',template:input.template??'empty'});
    return this.projects.get(project.id);
  }
  private row(id:string){
    this.projects.get(id);
    return this.store.managed.source(id);
  }
  createSource(id:string,raw:unknown):Promise<ManagedExport>{
    projectId.parse(id);const input=sourceCreateInput.parse(raw);
    const operation=(this.sourceCreations.get(id)??Promise.resolve()).catch(()=>{}).then(()=>this.createSourceOnce(id,input));
    this.sourceCreations.set(id,operation);
    void operation.finally(()=>{if(this.sourceCreations.get(id)===operation)this.sourceCreations.delete(id);}).catch(()=>{});return operation;
  }
  private async createSourceOnce(id:string,input:z.infer<typeof sourceCreateInput>):Promise<ManagedExport>{
    const project=this.projects.get(id),existing=this.row(id);
    if(existing){if(existing.kind!==input.kind)throw fail('Managed source already exists with a different package kind.',409);return this.readSource(id);}
    const previous=await this.repository.source(input.kind,id);
    const value=previous.commit?await this.repository.export(input.kind,id):await this.repository.create({id,kind:input.kind,name:project.name,description:project.description,template:input.template});
    this.store.managed.saveSource(id,input.kind,value.source);return value;
  }
  async readSource(id:string):Promise<ManagedExport>{
    const row=this.row(id);if(!row)throw fail('This project has no managed source yet.',404);
    const value=await this.repository.export(row.kind,row.packageId);this.store.managed.saveSource(id,row.kind,value.source);return value;
  }
  async writeSource(id:string,raw:unknown){
    const input=sourceWriteInput.parse(raw),row=this.row(id);if(!row)throw fail('Add managed source before saving files.',409);
    const value=await this.repository.write(row.kind,row.packageId,input.files,input.removedFiles??[],{message:input.message,expectedCommit:input.expectedCommit});this.store.managed.saveSource(id,row.kind,value.source);return value;
  }
  async commitSource(id:string,raw:unknown={},runId?:string){
    const input=sourceCommitInput.parse(raw),row=this.row(id);if(!row)throw fail('This project has no managed source yet.',404);
    const source=await this.repository.commit(row.kind,row.packageId,input.message??'Save generated project changes',runId);this.store.managed.saveSource(id,row.kind,source);return source;
  }
  async executionDirectory(conversationId:string):Promise<string|undefined>{
    const project=this.store.projects.forConversation(conversationId);if(!project)return;
    const row=this.row(project.id);if(!row)return project.directory;
    const source=await this.repository.source(row.kind,row.packageId);this.store.managed.saveSource(project.id,row.kind,source);return source.workspacePath;
  }
  async finishRun(run:{id:string;conversationId:string;status:string}){
    if(!['completed','failed','interrupted'].includes(run.status))return;
    const project=this.store.projects.forConversation(run.conversationId);if(!project||!this.row(project.id))return;
    this.store.managed.beginFinalization(run.id,project.id);
    if(this.store.managed.finalizationCommitted(run.id))return;
    try{
      const source=await this.commitSource(project.id,{message:`Save generated changes from ${run.status} task ${run.id}`},run.id);
      if(!source.commit)throw new Error('Managed source did not produce a commit.');
      this.store.sourceFinalized(run.id,source.commit,source);
    }catch(error){
      this.store.managed.finalizationFailed(run.id,String((error as Error).message));throw error;
    }
  }
  async recoverSource(){
    for(const run of this.store.managed.pendingFinalizations())await this.finishRun(run);
  }
  private response<T>(schema:z.ZodType<T>,raw:unknown):T {
    const result=schema.safeParse(raw);if(!result.success)throw fail('The worker returned an invalid managed runtime response.',502);return result.data;
  }
  private verifyRelease(project:{id:string;directory:string},value:{commit?:string;releaseDirectory?:string;unitName?:string},expectedCommit?:string){
    if(value.unitName&&value.unitName!==`vps-ai-project-${project.id}.service`)throw fail('The worker returned an unexpected managed service unit.',502);
    const incomplete=Boolean(value.commit)!==Boolean(value.releaseDirectory);
    const wrongDirectory=value.commit&&value.releaseDirectory!==join(project.directory,'releases',value.commit);
    const wrongCommit=expectedCommit&&value.commit!==expectedCommit;
    if(incomplete||wrongDirectory||wrongCommit)throw fail('The worker returned an unexpected managed release revision or directory.',502);
  }
  async prepare(id:string){
    return this.prepareExport(id,await this.readSource(id));
  }
  async prepareExport(id:string,value:ManagedExport){
    const project=this.projects.get(id);
    if(!value.source.commit||value.source.dirty)throw fail('Commit source changes before preparing a release.',409);
    const prepared=this.response(managedPreparedResult,await this.receipts.request('managed/prepare',{project:{id,directory:project.directory},source:{commit:value.source.commit,path:value.source.path},manifest:value.manifest,files:value.files}));
    this.verifyRelease(project,prepared,value.source.commit);return prepared;
  }
  async deploy(id:string){
    const project=this.projects.get(id),value=await this.readSource(id);
    if(!value.source.commit||value.source.dirty)throw fail('Commit source changes before deploying.',409);
    if(!value.manifest.run)throw fail('The package manifest needs a run command before it can be deployed.');
    const environment=this.store.projects.environment(id);
    const deployed=this.response(managedDeploymentResult,await this.receipts.request('managed/deploy',{project:{id,directory:project.directory},source:{commit:value.source.commit,path:value.source.path},manifest:value.manifest,files:value.files,...(environment?{environment}:{})}));
    this.verifyRelease(project,deployed,value.source.commit);
    this.store.managed.saveDeployment(id,deployed);
    this.registerService(id,deployed.unitName);
    return deployed;
  }
  async refreshProject(id:string){
    await this.projects.refresh(id);
    if(this.projects.get(id).source)await this.deploymentAction(id,'status');
    return this.projects.get(id);
  }
  private registerService(id:string,unitName?:string){
    if(unitName){
      const name='Managed service',existing=this.projects.get(id).components.find(component=>component.name===name);
      if(existing&&existing.unitName!==unitName)this.projects.updateComponent(id,existing.id,{kind:'service',unitName});
      else if(!existing)this.projects.addComponent(id,{name,kind:'service',unitName});
    }
  }
  async deploymentAction(id:string,action:'status'|'stop'|'logs'){
    const project=this.projects.get(id);if(!project.source&&!project.deployment)throw fail('This project has no managed source or deployment.',404);
    const raw=await this.receipts.request(`managed/${action}`,{project:{id,directory:project.directory}});
    if(action==='logs')return this.response(managedLogsResult,raw);
    const value=this.response(managedStatusResult,raw);this.verifyRelease(project,value);
    const observed={...project.deployment,...value};
    if(observed.commit&&observed.releaseDirectory){
      this.store.managed.saveDeployment(id,this.response(managedDeploymentResult,observed));
      this.registerService(id,observed.unitName);
    }
    return value;
  }
}
