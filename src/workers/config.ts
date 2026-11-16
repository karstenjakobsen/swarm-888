import { chmodSync, lchownSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { workerId, workerRecordSchema, type WorkerRecord } from './schemas.ts';

export function workerDirectory(config:Pick<Config,'stateDir'|'workerDir'|'workerId'>):string {return config.workerDir??(config.workerId?join(config.stateDir,'workers',config.workerId):join(config.stateDir,'worker'));}
export function prepareWorkerDirectory(config:Config):void {
  if(config.workerId){
    const expected=join(resolve(config.stateDir),'workers',config.workerId);
    if(resolve(workerDirectory(config))!==expected||resolve(config.runtimeHome)!==join(expected,'runtime')||resolve(config.socketPath)!==join(expected,'worker.sock'))throw new Error('Named worker state, socket and profile must stay inside its own registered worker directory.');
  }
  const paths=config.workerId?[join(config.stateDir,'workers'),workerDirectory(config),config.runtimeHome]:[workerDirectory(config),config.runtimeHome];
  for(const path of paths){
    mkdirSync(path,{recursive:true,mode:0o700});const stat=lstatSync(path);
    if(!stat.isDirectory()||stat.isSymbolicLink()||realpathSync(path)!==resolve(path))throw new Error('Worker state directories must be canonical without symlinks.');
    if(process.getuid?.()===0)lchownSync(path,config.controllerUid,-1);
    if(lstatSync(path).uid!==config.controllerUid)throw new Error('Worker state directories must belong to the controller user.');
    chmodSync(path,0o700);
  }
}
export function ownWorkerConfig(base:Config,raw:WorkerRecord):Config {
  const record=workerRecordSchema.parse(raw);if(record.id==='default')return {...base,workerId:undefined,workerDir:undefined,model:record.model??undefined,effort:record.effort,workerMode:record.mode,requireRootWorker:record.mode==='root',socketPath:join(base.stateDir,'worker.sock'),runtimeHome:join(base.stateDir,'runtime')};
  workerId.parse(record.id);const directory=join(base.stateDir,'workers',record.id);
  return {...base,workerId:record.id,workerDir:directory,socketPath:join(directory,'worker.sock'),runtimeHome:join(directory,'runtime'),model:record.model??undefined,effort:record.effort,workerMode:record.mode,requireRootWorker:record.mode==='root'};
}
