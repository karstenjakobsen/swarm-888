DROP INDEX IF EXISTS one_active_run;
ALTER TABLE projects ADD COLUMN defaultWorkerId TEXT;
ALTER TABLE runs ADD COLUMN workerId TEXT;
ALTER TABLE runs ADD COLUMN assignedWorkerId TEXT;
ALTER TABLE runs ADD COLUMN attemptId TEXT;
ALTER TABLE runs ADD COLUMN model TEXT;
ALTER TABLE runs ADD COLUMN effort TEXT;
ALTER TABLE runs ADD COLUMN taskType TEXT NOT NULL DEFAULT 'interactive';
ALTER TABLE runs ADD COLUMN requiredRoot INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN requiredConnectorIds TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN connectionScope TEXT NOT NULL DEFAULT 'project';
ALTER TABLE runs ADD COLUMN grantedConnectorIds TEXT NOT NULL DEFAULT '[]';
ALTER TABLE runs ADD COLUMN timeoutMs INTEGER NOT NULL DEFAULT 600000;
ALTER TABLE runs ADD COLUMN maxToolCalls INTEGER NOT NULL DEFAULT 32;
ALTER TABLE runs ADD COLUMN toolCalls INTEGER NOT NULL DEFAULT 0;
ALTER TABLE runs ADD COLUMN maxContextChars INTEGER NOT NULL DEFAULT 32000;
ALTER TABLE runs ADD COLUMN maxOutputChars INTEGER NOT NULL DEFAULT 64000;
ALTER TABLE runs ADD COLUMN blockedReason TEXT;
ALTER TABLE runs ADD COLUMN usage TEXT;
UPDATE runs SET taskType='improvement' WHERE kind='improvement';
CREATE UNIQUE INDEX one_active_worker ON runs(assignedWorkerId) WHERE assignedWorkerId IS NOT NULL AND status IN ('running','waiting','uncertain');
CREATE UNIQUE INDEX one_active_unassigned ON runs((1)) WHERE assignedWorkerId IS NULL AND status IN ('running','waiting','uncertain');
CREATE UNIQUE INDEX one_active_conversation ON runs(conversationId) WHERE status IN ('running','waiting','uncertain');

CREATE TABLE workers (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,model TEXT,effort TEXT,
 mode TEXT NOT NULL CHECK(mode IN ('user','root')),enabled INTEGER NOT NULL DEFAULT 1,draining INTEGER NOT NULL DEFAULT 0,
 createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE TABLE run_attempts (
 id TEXT PRIMARY KEY,runId TEXT NOT NULL REFERENCES runs(id),workerId TEXT NOT NULL,journalId TEXT NOT NULL,
 leaseToken TEXT NOT NULL UNIQUE,status TEXT NOT NULL,model TEXT,effort TEXT,uid INTEGER,
 leaseExpiresAt TEXT NOT NULL,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE TABLE project_leases (
 projectId TEXT PRIMARY KEY REFERENCES projects(id),runId TEXT NOT NULL UNIQUE REFERENCES runs(id),
 attemptId TEXT NOT NULL,acquiredAt TEXT NOT NULL
);
CREATE TABLE worker_cursors (
 workerId TEXT NOT NULL,journalId TEXT NOT NULL,cursor INTEGER NOT NULL DEFAULT 0,
 PRIMARY KEY(workerId,journalId)
);
CREATE TABLE worker_threads (
 conversationId TEXT NOT NULL REFERENCES conversations(id),workerId TEXT NOT NULL,journalId TEXT NOT NULL,
 threadId TEXT NOT NULL,PRIMARY KEY(conversationId,workerId,journalId)
);

ALTER TABLE events RENAME TO legacy_events;
CREATE TABLE events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT,workerCursor INTEGER,workerId TEXT NOT NULL DEFAULT 'default',journalId TEXT NOT NULL DEFAULT 'legacy',
 runId TEXT REFERENCES runs(id),conversationId TEXT REFERENCES conversations(id),type TEXT NOT NULL,data TEXT NOT NULL,createdAt TEXT NOT NULL,
 UNIQUE(workerId,journalId,workerCursor)
);
INSERT INTO events(seq,workerCursor,runId,conversationId,type,data,createdAt) SELECT seq,workerCursor,runId,conversationId,type,data,createdAt FROM legacy_events;
DROP TABLE legacy_events;
CREATE INDEX events_conversation ON events(conversationId,seq);
ALTER TABLE runtime_receipts ADD COLUMN workerId TEXT NOT NULL DEFAULT 'default';
ALTER TABLE runtime_receipts ADD COLUMN journalId TEXT NOT NULL DEFAULT 'legacy';

CREATE TABLE jobs (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,projectId TEXT NOT NULL REFERENCES projects(id),prompt TEXT NOT NULL,
 schedule TEXT NOT NULL,options TEXT NOT NULL,enabled INTEGER NOT NULL DEFAULT 1,
 nextRunAt TEXT,lastRunAt TEXT,blockedReason TEXT,createdAt TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE TABLE job_runs (
 jobId TEXT NOT NULL REFERENCES jobs(id),runId TEXT NOT NULL REFERENCES runs(id),scheduledFor TEXT NOT NULL,
 PRIMARY KEY(jobId,scheduledFor),UNIQUE(runId)
);
