import type { DatabaseSync } from 'node:sqlite';

const fail=(message:string)=>Object.assign(new Error(message),{statusCode:409});

/** A task owns the repository until execution and source finalization finish. */
export function assertRepositoryWritable(db:DatabaseSync,repositoryId:string,runId?:string){
  const lease=db.prepare('SELECT runId FROM repository_leases WHERE repositoryId=?').get(repositoryId) as {runId:string}|undefined;
  if(lease&&lease.runId!==runId)throw fail('Another task owns this repository until execution and source finalization finish.');
}

export function acquireRepository(db:DatabaseSync,repositoryId:string,runId:string){
  assertRepositoryWritable(db,repositoryId,runId);
  db.prepare('INSERT OR IGNORE INTO repository_leases(repositoryId,runId,acquiredAt) VALUES(?,?,?)').run(repositoryId,runId,new Date().toISOString());
}

export function projectRepository(db:DatabaseSync,projectId:string):string|undefined {
  return (db.prepare("SELECT json_extract(source,'$.repositoryId') AS repositoryId FROM project_sources WHERE projectId=?").get(projectId) as {repositoryId?:string}|undefined)?.repositoryId??undefined;
}
