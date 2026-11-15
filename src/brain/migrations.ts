import type { DatabaseSync } from 'node:sqlite';

export function migrateBrain(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS brain_migrations(version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL);
  `);
  if (db.prepare('SELECT 1 FROM brain_migrations WHERE version=1').get()) return;
  db.exec(`BEGIN IMMEDIATE;
    CREATE TABLE brain_settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE memories(
      id TEXT PRIMARY KEY, content TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('user_fact','observation','inference')),
      source TEXT NOT NULL, category TEXT, tags TEXT NOT NULL DEFAULT '[]', project TEXT,
      checked_at TEXT, state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','archived','superseded')),
      superseded_by TEXT REFERENCES memories(id), revision INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE memory_revisions(
      memory_id TEXT NOT NULL REFERENCES memories(id), revision INTEGER NOT NULL,
      snapshot TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(memory_id,revision)
    );
    CREATE TABLE memory_links(
      from_id TEXT NOT NULL REFERENCES memories(id), to_id TEXT NOT NULL REFERENCES memories(id),
      relation TEXT NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY(from_id,to_id,relation)
    );
    CREATE VIRTUAL TABLE memory_fts USING fts5(content,tags,category,project,source,content='memories',content_rowid='rowid');
    CREATE TRIGGER memories_ai AFTER INSERT ON memories BEGIN
      INSERT INTO memory_fts(rowid,content,tags,category,project,source) VALUES(new.rowid,new.content,new.tags,new.category,new.project,new.source);
    END;
    CREATE TRIGGER memories_ad AFTER DELETE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts,rowid,content,tags,category,project,source) VALUES('delete',old.rowid,old.content,old.tags,old.category,old.project,old.source);
    END;
    CREATE TRIGGER memories_au AFTER UPDATE ON memories BEGIN
      INSERT INTO memory_fts(memory_fts,rowid,content,tags,category,project,source) VALUES('delete',old.rowid,old.content,old.tags,old.category,old.project,old.source);
      INSERT INTO memory_fts(rowid,content,tags,category,project,source) VALUES(new.rowid,new.content,new.tags,new.category,new.project,new.source);
    END;
    CREATE TABLE task_checkpoints(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, conversation_id TEXT, summary TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE skills(name TEXT PRIMARY KEY, description TEXT NOT NULL, state TEXT NOT NULL, active_version INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE skill_versions(
      name TEXT NOT NULL REFERENCES skills(name), version INTEGER NOT NULL, state TEXT NOT NULL,
      path TEXT NOT NULL, description TEXT NOT NULL, digest TEXT, evidence TEXT NOT NULL DEFAULT 'null',
      created_at TEXT NOT NULL, published_at TEXT, PRIMARY KEY(name,version)
    );
    CREATE TABLE skill_usage(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL, run_id TEXT,
      outcome TEXT NOT NULL, summary TEXT NOT NULL, metrics TEXT, created_at TEXT NOT NULL,
      FOREIGN KEY(name,version) REFERENCES skill_versions(name,version)
    );
    INSERT INTO brain_migrations VALUES(1,strftime('%Y-%m-%dT%H:%M:%fZ','now'));
    COMMIT;
  `);
}
