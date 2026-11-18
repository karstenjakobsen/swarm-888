import test from 'node:test';
import assert from 'node:assert/strict';
import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairProjectOwnership } from '../src/runtime/ownership.ts';

test('repository ownership repair traverses external managed Git sources while preserving other project state',()=>{
  const root=mkdtempSync(join(tmpdir(),'operator-repository-owner-')),projects=join(root,'external-projects'),repositories=join(projects,'repositories'),repository=join(repositories,'registered-repository');
  try{
    mkdirSync(join(repository,'.git'),{recursive:true});writeFileSync(join(repository,'.git','HEAD'),'ref: refs/heads/operator/work\n');writeFileSync(join(repository,'server.mjs'),'Created by a root task\n');
    mkdirSync(join(projects,'runtimes'));writeFileSync(join(projects,'runtimes','data'),'Runtime data\n');
    // Passing an invalid UID fails fchown for ordinary nodes, proving successful passes invoke it.
    assert.equal(repairProjectOwnership({projectsDir:projects,stateDir:join(root,'state'),controllerUid:-2}),0);
    assert.equal(repairProjectOwnership({projectsDir:projects,stateDir:join(root,'state'),controllerUid:process.getuid!()}),5);
    assert.equal(readFileSync(join(projects,'runtimes','data'),'utf8'),'Runtime data\n');
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('ownership repair rejects symlink parents, linked files, and paths outside managed repositories',()=>{
  const root=mkdtempSync(join(tmpdir(),'operator-repository-links-')),projects=join(root,'projects'),repositories=join(projects,'repositories'),outside=join(root,'outside');
  try{
    mkdirSync(repositories,{recursive:true});mkdirSync(outside);writeFileSync(join(outside,'secret'),'Outside source\n');symlinkSync(outside,join(repositories,'linked-directory'));symlinkSync(join(outside,'secret'),join(repositories,'linked-file'));linkSync(join(outside,'secret'),join(repositories,'hard-link'));
    const config={projectsDir:projects,stateDir:join(root,'state'),controllerUid:process.getuid!()};assert.equal(repairProjectOwnership(config),1);assert.equal(readFileSync(join(outside,'secret'),'utf8'),'Outside source\n');
    const alias=join(root,'projects-alias');symlinkSync(projects,alias);assert.equal(repairProjectOwnership({...config,projectsDir:alias}),0);
    rmSync(repositories,{recursive:true});symlinkSync(outside,repositories);assert.equal(repairProjectOwnership(config),0);
  }finally{rmSync(root,{recursive:true,force:true});}
});

test('the default in-state project root uses the same safe ownership traversal as external repositories',()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-default-project-ownership-'));
  try{
    const projects=join(stateDir,'projects'),outside=join(stateDir,'outside');
    mkdirSync(projects);writeFileSync(outside,'Retain outside ownership');
    linkSync(outside,join(projects,'hard-link'));symlinkSync(outside,join(projects,'symbolic-link'));
    writeFileSync(join(projects,'owned'),'Restore project ownership');
    assert.equal(repairProjectOwnership({stateDir,controllerUid:process.getuid!()}),2);
  }finally{rmSync(stateDir,{recursive:true,force:true});}
});
