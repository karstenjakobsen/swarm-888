import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmodSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Config } from '../src/config.ts';
import { ManagedRepository } from '../src/managed/repository.ts';
import { managedFilesSchema, managedManifestSchema, managedPath, sourceWriteInput } from '../src/managed/schemas.ts';

function git(directory:string,...args:string[]):string {
  return execFileSync('git',['-C',directory,...args],{encoding:'utf8',env:{...process.env,GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null'},stdio:['ignore','pipe','pipe']});
}
function checkEnvironment():NodeJS.ProcessEnv {const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('NODE_TEST'))delete env[key];return env;}
function fixture(){
  const root=mkdtempSync(join(tmpdir(),'operator-managed-git-')),repositoryPath=join(root,'owner'),stateDir=join(root,'state');mkdirSync(repositoryPath);mkdirSync(stateDir);
  git(repositoryPath,'init','-q','-b','main');git(repositoryPath,'config','user.name','Fixture owner');git(repositoryPath,'config','user.email','fixture@example.test');
  writeFileSync(join(repositoryPath,'README.md'),'Owner source\n');writeFileSync(join(repositoryPath,'core.ts'),'export const owner = true;\n');writeFileSync(join(repositoryPath,'.gitignore'),'node_modules/\ndist/\n.env\n');
  git(repositoryPath,'add','README.md','core.ts','.gitignore');git(repositoryPath,'commit','-qm','Owner baseline');
  const config={repositoryPath,stateDir,controllerUid:process.getuid!()} as Config;
  return {root,repositoryPath,stateDir,config,repository:new ManagedRepository(config),close(){rmSync(root,{recursive:true,force:true});}};
}

test('managed source auto-commits in the same repository while preserving owner HEAD, files, index and hooks',async()=>{
  const f=fixture();
  try{
    writeFileSync(join(f.repositoryPath,'README.md'),'Owner staged work\n');git(f.repositoryPath,'add','README.md');writeFileSync(join(f.repositoryPath,'core.ts'),'Owner unstaged work\n');writeFileSync(join(f.repositoryPath,'notes.txt'),'Owner untracked notes\n');
    const before={head:git(f.repositoryPath,'rev-parse','HEAD'),status:git(f.repositoryPath,'status','--porcelain=v1'),index:readFileSync(join(f.repositoryPath,'.git','index')),diff:git(f.repositoryPath,'diff','--cached')};
    const marker=join(f.root,'hook-ran'),hook=`#!/bin/sh\ntouch '${marker}'\n`;
    for(const name of ['post-checkout','pre-commit','prepare-commit-msg','commit-msg','post-commit']){const path=join(f.repositoryPath,'.git','hooks',name);writeFileSync(path,hook);chmodSync(path,0o755);}
    const id=randomUUID(),created=await f.repository.create({id,kind:'project',name:'Service fixture',description:'A local fixture',template:'service'});
    assert.equal(created.source.repositoryPath,f.repositoryPath);assert.equal(created.source.branch,'operator/generated');assert.equal(created.source.path,managedPath('project',id));assert.match(created.source.commit!,/^[a-f0-9]{40}$/);assert.equal(created.source.dirty,false);
    assert.equal(git(f.repositoryPath,'rev-parse','HEAD'),before.head);assert.equal(git(f.repositoryPath,'status','--porcelain=v1'),before.status);assert.deepEqual(readFileSync(join(f.repositoryPath,'.git','index')),before.index);assert.equal(git(f.repositoryPath,'diff','--cached'),before.diff);assert.equal(existsSync(marker),false);
    assert.equal(readFileSync(join(f.repositoryPath,'core.ts'),'utf8'),'Owner unstaged work\n');
    const check=created.manifest.check!;const result=execFileSync(process.execPath,check.args,{cwd:created.source.workspacePath,encoding:'utf8',env:checkEnvironment()});assert.match(result,/pass 1/);
  }finally{f.close();}
});

test('committed exports are immutable and source edits, deletions and runtime skill links remain scoped',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),created=await f.repository.create({id,kind:'project',name:'Versioned fixture',description:''});
    const updated=await f.repository.write('project',id,{'src/hello [fixture].mjs':'export const value = 1;\n','obsolete.txt':'remove me\n'},[],{message:'Add exact source paths',runId:'run_fixture'});
    assert.notEqual(updated.source.commit,created.source.commit);assert.equal(updated.files['src/hello [fixture].mjs'],'export const value = 1;\n');
    const directory=updated.source.workspacePath;mkdirSync(join(directory,'.agents'));mkdirSync(join(directory,'.agents','skills'));symlinkSync(f.stateDir,join(directory,'.agents','skills','fixture'));
    assert.equal((await f.repository.source('project',id)).dirty,false);
    writeFileSync(join(directory,'src','hello [fixture].mjs'),'export const value = 2;\n');
    assert.equal((await f.repository.source('project',id)).dirty,true);assert.equal((await f.repository.export('project',id)).source.dirty,true);
    const old=await f.repository.export('project',id,updated.source.commit!);assert.equal(old.files['src/hello [fixture].mjs'],'export const value = 1;\n');assert.equal(old.source.dirty,false);assert.equal(Object.keys(old.files).some(path=>path.includes('.agents')),false);
    await f.repository.commit('project',id,'Commit worker edits','run_worker');
    const removed=await f.repository.write('project',id,{},['obsolete.txt']);assert.equal(removed.files['obsolete.txt'],undefined);assert.equal(removed.files['src/hello [fixture].mjs'],'export const value = 2;\n');assert.equal(removed.source.dirty,false);
    assert.match(git(f.repository.workspacePath,'log','--format=%B'),/Operator-Run: run_worker/);
  }finally{f.close();}
});

