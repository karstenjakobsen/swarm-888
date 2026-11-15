import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync, mkdirSync, cpSync, readFileSync, writeFileSync, chmodSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Brain } from '../src/brain/index.js';
import type { CheckSpec, CheckEvidence } from '../src/brain/schemas.js';

const exec=promisify(execFile);
async function representativeExecutor(spec:CheckSpec):Promise<CheckEvidence>{
  const root=mkdtempSync(path.join(tmpdir(),'operator-fixture-'));
  try{
    const checks=[];
    for(const check of spec.checks){
      const fixture=path.join(root,String(checks.length));mkdirSync(fixture,{recursive:true});cpSync(spec.candidatePath,path.join(fixture,'skill'),{recursive:true});
      for(const [file,body] of Object.entries(check.fixtures)){mkdirSync(path.dirname(path.join(fixture,file)),{recursive:true});writeFileSync(path.join(fixture,file),body);}
      const replace=(s:string)=>s.replaceAll('{skill}',path.join(fixture,'skill')).replaceAll('{fixture}',fixture);
      const started=Date.now();let stdout='',stderr='',exitCode:number|null=0,error:string|undefined;
      try{const output=await exec(check.command==='node'?process.execPath:check.command,check.args.map(replace),{cwd:fixture,timeout:check.timeoutMs});stdout=output.stdout;stderr=output.stderr;}catch(e:any){stdout=e.stdout??'';stderr=e.stderr??'';exitCode=e.code??null;error=e.message;}
      const passed=exitCode===0&&(check.expectedStdout===undefined||check.expectedStdout===stdout)&&Object.entries(check.expectedFiles??{}).every(([file,body])=>{try{return readFileSync(path.join(fixture,file),'utf8')===body;}catch{return false;}});
      checks.push({name:check.name,exitCode,stdout,stderr,passed,error,durationMs:Date.now()-started});
    }
    return{passed:checks.every(c=>c.passed),checks};
  }finally{rmSync(root,{recursive:true,force:true});}
}
async function fixture(){
  const state=mkdtempSync(path.join(tmpdir(),'operator-brain-')),file=path.join(state,'operator.sqlite');
  const db=new DatabaseSync(file);db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; CREATE TABLE runs(id TEXT PRIMARY KEY,summary TEXT,status TEXT,createdAt TEXT);');
  const brain=new Brain(db,state);await brain.initialize();brain.setExecutor(representativeExecutor);
  return{state,file,db,brain,close:()=>{db.close();rmSync(state,{recursive:true,force:true});}};
}
const report=(factor=1)=>({name:'fixture-report',files:{
  'SKILL.md':'---\nname: fixture-report\ndescription: Generate a deterministic report from a numeric JSON fixture.\n---\nRun scripts/report.mjs on a JSON array to print the sum.\n',
  'scripts/report.mjs':`import fs from 'node:fs';const values=JSON.parse(fs.readFileSync(process.argv[2],'utf8'));console.log(values.reduce((a,b)=>a+b,0)*${factor});\n`,
},checks:[{name:'sums two values',command:'node',args:['{skill}/scripts/report.mjs','{fixture}/values.json'],fixtures:{'values.json':'[2,3]'},expectedStdout:`${5*factor}\n`,timeoutMs:10000}]});

