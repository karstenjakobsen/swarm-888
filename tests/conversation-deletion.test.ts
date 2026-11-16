import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { migrateBrain } from '../src/brain/migrations.ts';
import { JobService } from '../src/jobs/service.ts';
import type { ProjectService } from '../src/projects/service.ts';

function fixture(){
  const directory=mkdtempSync(join(tmpdir(),'operator-conversation-delete-'));let store=new Store(directory);
  return {directory,get store(){return store;},reopen(){store.close();store=new Store(directory);},close(){store.close();rmSync(directory,{recursive:true,force:true});}};
}
const status=(code:number,expression:RegExp)=>(error:unknown)=>error instanceof Error&&(error as Error&{statusCode:number}).statusCode===code&&expression.test(error.message);
function project(store:Store,directory:string){
  const now=new Date().toISOString();return store.projects.create({id:randomUUID(),name:'Retained project',description:'Conversation deletion fixture',directory,origin:'created',createdAt:now,updatedAt:now});
}
function accept(store:Store,runId:string,workerId='fixture'){
  return store.claim(runId,{id:workerId,model:'fixture-model'},{journalId:randomUUID(),uid:process.getuid!(),runtime:{model:'fixture-model'}});
}

test('conversation removal hides the workspace entry durably and emits one deletion event',()=>{
  const f=fixture();try{
    const conversation=f.store.newConversation('Remove this chat'),other=f.store.newConversation('Keep this chat'),emitted:string[]=[];
    f.store.on('event',event=>emitted.push(event.type));
    assert.deepEqual(f.store.removeConversation(conversation.id),{ok:true});assert.equal(f.store.conversation(conversation.id),undefined);assert.equal(f.store.conversation(conversation.id,true)?.title,conversation.title);assert.deepEqual(f.store.conversations().map(item=>item.id),[other.id]);
    const event=f.store.events().find(event=>event.type==='conversation_deleted')!;assert.deepEqual(event.data,{conversationId:conversation.id});assert.equal(event.conversationId,null);assert.equal(event.runId,null);
    assert.deepEqual(f.store.removeConversation(conversation.id),{ok:true});assert.deepEqual(emitted,['conversation_deleted']);assert.throws(()=>f.store.removeConversation(randomUUID()),status(404,/not found/));
    f.reopen();assert.equal(f.store.conversation(conversation.id),undefined);assert.deepEqual(f.store.conversations().map(item=>item.id),[other.id]);assert.equal(f.store.events().filter(event=>event.type==='conversation_deleted').length,1);
    const created=f.store.newConversation('A new chat');assert(f.store.conversation(created.id));assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n,9);
  }finally{f.close();}
});

