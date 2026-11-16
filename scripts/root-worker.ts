import { spawn } from 'node:child_process';
import { loadConfig, projectRoot } from '../src/config.ts';
import { workerLaunch } from '../src/worker-launch.ts';
import { loadWorkerConfig } from '../src/workers/startup.ts';

async function main(){
  if(process.getuid?.()===0)throw new Error('Run npm run worker:root as your normal controller user. This command requests sudo itself after capturing your configuration.');
  const config=loadWorkerConfig(process.argv.slice(2),{root:true}),launch=workerLaunch(config);
  console.log(`Starting the root worker with APP_PROJECTS_DIR=${config.projectsDir}. Enter your sudo password here if requested.`);
  const child=spawn('sudo',['--',...launch.args],{cwd:projectRoot,stdio:'inherit'});
  process.exitCode=await new Promise<number>((ok,no)=>{child.once('error',no);child.once('exit',(code,signal)=>ok(code??(signal?130:1)));});
}
main().catch(error=>{console.error(error instanceof Error?error.message:String(error));process.exitCode=1;});
