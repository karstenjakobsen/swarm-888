import { backup, DatabaseSync } from 'node:sqlite';
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync, lstatSync, realpathSync } from 'node:fs';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { Config } from './config.ts';
import { acquireLock } from './lock.ts';
import { rebaseNativeState } from './runtime/restore.ts';

function inside(root:string,entry:string){const rel=relative(root,entry);return !rel.startsWith('..')&&!isAbsolute(rel);}
function verifyDirectory(directory:string){
  let info;
  try{info=lstatSync(directory);}catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error;}
  if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(directory)!==resolve(directory))throw new Error('Snapshot state directories must be real directories without symlinks');
}
const snapshotManifest=z.object({format:z.literal(1),createdAt:z.string().datetime(),sourceStateDir:z.string().refine(isAbsolute,'Snapshot state directory must be absolute'),credentialsIncluded:z.literal(false)});
function verifyDatabase(file:string){
  const db=new DatabaseSync(file,{readOnly:true});
  try{
    if((db.prepare('PRAGMA integrity_check').get() as Record<string,unknown>).integrity_check!=='ok')throw new Error('Snapshot database integrity check failed');
    if(db.prepare('PRAGMA foreign_key_check').all().length)throw new Error('Snapshot contains invalid foreign-key references');
  }finally{db.close();}
}
function legacySnapshotLayout(config:Config,operation:'export'|'restore'){
  const workers=join(config.stateDir,'workers');
  if(existsSync(workers)&&readdirSync(workers).length)throw new Error(`Legacy brain ${operation} does not include named worker journals or credential profiles. Use an owner-controlled backup of the complete stopped operator state and project roots.`);
  const runtime=resolve(config.runtimeHome),expected=join(resolve(config.stateDir),'runtime');
  const projects=config.projectsDir&&resolve(config.projectsDir);
  if(runtime!==expected||(projects&&!inside(config.stateDir,projects)))throw new Error(`Legacy brain ${operation} does not include a custom runtime profile or external project directories. Use an owner-controlled backup of operator state, the runtime profile and APP_PROJECTS_DIR together; automatic external-data restore is not supported.`);
}
function rejectProjectSnapshot(database:string){
  if(!existsSync(database))return;
  const db=new DatabaseSync(database,{readOnly:true});
  try{
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='projects'").get()&&db.prepare('SELECT id FROM projects LIMIT 1').get())throw new Error('Legacy brain snapshots do not include project workspace data or rebase project directories. Use an owner-controlled backup of operator state and projects together.');
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='repositories'").get()&&db.prepare('SELECT id FROM repositories LIMIT 1').get())throw new Error('Legacy brain snapshots do not include registered source repositories. Back up the complete stopped operator state and APP_PROJECTS_DIR together.');
  }finally{db.close();}
}
function maintenance(config:Config):()=>void {
  const release=acquireLock(join(config.stateDir,'controller.lock'));
  try {const workerRelease=acquireLock(join(config.stateDir,'worker/lock.json'));return ()=>{workerRelease();release();};}
  catch(error){release();throw new Error(`Stop both controller and worker for the maintenance window: ${(error as Error).message}`);}
}
async function sqliteSnapshot(source:string,destination:string){
  const db=new DatabaseSync(source,{readOnly:true});try {await backup(db,destination);}finally{db.close();}
}
export async function exportBrain(config:Config,destination:string){
  legacySnapshotLayout(config,'export');
  rejectProjectSnapshot(join(config.stateDir,'operator.sqlite'));
  const target=resolve(destination);
  if(inside(config.stateDir,target))throw new Error('Snapshot destination must be outside APP_STATE_DIR');
  if(existsSync(target))throw new Error('Snapshot destination already exists; choose a new directory');
  const release=maintenance(config),temp=`${target}.partial-${randomUUID()}`;
  try{
    const source=join(config.stateDir,'operator.sqlite');if(!existsSync(source))throw new Error('Initialize the database before exporting');
    const check=new DatabaseSync(source,{readOnly:true});
    try{if(check.prepare("SELECT id FROM runs WHERE status IN ('running','waiting','uncertain') LIMIT 1").get())throw new Error('Reconcile or interrupt active/uncertain execution before exporting');}finally{check.close();}
    const journal=join(config.stateDir,'worker/journal.sqlite');
    if(existsSync(journal)){const db=new DatabaseSync(journal,{readOnly:true});try{
      if(db.prepare("SELECT id FROM worker_runs WHERE status IN ('accepted','running','waiting','uncertain') LIMIT 1").get())throw new Error('Resolve owned worker execution before exporting');
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_checks'").get()&&db.prepare('SELECT id FROM worker_checks LIMIT 1').get())throw new Error('Resolve owned representative skill-check execution before exporting');
      if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='worker_runtime_operations'").get()&&db.prepare('SELECT id FROM worker_runtime_operations LIMIT 1').get())throw new Error('Resolve or acknowledge runtime operations before exporting');
    }finally{db.close();}}
    mkdirSync(temp,{recursive:true,mode:0o700});
    await sqliteSnapshot(source,join(temp,'operator.sqlite'));
    const db=new DatabaseSync(join(temp,'operator.sqlite'));try{db.exec('DELETE FROM sessions;');}finally{db.close();}
    verifyDatabase(join(temp,'operator.sqlite'));
    for(const dir of ['skills','runtime','workspaces','artifacts']){
      cpSync(join(config.stateDir,dir),join(temp,dir),{recursive:true,verbatimSymlinks:true,
        filter:path=>![join(config.stateDir,'runtime/auth.json'),join(config.stateDir,'runtime/.credentials.json')].includes(path)&&!path.startsWith(join(config.stateDir,'runtime/log')+'/')});
    }
    if(existsSync(journal)){mkdirSync(join(temp,'worker'),{mode:0o700});await sqliteSnapshot(journal,join(temp,'worker/journal.sqlite'));}
    writeFileSync(join(temp,'snapshot.json'),JSON.stringify({format:1,createdAt:new Date().toISOString(),sourceStateDir:config.stateDir,credentialsIncluded:false},null,2),{mode:0o600});
    renameSync(temp,target);return {path:target};
  }catch(error){rmSync(temp,{recursive:true,force:true});throw error;}finally{release();}
}
export async function restoreBrain(config:Config,source:string){
  legacySnapshotLayout(config,'restore');
  rejectProjectSnapshot(join(resolve(source),'operator.sqlite'));
  const root=resolve(source),manifest=snapshotManifest.parse(JSON.parse(readFileSync(join(root,'snapshot.json'),'utf8')));
  if(existsSync(join(config.stateDir,'operator.sqlite')))throw new Error('Restore requires a fresh APP_STATE_DIR without an existing database');
  const release=maintenance(config),stage=join(config.stateDir,`.restore-${randomUUID()}`);
  const installed:string[]=[];
  try{
    for(const dir of ['skills','runtime','workspaces','artifacts','worker']){
      const entries=readdirSync(join(config.stateDir,dir));
      if(entries.some(name=>!(dir==='worker'&&name==='lock.json')))throw new Error(`Restore destination ${dir} is not empty`);
    }
    mkdirSync(stage,{mode:0o700});
    await sqliteSnapshot(join(root,'operator.sqlite'),join(stage,'operator.sqlite'));
    verifyDatabase(join(stage,'operator.sqlite'));
    for(const dir of ['skills','runtime','workspaces','artifacts']){
      mkdirSync(join(stage,dir),{mode:0o700});
      if(existsSync(join(root,dir)))cpSync(join(root,dir),join(stage,dir),{recursive:true,verbatimSymlinks:true});
    }
    for(const dir of ['skills','skills/staging','skills/packages','skills/active','runtime','workspaces','artifacts'])verifyDirectory(join(stage,dir));
    if(existsSync(join(root,'worker/journal.sqlite'))){mkdirSync(join(stage,'worker'),{mode:0o700});await sqliteSnapshot(join(root,'worker/journal.sqlite'),join(stage,'worker/journal.sqlite'));verifyDatabase(join(stage,'worker/journal.sqlite'));}
    // Package locations are authoritative files; rewrite only indexed paths, not sourced memories.
    const db=new DatabaseSync(join(stage,'operator.sqlite'));
    try{
      const rows=db.prepare('SELECT name,version,path FROM skill_versions').all() as Array<{name:string;version:number;path:string}>;
      for(const row of rows){
        if(!inside(manifest.sourceStateDir,row.path))throw new Error('Snapshot contains a skill path outside its state directory');
        const rel=relative(manifest.sourceStateDir,row.path);
        if(!rel.startsWith('skills/'))throw new Error('Snapshot skill package is outside the skill directory');
        const packagePath=join(stage,rel),instructions=join(packagePath,'SKILL.md');
        if(!existsSync(instructions)||!lstatSync(instructions).isFile()||realpathSync(instructions)!==instructions)throw new Error('Snapshot skill package is missing or is a symlink');
        verifyDirectory(packagePath);
        db.prepare('UPDATE skill_versions SET path=? WHERE name=? AND version=?').run(join(config.stateDir,rel),row.name,row.version);
      }
      db.exec('DELETE FROM sessions;');
    }finally{db.close();}
    // Rebuilt from the restored database on initialization; never follow old absolute links.
    const active=join(stage,'skills/active');if(existsSync(active))for(const entry of readdirSync(active))rmSync(join(active,entry),{force:true});
    function clearDiscovery(dir:string){for(const entry of readdirSync(dir,{withFileTypes:true})){if(entry.isSymbolicLink())continue;const path=join(dir,entry.name);if(entry.isDirectory()){if(entry.name==='.agents'){const skills=join(path,'skills');if(existsSync(skills))rmSync(skills,{recursive:true,force:true});}else clearDiscovery(path);}}}
    clearDiscovery(join(stage,'workspaces'));
    rebaseNativeState(join(stage,'runtime'),manifest.sourceStateDir,config.stateDir);
    // No data is published until every copied database and package has passed verification.
    for(const dir of ['skills','runtime','workspaces','artifacts']){
      rmSync(join(config.stateDir,dir),{recursive:true});renameSync(join(stage,dir),join(config.stateDir,dir));installed.push(dir);
    }
    if(existsSync(join(stage,'worker/journal.sqlite'))){renameSync(join(stage,'worker/journal.sqlite'),join(config.stateDir,'worker/journal.sqlite'));installed.push('worker/journal.sqlite');}
    renameSync(join(stage,'operator.sqlite'),join(config.stateDir,'operator.sqlite'));installed.push('operator.sqlite');
    return {stateDir:config.stateDir,reauthenticationRequired:true};
  }catch(error){
    for(const entry of installed)rmSync(join(config.stateDir,entry),{recursive:true,force:true});
    for(const dir of ['skills','runtime','workspaces','artifacts'])mkdirSync(join(config.stateDir,dir),{recursive:true,mode:0o700});
    throw error;
  }finally{rmSync(stage,{recursive:true,force:true});release();}
}
