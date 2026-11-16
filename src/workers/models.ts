import { closeSync,constants,fstatSync,lstatSync,openSync,readSync,realpathSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { WorkerRegistry } from './registry.ts';
import { ownWorkerConfig } from './config.ts';
import { workerEffort } from './schemas.ts';
import { workerModelSchema,type WorkerModel,type WorkerModelCatalog } from './models-schema.ts';

const maxCacheBytes=4*1024*1024;
const cachedModel=z.object({slug:z.string().min(1).max(200),display_name:z.string().min(1).max(200),description:z.string().max(4000),visibility:z.string(),supported_reasoning_levels:z.array(z.object({effort:z.string()})).max(20),default_reasoning_level:z.string().optional()});
const cacheSchema=z.object({models:z.array(z.unknown()).max(1000)});

/** The Codex cache contains instructions and account metadata; publish only display fields. */
export function cachedModels(raw:unknown):WorkerModel[] {
  const result:WorkerModel[]=[],seen=new Set<string>();
  for(const value of cacheSchema.parse(raw).models){
    const parsed=cachedModel.safeParse(value);if(!parsed.success||parsed.data.visibility!=='list')continue;
    const model=parsed.data;if(seen.has(model.slug))continue;seen.add(model.slug);
    const efforts=model.supported_reasoning_levels.flatMap(({effort})=>{const parsed=workerEffort.safeParse(effort);return parsed.success?[parsed.data]:[];}),defaultEffort=workerEffort.safeParse(model.default_reasoning_level);
    result.push(workerModelSchema.parse({id:model.slug,name:model.display_name,description:model.description,supportedEfforts:[...new Set(efforts)],defaultEffort:defaultEffort.success&&efforts.includes(defaultEffort.data)?defaultEffort.data:null,isDefault:false}));
  }
  return result;
}

export function readCachedModels(runtimeHome:string,controllerUid:number):WorkerModel[] {
  const root=resolve(runtimeHome);let fd:number|undefined;
  try{
    const directory=lstatSync(root);if(!directory.isDirectory()||directory.isSymbolicLink()||directory.uid!==controllerUid||realpathSync(root)!==root)return [];
    fd=openSync(join(root,'models_cache.json'),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    const info=fstatSync(fd);if(!info.isFile()||info.uid!==controllerUid||info.size>maxCacheBytes)return [];
    const content=Buffer.alloc(Math.min(info.size+1,maxCacheBytes+1));let size=0;
    while(size<content.length){const read=readSync(fd,content,size,content.length-size,null);if(!read)break;size+=read;}
    if(size>info.size||size>maxCacheBytes)return [];
    return cachedModels(JSON.parse(content.subarray(0,size).toString('utf8')));
  }catch{return [];}finally{if(fd!==undefined)closeSync(fd);}
}

/** Read-only catalog discovery has a bounded wait and never starts inference or changes worker settings. */
export class WorkerModelCatalogService {
  private pending?:Promise<WorkerModelCatalog>;
  constructor(private config:Config,private registry:WorkerRegistry){}
  list():Promise<WorkerModelCatalog>{
    if(this.pending)return this.pending;
    const operation=this.load();this.pending=operation;
    void operation.finally(()=>{if(this.pending===operation)this.pending=undefined;}).catch(()=>{});return operation;
  }
  private async load():Promise<WorkerModelCatalog>{
    const workers=this.registry.list(),deadline=Date.now()+2500;
    for(const worker of workers){
      const health=this.registry.cachedHealth(worker.id);if(!health||health.runtime.authenticating||health.replacementReserved)continue;
      const remaining=deadline-Date.now();if(remaining<=0)break;
      let timeout:NodeJS.Timeout|undefined;
      try{
        const raw=await Promise.race([this.registry.client(worker.id).request('models/list',{}),new Promise<never>((_,reject)=>{timeout=setTimeout(()=>reject(new Error('Model catalog lookup timed out')),Math.min(remaining,1250));})]);
        const models=z.array(workerModelSchema).max(1000).parse(raw);if(models.length)return {models,source:'worker',detail:'Available models from a connected worker. The new worker confirms availability after sign-in.'};
      }catch{/* Older, busy or unavailable workers can still have a usable local catalog. */}finally{clearTimeout(timeout);}
    }
    const profiles=[this.config.runtimeHome,...workers.map(worker=>ownWorkerConfig(this.config,worker).runtimeHome)];
    for(const profile of new Set(profiles)){
      const models=readCachedModels(profile,this.config.controllerUid);if(models.length)return {models,source:'cache',detail:'Using the saved Codex model catalog. The worker confirms model availability when started.'};
    }
    return {models:[],source:'unavailable',detail:'No model catalog is available yet. Start and connect the default worker, then retry.'};
  }
}
