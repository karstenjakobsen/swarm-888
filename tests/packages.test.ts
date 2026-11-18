import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import { PackageService } from '../src/packages/service.ts';
import { packageManifestSchema, packagePath, remoteUrlSchema } from '../src/packages/schemas.ts';

function git(directory:string,...args:string[]):string{return execFileSync('git',['-c','user.name=Fixture','-c','user.email=fixture@example.test','-C',directory,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['ignore','pipe','pipe']});}
function manifest(kind:'project'|'skill'|'connector'='project',name='fixture'){return {schemaVersion:1 as const,id:randomUUID(),kind,name,version:'0.1.0',description:'Fixture package',...(kind==='connector'?{mcp:{transport:'stdio' as const,command:'node',args:['server.mjs']}}:{})};}
function fixture(){const root=mkdtempSync(join(tmpdir(),'operator-packages-')),stateDir=join(root,'state'),projectsDir=join(root,'projects');mkdirSync(stateDir);mkdirSync(projectsDir);const store=new Store(stateDir),config={stateDir,projectsDir,controllerUid:process.getuid!(),adminPassword:'private-admin-fixture-password',ipcToken:'a'.repeat(64)} as Config;const service=new PackageService(config,store.db);return {root,stateDir,projectsDir,store,service,config,close(){store.close();rmSync(root,{recursive:true,force:true});}};}

test('package v1 schema requires canonical IDs, release versions and kind-specific portable fields',()=>{
  const value=manifest();assert(packageManifestSchema.safeParse(value).success);
  for(const input of [{...value,version:undefined},{...value,version:'latest'},{...value,schemaVersion:2},{...value,id:'fixture'},{...value,kind:'connector'},{...value,mcp:{transport:'http',url:'https://example.test/mcp'}},{...manifest('skill'),name:'Friendly Skill'},{...manifest('skill'),run:{command:'node'}}])assert.equal(packageManifestSchema.safeParse(input).success,false);
  for(const value of ['../escape','/tmp/package','a/../package','.git/module','a\\b'])assert.throws(()=>packagePath(value));assert.equal(packagePath('.'),'.');
  for(const value of ['https://token@example.test/repo','https://example.test/repo?token=secret','-upload-pack=evil','ssh://git:token@example.test/repo'])assert.equal(remoteUrlSchema.safeParse(value).success,false);
  assert(remoteUrlSchema.safeParse('git@example.test:owner/repo.git').success);
  assert.equal(packageManifestSchema.safeParse({...value,run:{command:'node',args:Array.from({length:5},()=> 'x'.repeat(16_000))}}).success,false);
});

test('local repositories require remote URLs, support several package kinds, and never push',async()=>{
  const f=fixture();try{
    await assert.rejects(f.service.register({name:'Missing remote',mode:'create'}));
    const repository=await f.service.register({name:'Monorepo',remoteUrl:'https://example.invalid/packages.git',mode:'create'});assert.equal(repository.directory,join(f.projectsDir,'repositories',repository.id));assert.equal(git(repository.directory,'remote','get-url','origin').trim(),repository.remoteUrl);assert.equal(repository.localOnly,true);assert.equal(repository.hasRemoteBranch,false);assert.equal(repository.dirty,false);assert.match(repository.head!,/^[0-9a-f]{40}$/);
    const project=await f.service.createPackage(repository.id,{path:'apps/website',manifest:manifest(),files:{'index.html':'<h1>Hello</h1>\n'}}),connector=await f.service.createPackage(repository.id,{path:'connectors/provider',manifest:manifest('connector')}),skill=await f.service.createPackage(repository.id,{path:'skills/analysis',manifest:manifest('skill','analysis')});
    assert.equal(f.service.listPackages(repository.id).length,3);assert.equal((await f.service.discover(repository.id)).packages.length,3);assert.equal(f.service.source(project.id).commit,project.lastImportedCommit);assert.notEqual(project.lastImportedCommit,connector.lastImportedCommit);assert.match(readFileSync(join(repository.directory,'skills/analysis/SKILL.md'),'utf8'),/name: analysis/);
    assert.equal(f.service.imports(skill.id)[0].status,'imported');assert.equal(git(repository.directory,'for-each-ref','refs/remotes/').trim(),'');
  }finally{f.close();}
});

