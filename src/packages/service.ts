import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import { closeSync, constants, fstatSync, openSync, readSync, renameSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { dirname, join, resolve } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import type { Config } from '../config.ts';
import { managedFilePath } from '../managed/repository.ts';
import type { ManagedSource } from '../managed/schemas.ts';
import { PackageStore } from './store.ts';
import { packageImportInput, packageManifestMaxBytes, packageManifestSchema, packagePath, repositoryInput, type PackageDiscovery, type PackageManifest, type PackageRecord, type RepositoryRecord } from './schemas.ts';

const manifestFile='operator-package.json',failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
const textLimit=8_000_000;
const runGitAsync=promisify(execFile);
function gitOptions(directory:string,args:string[]){
  const env:NodeJS.ProcessEnv={...process.env};
  for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'});
  if(args[0]!=='check-ignore')env.GIT_LITERAL_PATHSPECS='1';
  const argv=['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','core.quotePath=false','-c','status.renames=false','-c','protocol.ext.allow=never','-c','credential.helper=','-c','core.askPass=','-C',directory,...args];
  return {argv,options:{env,timeout:60_000,maxBuffer:32_000_000}};
}
function gitError(error:unknown){
  const detail=(error as {stderr?:Buffer|string}).stderr?.toString().trim().slice(0,1000);
  return failure(`Package Git operation failed${detail?`: ${detail}`:''}`);
}
interface TreeEntry {mode:string;sha:string;path:string}
type Source=ManagedSource&{repositoryId:string;packageId:string;workspaceDiverged?:boolean};
function validateSkillInstructions(text:string,name:string):void {
  const frontmatter=/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]+)/.exec(text);
  if(!frontmatter)throw failure('SKILL.md requires frontmatter and instructions',400);
  const declared=/^name:\s*(.+?)\s*$/m.exec(frontmatter[1])?.[1].replace(/^['"]|['"]$/g,'');
  if(declared!==name)throw failure('SKILL.md name must match the package manifest name',400);
}
function overlappingFolders(left:string,right:string):boolean {
  return left==='.' || right==='.' || left===right || left.startsWith(right+'/') || right.startsWith(left+'/');
}
function sourceFilePath(name:string):string {managedFilePath(name.split('/').map(piece=>piece==='.env.example'?'env.example':piece).join('/'));return name;}

/** Repository-backed package source. Discovery reads Git objects and never executes package code. */
export class PackageService {
  readonly store:PackageStore;
  private queues=new Map<string,Promise<unknown>>();
  private runContext=new AsyncLocalStorage<string>();
  private guard?:(repositoryId:string,runId?:string)=>void;
  private importGuard?:(manifest:PackageManifest)=>void;
  private writeScope?:(repositoryId:string,runId:string)=>string[];
  private secretGuard?:(value:unknown)=>void;
  constructor(private config:Config,db:DatabaseSync){this.store=new PackageStore(db);this.store.recoverImports();}
  setImportGuard(guard:(manifest:PackageManifest)=>void):void{this.importGuard=guard;}
  setWriteGuard(guard:(repositoryId:string,runId?:string)=>void):void{this.guard=guard;}
  setWriteScope(scope:(repositoryId:string,runId:string)=>string[]):void{this.writeScope=scope;}
  setSecretGuard(guard:(value:unknown)=>void):void{this.secretGuard=guard;}
  withRun<T>(runId:string,operation:()=>T):T{return this.runContext.run(runId,operation);}
  private assertWritable(id:string,runId?:string):void{this.guard?.(id,runId??this.runContext.getStore());}
  listRepositories():RepositoryRecord[]{return this.store.repositories().map(repository=>this.observeRepository(repository));}
  private registeredRepository(id:string):RepositoryRecord {
    const repository=this.store.repository(id);
    if(!repository)throw failure('Repository not found',404);
    return repository;
  }
  repository(id:string):RepositoryRecord {return this.observeRepository(this.registeredRepository(id));}
  private checkedRepository(id:string):RepositoryRecord {
    const repository=this.registeredRepository(id);
    this.checkRepository(repository);
    return repository;
  }
  private observeRepository(repository:RepositoryRecord):RepositoryRecord {
    try{
      this.checkRepository(repository);const head=this.head(repository),dirty=Boolean(this.git(repository.directory,['status','--porcelain=v1','--untracked-files=all'])),remoteRef=`refs/remotes/origin/${repository.sourceBranch}`,hasRemoteBranch=Boolean(this.git(repository.directory,['show-ref','--verify',remoteRef],true));
      let ahead=0,behind=0;if(hasRemoteBranch){const counts=this.git(repository.directory,['rev-list','--left-right','--count',`HEAD...${remoteRef}`]).trim().split(/\s+/).map(Number);ahead=counts[0];behind=counts[1];}
      return {...repository,status:'ready',error:null,head,dirty,ahead,behind,hasRemoteBranch,localOnly:!hasRemoteBranch||ahead>0};
    }catch(error){return {...repository,status:'error',error:error instanceof Error?error.message:'Repository is unavailable',head:null};}
  }
  listPackages(repositoryId?:string):PackageRecord[]{return this.store.packages(repositoryId);}
  package(id:string):PackageRecord {const value=this.store.package(id);if(!value)throw failure('Package not found',404);return value;}
  imports(packageId?:string,repositoryId?:string){return this.store.imports(packageId,repositoryId);}
  repositoryImports(id:string){this.registeredRepository(id);return this.imports(undefined,id);}
  private git(directory:string,args:string[],allowFailure=false):string {
    const {argv,options}=gitOptions(directory,args);
    try{return execFileSync('git',argv,{...options,encoding:'utf8',stdio:['ignore','pipe','pipe']});}
    catch(error){
      if(allowFailure&&(args[0]!=='check-ignore'||(error as {status?:number}).status===1))return '';
      throw gitError(error);
    }
  }
  private async remoteGit(directory:string,args:string[]):Promise<void>{
    const {argv,options}=gitOptions(directory,args);
    try{
      const operation=runGitAsync('git',argv,options);
      operation.child.stdin?.end();
      await operation;
    }catch(error){throw gitError(error);}
  }
  private object(repository:RepositoryRecord,spec:string):Buffer {
    const {argv,options}=gitOptions(repository.directory,['cat-file','blob',spec]);
    try{return execFileSync('git',argv,{...options,timeout:15_000,stdio:['ignore','pipe','pipe']});}
    catch{throw failure('Package Git object could not be read');}
  }
  private root():string {
    const root=resolve(this.config.projectsDir??join(this.config.stateDir,'projects'),'repositories');mkdirSync(root,{recursive:true,mode:0o700});
    if(realpathSync(root)!==root||lstatSync(root).uid!==this.config.controllerUid)throw failure('Repository root must be a canonical directory owned by the controller');return root;
  }
  private checkRepository(repository:RepositoryRecord):void {
    const expected=join(this.root(),repository.id);
    if(repository.directory!==expected||!existsSync(expected)||realpathSync(expected)!==expected||lstatSync(expected).uid!==this.config.controllerUid)throw failure('Registered repository directory is unavailable or its ownership/path changed');
    const metadata=join(expected,'.git');if(!existsSync(metadata)||!lstatSync(metadata).isDirectory()||lstatSync(metadata).isSymbolicLink()||realpathSync(metadata)!==metadata)throw failure('Repository Git metadata must remain a real directory');
    if(resolve(this.git(expected,['rev-parse','--show-toplevel']).trim())!==expected)throw failure('Registered source must remain a Git checkout root');
    if(this.git(expected,['symbolic-ref','--short','HEAD']).trim()!==repository.branch)throw failure('Repository is on another branch; return to its registered operator branch first');
    if(this.git(expected,['ls-files','--unmerged','-z']))throw failure('Resolve repository merge conflicts before using package source');
    if(this.git(expected,['remote','get-url','origin']).trim()!==repository.remoteUrl)throw failure('Repository origin differs from its registered remote URL');
  }
  private async exclusive<T>(id:string,operation:()=>T|Promise<T>):Promise<T>{
    const previous=this.queues.get(id)??Promise.resolve();const next=previous.catch(()=>{}).then(async()=>{
      if(process.getuid?.()!==this.config.controllerUid)throw failure('Repository operations must run as the controller owner',403);
      const lockRoot=join(this.config.stateDir,'workspaces');mkdirSync(lockRoot,{recursive:true,mode:0o700});
      if(realpathSync(lockRoot)!==lockRoot)throw failure('Repository lock directory must be canonical');
      const lock=join(lockRoot,`repository-${id}.lock`);try{mkdirSync(lock,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw failure('Repository is busy; reconcile its previous controller operation before removing its lock');throw error;}
      try{return await operation();}finally{rmSync(lock,{recursive:true,force:true});}
    });this.queues.set(id,next);try{return await next;}finally{if(this.queues.get(id)===next)this.queues.delete(id);}
  }
  async register(input:unknown):Promise<RepositoryRecord>{
    const value=repositoryInput.parse(input),id=randomUUID();return this.exclusive(id,async()=>{
      const directory=join(this.root(),id),now=new Date().toISOString();let initialized=false,sourceBranch=value.branch??'main';
      try{
        if(value.mode==='create'){
          mkdirSync(directory,{mode:0o700});this.git(directory,['init','-q','-b',sourceBranch]);this.git(directory,['remote','add','origin',value.remoteUrl]);
          writeFileSync(join(directory,'.gitignore'),'node_modules/\ndist/\nbuild/\ncoverage/\n.env\n.env.*\n!.env.example\n*.log\n',{mode:0o600});
          writeFileSync(join(directory,'README.md'),`# ${value.name}\n\nPackages managed locally by the operator. Remote pushes are disabled.\n`,{mode:0o600});
          this.git(directory,['add','--','.gitignore','README.md']);this.git(directory,['-c','user.name=AI Operator','-c','user.email=operator@localhost','commit','-qm','Initialize package repository']);
        }else{
          await this.remoteGit(dirname(directory),['clone','--quiet','--no-local','--no-hardlinks','--no-checkout','--single-branch',...(value.branch?['--branch',value.branch]:[]),'--',value.remoteUrl,directory]);
          sourceBranch=this.git(directory,['symbolic-ref','--short','HEAD']).trim();
        }
        const branch=sourceBranch==='operator/work'?'operator/packages':'operator/work';this.git(directory,['checkout','-q','-b',branch]);
        const exclude=join(directory,'.git','info','exclude');writeFileSync(exclude,`${existsSync(exclude)?readFileSync(exclude,'utf8'):''}\n**/.agents/\n`,{mode:0o600});
        const repository:RepositoryRecord={id,name:value.name,remoteUrl:value.remoteUrl,directory,branch,sourceBranch,status:'ready',error:null,createdAt:now,updatedAt:now};
        this.store.saveRepository(repository);initialized=true;return this.observeRepository(repository);
      }finally{if(!initialized)rmSync(directory,{recursive:true,force:true});}
    });
  }
  private assertDisjoint(repositoryId:string,path:string,id:string):void {
    const conflict=this.store.packages(repositoryId).find(other=>other.id!==id && overlappingFolders(path,other.path));
    if(conflict)throw failure(`Package folder overlaps registered package ${conflict.name} at ${conflict.path}. Each package needs its own folder.`);
  }
  private head(repository:RepositoryRecord):string{return this.git(repository.directory,['rev-parse','HEAD']).trim();}
  private tree(repository:RepositoryRecord,commit:string):TreeEntry[]{
    if(!/^[a-f0-9]{40,64}$/.test(commit))throw failure('Invalid package revision',400);
    const entries=this.git(repository.directory,['ls-tree','-r','-z','--full-tree',commit]).split('\0').filter(Boolean).map(value=>{const match=/^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(value);if(!match)throw failure('Unsupported Git tree entry');return {mode:match[1],sha:match[2],path:match[3]};});
    if(entries.length>50_000)throw failure('Repository discovery is limited to 50,000 tracked files',400);return entries;
  }
  private manifestDocument(repository:RepositoryRecord,path:string,commit:string):unknown {
    const data=this.object(repository,`${commit}:${path==='.'?'':path+'/'}${manifestFile}`);
    if(data.length>packageManifestMaxBytes)throw failure('Package manifest must be at most 64 KB',400);
    const body=data.toString('utf8');
    if(!Buffer.from(body).equals(data))throw failure('Package manifest must contain valid UTF-8',400);
    return this.parseManifestDocument(body);
  }
  private parseManifestDocument(body:string):unknown {
    this.assertNoSecrets(body);
    let raw:unknown;
    try{raw=JSON.parse(body);}catch{throw failure('Package manifest must contain valid JSON',400);}
    // Scan decoded strings too, before schema errors or import metadata can expose any values.
    this.assertNoSecrets(raw);
    return raw;
  }
  private manifestAt(repository:RepositoryRecord,path:string,commit:string):PackageManifest {
    return packageManifestSchema.parse(this.manifestDocument(repository,path,commit));
  }
  private safeDetail(error:unknown,fallback:string):string {
    const message=error instanceof Error?error.message:fallback;
    try{this.assertNoSecrets(message);return message;}catch{return fallback;}
  }
  private discoverAt(repository:RepositoryRecord,commit:string):PackageDiscovery {
    const entries=this.tree(repository,commit),result:PackageDiscovery={repository,commit,packages:[],errors:[]};
    const manifestEntries=entries.filter(entry=>entry.path===manifestFile||entry.path.endsWith(`/${manifestFile}`));
    if(manifestEntries.length>200)throw failure('At most 200 package manifests can be discovered in one repository',400);
    for(const entry of manifestEntries){
      const path=entry.path===manifestFile?'.':entry.path.slice(0,-manifestFile.length-1);
      try{this.assertNoSecrets(path);}catch{
        result.errors.push('A manifest folder contains a known credential. Rename the folder before importing it.');
        continue;
      }
      try{
      packagePath(path);if(entry.mode!=='100644'&&entry.mode!=='100755')throw failure('Package manifests must be regular files');
      const manifest=this.manifestAt(repository,path,commit),prior=this.store.package(manifest.id);result.packages.push({path,manifest,imported:Boolean(prior&&prior.repositoryId===repository.id&&prior.path===path)});
    }catch(error){result.packages.push({path,error:this.safeDetail(error,'Package manifest could not be safely displayed')});}}
    const counts=new Map<string,number>();for(const item of result.packages)if(item.manifest)counts.set(item.manifest.id,(counts.get(item.manifest.id)??0)+1);
    for(const item of result.packages)if(item.manifest&&(counts.get(item.manifest.id)??0)>1)item.error='Duplicate canonical package identifier appears in this repository';return result;
  }
  async discover(id:string,options:{refresh?:boolean}={}):Promise<PackageDiscovery>{return this.exclusive(id,async()=>{
    const repository=this.checkedRepository(id);let commit=this.head(repository);
    if(options.refresh){this.assertWritable(id);await this.remoteGit(repository.directory,['fetch','--no-tags','--no-recurse-submodules','origin',repository.sourceBranch]);commit=this.git(repository.directory,['rev-parse','FETCH_HEAD']).trim();}
    return this.discoverAt(repository,commit);
  });}
  private validatePackage(repository:RepositoryRecord,path:string,commit:string,manifest:PackageManifest):void {
    const prefix=path==='.'?'':`${path}/`,entries=this.tree(repository,commit).filter(entry=>entry.path.startsWith(prefix));let skill=false;
    for(const entry of entries){const name=entry.path.slice(prefix.length);this.assertNoSecrets(name);sourceFilePath(name);if(!['100644','100755'].includes(entry.mode))throw failure('Package source must contain regular Git files; symlinks and submodules are unsupported',400);if(name==='SKILL.md')skill=true;}
    if(manifest.kind==='skill'){
      if(!skill)throw failure('Skill packages require SKILL.md',400);
      validateSkillInstructions(this.object(repository,`${commit}:${prefix}SKILL.md`).toString('utf8'),manifest.name);
    }
    this.assertDisjoint(repository.id,path,manifest.id);
    const prior=this.store.package(manifest.id);if(prior&&prior.kind!==manifest.kind)throw failure('Package kind cannot change for an existing canonical identifier');
    if(prior&&prior.repositoryId!==repository.id)throw failure('Package identifier already belongs to another repository; independent copies need a new identifier');
    if(prior&&prior.path!==path){const oldManifest=prior.path==='.'?manifestFile:`${prior.path}/${manifestFile}`;if(this.tree(repository,commit).some(entry=>entry.path===oldManifest))throw failure('Package identifier still exists in its previous folder; independent copies need a new identifier');}
    const occupant=this.store.atPath(repository.id,path);if(occupant&&occupant.id!==manifest.id)throw failure('This repository folder is registered with a different package identifier');
  }
  async importPackages(id:string,input:unknown):Promise<{packages:PackageRecord[];imports:ReturnType<PackageService['imports']>}>{
    const value=packageImportInput.parse(input);return this.exclusive(id,()=>{
      this.assertWritable(id);const repository=this.checkedRepository(id);const commit=value.expectedCommit??this.head(repository),discovery=this.discoverAt(repository,commit),imported:PackageRecord[]=[],attemptIds:string[]=[],valid:Array<{attemptId:string;path:string;manifest:PackageManifest}>=[];
      this.assertNoSecrets(value.paths);
      for(const path of [...new Set(value.paths)]){
        const candidate=discovery.packages.find(item=>item.path===path),manifest=candidate?.manifest;
        const previous=manifest&&this.store.package(manifest.id);
        if(previous&&previous.repositoryId===id&&previous.path===path&&previous.lastImportedCommit===commit&&!candidate?.error){imported.push(previous);continue;}
        let metadata:{id?:string;schemaVersion?:number;version?:string}=manifest??{id:this.store.atPath(id,path)?.id};
        if(!manifest)try{const raw=this.manifestDocument(repository,path,commit) as Record<string,unknown>;metadata={id:typeof raw.id==='string'&&/^[0-9a-f-]{36}$/i.test(raw.id)?raw.id.toLowerCase():metadata.id,schemaVersion:typeof raw.schemaVersion==='number'&&Number.isSafeInteger(raw.schemaVersion)?raw.schemaVersion:undefined,version:typeof raw.version==='string'?raw.version.slice(0,100):undefined};}catch{}
        const attempt=this.store.beginImport(id,path,commit,metadata);attemptIds.push(attempt.id);this.store.importing(attempt.id);
        try{
          if(!candidate)throw failure('No package manifest was discovered in this folder',400);if(candidate.error||!manifest)throw failure(candidate.error??'Invalid package manifest',400);
          if(!previous)this.importGuard?.(manifest);
          if(value.paths.some(other=>other!==path && overlappingFolders(other,path)))throw failure('Selected package folders overlap. Select disjoint folders or a single repository-root package.');
          this.validatePackage(repository,path,commit,manifest);this.assertNoSecrets(JSON.stringify(manifest));
          valid.push({attemptId:attempt.id,path,manifest});
        }catch(error){this.store.failImport(attempt.id,this.safeDetail(error,'Package import failed'));}
      }
      // Importing a fetched revision advances the checkout only when every selected package succeeded.
      const failed=this.store.attempts(attemptIds).some(item=>item.status==='failed');
      try{
        if(failed)throw failure('Another selected package failed validation; no packages in this import were changed');
        if(commit!==this.head(repository)){
          if(this.git(repository.directory,['status','--porcelain=v1','--untracked-files=all']))throw failure('Commit or discard local repository changes before checking out an imported revision');
          if(this.git(repository.directory,['rev-list',`${commit}..HEAD`]).trim())throw failure('The remote revision diverges from local commits; reconcile Git history before importing it');
          this.git(repository.directory,['merge','--ff-only',commit]);
        }
        // Commit every metadata row together after all validation and checkout checks succeed.
        imported.push(...this.store.finishImports(id,commit,valid));
      }catch(error){for(const item of valid)this.store.failImport(item.attemptId,this.safeDetail(error,'Package import failed'));}
      const attempts=this.store.attempts(attemptIds);
      return {packages:attempts.some(item=>item.status==='failed')?[]:imported,imports:attempts};
    });
  }
  private assertNoSecrets(value:unknown):void {
    try{this.secretGuard?.(value);}catch{throw failure('Package data contains known credentials and cannot be exposed or persisted.',400);}
    const text=typeof value==='string'?value:JSON.stringify(value);
    for(const secret of [this.config.adminPassword,this.config.ipcToken])if(secret&&secret.length>=8&&(text.includes(secret)||text.includes(JSON.stringify(secret).slice(1,-1))))throw failure('Package data contains known credentials and cannot be exposed or persisted.',400);
  }
  private directory(repository:RepositoryRecord,path:string):string {
    packagePath(path);
    let directory=repository.directory;
    for(const part of path==='.'?[]:path.split('/')){
      directory=join(directory,part);
      const info=lstatSync(directory,{throwIfNoEntry:false});
      if(info&&!info.isDirectory())throw failure('Package folders must be real directories without symlinks',400);
    }
    return directory;
  }
  private importCreated(repository:RepositoryRecord,path:string,manifest:PackageManifest,commit:string):PackageRecord {
    const prior=this.store.package(manifest.id);if(prior&&prior.repositoryId===repository.id&&prior.path===path&&prior.lastImportedCommit===commit)return prior;
    const attempt=this.store.beginImport(repository.id,path,commit,manifest);this.store.importing(attempt.id);try{return this.store.finishImport(attempt.id,repository.id,path,commit,manifest);}catch(error){this.store.failImport(attempt.id,(error as Error).message);throw error;}
  }
  async createPackage(repositoryId:string,input:{path:string;manifest:unknown;files?:Record<string,string>}):Promise<PackageRecord>{return this.exclusive(repositoryId,()=>{
    const runId=this.runContext.getStore();this.assertWritable(repositoryId,runId);const repository=this.checkedRepository(repositoryId);const path=packagePath(input.path),manifest=packageManifestSchema.parse(input.manifest),directory=this.directory(repository,path);
    if(this.store.package(manifest.id)||this.store.atPath(repositoryId,path))throw failure('Package identifier or folder is already registered');
    this.assertDisjoint(repositoryId,path,manifest.id);
    if(lstatSync(join(directory,manifestFile),{throwIfNoEntry:false}))throw failure('This folder already has a package manifest; import or adopt it explicitly');
    const prefix=path==='.'?'':path+'/';
    for(const entry of this.tree(repository,this.head(repository)).filter(entry=>entry.path.startsWith(prefix))){
      sourceFilePath(entry.path.slice(prefix.length));
      if(!['100644','100755'].includes(entry.mode))throw failure('Package source must contain regular Git files; symlinks and submodules are unsupported',400);
    }
    const files:Record<string,string>={...input.files,[manifestFile]:`${JSON.stringify(manifest,null,2)}\n`};if(manifest.kind==='skill'&&!files['SKILL.md']&&!existsSync(join(directory,'SKILL.md')))files['SKILL.md']=`---\nname: ${manifest.name}\ndescription: ${manifest.description||manifest.name}\n---\n\n# ${manifest.name}\n`;
    this.checkEditorFiles(repository,path,manifest,files,[]);this.assertNoSecrets(files);this.preflightCommit(repository,`Create ${manifest.kind} package ${manifest.name}`,path,runId);
    for(const [name,body] of Object.entries(files)){
      const file=join(directory,name);if(!existsSync(file))continue;
      if(path==='.'&&name==='README.md'){delete files[name];continue;}
      if(!readFileSync(file).equals(Buffer.from(body)))throw failure(`Package scaffold would overwrite ${name}; adopt the existing folder or choose an empty package folder`);
    }
    mkdirSync(directory,{recursive:true,mode:0o700});for(const [name,body] of Object.entries(files))this.writeEditorFile(directory,name,body);
    const commit=this.commitFolder(repository,path,manifest,`Create ${manifest.kind} package ${manifest.name}`,runId);return this.importCreated(repository,path,manifest,commit);
  });}
  async adoptPackage(repositoryId:string,input:{path:string;manifest:unknown}):Promise<PackageRecord>{
    const repository=this.checkedRepository(repositoryId);
    const directory=this.directory(repository,packagePath(input.path));
    if(!lstatSync(directory,{throwIfNoEntry:false})?.isDirectory())throw failure('Choose an existing package folder to adopt',400);
    if(packageManifestSchema.parse(input.manifest).kind==='skill'&&!lstatSync(join(directory,'SKILL.md'),{throwIfNoEntry:false})?.isFile())throw failure('Adopting an existing skill requires SKILL.md',400);
    return this.createPackage(repositoryId,input);
  }
  manifest(id:string,commit?:string):PackageManifest {const value=this.package(id),repository=this.checkedRepository(value.repositoryId);return this.manifestAt(repository,value.path,commit??value.lastImportedCommit);}
  fileNames(id:string,commit?:string):string[]{const value=this.package(id),repository=this.checkedRepository(value.repositoryId);const prefix=value.path==='.'?'':`${value.path}/`;return this.tree(repository,commit??value.lastImportedCommit).filter(entry=>entry.path.startsWith(prefix)).map(entry=>entry.path.slice(prefix.length));}
  source(id:string):Source {
    const value=this.package(id),repository=this.checkedRepository(value.repositoryId);const commit=value.lastImportedCommit;
    const dirty=Boolean(this.git(repository.directory,['status','--porcelain=v1','--untracked-files=all','--',value.path]));
    const workspaceDiverged=Boolean(this.git(repository.directory,['diff','--name-only',commit,'HEAD','--',value.path]));
    return {repositoryId:repository.id,packageId:value.id,repositoryPath:repository.directory,branch:repository.branch,path:value.path,workspacePath:this.directory(repository,value.path),commit,dirty,...(workspaceDiverged?{workspaceDiverged}: {})};
  }
  readTextFiles(id:string,commit?:string):Record<string,string> {
    const value=this.package(id),repository=this.checkedRepository(value.repositoryId);const revision=commit??value.lastImportedCommit,prefix=value.path==='.'?'':`${value.path}/`,files:Record<string,string>=Object.create(null);let bytes=0;
    const entries=this.tree(repository,revision).filter(entry=>entry.path.startsWith(prefix)).sort((a,b)=>Number(b.path===`${prefix}${manifestFile}`)-Number(a.path===`${prefix}${manifestFile}`));
    for(const entry of entries){if(Object.keys(files).length>=500)break;if(!['100644','100755'].includes(entry.mode))continue;const name=entry.path.slice(prefix.length);try{sourceFilePath(name);}catch{continue;}if(Number(this.git(repository.directory,['cat-file','-s',entry.sha]).trim())>1_000_000)continue;const data=this.object(repository,entry.sha);const text=data.toString('utf8');if(data.includes(0)||!Buffer.from(text).equals(data))continue;const serializedBytes=Buffer.byteLength(JSON.stringify(name))+Buffer.byteLength(JSON.stringify(text))+2;if(Object.keys(files).length>=500||bytes+serializedBytes>textLimit-2)continue;this.assertNoSecrets(name);this.assertNoSecrets(text);files[name]=text;bytes+=serializedBytes;}return files;
  }
  private checkEditorFiles(repository:RepositoryRecord,path:string,previous:PackageManifest,files:Record<string,string>,removed:string[]):void {
    const directory=this.directory(repository,path),names=[...Object.keys(files),...removed];if(names.length>600)throw failure('Too many editor changes',400);let bytes=0;
    for(const name of names){
      sourceFilePath(name);
      const pieces=name.split('/');let parent=directory;
      for(const piece of pieces.slice(0,-1)){
        parent=join(parent,piece);
        const info=lstatSync(parent,{throwIfNoEntry:false});
        if(info&&!info.isDirectory())throw failure('Package writes require real parent directories',400);
      }
      const info=lstatSync(join(directory,name),{throwIfNoEntry:false});
      if(info&&(!info.isFile()||info.nlink!==1))throw failure('Package editor can only replace regular unlinked files',400);
    }
    for(const [name,body] of Object.entries(files)){if(typeof body!=='string'||body.includes('\0')||Buffer.from(body,'utf8').toString('utf8')!==body||Buffer.byteLength(body)>1_000_000)throw failure('Package editor supports UTF-8 text files up to 1 MB',400);bytes+=Buffer.byteLength(body)+Buffer.byteLength(name);if(bytes>textLimit)throw failure('Package editor changes must not exceed 8 MB',400);}
    const written=new Set(Object.keys(files));for(const name of names){const parts=name.split('/');while(parts.length>1){parts.pop();if(written.has(parts.join('/')))throw failure('A source file cannot also be a parent directory',400);}}
    if(Object.hasOwn(files,manifestFile)&&Buffer.byteLength(files[manifestFile])>packageManifestMaxBytes)throw failure('Package manifest must be at most 64 KB',400);
    if(removed.includes(manifestFile))throw failure('Package manifest cannot be removed',400);
    let manifest=previous;
    if(Object.hasOwn(files,manifestFile)){
      manifest=packageManifestSchema.parse(this.parseManifestDocument(files[manifestFile]));
      if(manifest.id!==previous.id||manifest.kind!==previous.kind)throw failure('Package manifest identity cannot change',400);
    }
    if(manifest.kind==='skill'){
      if(removed.includes('SKILL.md'))throw failure('Skill packages require SKILL.md',400);
      const skillPath=join(directory,'SKILL.md');
      if(!Object.hasOwn(files,'SKILL.md')&&!lstatSync(skillPath,{throwIfNoEntry:false})?.isFile())throw failure('Skill packages require a regular SKILL.md file',400);
      validateSkillInstructions(files['SKILL.md']??readFileSync(skillPath,'utf8'),manifest.name);
    }
    const targets=Object.keys(files).map(name=>path==='.'?name:path+'/'+name);
    if(targets.length&&this.git(repository.directory,['check-ignore','--',...targets],true))throw failure('Source files are ignored by Git. Update the repository ignore rules or choose a tracked path.',400);
  }
  private writeEditorFile(directory:string,name:string,body:string):void {
    const target=join(directory,name),parent=dirname(target);
    mkdirSync(parent,{recursive:true,mode:0o700});
    if(realpathSync(parent)!==parent)throw failure('Package writes require real parent directories',400);
    const original=lstatSync(target,{throwIfNoEntry:false});
    if(original&&(!original.isFile()||original.nlink!==1))throw failure('Package editor can only replace regular unlinked files',400);
    const temporary=join(parent,`.operator-tmp-${randomUUID()}`);
    try{
      writeFileSync(temporary,body,{flag:'wx',mode:original?original.mode&0o777:0o600});
      renameSync(temporary,target);
    }finally{rmSync(temporary,{force:true});}
  }
  private preflightCommit(repository:RepositoryRecord,message:string,path?:string,runId?:string):void {
    this.assertNoSecrets(message);if(!message.trim()||message.length>300||/[\x00-\x1f]/.test(message))throw failure('Commit message must be a single line of at most 300 characters',400);
    if(this.git(repository.directory,['diff','--cached','--name-only','-z']))throw failure('Repository has staged changes; finish or unstage them before the operator commits');
    if(runId&&!/^[\w-]{1,200}$/.test(runId))throw failure('Invalid task identifier',400);
    if(runId&&path&&path!=='.'){
      const allowed=[path,...this.writeScope?.(repository.id,runId)??[]].map(packagePath);
      const outside=this.git(repository.directory,['status','--porcelain=v1','-z','--untracked-files=all']).split('\0').filter(Boolean).map(row=>row.slice(3)).find(name=>!allowed.some(folder=>folder==='.'||name.startsWith(`${folder}/`)));
      if(outside)throw failure('Task changed files outside its assigned package; review and commit those repository changes before finalizing this task');
    }
  }
  private scanChangedFile(file:string):void {
    const fd=openSync(file,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{
      const info=fstatSync(fd);
      if(!info.isFile()||info.nlink!==1)throw failure('Package source can contain only regular files',400);
      const decoder=new StringDecoder('utf8'),bytes=Buffer.allocUnsafe(512*1024);
      // Linux environment strings are bounded to 128 KiB. Vault values are at most 32k
      // UTF-16 code units, which can grow sixfold when escaped inside JSON.
      let tail='',count:number;
      while((count=readSync(fd,bytes,0,bytes.length,null))>0){
        const chunk=tail+decoder.write(bytes.subarray(0,count));
        this.assertNoSecrets(chunk);
        tail=chunk.slice(-192_000);
      }
      this.assertNoSecrets(tail+decoder.end());
    }finally{closeSync(fd);}
  }
  private commitFolder(repository:RepositoryRecord,path:string,manifest:PackageManifest,message:string,runId?:string):string {
    this.preflightCommit(repository,message,path,runId);
    const directory=this.directory(repository,path),prefix=path==='.'?'':`${path}/`;
    // Inspect actual files before staging. Git index/object checks retain binary assets and executable modes.
    const changed=this.git(repository.directory,['status','--porcelain=v1','-z','--untracked-files=all','--',path]).split('\0').filter(Boolean);
    for(const row of changed){const full=row.slice(3);if(!full.startsWith(prefix))throw failure('Source change escapes its package');const name=full.slice(prefix.length);sourceFilePath(name);const file=join(directory,name),info=lstatSync(file,{throwIfNoEntry:false});if(info){if(!info.isFile()||info.nlink!==1)throw failure('Package source can contain only regular files',400);this.scanChangedFile(file);}}
    const manifestData=readFileSync(join(directory,manifestFile));if(manifestData.length>packageManifestMaxBytes||!Buffer.from(manifestData.toString('utf8')).equals(manifestData))throw failure('Package manifest must contain valid UTF-8 and be at most 64 KB',400);
    const diskManifest=packageManifestSchema.parse(this.parseManifestDocument(manifestData.toString('utf8')));if(diskManifest.id!==manifest.id||diskManifest.kind!==manifest.kind)throw failure('Package manifest identity cannot change',400);
    if(diskManifest.kind==='skill'){
      const skillPath=join(directory,'SKILL.md');if(!existsSync(skillPath)||!lstatSync(skillPath).isFile()||lstatSync(skillPath).isSymbolicLink())throw failure('Skill packages require a regular SKILL.md file',400);
      validateSkillInstructions(readFileSync(skillPath,'utf8'),diskManifest.name);
    }
    this.git(repository.directory,['add','--',path]);
    if(this.git(repository.directory,['diff','--cached','--name-only','-z']))this.git(repository.directory,['-c','user.name=AI Operator','-c','user.email=operator@localhost','commit','-qm',`${message}${runId?`\n\nOperator-Run: ${runId}`:''}`]);
    return this.head(repository);
  }
  async commit(id:string,message='Update package source',runId?:string):Promise<Source>{const repositoryId=this.package(id).repositoryId;return this.exclusive(repositoryId,()=>{
    const value=this.package(id),effectiveRunId=runId??this.runContext.getStore();this.assertWritable(value.repositoryId,effectiveRunId);const repository=this.checkedRepository(value.repositoryId);const current=this.source(id);
    if(current.workspaceDiverged){
      // A task may have committed successfully just before the controller lost its SQLite update.
      const last=this.git(repository.directory,['log','-1','--format=%H','--',value.path]).trim();
      const owner=effectiveRunId&&this.git(repository.directory,['show','-s','--format=%(trailers:key=Operator-Run,valueonly)',last]).trim();
      if(!current.dirty && owner && owner===effectiveRunId){
        const saved=this.manifestAt(repository,value.path,last);
        if(saved.id!==value.id||saved.kind!==value.kind)throw failure('Package manifest identity cannot change',400);
        this.validatePackage(repository,value.path,last,saved);
        this.importCreated(repository,value.path,saved,last);
        return this.source(id);
      }
      throw failure('The checkout contains a different committed package revision. Discover and import it before committing source.');
    }
    if(!current.dirty){this.preflightCommit(repository,message,value.path,effectiveRunId);return current;}
    const commit=this.commitFolder(repository,value.path,value.manifest,message,effectiveRunId);const manifest=this.manifestAt(repository,value.path,commit);this.validatePackage(repository,value.path,commit,manifest);this.importCreated(repository,value.path,manifest,commit);return this.source(id);
  });}
  async writeTextFiles(id:string,files:Record<string,string>,removed:string[]=[],options:{message?:string;expectedCommit?:string|null;runId?:string;createOnly?:string[]}={}):Promise<PackageRecord>{const repositoryId=this.package(id).repositoryId;return this.exclusive(repositoryId,()=>{
    const value=this.package(id),runId=options.runId??this.runContext.getStore();this.assertWritable(value.repositoryId,runId);const repository=this.checkedRepository(value.repositoryId);const source=this.source(id);if(source.workspaceDiverged)throw failure('The checkout contains a different committed package revision. Discover and import it before editing source.');if(options.expectedCommit!==undefined&&options.expectedCommit!==source.commit)throw failure('Package source changed since it was loaded; reload before saving');
    const directory=this.directory(repository,value.path);
    for(const name of options.createOnly??[]){
      sourceFilePath(name);
      if(!Object.hasOwn(files,name)||removed.includes(name))throw failure('Each create-only path must name a new source file in this write',400);
      if(lstatSync(join(directory,name),{throwIfNoEntry:false}))throw failure(`Source file already exists: ${name}. Choose another name before saving.`);
    }
    this.checkEditorFiles(repository,value.path,value.manifest,files,removed);this.assertNoSecrets(files);this.preflightCommit(repository,options.message??'Update package source',value.path,runId);
    for(const name of removed)rmSync(join(directory,name),{force:true});for(const [name,body] of Object.entries(files))this.writeEditorFile(directory,name,body);
    const commit=this.commitFolder(repository,value.path,value.manifest,options.message??'Update package source',runId),manifest=this.manifestAt(repository,value.path,commit);return this.importCreated(repository,value.path,manifest,commit);
  });}
}
