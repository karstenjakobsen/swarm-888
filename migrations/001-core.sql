CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
 id TEXT PRIMARY KEY, title TEXT NOT NULL, threadId TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
 id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id), prompt TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('queued','running','waiting','completed','failed','interrupted','uncertain')),
 kind TEXT NOT NULL DEFAULT 'user' CHECK(kind IN ('user','improvement')), summary TEXT NOT NULL DEFAULT '', threadId TEXT,
 requestId TEXT NOT NULL UNIQUE, parentRunId TEXT REFERENCES runs(id), createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT, error TEXT
);
CREATE UNIQUE INDEX IF NOT EXISTS one_active_run ON runs((1)) WHERE status IN ('running','waiting','uncertain');
CREATE UNIQUE INDEX IF NOT EXISTS one_improvement_per_run ON runs(parentRunId) WHERE kind='improvement';
CREATE TABLE IF NOT EXISTS messages (
 id TEXT PRIMARY KEY, conversationId TEXT NOT NULL REFERENCES conversations(id),runId TEXT NOT NULL REFERENCES runs(id),
 role TEXT NOT NULL CHECK(role IN ('user','assistant')), content TEXT NOT NULL, createdAt TEXT NOT NULL,
 UNIQUE(runId,role)
);
CREATE TABLE IF NOT EXISTS events (
 seq INTEGER PRIMARY KEY AUTOINCREMENT, workerCursor INTEGER UNIQUE,
 runId TEXT REFERENCES runs(id),conversationId TEXT REFERENCES conversations(id),type TEXT NOT NULL,data TEXT NOT NULL,createdAt TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS events_conversation ON events(conversationId,seq);
CREATE TABLE IF NOT EXISTS sessions (hash TEXT PRIMARY KEY, csrf TEXT NOT NULL, expiresAt INTEGER NOT NULL);
INSERT OR IGNORE INTO settings VALUES ('maintenance','false');
