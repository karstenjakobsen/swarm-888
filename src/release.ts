import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { projectRoot } from './config.ts';

export interface ReleaseInfo { readonly commit:string|null }

/** Read the source checkout once; a running controller must not follow later pulls. */
export function captureRelease(directory:string):Readonly<ReleaseInfo> {
  try {
    const env:NodeJS.ProcessEnv={...process.env};
    for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
    Object.assign(env,{GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'});
    const output=execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',directory,'rev-parse','--show-toplevel','--verify','HEAD'],{
      env,encoding:'utf8',stdio:['ignore','pipe','pipe'],timeout:2000,maxBuffer:16_000,
    }).trim().split('\n');
    const [root,commit]=output;
    if(root&&commit&&realpathSync(root)===realpathSync(directory)&&/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(commit))return Object.freeze({commit});
  }catch{ /* Source archives and development fixtures may not contain Git metadata. */ }
  return Object.freeze({commit:null});
}

export const release=captureRelease(projectRoot);
