import type { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { memoryFilters, memoryInput } from './schemas.js';

export interface MemoryEntry {
  id: string; content: string; kind: 'user_fact' | 'observation' | 'inference'; source: string;
  category: string | null; tags: string[]; project: string | null; checkedAt: string | null;
  state: 'active' | 'archived' | 'superseded'; supersededBy: string | null;
  revision: number; createdAt: string; updatedAt: string;
}
type Row = Record<string, any>;
function entry(row: Row): MemoryEntry {
  return { id: row.id, content: row.content, kind: row.kind, source: row.source, category: row.category,
    tags: JSON.parse(row.tags), project: row.project, checkedAt: row.checked_at, state: row.state,
    supersededBy: row.superseded_by, revision: Number(row.revision), createdAt: row.created_at, updatedAt: row.updated_at };
}
export class MemoryStore {
  constructor(private db: DatabaseSync) {}
  search(query = '', filters: unknown = {}) {
    const f = memoryFilters.parse(filters ?? {});
    const terms = query.match(/[\p{L}\p{N}_-]+/gu) ?? [];
    const fulltext = terms.slice(0,30).map(t => `"${t.replaceAll('"','""')}"*`).join(' AND ');
    const params: Array<string | number> = [];
    const where: string[] = [];
    if (fulltext) { where.push('memory_fts MATCH ?'); params.push(fulltext); }
    if (f.state !== 'all') { where.push('m.state=?'); params.push(f.state); }
    for (const key of ['kind','category','project'] as const) if (f[key]) { where.push(`m.${key}=?`); params.push(f[key]!); }
    if (f.tag) { where.push('EXISTS(SELECT 1 FROM json_each(m.tags) WHERE value=?)'); params.push(f.tag); }
    params.push(f.limit);
    return (this.db.prepare(`SELECT m.* FROM memories m ${fulltext ? 'JOIN memory_fts ON memory_fts.rowid=m.rowid' : ''}
      ${where.length ? 'WHERE '+where.join(' AND ') : ''} ORDER BY ${fulltext ? 'memory_fts.rank,' : ''} m.updated_at DESC LIMIT ?`).all(...params) as Row[]).map(entry);
  }
  get(id: string) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined;
    if (!row) throw new Error('Memory not found');
    return { ...entry(row), revisions: (this.db.prepare('SELECT * FROM memory_revisions WHERE memory_id=? ORDER BY revision DESC').all(id) as Row[])
      .map(r => ({ revision: Number(r.revision), snapshot: JSON.parse(r.snapshot) as MemoryEntry, createdAt: r.created_at })),
      links: (this.db.prepare('SELECT * FROM memory_links WHERE from_id=? OR to_id=? ORDER BY created_at').all(id,id) as Row[])
        .map(r => ({ fromId: r.from_id, toId: r.to_id, relation: r.relation, createdAt: r.created_at })) };
  }
  private revision(id: string) {
    const row = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row;
    const e = entry(row);
    this.db.prepare('INSERT INTO memory_revisions(memory_id,revision,snapshot,created_at) VALUES(?,?,?,?)')
      .run(id,e.revision,JSON.stringify(e),e.updatedAt);
    return e;
  }
  write(raw: unknown) {
    const input = memoryInput.parse(raw), now = new Date().toISOString(), id = input.id ?? randomUUID();
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const old = this.db.prepare('SELECT * FROM memories WHERE id=?').get(id) as Row | undefined;
      if (input.id && !old) throw new Error('Memory not found');
      if (input.expectedRevision !== undefined && input.expectedRevision !== old?.revision) throw new Error('Memory revision conflict');
      if (old) {
        this.db.prepare(`UPDATE memories SET content=?,kind=?,source=?,category=?,tags=?,project=?,checked_at=?,revision=revision+1,updated_at=? WHERE id=?`)
          .run(input.content,input.kind,input.source,input.category ?? null,JSON.stringify(input.tags ?? []),input.project ?? null,input.checkedAt ?? null,now,id);
      } else {
        this.db.prepare(`INSERT INTO memories(id,content,kind,source,category,tags,project,checked_at,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)`)
          .run(id,input.content,input.kind,input.source,input.category ?? null,JSON.stringify(input.tags ?? []),input.project ?? null,input.checkedAt ?? null,now,now);
      }
      const result = this.revision(id); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  link(fromId: string, toId: string, relation = 'related') {
    this.get(fromId); this.get(toId);
    this.db.prepare('INSERT OR IGNORE INTO memory_links(from_id,to_id,relation,created_at) VALUES(?,?,?,?)').run(fromId,toId,relation,new Date().toISOString());
    return this.get(fromId);
  }
  archive(id: string, supersededBy?: string, reason?: string) {
    const original = this.get(id);
    if (supersededBy === id) throw new Error('A memory cannot supersede itself');
    if (supersededBy) this.get(supersededBy);
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare('UPDATE memories SET state=?,superseded_by=?,revision=revision+1,updated_at=? WHERE id=?')
        .run(supersededBy ? 'superseded' : 'archived',supersededBy ?? null,new Date().toISOString(),id);
      if (supersededBy) this.db.prepare('INSERT OR IGNORE INTO memory_links VALUES(?,?,?,?)').run(id,supersededBy,`superseded: ${reason}`,new Date().toISOString());
      const result = this.revision(original.id); this.db.exec('COMMIT'); return result;
    } catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
}
