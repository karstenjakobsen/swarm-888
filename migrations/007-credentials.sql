CREATE TABLE IF NOT EXISTS credentials (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,kind TEXT NOT NULL CHECK(kind IN ('secret','oauth2')),
 fields TEXT NOT NULL DEFAULT '[]',revision INTEGER NOT NULL DEFAULT 1,
 ready INTEGER NOT NULL DEFAULT 1,expiresAt TEXT,updatedAt TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_requests (
 stateHash TEXT PRIMARY KEY,connectorId TEXT NOT NULL,credentialId TEXT NOT NULL,
 sessionHash TEXT NOT NULL,cookieHash TEXT NOT NULL,expiresAt INTEGER NOT NULL,
 verifier TEXT NOT NULL,redirectUri TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_sources (
 name TEXT PRIMARY KEY,packageId TEXT NOT NULL UNIQUE,source TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS skill_version_sources (
 name TEXT NOT NULL,version INTEGER NOT NULL,source TEXT NOT NULL,PRIMARY KEY(name,version)
);
