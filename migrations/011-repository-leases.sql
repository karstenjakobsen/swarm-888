CREATE TABLE repository_leases (
 repositoryId TEXT PRIMARY KEY REFERENCES repositories(id),
 runId TEXT NOT NULL REFERENCES runs(id), acquiredAt TEXT NOT NULL
);
CREATE INDEX repository_leases_run ON repository_leases(runId);
