import { DatabaseSync } from 'node:sqlite';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { AppEvent, Conversation, Message, Run, RunStatus } from './shared.ts';
import { terminal } from './shared.ts';

export class Store extends EventEmitter {
  db: DatabaseSync;
  constructor(stateDir:string) {
    super();
    this.db = new DatabaseSync(join(stateDir,'operator.sqlite'));
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; PRAGMA synchronous=FULL;');
    this.db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS fts_capability_check USING fts5(content); DROP TABLE fts_capability_check;');
    this.transaction(()=>{
      this.db.exec(readFileSync(new URL('../migrations/001-core.sql',import.meta.url),'utf8'));
      this.db.prepare('INSERT OR IGNORE INTO schema_migrations VALUES (1,?)').run(new Date().toISOString());
    });
  }
  transaction<T>(fn:()=>T):T { this.db.exec('BEGIN IMMEDIATE');try {const value=fn();this.db.exec('COMMIT');return value;} catch(e){this.db.exec('ROLLBACK');throw e;} }
  setting(key:string):string|undefined {return (this.db.prepare('SELECT value FROM settings WHERE key=?').get(key) as {value:string}|undefined)?.value;}
  setSetting(key:string,value:string) {this.db.prepare('INSERT INTO settings VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value').run(key,value);}
  conversations():Conversation[] {return this.db.prepare('SELECT * FROM conversations ORDER BY updatedAt DESC').all() as unknown as Conversation[];}
  conversation(id:string):Conversation|undefined {return this.db.prepare('SELECT * FROM conversations WHERE id=?').get(id) as unknown as Conversation|undefined;}
  newConversation(title='New conversation'):Conversation {
    const now=new Date().toISOString();const c={id:randomUUID(),title,threadId:null,createdAt:now,updatedAt:now};
    this.db.prepare('INSERT INTO conversations VALUES (?,?,?,?,?)').run(c.id,c.title,null,now,now);return c;
  }
  run(id:string):Run|undefined {return this.db.prepare('SELECT * FROM runs WHERE id=?').get(id) as unknown as Run|undefined;}
  runs(conversationId?:string):Run[] {return (conversationId?this.db.prepare('SELECT * FROM runs WHERE conversationId=? ORDER BY createdAt').all(conversationId):this.db.prepare('SELECT * FROM runs ORDER BY createdAt').all()) as unknown as Run[];}
  active():Run|undefined {return this.db.prepare("SELECT * FROM runs WHERE status IN ('running','waiting','uncertain') LIMIT 1").get() as unknown as Run|undefined;}
  queued():Run|undefined {return this.db.prepare("SELECT * FROM runs WHERE status='queued' ORDER BY CASE kind WHEN 'user' THEN 0 ELSE 1 END,createdAt LIMIT 1").get() as unknown as Run|undefined;}
  enqueue(conversationId:string,prompt:string,requestId:string,kind:Run['kind']='user',parentRunId:string|null=null):Run {
    const prior=this.db.prepare('SELECT * FROM runs WHERE requestId=?').get(requestId) as unknown as Run|undefined;
    if(prior){if(prior.conversationId!==conversationId||prior.prompt!==prompt)throw new Error('Request ID already used with different input');return prior;}
    if(!this.conversation(conversationId))throw new Error('Conversation not found');
    const id=randomUUID(),now=new Date().toISOString();
    this.transaction(()=>{
      this.db.prepare("INSERT INTO runs(id,conversationId,prompt,status,kind,requestId,parentRunId,createdAt) VALUES (?,?,?,'queued',?,?,?,?)").run(id,conversationId,prompt,kind,requestId,parentRunId,now);
      if(kind==='user'){
        this.db.prepare('INSERT INTO messages VALUES (?,?,?,?,?,?)').run(randomUUID(),conversationId,id,'user',prompt,now);
        this.db.prepare("UPDATE conversations SET updatedAt=?,title=CASE WHEN title='New conversation' THEN ? ELSE title END WHERE id=?").run(now,prompt.slice(0,65),conversationId);
      }
    });
    const run=this.run(id)!;this.addEvent('run',{run},id);return run;
  }
  transition(id:string,status:RunStatus,error:string|null=null) {
    const run=this.run(id);if(!run)throw new Error('Run not found');
    const allowed:Record<RunStatus,RunStatus[]>={queued:['running','interrupted','failed'],running:['waiting','completed','failed','interrupted','uncertain'],waiting:['running','completed','failed','interrupted','uncertain'],uncertain:['completed','failed','interrupted'],completed:[],failed:[],interrupted:[]};
    if(run.status===status)return;
    if(!allowed[run.status].includes(status))throw new Error(`Invalid run transition ${run.status} -> ${status}`);
    const now=new Date().toISOString();
    this.db.prepare('UPDATE runs SET status=?,error=?,startedAt=COALESCE(startedAt,?),finishedAt=? WHERE id=?').run(status,error,status==='running'?now:null,terminal.has(status)?now:null,id);
    this.addEvent('run',{run:this.run(id)},id);
  }
  messages(id:string):Message[] {return this.db.prepare('SELECT * FROM messages WHERE conversationId=? ORDER BY createdAt,rowid').all(id) as unknown as Message[];}
  private eventRow(type:string,data:unknown,runId:string|null=null,workerCursor:number|null=null,createdAt=new Date().toISOString()):AppEvent {
    const conversationId=runId?this.run(runId)?.conversationId??null:null;
    const result=this.db.prepare('INSERT INTO events(workerCursor,runId,conversationId,type,data,createdAt) VALUES (?,?,?,?,?,?)').run(workerCursor,runId,conversationId,type,JSON.stringify(data),createdAt);
    return {seq:Number(result.lastInsertRowid),runId,conversationId,type,data,createdAt};
  }
  addEvent(type:string,data:unknown,runId:string|null=null) {const event=this.eventRow(type,data,runId);this.emit('event',event);return event;}
  events(after=0,conversationId?:string,limit=2000):AppEvent[] {
    const rows=conversationId?this.db.prepare('SELECT * FROM events WHERE seq>? AND conversationId=? ORDER BY seq LIMIT ?').all(after,conversationId,limit):this.db.prepare('SELECT * FROM events WHERE seq>? ORDER BY seq LIMIT ?').all(after,limit);
    return rows.map(row=>({...row,data:JSON.parse(String(row.data))})) as unknown as AppEvent[];
  }
  ingest(event:{cursor:number;runId:string;type:string;data:any;createdAt:string}):boolean {
    if(!this.run(event.runId))throw new Error(`Worker has unknown run ${event.runId}; resolve worker ownership before admitting work`);
    if(this.db.prepare('SELECT 1 FROM events WHERE workerCursor=?').get(event.cursor))return false;
    const emitted:AppEvent[]=[];
    this.transaction(()=>{
      const run=this.run(event.runId)!;
      if(event.type==='thread'&&event.data.threadId){
        this.db.prepare('UPDATE runs SET threadId=? WHERE id=?').run(event.data.threadId,run.id);
        if(run.kind==='user')this.db.prepare('UPDATE conversations SET threadId=? WHERE id=?').run(event.data.threadId,run.conversationId);
      }
      if(event.type==='clarification'&&!terminal.has(run.status))this.db.prepare("UPDATE runs SET status='waiting' WHERE id=?").run(run.id);
      if(event.type==='completed'&&!terminal.has(run.status)){
        const status=event.data.uncertain?'uncertain':terminal.has(event.data.status)?event.data.status:'failed';
        const error=event.data.error==null?null:typeof event.data.error==='string'?event.data.error:JSON.stringify(event.data.error);
        this.db.prepare('UPDATE runs SET status=?,error=?,finishedAt=? WHERE id=?').run(status,error,status==='uncertain'?null:event.createdAt,run.id);
        const deltas=this.db.prepare("SELECT data FROM events WHERE runId=? AND type='delta' ORDER BY seq").all(run.id);
        const text=deltas.map(row=>JSON.parse(String(row.data)).text??'').join('');
        if(text){const message={id:randomUUID(),conversationId:run.conversationId,runId:run.id,role:'assistant',content:text,createdAt:event.createdAt};
          this.db.prepare('INSERT OR IGNORE INTO messages VALUES (?,?,?,?,?,?)').run(message.id,message.conversationId,message.runId,message.role,text,message.createdAt);
          emitted.push(this.eventRow('message',{message},run.id,null,event.createdAt));
        }
        this.db.prepare('UPDATE conversations SET updatedAt=? WHERE id=?').run(event.createdAt,run.conversationId);
      }
      emitted.push(this.eventRow(event.type,event.data,event.runId,event.cursor,event.createdAt));
      this.setSetting('worker_cursor',String(event.cursor));
    });
    for(const e of emitted)this.emit('event',e);
    return true;
  }
  close(){this.db.close();}
}
