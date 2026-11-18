import type { DatabaseSync } from 'node:sqlite';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { candidateInput, skillName, type CheckEvidence, type CheckSpec } from './schemas.js';
import type { ManagedSource } from '../managed/schemas.ts';

type Row = Record<string, any>;
export type SkillSnapshot = { name: string; path: string; version: number };
export type SkillSummary = { name: string; description: string; state: string; activeVersion: number | null; versions: number; updatedAt: string };
export function safeRelative(file: string) {
  if (!file || file.length > 240 || file.includes('\\') || file.includes('\0') || path.isAbsolute(file) || file.split('/').some(p => !p || p === '.' || p === '..'))
    throw new Error(`Invalid package path: ${file}`);
  return file;
}
function writeAtomic(file: string, data: string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = `${file}.${randomUUID()}.tmp`;
  const fd = fs.openSync(temporary, 'wx', 0o600);
  try { fs.writeFileSync(fd,data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(temporary,file);
  const directory = fs.openSync(path.dirname(file),'r');
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
}
function packageFiles(directory: string, prefix = ''): string[] {
  const files: string[] = [];
  for (const dirent of fs.readdirSync(path.join(directory,prefix),{withFileTypes:true})) {
    const relative = prefix ? `${prefix}/${dirent.name}` : dirent.name;
    if (dirent.isSymbolicLink()) throw new Error(`Package symlinks are not permitted: ${relative}`);
    if (dirent.isDirectory()) files.push(...packageFiles(directory,relative));
    else if (dirent.isFile()) files.push(relative);
    else throw new Error(`Unsupported package entry: ${relative}`);
  }
  return files.sort();
}
function metadata(body: string) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(body);
  if (!match) throw new Error('SKILL.md requires YAML frontmatter and instructions');
  const field = (name: string) => {
    const raw = new RegExp(`^${name}:\\s*(.+)$`,'m').exec(match[1]!)?.[1]?.trim();
    if (!raw) throw new Error(`Missing ${name} in SKILL.md`);
    if (raw.startsWith('"')) { try { return JSON.parse(raw) as string; } catch { throw new Error(`Invalid ${name} quoting`); } }
    return raw.replace(/^'(.*)'$/,'$1');
  };
  const name = skillName.parse(field('name')), description = field('description');
  if (description.length > 500 || description.length < 10) throw new Error('Skill description must be 10–500 characters');
  if (match[2]!.trim().length < 20) throw new Error('Skill instructions are too short');
  return { name, description };
}
function digest(directory: string) {
  const hash = createHash('sha256');
  for (const file of packageFiles(directory)) { hash.update(file); hash.update('\0'); hash.update(fs.readFileSync(path.join(directory,file))); hash.update('\0'); }
  return hash.digest('hex');
}
export class SkillStore {
  private executor?: (spec: CheckSpec) => Promise<CheckEvidence>;
  private validating = new Set<string>();
  private root: string;
  constructor(private db: DatabaseSync, stateDir: string) { this.root=path.join(stateDir,'skills'); }
  initialize() {
    for (const sub of ['staging','packages','active']) fs.mkdirSync(path.join(this.root,sub),{recursive:true,mode:0o700});
    for (const row of this.db.prepare('SELECT * FROM skill_versions').all() as Row[]) {
      const final = this.versionPath(row.name,row.version);
      if (!fs.existsSync(row.path) && fs.existsSync(final)) {
        if (!row.digest || digest(final) !== row.digest) throw new Error(`Interrupted skill publication has mismatched content: ${row.name} v${row.version}`);
        this.db.prepare('UPDATE skill_versions SET path=?,published_at=COALESCE(published_at,?) WHERE name=? AND version=?').run(final,new Date().toISOString(),row.name,row.version);
      }
    }
    this.recoverPointers();
  }
  setExecutor(executor: (spec: CheckSpec) => Promise<CheckEvidence>) { this.executor=executor; }
  private versionPath(name:string,version:number) { return path.join(this.root,'packages',name,`v${version}`); }
  private pointer(name:string,version:number|null) {
    const active = path.join(this.root,'active',name);
    if (version === null) { fs.rmSync(active,{force:true}); return; }
    const target = this.versionPath(name,version);
    if (!fs.existsSync(path.join(target,'SKILL.md'))) throw new Error(`Missing published skill: ${name} v${version}`);
    const temp = `${active}.${randomUUID()}.tmp`;
    fs.symlinkSync(target,temp,'dir'); fs.renameSync(temp,active);
  }
  private recoverPointers() {
    const rows = this.db.prepare('SELECT name,active_version FROM skills').all() as Row[];
    const names = new Set(rows.map(r => r.name));
    for (const file of fs.readdirSync(path.join(this.root,'active'))) if (!names.has(file)) fs.rmSync(path.join(this.root,'active',file),{force:true});
    for (const row of rows) this.pointer(row.name,row.active_version);
  }
  list(query=''): SkillSummary[] {
    const rows = this.db.prepare(`SELECT s.*,COUNT(v.version) AS versions FROM skills s JOIN skill_versions v ON v.name=s.name
      WHERE s.name LIKE ? ESCAPE '\\' OR s.description LIKE ? ESCAPE '\\' GROUP BY s.name ORDER BY s.name`)
      .all(`%${query.replace(/[\\%_]/g,'\\$&')}%`,`%${query.replace(/[\\%_]/g,'\\$&')}%`) as Row[];
    return rows.map(r => ({name:r.name,description:r.description,state:r.state,activeVersion:r.active_version === null ? null : Number(r.active_version),versions:Number(r.versions),updatedAt:r.updated_at}));
  }
  get(name:string) {
    skillName.parse(name);
    const summary = this.list().find(s => s.name===name);
    if (!summary) throw new Error('Skill not found');
    const hasSources=Boolean(this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='skill_version_sources'").get());
    const versions = (this.db.prepare('SELECT * FROM skill_versions WHERE name=? ORDER BY version DESC').all(name) as Row[]).map(row => ({
      version:Number(row.version),state:row.state,path:row.path,description:row.description,createdAt:row.created_at,publishedAt:row.published_at,
      evidence:JSON.parse(row.evidence),files:fs.existsSync(row.path) ? packageFiles(row.path) : [],
      body:fs.existsSync(path.join(row.path,'SKILL.md')) ? fs.readFileSync(path.join(row.path,'SKILL.md'),'utf8') : '[Package missing on disk]',
      ...(hasSources?{source:this.source(name,Number(row.version))}:{}),
    }));
    const usage = (this.db.prepare('SELECT * FROM skill_usage WHERE name=? ORDER BY created_at DESC LIMIT 100').all(name) as Row[])
      .map(r => ({id:r.id,version:Number(r.version),runId:r.run_id,outcome:r.outcome,summary:r.summary,metrics:r.metrics ? JSON.parse(r.metrics) : null,createdAt:r.created_at}));
    return {...summary,versions,usage};
  }
  create(raw:unknown,source?:ManagedSource) {
    const {input,meta}=this.checkCandidate(raw);
    const version=Number((this.db.prepare('SELECT COALESCE(MAX(version),0)+1 AS version FROM skill_versions WHERE name=?').get(input.name) as Row).version);
    const target=path.join(this.root,'staging',`${input.name}-v${version}`), temporary=`${target}.${randomUUID()}.tmp`,now=new Date().toISOString();
    fs.mkdirSync(temporary,{recursive:true,mode:0o700});
    try {
      for(const [file,body] of Object.entries(input.files))writeAtomic(path.join(temporary,file),body);
      writeAtomic(path.join(temporary,'manifest.json'),JSON.stringify({name:input.name,version,files:Object.keys(input.files).sort(),checks:input.checks},null,2));
      fs.renameSync(temporary,target);
      this.db.exec('BEGIN IMMEDIATE');
      try {
        this.db.prepare(`INSERT INTO skills(name,description,state,active_version,created_at,updated_at) VALUES(?,?,'candidate',NULL,?,?)
          ON CONFLICT(name) DO UPDATE SET updated_at=excluded.updated_at`).run(input.name,meta.description,now,now);
        this.db.prepare(`INSERT INTO skill_versions(name,version,state,path,description,created_at) VALUES(?,?,'candidate',?,?,?)`).run(input.name,version,target,meta.description,now);
        if(source)this.db.prepare('INSERT INTO skill_version_sources(name,version,source) VALUES(?,?,?)').run(input.name,version,JSON.stringify(source));
        this.db.exec('COMMIT');
      } catch(error) { this.db.exec('ROLLBACK'); fs.rmSync(target,{recursive:true,force:true}); throw error; }
    } catch(error) { fs.rmSync(temporary,{recursive:true,force:true}); throw error; }
    return {name:input.name,version,state:'candidate',path:target};
  }
  checkCandidate(raw:unknown){
    const input=candidateInput.parse(raw);
    if (!input.files['SKILL.md']) throw new Error('Candidate must include SKILL.md');
    if (['manifest.json','operator-package.json','skill-checks.json'].some(name=>Object.hasOwn(input.files,name))) throw new Error('Skill package manifests are generated by the skill manager');
    if (Object.values(input.files).reduce((sum,c)=>sum+Buffer.byteLength(c),0)>4_000_000) throw new Error('Skill package exceeds 4 MB');
    for (const file of Object.keys(input.files)) safeRelative(file);
    for (const check of input.checks) {
      for (const file of Object.keys(check.fixtures)) {
        safeRelative(file);
        if(file.split('/')[0]==='skill')throw new Error('Fixture files cannot overwrite the copied skill package');
      }
      for (const file of Object.keys(check.expectedFiles??{})) safeRelative(file);
    }
    const meta=metadata(input.files['SKILL.md']);
    if(meta.name!==input.name) throw new Error('Skill name and SKILL.md metadata must match');
    return {input,meta};
  }
  sourceBinding(name:string) {
    const row=this.db.prepare('SELECT packageId,source FROM skill_sources WHERE name=?').get(name) as {packageId:string;source:string}|undefined;
    return row && { packageId:row.packageId, source:JSON.parse(row.source) as ManagedSource|null };
  }

  bindSource(name:string,packageId:string,source:ManagedSource):string|undefined {
    const prior=this.db.prepare('SELECT name FROM skill_sources WHERE packageId=?').get(packageId) as {name:string}|undefined;
    this.db.prepare(`INSERT INTO skill_sources(name,packageId,source) VALUES(?,?,?)
      ON CONFLICT(packageId) DO UPDATE SET name=excluded.name,source=excluded.source`).run(name,packageId,JSON.stringify(source));
    if(prior && prior.name!==name)return prior.name;
  }

  hasImportedSource(packageId:string,commit:string|null):boolean {
    return Boolean(this.db.prepare(`SELECT 1 FROM skill_version_sources WHERE json_extract(source,'$.packageId')=?
      AND json_extract(source,'$.commit')=? LIMIT 1`).get(packageId,commit));
  }

  source(name:string,version:number):ManagedSource|undefined {const row=this.db.prepare('SELECT source FROM skill_version_sources WHERE name=? AND version=?').get(name,version) as {source:string}|undefined;return row?JSON.parse(row.source):undefined;}
  private version(name:string,version:number) {
    skillName.parse(name);
    const row=this.db.prepare('SELECT * FROM skill_versions WHERE name=? AND version=?').get(name,version) as Row | undefined;
    if(!row)throw new Error('Skill version not found');return row;
  }
  assertCanValidate(name:string,version:number):void {
    const row=this.version(name,version),key=`${name}:${version}`;
    if(this.validating.has(key))throw new Error('Skill validation is already in progress');
    if(row.published_at)throw new Error('Published skill versions are immutable; create a candidate revision');
    if(!this.executor)throw new Error('Worker unavailable: representative skill checks require the execution worker');
  }
  async validate(name:string,version:number) {
    this.assertCanValidate(name,version);
    const row=this.version(name,version),key=`${name}:${version}`;
    this.validating.add(key);
    try {
      const declared=JSON.parse(fs.readFileSync(path.join(row.path,'manifest.json'),'utf8'));
      if(declared.name!==name||declared.version!==version)throw new Error('Package manifest name/version does not match the candidate');
      const actual=packageFiles(row.path),files=actual.filter(f=>f!=='manifest.json');
      if(JSON.stringify(files)!==JSON.stringify([...declared.files].sort()))throw new Error('Package contains undeclared or missing files');
      const input=candidateInput.parse({name,files:Object.fromEntries(files.map(file=>[file,fs.readFileSync(path.join(row.path,safeRelative(file)),'utf8')])),checks:declared.checks});
      for(const check of input.checks){
        for(const file of Object.keys(check.fixtures)){safeRelative(file);if(file.split('/')[0]==='skill')throw new Error('Fixture files cannot overwrite the copied skill package');}
        for(const file of Object.keys(check.expectedFiles??{}))safeRelative(file);
      }
      const meta=metadata(input.files['SKILL.md']!);if(meta.name!==name)throw new Error('Skill metadata name does not match');
      for(const file of files) if(/^scripts\//.test(file)&&/\.(sh|py|js|mjs|cjs)$/.test(file)) {
        if(!input.checks.some(check=>JSON.stringify([check.command,...check.args]).includes(file)))throw new Error(`Executable helper requires representative coverage: ${file}`);
      }
      const before=digest(row.path),startedAt=new Date().toISOString();
      const evidence=await this.executor!({candidatePath:row.path,checks:input.checks});
      if(digest(row.path)!==before)throw new Error('Candidate changed during validation; create or validate a stable revision');
      if(!Array.isArray(evidence.checks)||evidence.checks.length!==input.checks.length)throw new Error('Worker returned incomplete representative evidence');
      const passed=evidence.passed&&evidence.checks.every((check,i)=>check.passed&&check.exitCode===0&&check.name===input.checks[i]!.name);
      const record={...evidence,passed,startedAt,finishedAt:new Date().toISOString(),digest:before,structural:{metadata:true,declaredFiles:true,helpersCovered:true}};
      this.db.prepare('UPDATE skill_versions SET state=?,digest=?,evidence=? WHERE name=? AND version=?').run(passed?'validated':'candidate',before,JSON.stringify(record),name,version);
      this.db.prepare("UPDATE skills SET state=?,updated_at=? WHERE name=? AND active_version IS NULL").run(passed?'validated':'candidate',new Date().toISOString(),name);
      return {name,version,state:passed?'validated':'candidate',evidence:record};
    }finally{this.validating.delete(key);}
  }
  publish(name:string,version:number,activate=true) {
    const row=this.version(name,version);
    if(row.published_at){ if(activate)this.action(name,'activate',String(version));return this.get(name); }
    const evidence=JSON.parse(row.evidence);
    if(row.state!=='validated'||!evidence?.passed||!row.digest)throw new Error('Skill requires successful structural and representative validation before publication');
    if(digest(row.path)!==row.digest)throw new Error('Candidate changed after validation; validate it again');
    const destination=this.versionPath(name,version);
    fs.mkdirSync(path.dirname(destination),{recursive:true,mode:0o700});
    fs.renameSync(row.path,destination);
    for(const file of packageFiles(destination))fs.chmodSync(path.join(destination,file),/^scripts\//.test(file)?0o500:0o400);
    this.db.prepare('UPDATE skill_versions SET path=?,published_at=? WHERE name=? AND version=?').run(destination,new Date().toISOString(),name,version);
    if(activate)this.action(name,'activate',String(version));
    return this.get(name);
  }
  action(name:string,action:'activate'|'disable'|'retire'|'rollback',selected?:string|number) {
    const skill=this.get(name),now=new Date().toISOString();
    let version:number|null=null;
    if(action==='activate'||action==='rollback'){
      version=selected ? Number(selected) : action==='rollback' ? skill.versions.find(v=>v.publishedAt&&v.version<(skill.activeVersion??Infinity))?.version??null : skill.versions.find(v=>v.publishedAt)?.version??null;
      if(version===null||!Number.isSafeInteger(version)||version<1)throw new Error('No applicable published skill version');
      const row=this.version(name,version);
      if(!row.published_at||!row.digest||!JSON.parse(row.evidence)?.passed)throw new Error('Only validated published versions can be activated');
      if(digest(row.path)!==row.digest)throw new Error('Published skill content differs from its validated digest');
    }
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.pointer(name,version);
      this.db.prepare("UPDATE skill_versions SET state='validated' WHERE name=? AND state='active'").run(name);
      if(version!==null)this.db.prepare("UPDATE skill_versions SET state='active' WHERE name=? AND version=?").run(name,version);
      else if(skill.activeVersion!==null)this.db.prepare('UPDATE skill_versions SET state=? WHERE name=? AND version=?').run(action==='retire'?'retired':'disabled',name,skill.activeVersion);
      this.db.prepare('UPDATE skills SET state=?,active_version=?,description=?,updated_at=? WHERE name=?').run(version!==null?'active':action==='retire'?'retired':'disabled',version,version!==null?this.version(name,version).description:skill.description,now,name);
      this.db.exec('COMMIT');
    }catch(error){this.db.exec('ROLLBACK');this.recoverPointers();throw error;}
    return this.get(name);
  }
  snapshots():SkillSnapshot[]{
    return (this.db.prepare('SELECT name,active_version FROM skills WHERE active_version IS NOT NULL AND state=\'active\' ORDER BY name').all() as Row[])
      .map(r=>({name:r.name,path:this.versionPath(r.name,r.active_version),version:Number(r.active_version)}));
  }
  outcome(name:string,version:number,outcome:string,summary:string,runId?:string,metrics?:unknown){
    this.version(name,version);
    const id=randomUUID();this.db.prepare('INSERT INTO skill_usage(id,name,version,run_id,outcome,summary,metrics,created_at) VALUES(?,?,?,?,?,?,?,?)').run(id,name,version,runId??null,outcome,summary,metrics?JSON.stringify(metrics):null,new Date().toISOString());return{id,recorded:true};
  }
}