test('memory FTS, provenance, revision history, links and supersession survive reopening',async()=>{
  const f=await fixture();
  try{
    const first=f.brain.memoryWrite({content:'The unique amber-banana token is 1289',kind:'user_fact',source:'owner conversation',tags:['unique'],project:'alpha'});
    assert.equal(f.brain.memorySearch('amber-banana',{project:'alpha',tag:'unique'})[0]?.id,first.id);
    const updated=f.brain.memoryWrite({content:'The unique amber-banana token is 1290',kind:'user_fact',source:'owner correction',expectedRevision:1,id:first.id,category:'fact',tags:['unique'],project:'alpha'});
    assert.equal(updated.revision,2);assert.equal(f.brain.memoryGet(first.id).revisions.length,2);
    assert.throws(()=>f.brain.memoryWrite({id:first.id,content:'stale edit',kind:'user_fact',source:'owner',expectedRevision:1}),/revision conflict/);
    const observation=f.brain.memoryWrite({content:'Disk was 12 GB',kind:'observation',source:'df output',checkedAt:'2026-01-01T00:00:00.000Z'});
    assert.throws(()=>f.brain.memoryWrite({content:'unchecked disk',kind:'observation',source:'guess'}),/Observations require/);
    await f.brain.callTool('memory_link',{fromId:first.id,toId:observation.id,relation:'checked_with'});
    await f.brain.callTool('memory_supersede',{id:first.id,byId:observation.id,reason:'checked replacement'});
    assert.equal(f.brain.memorySearch('amber-banana').length,0);assert.equal(f.brain.memoryGet(first.id).state,'superseded');
    f.db.close();const reopened=new DatabaseSync(f.file);const brain=new Brain(reopened,f.state);await brain.initialize();
    assert.equal(brain.memorySearch('amber-banana',{state:'all'})[0]?.revision,3);assert.equal(brain.memoryGet(first.id).links.length,2);reopened.close();
  }finally{try{f.db.close();}catch{}rmSync(f.state,{recursive:true,force:true});}
});

test('memory index removes obsolete terms on update and checkpoint persists actual task summary',async()=>{
  const f=await fixture();try{
    const first=f.brain.memoryWrite({content:'olduniqueterm',kind:'inference',source:'test reasoning'});
    f.brain.memoryWrite({id:first.id,content:'newuniqueterm',kind:'inference',source:'corrected reasoning'});
    assert.equal(f.brain.memorySearch('olduniqueterm').length,0);assert.equal(f.brain.memorySearch('newuniqueterm').length,1);
    f.db.prepare('INSERT INTO runs VALUES(?,?,?,?)').run('run-1','','running',new Date().toISOString());
    await f.brain.callTool('progress_checkpoint',{summary:'Created fixture; next verify output'},{runId:'run-1',conversationId:'conversation-1'});
    assert.equal((f.db.prepare('SELECT summary FROM runs WHERE id=?').get('run-1') as any).summary,'Created fixture; next verify output');
    assert.match(f.brain.bootstrap(),/Created fixture; next verify output/);
    await assert.rejects(f.brain.callTool('progress_checkpoint',{summary:'missing run'},{runId:'unknown'}),/Current run not found/);
  }finally{f.close();}
});

test('skills require representative evidence, retain immutable versions, rollback and restore active pointers',async()=>{
  const f=await fixture();try{
    const v1:any=await f.brain.callTool('skill_create',report());
    await assert.rejects(f.brain.callTool('skill_publish',{name:v1.name,version:v1.version}),/requires successful/);
    const validated:any=await f.brain.callTool('skill_validate',{name:v1.name,version:v1.version});assert.equal(validated.evidence.passed,true);assert.equal(validated.evidence.checks[0].stdout,'5\n');
    await f.brain.callTool('skill_publish',{name:v1.name,version:v1.version});
    const firstPath=f.brain.snapshotSkills()[0]!.path;
    const v2:any=await f.brain.callTool('skill_create',report(2));assert.equal(f.brain.skillGet(v1.name).activeVersion,1);
    await f.brain.callTool('skill_validate',{name:v2.name,version:v2.version});await f.brain.callTool('skill_publish',{name:v2.name,version:v2.version});
    assert.equal(f.brain.skillGet(v1.name).activeVersion,2);assert.match(readFileSync(path.join(firstPath,'scripts/report.mjs'),'utf8'),/\*1/);
    f.brain.skillAction(v1.name,'rollback');assert.equal(f.brain.skillGet(v1.name).activeVersion,1);
    rmSync(path.join(f.state,'skills/active',v1.name));await f.brain.initialize();assert.equal(f.brain.snapshotSkills()[0]?.version,1);
    f.brain.skillAction(v1.name,'disable');await f.brain.initialize();assert.equal(f.brain.snapshotSkills().length,0);
    await f.brain.callTool('skill_action',{name:v1.name,action:'activate',version:2});assert.equal(f.brain.snapshotSkills()[0]?.version,2);
    await assert.rejects(f.brain.callTool('skill_action',{name:v1.name,action:'activate',version:0}));
    await assert.rejects(f.brain.callTool('skill_action',{name:v1.name,action:'activate',version:'9007199254740993'}));
  }finally{f.close();}
});

