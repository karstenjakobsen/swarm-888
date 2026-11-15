import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync,writeFileSync,symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { loadConfig } from '../src/config.ts';
import { bridgeRequest } from '../src/mcp.ts';

test('authenticated routes require cookie, origin and CSRF; memory persists and artifact paths stay confined',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'operator-http-'));
  const previous={...process.env};Object.assign(process.env,{APP_STATE_DIR:dir,APP_ALLOW_TEMP_STATE:'true',ADMIN_PASSWORD:'test-only-password-123456',APP_ORIGIN:'http://localhost:5173'});
  const config=loadConfig({requireAdmin:true});process.env=previous;
  const ctl=await createController(config,{startQueue:false});
  try{
    let response=await ctl.app.inject({method:'GET',url:'/api/status'});assert.equal(response.statusCode,401);
    response=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:'https://evil.invalid'},payload:{password:config.adminPassword}});assert.equal(response.statusCode,403);
    response=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:'wrong'}});assert.equal(response.statusCode,401);
    response=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});assert.equal(response.statusCode,200);
    assert.match(String(response.headers['set-cookie']),/HttpOnly; SameSite=Strict/);
    const cookie=String(response.headers['set-cookie']).split(';')[0],csrf=response.json().csrfToken,headers={cookie,origin:config.origins[0],'x-csrf-token':csrf};
    response=await ctl.app.inject({method:'POST',url:'/api/conversations',headers:{cookie,origin:config.origins[0]},payload:{}});assert.equal(response.statusCode,403);
    response=await ctl.app.inject({method:'POST',url:'/api/conversations',headers,payload:{title:'Durable browser task'}});assert.equal(response.statusCode,200);const c=response.json();
    response=await ctl.app.inject({method:'POST',url:`/api/conversations/${c.id}/runs`,headers,payload:{prompt:'Harmless fixture',requestId:'http_request'}});assert.equal(response.statusCode,200);const run=response.json();
    response=await ctl.app.inject({method:'POST',url:'/api/memory',headers,payload:{content:'The unique kestrel number is 47.',kind:'user_fact',source:'owner',tags:['fixture']}});assert.equal(response.statusCode,200);
    response=await ctl.app.inject({method:'GET',url:'/api/memory?q=kestrel',headers});assert.equal(response.json().length,1);
    response=await ctl.app.inject({method:'PUT',url:'/api/instructions',headers,payload:{text:'Prefer concise status updates.'}});assert.equal(response.statusCode,200);
    ctl.store.transition(run.id,'running');
    await assert.rejects(bridgeRequest('tools/call',{name:'memory_search',arguments:{query:'kestrel'},runId:run.id},{socketPath:config.bridgeSocket,token:'f'.repeat(64)}),/Unauthorized/);
    const result=await bridgeRequest('tools/call',{name:'memory_search',arguments:{query:'kestrel'},runId:run.id},{socketPath:config.bridgeSocket,token:config.ipcToken});assert.equal(result[0].content,'The unique kestrel number is 47.');
    writeFileSync(join(dir,'artifacts/report.txt'),'fixture output');symlinkSync('/etc/passwd',join(dir,'artifacts/escape.txt'));
    response=await ctl.app.inject({method:'GET',url:'/api/artifacts/report.txt',headers});assert.equal(response.body,'fixture output');assert.match(String(response.headers['content-disposition']),/attachment/);
    response=await ctl.app.inject({method:'GET',url:'/api/artifacts/escape.txt',headers});assert.equal(response.statusCode,403);
    response=await ctl.app.inject({method:'POST',url:'/api/logout',headers,payload:{}});assert.equal(response.statusCode,200);
    response=await ctl.app.inject({method:'GET',url:'/api/status',headers});assert.equal(response.statusCode,401);
  }finally{await ctl.close();rmSync(dir,{recursive:true,force:true});}
});

test('configuration rejects ephemeral/relative state and requires an administrator credential',()=>{
  const previous={...process.env};
  try{
    process.env.APP_STATE_DIR='relative/state';assert.throws(()=>loadConfig(),/absolute/);
    process.env.APP_STATE_DIR='/tmp/unsafe-default';delete process.env.APP_ALLOW_TEMP_STATE;assert.throws(()=>loadConfig(),/persistent/);
    delete process.env.ADMIN_PASSWORD;assert.throws(()=>loadConfig({requireAdmin:true}));
  }finally{process.env=previous;}
});

test('authenticated SSE catches up by sequence cursor after disconnection',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'operator-stream-')),previous={...process.env};
  Object.assign(process.env,{APP_STATE_DIR:dir,APP_ALLOW_TEMP_STATE:'true',ADMIN_PASSWORD:'test-stream-password-1234'});
  const config=loadConfig({requireAdmin:true});process.env=previous;
  const ctl=await createController(config,{startQueue:false,startBridge:false});
  try{
    const base=await ctl.app.listen({host:'127.0.0.1',port:0});
    assert.equal((await fetch(base+'/api/events')).status,401);
    const login=await fetch(base+'/api/login',{method:'POST',headers:{origin:config.origins[0],'content-type':'application/json'},body:JSON.stringify({password:config.adminPassword})});
    const cookie=login.headers.get('set-cookie')!.split(';')[0];
    const first=ctl.store.addEvent('fixture',{text:'before disconnect'});
    async function take(after:number,target:number){
      const abort=new AbortController(),timer=setTimeout(()=>abort.abort(),4000);const result:any[]=[];
      try{
        const response=await fetch(base+`/api/events?after=${after}`,{headers:{cookie},signal:abort.signal});assert.equal(response.status,200);
        const reader=response.body!.getReader(),decoder=new TextDecoder();let buffer='';
        while(!result.some(e=>e.seq===target)){
          const chunk=await reader.read();if(chunk.done)break;buffer+=decoder.decode(chunk.value,{stream:true});
          let end;while((end=buffer.indexOf('\n\n'))>=0){const frame=buffer.slice(0,end);buffer=buffer.slice(end+2);
            if(frame.includes('event: event')){const data=frame.split('\n').find(line=>line.startsWith('data: '));result.push(JSON.parse(data!.slice(6)));}
          }
        }
        await reader.cancel();return result;
      }finally{clearTimeout(timer);abort.abort();}
    }
    const loaded=await take(0,first.seq);assert.deepEqual(loaded.map(e=>e.seq),[first.seq]);
    const second=ctl.store.addEvent('fixture',{text:'during disconnect'}),third=ctl.store.addEvent('fixture',{text:'still durable'});
    const replay=await take(first.seq,third.seq);assert.deepEqual(replay.map(e=>e.seq),[second.seq,third.seq]);
    assert.equal(ctl.store.events().length,3);
  }finally{await ctl.close();rmSync(dir,{recursive:true,force:true});}
});