test('cloned discovery is metadata only and imports are idempotent with exact version history',async()=>{
  const f=fixture();try{
    const origin=join(f.root,'origin');mkdirSync(origin);git(origin,'init','-q','-b','master');const packageManifest=manifest();mkdirSync(join(origin,'app'));writeFileSync(join(origin,'app/operator-package.json'),JSON.stringify({...packageManifest,build:{command:'touch',args:[join(f.root,'must-not-execute')]}}));writeFileSync(join(origin,'app/logo.png'),Buffer.from([0,255,1,254]));git(origin,'add','.');git(origin,'commit','-qm','Initial packages');
    let controllerResponded=false;
    setImmediate(()=>{controllerResponded=true;});
    const repository=await f.service.register({name:'Imported',remoteUrl:origin,mode:'clone'});
    assert.equal(controllerResponded,true,'Other controller events must run while Git clones the remote');
    const preview=await f.service.discover(repository.id);assert.equal(repository.sourceBranch,'master');assert.equal(repository.hasRemoteBranch,true);assert.equal(repository.localOnly,false);assert.equal(preview.packages[0].manifest!.id,packageManifest.id);assert.equal(f.service.listPackages().length,0);
    const first=await f.service.importPackages(repository.id,{paths:['app'],expectedCommit:preview.commit});assert.equal(first.packages.length,1);assert.equal(first.imports[0].status,'imported');assert.equal(first.imports[0].packageVersion,'0.1.0');assert.equal(existsSync(join(f.root,'must-not-execute')),false);assert.equal(f.service.readTextFiles(packageManifest.id)['logo.png'],undefined);
    const count=f.service.imports(packageManifest.id).length,second=await f.service.importPackages(repository.id,{paths:['app']});assert.equal(second.packages[0].lastImportedCommit,first.packages[0].lastImportedCommit);assert.equal(f.service.imports(packageManifest.id).length,count);
    writeFileSync(join(origin,'app/operator-package.json'),JSON.stringify({...packageManifest,version:'0.2.0'}));git(origin,'add','.');git(origin,'commit','-qm','New version');const updated=await f.service.discover(repository.id,{refresh:true});assert.equal(f.service.package(packageManifest.id).version,'0.1.0');
    const imported=await f.service.importPackages(repository.id,{paths:['app'],expectedCommit:updated.commit});assert.equal(imported.packages[0].version,'0.2.0');assert.equal(git(repository.directory,'rev-parse','HEAD').trim(),updated.commit);assert.equal(f.service.imports(packageManifest.id).length,2);
  }finally{f.close();}
});

test('repositories without main clone a selected branch and preview another remote branch before importing it',async()=>{
  const f=fixture();try{
    const origin=join(f.root,'origin');mkdirSync(origin);git(origin,'init','-q','-b','release/stable');const packageManifest=manifest();mkdirSync(join(origin,'app'));writeFileSync(join(origin,'app/operator-package.json'),JSON.stringify(packageManifest));git(origin,'add','.');git(origin,'commit','-qm','Stable package');const stable=git(origin,'rev-parse','HEAD').trim();
    git(origin,'tag','preview/packages');git(origin,'checkout','-qb','preview/packages');writeFileSync(join(origin,'app/operator-package.json'),JSON.stringify({...packageManifest,version:'0.2.0'}));git(origin,'add','.');git(origin,'commit','-qm','Preview package');const previewCommit=git(origin,'rev-parse','HEAD').trim();
    assert.equal(git(origin,'branch','--list','main').trim(),'');
    const repository=await f.service.register({name:'Release packages',remoteUrl:origin,mode:'clone',branch:'release/stable'});assert.equal(repository.sourceBranch,'release/stable');assert.equal(repository.head,stable);
    const initial=await f.service.discover(repository.id,{refresh:true});assert.equal(initial.commit,stable);assert.equal(initial.remoteBranch,'release/stable');
    const preview=await f.service.discover(repository.id,{refresh:true,branch:'preview/packages'});assert.equal(preview.commit,previewCommit);assert.equal(preview.remoteBranch,'preview/packages');assert.equal(preview.packages[0].manifest!.version,'0.2.0');
    assert.equal(git(repository.directory,'rev-parse','HEAD').trim(),stable);assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD').trim(),repository.branch);assert.equal(f.service.repository(repository.id).sourceBranch,'release/stable');assert.equal(git(repository.directory,'status','--porcelain').trim(),'');
    const imported=await f.service.importPackages(repository.id,{paths:['app'],expectedCommit:preview.commit});assert.equal(imported.packages[0].version,'0.2.0');assert.equal(imported.packages[0].lastImportedCommit,previewCommit);assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD').trim(),repository.branch);assert.equal(f.service.repository(repository.id).sourceBranch,'release/stable');
  }finally{f.close();}
});

