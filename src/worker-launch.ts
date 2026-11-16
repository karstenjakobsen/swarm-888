import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { projectRoot, type Config } from './config.ts';

/** Capture controller configuration before sudo changes the process environment. */
export function workerLaunch(config:Config){
  const loader=createRequire(import.meta.url).resolve('tsx');
  const runtimePath=[join(projectRoot,'node_modules/.bin'),dirname(process.execPath),'/usr/local/sbin','/usr/local/bin','/usr/sbin','/usr/bin','/sbin','/bin'].join(':');
  const root=config.workerMode?config.workerMode==='root':config.requireRootWorker===true;
  const env=[`APP_STATE_DIR=${config.stateDir}`,`APP_CONTROLLER_UID=${config.controllerUid}`,`APP_REQUIRE_ROOT_WORKER=${root}`,`CODEX_BIN=${config.codexBin}`,`PATH=${runtimePath}`,
    `APP_PROJECTS_DIR=${resolve(config.projectsDir??join(config.stateDir,'projects'))}`,
    `APP_ALLOW_TEMP_STATE=${config.allowTempState}`,`CODEX_MODEL=${config.model??''}`,`CODEX_EFFORT=${config.effort??''}`,`APP_WORKER_ID=${config.workerId??''}`,`APP_WORKER_MODE=${root?'root':'user'}`];
  const args=['env',...env,process.execPath,`--env-file-if-exists=${join(projectRoot,'.env')}`,'--import',loader,join(projectRoot,root?'src/root-worker.ts':'src/worker.ts')];
  const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
  return {args,command:(root?['sudo','--',...args]:args).map(quote).join(' ')};
}