test('source writes reject escapes, credentials, oversized text, manifest changes and linked files',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),created=await f.repository.create({id,kind:'connector',name:'Safe fixture',description:''});const sha=created.source.commit;
    for(const path of ['../core.ts','/etc/secret','nested/../../core.ts','.git/config','.env','secrets/token.txt','node_modules/module.js','dist/output.js','private.key','.agents/secret.txt'])await assert.rejects(f.repository.write('connector',id,{[path]:'not source'}));
    await assert.rejects(f.repository.write('connector',id,{'nul.txt':'a\0b'}),/UTF-8/);
    await assert.rejects(f.repository.write('connector',id,{'big.txt':'x'.repeat(8_000_001)}),/8 MB/);
    await assert.rejects(f.repository.write('connector',id,{'operator-package.json':JSON.stringify({...created.manifest,id:randomUUID()})}),/identity/);
    symlinkSync(join(f.repositoryPath,'core.ts'),join(created.source.workspacePath,'linked.txt'));await assert.rejects(f.repository.commit('connector',id,'No symlinks'),/real directories/);rmSync(join(created.source.workspacePath,'linked.txt'));
    linkSync(join(f.repositoryPath,'core.ts'),join(created.source.workspacePath,'hardlink.txt'));await assert.rejects(f.repository.commit('connector',id,'No hard links'),/hard links/);rmSync(join(created.source.workspacePath,'hardlink.txt'));
    f.config.adminPassword='fixture-known-private-credential';
    await assert.rejects(f.repository.write('connector',id,{'leaked.mjs':`export const credential = ${JSON.stringify(f.config.adminPassword)};`}),/Known credentials/);
    assert.equal(git(f.repository.workspacePath,'diff','--cached'),'');assert.equal(existsSync(join(created.source.workspacePath,'leaked.mjs')),false);
    assert.equal((await f.repository.source('connector',id)).commit,sha);assert.equal((await f.repository.source('connector',id)).dirty,false);
    assert.equal(readFileSync(join(f.repositoryPath,'core.ts'),'utf8'),'export const owner = true;\n');
  }finally{f.close();}
});

