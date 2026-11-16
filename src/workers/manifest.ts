import { randomUUID } from 'node:crypto';
import { existsSync, lchownSync, lstatSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Config } from '../config.ts';
import { ownWorkerConfig, prepareWorkerDirectory } from './config.ts';
import { workerId, workerRecordSchema, type WorkerRecord } from './schemas.ts';

export function manifestPath(config:Config,id:string):string {return join(config.stateDir,'workers',workerId.parse(id),'registration.json');}
export function readWorkerManifest(config:Config,id:string):WorkerRecord|undefined {
  const path=manifestPath(config,id);if(!existsSync(path))return;
  const stat=lstatSync(path);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==config.controllerUid||(stat.mode&0o077)!==0||realpathSync(path)!==path||stat.size>16_000)throw new Error('Worker registration manifest must be canonical, private, and controller-owned.');
  const record=workerRecordSchema.parse(JSON.parse(readFileSync(path,'utf8')));if(record.id!==id||record.id==='default'||!record.model)throw new Error('Worker registration manifest identity/model is invalid.');return record;
}
export function writeWorkerManifest(config:Config,record:WorkerRecord):void {
  if(record.id==='default')return;const own=ownWorkerConfig(config,record);prepareWorkerDirectory(own);
  if(Buffer.byteLength(own.socketPath)>107)throw new Error('Worker socket path is too long. Use a shorter worker ID or a shorter persistent APP_STATE_DIR.');
  const target=manifestPath(config,record.id),temporary=`${target}.${randomUUID()}`;
  if(existsSync(target)&&(!lstatSync(target).isFile()||lstatSync(target).isSymbolicLink()))throw new Error('Worker registration cannot replace a symlink or non-file.');
  try{writeFileSync(temporary,JSON.stringify(record),{flag:'wx',mode:0o600});if(process.getuid?.()===0)lchownSync(temporary,config.controllerUid,-1);renameSync(temporary,target);}finally{rmSync(temporary,{force:true});}
}
export function workerManifests(config:Config):WorkerRecord[]{
  const root=join(config.stateDir,'workers');if(!existsSync(root))return [];
  if(realpathSync(root)!==root||lstatSync(root).isSymbolicLink())throw new Error('Worker registration directory must be canonical.');
  return readdirSync(root).filter(id=>id!=='default'&&workerId.safeParse(id).success).flatMap(id=>{const record=readWorkerManifest(config,id);return record?[record]:[];});
}
