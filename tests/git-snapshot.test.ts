import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { Config } from '../src/config.ts';
import { createGitSnapshot, openGitSnapshot, packageSnapshotPath } from '../src/managed/snapshot.ts';
import { ManagedRuntime } from '../src/runtime/managed.ts';

function fixture(path='apps/site'){
  const directory=mkdtempSync(join(tmpdir(),'operator-git-snapshot-')),repository=join(directory,'repository'),projectsDir=join(directory,'projects');mkdirSync(repository);mkdirSync(projectsDir);
  const config={stateDir:join(directory,'state'),projectsDir,controllerUid:process.getuid!()} as Config;
  const git=(args:string[])=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','user.name=Fixture','-c','user.email=fixture@localhost','-C',repository,...args],{encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();git(['init','-q']);
  const project={id:'4fcbfc98-c381-4358-a753-af570e9bc3d2',directory:join(projectsDir,'runtimes','fixture')};
  const manifest={schemaVersion:1,id:project.id,kind:'project' as const,name:'Binary website',description:'',run:{command:'node',args:['server.mjs']}};
  const folder=path==='.'?repository:join(repository,path);mkdirSync(folder,{recursive:true});writeFileSync(join(folder,'operator-package.json'),JSON.stringify(manifest));writeFileSync(join(folder,'server.mjs'),'console.log("committed");\n');
  return {directory,repository,config,git,project,manifest,path,folder,commit:()=>{git(['add','.']);git(['commit','-qm','Snapshot fixture']);return git(['rev-parse','HEAD']);},close:()=>rmSync(directory,{recursive:true,force:true})};
}

test('Git snapshots preserve committed binary bytes, executable modes and source revisions independently of dirty working files',async()=>{
  const f=fixture(),runtime=new ManagedRuntime(f.config,async()=>{throw new Error('Preparing a project must not execute imported code');});
  try{
    const binary=Buffer.alloc(9_000_001);for(let index=0;index<binary.length;index+=4096)binary[index]=255;writeFileSync(join(f.folder,'asset.bin'),binary);
    writeFileSync(join(f.folder,'script.sh'),'#!/bin/sh\necho committed\n');chmodSync(join(f.folder,'script.sh'),0o755);
    const revision=f.commit(),snapshot=createGitSnapshot(f.config,f.repository,revision,f.path);
    writeFileSync(join(f.folder,'asset.bin'),'dirty');writeFileSync(join(f.folder,'untracked.txt'),'must not deploy');
    const prepared=await runtime.prepare({project:f.project,manifest:f.manifest,source:{commit:revision,path:f.path},snapshot});
    assert.deepEqual(readFileSync(join(prepared.releaseDirectory,'asset.bin')),binary);assert(lstatSync(join(prepared.releaseDirectory,'script.sh')).mode&0o111);assert(!existsSync(join(prepared.releaseDirectory,'untracked.txt')));
    assert.deepEqual(createGitSnapshot(f.config,f.repository,revision,f.path),snapshot);assert.equal((await runtime.prepare({project:f.project,manifest:f.manifest,source:{commit:revision,path:f.path},snapshot})).releaseDirectory,prepared.releaseDirectory);
    writeFileSync(join(prepared.releaseDirectory,'asset.bin'),'modified');await assert.rejects(runtime.prepare({project:f.project,manifest:f.manifest,source:{commit:revision,path:f.path},snapshot}),/differs from its committed snapshot/);
  }finally{await runtime.close();f.close();}
});

test('root packages and repositories with more than 500 files use Git snapshot preparation',async()=>{
  const f=fixture('.'),runtime=new ManagedRuntime(f.config);
  try{
    for(let index=0;index<510;index++)writeFileSync(join(f.folder,`file-${index}.txt`),String(index));
    const revision=f.commit(),snapshot=createGitSnapshot(f.config,f.repository,revision,'.');
    const prepared=await runtime.prepare({project:f.project,manifest:f.manifest,source:{commit:revision,path:'.'},snapshot});assert.equal(readFileSync(join(prepared.releaseDirectory,'file-509.txt'),'utf8'),'509');
  }finally{await runtime.close();f.close();}
});