test('invalid writes are rejected before changing source, Git index, or history',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),created=await f.repository.create({id,kind:'project',name:'Atomic validation',description:''});
    const before=readFileSync(join(created.source.workspacePath,'README.md'),'utf8'),head=git(f.repository.workspacePath,'rev-parse','HEAD'),staged=git(f.repository.workspacePath,'diff','--cached');
    mkdirSync(join(created.source.workspacePath,'empty-directory'));
    const invalid:Array<()=>Promise<unknown>>=[
      ()=>f.repository.write('project',id,{'README.md':'Do not apply\n','file':'a','file/child.mjs':'b'}),
      ()=>f.repository.write('project',id,{'README.md':'Do not apply\n','empty-directory':'not a file'}),
      ()=>f.repository.write('project',id,{'README.md':'Do not apply\n'},['README.md','empty-directory']),
      ()=>f.repository.write('project',id,{'README.md':'Do not apply\n'},[],{message:''}),
      ()=>f.repository.write('project',id,{'README.md':'Do not apply\n'},[],{runId:'invalid/run'}),
    ];
    for(const operation of invalid){await assert.rejects(operation());assert.equal(readFileSync(join(created.source.workspacePath,'README.md'),'utf8'),before);assert.equal(git(f.repository.workspacePath,'rev-parse','HEAD'),head);assert.equal(git(f.repository.workspacePath,'diff','--cached'),staged);assert.equal((await f.repository.source('project',id)).dirty,false);}
    f.config.adminPassword='private-source-validation-fixture';
    await assert.rejects(f.repository.write('project',id,{'README.md':'Do not apply\n'},[],{message:f.config.adminPassword}),/Known credentials/);
    const newId=randomUUID();await assert.rejects(f.repository.create({id:newId,kind:'project',name:'Rejected creation',description:f.config.adminPassword}),/Known credentials/);assert.equal(existsSync(join(f.repository.workspacePath,managedPath('project',newId))),false);
    assert.equal(readFileSync(join(created.source.workspacePath,'README.md'),'utf8'),before);
  }finally{f.close();}
});

test('stale source saves return a conflict while preserving the newer files and Git state',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),original=await f.repository.create({id,kind:'project',name:'Concurrent editors',description:''});
    const latest=await f.repository.write('project',id,{'README.md':'Newer committed edit\n'},[],{expectedCommit:original.source.commit});
    const head=git(f.repository.workspacePath,'rev-parse','HEAD'),index=git(f.repository.workspacePath,'diff','--cached');
    await assert.rejects(f.repository.write('project',id,{'README.md':'Stale overwrite\n','new-file.txt':'Must not appear\n'},[],{expectedCommit:original.source.commit}),error=>(error as {statusCode:number}).statusCode===409);
    assert.equal(readFileSync(join(latest.source.workspacePath,'README.md'),'utf8'),'Newer committed edit\n');assert.equal(existsSync(join(latest.source.workspacePath,'new-file.txt')),false);assert.equal(git(f.repository.workspacePath,'rev-parse','HEAD'),head);assert.equal(git(f.repository.workspacePath,'diff','--cached'),index);
    assert.equal((await f.repository.export('project',id)).source.commit,latest.source.commit);assert.equal((await f.repository.source('project',id)).dirty,false);
  }finally{f.close();}
});

test('source file maps retain prototype-like filenames, canonical IDs, and nested runtime source',async()=>{
  const f=fixture();
  try{
    const id=randomUUID().toUpperCase(),created=await f.repository.create({id,kind:'connector',name:'Portable filenames',description:''});assert.equal(created.manifest.id,id.toLowerCase());assert.equal(created.source.path,managedPath('connector',id.toLowerCase()));
    const value=await f.repository.write('connector',id,{'constructor':'constructor source\n','toString':'string conversion source\n','src/runtime/server.mjs':'export const runtime = true;\n','scripts/build/check.mjs':'export const build = true;\n'});
    assert.equal(value.files['constructor'],'constructor source\n');assert.equal(value.files['toString'],'string conversion source\n');assert.equal(value.files['src/runtime/server.mjs'],'export const runtime = true;\n');assert.equal(value.source.dirty,false);
    const reserved=JSON.parse('{"__proto__":"Do not silently discard this filename"}') as Record<string,string>;
    assert.equal(sourceWriteInput.safeParse({files:reserved}).success,false);await assert.rejects(f.repository.write('connector',id,reserved));
    assert.equal(managedFilesSchema.safeParse({'control.txt':'\x01'.repeat(1_400_000)}).success,false);
    assert.equal(managedManifestSchema.safeParse({...created.manifest,run:{command:'node\0',args:[]}}).success,false);
  }finally{f.close();}
});

