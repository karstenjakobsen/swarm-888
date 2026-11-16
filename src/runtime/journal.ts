import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Submission, WorkerEvent } from '../ipc.js';
import { randomUUID } from 'node:crypto';

export type JournalRun = { id: string; status: string; submission: string; child_pid: number | null; child_start: string | null; boot_id: string | null };
export type JournalCheck = { id: string; run_id: string | null; status: string; candidate_path: string; child_pid: number | null; child_start: string | null; boot_id: string | null };
export type RuntimeOperation={id:string;method:string;status:'running'|'uncertain';requiresExternalInspection:boolean;completed:boolean};
export type RuntimeProcess={id:string;pid:number|null;start:string|null;boot:string|null;released:boolean};
export const MAX_WORKER_EVENT_BYTES = 1024 * 1024;
export const WORKER_REPLAY_PAGE_BYTES = 2 * 1024 * 1024;

/** The worker's durable acceptance ledger and bounded replay outbox are independent of controller SQLite. */
export class WorkerJournal {
  readonly db: DatabaseSync;
  readonly journalId:string;
  readonly workerId:string;
  constructor(stateDir: string, readonly maxEvents = 10_000,options:{directory?:string;workerId?:string}={}) {
    const directory=options.directory??resolve(stateDir,'worker');this.workerId=options.workerId??'default';
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(directory,'journal.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worker_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,submission TEXT NOT NULL,child_pid INTEGER,child_start TEXT,boot_id TEXT);
      CREATE TABLE IF NOT EXISTS worker_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES worker_runs(id),type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_checks(id TEXT PRIMARY KEY,run_id TEXT,status TEXT NOT NULL,candidate_path TEXT NOT NULL,child_pid INTEGER,child_start TEXT,boot_id TEXT);
      CREATE TABLE IF NOT EXISTS worker_runtime_operations(id TEXT PRIMARY KEY,method TEXT NOT NULL,status TEXT NOT NULL,external_inspection INTEGER NOT NULL DEFAULT 0,completed INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS worker_runtime_processes(id TEXT PRIMARY KEY,operation_id TEXT NOT NULL REFERENCES worker_runtime_operations(id) ON DELETE CASCADE,pid INTEGER,start TEXT,boot TEXT,released INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS worker_identity(id INTEGER PRIMARY KEY CHECK(id=1),journal_id TEXT NOT NULL);
      INSERT OR IGNORE INTO worker_meta(key,value) VALUES('ack',0);`);
    if(!(this.db.prepare('PRAGMA table_info(worker_runtime_operations)').all() as {name:string}[]).some(column=>column.name==='completed'))this.db.exec('ALTER TABLE worker_runtime_operations ADD COLUMN completed INTEGER NOT NULL DEFAULT 0');
    this.db.prepare('INSERT OR IGNORE INTO worker_identity(id,journal_id) VALUES(1,?)').run(randomUUID());this.journalId=String(this.db.prepare('SELECT journal_id FROM worker_identity WHERE id=1').get()!.journal_id);
  }
  accept(submission: Submission): boolean {
    if (this.get(submission.runId)) return false;
    this.db.prepare('INSERT INTO worker_runs(id,status,submission) VALUES(?,?,?)').run(submission.runId, 'accepted', JSON.stringify(submission)); return true;
  }
  get(runId: string): JournalRun | undefined { return this.db.prepare('SELECT * FROM worker_runs WHERE id=?').get(runId) as JournalRun | undefined; }
  runs(): JournalRun[] { return this.db.prepare('SELECT * FROM worker_runs ORDER BY rowid').all() as JournalRun[]; }
  active(): JournalRun[] { return this.db.prepare("SELECT * FROM worker_runs WHERE status IN ('accepted','running','waiting','uncertain')").all() as JournalRun[]; }
  status(runId: string, status: string): void { this.db.prepare('UPDATE worker_runs SET status=? WHERE id=?').run(status, runId); }
  child(runId: string, pid: number, start: string, boot: string): void { this.db.prepare('UPDATE worker_runs SET child_pid=?,child_start=?,boot_id=? WHERE id=?').run(pid, start, boot, runId); }
  beginCheck(id: string, runId: string | null, candidatePath: string): void { this.db.prepare('INSERT INTO worker_checks(id,run_id,status,candidate_path) VALUES(?,?,?,?)').run(id, runId, 'running', candidatePath); }
  checkChild(id: string, pid: number, start: string, boot: string): void { this.db.prepare('UPDATE worker_checks SET child_pid=?,child_start=?,boot_id=? WHERE id=?').run(pid, start, boot, id); }
  checks(): JournalCheck[] { return this.db.prepare('SELECT * FROM worker_checks').all() as JournalCheck[]; }
  checkStatus(id: string, status: string): void { this.db.prepare('UPDATE worker_checks SET status=? WHERE id=?').run(status, id); }
  finishCheck(id: string): void { this.db.prepare('DELETE FROM worker_checks WHERE id=?').run(id); }
  runtimeOperations():RuntimeOperation[]{return (this.db.prepare('SELECT id,method,status,external_inspection,completed FROM worker_runtime_operations ORDER BY rowid').all() as {id:string;method:string;status:RuntimeOperation['status'];external_inspection:number;completed:number}[]).map(row=>({id:row.id,method:row.method,status:row.status,requiresExternalInspection:row.external_inspection===1,completed:row.completed===1}));}
  beginRuntimeOperation(id:string,method:string):void {this.db.prepare("INSERT INTO worker_runtime_operations(id,method,status) VALUES(?,?,'running')").run(id,method);}
  runtimeStatus(id:string,status:RuntimeOperation['status']):void {this.db.prepare('UPDATE worker_runtime_operations SET status=? WHERE id=?').run(status,id);}
  runtimeExternal(id:string):void {this.db.prepare('UPDATE worker_runtime_operations SET external_inspection=1 WHERE id=?').run(id);}
  completeRuntimeOperation(id:string):void {this.db.prepare("UPDATE worker_runtime_operations SET completed=1,status='uncertain' WHERE id=?").run(id);}
  reserveRuntimeProcess(operationId:string,id:string):void {this.db.prepare('INSERT INTO worker_runtime_processes(id,operation_id) VALUES(?,?)').run(id,operationId);}
  captureRuntimeProcess(id:string,pid:number,start:string,boot:string):void {
    if(!Number.isSafeInteger(pid)||pid<=0||!/^\d+$/.test(start)||!boot||boot==='unsupported')throw new Error('Cannot durably capture the owned helper identity.');
    if(Number(this.db.prepare('UPDATE worker_runtime_processes SET pid=?,start=?,boot=? WHERE id=?').run(pid,start,boot,id).changes)!==1)throw new Error('Owned helper reservation is missing.');
  }
  releaseRuntimeProcess(id:string):void {if(Number(this.db.prepare('UPDATE worker_runtime_processes SET released=1 WHERE id=? AND pid IS NOT NULL AND start IS NOT NULL AND boot IS NOT NULL').run(id).changes)!==1)throw new Error('Owned helper launch identity is incomplete.');}
  runtimeProcess(operationId:string,pid:number,start:string,boot:string):void {const id=`${operationId}_${pid}_${start}`;this.reserveRuntimeProcess(operationId,id);this.captureRuntimeProcess(id,pid,start,boot);this.releaseRuntimeProcess(id);}
  runtimeProcesses(operationId:string):RuntimeProcess[]{return (this.db.prepare('SELECT id,pid,start,boot,released FROM worker_runtime_processes WHERE operation_id=? ORDER BY rowid').all(operationId) as {id:string;pid:number|null;start:string|null;boot:string|null;released:number}[]).map(row=>({...row,released:row.released===1}));}
  finishRuntimeOperation(id:string):void {this.db.prepare('DELETE FROM worker_runtime_operations WHERE id=?').run(id);}
  count(): number { return Number((this.db.prepare('SELECT count(*) AS n FROM worker_events').get() as { n: number }).n); }
  bytes(): number { return Number((this.db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS n FROM worker_events').get() as { n: number }).n); }
  append(runId: string, type: string, data: unknown, terminal = false): WorkerEvent {
    const text = JSON.stringify(data);
    const createdAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify({ cursor: Number.MAX_SAFE_INTEGER, runId, type, data, createdAt,workerId:this.workerId,journalId:this.journalId })) > MAX_WORKER_EVENT_BYTES) throw new Error('Worker execution event exceeded 1 MiB; use artifact files for large outputs. Execution was stopped instead of truncating its history.');
    // Reserve room to describe interruption/failure when the normal event budget is exhausted.
    if ((!terminal && this.count() >= this.maxEvents) || this.bytes() + Buffer.byteLength(text) > (terminal ? 32 : 31) * 1024 * 1024) throw new Error('Worker outbox is full; reconnect the controller before continuing');
    const result = this.db.prepare('INSERT INTO worker_events(run_id,type,data,created_at) VALUES(?,?,?,?)').run(runId, type, text, createdAt);
    return { cursor: Number(result.lastInsertRowid), runId, type, data, createdAt,workerId:this.workerId,journalId:this.journalId };
  }
  replay(after: number): WorkerEvent[] {
    return this.replayPage(after).events;
  }
  replayPage(after: number): { events: WorkerEvent[]; hasMore: boolean; nextCursor: number } {
    const events: WorkerEvent[] = []; let bytes = 2; let hasMore = false;
    const rows = this.db.prepare('SELECT * FROM worker_events WHERE cursor>? ORDER BY cursor LIMIT 501').iterate(after);
    for (const raw of rows) {
      const row = raw as { cursor: number; run_id: string; type: string; data: string; created_at: string };
      const event: WorkerEvent = { cursor: row.cursor, runId: row.run_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at,workerId:this.workerId,journalId:this.journalId };
      const size = Buffer.byteLength(JSON.stringify(event)) + (events.length ? 1 : 0);
      if (events.length >= 500 || bytes + size > WORKER_REPLAY_PAGE_BYTES) { hasMore = true; break; }
      events.push(event); bytes += size;
    }
    return { events, hasMore, nextCursor: events.at(-1)?.cursor ?? after };
  }
  acknowledge(cursor: number): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE worker_meta SET value=max(value,?) WHERE key=?').run(cursor, 'ack');
      this.db.prepare('DELETE FROM worker_events WHERE cursor<=?').run(cursor); this.db.exec('COMMIT');
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  close(): void { this.db.close(); }
}
