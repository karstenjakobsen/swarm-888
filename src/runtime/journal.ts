import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Submission, WorkerEvent } from '../ipc.js';

export type JournalRun = { id: string; status: string; submission: string; child_pid: number | null; child_start: string | null; boot_id: string | null };
export type JournalCheck = { id: string; run_id: string | null; status: string; candidate_path: string; child_pid: number | null; child_start: string | null; boot_id: string | null };
export const MAX_WORKER_EVENT_BYTES = 1024 * 1024;
export const WORKER_REPLAY_PAGE_BYTES = 2 * 1024 * 1024;

/** The worker's durable acceptance ledger and bounded replay outbox are independent of controller SQLite. */
export class WorkerJournal {
  readonly db: DatabaseSync;
  constructor(stateDir: string, readonly maxEvents = 10_000) {
    mkdirSync(resolve(stateDir, 'worker'), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(resolve(stateDir, 'worker/journal.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS worker_runs(id TEXT PRIMARY KEY,status TEXT NOT NULL,submission TEXT NOT NULL,child_pid INTEGER,child_start TEXT,boot_id TEXT);
      CREATE TABLE IF NOT EXISTS worker_events(cursor INTEGER PRIMARY KEY AUTOINCREMENT,run_id TEXT NOT NULL REFERENCES worker_runs(id),type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_meta(key TEXT PRIMARY KEY,value INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS worker_checks(id TEXT PRIMARY KEY,run_id TEXT,status TEXT NOT NULL,candidate_path TEXT NOT NULL,child_pid INTEGER,child_start TEXT,boot_id TEXT);
      INSERT OR IGNORE INTO worker_meta(key,value) VALUES('ack',0);`);
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
  count(): number { return Number((this.db.prepare('SELECT count(*) AS n FROM worker_events').get() as { n: number }).n); }
  bytes(): number { return Number((this.db.prepare('SELECT coalesce(sum(length(CAST(data AS BLOB))),0) AS n FROM worker_events').get() as { n: number }).n); }
  append(runId: string, type: string, data: unknown, terminal = false): WorkerEvent {
    const text = JSON.stringify(data);
    const createdAt = new Date().toISOString();
    if (Buffer.byteLength(JSON.stringify({ cursor: Number.MAX_SAFE_INTEGER, runId, type, data, createdAt })) > MAX_WORKER_EVENT_BYTES) throw new Error('Worker execution event exceeded 1 MiB; use artifact files for large outputs. Execution was stopped instead of truncating its history.');
    // Reserve room to describe interruption/failure when the normal event budget is exhausted.
    if ((!terminal && this.count() >= this.maxEvents) || this.bytes() + Buffer.byteLength(text) > (terminal ? 32 : 31) * 1024 * 1024) throw new Error('Worker outbox is full; reconnect the controller before continuing');
    const result = this.db.prepare('INSERT INTO worker_events(run_id,type,data,created_at) VALUES(?,?,?,?)').run(runId, type, text, createdAt);
    return { cursor: Number(result.lastInsertRowid), runId, type, data, createdAt };
  }
  replay(after: number): WorkerEvent[] {
    return this.replayPage(after).events;
  }
  replayPage(after: number): { events: WorkerEvent[]; hasMore: boolean; nextCursor: number } {
    const events: WorkerEvent[] = []; let bytes = 2; let hasMore = false;
    const rows = this.db.prepare('SELECT * FROM worker_events WHERE cursor>? ORDER BY cursor LIMIT 501').iterate(after);
    for (const raw of rows) {
      const row = raw as { cursor: number; run_id: string; type: string; data: string; created_at: string };
      const event: WorkerEvent = { cursor: row.cursor, runId: row.run_id, type: row.type, data: JSON.parse(row.data), createdAt: row.created_at };
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
