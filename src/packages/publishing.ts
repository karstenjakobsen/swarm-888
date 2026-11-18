import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { transaction } from '../persistence/transaction.ts';
import { repositoryPushSettingsInput, remoteUrlSchema, type RepositoryRecord, type RepositoryPushStatus } from './schemas.ts';

type Settings={repositoryId:string;enabled:number;autoPush:number;pushUrl:string;branch:string;revision:number;updatedAt:string};
type Push={id:string;repositoryId:string;revision:number;commitSha:string;state:'pending'|'pushing'|'pushed'|'failed'|'cancelled';attempts:number;error:string|null;createdAt:string;updatedAt:string};
interface Host {
  repository:(id:string)=>RepositoryRecord;
  exclusive:<T>(id:string,operation:()=>T|Promise<T>)=>Promise<T>;
  git:(directory:string,args:string[],allowFailure?:boolean)=>string;
  remoteGit:(directory:string,args:string[])=>Promise<string>;
  assertSafe:(value:unknown)=>void;
  error:(error:unknown)=>string;
}
const fail=(message:string)=>Object.assign(new Error(message),{statusCode:409});

/** Durable remote publication is independent of committing and completing local work. */
export class RepositoryPublisher {
  private timer?:NodeJS.Timeout;
  private active=new Map<string,Promise<void>>();
  private closed=false;
  constructor(private db:DatabaseSync,private host:Host){
    // A controller crash can lose a push acknowledgement. The next attempt checks
    // remote history before sending anything, so no local commit is recreated.
    db.prepare("UPDATE repository_pushes SET state='pending' WHERE state='pushing'").run();
  }
  private settings(id:string):Settings|undefined{return this.db.prepare('SELECT * FROM repository_push_settings WHERE repositoryId=?').get(id) as Settings|undefined;}
  status(id:string):RepositoryPushStatus {
    const config=this.settings(id);
    const latest=config?this.db.prepare("SELECT * FROM repository_pushes WHERE repositoryId=? AND revision=? AND state<>'cancelled' ORDER BY createdAt DESC,rowid DESC LIMIT 1").get(id,config.revision) as Push|undefined:undefined;
    const pushed=config?this.db.prepare("SELECT commitSha FROM repository_pushes WHERE repositoryId=? AND revision=? AND state='pushed' ORDER BY updatedAt DESC,rowid DESC LIMIT 1").get(id,config.revision) as {commitSha:string}|undefined:undefined;
    return {enabled:config?.enabled===1,autoPush:config?.autoPush===1,pushUrl:config?.pushUrl??null,branch:config?.branch??null,state:!config?.enabled?'disabled':latest?.state as RepositoryPushStatus['state']??'idle',commit:latest?.commitSha??null,pushedCommit:pushed?.commitSha??null,error:latest?.error??null,updatedAt:latest?.updatedAt??config?.updatedAt??null};
  }
  async configure(id:string,raw:unknown):Promise<void>{
    const input=repositoryPushSettingsInput.parse(raw);
    await this.host.exclusive(id,()=>{
      const repository=this.host.repository(id),previous=this.settings(id);
      const configuredUrl=input.pushUrl===undefined?previous?.pushUrl:input.pushUrl;
      const pushUrl=remoteUrlSchema.parse(configuredUrl??this.host.git(repository.directory,['remote','get-url','--push','origin']).trim());
      const branch=input.branch??previous?.branch??repository.branch;
      this.host.assertSafe({pushUrl,branch});
      const unchanged=previous&&previous.enabled===Number(input.enabled)&&previous.autoPush===Number(input.autoPush)&&previous.pushUrl===pushUrl&&previous.branch===branch;
      if(!unchanged)transaction(this.db,()=>{
        this.db.prepare("UPDATE repository_pushes SET state='cancelled',error=NULL,updatedAt=? WHERE repositoryId=? AND state IN ('pending','pushing','failed')").run(new Date().toISOString(),id);
        this.db.prepare('INSERT INTO repository_push_settings(repositoryId,enabled,autoPush,pushUrl,branch,revision,updatedAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT(repositoryId) DO UPDATE SET enabled=excluded.enabled,autoPush=excluded.autoPush,pushUrl=excluded.pushUrl,branch=excluded.branch,revision=excluded.revision,updatedAt=excluded.updatedAt').run(id,Number(input.enabled),Number(input.autoPush),pushUrl,branch,(previous?.revision??0)+1,new Date().toISOString());
      });
      if(input.enabled&&input.autoPush)this.enqueue(id,this.host.git(repository.directory,['rev-parse','HEAD']).trim(),false);
    });
  }
  enqueue(id:string,commit:string,retry=false):void {
    const config=this.settings(id);if(!config?.enabled)throw fail('Remote pushing is disabled for this repository. Enable it in Repositories first.');
    if(!/^[0-9a-f]{40,64}$/.test(commit))throw fail('Only an existing committed revision can be published.');
    const now=new Date().toISOString();
    this.db.prepare('INSERT OR IGNORE INTO repository_pushes(id,repositoryId,revision,commitSha,state,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run(randomUUID(),id,config.revision,commit,'pending',now,now);
    if(retry)this.db.prepare("UPDATE repository_pushes SET state='pending',error=NULL,updatedAt=? WHERE repositoryId=? AND revision=? AND commitSha=? AND state='failed'").run(now,id,config.revision,commit);
  }
  committed(id:string,commit:string):void {const config=this.settings(id);if(config?.enabled&&config.autoPush)this.enqueue(id,commit);}
  async request(id:string):Promise<void>{await this.host.exclusive(id,()=>{const repository=this.host.repository(id);this.enqueue(id,this.host.git(repository.directory,['rev-parse','HEAD']).trim(),true);});}
  start():void {
    if(this.timer||this.closed)return;
    const automatic=this.db.prepare('SELECT repositoryId FROM repository_push_settings WHERE enabled=1 AND autoPush=1').all() as {repositoryId:string}[];
    for(const {repositoryId:id} of automatic){
      // Recover every accepted revision. Journal order keeps old acknowledgements
      // first even when package timestamps tie or an existing package was updated.
      const accepted=this.db.prepare(`SELECT p.lastImportedCommit FROM packages p
        LEFT JOIN package_imports i ON i.repositoryId=p.repositoryId AND i.packageId=p.id AND i.commitSha=p.lastImportedCommit AND i.status='imported'
        WHERE p.repositoryId=? GROUP BY p.lastImportedCommit ORDER BY MAX(i.rowid),p.lastImportedCommit`).all(id) as {lastImportedCommit:string}[];
      for(const revision of accepted)this.committed(id,revision.lastImportedCommit);
    }
    this.timer=setInterval(()=>{void this.flush().catch(()=>{});},1000);this.timer.unref();
    void this.flush().catch(()=>{});
  }
  async close():Promise<void>{this.closed=true;if(this.timer)clearInterval(this.timer);this.timer=undefined;await Promise.allSettled([...this.active.values()]);}
  async flush():Promise<void> {
    if(this.closed)return;
    const rows=this.db.prepare("SELECT DISTINCT repositoryId FROM repository_pushes WHERE state='pending' ORDER BY createdAt").all() as {repositoryId:string}[];
    const jobs=rows.map(({repositoryId:id})=>{
      if(this.active.has(id))return this.active.get(id)!;
      const operation=this.publishOne(id).finally(()=>{this.active.delete(id);});this.active.set(id,operation);return operation;
    });
    await Promise.allSettled(jobs);
  }
  private leased(id:string):boolean{return Boolean(this.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(id));}
  private async publishOne(id:string):Promise<void>{
    if(this.leased(id))return;
    // Existing source locks cover Git refs as well as file commits. A busy lock
    // is retried on the next tick; it does not turn accepted source work into failure.
    await this.host.exclusive(id,async()=>{
      if(this.closed||this.leased(id))return;
      const config=this.settings(id);if(!config?.enabled)return;
      const item=this.db.prepare("SELECT * FROM repository_pushes WHERE repositoryId=? AND revision=? AND state='pending' ORDER BY createdAt,rowid LIMIT 1").get(id,config.revision) as Push|undefined;if(!item)return;
      const now=new Date().toISOString();
      this.db.prepare("UPDATE repository_pushes SET state='pushing',attempts=attempts+1,error=NULL,updatedAt=? WHERE id=?").run(now,item.id);
      try{
        const repository=this.host.repository(id),ref=`refs/heads/${config.branch}`;
        if(this.host.git(repository.directory,['rev-parse',`${item.commitSha}^{commit}`]).trim()!==item.commitSha)throw fail('The queued source commit is unavailable.');
        const published=async()=>{
          const value=await this.host.remoteGit(repository.directory,['ls-remote','--heads','--',config.pushUrl,ref]);
          const tip=value.trim().split(/\s+/)[0]??'';
          if(tip===item.commitSha)return true;
          if(!/^[0-9a-f]{40,64}$/.test(tip))return false;
          if(this.host.git(repository.directory,['rev-parse','--verify',`${tip}^{commit}`],true).trim()!==tip){
            // Read missing history without changing the authoring checkout, its
            // tracking branches, or a pending remote-import preview in FETCH_HEAD.
            await this.host.remoteGit(repository.directory,['fetch','--no-tags','--no-recurse-submodules','--no-write-fetch-head','--',config.pushUrl,ref]);
          }
          return this.host.git(repository.directory,['merge-base',item.commitSha,tip],true).trim()===item.commitSha;
        };
        if(!await published()){
          let pushError:unknown;
          try{await this.host.remoteGit(repository.directory,['push','--porcelain','--',config.pushUrl,`${item.commitSha}:${ref}`]);}catch(error){pushError=error;}
          // Another writer may have published this revision while our push was
          // starting, or advanced the branch before the acknowledgement arrived.
          if(!await published())throw pushError??fail('Remote branch did not confirm the queued commit. Refresh and retry publication.');
        }
        this.db.prepare("UPDATE repository_pushes SET state='pushed',error=NULL,updatedAt=? WHERE id=?").run(new Date().toISOString(),item.id);
      }catch(error){this.db.prepare("UPDATE repository_pushes SET state='failed',error=?,updatedAt=? WHERE id=?").run(this.host.error(error).slice(0,4000),new Date().toISOString(),item.id);}
    });
  }
}
