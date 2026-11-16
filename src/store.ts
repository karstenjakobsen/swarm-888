import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AppEvent, Conversation, Message, Run, RunStatus } from './shared.ts';
import { terminal } from './shared.ts';
import { storedRun } from './persistence/runs.ts';
import { transaction } from './persistence/transaction.ts';
import { taskOptions, type TaskOptions } from './tasks/schemas.ts';
import { ProjectStore } from './projects/store.ts';
import { ManagedStore } from './managed/store.ts';
import { ConnectorStore } from './connectors/store.ts';

export class Store extends EventEmitter {
  db: DatabaseSync;
  projects: ProjectStore;
  managed: ManagedStore;
  connectors: ConnectorStore;
  private redactor:(value:unknown)=>unknown=value=>value;
  constructor(stateDir:string) {
    super();
    this.db = new DatabaseSync(join(stateDir,'operator.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS fts_capability_check USING fts5(content); DROP TABLE fts_capability_check;');
    this.db.exec('CREATE TABLE IF NOT EXISTS schema_migrations(version INTEGER PRIMARY KEY,applied_at TEXT NOT NULL)');
    for(const [index,file] of ['001-core.sql','002-projects.sql','003-managed-source.sql','004-connector-checks.sql','005-runtime-receipts.sql','006-worker-platform.sql','007-credentials.sql','008-project-runtime.sql'].entries()){
      if(this.db.prepare('SELECT 1 FROM schema_migrations WHERE version=?').get(index+1))continue;
      this.transaction(()=>{this.db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));this.db.prepare('INSERT INTO schema_migrations VALUES (?,?)').run(index+1,new Date().toISOString());});
    }
    this.projects = new ProjectStore(this.db);
    this.managed = new ManagedStore(this.db);
    this.connectors = new ConnectorStore(this.db);
  }
  transaction<T>(fn:()=>T):T {return transaction(this.db,fn);}
  setRedactor(redact:(value:unknown)=>unknown){this.redactor=redact;}
  sanitize(value:unknown){return this.redactor(value);}
  setting(key:string):string|undefined {return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  setSetting(key:string,value:string) {this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  session(hash:string,now=Date.now()):{hash:string;csrf:string;expiresAt:number}|undefined {
    return this.db.prepare('SELECT * FROM sessions WHERE hash=? AND expiresAt>?').get(hash,now) as {hash:string;csrf:string;expiresAt:number}|undefined;
  }
  createSession(hash:string,csrf:string,expiresAt:number,now=Date.now()):void {
    this.transaction(()=>{
      this.db.prepare('DELETE FROM sessions WHERE expiresAt<=?').run(now);
      this.db.prepare('INSERT INTO sessions(hash,csrf,expiresAt) VALUES (?,?,?)').run(hash,csrf,expiresAt);
    });
  }
  deleteSession(hash:string):void {this.db.prepare('DELETE FROM sessions WHERE hash=?').run(hash);}
  latestRuntimeUsage(runId:string):unknown|undefined {
    const row=this.db.prepare("SELECT data FROM events WHERE runId=? AND type='activity' AND json_extract(data,'$.method')='thread/tokenUsage/updated' ORDER BY seq DESC LIMIT 1").get(runId) as {data:string}|undefined;
    return row?JSON.parse(row.data).tokenUsage:undefined;
  }
  conversations():Conversation[] {return this.db.prepare('SELECT * FROM conversations ORDER BY updatedAt DESC').all() as unknown as Conversation[];}
  conversation(id:string):Conversation|undefined {return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as Conversation|undefined;}
  newConversation(title='New conversation'):Conversation {
    const now=new Date().toISOString();const c={id:randomUUID(),title,threadId:null,createdAt:now,updatedAt:now};
    this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)').run(c.id,c.title,null,now,now);return c;
  }
  run(id:string):Run|undefined {const row=this.db.prepare('SELECT * FROM runs WHERE id=?').get(id);return row?storedRun(row):undefined;}
  runs(conversationId?:string):Run[] {return (conversationId?this.db.prepare('SELECT * FROM runs WHERE conversationId=? ORDER BY createdAt').all(conversationId):this.db.prepare('SELECT * FROM runs ORDER BY createdAt').all()).map(storedRun);}
  active():Run|undefined {const row=this.db.prepare("SELECT * FROM runs WHERE status IN ('running','waiting','uncertain') LIMIT 1").get();return row?storedRun(row):undefined;}
  queued():Run|undefined {return this.pending()[0];}
  pending():Run[]{return this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY CASE kind WHEN 'user' THEN 0 ELSE 1 END,createdAt,rowid").all().map(storedRun);}
  blocked(id:string,reason:string|null){const run=this.run(id);if(!run||run.blockedReason===reason)return;this.db.prepare('UPDATE runs SET blockedReason=? WHERE id=?').run(reason,id);this.addEvent('run',{run:this.run(id)},id);}
  cursor(workerId:string,journalId:string):number{return Number(this.db.prepare('SELECT cursor FROM worker_cursors WHERE workerId=? AND journalId=?').get(workerId,journalId)?.cursor??0);}
  thread(conversationId:string,workerId:string,journalId:string):string|null{return String(this.db.prepare('SELECT threadId FROM worker_threads WHERE conversationId=? AND workerId=? AND journalId=?').get(conversationId,workerId,journalId)?.threadId??'')||null;}
  attempt(id:string){return this.db.prepare('SELECT * FROM run_attempts WHERE id=?').get(id);}
  claim(id:string,worker:{id:string;model?:string|null;effort?:string|null},health:{journalId?:string;uid:number;runtime:{model?:string}},connectionIds:string[]=[]):Run {
    const event=this.transaction(()=>{
      const run=this.run(id);if(!run||run.status!=='queued')throw new Error('The task is no longer queued');
      const project=this.projects.forConversation(run.conversationId),lease=project?this.db.prepare('SELECT runId FROM project_leases WHERE projectId=?').get(project.id):undefined;
      if(lease&&lease.runId!==run.id)throw new Error('Another task owns this project until execution and source finalization finish');
      const now=new Date().toISOString(),attemptId=randomUUID(),token=randomUUID(),journalId=health.journalId??'legacy',model=health.runtime.model??worker.model??null;
      this.db.prepare('INSERT INTO run_attempts(id,runId,workerId,journalId,leaseToken,status,model,effort,uid,leaseExpiresAt,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)').run(attemptId,id,worker.id,journalId,token,'running',model,worker.effort??null,health.uid,new Date(Date.now()+30_000).toISOString(),now,now);
      this.db.prepare("UPDATE runs SET assignedWorkerId=?,attemptId=?,model=?,effort=?,status='running',startedAt=?,blockedReason=NULL,grantedConnectorIds=? WHERE id=?").run(worker.id,attemptId,model,worker.effort??null,now,JSON.stringify(connectionIds),id);
      if(project)this.db.prepare('INSERT INTO project_leases(projectId,runId,attemptId,acquiredAt) VALUES(?,?,?,?)').run(project.id,id,attemptId,now);
      return this.eventRow('run',{run:this.run(id)},id);
    });this.emit('event',event);return this.run(id)!;
  }
  renew(id:string){const run=this.run(id);if(run?.attemptId)this.db.prepare('UPDATE run_attempts SET leaseExpiresAt=?,updatedAt=? WHERE id=?').run(new Date(Date.now()+30_000).toISOString(),new Date().toISOString(),run.attemptId);}
  releaseProject(id:string){
    const run=this.run(id);if(!run||!terminal.has(run.status))return;
    if(this.db.prepare("SELECT 1 FROM source_finalizations WHERE runId=? AND state='pending'").get(id))return;
    this.db.prepare('DELETE FROM project_leases WHERE runId=?').run(id);
  }
  enqueue(conversationId:string,prompt:string,requestId:string,kind:Run['kind']='user',parentRunId:string|null=null,options:TaskOptions&{taskType?:Run['taskType']}={}):Run {
    const parsed=taskOptions.parse(Object.fromEntries(Object.entries(options).filter(([key])=>key!=='taskType')));
    const priorRow=this.db.prepare('SELECT * FROM runs WHERE requestId=?').get(requestId),prior=priorRow?storedRun(priorRow):undefined;
      if(prior){
        const sameOptions=prior.connectionScope===(parsed.requiredConnectorIds===undefined?'project':'explicit')&&prior.timeoutMs===(parsed.timeoutMs??600000)&&prior.maxToolCalls===(parsed.maxToolCalls??32)&&prior.maxContextChars===(parsed.maxContextChars??32000)&&prior.maxOutputChars===(parsed.maxOutputChars??64000)&&prior.taskType===(options.taskType??(kind==='improvement'?'improvement':'interactive'));
        if(!sameOptions||prior.conversationId!==conversationId||prior.prompt!==prompt||prior.kind!==kind||prior.parentRunId!==parentRunId||prior.workerId!==(parsed.workerId??null)||Boolean(prior.requiredRoot)!==Boolean(parsed.requiredRoot)||JSON.stringify(prior.requiredConnectorIds)!==JSON.stringify(parsed.requiredConnectorIds??[]))throw new Error('Request ID already used with different input');return prior;
      }
    if(!this.conversation(conversationId))throw new Error('Conversation not found');
    const id=randomUUID(),now=new Date().toISOString();
    const event=this.transaction(()=>{
      this.db.prepare("INSERT INTO runs(id,conversationId,prompt,status,kind,requestId,parentRunId,createdAt,workerId,requiredRoot,requiredConnectorIds,timeoutMs,maxToolCalls,maxContextChars,maxOutputChars,taskType,connectionScope) VALUES (?,?,?,'queued',?,?,?,?,?,?,?,?,?,?,?,?,?)").run(id,conversationId,prompt,kind,requestId,parentRunId,now,parsed.workerId??null,parsed.requiredRoot?1:0,JSON.stringify(parsed.requiredConnectorIds??[]),parsed.timeoutMs??600000,parsed.maxToolCalls??32,parsed.maxContextChars??32000,parsed.maxOutputChars??64000,options.taskType??(kind==='improvement'?'improvement':'interactive'),parsed.requiredConnectorIds===undefined?'project':'explicit');
      if(kind==='user'){
        this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(randomUUID(),conversationId,id,'user',prompt,now);
        this.db.prepare("UPDATE conversations SET updatedAt=?,title=CASE WHEN title='New conversation' THEN ? ELSE title END WHERE id=?").run(now,prompt.slice(0,65),conversationId);
      }
      return this.eventRow('run',{run:this.run(id)!},id);
    });
    this.emit('event',event);return this.run(id)!;
  }
  transition(id:string,status:RunStatus,error:string|null=null) {
    const run=this.run(id);if(!run)throw new Error('Run not found');
    const allowed:Record<RunStatus,RunStatus[]>={queued:['running','interrupted','failed'],running:['waiting','completed','failed','interrupted','uncertain'],waiting:['running','completed','failed','interrupted','uncertain'],uncertain:['completed','failed','interrupted'],completed:[],failed:[],interrupted:[]};
    if(run.status===status)return;
    if(!allowed[run.status].includes(status))throw new Error(`Invalid run transition ${run.status} -> ${status}`);
    const now=new Date().toISOString();
    const event=this.transaction(()=>{
      this.db.prepare('UPDATE runs SET status=?,error=?,startedAt=COALESCE(startedAt,?),finishedAt=? WHERE id=?').run(status,error,status==='running'?now:null,terminal.has(status)?now:null,id);
      if(run.attemptId)this.db.prepare('UPDATE run_attempts SET status=?,updatedAt=? WHERE id=?').run(status,now,run.attemptId);
      if(terminal.has(status)&&run.startedAt)this.markSourceFinalization(run.id,run.conversationId,now);
      if(terminal.has(status))this.releaseProject(id);
      return this.eventRow('run',{run:this.run(id)},id);
    });
    this.emit('event',event);
  }
  messages(id:string):Message[] {return this.db.prepare('SELECT * FROM messages WHERE conversationId=? ORDER BY createdAt,rowid').all(id) as unknown as Message[];}
  private eventRow(type:string,data:unknown,runId:string|null=null,workerCursor:number|null=null,createdAt=new Date().toISOString(),workerId='default',journalId='legacy'):AppEvent {
    data=this.redactor(data);
    const conversationId=runId?this.run(runId)?.conversationId??null:null;
    const result=this.db.prepare('INSERT INTO events(workerCursor,workerId,journalId,runId,conversationId,type,data,createdAt) VALUES (?,?,?,?,?,?,?,?)').run(workerCursor,workerId,journalId,runId,conversationId,type,JSON.stringify(data),createdAt);
    return {seq:Number(result.lastInsertRowid),runId,conversationId,type,data,createdAt};
  }
  addEvent(type:string,data:unknown,runId:string|null=null) {const event=this.eventRow(type,data,runId);this.emit('event',event);return event;}
  events(after=0,conversationId?:string,limit=2000):AppEvent[] {
    const rows=conversationId?this.db.prepare('SELECT * FROM events WHERE seq>? AND conversationId=? ORDER BY seq LIMIT ?').all(after,conversationId,limit):this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit);
    return rows.map(row=>({...row,data:JSON.parse(String(row.data))})) as unknown as AppEvent[];
  }
  ingest(event:{cursor:number;runId:string;type:string;data:any;createdAt:string;attemptId?:string},owner={workerId:'default',journalId:'legacy'}):boolean {
    event={...event,data:this.redactor(event.data)};
    if(!this.run(event.runId))throw new Error(`Worker has unknown run ${event.runId}; resolve worker ownership before admitting work`);
    const run=this.run(event.runId)!;
    if(run.assignedWorkerId&&run.assignedWorkerId!==owner.workerId)throw new Error('Worker event does not belong to the assigned task worker');
    const attempt=run.attemptId?this.attempt(run.attemptId):undefined;
    if(attempt&&attempt.journalId!==owner.journalId)throw new Error('Worker event does not belong to the accepted task journal');
    if(run.attemptId&&event.attemptId&&run.attemptId!==event.attemptId)throw new Error('Worker event belongs to a different task attempt');
    const advance=()=>this.db.prepare('INSERT INTO worker_cursors(workerId,journalId,cursor) VALUES(?,?,?) ON CONFLICT(workerId,journalId) DO UPDATE SET cursor=max(cursor,excluded.cursor)').run(owner.workerId,owner.journalId,event.cursor);
    if(this.db.prepare('SELECT 1 FROM events WHERE workerId=? AND journalId=? AND workerCursor=?').get(owner.workerId,owner.journalId,event.cursor)||owner.workerId==='default'&&this.db.prepare("SELECT 1 FROM events WHERE workerId='default' AND journalId='legacy' AND workerCursor=? AND runId=?").get(event.cursor,event.runId)){advance();return false;}
    const emitted:AppEvent[]=[];
    this.transaction(()=>{
      const run=this.run(event.runId)!;
      if(event.type==='thread'&&event.data.threadId){
        this.db.prepare('UPDATE runs SET threadId=? WHERE id=?').run(event.data.threadId,run.id);
        if(typeof event.data.model==='string'){this.db.prepare('UPDATE runs SET model=? WHERE id=?').run(event.data.model,run.id);if(run.attemptId)this.db.prepare('UPDATE run_attempts SET model=? WHERE id=?').run(event.data.model,run.attemptId);}
        if(run.kind==='user')this.db.prepare('UPDATE conversations SET threadId=? WHERE id=?').run(event.data.threadId,run.conversationId);
        this.db.prepare('INSERT INTO worker_threads(conversationId,workerId,journalId,threadId) VALUES(?,?,?,?) ON CONFLICT(conversationId,workerId,journalId) DO UPDATE SET threadId=excluded.threadId').run(run.conversationId,owner.workerId,owner.journalId,event.data.threadId);
      }
      if(event.type==='clarification'&&!terminal.has(run.status))this.db.prepare("UPDATE runs SET status='waiting' WHERE id=?").run(run.id);
      if(event.type==='completed'&&!terminal.has(run.status)){
        const status=event.data.uncertain?'uncertain':terminal.has(event.data.status)?event.data.status:'failed';
        const error=event.data.error==null?null:typeof event.data.error==='string'?event.data.error:JSON.stringify(event.data.error);
        this.db.prepare('UPDATE runs SET status=?,error=?,finishedAt=? WHERE id=?').run(status,error,status==='uncertain'?null:event.createdAt,run.id);
        if(status!=='uncertain')this.markSourceFinalization(run.id,run.conversationId,event.createdAt);
        if(run.attemptId)this.db.prepare('UPDATE run_attempts SET status=?,updatedAt=? WHERE id=?').run(status,event.createdAt,run.attemptId);
        if(event.data.usage)this.db.prepare('UPDATE runs SET usage=? WHERE id=?').run(JSON.stringify(event.data.usage),run.id);
        this.releaseProject(run.id);
        const deltas=this.db.prepare("SELECT data FROM events WHERE runId=? AND type='delta' ORDER BY seq").all(run.id);
        const text=deltas.map(row=>JSON.parse(String(row.data)).text??'').join('');
        if(text){const message={id:randomUUID(),conversationId:run.conversationId,runId:run.id,role:'assistant',content:text,createdAt:event.createdAt};
          this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)').run(message.id,message.conversationId,message.runId,message.role,text,message.createdAt);
          emitted.push(this.eventRow('message',{message},run.id,null,event.createdAt));
        }
        this.db.prepare('UPDATE conversations SET updatedAt=? WHERE id=?').run(event.createdAt,run.conversationId);
      }
      if(event.type==='activity'&&event.data.method==='thread/tokenUsage/updated')this.db.prepare('UPDATE runs SET usage=? WHERE id=?').run(JSON.stringify(event.data.tokenUsage??event.data),run.id);
      emitted.push(this.eventRow(event.type,event.data,event.runId,event.cursor,event.createdAt,owner.workerId,owner.journalId));
      advance();
      this.setSetting('worker_cursor',String(event.cursor));
    });
    for(const e of emitted)this.emit('event',e);
    return true;
  }
  close(){this.db.close();}
  private markSourceFinalization(runId:string,conversationId:string,createdAt:string){
    this.db.prepare("INSERT OR IGNORE INTO source_finalizations(runId,projectId,state,updatedAt) SELECT ?,pc.projectId,'pending',? FROM project_conversations pc JOIN project_sources ps ON ps.projectId=pc.projectId WHERE pc.conversationId=?").run(runId,createdAt,conversationId);
  }
  sourceFinalized(runId:string,commit:string,source:unknown){
    const event=this.transaction(()=>{
      if(!this.managed.finalized(runId,commit))return;
      this.releaseProject(runId);
      return this.eventRow('checkpoint',{summary:`Generated source committed at ${commit.slice(0,12)}.`,source},runId);
    });
    if(event)this.emit('event',event);
  }
}
