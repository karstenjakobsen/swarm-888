import type { DatabaseSync } from 'node:sqlite';
import type { RunStatus } from '../shared.ts';
import type { ProjectDeployment } from '../projects/schemas.ts';
import { managedSourceSchema, type ManagedKind, type ManagedSource } from './schemas.ts';

export interface SourceAssociation {kind:ManagedKind;packageId:string;source:ManagedSource}

/** Persistence for generated source and deployment observations. Git/host operations stay in services. */
export class ManagedStore {
  constructor(private db:DatabaseSync){}
  ownsLegacyId(id:string):boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM projects WHERE id=?
      UNION ALL SELECT 1 FROM project_sources WHERE packageId=?
      UNION ALL SELECT 1 FROM skill_sources WHERE packageId=?
      LIMIT 1
    `).get(id,id,id));
  }
  hasPendingFinalization(runId:string):boolean {
    return Boolean(this.db.prepare(`
      SELECT 1 FROM source_finalizations WHERE runId=? AND state='pending'
      UNION ALL SELECT 1 FROM package_finalizations WHERE runId=? AND state='pending'
      LIMIT 1
    `).get(runId,runId));
  }
  writablePackagePaths(repositoryId:string,runId:string):string[] {
    const paths=this.db.prepare(`
      SELECT p.path FROM package_finalizations pf JOIN packages p ON p.id=pf.packageId
       WHERE pf.runId=? AND p.repositoryId=?
      UNION
      SELECT p.path FROM project_sources ps JOIN packages p ON p.id=ps.packageId
        JOIN project_conversations pc ON pc.projectId=ps.projectId
        JOIN runs r ON r.conversationId=pc.conversationId
       WHERE r.id=? AND p.repositoryId=?
    `).all(runId,repositoryId,runId,repositoryId) as {path:string}[];
    return paths.map(row=>row.path);
  }
  refreshPackageSource(packageId:string,source:ManagedSource):void {
    const encoded=JSON.stringify(source);
    this.db.prepare('UPDATE project_sources SET source=?,updatedAt=? WHERE packageId=?').run(encoded,new Date().toISOString(),packageId);
    this.db.prepare('UPDATE skill_sources SET source=? WHERE packageId=?').run(encoded,packageId);
  }
  source(projectId:string):SourceAssociation|undefined {
    const row=this.db.prepare('SELECT kind,packageId,source FROM project_sources WHERE projectId=?').get(projectId) as {kind:ManagedKind;packageId:string;source:string}|undefined;
    return row?{...row,source:managedSourceSchema.parse(JSON.parse(row.source))}:undefined;
  }
  saveSource(projectId:string,kind:ManagedKind,source:ManagedSource,packageId=source.packageId??projectId){
    this.db.prepare('INSERT INTO project_sources(projectId,kind,packageId,source,updatedAt) VALUES(?,?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET kind=excluded.kind,packageId=excluded.packageId,source=excluded.source,updatedAt=excluded.updatedAt').run(projectId,kind,packageId,JSON.stringify(source),new Date().toISOString());
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
    return this.db.prepare("SELECT r.id,r.conversationId,r.status FROM runs r WHERE r.status IN ('completed','failed','interrupted') AND (EXISTS(SELECT 1 FROM source_finalizations sf WHERE sf.runId=r.id AND sf.state='pending') OR EXISTS(SELECT 1 FROM package_finalizations pf WHERE pf.runId=r.id AND pf.state='pending')) ORDER BY r.finishedAt,r.id").all() as {id:string;conversationId:string;status:RunStatus}[];
  }
  trackPackage(runId:string,packageId:string){
    this.db.prepare("INSERT INTO package_finalizations(runId,packageId,state,updatedAt) VALUES(?,?,'pending',?) ON CONFLICT(runId,packageId) DO UPDATE SET state='pending',error=NULL,updatedAt=excluded.updatedAt").run(runId,packageId,new Date().toISOString());
  }
  pendingPackages(runId:string){return this.db.prepare("SELECT packageId FROM package_finalizations WHERE runId=? AND state='pending'").all(runId) as {packageId:string}[];}
  packageFinalized(runId:string,packageId:string,commit:string|null){this.db.prepare("UPDATE package_finalizations SET state=?,commitSha=?,error=NULL,updatedAt=? WHERE runId=? AND packageId=?").run(commit?'committed':'aborted',commit,new Date().toISOString(),runId,packageId);}
  packageFinalizationFailed(runId:string,packageId:string,error:string){this.db.prepare('UPDATE package_finalizations SET error=?,updatedAt=? WHERE runId=? AND packageId=?').run(error.slice(0,4000),new Date().toISOString(),runId,packageId);}
  saveDeployment(projectId:string,input:ProjectDeployment){
    this.db.prepare('INSERT INTO project_deployments(projectId,commitSha,releaseDirectory,unitName,status,detail,checkedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(projectId) DO UPDATE SET commitSha=excluded.commitSha,releaseDirectory=excluded.releaseDirectory,unitName=excluded.unitName,status=excluded.status,detail=excluded.detail,checkedAt=excluded.checkedAt WHERE julianday(excluded.checkedAt)>=julianday(project_deployments.checkedAt)').run(projectId,input.commit,input.releaseDirectory,input.unitName,input.status,input.detail,input.checkedAt);
  }
}
