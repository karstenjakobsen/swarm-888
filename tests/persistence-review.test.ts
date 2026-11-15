import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';

test('event persistence failure rolls back queued work, messages and status changes',()=>{
  const state=mkdtempSync(join(tmpdir(),'operator-event-atomic-')),store=new Store(state);
  const emitted:unknown[]=[];store.on('event',event=>emitted.push(event));
  const blockEvents=()=>store.db.exec("CREATE TEMP TRIGGER reject_event BEFORE INSERT ON events BEGIN SELECT RAISE(ABORT,'fixture event persistence failure'); END;");
  const allowEvents=()=>store.db.exec('DROP TRIGGER reject_event;');
  try{
    const conversation=store.newConversation();blockEvents();
    assert.throws(()=>store.enqueue(conversation.id,'Keep state and history atomic','atomic-request'),/fixture event persistence failure/);
    assert.equal(store.runs().length,0);assert.equal(store.messages(conversation.id).length,0);
    assert.equal(store.conversation(conversation.id)?.title,'New conversation');assert.equal(emitted.length,0);
    allowEvents();const run=store.enqueue(conversation.id,'Keep state and history atomic','atomic-request');
    blockEvents();assert.throws(()=>store.transition(run.id,'running'),/fixture event persistence failure/);
    assert.equal(store.run(run.id)?.status,'queued');assert.equal(store.run(run.id)?.startedAt,null);assert.equal(emitted.length,1);
    allowEvents();store.transition(run.id,'running');
    blockEvents();assert.throws(()=>store.transition(run.id,'completed'),/fixture event persistence failure/);
    assert.equal(store.run(run.id)?.status,'running');assert.equal(store.run(run.id)?.finishedAt,null);assert.equal(emitted.length,2);
    allowEvents();store.transition(run.id,'completed');assert.equal(store.run(run.id)?.status,'completed');assert.equal(emitted.length,3);
  }finally{store.close();rmSync(state,{recursive:true,force:true});}
});

test('idempotency keys cannot change run kind or parent identity',()=>{
  const state=mkdtempSync(join(tmpdir(),'operator-idempotency-input-')),store=new Store(state);
  try{
    const conversation=store.newConversation(),run=store.enqueue(conversation.id,'Same prompt','complete-request');
    assert.equal(store.enqueue(conversation.id,'Same prompt','complete-request').id,run.id);
    assert.throws(()=>store.enqueue(conversation.id,'Same prompt','complete-request','improvement'),/different input/);
    assert.throws(()=>store.enqueue(conversation.id,'Same prompt','complete-request','user',run.id),/different input/);
    assert.equal(store.runs().length,1);assert.equal(store.messages(conversation.id).length,1);assert.equal(store.events().length,1);
  }finally{store.close();rmSync(state,{recursive:true,force:true});}
});
