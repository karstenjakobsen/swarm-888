CREATE TABLE IF NOT EXISTS runtime_receipts (
 operationId TEXT PRIMARY KEY,
 method TEXT NOT NULL,
 projectId TEXT,
 payload TEXT NOT NULL,
 receivedAt TEXT NOT NULL,
 acknowledgedAt TEXT
);
CREATE INDEX IF NOT EXISTS runtime_receipts_pending ON runtime_receipts(receivedAt,operationId) WHERE acknowledgedAt IS NULL;
