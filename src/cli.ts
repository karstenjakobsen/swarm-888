import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { loadConfig } from './config.ts';
import { Store } from './store.ts';
import { Brain } from './brain/index.ts';
import { exportBrain, restoreBrain } from './backup.ts';
import { acquireLock } from './lock.ts';
import { executionCommand, executionEnvironment, prepareExecutionProfile, verifyExecutionProtection } from './runtime/protection.ts';

async function main(){
  const [command,argument]=process.argv.slice(2),config=loadConfig();
  switch(command){
    case'init':{
      const release=acquireLock(resolve(config.stateDir,'controller.lock'));
      try{const store=new Store(config.stateDir);try{const brain=new Brain(store.db,config.stateDir);await brain.initialize();console.log(`Initialized persistent state: ${config.stateDir}`);}finally{store.close();}}finally{release();}break;
    }
    case'auth':{
      const mode=argument??'--with-api-key';
      if(!['--with-api-key','--device-auth','status'].includes(mode)||process.argv.length>4)throw new Error('Usage: npm run auth [-- --device-auth | -- status]. The default reads an API key from stdin.');
      if(config.protectOperator){verifyExecutionProtection(config);prepareExecutionProfile(config);}
      // The key is read by Codex from stdin. No key in argv, browser, or application logs.
      if(mode==='--with-api-key'&&process.stdin.isTTY)console.error('Pipe an OpenAI API key into this command, or use npm run auth -- --device-auth to sign in with ChatGPT. Only the application’s dedicated Codex profile is changed.');
      let release=()=>{};
      if(mode!=='status'){
        try{release=acquireLock(resolve(config.stateDir,'worker/lock.json'));}
        catch{throw new Error('Stop the worker with Ctrl+C before authenticating, then run this command again. Start npm run worker after login succeeds; queued tasks will resume.');}
      }
      try{
        const command=executionCommand(config,config.codexBin,['login',mode]);
        const child=spawn(command.command,command.args,{env:{...executionEnvironment(config),CODEX_HOME:config.runtimeHome},stdio:'inherit'});
        const code=await new Promise<number>((ok,no)=>{child.on('error',no);child.on('exit',code=>ok(code??1));});
        if(code){if(mode==='status')process.exitCode=code;else throw new Error(`Codex authentication failed (exit ${code})`);}
      }finally{release();}break;
    }
    case'export':if(!argument)throw new Error('Usage: npm run brain:export -- /absolute/snapshot-directory');console.log(JSON.stringify(await exportBrain(config,argument)));break;
    case'restore':if(!argument)throw new Error('Usage: APP_STATE_DIR=/fresh/state npm run brain:restore -- /absolute/snapshot-directory');console.log(JSON.stringify(await restoreBrain(config,argument)));break;
    default:throw new Error('Use init, auth, export DIRECTORY, or restore DIRECTORY');
  }
}
main().catch(error=>{console.error(error.message);process.exitCode=1;});
