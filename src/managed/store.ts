import type { DatabaseSync } from 'node:sqlite';
import type { RunStatus } from '../shared.ts';
import type { ProjectDeployment } from '../projects/schemas.ts';
import { managedSourceSchema, type ManagedKind, type ManagedSource } from './schemas.ts';

export interface SourceAssociation {kind:ManagedKind;packageId:string;source:ManagedSource}

/** Persistence for generated source and deployment observations. Git/host operations stay in services. */
export class ManagedStore {
  constructor(private db:DatabaseSync){}
  source(projectId:string):SourceAssociation|undefined {
    const row=this.db.prepare('SELECT kind,packageId,source FROM project_sources WHERE projectId=?').get(projectId) as {kind:ManagedKind;packageId:string;source:string}|undefined;
    return row?{...row,source:managedSourceSchema.parse(JSON.parse(row.source))}:undefined;
  }
  saveSource(projectId:string,kind:ManagedKind,source:ManagedSource){
    this.db.prepare('INSERT INTO project_sources(projectId,kind,packageId,source,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET source=excluded.source,updatedAt=excluded.updatedAt').run(projectId,kind,projectId,JSON.stringify(source),new Date().toISOString());
  }
  beginFinalization(runId:string,projectId:string){
    this.db.prepare("INSERT OR IGNORE INTO source_finalizations(runId,projectId,state,updatedAt) VALUES(?,?,'pending',?)").run(runId,projectId,new Date().toISOString());
  }
  finalizationCommitted(runId:string):boolean {
    return (this.db.prepare('SELECT state FROM source_finalizations WHERE runId=?').get(runId) as {state:string}|undefined)?.state==='committed';
  }
  finalizationFailed(runId:string,message:string){
    this.db.prepare('UPDATE source_finalizations SET error=?,updatedAt=? WHERE runId=?').run(message.slice(0,4000),new Date().toISOString(),runId);
  }
  finalized(runId:string,commit:string):boolean {
    return Boolean(this.db.prepare("UPDATE source_finalizations SET state='committed',commitSha=?,error=NULL,updatedAt=? WHERE runId=? AND state='pending'").run(commit,new Date().toISOString(),runId).changes);
  }
  pendingFinalizations(){
    return this.db.prepare("SELECT r.id,r.conversationId,r.status FROM source_finalizations sf JOIN runs r ON r.id=sf.runId WHERE sf.state='pending' ORDER BY r.finishedAt,r.id").all() as {id:string;conversationId:string;status:RunStatus}[];
  }
  saveDeployment(projectId:string,input:ProjectDeployment){
    this.db.prepare('INSERT INTO project_deployments(projectId,commitSha,releaseDirectory,unitName,status,detail,checkedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET commitSha=excluded.commitSha,releaseDirectory=excluded.releaseDirectory,unitName=excluded.unitName,status=excluded.status,detail=excluded.detail,checkedAt=excluded.checkedAt WHERE julianday(excluded.checkedAt)>=julianday(project_deployments.checkedAt)').run(projectId,input.commit,input.releaseDirectory,input.unitName,input.status,input.detail,input.checkedAt);
  }
}