test('missing, invalid and tag-only preview branches preserve local source and the registered branch',async()=>{
  const f=fixture();try{
    const origin=join(f.root,'origin');mkdirSync(origin);git(origin,'init','-q','-b','release/stable');writeFileSync(join(origin,'README.md'),'Stable repository\n');git(origin,'add','.');git(origin,'commit','-qm','Stable source');git(origin,'tag','tag-only');
    const repository=await f.service.register({name:'Safe branch previews',remoteUrl:origin,mode:'clone'}),head=git(repository.directory,'rev-parse','HEAD').trim();writeFileSync(join(repository.directory,'owner-note.txt'),'Keep unfinished owner work\n');
    for(const branch of ['missing','tag-only','release/../escape','release//empty','release/.hidden','release/topic.lock/next','-upload-pack=evil'])await assert.rejects(f.service.discover(repository.id,{refresh:true,branch}));
    await assert.rejects(f.service.discover(repository.id,{branch:'release/stable'}),/when fetching/);
    assert.equal(readFileSync(join(repository.directory,'owner-note.txt'),'utf8'),'Keep unfinished owner work\n');assert.equal(git(repository.directory,'rev-parse','HEAD').trim(),head);assert.equal(git(repository.directory,'symbolic-ref','--short','HEAD').trim(),repository.branch);assert.equal(f.service.repository(repository.id).sourceBranch,'release/stable');assert.equal(git(repository.directory,'diff','--cached').trim(),'');
  }finally{f.close();}
});

test('failed imports keep the last successful revision and capture invalid manifest versions',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Failure recovery',remoteUrl:'https://example.invalid/recovery.git'}),created=await f.service.createPackage(repository.id,{path:'app',manifest:manifest()});
    writeFileSync(join(repository.directory,'app/operator-package.json'),JSON.stringify({...created.manifest,version:'broken-version'}));git(repository.directory,'add','.');git(repository.directory,'commit','-qm','Bad manifest');const failed=await f.service.importPackages(repository.id,{paths:['app']});
    assert.equal(failed.packages.length,0);assert.equal(failed.imports[0].status,'failed');assert.equal(failed.imports[0].packageVersion,'broken-version');assert.equal(f.service.package(created.id).lastImportedCommit,created.lastImportedCommit);assert.equal(f.service.source(created.id).commit,created.lastImportedCommit);assert.equal(f.service.manifest(created.id).version,'0.1.0');assert.equal(f.service.imports(created.id).length,2);
  }finally{f.close();}
});

test('a partially invalid import batch leaves every successful package revision intact',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Atomic import',remoteUrl:'https://example.invalid/atomic.git'}),created=await f.service.createPackage(repository.id,{path:'existing',manifest:manifest()});
    mkdirSync(join(repository.directory,'new'));writeFileSync(join(repository.directory,'new/operator-package.json'),JSON.stringify(manifest()));writeFileSync(join(repository.directory,'existing/operator-package.json'),JSON.stringify({...created.manifest,version:'0.2.0'}));mkdirSync(join(repository.directory,'invalid'));writeFileSync(join(repository.directory,'invalid/operator-package.json'),'{broken');git(repository.directory,'add','.');git(repository.directory,'commit','-qm','Mixed batch');
    const result=await f.service.importPackages(repository.id,{paths:['existing','new','invalid']});assert.equal(result.packages.length,0);assert.equal(result.imports.length,3);assert(result.imports.every(attempt=>attempt.status==='failed'));assert.equal(f.service.listPackages().length,1);assert.equal(f.service.package(created.id).version,'0.1.0');assert.equal(f.service.package(created.id).lastImportedCommit,created.lastImportedCommit);
  }finally{f.close();}
});

