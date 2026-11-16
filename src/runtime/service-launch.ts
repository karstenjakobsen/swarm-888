import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync,constants,fstatSync,openSync,readFileSync,realpathSync } from 'node:fs';
import { basename,isAbsolute,join,relative,resolve } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { projectEnvironmentSchema,type ProjectEnvironment } from '../credentials/schemas.ts';
import { resolveProjectSecrets } from '../credentials/runtime.ts';

const absolute=z.string().min(1).max(4000).refine(value=>isAbsolute(value)&&!value.includes('\0'));
export const serviceLaunchSchema=z.object({schemaVersion:z.literal(1),projectId:z.string().uuid(),controllerUid:z.number().int().nonnegative(),stateDir:absolute,projectDirectory:absolute,releaseDirectory:absolute,command:absolute,args:z.array(z.string().max(16000).refine(value=>!value.includes('\0'))).max(100),environment:projectEnvironmentSchema,materialRevision:z.number().int().positive()}).strict();
export type ServiceLaunch=z.infer<typeof serviceLaunchSchema>;

export function serviceConfiguration(environment:ProjectEnvironment,materialRevision:number):string {
  return createHash('sha256').update(JSON.stringify({environment:{credentialId:environment.credentialId,bindings:Object.fromEntries(Object.entries(environment.bindings).sort(([a],[b])=>a.localeCompare(b)))},materialRevision})).digest('hex');
}
export function serviceDescriptorPath(input:Pick<ServiceLaunch,'projectDirectory'|'releaseDirectory'|'environment'|'materialRevision'>):string{return join(input.projectDirectory,'.operator-service',`${basename(input.releaseDirectory)}-${serviceConfiguration(input.environment,input.materialRevision)}.json`);}

/** Keep incomplete matches until another chunk arrives; no raw credential crosses output boundaries. */
export class ServiceOutputRedactor {
  private decoder=new StringDecoder('utf8');private pending='';private variants:string[];private overlap:number;
  constructor(secrets:string[]){this.variants=[...new Set(secrets.flatMap(secret=>[secret,JSON.stringify(secret).slice(1,-1)]).filter(Boolean))].sort((a,b)=>b.length-a.length);this.overlap=Math.max(0,...this.variants.map(value=>value.length-1));}
  private take(final:boolean):string {
    const end=final?this.pending.length:Math.max(0,this.pending.length-this.overlap);let cursor=0,output='';
    while(cursor<end){
      let next=-1,matched='';for(const value of this.variants){const index=this.pending.indexOf(value,cursor);if(index>=0&&(next<0||index<next)){next=index;matched=value;}}
      if(next<0||next>=end){output+=this.pending.slice(cursor,end);cursor=end;break;}
      output+=this.pending.slice(cursor,next)+'[REDACTED]';cursor=next+matched.length;
    }
    this.pending=this.pending.slice(cursor);return output;
  }
  write(chunk:Buffer):string{this.pending+=this.decoder.write(chunk);return this.take(false);}
  end():string{this.pending+=this.decoder.end();return this.take(true);}
}

export function projectServiceEnvironment(env:Record<string,string>,ambient:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  const base:NodeJS.ProcessEnv={PATH:ambient.PATH??'/usr/local/bin:/usr/bin:/bin',LANG:ambient.LANG??'C.UTF-8'};
  for(const key of ['HOME','LC_ALL','TZ'])if(ambient[key]!==undefined)base[key]=ambient[key];return {...base,...env};
}
function readDescriptor(path:string):ServiceLaunch {
  const canonical=resolve(path);if(realpathSync(canonical)!==canonical)throw new Error('Project service descriptor must be canonical');
  const descriptor=openSync(canonical,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=fstatSync(descriptor);if(!stat.isFile()||(stat.mode&0o077)!==0||stat.size>100_000)throw new Error('Project service descriptor must remain a private owned file');
    const input=serviceLaunchSchema.parse(JSON.parse(readFileSync(descriptor,'utf8')));
    if(stat.uid!==process.getuid?.()&&stat.uid!==input.controllerUid)throw new Error('Project service descriptor belongs to another user');
    if(serviceDescriptorPath(input)!==canonical||realpathSync(input.projectDirectory)!==input.projectDirectory||realpathSync(input.releaseDirectory)!==input.releaseDirectory||!/^releases\/[0-9a-f]{40,64}$/.test(relative(input.projectDirectory,input.releaseDirectory)))throw new Error('Project service descriptor does not match its canonical runtime');
    return input;
  }finally{closeSync(descriptor);}
}

/** Persistent systemd supervisor: only its service child receives the selected credential fields. */
export async function launchProjectService(path:string):Promise<number> {
  const input=readDescriptor(path),secret=resolveProjectSecrets({stateDir:input.stateDir},input.projectId,input.environment);
  const child=spawn(input.command,input.args,{cwd:input.releaseDirectory,env:projectServiceEnvironment(secret.env),stdio:['inherit','pipe','pipe'],detached:false});
  const forward=(signal:NodeJS.Signals)=>{try{child.kill(signal);}catch{}};
  const term=()=>forward('SIGTERM'),interrupt=()=>forward('SIGINT');process.on('SIGTERM',term);process.on('SIGINT',interrupt);
  for(const [source,target]of [[child.stdout,process.stdout],[child.stderr,process.stderr]] as const){
    const filter=new ServiceOutputRedactor(secret.secrets);
    source.on('data',(chunk:Buffer)=>{const text=filter.write(chunk);if(text&&!target.write(text)){source.pause();target.once('drain',()=>source.resume());}});
    source.once('end',()=>{const text=filter.end();if(text)target.write(text);});
  }
  try{return await new Promise<number>(ok=>{child.once('error',()=>{process.stderr.write('Project service executable could not start.\n');ok(1);});child.once('close',(code,signal)=>ok(code??(signal==='SIGINT'?130:signal==='SIGTERM'?143:1)));});}
  finally{process.off('SIGTERM',term);process.off('SIGINT',interrupt);}
}

if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href){
  try{process.exitCode=await launchProjectService(process.argv[2]??'');}
  catch{process.stderr.write('Project service launch failed; check its runtime and credential configuration.\n');process.exitCode=1;}
}
