CREATE TABLE repositories (
 id TEXT PRIMARY KEY, name TEXT NOT NULL, remoteUrl TEXT NOT NULL, directory TEXT NOT NULL UNIQUE,
 branch TEXT NOT NULL, sourceBranch TEXT NOT NULL, status TEXT NOT NULL CHECK(status IN ('ready','error')),
 error TEXT, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL
);
CREATE TABLE packages (
 id TEXT PRIMARY KEY, repositoryId TEXT NOT NULL REFERENCES repositories(id), path TEXT NOT NULL,
 kind TEXT NOT NULL CHECK(kind IN ('project','connector','skill')), name TEXT NOT NULL, version TEXT NOT NULL,
 description TEXT NOT NULL, manifest TEXT NOT NULL, lastImportedCommit TEXT NOT NULL,
 lastImportedAt TEXT NOT NULL, createdAt TEXT NOT NULL, updatedAt TEXT NOT NULL,
 UNIQUE(repositoryId,path)
);
CREATE TABLE package_imports (
 id TEXT PRIMARY KEY, repositoryId TEXT NOT NULL REFERENCES repositories(id), packageId TEXT, path TEXT NOT NULL,
 schemaVersion INTEGER, packageVersion TEXT, commitSha TEXT NOT NULL,
 status TEXT NOT NULL CHECK(status IN ('pending','importing','imported','failed')), error TEXT,
 createdAt TEXT NOT NULL, startedAt TEXT, finishedAt TEXT
);
CREATE INDEX package_imports_package ON package_imports(packageId,createdAt);
CREATE INDEX package_imports_repository ON package_imports(repositoryId,createdAt);
