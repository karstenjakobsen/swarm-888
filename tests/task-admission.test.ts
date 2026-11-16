import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Queue } from '../src/queue.ts';
import { TaskService } from '../src/tasks/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import type { Config } from '../src/config.ts';
import type { TaskOptions } from '../src/tasks/schemas.ts';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-task-admission-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'task-admission-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  const store=new Store(stateDir),worker=Object.assign(new EventEmitter(),{close(){}}),brain={ensureFoundation:async()=>{}};
  const queue=new Queue(config,store,brain as any,worker as any),projects=new ProjectService(config,store,queue.client,()=>false),tasks=new TaskService(store,queue,projects,{get:()=>({})} as any);
  return {store,queue,projects,tasks,close(){queue.close();projects.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}
const invalidContext=(error:unknown)=>error instanceof Error&&(error as Error&{statusCode:number}).statusCode===400&&/context budget/.test(error.message);

test('manual admission rejects intrinsically oversized prompts without storing tasks or messages',()=>{
  const f=fixture();try{
    const conversation=f.store.newConversation();
    for(const [prompt,options] of [
      ['x'.repeat(31_001),{}],
      ['x'.repeat(1001),{maxContextChars:2000}],
      ['x',{maxContextChars:1000}],
    ] satisfies Array<[string,TaskOptions]>){
      assert.throws(()=>f.tasks.submit(conversation.id,{prompt,requestId:randomUUID(),...options}),invalidContext);
      assert.equal(f.store.runs().length,0);assert.equal(f.store.messages(conversation.id).length,0);assert.equal(f.store.conversations().length,1);
    }
    const accepted=f.tasks.submit(conversation.id,{prompt:'x'.repeat(1000),requestId:randomUUID(),maxContextChars:2000});assert.equal(accepted.status,'queued');assert.equal(accepted.prompt.length,1000);assert.equal(f.store.runs().length,1);
  }finally{f.close();}
});

test('delegated admission checks inherited context limits before creating a linked conversation',()=>{
  const f=fixture();try{
    const project=f.projects.create({name:'Bounded delegation'}),conversation=f.projects.newConversation(project.id),parent=f.store.enqueue(conversation.id,'Coordinate a focused task',randomUUID(),'user',null,{requiredConnectorIds:[],maxContextChars:2000,maxOutputChars:2000});
    f.store.claim(parent.id,{id:'default'},{uid:process.getuid!(),journalId:randomUUID(),runtime:{}});
    const before={conversations:f.store.conversations().length,runs:f.store.runs().length,links:Number(f.store.db.prepare('SELECT count(*) AS n FROM project_conversations').get()?.n)};
    const requestId='context-budget-retry';assert.throws(()=>f.tasks.create(parent.id,{prompt:'x'.repeat(1001),requestId}),invalidContext);
    assert.equal(f.store.conversations().length,before.conversations);assert.equal(f.store.runs().length,before.runs);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM project_conversations').get()?.n,before.links);
    assert.throws(()=>f.tasks.create(parent.id,{prompt:'x'.repeat(1001),requestId,maxContextChars:3000}),/cannot increase/);
    const child=f.tasks.create(parent.id,{prompt:'x'.repeat(1000),requestId});assert.equal(child.maxContextChars,2000);assert.equal(child.parentRunId,parent.id);assert.equal(f.store.projects.forConversation(child.conversationId)?.id,project.id);assert.equal(f.store.conversations().length,before.conversations+1);assert.equal(f.store.runs().length,before.runs+1);
    assert.equal(f.tasks.create(parent.id,{prompt:'x'.repeat(1000),requestId}).id,child.id);assert.equal(f.store.conversations().length,before.conversations+1);
  }finally{f.close();}
});
