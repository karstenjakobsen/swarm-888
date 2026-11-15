CREATE TABLE IF NOT EXISTS project_sources (
 projectId TEXT PRIMARY KEY REFERENCES projects(id), kind TEXT NOT NULL CHECK(kind IN ('project','connector','skill')),
 packageId TEXT NOT NULL UNIQUE, source TEXT NOT NULL,
 updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_deployments (
 projectId TEXT PRIMARY KEY REFERENCES projects(id), commitSha TEXT NOT NULL, releaseDirectory TEXT NOT NULL,
 unitName TEXT, status TEXT NOT NULL, detail TEXT NOT NULL, checkedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS connectors (
 id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE, description TEXT NOT NULL DEFAULT '', enabled INTEGER NOT NULL DEFAULT 1,
 definition TEXT NOT NULL, projectId TEXT REFERENCES projects(id), tools TEXT NOT NULL DEFAULT '[]',
 status TEXT NOT NULL DEFAULT 'untested', detail TEXT NOT NULL DEFAULT 'Connection has not been tested.', checkedAt TEXT,
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_connectors (
 projectId TEXT NOT NULL REFERENCES projects(id), connectorId TEXT NOT NULL REFERENCES connectors(id),
 PRIMARY KEY(projectId,connectorId)
);
CREATE TABLE IF NOT EXISTS source_finalizations (
 runId TEXT PRIMARY KEY REFERENCES runs(id), projectId TEXT NOT NULL REFERENCES projects(id),
 state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','committed')), commitSha TEXT, error TEXT,
 updatedAt TEXT NOT NULL
);
