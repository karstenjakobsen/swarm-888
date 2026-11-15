import { randomUUID, createHash } from 'node:crypto';
import { accessSync, closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { managedFilesSchema, managedManifestSchema, managedPath, managedStatusResult } from '../managed/schemas.ts';
import { projectReferenceSchema } from '../projects/schemas.ts';
import { executionEnvironment, inside, prepareExecutionDirectory } from './execution.ts';
import { validateProjectReference } from './projects.ts';
import { markCleanupUncertain, markExternalEffects, signalOwned, spawnOwned, terminateOwned } from './operations.ts';

export const managedPrepareInput=z.object({
  project:projectReferenceSchema,source:z.object({commit:z.string().regex(/^[0-9a-f]{40,64}$/),path:z.string().max(2000)}).strict(),
  manifest:managedManifestSchema,files:managedFilesSchema,
}).strict();
export const managedLifecycleInput=z.object({project:projectReferenceSchema}).strict();
type PrepareInput=z.infer<typeof managedPrepareInput>;
type LifecycleInput=z.infer<typeof managedLifecycleInput>;
export type ManagedCommand=(command:string,args:string[],options:{cwd?:string;timeoutMs:number;signal:AbortSignal})=>Promise<{stdout:string;stderr:string;exitCode:number;truncated:boolean}>;
export interface ManagedServiceHost {isRoot:()=>boolean;writeUnit:(name:string,content:string)=>void}
const metadataName='.operator-release.json';
const marker=z.object({commit:z.string().regex(/^[0-9a-f]{40,64}$/),path:z.string(),digest:z.string().regex(/^[0-9a-f]{64}$/)}).strict();
type Status=z.infer<typeof managedStatusResult>;

/** Every helper owns a separate process group so timeouts also terminate descendants. */
export function managedCommand(config:Config):ManagedCommand {
  return async(command,args,options)=>{
    options.signal.throwIfAborted();
    const child=spawnOwned(command,args,{cwd:options.cwd,env:{...executionEnvironment(config),LANG:'C',LC_ALL:'C'}});
    let stdout='',stderr='',error:Error|undefined;
    const terminate=()=>{try{signalOwned(child,'SIGKILL');}catch(failure){markCleanupUncertain();error=failure instanceof Error?failure:new Error('Owned helper cleanup is uncertain.');}};
    const abort=()=>{error=new Error('Managed command was interrupted; its outcome may be uncertain.');terminate();};
    options.signal.addEventListener('abort',abort,{once:true});
    const timer=setTimeout(()=>{error=new Error('Managed command timed out; its process group was terminated and service state may be uncertain.');terminate();},options.timeoutMs);
    const capture=(stream:'stdout'|'stderr',chunk:Buffer)=>{
      if(Buffer.byteLength(stdout)+Buffer.byteLength(stderr)+chunk.length>256_000){error=new Error('Managed command output exceeded 256 kB.');terminate();return;}
      if(stream==='stdout')stdout+=chunk.toString();else stderr+=chunk.toString();
    };
    child.stdout.on('data',chunk=>capture('stdout',chunk));child.stderr.on('data',chunk=>capture('stderr',chunk));
    try{
      const exitCode=await new Promise<number>((ok,no)=>{child.once('error',()=>no(new Error('Managed command could not start.')));child.once('close',code=>ok(code??-1));});
      if(error)throw error;return {stdout,stderr,exitCode,truncated:false};
    }finally{clearTimeout(timer);options.signal.removeEventListener('abort',abort);try{await terminateOwned(child);}catch(error){markCleanupUncertain();throw error;}}
  };
}

function digest(input:PrepareInput):string {
  return createHash('sha256').update(JSON.stringify({manifest:input.manifest,files:Object.entries(input.files).sort(([a],[b])=>a<b?-1:a>b?1:0)})).digest('hex');
}
function safeFile(name:string):boolean { return name.length<=2000&&!name.startsWith('/')&&!name.includes('\\')&&!name.includes('\0')&&name.split('/').every(piece=>piece&&piece!=='.'&&piece!=='..')&&name!==metadataName; }
function readReleaseFile(path:string,limit:number):string {
  if(realpathSync(path)!==path)throw new Error('Release files must remain canonical.');
  const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=fstatSync(descriptor);if(!stat.isFile()||stat.size>limit||readlinkSync(`/proc/self/fd/${descriptor}`)!==path)throw new Error('Release file changed or exceeded its expected size.');
    const buffer=Buffer.alloc(limit+1);let total=0,size;
    while(total<buffer.length&&(size=readSync(descriptor,buffer,total,buffer.length-total,null))>0)total+=size;
    if(total>limit)throw new Error('Release file exceeded its expected size.');return buffer.subarray(0,total).toString();
  }finally{closeSync(descriptor);}
}
function unitName(input:LifecycleInput):string { return `vps-ai-project-${input.project.id}.service`; }
function properties(text:string):Record<string,string> { return Object.fromEntries(text.split('\n').filter(line=>line.includes('=')).map(line=>{const index=line.indexOf('=');return [line.slice(0,index),line.slice(index+1)];})); }
function quoteUnit(value:string,exec=false):string {
  if(/[\x00-\x1f\x7f]/.test(value))throw new Error('Systemd command arguments and paths cannot contain control characters.');
  return `"${value.replaceAll('\\','\\\\').replaceAll('"','\\"').replaceAll('%','%%').replaceAll('$',()=>exec?'$$':'$')}"`;
}
function executable(command:string,cwd:string):string {
  if(command==='node')return process.execPath;
  if(command.includes('/'))return resolve(cwd,command);
  for(const directory of (process.env.PATH??'/usr/local/bin:/usr/bin:/bin').split(':')){
    const path=resolve(directory,command);try{accessSync(path,constants.X_OK);if(lstatSync(path).isFile()||lstatSync(path).isSymbolicLink())return path;}catch{}
  }
  throw new Error(`Run executable is unavailable: ${command}`);
}
const serviceHost:ManagedServiceHost={
  isRoot:()=>process.getuid?.()===0,
  writeUnit:(name,content)=>{
    const directory='/etc/systemd/system',target=join(directory,name),temporary=join(directory,`.${name}.${randomUUID()}`);
    if(realpathSync(directory)!==directory)throw new Error('Systemd unit directory must be canonical.');
    try{const stat=lstatSync(target);if(!stat.isFile()||stat.isSymbolicLink())throw new Error('Managed systemd unit must be a regular file.');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    try{writeFileSync(temporary,content,{flag:'wx',mode:0o644});renameSync(temporary,target);}finally{rmSync(temporary,{force:true});}
  },
};

/** Runtime release files are exported committed code; this class never touches repository source. */
export class ManagedRuntime {
  private controller=new AbortController();
  private operations=new Map<string,Promise<unknown>>();
  private observations=new Set<Promise<unknown>>();
  constructor(private config:Config,private command:ManagedCommand=managedCommand(config),private host:ManagedServiceHost=serviceHost){}
  private exclusive<T>(projectId:string,operation:()=>Promise<T>):Promise<T> {
    const previous=this.operations.get(projectId)??Promise.resolve();
    const next=previous.catch(()=>{}).then(()=>{this.controller.signal.throwIfAborted();return operation();});
    this.operations.set(projectId,next);void next.finally(()=>{if(this.operations.get(projectId)===next)this.operations.delete(projectId);}).catch(()=>{});return next;
  }
  private observation<T>(operation:()=>Promise<T>):Promise<T> {
    const next=Promise.resolve().then(()=>{this.controller.signal.throwIfAborted();return operation();});this.observations.add(next);
    void next.finally(()=>this.observations.delete(next)).catch(()=>{});return next;
  }
  private async execute(command:string,args:string[],cwd?:string,timeoutMs=5000) {
    if(!command||command.includes('\0')||args.some(arg=>arg.includes('\0')))throw new Error('Managed commands must be valid argument vectors.');
    const result=await this.command(command,args,{cwd,timeoutMs,signal:this.controller.signal});
    if(result.exitCode!==0)throw new Error(`Managed command failed with exit code ${result.exitCode}.${result.stderr.trim()?` ${result.stderr.trim().slice(-2000)}`:''}`);
    return result;
  }
  private prepareSnapshot(input:PrepareInput):{releaseDirectory:string;commit:string;checkedAt:string} {
    validateProjectReference(this.config,input.project);
    if(input.manifest.id!==input.project.id||input.source.path!==managedPath(input.manifest.kind,input.manifest.id))throw new Error('Managed source identity does not match its project and package manifest.');
    const names=Object.keys(input.files);if(!names.length||names.some(name=>!safeFile(name)))throw new Error('Release files must use relative paths inside the committed package.');
    let exportedManifest;
    try{exportedManifest=managedManifestSchema.parse(JSON.parse(input.files['operator-package.json']??''));}catch{throw new Error('Committed source must include a valid operator-package.json.');}
    if(JSON.stringify(exportedManifest)!==JSON.stringify(input.manifest))throw new Error('Committed package manifest differs from the deployment manifest.');
    prepareExecutionDirectory(this.config,input.project.directory);
    const releases=join(input.project.directory,'releases');prepareExecutionDirectory(this.config,releases);
    const releaseDirectory=join(releases,input.source.commit),expected={commit:input.source.commit,path:input.source.path,digest:digest(input)};
    if(existsSync(releaseDirectory)){
      if(realpathSync(releaseDirectory)!==releaseDirectory||!lstatSync(releaseDirectory).isDirectory())throw new Error('Release directory must remain canonical.');
      if(JSON.stringify(marker.parse(JSON.parse(readReleaseFile(join(releaseDirectory,metadataName),8000))))!==JSON.stringify(expected))throw new Error('This committed revision already has a different runtime snapshot.');
      for(const [name,content] of Object.entries(input.files)){
        const path=join(releaseDirectory,name);if(readReleaseFile(path,Buffer.byteLength(content))!==content)throw new Error('Existing release source differs from its committed snapshot.');
      }
    }else{
      const staging=join(releases,`.prepare-${randomUUID()}`);mkdirSync(staging,{mode:0o700});
      try{
        for(const [name,content] of Object.entries(input.files)){
          const path=join(staging,name);mkdirSync(dirname(path),{recursive:true,mode:0o700});writeFileSync(path,content,{flag:'wx',mode:0o600});
        }
        writeFileSync(join(staging,metadataName),JSON.stringify(expected),{flag:'wx',mode:0o600});renameSync(staging,releaseDirectory);
      }finally{rmSync(staging,{recursive:true,force:true});}
    }
    return {releaseDirectory,commit:input.source.commit,checkedAt:new Date().toISOString()};
  }
  prepare(raw:unknown):Promise<{releaseDirectory:string;commit:string;checkedAt:string}> {
    const input=managedPrepareInput.parse(raw);return this.exclusive(input.project.id,async()=>{
      const result=this.prepareSnapshot(input);if(input.manifest.kind==='connector'&&input.manifest.check){await this.execute(input.manifest.check.command,input.manifest.check.args,result.releaseDirectory,30_000);this.prepareSnapshot(input);}return {...result,checkedAt:new Date().toISOString()};
    });
  }
  deploy(raw:unknown):Promise<Status&{releaseDirectory:string;commit:string}> {
    const input=managedPrepareInput.parse(raw);
    return this.exclusive(input.project.id,async()=>{
      if(!['project','connector'].includes(input.manifest.kind)||!input.manifest.run)throw new Error('Deployment requires a project or connector manifest with a run command.');
      const release=this.prepareSnapshot(input);
      const run=[executable(input.manifest.run.command,release.releaseDirectory),...input.manifest.run.args].map(value=>quoteUnit(value,true)).join(' ');
      if(!this.host.isRoot())throw new Error('Managed deployment requires a root worker to install and enable its systemd service.');
      // Check the real manager before touching the previous independently running service.
      try{await this.execute('/usr/bin/systemctl',['show','--property=Version','--no-pager']);}
      catch{throw new Error('Systemd is unavailable; the committed release was prepared, but no service was deployed.');}
      const existing=await this.observe(input);
      if(existing.status==='running'&&existing.commit===input.source.commit&&existing.releaseDirectory===release.releaseDirectory)return {...release,...existing,releaseDirectory:release.releaseDirectory,commit:release.commit};
      for(const [name,timeout] of [['check',30_000],['build',60_000]] as const){const operation=input.manifest[name];if(operation)await this.execute(operation.command,operation.args,release.releaseDirectory,timeout);}
      this.prepareSnapshot(input);
      markExternalEffects();this.host.writeUnit(unitName(input),`[Unit]\nDescription=VPS AI project ${input.project.id}\nAfter=network.target\n\n[Service]\nType=exec\nWorkingDirectory=${quoteUnit(release.releaseDirectory)}\nExecStart=${run}\nRestart=on-failure\nRestartSec=3\n\n[Install]\nWantedBy=multi-user.target\n`);
      await this.execute('/usr/bin/systemctl',['daemon-reload']);
      await this.execute('/usr/bin/systemctl',['enable','--',unitName(input)]);
      await this.execute('/usr/bin/systemctl',['restart','--',unitName(input)]);
      const status=await this.observe(input);
      if(status.status!=='running'||status.commit!==release.commit||status.releaseDirectory!==release.releaseDirectory)throw new Error(`Systemd did not confirm the requested committed release running. ${status.detail}`);
      return {...release,...status,releaseDirectory:release.releaseDirectory,commit:release.commit};
    });
  }
  private async observe(input:LifecycleInput):Promise<Status> {
    validateProjectReference(this.config,input.project);const base={unitName:unitName(input),checkedAt:new Date().toISOString()};
    const result=await this.command('/usr/bin/systemctl',['show','--no-pager','--property=LoadState,ActiveState,SubState,WorkingDirectory,Result','--',base.unitName],{timeoutMs:5000,signal:this.controller.signal});
    const state=properties(result.stdout);
    if(state.LoadState==='not-found')return {...base,status:'unknown',detail:'No managed systemd service is registered.'};
    if(result.exitCode!==0||!state.ActiveState)throw new Error('Systemd service state is unavailable.');
    const directory=state.WorkingDirectory,releases=join(input.project.directory,'releases');
    if(!directory||!inside(releases,directory)||realpathSync(directory)!==directory)throw new Error('Managed service working directory does not match this project release.');
    const revision=marker.parse(JSON.parse(readReleaseFile(join(directory,metadataName),8000)));
    if(![managedPath('project',input.project.id),managedPath('connector',input.project.id)].includes(revision.path))throw new Error('Managed service release identity does not match this project.');
    return {...base,status:['active','reloading'].includes(state.ActiveState)?'running':state.ActiveState==='failed'?'failed':state.ActiveState==='inactive'?'stopped':'unknown',detail:`Service is ${state.ActiveState}/${state.SubState??'unknown'}.${state.Result&&state.Result!=='success'?` Result: ${state.Result}.`:''}`,releaseDirectory:directory,commit:revision.commit};
  }
  status(raw:unknown):Promise<Status> { const input=managedLifecycleInput.parse(raw);return this.observation(()=>this.observe(input)); }
  stop(raw:unknown):Promise<Status> {
    const input=managedLifecycleInput.parse(raw);return this.exclusive(input.project.id,async()=>{
      const state=await this.observe(input);if(!state.releaseDirectory)return state;
      if(!this.host.isRoot())throw new Error('Stopping a managed service requires a root worker.');
      markExternalEffects();await this.execute('/usr/bin/systemctl',['disable','--now','--',unitName(input)]);
      const observed=await this.observe(input);return observed.status==='unknown'?{...state,status:'stopped',detail:'Systemd confirmed the managed service was disabled and stopped.',checkedAt:new Date().toISOString()}:observed;
    });
  }
  logs(raw:unknown):Promise<{text:string;truncated:boolean;checkedAt:string}> {
    const input=managedLifecycleInput.parse(raw);return this.observation(async()=>{await this.observe(input);const result=await this.execute('/usr/bin/journalctl',['--no-pager','--output=short-iso','--lines=200',`--unit=${unitName(input)}`]);return {text:result.stdout.slice(-180_000),truncated:result.truncated||result.stdout.length>180_000,checkedAt:new Date().toISOString()};});
  }
  async close():Promise<void> {this.controller.abort(new Error('Worker is stopping.'));await Promise.allSettled([...this.operations.values(),...this.observations]);}
}
