import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState,type Config } from '../src/config.ts';
import { bridgeRequest } from '../src/mcp.ts';

class OfflineWorker extends EventEmitter {
  calls=0;
  async connect():Promise<never>{this.calls++;throw new Error('Conversation deletion must work offline');}
  close(){}
}
async function fixture(bridge=false){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-chat-removal-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'conversation-removal-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const worker=new OfflineWorker(),controller=await createController(config,{client:worker as any,startQueue:false,startBridge:bridge});
  const login=await controller.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});assert.equal(login.statusCode,200,login.body);
  const headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  return {config,worker,controller,headers,remove(id:string){return controller.app.inject({method:'DELETE',url:`/api/conversations/${id}`,headers});},async close(){await controller.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('conversation deletion requires owner origin/CSRF, rejects unsafe bodies and preserves recovery history offline',async()=>{
  const f=await fixture();try{
    const conversation=f.controller.store.newConversation('Remove this chat'),url=`/api/conversations/${conversation.id}`,input={prompt:'Historical input',requestId:'deleted-chat-request'},run=f.controller.store.enqueue(conversation.id,input.prompt,input.requestId);
    f.controller.store.transition(run.id,'interrupted');f.controller.store.db.prepare('UPDATE runs SET summary=? WHERE id=?').run('Unique deleted checkpoint',run.id);assert.match(f.controller.brain.bootstrap(),/Unique deleted checkpoint/);
    assert.equal((await f.controller.app.inject({method:'DELETE',url,headers:{origin:f.headers.origin}})).statusCode,401);
    assert.equal((await f.controller.app.inject({method:'DELETE',url,headers:{cookie:f.headers.cookie,'x-csrf-token':f.headers['x-csrf-token']}})).statusCode,403);
    assert.equal((await f.controller.app.inject({method:'DELETE',url,headers:{...f.headers,origin:'https://untrusted.example'}})).statusCode,403);
    assert.equal((await f.controller.app.inject({method:'DELETE',url,headers:{origin:f.headers.origin,cookie:f.headers.cookie}})).statusCode,403);
    for(const payload of [{deleteFiles:true},null,[]])assert.equal((await f.controller.app.inject({method:'DELETE',url,headers:{...f.headers,'content-type':'application/json'},payload:JSON.stringify(payload)})).statusCode,400);
    f.controller.store.setSetting('maintenance','true');assert.equal((await f.remove(conversation.id)).statusCode,503);f.controller.store.setSetting('maintenance','false');
    const result=await f.remove(conversation.id);assert.equal(result.statusCode,200,result.body);assert.deepEqual(result.json(),{ok:true});assert.equal((await f.remove(conversation.id)).statusCode,200);
    assert.equal((await f.controller.app.inject({method:'GET',url,headers:f.headers})).statusCode,404);
    assert.equal((await f.controller.app.inject({method:'POST',url:`${url}/runs`,headers:f.headers,payload:input})).statusCode,404);
    assert.equal((await f.controller.app.inject({method:'POST',url:`${url}/runs`,headers:f.headers,payload:{...input,requestId:randomUUID()}})).statusCode,404);
    assert.equal((await f.controller.app.inject({method:'GET',url:'/api/conversations',headers:f.headers})).json().some((item:any)=>item.id===conversation.id),false);
    assert.equal((await f.remove(randomUUID())).statusCode,404);assert.equal(f.controller.brain.bootstrap().includes('Unique deleted checkpoint'),false);
    assert.equal(f.controller.store.run(run.id)?.status,'interrupted');assert.equal(f.controller.store.messages(conversation.id)[0]?.content,input.prompt);
    const events=f.controller.store.events().filter(event=>event.type==='conversation_deleted');assert.equal(events.length,1);assert.deepEqual(events[0]?.data,{conversationId:conversation.id});assert.equal(events[0]?.conversationId,null);assert.equal(f.worker.calls,0);assert.deepEqual(f.controller.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.close();}
});

test('a queued conversation cannot be removed, while unrelated execution does not prevent cleanup',async()=>{
  const f=await fixture();try{
    const conversation=f.controller.store.newConversation(),run=f.controller.store.enqueue(conversation.id,'Queued work',randomUUID());
    let response=await f.remove(conversation.id);assert.equal(response.statusCode,409,response.body);assert(f.controller.store.conversation(conversation.id));
    f.controller.store.transition(run.id,'interrupted');const other=f.controller.store.newConversation(),active=f.controller.store.enqueue(other.id,'Independent work',randomUUID());f.controller.store.transition(active.id,'running');
    response=await f.remove(conversation.id);assert.equal(response.statusCode,200,response.body);assert.equal(f.controller.store.run(active.id)?.status,'running');assert(f.controller.store.conversation(other.id));assert.equal(f.worker.calls,0);
  }finally{await f.close();}
});

test('accepted parallel tools block removal of their task tree after the caller completes',async()=>{
  const f=await fixture(true),releases:Array<()=>void>=[],pending:Promise<any>[]=[];let entered=0,started!:()=>void;const bothStarted=new Promise<void>(resolve=>{started=resolve;});
  try{
    const parent=f.controller.store.newConversation(),child=f.controller.store.newConversation(),unrelated=f.controller.store.newConversation(),run=f.controller.store.enqueue(parent.id,'Coordinate work',randomUUID()),childRun=f.controller.store.enqueue(child.id,'Historical child',randomUUID(),'user',run.id,{taskType:'delegated'});f.controller.store.transition(childRun.id,'interrupted');f.controller.store.transition(run.id,'running');
    f.controller.brain.callTool=async()=>{const gate=new Promise<void>(resolve=>{releases.push(resolve);});if(++entered===2)started();await gate;return {ok:true};};
    for(let index=0;index<2;index++)pending.push(bridgeRequest('tools/call',{name:'memory_search',arguments:{query:`fixture-${index}`},runId:run.id},{socketPath:f.config.bridgeSocket,token:f.config.ipcToken}));
    await bothStarted;f.controller.store.transition(run.id,'completed');assert.equal(f.controller.pendingTools,2);
    assert.equal((await f.remove(parent.id)).statusCode,409);assert.equal((await f.remove(child.id)).statusCode,409);assert.equal((await f.remove(unrelated.id)).statusCode,200);
    releases[0]!();await pending[0];assert.equal(f.controller.pendingTools,1);assert.equal((await f.remove(child.id)).statusCode,409);
    releases[1]!();await pending[1];assert.equal(f.controller.pendingTools,0);assert.equal((await f.remove(child.id)).statusCode,200);assert.equal((await f.remove(parent.id)).statusCode,200);assert.equal(f.worker.calls,0);
  }finally{for(const release of releases)release();await Promise.allSettled(pending);await f.close();}
});
