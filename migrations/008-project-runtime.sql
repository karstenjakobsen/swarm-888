CREATE TABLE project_environment (
 projectId TEXT PRIMARY KEY REFERENCES projects(id),environment TEXT NOT NULL,updatedAt TEXT NOT NULL
);
CREATE TABLE job_trigger_tokens (
 jobId TEXT PRIMARY KEY REFERENCES jobs(id) ON DELETE CASCADE,tokenHash TEXT NOT NULL UNIQUE,createdAt TEXT NOT NULL
);