test('failed checks, undeclared files and changed validated content prevent skill publication',async()=>{
  const f=await fixture();try{
    const input=report();input.checks[0]!.expectedStdout='wrong\n';const candidate:any=await f.brain.callTool('skill_create',input);
    const result:any=await f.brain.callTool('skill_validate',{name:candidate.name,version:1});assert.equal(result.evidence.passed,false);
    await assert.rejects(f.brain.callTool('skill_publish',{name:candidate.name,version:1}),/requires successful/);
    const good:any=await f.brain.callTool('skill_create',report());writeFileSync(path.join(good.path,'extra.txt'),'undeclared');
    await assert.rejects(f.brain.callTool('skill_validate',{name:good.name,version:2}),/undeclared/);rmSync(path.join(good.path,'extra.txt'));
    await f.brain.callTool('skill_validate',{name:good.name,version:2});writeFileSync(path.join(good.path,'SKILL.md'),input.files['SKILL.md']+'Edited after validation.');
    await assert.rejects(f.brain.callTool('skill_publish',{name:good.name,version:2}),/changed after validation/);
    await assert.rejects(f.brain.callTool('skill_create',{...report(),files:{...report().files,'../escape':'bad'}}),/Invalid package path/);
  }finally{f.close();}
});

test('interrupted publication repairs database location without silently activating a package',async()=>{
  const f=await fixture();try{
    const c:any=await f.brain.callTool('skill_create',report());await f.brain.callTool('skill_validate',{name:c.name,version:1});
    const final=path.join(f.state,'skills/packages',c.name,'v1');mkdirSync(path.dirname(final),{recursive:true});renameSync(c.path,final);
    await f.brain.initialize();const version=f.brain.skillGet(c.name).versions[0]!;assert.equal(version.path,final);assert.ok(version.publishedAt);assert.equal(f.brain.snapshotSkills().length,0);
    f.brain.skillAction(c.name,'activate','1');assert.equal(f.brain.snapshotSkills()[0]?.version,1);
  }finally{f.close();}
});

test('foundation is seeded once, validated through worker hook, and owner changes persist',async()=>{
  const f=await fixture();try{
    assert.equal(f.brain.skillGet('skill-maintenance').state,'candidate');await f.brain.ensureFoundation();
    assert.equal(f.brain.skillGet('skill-maintenance').state,'active');f.brain.skillAction('skill-maintenance','disable');f.brain.setInstructions('Always checkpoint before editing service configuration.');
    await f.brain.initialize();await f.brain.ensureFoundation();assert.equal(f.brain.skillGet('skill-maintenance').state,'disabled');assert.match(f.brain.bootstrap(),/Always checkpoint/);
  }finally{f.close();}
});

test('disabling the foundational candidate before worker startup is respected',async()=>{
  const f=await fixture();
  try{
    f.brain.skillAction('skill-maintenance','disable');
    f.brain.setExecutor(async()=>{throw new Error('Disabled foundational candidate must not execute');});
    await f.brain.ensureFoundation();
    await f.brain.initialize();await f.brain.ensureFoundation();
    assert.equal(f.brain.skillGet('skill-maintenance').state,'disabled');
  }finally{f.close();}
});
