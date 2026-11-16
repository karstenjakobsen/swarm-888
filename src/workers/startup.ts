import { loadConfig, type Config } from '../config.ts';
import { join } from 'node:path';
import { ownWorkerConfig } from './config.ts';
import { readWorkerManifest, writeWorkerManifest } from './manifest.ts';
import { workerCreateInput, workerEffort, workerId, workerMode, type WorkerRecord } from './schemas.ts';

export function workerArguments(args:string[]):{id?:string;name?:string;model?:string;effort?:WorkerRecord['effort'];mode?:WorkerRecord['mode']} {
  const input:Record<string,string>={};
  for(let index=0;index<args.length;index++){
    const equal=args[index].indexOf('='),option=equal<0?args[index]:args[index].slice(0,equal),inline=equal<0?undefined:args[index].slice(equal+1),name=option.replace(/^--/,'');if(!option.startsWith('--')||!['id','name','model','effort','mode'].includes(name)||name in input)throw new Error('Usage: npm run worker -- --id ID --model MODEL [--effort high] [--mode user|root]');
    const value=inline??args[++index];if(!value||value.startsWith('--'))throw new Error(`Worker --${name} needs a value.`);input[name]=value;
  }
  return {...input,...(input.id?{id:workerId.parse(input.id)}:{}),...(input.effort?{effort:workerEffort.parse(input.effort)}:{}),...(input.mode?{mode:workerMode.parse(input.mode)}:{})};
}
export function loadWorkerConfig(args:string[]=process.argv.slice(2),options:{root?:boolean}={}):Config {
  const input=workerArguments(args),base=loadConfig(),id=input.id??base.workerId;
  if(!id||id==='default')return {...base,workerId:undefined,workerDir:undefined,socketPath:join(base.stateDir,'worker.sock'),runtimeHome:join(base.stateDir,'runtime'),model:input.model??base.model,effort:input.effort??base.effort,...(options.root?{workerMode:'root' as const,requireRootWorker:true}:input.mode?{workerMode:input.mode,requireRootWorker:input.mode==='root'}:{})};
  const previous=readWorkerManifest(base,id),mode=options.root?'root':input.mode??previous?.mode??base.workerMode??'user',model=input.model??previous?.model??base.model;
  if(!model)throw new Error('A new named worker requires --model MODEL or an explicit CODEX_MODEL. No provider default is pinned implicitly.');
  const parsed=workerCreateInput.parse({id,name:input.name??previous?.name??id,model,effort:input.effort??(previous?previous.effort:base.effort),mode,enabled:previous?.enabled??true});
  if(previous&&(previous.model!==parsed.model||previous.mode!==parsed.mode||(previous.effort??null)!==(parsed.effort??null)))throw new Error('Worker startup model, effort and mode are pinned. Register a new ID instead of changing a live worker.');
  const now=new Date().toISOString(),record:WorkerRecord=previous??{...parsed,draining:false,createdAt:now,updatedAt:now};if(!previous)writeWorkerManifest(base,record);
  return ownWorkerConfig(base,record);
}