test('core modifications and other staged packages are rejected without discarding their changes',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),otherId=randomUUID(),created=await f.repository.create({id,kind:'project',name:'First',description:''}),other=await f.repository.create({id:otherId,kind:'skill',name:'Other',description:''});
    const core=join(f.repository.workspacePath,'core.ts');writeFileSync(core,'Unexpected core edit\n');writeFileSync(join(created.source.workspacePath,'README.md'),'Intended package change\n');
    await assert.rejects(f.repository.commit('project',id,'Reject core edit'),/outside managed source/);assert.equal(readFileSync(core,'utf8'),'Unexpected core edit\n');assert.equal(readFileSync(join(created.source.workspacePath,'README.md'),'utf8'),'Intended package change\n');
    writeFileSync(core,'export const owner = true;\n');writeFileSync(join(other.source.workspacePath,'README.md'),'Uncommitted other package\n');
    const committed=await f.repository.commit('project',id,'Only this package');assert.equal(committed.dirty,false);assert.equal((await f.repository.source('skill',otherId)).dirty,true);
    git(f.repository.workspacePath,'add','--',`${other.source.path}/README.md`);
    await assert.rejects(f.repository.write('project',id,{'new.txt':'Do not stage alongside other work\n'}),/Another package has staged/);assert.equal(existsSync(join(created.source.workspacePath,'new.txt')),false);assert.match(git(f.repository.workspacePath,'diff','--cached'),/Uncommitted other package/);
  }finally{f.close();}
});

test('managed operations serialize and an occupied process lock is never stolen',async()=>{
  const f=fixture();
  try{
    const id=randomUUID();await f.repository.create({id,kind:'project',name:'Serialized',description:''});
    await Promise.all([f.repository.write('project',id,{'one.txt':'one\n'}),f.repository.write('project',id,{'two.txt':'two\n'})]);
    const result=await f.repository.export('project',id);assert.equal(result.files['one.txt'],'one\n');assert.equal(result.files['two.txt'],'two\n');
    const lock=join(f.stateDir,'workspaces','managed-repository.lock');mkdirSync(lock);writeFileSync(join(lock,'owner.json'),JSON.stringify({pid:process.pid}));
    await assert.rejects(new ManagedRepository(f.config).ensure(),/busy/);assert.equal(existsSync(join(lock,'owner.json')),true);rmSync(lock,{recursive:true});
    await f.repository.ensure();
  }finally{f.close();}
});

test('concurrent source creation is idempotent and never overwrites an existing draft',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),input={id,kind:'project' as const,name:'Idempotent source',description:''};
    const [first,second]=await Promise.all([f.repository.create(input),f.repository.create(input)]);assert.equal(first.source.commit,second.source.commit);
    const count=git(f.repository.workspacePath,'rev-list','--count','operator/generated');
    writeFileSync(join(first.source.workspacePath,'README.md'),'Keep existing worker draft\n');
    const again=await f.repository.create({...input,name:'Changed retry metadata',template:'service'});assert.equal(again.source.commit,first.source.commit);assert.equal(again.source.dirty,true);assert.equal(again.manifest.name,input.name);assert.equal(readFileSync(join(first.source.workspacePath,'README.md'),'utf8'),'Keep existing worker draft\n');assert.equal(existsSync(join(first.source.workspacePath,'server.mjs')),false);assert.equal(git(f.repository.workspacePath,'rev-list','--count','operator/generated'),count);
  }finally{f.close();}
});

test('connector scaffold checks its actual MCP round trip, and committed binary/symlink entries cannot be exported',async()=>{
  const f=fixture();
  try{
    const id=randomUUID(),created=await f.repository.create({id,kind:'connector',name:'MCP fixture',description:'Deterministic local connector',template:'connector'});
    assert.equal(created.manifest.mcp?.transport,'stdio');assert(managedManifestSchema.safeParse(created.manifest).success);
    const result=execFileSync(process.execPath,created.manifest.check!.args,{cwd:created.source.workspacePath,encoding:'utf8',env:checkEnvironment()});assert.match(result,/pass 1/);
    writeFileSync(join(created.source.workspacePath,'binary.txt'),Buffer.from([0xff,0xfe]));git(f.repository.workspacePath,'add','--',`${created.source.path}/binary.txt`);git(f.repository.workspacePath,'commit','-qm','Injected invalid UTF-8');
    await assert.rejects(f.repository.export('connector',id),/UTF-8/);
    rmSync(join(created.source.workspacePath,'binary.txt'));symlinkSync('/etc/passwd',join(created.source.workspacePath,'symlink.txt'));git(f.repository.workspacePath,'add','--',created.source.path);git(f.repository.workspacePath,'commit','-qm','Injected symlink');
    await assert.rejects(f.repository.export('connector',id),/symlink/);
  }finally{f.close();}
});
