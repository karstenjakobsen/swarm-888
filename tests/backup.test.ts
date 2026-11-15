import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/store.ts';
import { Brain } from '../src/brain/index.ts';
import { exportBrain, restoreBrain } from '../src/backup.ts';
import { acquireLock } from '../src/lock.ts';
import { checkSkill } from '../src/runtime/fixtures.ts';
import { WorkerJournal } from '../src/runtime/journal.ts';
import type { Config } from '../src/config.ts';

function config(stateDir:string):Config{
  for(const dir of ['secrets','runtime','skills','workspaces','artifacts','worker'])mkdirSync(path.join(stateDir,dir),{recursive:true,mode:0o700});
  writeFileSync(path.join(stateDir,'secrets/ipc-token'),'a'.repeat(64),{mode:0o600});
  return{stateDir,socketPath:path.join(stateDir,'worker.sock'),bridgeSocket:path.join(stateDir,'bridge.sock'),ipcToken:'a'.repeat(64),controllerUid:process.getuid!(),codexBin:'codex',runtimeHome:path.join(stateDir,'runtime'),host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'backup-test-credential',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
}
const candidate=(factor:number)=>({name:'backup-report',files:{
  'SKILL.md':'---\nname: backup-report\ndescription: Produce a deterministic sum report from a JSON fixture.\n---\nRun scripts/report.mjs with a JSON input filename to print a numeric sum.\n',
  'scripts/report.mjs':`import fs from 'node:fs';console.log(JSON.parse(fs.readFileSync(process.argv[2],'utf8')).reduce((a,b)=>a+b,0)*${factor});\n`,
},checks:[{name:'sum fixture',command:process.execPath,args:['{skill}/scripts/report.mjs','{fixture}/input.json'],fixtures:{'input.json':'[4,5]'},expectedStdout:`${9*factor}\n`,timeoutMs:10000}]});

test('SQLite snapshot restores memory, both immutable skills, active revision and rebased native sessions into fresh state',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'operator-backup-')),source=config(path.join(root,'source')),target=config(path.join(root,'restored')),snapshot=path.join(root,'snapshot');
  const store=new Store(source.stateDir),brain=new Brain(store.db,source.stateDir);await brain.initialize();brain.setExecutor(spec=>checkSkill(source.stateDir,spec));
  try{
    const memory=brain.memoryWrite({content:'backupunique fact: violet bananas are the fixture marker',kind:'user_fact',source:'snapshot test owner',tags:['backup']});brain.setInstructions('Keep exact provenance after restore.');
    for(const factor of [1,2]){const skill:any=await brain.callTool('skill_create',candidate(factor));const validation:any=await brain.callTool('skill_validate',{name:skill.name,version:skill.version});assert.equal(validation.evidence.passed,true);await brain.callTool('skill_publish',{name:skill.name,version:skill.version});}
    brain.skillAction('backup-report','rollback');
    const conversation=store.newConversation('snapshot fixture'),run=store.enqueue(conversation.id,'fixture completed','snapshot-request');store.transition(run.id,'running');store.transition(run.id,'completed');
    store.db.prepare('INSERT INTO sessions VALUES(?,?,?)').run('old-session','old-csrf',Date.now()+60000);
    mkdirSync(path.join(source.stateDir,'runtime/sessions'),{recursive:true});
    const originalRollout=path.join(source.stateDir,'runtime/sessions/session.jsonl'),originalCwd=path.join(source.stateDir,'workspaces',conversation.id);
    mkdirSync(path.join(originalCwd,'.agents/skills'),{recursive:true});symlinkSync(brain.snapshotSkills().find(s=>s.name==='backup-report')!.path,path.join(originalCwd,'.agents/skills/backup-report'));
    writeFileSync(originalRollout,[JSON.stringify({type:'session_meta',payload:{id:'thread-fixture',cwd:originalCwd}}),JSON.stringify({type:'turn_context',payload:{cwd:originalCwd}}),JSON.stringify({type:'event_msg',payload:{message:`Historical source was ${originalCwd}`}}),''].join('\n'));
    const native=new DatabaseSync(path.join(source.stateDir,'runtime/state_5.sqlite'));native.exec('CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL,cwd TEXT NOT NULL);CREATE TABLE project_roots(path TEXT PRIMARY KEY);');native.prepare('INSERT INTO threads VALUES(?,?,?)').run('thread-fixture',originalRollout,originalCwd);native.prepare('INSERT INTO project_roots VALUES(?)').run(originalCwd);native.close();
    writeFileSync(path.join(source.stateDir,'runtime/auth.json'),'model-secret-omitted');writeFileSync(path.join(source.stateDir,'runtime/.credentials.json'),'credential-omitted');writeFileSync(path.join(source.stateDir,'artifacts/report.txt'),'independent report\n');
    const result=await exportBrain(source,snapshot);assert.equal(result.path,snapshot);assert.equal(existsSync(path.join(snapshot,'secrets')),false);assert.equal(existsSync(path.join(snapshot,'runtime/auth.json')),false);assert.equal(existsSync(path.join(snapshot,'runtime/.credentials.json')),false);
    const snapdb=new DatabaseSync(path.join(snapshot,'operator.sqlite'),{readOnly:true});assert.equal((snapdb.prepare('SELECT COUNT(*) n FROM sessions').get() as any).n,0);snapdb.close();
    assert.equal((await restoreBrain(target,snapshot)).reauthenticationRequired,true);
    const restoredStore=new Store(target.stateDir),restoredBrain=new Brain(restoredStore.db,target.stateDir);await restoredBrain.initialize();
    try{
      assert.equal(restoredBrain.memorySearch('backupunique')[0]?.id,memory.id);assert.equal(restoredBrain.getInstructions(),'Keep exact provenance after restore.');
      const details=restoredBrain.skillGet('backup-report');assert.equal(details.activeVersion,1);assert.equal(details.versions.length,2);assert.ok(details.versions.every(v=>v.path.startsWith(target.stateDir)));assert.ok(details.versions.every(v=>v.evidence.passed));
      const active=restoredBrain.snapshotSkills().find(s=>s.name==='backup-report')!;
      const evidence=await checkSkill(target.stateDir,{candidatePath:active.path,checks:[{name:'new input after restore',command:process.execPath,args:['{skill}/scripts/report.mjs','{fixture}/new.json'],fixtures:{'new.json':'[10,20]'},expectedStdout:'30\n',timeoutMs:10000}]});assert.equal(evidence.passed,true);
      restoredBrain.skillAction('backup-report','activate','2');assert.equal(restoredBrain.skillGet('backup-report').activeVersion,2);
      assert.equal(readFileSync(path.join(target.stateDir,'artifacts/report.txt'),'utf8'),'independent report\n');assert.equal(existsSync(path.join(target.stateDir,'workspaces',conversation.id,'.agents/skills')),false);
      const restoredNative=new DatabaseSync(path.join(target.stateDir,'runtime/state_5.sqlite'),{readOnly:true});const thread=restoredNative.prepare('SELECT * FROM threads').get() as any;assert.equal(thread.rollout_path,path.join(target.stateDir,'runtime/sessions/session.jsonl'));assert.equal(thread.cwd,path.join(target.stateDir,'workspaces',conversation.id));assert.equal((restoredNative.prepare('SELECT path FROM project_roots').get() as any).path,thread.cwd);restoredNative.close();
      const transcript=readFileSync(thread.rollout_path,'utf8').trim().split('\n').map(line=>JSON.parse(line));assert.equal(transcript[0].payload.cwd,thread.cwd);assert.equal(transcript[1].payload.cwd,thread.cwd);assert.match(transcript[2].payload.message,new RegExp(source.stateDir));
    }finally{restoredStore.close();}
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('snapshot refuses live controller or worker locks and unresolved controller/worker execution',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'operator-backup-lock-')),source=config(path.join(root,'source')),store=new Store(source.stateDir);await new Brain(store.db,source.stateDir).initialize();
  try{
    let release=acquireLock(path.join(source.stateDir,'controller.lock'));
    await assert.rejects(exportBrain(source,path.join(root,'snapshot1')),/Another process owns/);release();
    release=acquireLock(path.join(source.stateDir,'worker/lock.json'));await assert.rejects(exportBrain(source,path.join(root,'snapshot2')),/Stop both controller and worker/);release();
    const conversation=store.newConversation(),run=store.enqueue(conversation.id,'ambiguous action','ambiguous-request');store.transition(run.id,'running');store.transition(run.id,'uncertain');
    await assert.rejects(exportBrain(source,path.join(root,'snapshot3')),/active\/uncertain execution/);store.transition(run.id,'interrupted');
    const journal=new WorkerJournal(source.stateDir);journal.accept({runId:'worker-uncertain',conversationId:conversation.id,prompt:'fixture',cwd:path.join(source.stateDir,'workspaces'),bootstrap:'',skills:[],kind:'user',threadId:null});journal.status('worker-uncertain','uncertain');
    await assert.rejects(exportBrain(source,path.join(root,'snapshot4')),/Resolve owned worker execution/);
    journal.status('worker-uncertain','interrupted');journal.beginCheck('fixture_owned_orphan',null,path.join(source.stateDir,'skills/staging/fixture'));
    await assert.rejects(exportBrain(source,path.join(root,'snapshot5')),/representative skill-check execution/);journal.close();
    await assert.rejects(exportBrain(source,path.join(source.stateDir,'nested-snapshot')),/outside APP_STATE_DIR/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('invalid snapshots leave a fresh restore destination usable and never publish a partial database',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'operator-backup-invalid-')),source=config(path.join(root,'source')),target=config(path.join(root,'target')),snapshot=path.join(root,'snapshot'),store=new Store(source.stateDir);const brain=new Brain(store.db,source.stateDir);await brain.initialize();
  try{
    await exportBrain(source,snapshot);const db=new DatabaseSync(path.join(snapshot,'operator.sqlite'));db.prepare('UPDATE skill_versions SET path=?').run('/unrelated/SKILL');db.close();
    await assert.rejects(restoreBrain(target,snapshot),/outside its state directory/);assert.equal(existsSync(path.join(target.stateDir,'operator.sqlite')),false);assert.equal(existsSync(path.join(target.stateDir,'controller.lock')),false);assert.equal(existsSync(path.join(target.stateDir,'worker/lock.json')),false);
    const repaired=new DatabaseSync(path.join(snapshot,'operator.sqlite'));repaired.prepare('UPDATE skill_versions SET path=?').run(brain.skillGet('skill-maintenance').versions[0]!.path);repaired.close();
    await restoreBrain(target,snapshot);assert.equal(existsSync(path.join(target.stateDir,'operator.sqlite')),true);
    await assert.rejects(restoreBrain(target,snapshot),/fresh APP_STATE_DIR/);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('restore rejects symlinked skill directories before touching external files',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'operator-backup-symlink-')),source=config(path.join(root,'source')),target=config(path.join(root,'target')),snapshot=path.join(root,'snapshot'),outside=path.join(root,'outside');
  const store=new Store(source.stateDir);await new Brain(store.db,source.stateDir).initialize();
  try{
    await exportBrain(source,snapshot);mkdirSync(outside);writeFileSync(path.join(outside,'keep.txt'),'unrelated content');
    rmSync(path.join(snapshot,'skills/active'),{recursive:true});symlinkSync(outside,path.join(snapshot,'skills/active'));
    await assert.rejects(restoreBrain(target,snapshot),/real directories without symlinks/);
    assert.equal(readFileSync(path.join(outside,'keep.txt'),'utf8'),'unrelated content');
    assert.equal(existsSync(path.join(target.stateDir,'operator.sqlite')),false);
    assert.equal(existsSync(path.join(target.stateDir,'controller.lock')),false);
    assert.equal(existsSync(path.join(target.stateDir,'worker/lock.json')),false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});

test('legacy snapshots fail closed for external execution roots and registered projects',async()=>{
  const root=mkdtempSync(path.join(tmpdir(),'operator-backup-project-layout-')),source=config(path.join(root,'source')),target=config(path.join(root,'target')),snapshot=path.join(root,'snapshot');
  const store=new Store(source.stateDir);await new Brain(store.db,source.stateDir).initialize();
  try{
    const external={...source,runtimeHome:path.join(root,'executor/codex'),projectsDir:path.join(root,'projects')};
    await assert.rejects(exportBrain(external,snapshot),/owner-controlled backup/);
    assert.equal(existsSync(snapshot),false);assert.equal(existsSync(path.join(source.stateDir,'controller.lock')),false);
    await exportBrain(source,snapshot);
    await assert.rejects(restoreBrain({...target,runtimeHome:path.join(root,'restored-executor/codex')},snapshot),/automatic external-data restore is not supported/);
    assert.equal(existsSync(path.join(target.stateDir,'operator.sqlite')),false);
    const now=new Date().toISOString();store.projects.create({id:'d9cde03b-ce43-48c7-a568-cd88ef41f738',name:'Registered project',description:'Metadata only',directory:path.join(source.stateDir,'projects/site'),origin:'created',createdAt:now,updatedAt:now});
    await assert.rejects(exportBrain(source,path.join(root,'project-snapshot')),/do not include project workspace data/);
    assert.equal(existsSync(path.join(root,'project-snapshot')),false);
  }finally{store.close();rmSync(root,{recursive:true,force:true});}
});
