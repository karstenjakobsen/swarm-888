import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { transaction } from '../persistence/transaction.ts';
import type { PackageImport, PackageManifest, PackageRecord, RepositoryRecord } from './schemas.ts';

/** Metadata and import outcomes; Git and filesystem operations belong to PackageService. */
export class PackageStore {
  constructor(private db:DatabaseSync){}
  repositories():RepositoryRecord[]{return this.db.prepare('SELECT * FROM repositories ORDER BY createdAt,id').all() as unknown as RepositoryRecord[];}
  repository(id:string):RepositoryRecord|undefined{return this.db.prepare('SELECT * FROM repositories WHERE id=?').get(id) as unknown as RepositoryRecord|undefined;}
  saveRepository(value:RepositoryRecord):void{this.db.prepare('INSERT INTO repositories(id,name,remoteUrl,directory,branch,sourceBranch,syncMode,status,error,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET status=excluded.status,error=excluded.error,updatedAt=excluded.updatedAt').run(value.id,value.name,value.remoteUrl,value.directory,value.branch,value.sourceBranch,value.syncMode??'legacy',value.status,value.error,value.createdAt,value.updatedAt);}
  packages(repositoryId?:string):PackageRecord[]{const rows=repositoryId?this.db.prepare('SELECT * FROM packages WHERE repositoryId=? ORDER BY path').all(repositoryId):this.db.prepare('SELECT * FROM packages ORDER BY name,id').all();return rows.map(row=>({...row,manifest:JSON.parse(String(row.manifest))})) as unknown as PackageRecord[];}
  package(id:string):PackageRecord|undefined{const row=this.db.prepare('SELECT * FROM packages WHERE id=?').get(id.toLowerCase());return row?{...row,manifest:JSON.parse(String(row.manifest))} as unknown as PackageRecord:undefined;}
  atPath(repositoryId:string,path:string):PackageRecord|undefined {
    const row=this.db.prepare('SELECT id FROM packages WHERE repositoryId=? AND path=?').get(repositoryId,path);
    return row?this.package(String(row.id)):undefined;
  }
  finishImports(repositoryId:string,commit:string,items:{attemptId:string;path:string;manifest:PackageManifest}[]):PackageRecord[]{
    return transaction(this.db,()=>items.map(item=>this.finishImport(item.attemptId,repositoryId,item.path,commit,item.manifest,true)));
  }
  attempts(ids:string[]):PackageImport[]{
    if(!ids.length)return [];
    return this.db.prepare(`SELECT id,repositoryId,packageId,path,schemaVersion,packageVersion,commitSha AS "commit",status,error,createdAt,startedAt,finishedAt FROM package_imports WHERE id IN (${ids.map(()=>'?').join(',')}) ORDER BY createdAt DESC,rowid DESC`).all(...ids) as unknown as PackageImport[];
  }
  beginImport(repositoryId:string,path:string,commit:string,manifest?:{id?:string;schemaVersion?:number;version?:string}):PackageImport {
    const value:PackageImport={id:randomUUID(),repositoryId,path,commit,packageId:manifest?.id??null,schemaVersion:manifest?.schemaVersion??null,packageVersion:manifest?.version??null,status:'pending',error:null,createdAt:new Date().toISOString(),startedAt:null,finishedAt:null};
    this.db.prepare('INSERT INTO package_imports(id,repositoryId,packageId,path,schemaVersion,packageVersion,commitSha,status,createdAt) VALUES(?,?,?,?,?,?,?,?,?)').run(value.id,repositoryId,value.packageId,path,value.schemaVersion,value.packageVersion,commit,'pending',value.createdAt);return value;
  }
  importing(id:string):void{this.db.prepare("UPDATE package_imports SET status='importing',startedAt=? WHERE id=? AND status='pending'").run(new Date().toISOString(),id);}
  failImport(id:string,error:string):void{this.db.prepare("UPDATE package_imports SET status='failed',error=?,finishedAt=? WHERE id=? AND status IN ('pending','importing')").run(error.slice(0,4000),new Date().toISOString(),id);}
  finishImport(id:string,repositoryId:string,path:string,commit:string,manifest:PackageManifest,allowMove=false):PackageRecord {
    return transaction(this.db,()=>{
      const now=new Date().toISOString(),prior=this.package(manifest.id);
      if(prior&&(prior.repositoryId!==repositoryId||(prior.path!==path&&!allowMove)))throw Object.assign(new Error('Package identifier already belongs to another repository or folder; explicitly move it or give an independent copy a new identifier'),{statusCode:409});
      const occupant=this.atPath(repositoryId,path);if(occupant&&occupant.id!==manifest.id)throw Object.assign(new Error('This repository folder is registered with a different package identifier'),{statusCode:409});
      this.db.prepare('INSERT INTO packages(id,repositoryId,path,kind,name,version,description,manifest,lastImportedCommit,lastImportedAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET path=excluded.path,kind=excluded.kind,name=excluded.name,version=excluded.version,description=excluded.description,manifest=excluded.manifest,lastImportedCommit=excluded.lastImportedCommit,lastImportedAt=excluded.lastImportedAt,updatedAt=excluded.updatedAt').run(manifest.id,repositoryId,path,manifest.kind,manifest.name,manifest.version,manifest.description,JSON.stringify(manifest),commit,now,prior?.createdAt??now,now);
      this.db.prepare("UPDATE package_imports SET status='imported',packageId=?,schemaVersion=?,packageVersion=?,finishedAt=?,error=NULL WHERE id=?").run(manifest.id,manifest.schemaVersion,manifest.version,now,id);return this.package(manifest.id)!;
    });
  }
  imports(packageId?:string,repositoryId?:string):PackageImport[]{const rows=packageId?this.db.prepare('SELECT *,commitSha AS "commit" FROM package_imports WHERE packageId=? ORDER BY createdAt DESC,rowid DESC').all(packageId):repositoryId?this.db.prepare('SELECT *,commitSha AS "commit" FROM package_imports WHERE repositoryId=? ORDER BY createdAt DESC,rowid DESC').all(repositoryId):this.db.prepare('SELECT *,commitSha AS "commit" FROM package_imports ORDER BY createdAt DESC,rowid DESC').all();return rows.map(({commitSha,...row})=>row) as unknown as PackageImport[];}
  recoverImports():number{return Number(this.db.prepare("UPDATE package_imports SET status='failed',error='Controller stopped before the import completed; retry this import.',finishedAt=? WHERE status IN ('pending','importing')").run(new Date().toISOString()).changes);}
}