test('canonical identifier conflicts fail explicitly while same-repository moves retain identity',async()=>{
  const f=fixture();try{
    const first=await f.service.register({name:'One',remoteUrl:'https://example.invalid/one.git'}),created=await f.service.createPackage(first.id,{path:'old',manifest:manifest()});
    const second=await f.service.register({name:'Two',remoteUrl:'https://example.invalid/two.git'});mkdirSync(join(second.directory,'copy'));writeFileSync(join(second.directory,'copy/operator-package.json'),JSON.stringify(created.manifest));git(second.directory,'add','.');git(second.directory,'commit','-qm','Copied identity');const conflict=await f.service.importPackages(second.id,{paths:['copy']});assert.equal(conflict.imports[0].status,'failed');assert.match(conflict.imports[0].error!,/another repository/);
    git(first.directory,'mv','old','renamed');git(first.directory,'commit','-qm','Move package');const moved=await f.service.importPackages(first.id,{paths:['renamed']});assert.equal(moved.imports[0].status,'imported');assert.equal(f.service.package(created.id).path,'renamed');assert.equal(f.service.package(created.id).id,created.id);
  }finally{f.close();}
});

test('source edits preserve binary assets and reject stale writes, credentials and symlinks',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Editor',remoteUrl:'https://example.invalid/editor.git'}),created=await f.service.createPackage(repository.id,{path:'.',manifest:manifest(),files:{'README.md':'Initial source\n'}}),directory=repository.directory;
    writeFileSync(join(directory,'asset.png'),Buffer.from([0,255,254,253]));await f.service.commit(created.id,'Add binary asset');const journalCount=f.service.imports(created.id).length;await f.service.commit(created.id,'Retry completed source commit');assert.equal(f.service.imports(created.id).length,journalCount);const first=f.service.source(created.id).commit!;await f.service.writeTextFiles(created.id,{'README.md':'Updated source\n'},[],{expectedCommit:first});assert.deepEqual(readFileSync(join(directory,'asset.png')),Buffer.from([0,255,254,253]));
    await assert.rejects(f.service.writeTextFiles(created.id,{'README.md':'Stale\n'},[],{expectedCommit:first}),/changed/);assert.equal(readFileSync(join(directory,'README.md'),'utf8'),'Updated source\n');
    await assert.rejects(f.service.writeTextFiles(created.id,{'token.txt':f.config.adminPassword}),/credentials/);await assert.rejects(f.service.writeTextFiles(created.id,{'.env':'secret'}));
    symlinkSync('/etc/passwd',join(directory,'bad-link'));await assert.rejects(f.service.commit(created.id,'Reject symlink'),/regular files/);assert.equal(git(directory,'diff','--cached').trim(),'');
  }finally{f.close();}
});

test('repository write guards cover source mutations and retain task context',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Guard',remoteUrl:'https://example.invalid/guard.git'}),created=await f.service.createPackage(repository.id,{path:'app',manifest:manifest()});const calls:string[]=[];
    f.service.setWriteGuard((id,runId)=>{assert.equal(id,repository.id);calls.push(runId??'none');if(runId!=='allowed')throw new Error('Repository has an active task');});
    await assert.rejects(f.service.writeTextFiles(created.id,{'README.md':'blocked'}),/active task/);await f.service.withRun('allowed',()=>f.service.writeTextFiles(created.id,{'README.md':'allowed'}));assert.deepEqual(calls,['none','allowed']);
  }finally{f.close();}
});

test('task context records source provenance and rejects changes outside the package before writes',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Task boundaries',remoteUrl:'https://example.invalid/tasks.git'}),created=await f.service.createPackage(repository.id,{path:'app',manifest:manifest(),files:{'README.md':'Before\n'}});
    await f.service.withRun('task_one',()=>f.service.writeTextFiles(created.id,{'README.md':'After\n'}));assert.match(git(repository.directory,'log','-1','--format=%B'),/Operator-Run: task_one/);
    writeFileSync(join(repository.directory,'owner-note.txt'),'Unrelated owner work\n');await assert.rejects(f.service.withRun('task_two',()=>f.service.writeTextFiles(created.id,{'README.md':'Must not appear\n'})),/outside its assigned package/);assert.equal(readFileSync(join(repository.directory,'app/README.md'),'utf8'),'After\n');assert.equal(git(repository.directory,'diff','--cached').trim(),'');
    await f.service.writeTextFiles(created.id,{'README.md':'Direct UI edit\n'});assert.equal(readFileSync(join(repository.directory,'owner-note.txt'),'utf8'),'Unrelated owner work\n');
  }finally{f.close();}
});

