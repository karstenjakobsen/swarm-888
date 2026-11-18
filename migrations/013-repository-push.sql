CREATE TABLE repository_push_settings (
 repositoryId TEXT PRIMARY KEY REFERENCES repositories(id),
 enabled INTEGER NOT NULL DEFAULT 0, autoPush INTEGER NOT NULL DEFAULT 0,
 pushUrl TEXT NOT NULL, branch TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
 updatedAt TEXT NOT NULL
);
CREATE TABLE repository_pushes (
 id TEXT PRIMARY KEY, repositoryId TEXT NOT NULL REFERENCES repositories(id),
 revision INTEGER NOT NULL, commitSha TEXT NOT NULL,
 state TEXT NOT NULL CHECK(state IN ('pending','pushing','pushed','failed','cancelled')),
 attempts INTEGER NOT NULL DEFAULT 0, error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
 UNIQUE(repositoryId,revision,commitSha)
);
CREATE INDEX repository_pushes_pending ON repository_pushes(state,createdAt);
