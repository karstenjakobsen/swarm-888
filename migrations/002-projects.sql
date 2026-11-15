CREATE TABLE IF NOT EXISTS projects (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', directory TEXT NOT NULL UNIQUE,
 origin TEXT NOT NULL CHECK(origin IN ('created','adopted')), createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS project_components (
 id TEXT PRIMARY KEY, projectId TEXT NOT NULL REFERENCES projects(id), name TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('website','service','scheduled_job','script')),
 unitName TEXT, url TEXT, scriptPath TEXT, schedule TEXT, timezone TEXT, observation TEXT,
 createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL, UNIQUE(projectId,name)
);
CREATE INDEX IF NOT EXISTS project_components_project ON project_components(projectId);
CREATE TABLE IF NOT EXISTS project_conversations (
 conversationId TEXT PRIMARY KEY REFERENCES conversations(id), projectId TEXT NOT NULL REFERENCES projects(id)
);
CREATE INDEX IF NOT EXISTS project_conversations_project ON project_conversations(projectId);