test('package creation preserves existing source and explicit adoption only adds the manifest',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Adoption',remoteUrl:'https://example.invalid/adopt.git'});mkdirSync(join(repository.directory,'existing'));writeFileSync(join(repository.directory,'existing/server.mjs'),'Original source\n');git(repository.directory,'add','.');git(repository.directory,'commit','-qm','Existing application');
    await assert.rejects(f.service.createPackage(repository.id,{path:'existing',manifest:manifest(),files:{'server.mjs':'Replacement source\n'}}),/would overwrite/);assert.equal(readFileSync(join(repository.directory,'existing/server.mjs'),'utf8'),'Original source\n');assert.equal(existsSync(join(repository.directory,'existing/operator-package.json')),false);
    const adopted=await f.service.adoptPackage(repository.id,{path:'existing',manifest:manifest()});assert.equal(f.service.readTextFiles(adopted.id)['server.mjs'],'Original source\n');
    await assert.rejects(f.service.createPackage(repository.id,{path:'.',manifest:manifest()}),/overlap/);
    assert.equal(existsSync(join(repository.directory,'operator-package.json')),false);
  }finally{f.close();}
});

test('one task can finalize multiple journaled packages without committing another package implicitly',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Multiple package writes',remoteUrl:'https://example.invalid/multiwrite.git'}),one=await f.service.createPackage(repository.id,{path:'one',manifest:manifest()}),two=await f.service.createPackage(repository.id,{path:'two',manifest:manifest()});
    f.service.setWriteScope((repositoryId,runId)=>{assert.equal(repositoryId,repository.id);return runId==='one_task'?['one','two']:[];});
    writeFileSync(join(repository.directory,'one/source.txt'),'One\n');writeFileSync(join(repository.directory,'two/source.txt'),'Two\n');await f.service.withRun('one_task',()=>f.service.commit(one.id));assert.equal(f.service.source(one.id).dirty,false);assert.equal(f.service.source(two.id).dirty,true);assert.equal(f.service.fileNames(one.id).includes('source.txt'),true);assert.equal(f.service.fileNames(two.id).includes('source.txt'),false);
    await f.service.withRun('one_task',()=>f.service.commit(two.id));assert.equal(f.service.source(two.id).dirty,false);writeFileSync(join(repository.directory,'outside.txt'),'Unassigned source\n');await assert.rejects(f.service.withRun('one_task',()=>f.service.commit(one.id)),/outside its assigned package/);
  }finally{f.close();}
});

test('incomplete import attempts become failed on controller recovery without losing packages',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Recovery',remoteUrl:'https://example.invalid/recovery.git'}),created=await f.service.createPackage(repository.id,{path:'app',manifest:manifest()});const attempt=f.service.store.beginImport(repository.id,'app',created.lastImportedCommit,created.manifest);f.service.store.importing(attempt.id);
    const recovered=new PackageService(f.config,f.store.db);assert.equal(recovered.imports(created.id)[0].status,'failed');assert.equal(recovered.package(created.id).lastImportedCommit,created.lastImportedCommit);
  }finally{f.close();}
});

test('oversized package manifests are rejected before source files or Git history change',async()=>{
  const f=fixture();try{
    const repository=await f.service.register({name:'Manifest limits',remoteUrl:'https://example.invalid/manifest-limits.git'}),oversized={...manifest(),run:{command:'node',args:Array.from({length:5},()=> 'x'.repeat(16_000))}},before=git(repository.directory,'rev-parse','HEAD');
    await assert.rejects(f.service.createPackage(repository.id,{path:'oversized',manifest:oversized}),/64 KB/);assert.equal(existsSync(join(repository.directory,'oversized')),false);assert.equal(git(repository.directory,'rev-parse','HEAD'),before);
    const created=await f.service.createPackage(repository.id,{path:'valid',manifest:manifest()}),original=readFileSync(join(repository.directory,'valid/operator-package.json'),'utf8'),head=git(repository.directory,'rev-parse','HEAD');
    await assert.rejects(f.service.writeTextFiles(created.id,{'operator-package.json':`${' '.repeat(64_000)}${JSON.stringify(created.manifest)}`}),/64 KB/);assert.equal(readFileSync(join(repository.directory,'valid/operator-package.json'),'utf8'),original);assert.equal(git(repository.directory,'rev-parse','HEAD'),head);assert.equal(git(repository.directory,'status','--porcelain').trim(),'');
  }finally{f.close();}
});

