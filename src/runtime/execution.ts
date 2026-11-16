import { lchownSync, lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Config } from '../config.ts';
import { prepareWorkerDirectory, workerDirectory } from '../workers/config.ts';

export function inside(root:string,path:string):boolean {
  const rel=relative(resolve(root),resolve(path));
  return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));
}

/** Commands deliberately inherit the worker's actual OS identity, including root. */
export function executionCommand(_config:Config,command:string,args:string[]):{command:string;args:string[]} {
  return {command,args};
}

/** Keep controller credentials out of child environments without claiming OS isolation. */
export function executionEnvironment(_config:Config):NodeJS.ProcessEnv {
  const environment={...process.env};
  for(const key of ['ADMIN_PASSWORD','APP_BRIDGE_TOKEN','APP_STATE_DIR','APP_CONTROLLER_UID'])delete environment[key];
  return environment;
}

export function prepareExecutionDirectory(config:Config,directory:string):void {
  const path=resolve(directory),projects=resolve(config.projectsDir??join(config.stateDir,'projects')),workspaces=resolve(config.stateDir,'workspaces');
  if((!inside(projects,path)||path===projects)&&(!inside(workspaces,path)||path===workspaces))throw new Error('Execution workspace must be inside APP_PROJECTS_DIR or the conversation workspace directory.');
  let ancestor=path;
  while(true){
    try{if(realpathSync(ancestor)!==ancestor)throw new Error('Execution workspace must be canonical without symlinks.');break;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;ancestor=resolve(ancestor,'..');}
  }
  const first=mkdirSync(path,{recursive:true,mode:0o700});
  if(first&&process.getuid?.()===0){
    const pieces=relative(first,path).split(sep).filter(Boolean);let current=first;
    for(const piece of [undefined,...pieces]){
      if(piece)current=join(current,piece);
      if(!lstatSync(current).isDirectory())throw new Error('New project directories must remain real directories.');
      lchownSync(current,config.controllerUid,-1);
    }
  }
  if(realpathSync(path)!==path)throw new Error('Execution workspace must be canonical without symlinks.');
}

export function prepareExecutionProfile(config:Config):void {
  if(config.workerId)prepareWorkerDirectory(config);
  mkdirSync(config.runtimeHome,{recursive:true,mode:0o700});
  if(realpathSync(config.runtimeHome)!==resolve(config.runtimeHome))throw new Error('Codex profile must be a canonical directory.');
}

export function trustedExecutionDirectory(config:Config,name:string):string {
  if(!/^[a-z][a-z-]*$/.test(name))throw new Error('Invalid worker runtime directory.');
  const path=join(workerDirectory(config),name);
  mkdirSync(path,{recursive:true,mode:0o700});
  if(realpathSync(path)!==resolve(path))throw new Error('Worker runtime directory must be canonical.');
  return path;
}
