import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFileSync } from 'node:child_process';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Brain } from '../src/brain/index.ts';
import { initState,type Config } from '../src/config.ts';
import { ManagedService } from '../src/managed/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { CredentialVault } from '../src/credentials/vault.ts';
import { checkSkill } from '../src/runtime/fixtures.ts';
import type { WorkerClient } from '../src/ipc.ts';
const git=(path:string,...args:string[])=>execFileSync('git',['-C',path,...args],{encoding:'utf8'}).trim();
test('reusable skill source and checks commit to the managed repository and pin immutable runtime versions',async()=>{
  const root=mkdtempSync(join(tmpdir(),'operator-skill-source-')),stateDir=join(root,'state'),repositoryPath=join(root,'repository');mkdirSync(stateDir,{mode:0o700});mkdirSync(repositoryPath);
  git(repositoryPath,'init','-q','-b','main');writeFileSync(join(repositoryPath,'owner.txt'),'Owner baseline\n');git(repositoryPath,'add','owner.txt');git(repositoryPath,'-c','user.name=Fixture','-c','user.email=fixture@example.test','commit','-qm','Baseline');writeFileSync(join(repositoryPath,'owner.txt'),'Owner staged work\n');git(repositoryPath,'add','owner.txt');const owner=git(repositoryPath,'diff','--cached');
  const config={stateDir,repositoryPath,projectsDir:join(stateDir,'projects'),controllerUid:process.getuid!()}as Config;initState(config);const store=new Store(stateDir);store.db.exec(readFileSync(new URL('../migrations/007-credentials.sql',import.meta.url),'utf8'));const brain=new Brain(store.db,stateDir),client=new EventEmitter() as WorkerClient;
  const projects=new ProjectService(config,store,client,()=>false),managed=new ManagedService(config,store,projects,client),vault=new CredentialVault(stateDir,store.db),connectors=new ConnectorService(store,client,projects,managed,undefined,vault);
  try{
    await brain.initialize();brain.setManaged(managed,connectors);brain.setSecretGuard(value=>vault.assertSafe(value));managed.repository.setSecretGuard(value=>vault.assertSafe(value));brain.setExecutor(spec=>checkSkill(stateDir,spec,{spawned:()=>{},config}));
    const candidate=(text:string)=>({name:'fixture-report',files:{'SKILL.md':'---\nname: fixture-report\ndescription: A reproducible local report skill.\n---\nRun the helper to produce a deterministic report.\n','scripts/report.mjs':`process.stdout.write(${JSON.stringify(text)});`},checks:[{name:'local report',command:process.execPath,args:['{skill}/scripts/report.mjs'],fixtures:{},expectedStdout:text}]});
    const first:any=await brain.callTool('skill_create',candidate('first\n'));assert(first.source.commit);assert.match(first.source.path,/^generated\/skills\//);assert.equal(readFileSync(join(first.source.workspacePath,'scripts/report.mjs'),'utf8'),candidate('first\n').files['scripts/report.mjs']);
    await brain.callTool('skill_validate',{name:first.name,version:first.version});await brain.callTool('skill_publish',{name:first.name,version:first.version});const published=brain.skillGet(first.name).versions[0]!;assert.equal(published.source?.commit,first.source.commit);const pinned=readFileSync(join(published.path,'scripts/report.mjs'),'utf8');
    const second:any=await brain.callTool('skill_create',candidate('second\n'));assert.notEqual(second.source.commit,first.source.commit);assert.equal(brain.skillGet(first.name).activeVersion,first.version);assert.equal(readFileSync(join(published.path,'scripts/report.mjs'),'utf8'),pinned);
    const head=git(managed.repository.workspacePath,'rev-parse','HEAD'),provenance=brain.skillGet(first.name).versions.find(version=>version.version===first.version)!.source;
    await assert.rejects(brain.callTool('skill_validate',{name:first.name,version:first.version}),/Published skill versions are immutable/);
    assert.equal(git(managed.repository.workspacePath,'rev-parse','HEAD'),head,'Rejected validation must not commit old content over the newer source revision');
    assert.equal(readFileSync(join(second.source.workspacePath,'scripts/report.mjs'),'utf8'),candidate('second\n').files['scripts/report.mjs']);
    assert.deepEqual(brain.skillGet(first.name).versions.find(version=>version.version===first.version)!.source,provenance,'Published source provenance must remain pinned');
    const [validated,activated]:any[]=await Promise.all([brain.callTool('skill_validate',{name:second.name,version:second.version}),brain.callTool('skill_publish',{name:second.name,version:second.version})]);
    assert.equal(validated.state,'validated');assert.equal(activated.activeVersion,second.version,'Concurrent operations on one skill must publish after its validation');
    const old=await managed.repository.export('skill',first.source.path.split('/').at(-1)!,first.source.commit);assert.equal(old.files['scripts/report.mjs'],pinned);assert(old.files['skill-checks.json']);
    vault.create({name:'Source guard',values:{token:'fixture-source-private-token'}});await assert.rejects(brain.callTool('skill_create',candidate('fixture-source-private-token')),/Credential values/);assert.equal(git(repositoryPath,'diff','--cached'),owner);
  }finally{projects.close();store.close();rmSync(root,{recursive:true,force:true});}
});