test('Git artifacts reject changed content, wrong identity, traversal, symbolic links and ambiguous source payloads',async()=>{
  const f=fixture(),runtime=new ManagedRuntime(f.config);
  try{
    const revision=f.commit(),snapshot=createGitSnapshot(f.config,f.repository,revision,f.path),input={project:f.project,manifest:f.manifest,source:{commit:revision,path:f.path},snapshot};
    assert.throws(()=>runtime.prepare({...input,files:{'operator-package.json':JSON.stringify(f.manifest)}}),/exactly one/);
    await assert.rejects(runtime.prepare({...input,source:{commit:'a'.repeat(40),path:f.path}}),/identity or digest/);
    await assert.rejects(runtime.prepare({...input,snapshot:{...snapshot,directory:f.repository}}),/configured artifact directory/);
    assert.throws(()=>packageSnapshotPath('../site'),/repository-relative/);
    writeFileSync(join(snapshot.directory,'server.mjs'),'malicious changed bytes');assert.throws(()=>openGitSnapshot(f.config,snapshot,input.source),/differs from its committed snapshot/);
    symlinkSync('/etc/passwd',join(f.folder,'link'));f.git(['add','.']);f.git(['commit','-qm','Unsupported link']);assert.throws(()=>createGitSnapshot(f.config,f.repository,f.git(['rev-parse','HEAD']),f.path),/symbolic links and submodules/);
  }finally{await runtime.close();f.close();}
});

test('registered package paths keep service observation and lifecycle bound to their canonical package identity',async()=>{
  const f=fixture('services/public-site');let serviceDirectory:string|undefined,running=false,units=0;
  const runtime=new ManagedRuntime(f.config,async(_command,args)=>{
    if(args.includes('--property=Version'))return {stdout:'Version=fixture',stderr:'',exitCode:0,truncated:false};
    if(args[0]==='restart')running=true;if(args[0]==='disable')running=false;
    return {stdout:args[0]==='show'?serviceDirectory?`LoadState=loaded\nActiveState=${running?'active':'inactive'}\nSubState=fixture\nWorkingDirectory=${serviceDirectory}\n`:'LoadState=not-found\n':'',stderr:'',exitCode:0,truncated:false};
  },{isRoot:()=>true,writeUnit:(_name,content)=>{units++;serviceDirectory=content.match(/^WorkingDirectory="(.*)"$/m)?.[1];}});
  try{
    const revision=f.commit(),snapshot=createGitSnapshot(f.config,f.repository,revision,f.path),input={project:f.project,manifest:f.manifest,source:{commit:revision,path:f.path},snapshot};
    const deployed=await runtime.deploy(input);assert.equal(deployed.status,'running');assert.equal((await runtime.status({project:f.project})).commit,revision);assert.equal((await runtime.deploy(input)).commit,revision);assert.equal(units,1);assert.equal((await runtime.stop({project:f.project})).status,'stopped');
  }finally{await runtime.close();f.close();}
});

test('Git replacement refs cannot substitute different source under an original commit identifier',async()=>{
  const f=fixture(),runtime=new ManagedRuntime(f.config);
  try{
    const original=f.commit();writeFileSync(join(f.folder,'server.mjs'),'console.log("replacement");\n');const replacement=f.commit();f.git(['replace',original,replacement]);
    assert.equal(f.git(['show',`${original}:${f.path}/server.mjs`]),'console.log("replacement");');
    const snapshot=createGitSnapshot(f.config,f.repository,original,f.path),prepared=await runtime.prepare({project:f.project,manifest:f.manifest,source:{commit:original,path:f.path},snapshot});
    assert.equal(readFileSync(join(prepared.releaseDirectory,'server.mjs'),'utf8'),'console.log("committed");\n');
  }finally{await runtime.close();f.close();}
});
