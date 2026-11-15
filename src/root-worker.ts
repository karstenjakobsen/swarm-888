import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, projectRoot, type Config } from './config.ts';
import { WorkerClient } from './ipc.ts';
import { WorkerServer } from './worker.ts';
import { processStamp } from './runtime/processes.ts';

/** Replace only this application's verified, idle non-root worker after root access is granted. */
export async function replaceIdleNonRootWorker(config:Config):Promise<boolean>{
  if(!existsSync(config.socketPath))return true;
  const client=new WorkerClient(config);
  let reserved=false;
  try{
    let health;
    try{health=await client.connect();}catch(error){if((error as NodeJS.ErrnoException).code==='ECONNREFUSED')return true;throw error;}
    if(health.uid===0&&health.root)return false;
    if(health.activeRunId||health.uncertainRuns.length||health.runtime.authenticating)throw new Error('The existing worker is busy or uncertain. Finish, interrupt, or reconcile its work before replacing it with the root worker.');
    try{
      const reservation=await client.request('worker/reserve-root-replacement',{});
      if(!reservation?.reserved||reservation.pid!==health.pid||reservation.uid!==health.uid)throw new Error('Unexpected worker reservation identity');
      reserved=true;
    }catch{throw new Error('The existing worker could not reserve idle execution for replacement. Stop the older worker in its terminal, then run this root-worker command again.');}
    const lockPath=join(config.stateDir,'worker/lock.json');
    const lock=JSON.parse(readFileSync(lockPath,'utf8'));
    const args=readFileSync(`/proc/${health.pid}/cmdline`,'utf8').split('\0');
    const cwd=realpathSync(`/proc/${health.pid}/cwd`);
    const entry=join(projectRoot,'src/worker.ts');
    const validEntry=args.some(arg=>arg===entry||(resolve(cwd)===resolve(projectRoot)&&arg==='src/worker.ts'));
    if(lock.pid!==health.pid||!lock.start||processStamp(health.pid)!==lock.start||!validEntry)throw new Error('Cannot verify the existing worker process identity. It has not been stopped.');
    const uids=/^Uid:\s+(\d+)\s+(\d+)/m.exec(readFileSync(`/proc/${health.pid}/status`,'utf8'));
    if(!uids||Number(uids[2])!==health.uid||health.uid!==config.controllerUid)throw new Error('Existing worker ownership does not match the controller. It has not been stopped.');
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

async function main(){
  if(process.getuid?.()!==0)throw new Error('Root worker launch requires sudo. Use the root-worker command shown by Connect agent.');
  const config=loadConfig();config.requireRootWorker=true;
  if(!await replaceIdleNonRootWorker(config)){console.log('The root worker is already running.');return;}
  const worker=new WorkerServer(config);await worker.listen();
  console.log(`Root worker connected on the private Unix socket; UID ${process.getuid?.()}.`);
  let stopping=false;for(const signal of ['SIGINT','SIGTERM'] as const)process.once(signal,()=>{if(!stopping){stopping=true;void worker.close().then(()=>process.exit(0));}});
}
if(process.argv[1]&&import.meta.url===pathToFileURL(resolve(process.argv[1])).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