test('rejected source edits preserve existing files and a clean index',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Source preflight',remoteUrl:'https://example.test/preflight.git'});
    const skill=await f.service.createPackage(repo.id,{path:'skills/review',manifest:manifest('skill','review')});
    const directory=f.service.source(skill.id).workspacePath,original=readFileSync(join(directory,'SKILL.md'),'utf8');
    await assert.rejects(f.service.writeTextFiles(skill.id,{'SKILL.md':'Missing metadata'}),/frontmatter/);
    assert.equal(readFileSync(join(directory,'SKILL.md'),'utf8'),original);
    writeFileSync(join(repo.directory,'.gitignore'),'ignored.txt\n');
    git(repo.directory,'add','.gitignore');git(repo.directory,'commit','-qm','Ignore generated files');
    await assert.rejects(f.service.writeTextFiles(skill.id,{'ignored.txt':'untracked'}),/ignored by Git/);
    assert.equal(existsSync(join(directory,'ignored.txt')),false);
    const binary=Buffer.from([255,0,254]);
    writeFileSync(join(directory,'asset.bin'),binary);
    await f.service.commit(skill.id,'Add binary file');
    assert.equal(f.service.readTextFiles(skill.id)['asset.bin'],undefined);
    await assert.rejects(f.service.writeTextFiles(skill.id,{'new.md':'draft','asset.bin':'replacement'},[],{createOnly:['new.md','asset.bin']}),/already exists/);
    assert.deepEqual(readFileSync(join(directory,'asset.bin')),binary);
    assert.equal(existsSync(join(directory,'new.md')),false);
    symlinkSync('missing-target',join(directory,'broken-link'));
    await assert.rejects(f.service.writeTextFiles(skill.id,{'broken-link':'rejected'}),/regular unlinked files/);
    assert.equal(existsSync(join(directory,'missing-target')),false);
    assert.equal(git(repo.directory,'diff','--cached').trim(),'');
  }finally{f.close();}
});

test('a failed import batch never returns package records rolled back by SQLite',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Batch failure',remoteUrl:'https://example.test/batch.git'});
    for(const name of ['first','second']){
      mkdirSync(join(repo.directory,name));
      writeFileSync(join(repo.directory,name,'operator-package.json'),JSON.stringify(manifest('project',name)));
    }
    git(repo.directory,'add','.');git(repo.directory,'commit','-qm','Two packages');
    f.store.db.exec("CREATE TRIGGER reject_one_package BEFORE INSERT ON packages WHEN NEW.path='second' BEGIN SELECT RAISE(ABORT,'Simulated SQLite failure'); END");
    const result=await f.service.importPackages(repo.id,{paths:['first','second']});
    assert.deepEqual(result.packages,[]);
    assert.equal(result.imports.length,2);
    assert(result.imports.every(item=>item.status==='failed'));
    assert.equal(f.service.listPackages().length,0);
  }finally{f.close();}
});

test('a sibling commit leaves an unchanged package pin intact and a changed local HEAD requires import',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Package pins',remoteUrl:'https://example.test/pins.git'});
    const pkg=await f.service.createPackage(repo.id,{path:'apps/a',manifest:manifest(),files:{'file.txt':'original'}});
    await f.service.createPackage(repo.id,{path:'apps/b',manifest:manifest()});
    assert.equal((await f.service.commit(pkg.id,'Finalize unchanged task','task')).commit,pkg.lastImportedCommit);
    assert.equal(f.service.imports(pkg.id).length,1);
    writeFileSync(join(repo.directory,'apps/a/file.txt'),'separate local commit');
    git(repo.directory,'add','apps/a');git(repo.directory,'commit','-qm','User revision');
    assert.equal(f.service.source(pkg.id).workspaceDiverged,true);
    assert.equal(f.service.source(pkg.id).dirty,false);
    await assert.rejects(f.service.writeTextFiles(pkg.id,{'file.txt':'stale editor save'},[],{expectedCommit:pkg.lastImportedCommit}),/Discover and import/);
    assert.equal(f.service.readTextFiles(pkg.id)['file.txt'],'original');
    assert.equal(readFileSync(join(repo.directory,'apps/a/file.txt'),'utf8'),'separate local commit');
  }finally{f.close();}
});