test('queued, running, waiting and uncertain work block deletion without affecting unrelated conversations',()=>{
  const f=fixture();try{
    for(const state of ['queued','running','waiting','uncertain'] as const){
      const conversation=f.store.newConversation(state),run=f.store.enqueue(conversation.id,'Finish this work',randomUUID());
      if(state!=='queued')accept(f.store,run.id);
      if(state==='waiting'||state==='uncertain')f.store.transition(run.id,state);
      assert.throws(()=>f.store.removeConversation(conversation.id),status(409,/Finish or reconcile/));assert(f.store.conversation(conversation.id));assert.equal(f.store.run(run.id)?.status,state);
      const unrelated=f.store.newConversation('Unrelated');assert.deepEqual(f.store.removeConversation(unrelated.id),{ok:true});
      f.store.transition(run.id,'interrupted');assert.deepEqual(f.store.removeConversation(conversation.id),{ok:true});
    }
    assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('active parent and child tasks keep their connected workflow conversations visible until finished',()=>{
  const f=fixture();try{
    const parentConversation=f.store.newConversation('Parent'),childConversation=f.store.newConversation('Child'),unrelated=f.store.newConversation('Other workflow');
    const parent=f.store.enqueue(parentConversation.id,'Coordinate work',randomUUID());accept(f.store,parent.id,'parent-worker');
    const child=f.store.enqueue(childConversation.id,'Bounded child',randomUUID(),'user',parent.id,{taskType:'delegated'});accept(f.store,child.id,'child-worker');f.store.transition(child.id,'completed');
    assert.throws(()=>f.store.removeConversation(childConversation.id),status(409,/related tasks/));assert.deepEqual(f.store.removeConversation(unrelated.id),{ok:true});
    f.store.transition(parent.id,'completed');
    const grandchildConversation=f.store.newConversation('Grandchild'),grandchild=f.store.enqueue(grandchildConversation.id,'Follow-up',randomUUID(),'user',child.id,{taskType:'delegated'});
    assert.throws(()=>f.store.removeConversation(parentConversation.id),status(409,/related tasks/));
    f.store.transition(grandchild.id,'interrupted');
    assert.deepEqual(f.store.removeConversation(parentConversation.id),{ok:true});assert.deepEqual(f.store.removeConversation(childConversation.id),{ok:true});assert.deepEqual(f.store.removeConversation(grandchildConversation.id),{ok:true});
    assert.equal(f.store.run(child.id)?.parentRunId,parent.id);assert.equal(f.store.run(grandchild.id)?.parentRunId,child.id);
  }finally{f.close();}
});

test('pending source finalization and execution leases cannot be hidden by deleting their conversation',()=>{
  const f=fixture();try{
    const p=project(f.store,join(f.directory,'project')),conversation=f.store.newConversation('Managed source');f.store.projects.linkConversation(p.id,conversation.id);
    const source={repositoryPath:join(f.directory,'repository'),branch:'operator/generated',path:`generated/projects/${p.id}`,workspacePath:join(f.directory,'source'),commit:'a'.repeat(40),dirty:false};
    f.store.managed.saveSource(p.id,'project',source);
    const run=f.store.enqueue(conversation.id,'Edit source',randomUUID());accept(f.store,run.id);f.store.transition(run.id,'completed');
    assert.throws(()=>f.store.removeConversation(conversation.id),status(409,/pending source commits/));assert(f.store.conversation(conversation.id));
    f.store.sourceFinalized(run.id,source.commit,source);
    f.store.db.prepare('INSERT INTO project_leases(projectId,runId,attemptId,acquiredAt) VALUES(?,?,?,?)').run(p.id,run.id,'retained-reconciliation-evidence',new Date().toISOString());
    assert.throws(()=>f.store.removeConversation(conversation.id),status(409,/execution lease/));f.store.db.prepare('DELETE FROM project_leases WHERE runId=?').run(run.id);
    assert.deepEqual(f.store.removeConversation(conversation.id),{ok:true});assert.equal(f.store.managed.source(p.id)?.source.commit,source.commit);
  }finally{f.close();}
});

test('accepted tool operations block their related workflow without blocking unrelated conversation removal',()=>{
  const f=fixture();try{
    const parentConversation=f.store.newConversation('Parent'),childConversation=f.store.newConversation('Child'),unrelated=f.store.newConversation('Other chat');
    const parent=f.store.enqueue(parentConversation.id,'Coordinate tools',randomUUID());accept(f.store,parent.id);f.store.transition(parent.id,'completed');
    const child=f.store.enqueue(childConversation.id,'Related tool work',randomUUID(),'user',parent.id);f.store.transition(child.id,'interrupted');
    assert.throws(()=>f.store.removeConversation(childConversation.id,[parent.id]),status(409,/tool operations/));assert(f.store.conversation(childConversation.id));assert.deepEqual(f.store.removeConversation(unrelated.id,[parent.id]),{ok:true});
    assert.deepEqual(f.store.removeConversation(childConversation.id),{ok:true});
  }finally{f.close();}
});

test('deleted conversations preserve attempts, replay cursors and thread ownership without accepting new work',()=>{
  const f=fixture();try{
    const conversation=f.store.newConversation('Replay history'),requestId=randomUUID(),run=f.store.enqueue(conversation.id,'Retain durable task evidence',requestId),accepted=accept(f.store,run.id),attempt=f.store.attempt(accepted.attemptId!)!,owner={workerId:'fixture',journalId:String(attempt.journalId)},now=new Date().toISOString();
    const event=(cursor:number,type:string,data:unknown)=>({cursor,runId:run.id,attemptId:accepted.attemptId!,type,data,createdAt:now});
    f.store.ingest(event(1,'thread',{threadId:'fixture-native-thread',model:'fixture-model'}),owner);f.store.ingest(event(2,'delta',{text:'Retained result'}),owner);const completed=event(3,'completed',{status:'completed'});f.store.ingest(completed,owner);
    const before={messages:f.store.messages(conversation.id),attempt:f.store.attempt(accepted.attemptId!)};
    f.store.removeConversation(conversation.id);
    assert.deepEqual(f.store.messages(conversation.id),before.messages);assert.deepEqual(f.store.attempt(accepted.attemptId!),before.attempt);assert.equal(f.store.thread(conversation.id,owner.workerId,owner.journalId),'fixture-native-thread');
    assert.equal(f.store.ingest(completed,owner),false);assert.equal(f.store.cursor(owner.workerId,owner.journalId),3);
    assert.equal(f.store.ingest(event(4,'activity',{method:'thread/tokenUsage/updated',tokenUsage:{totalTokens:3}}),owner),true);assert.equal(f.store.cursor(owner.workerId,owner.journalId),4);assert.equal(f.store.conversation(conversation.id),undefined);assert.deepEqual(f.store.conversations(),[]);
    assert.throws(()=>f.store.enqueue(conversation.id,'New work',randomUUID()),status(404,/not found/));assert.equal(f.store.enqueue(conversation.id,'Retain durable task evidence',requestId).id,run.id,'Internal idempotent recovery may return the recorded task without reopening its conversation');assert.equal(f.store.runs().length,1);
    f.reopen();assert.equal(f.store.conversation(conversation.id),undefined);assert.equal(f.store.ingest(completed,owner),false);assert.equal(f.store.run(run.id)?.status,'completed');assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('project inventory hides deleted chats while services, source, memory and scheduled history remain intact',()=>{
  const f=fixture();try{
    migrateBrain(f.store.db);
    const directory=join(f.directory,'project');mkdirSync(directory);writeFileSync(join(directory,'running-service.txt'),'Retained application state');
    const p=project(f.store,directory),conversation=f.store.newConversation('Analysis history'),kept=f.store.newConversation('Visible project chat');f.store.projects.linkConversation(p.id,conversation.id);f.store.projects.linkConversation(p.id,kept.id);
    const run=f.store.enqueue(conversation.id,'Analyze a fixture',randomUUID());accept(f.store,run.id);f.store.transition(run.id,'completed');f.store.db.prepare('UPDATE runs SET summary=? WHERE id=?').run('Do not include deleted-chat summary in fresh task context',run.id);
    const now=new Date().toISOString(),memoryId=randomUUID(),jobId=randomUUID();
    f.store.db.prepare("INSERT INTO memories(id,content,kind,source,created_at,updated_at) VALUES(?,?,'user_fact',?,?,?)").run(memoryId,'Retained owner memory','Explicit owner instruction',now,now);
    f.store.db.prepare('INSERT INTO task_checkpoints VALUES(?,?,?,?,?)').run(randomUUID(),run.id,conversation.id,'Retained recovery checkpoint',now);
    f.store.db.prepare('INSERT INTO jobs(id,name,projectId,prompt,schedule,options,enabled,createdAt,updatedAt) VALUES(?,?,?,?,?,?,1,?,?)').run(jobId,'Recurring analysis',p.id,'Analyze future data',JSON.stringify({type:'interval',seconds:60}),'{}',now,now);
    f.store.db.prepare('INSERT INTO job_runs VALUES(?,?,?)').run(jobId,run.id,'event:fixture-bar');
    f.store.projects.writeComponent(p.id,randomUUID(),{name:'Retained service',kind:'service',unitName:'retained.service'});
    assert(f.store.recentWork().some(item=>item.id===run.id));f.store.removeConversation(conversation.id);
    assert.equal(f.store.projects.get(p.id)?.components.length,1);assert.deepEqual(f.store.projects.get(p.id)?.conversationIds,[kept.id]);assert.deepEqual(f.store.projects.get(p.id)?.runs,[]);assert.equal(f.store.projects.forConversation(conversation.id)?.id,p.id,'Internal project ownership remains recoverable');
    assert.equal(f.store.recentWork().some(item=>item.id===run.id),false);assert.equal(f.store.db.prepare('SELECT content FROM memories WHERE id=?').get(memoryId)?.content,'Retained owner memory');assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM task_checkpoints').get()?.n,1);assert.equal(readFileSync(join(directory,'running-service.txt'),'utf8'),'Retained application state');
    const jobs=new JobService(f.store,{} as ProjectService);assert.equal(jobs.trigger(jobId,'fixture-bar').id,run.id);assert.equal(f.store.runs().length,1);jobs.close();
    assert.throws(()=>f.store.projects.linkConversation(p.id,conversation.id),status(404,/Conversation not found/));assert.deepEqual(f.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{f.close();}
});

test('a deleted scheduled conversation still deduplicates a crash-gap occurrence without reopening it',()=>{
  const f=fixture();try{
    const p=project(f.store,join(f.directory,'project')),projects={get:(id:string)=>f.store.projects.get(id)!,newConversation:(id:string)=>{const conversation=f.store.newConversation('Scheduled analysis');f.store.projects.linkConversation(id,conversation.id);return conversation;}} as ProjectService;
    const jobs=new JobService(f.store,projects),job=jobs.create({name:'Durable occurrence',projectId:p.id,prompt:'Inspect a prepared snapshot',schedule:{type:'interval',seconds:60}}),run=jobs.trigger(job.id,'same-event');
    f.store.transition(run.id,'running');f.store.transition(run.id,'completed');
    // Recreate the run-before-job_runs persistence gap that restart recovery handles.
    f.store.db.prepare('DELETE FROM job_runs WHERE jobId=?').run(job.id);f.store.removeConversation(run.conversationId);
    const before=f.store.db.prepare('SELECT count(*) AS n FROM conversations').get()?.n;
    assert.equal(jobs.trigger(job.id,'same-event').id,run.id);assert.equal(f.store.db.prepare('SELECT count(*) AS n FROM conversations').get()?.n,before);assert.equal(f.store.conversation(run.conversationId),undefined);assert.equal(jobs.get(job.id).history[0]?.runId,run.id);assert.equal(f.store.runs().length,1);jobs.close();
  }finally{f.close();}
});

test('conversation deletion migration upgrades an existing eight-migration database once',()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-delete-upgrade-')),db=new DatabaseSync(join(directory,'operator.sqlite'));let store:Store|undefined;
  try{
    const now=new Date().toISOString();
    for(const [index,file] of ['001-core.sql','002-projects.sql','003-managed-source.sql','004-connector-checks.sql','005-runtime-receipts.sql','006-worker-platform.sql','007-credentials.sql','008-project-runtime.sql'].entries()){
      db.exec(readFileSync(new URL(`../migrations/${file}`,import.meta.url),'utf8'));db.prepare('INSERT INTO schema_migrations VALUES(?,?)').run(index+1,now);
    }
    const id=randomUUID();db.prepare('INSERT INTO conversations VALUES(?,?,?,?,?)').run(id,'Existing chat',null,now,now);db.close();
    store=new Store(directory);assert.equal(store.conversation(id)?.title,'Existing chat');assert.deepEqual(store.removeConversation(id),{ok:true});store.close();store=new Store(directory);assert.equal(store.conversation(id),undefined);assert.equal(store.db.prepare('SELECT count(*) AS n FROM schema_migrations').get()?.n,9);assert.deepEqual(store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{store?.close();if(db.isOpen)db.close();rmSync(directory,{recursive:true,force:true});}
});
