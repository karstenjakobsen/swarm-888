import { z } from 'zod';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { lstatSync, readFileSync } from 'node:fs';
import type { Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { WorkerClient } from '../ipc.ts';
import type { ProjectService } from '../projects/service.ts';
import { projectCreateInput, projectId } from '../projects/schemas.ts';
import { ManagedRepository,scaffold } from './repository.ts';
import { PackageService } from '../packages/service.ts';
import { packageManifestMaxBytes,packageManifestSchema,type PackageRecord } from '../packages/schemas.ts';
import { acquireRepository,assertRepositoryWritable } from '../packages/leases.ts';
import { createGitSnapshot } from './snapshot.ts';
import { RuntimeReceipts } from '../runtime-receipts.ts';
import {sourceCreateInput,sourceWriteInput,sourceCommitInput,managedPreparedResult,managedDeploymentResult,managedStatusResult,managedLogsResult,type ManagedExport} from './schemas.ts';

const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
type ReleaseSource=Pick<ManagedExport,'source'|'manifest'>&{files?:ManagedExport['files']};

/** Source/Git belongs to the controller; builds and deployments belong to the worker. */
export class ManagedService {
  readonly repository:ManagedRepository;
  readonly packages:PackageService;
  private sourceCreations=new Map<string,Promise<ManagedExport>>();
  private connectorNames=new Map<string,Promise<unknown>>();
  private connectorNameContext=new AsyncLocalStorage<string>();
  private receipts:RuntimeReceipts;
  constructor(private config:Config,private store:Store,private projects:ProjectService,client:WorkerClient,receipts?:RuntimeReceipts){
    this.repository=new ManagedRepository(config);this.packages=new PackageService(config,store.db);
    this.packages.setWriteGuard((repositoryId,runId)=>{
      assertRepositoryWritable(store.db,repositoryId,runId);
      if(!runId)return;
      const run=store.run(runId);
      if(!run||(!['running','waiting'].includes(run.status)&&!store.managed.hasPendingFinalization(runId)))throw fail('Package changes require an active task or its pending source finalization.',409);
      acquireRepository(store.db,repositoryId,runId);
    });
    this.packages.setWriteScope((repositoryId,runId)=>store.managed.writablePackagePaths(repositoryId,runId));
    this.packages.setImportGuard(manifest=>{
      if(store.managed.ownsLegacyId(manifest.id))throw fail('This package ID already belongs to a legacy registration. Migrate its source explicitly or assign the independent package a new UUID.',409);
    });
    this.receipts=receipts??new RuntimeReceipts(store.db,client,config.projectsDir??join(config.stateDir,'projects'));
  }
  async createProject(raw:unknown,conversationId?:string){
    const input=projectCreateInput.parse(raw);
    if(!input.repositoryId||!input.packagePath)throw fail('Select a registered repository and package folder. Register its remote URL in Repositories first.');
    this.packages.repository(input.repositoryId);
    const project=conversationId?this.projects.createForConversation(input,conversationId):this.projects.create(input);
    try{await this.createSource(project.id,{kind:'project',template:input.template??'empty',repositoryId:input.repositoryId,packagePath:input.packagePath});}
    catch(error){if(!this.row(project.id))this.store.projects.discardUninitialized(project.id);throw error;}
    return this.projects.get(project.id);
  }
  async updateProject(id:string,raw:unknown,runId?:string){
    const input=this.projects.validateUpdate(id,raw),row=this.row(id);
    const name=row?.kind==='connector'&&(input.name!==undefined||input.description!==undefined)?input.name??this.projects.get(id).name:undefined;
    return this.withConnectorName(name,async()=>{
      const current=this.projects.get(id);
      if((input.name!==undefined&&input.name!==current.name)||(input.description!==undefined&&input.description!==current.description)){
        const row=this.row(id);
        if(!row)throw fail('Adopt this project into a registered repository package before changing its name or description.',409);
        if(!row.source.repositoryId)throw fail('Migrate this project source into a registered repository before changing its name or description.',409);
        this.trackProject(id,runId);
        const value=await this.readReleaseSource(id);
        if(value.source.dirty)throw fail('Commit or resolve pending source changes before updating project details.',409);
        const manifest=packageManifestSchema.parse({...value.manifest,name:input.name??value.manifest.name,description:input.description??value.manifest.description});
        if(row.kind==='connector'&&manifest.name!==name)throw fail('Connection source changed while updating its details. Retry with the current package.',409);
        this.assertPackageMetadata(manifest);
        const record=await this.packages.writeTextFiles(row.packageId,{'operator-package.json':JSON.stringify(manifest,null,2)+'\n'},[],{
          message:'Update project details',expectedCommit:value.source.commit,runId,
        });
        this.synchronizePackageMetadata(record);
        this.store.managed.saveSource(id,row.kind,this.packages.source(row.packageId),row.packageId);
      }
      return this.projects.update(id,input);
    });
  }
  /** Connection names are global even when their source repositories are independent. */
  async withConnectorName<T>(name:string|undefined,operation:()=>T|Promise<T>):Promise<T>{
    const held=this.connectorNameContext.getStore();
    if(!name||held===name)return operation();
    if(held)throw fail('Connection source changed while updating its details. Retry with the current package.',409);
    const pending=(this.connectorNames.get(name)??Promise.resolve()).catch(()=>{}).then(()=>this.connectorNameContext.run(name,operation));
    this.connectorNames.set(name,pending);
    try{return await pending;}finally{if(this.connectorNames.get(name)===pending)this.connectorNames.delete(name);}
  }
  private row(id:string){
    this.projects.get(id);
    return this.store.managed.source(id);
  }
  private assertPackageMetadata(value:Pick<PackageRecord,'id'|'kind'|'name'>){
    if(value.kind==='connector')this.store.connectors.assertPackageName(value.id,value.name);
  }
  private metadataDocument(text:string){
    let document:unknown;try{document=JSON.parse(text);}catch{throw fail('Package manifest must contain valid JSON.',400);}
    return packageManifestSchema.parse(document);
  }
  private synchronizePackageMetadata(record:PackageRecord){
    this.store.transaction(()=>{
      if(record.kind==='connector')this.store.connectors.syncPackageDetails(record.id,record);
      const project=this.store.projects.forPackage(record.id);
      if(project)this.projects.update(project.id,{name:record.name,description:record.description});
    });
  }
  private assertWorkspaceMetadata(packageId:string){
    const record=this.packages.package(packageId);if(record.kind!=='connector')return;
    const path=join(this.packages.source(packageId).workspacePath,'operator-package.json'),info=lstatSync(path);
    if(!info.isFile()||info.nlink!==1||info.size>packageManifestMaxBytes)throw fail('Package manifest must be a regular file of at most 64 KB.',409);
    const manifest=this.metadataDocument(readFileSync(path,'utf8'));
    if(manifest.id!==record.id||manifest.kind!==record.kind)throw fail('Package manifest identity cannot change.',409);
    this.assertPackageMetadata(manifest);
    return manifest;
  }
  createSource(id:string,raw:unknown):Promise<ManagedExport>{
    projectId.parse(id);const input=sourceCreateInput.parse(raw);
    const operation=(this.sourceCreations.get(id)??Promise.resolve()).catch(()=>{}).then(()=>this.createSourceOnce(id,input));
    this.sourceCreations.set(id,operation);
    void operation.finally(()=>{if(this.sourceCreations.get(id)===operation)this.sourceCreations.delete(id);}).catch(()=>{});return operation;
  }
  private async createSourceOnce(id:string,input:z.infer<typeof sourceCreateInput>):Promise<ManagedExport>{
    const project=this.projects.get(id),existing=this.row(id);
    if(existing){
      if(existing.kind!==input.kind)throw fail('Managed source already exists with a different package kind.',409);
      if(input.repositoryId&&!existing.source.repositoryId)return this.migrateSource(id,input);
      if((input.repositoryId&&input.repositoryId!==existing.source.repositoryId)||(input.packagePath&&input.packagePath!==existing.source.path))throw fail('This package already belongs to another repository folder. Import a committed canonical move instead of rebinding it.',409);
      return this.readSource(id);
    }
    if(!input.repositoryId||!input.packagePath)throw fail('A repository and package folder are required for all new source packages.');
    const recovered=this.packages.store.package(id);
    if(recovered){if(recovered.kind!==input.kind||recovered.repositoryId!==input.repositoryId||recovered.path!==input.packagePath)throw fail('The canonical package ID already belongs to another source location.',409);const value=await this.packageExport(id);this.store.managed.saveSource(id,input.kind,value.source);return value;}
    const initial=scaffold({id,kind:input.kind,name:project.name,description:project.description,template:input.template});
    const manifest=packageManifestSchema.parse({...initial.manifest,version:'0.1.0'});
    await this.packages.createPackage(input.repositoryId,{path:input.packagePath,manifest,files:initial.files});
    const value=await this.packageExport(id);
    this.store.managed.saveSource(id,input.kind,value.source);return value;
  }
  async migrateSource(id:string,input:{repositoryId?:string;packagePath?:string}){
    const row=this.row(id);if(!row)throw fail('This project has no legacy source to migrate.',404);
    if(!input.repositoryId||!input.packagePath)throw fail('Choose the destination repository and package folder.');
    if(row.source.repositoryId){
      if(row.source.repositoryId===input.repositoryId&&row.source.path===input.packagePath)return this.readSource(id);
      throw fail('This package already belongs to another registered repository folder.',409);
    }
    const old=await this.repository.export(row.kind,row.packageId);
    if(old.source.dirty)throw fail('Commit or resolve legacy source changes before migrating.',409);
    const manifest=packageManifestSchema.parse({...old.manifest,version:old.manifest.version??'0.1.0'});
    const files:Record<string,string>={...old.files,'operator-package.json':JSON.stringify(manifest,null,2)+'\n'};
    const existing=this.packages.store.package(row.packageId);
    if(existing&&(existing.repositoryId!==input.repositoryId||existing.path!==input.packagePath||existing.kind!==row.kind))throw fail('This package UUID already belongs to another source location.',409);
    if(!existing){
      // Creating a root package normally preserves the repository README. A migration must preserve the legacy README itself.
      if(input.packagePath==='.'&&files['README.md']!==undefined){
        const readme=join(this.packages.repository(input.repositoryId).directory,'README.md');
        const expected=files['README.md'];
        try{const stat=lstatSync(readme);if(!stat.isFile()||stat.size!==Buffer.byteLength(expected)||readFileSync(readme,'utf8')!==expected)throw fail('The repository README differs from this package. Choose a new folder to preserve both files.',409);}
        catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      }
      await this.packages.createPackage(input.repositoryId,{path:input.packagePath,manifest,files});
    }
    const value=await this.packageExport(row.packageId);
    if(value.source.dirty||value.source.workspaceDiverged||Object.entries(files).some(([path,content])=>value.files[path]!==content)){
      throw fail('The destination differs from the committed legacy package. Review the destination before completing migration.',409);
    }
    this.store.managed.saveSource(id,row.kind,value.source,row.packageId);
    return value;
  }
  async materializePackage(record:PackageRecord){
    if(record.kind==='skill')return;
    return this.withConnectorName(record.kind==='connector'?record.name:undefined,()=>{
      const source=this.packages.source(record.id);
      if(source.commit!==record.lastImportedCommit||source.path!==record.path)throw fail('A newer package revision was imported during registration. Import the current revision again to refresh runtime metadata.',409);
      const prior=this.store.managed.source(record.id);
      if(prior&&!prior.source.repositoryId)throw fail('Migrate the existing legacy source explicitly before attaching this package.',409);
      this.assertPackageMetadata(record);
      const project=this.projects.materializePackage(record);
      this.store.managed.saveSource(project.id,record.kind,source,record.id);
      this.synchronizePackageMetadata(record);return this.projects.get(project.id);
    });
  }
  async createPackage(repositoryId:string,input:{path:string;kind:'project'|'connector'|'skill';name:string;description?:string;version?:string;template?:'service'|'connector'|'empty';adopt?:boolean;mcp?:ManagedExport['manifest']['mcp'];run?:ManagedExport['manifest']['run']}){
    const initial=scaffold({id:randomUUID(),kind:input.kind,name:input.name,description:input.description??'',template:input.template??(input.kind==='connector'?'connector':'empty')});
    const manifest=packageManifestSchema.parse({...initial.manifest,version:input.version??'0.1.0',...(input.mcp?{mcp:input.mcp}:{}),...(input.run?{run:input.run}:{})});
    if(input.kind==='skill')initial.files['SKILL.md']=`---\nname: ${input.name}\ndescription: ${input.description||input.name}\n---\n\n# ${input.name}\n\nDescribe when and how this skill should be used.\n`;
    const record=input.adopt?await this.packages.adoptPackage(repositoryId,{path:input.path,manifest}):await this.packages.createPackage(repositoryId,{path:input.path,manifest,files:initial.files});
    return record;
  }
  async packageExport(packageId:string):Promise<ManagedExport>{
    const revision=this.packageRevision(packageId);
    return {...revision,files:this.packages.readTextFiles(packageId,revision.source.commit??undefined)};
  }
  private packageRevision(packageId:string) {
    const source=this.packages.source(packageId);
    return {source,manifest:this.packages.manifest(packageId,source.commit??undefined)};
  }
  /** Registered releases use Git objects and need no editor preview. */
  async readReleaseSource(id:string):Promise<ReleaseSource> {
    const row=this.row(id);
    if(!row)throw fail('This project has no managed source yet.',404);
    const revision=row.source.repositoryId?this.packageRevision(row.packageId):await this.repository.export(row.kind,row.packageId);
    this.store.managed.saveSource(id,row.kind,revision.source,row.packageId);
    return revision;
  }
  async readSource(id:string):Promise<ManagedExport>{
    const row=this.row(id);if(!row)throw fail('This project has no managed source yet.',404);
    const value=row.source.repositoryId?await this.packageExport(row.packageId):await this.repository.export(row.kind,row.packageId);this.store.managed.saveSource(id,row.kind,value.source,row.packageId);return value;
  }
  async writeSource(id:string,raw:unknown){
    const input=sourceWriteInput.parse(raw),row=this.row(id);if(!row)throw fail('Add managed source before saving files.',409);
    if(!row.source.repositoryId)throw fail('Migrate this legacy package to a registered repository before editing source.',409);
    const manifest=Object.hasOwn(input.files,'operator-package.json')?this.metadataDocument(input.files['operator-package.json']):this.assertWorkspaceMetadata(row.packageId);
    return this.withConnectorName(row.kind==='connector'?manifest?.name:undefined,async()=>{
      if(manifest)this.assertPackageMetadata(manifest);
      if(!Object.hasOwn(input.files,'operator-package.json')&&this.assertWorkspaceMetadata(row.packageId)?.name!==manifest?.name)throw fail('Connection source changed while updating its details. Retry with the current package.',409);
      const record=await this.packages.writeTextFiles(row.packageId,input.files,input.removedFiles??[],{message:input.message,expectedCommit:input.expectedCommit,createOnly:input.createOnly});
      this.synchronizePackageMetadata(record);
      const value=await this.packageExport(row.packageId);this.store.managed.saveSource(id,row.kind,value.source,row.packageId);return value;
    });
  }
  private async commitPackage(packageId:string,message:string,runId?:string){
    const manifest=this.assertWorkspaceMetadata(packageId);
    return this.withConnectorName(manifest?.name,async()=>{
      if(this.assertWorkspaceMetadata(packageId)?.name!==manifest?.name)throw fail('Connection source changed while updating its details. Retry with the current package.',409);
      const source=await this.packages.commit(packageId,message,runId);
      this.synchronizePackageMetadata(this.packages.package(packageId));return source;
    });
  }
  async commitSource(id:string,raw:unknown={},runId?:string){
    const input=sourceCommitInput.parse(raw),row=this.row(id);if(!row)throw fail('This project has no managed source yet.',404);
    const source=row.source.repositoryId?await this.commitPackage(row.packageId,input.message??'Save project changes',runId):await this.repository.commit(row.kind,row.packageId,input.message??'Save generated project changes',runId);
    this.store.managed.saveSource(id,row.kind,source,row.packageId);return source;
  }
  async executionDirectory(conversationId:string):Promise<string|undefined>{
    const project=this.store.projects.forConversation(conversationId);if(!project)return;
    const row=this.row(project.id);if(!row)return project.directory;
    if(!row.source.repositoryId)throw fail('Migrate this legacy package to a registered repository before starting new coding tasks.',409);
    const source=this.packages.source(row.packageId);
    if(source.workspaceDiverged)throw fail('Import the committed changes in this package before starting a task in its workspace.',409);
    this.store.managed.saveSource(project.id,row.kind,source,row.packageId);
    return source.workspacePath;
  }
  async finishRun(run:{id:string;conversationId:string;status:string}){
    if(!['completed','failed','interrupted'].includes(run.status))return;
    const project=this.store.projects.forConversation(run.conversationId);
    if(project&&this.row(project.id)){
      this.store.managed.beginFinalization(run.id,project.id);
      if(!this.store.managed.finalizationCommitted(run.id))try{
        const source=await this.commitSource(project.id,{message:`Save generated changes from ${run.status} task ${run.id}`},run.id);
        if(!source.commit)throw new Error('Managed source did not produce a commit.');
        this.store.sourceFinalized(run.id,source.commit,source);
      }catch(error){this.store.managed.finalizationFailed(run.id,String((error as Error).message));throw error;}
    }
    for(const {packageId} of this.store.managed.pendingPackages(run.id)){
      const record=this.packages.store.package(packageId);
      if(!record){this.store.transaction(()=>{this.store.managed.packageFinalized(run.id,packageId,null);this.store.releaseProject(run.id);});continue;}
      try{
        const source=await this.commitPackage(packageId,`Save package changes from ${run.status} task ${run.id}`,run.id);
        this.store.transaction(()=>{
          this.store.managed.refreshPackageSource(packageId,source);
          this.store.managed.packageFinalized(run.id,packageId,source.commit);
          this.store.releaseProject(run.id);
        });
        this.store.addEvent('checkpoint',{summary:`Package source committed at ${source.commit?.slice(0,12)}.`,source},run.id);
      }catch(error){this.store.managed.packageFinalizationFailed(run.id,packageId,String((error as Error).message));throw error;}
    }
    this.store.releaseProject(run.id);
  }
  trackPackage(packageId:string,runId?:string,repositoryId?:string){
    if(!runId)return;const run=this.store.run(runId);if(!run||!['running','waiting'].includes(run.status))throw fail('Package authoring requires an active task.',409);
    const record=this.packages.store.package(packageId),repository=record?.repositoryId??repositoryId;
    if(record&&this.packages.source(packageId).workspaceDiverged)throw fail('Import the committed changes in this package before authoring source.',409);
    this.store.transaction(()=>{if(repository)acquireRepository(this.store.db,repository,runId);this.store.managed.trackPackage(runId,packageId);});
  }
  trackProject(id:string,runId?:string,repositoryId?:string){
    const row=this.store.managed.source(id);this.trackPackage(row?.packageId??id,runId,repositoryId);
  }
  async recoverSource(){
    const errors:string[]=[];
    for(const run of this.store.managed.pendingFinalizations())try{await this.finishRun(run);}catch(error){errors.push(`${run.id}: ${(error as Error).message}`);}
    if(errors.length)throw fail(`Source recovery needs attention: ${errors.join('; ')}`,409);
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
    return this.prepareExport(id,await this.readReleaseSource(id));
  }
  private releaseInput(value:ReleaseSource){
    const {source,manifest}=value;
    if(!source.commit||source.dirty)throw fail('Commit source changes before preparing a release.',409);
    const content=source.repositoryId?{snapshot:createGitSnapshot(this.config,source.repositoryPath,source.commit,source.path)}:{files:value.files};
    return {source:{commit:source.commit,path:source.path},manifest,...content};
  }
  async prepareExport(id:string,value:ReleaseSource){
    const project=this.projects.get(id);
    const input=this.releaseInput(value);
    const prepared=this.response(managedPreparedResult,await this.receipts.request('managed/prepare',{project:{id,directory:project.directory},...input}));
    this.verifyRelease(project,prepared,input.source.commit);return prepared;
  }
  async deploy(id:string){
    const project=this.projects.get(id),value=await this.readReleaseSource(id);
    if(!value.manifest.run)throw fail('The package manifest needs a run command before it can be deployed.');
    const environment=this.store.projects.environment(id);
    const input=this.releaseInput(value);
    const deployed=this.response(managedDeploymentResult,await this.receipts.request('managed/deploy',{project:{id,directory:project.directory},...input,...(environment?{environment}:{})}));
    this.verifyRelease(project,deployed,input.source.commit);
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