test('a local task commit can finish its interrupted catalog update without a duplicate Git commit',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Resume package commit',remoteUrl:'https://example.test/tasks.git'});
    const pkg=await f.service.createPackage(repo.id,{path:'app',manifest:manifest()});
    writeFileSync(join(repo.directory,'app/new.txt'),'task edit');
    f.store.db.exec("CREATE TRIGGER reject_package_update BEFORE UPDATE ON packages BEGIN SELECT RAISE(ABORT,'Simulated interrupted catalog update'); END");
    await assert.rejects(f.service.commit(pkg.id,'Save task output','task_a'),/interrupted catalog update/);
    const head=git(repo.directory,'rev-parse','HEAD').trim();
    assert.notEqual(head,pkg.lastImportedCommit);
    f.store.db.exec('DROP TRIGGER reject_package_update');
    assert.equal((await f.service.commit(pkg.id,'Resume task','task_a')).commit,head);
    assert.equal(git(repo.directory,'rev-parse','HEAD').trim(),head);
  }finally{f.close();}
});

test('large source files are checked for known credentials before staging',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Large assets',remoteUrl:'https://example.test/assets.git'});
    const pkg=await f.service.createPackage(repo.id,{path:'app',manifest:manifest()});
    const body=Buffer.alloc(33*1024*1024,65);
    body.write(f.config.adminPassword,32*1024*1024-3);
    writeFileSync(join(repo.directory,'app/large.dat'),body);
    await assert.rejects(f.service.commit(pkg.id),/credentials/);
    assert.equal(git(repo.directory,'rev-parse','HEAD').trim(),pkg.lastImportedCommit);
    assert.equal(git(repo.directory,'diff','--cached').trim(),'');
  }finally{f.close();}
});

test('discovery and failed import history suppress credentials in valid and invalid manifests',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Manifest screening',remoteUrl:'https://example.test/screening.git'});
    const vaultValue='private-vault-fixture';
    f.service.setSecretGuard(value=>{
      if(JSON.stringify(value).includes(vaultValue))throw new Error('Sensitive value '+vaultValue);
    });
    const definitions={
      valid:{...manifest(),description:f.config.adminPassword},
      invalid:{...manifest(),version:vaultValue},
      unknown:{...manifest(),[f.config.ipcToken]:true},
    };
    for(const [folder,definition] of Object.entries(definitions)){
      mkdirSync(join(repo.directory,folder));
      writeFileSync(join(repo.directory,folder,'operator-package.json'),JSON.stringify(definition));
    }
    git(repo.directory,'add','.');git(repo.directory,'commit','-qm','Import test fixtures');
    const preview=await f.service.discover(repo.id);
    assert(preview.packages.every(item=>!item.manifest&&item.error));
    const result=await f.service.importPackages(repo.id,{paths:Object.keys(definitions),expectedCommit:preview.commit});
    assert.equal(result.packages.length,0);
    assert.equal(result.imports.length,3);
    assert(result.imports.every(attempt=>attempt.status==='failed'&&attempt.packageVersion===null));
    const saved=f.store.db.prepare('SELECT * FROM package_imports').all();
    for(const secret of [vaultValue,f.config.adminPassword,f.config.ipcToken])assert(!JSON.stringify([result,preview,saved]).includes(secret));
  }finally{f.close();}
});

test('bounded editor reads reject known credentials in imported text without echoing them',async()=>{
  const f=fixture();
  try{
    const repo=await f.service.register({name:'Imported text',remoteUrl:'https://example.test/source.git'});
    mkdirSync(join(repo.directory,'app'));
    const app=manifest();
    writeFileSync(join(repo.directory,'app/operator-package.json'),JSON.stringify(app));
    writeFileSync(join(repo.directory,'app/example.txt'),f.config.adminPassword);
    git(repo.directory,'add','.');git(repo.directory,'commit','-qm','Committed source fixture');
    const result=await f.service.importPackages(repo.id,{paths:['app']});
    assert.equal(result.imports[0].status,'imported');
    assert.throws(()=>f.service.readTextFiles(app.id),(error:Error)=>/credentials/.test(error.message)&&!error.message.includes(f.config.adminPassword));
    assert.equal(f.service.manifest(app.id).id,app.id);
  }finally{f.close();}
});
