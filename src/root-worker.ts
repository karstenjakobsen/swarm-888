import { readFileSync, realpathSync, existsSync, lstatSync } from 'node:fs';
import { join, resolve, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, projectRoot, type Config } from './config.ts';
import { WorkerClient, type WorkerHealth } from './ipc.ts';
import { WorkerServer } from './worker.ts';
import { processStamp } from './runtime/processes.ts';

export interface WorkerReplacementIdentity {
  lock:{pid:number;start:string|null};start:string|null;args:string[];cwd:string;
  realUid:number;effectiveUid:number;callerUid:number;callerEffectiveUid:number;
}

function nodeScript(args:string[]):string|undefined {
  const values=new Set(['--import','--require','-r','--loader','--experimental-loader','--env-file','--env-file-if-exists']);
  for(let index=1;index<args.length;index++){
    const arg=args[index]!;
    if(arg==='--')return args[index+1];
    if(values.has(arg)){if(!args[index+1])return;index++;continue;}
    if([...values].some(option=>option.startsWith('--')&&arg.startsWith(`${option}=`))||['--enable-source-maps','--no-warnings','--trace-warnings'].includes(arg))continue;
    if(arg.startsWith('-'))return;
    return arg;
  }
}

/** Pure evidence validation; calling this function never signals a process. */
export function verifyWorkerReplacementIdentity(config:Pick<Config,'controllerUid'>,health:Pick<WorkerHealth,'pid'|'uid'|'root'>,identity:WorkerReplacementIdentity):void {
  const source=resolve(projectRoot),script=nodeScript(identity.args),validEntry=Boolean(script&&['worker.ts','root-worker.ts'].some(name=>script===join(source,'src',name)||(resolve(identity.cwd)===source&&!isAbsolute(script)&&resolve(identity.cwd,script)===join(source,'src',name))));
  if(!isAbsolute(identity.cwd)||identity.cwd!==resolve(identity.cwd)||identity.lock.pid!==health.pid||!identity.lock.start||identity.start!==identity.lock.start||!validEntry)throw new Error('Cannot verify the existing worker process identity. It has not been stopped.');
  if(health.root!==(health.uid===0)||identity.realUid!==health.uid||identity.effectiveUid!==health.uid)throw new Error('Existing worker ownership does not match its reported identity. It has not been stopped.');
  if(health.uid===0){
    if(identity.callerUid!==0||identity.callerEffectiveUid!==0)throw new Error('Replacing an existing root worker requires root access. It has not been stopped.');
  }else if(health.uid!==config.controllerUid)throw new Error('Existing worker ownership does not match the controller. It has not been stopped.');
}

/** Replace only this application's verified idle worker after privileged launch. */
export async function replaceIdleWorker(config:Config):Promise<boolean>{
  if(!existsSync(config.socketPath))return true;
  const client=new WorkerClient(config);
  let reserved=false;
  try{
    let health;
    try{health=await client.connect();}catch(error){if((error as NodeJS.ErrnoException).code==='ECONNREFUSED')return true;throw error;}
    const existingRoot=health.uid===0&&health.root;
    if(existingRoot){
      if(health.executionUid!==undefined&&health.executionUid!==0)throw new Error('The existing worker uses a separate non-root execution account. Stop it in its terminal, then run this root-worker command again.');
      const expected=resolve(config.projectsDir??join(config.stateDir,'projects'));
      if(health.projectsDir===expected)return false;
    }
    if(health.activeRunId||health.uncertainRuns.length||health.runtimeOperations?.length||health.runtime.authenticating)throw new Error('The existing worker is busy or uncertain. Finish, interrupt, or reconcile its work before replacing it with the root worker.');
    if(existingRoot&&(process.getuid?.()!==0||process.geteuid?.()!==0))throw new Error(`Root access is required to replace the existing root worker (expected APP_PROJECTS_DIR=${resolve(config.projectsDir??join(config.stateDir,'projects'))}; reported ${health.projectsDir??'unknown (older worker)'}). Run the fresh root-worker launch command.`);
    try{
      const reservation=await client.request('worker/reserve-root-replacement',{});
      if(!reservation?.reserved||reservation.pid!==health.pid||reservation.uid!==health.uid)throw new Error('Unexpected worker reservation identity');
      reserved=true;
    }catch{throw new Error('The existing worker could not reserve idle execution for replacement. Stop the older worker in its terminal, then run this root-worker command again.');}
    const lockPath=join(config.stateDir,'worker/lock.json');
    const lockInfo=lstatSync(lockPath);if(!lockInfo.isFile()||lockInfo.isSymbolicLink())throw new Error('Cannot verify the existing worker lock file. It has not been stopped.');
    const lock=JSON.parse(readFileSync(lockPath,'utf8'));
    const args=readFileSync(`/proc/${health.pid}/cmdline`,'utf8').split('\0');
    const cwd=realpathSync(`/proc/${health.pid}/cwd`);
    const uids=/^Uid:\s+(\d+)\s+(\d+)/m.exec(readFileSync(`/proc/${health.pid}/status`,'utf8'));
    verifyWorkerReplacementIdentity(config,health,{lock,start:processStamp(health.pid),args,cwd,realUid:uids?Number(uids[1]):-1,effectiveUid:uids?Number(uids[2]):-1,callerUid:process.getuid?.()??-1,callerEffectiveUid:process.geteuid?.()??-1});
    if(processStamp(health.pid)!==lock.start)throw new Error('The existing worker process identity changed before replacement. It has not been stopped.');
    process.kill(health.pid,'SIGTERM');
    const deadline=Date.now()+15_000;
    while(existsSync(lockPath)&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,100));
    if(existsSync(lockPath))throw new Error('The previous worker has not finished shutdown. The root worker was not started.');
    return true;
  }finally{
    if(reserved)try{await client.request('worker/release-root-replacement',{});}catch{}
    client.close();
  }
}

// Kept for callers of the previous launcher API.
export const replaceIdleNonRootWorker=replaceIdleWorker;

async function main(){
  if(process.getuid?.()!==0)throw new Error('Root worker launch requires sudo. Use the root-worker command shown by Connect agent.');
  const config=loadConfig();config.requireRootWorker=true;
  if(!await replaceIdleWorker(config)){console.log('The root worker is already running.');return;}
  const worker=new WorkerServer(config);await worker.listen();
  console.log(`Root worker connected on the private Unix socket; execution UID ${worker.health().executionUid}. Operator-source guardrail is prompt only.`);
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{if(!stopping){stopping=true;void worker.close().then(()=>process.exit(0));}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
