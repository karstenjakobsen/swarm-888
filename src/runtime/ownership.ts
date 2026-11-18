import { closeSync, constants, fchownSync, fstatSync, openSync, readdirSync, readlinkSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from '../config.ts';
import { inside } from './execution.ts';

/** Inspect only real files and directories. Mutate the opened object, even if its name changes. */
export function repairTreeOwnership(root:string,controllerUid:number):number {
  let visited=0;
  const visit=(path:string):void=>{
    let descriptor:number|undefined;
    try{
      if(realpathSync(path)!==path)return;
      descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      const stat=fstatSync(descriptor);
      if(!stat.isDirectory()&&(!stat.isFile()||stat.nlink!==1))return;
      if(readlinkSync(`/proc/self/fd/${descriptor}`)!==path)return;
      if(stat.uid!==controllerUid)fchownSync(descriptor,controllerUid,-1);
      visited++;
      if(stat.isDirectory())for(const name of readdirSync(path))visit(join(path,name));
    }catch{/* A task may remove files during a repair pass. */}
    finally{if(descriptor!==undefined)closeSync(descriptor);}
  };
  visit(root);
  return visited;
}

/** In-state projects retain their existing ownership rules. External roots only expose managed repositories. */
export function repairProjectOwnership(config:Pick<Config,'projectsDir'|'stateDir'|'controllerUid'>):number {
  const projects=resolve(config.projectsDir??join(config.stateDir,'projects'));
  const root=inside(config.stateDir,projects)?projects:join(projects,'repositories');
  return repairTreeOwnership(root,config.controllerUid);
}
