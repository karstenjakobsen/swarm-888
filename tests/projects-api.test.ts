import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';

test('project HTTP routes enforce session/CSRF and keep project conversations linked',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-project-api-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'project-api-test-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const ctl=await createController(config,{startQueue:false,startBridge:false});
  try{
    assert.equal((await ctl.app.inject({method:'GET',url:'/api/projects'})).statusCode,401);
    const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
    const cookie=String(login.headers['set-cookie']).split(';')[0],headers={cookie,origin:config.origins[0],'x-csrf-token':login.json().csrfToken};
    assert.equal((await ctl.app.inject({method:'POST',url:'/api/projects',headers:{cookie,origin:config.origins[0]},payload:{name:'Missing CSRF'}})).statusCode,403);
    let response=await ctl.app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'VPS report',description:'A deployed report site'}});
    assert.equal(response.statusCode,200,response.body);const project=response.json();
    response=await ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/components`,headers,payload:{name:'Report site',kind:'website',url:'https://report.example.test'}});
    assert.equal(response.statusCode,200,response.body);const component=response.json();
    response=await ctl.app.inject({method:'PATCH',url:`/api/projects/${project.id}/components/${component.id}`,headers,payload:{url:'https://updated.example.test'}});assert.equal(response.statusCode,200,response.body);
    response=await ctl.app.inject({method:'PATCH',url:`/api/projects/${project.id}`,headers,payload:{name:'Updated report site'}});assert.equal(response.statusCode,200,response.body);
    response=await ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/conversations`,headers,payload:{}});assert.equal(response.statusCode,200,response.body);
    const conversation=response.json();assert.equal(ctl.store.projects.forConversation(conversation.id)?.id,project.id);
    response=await ctl.app.inject({method:'GET',url:`/api/projects/${project.id}`,headers});assert.equal(response.json().name,'Updated report site');assert.equal(response.json().components[0].status,'unknown');assert.deepEqual(response.json().conversationIds,[conversation.id]);
    response=await ctl.app.inject({method:'GET',url:'/api/projects',headers});assert.equal(response.json().length,1);
    assert.equal((await ctl.app.inject({method:'POST',url:`/api/projects/${project.id}/refresh`,headers,payload:{status:'healthy'}})).statusCode,400);
    response=await ctl.app.inject({method:'GET',url:`/api/projects/${project.id}/components/${component.id}/logs`,headers});assert.equal(response.statusCode,503);
    ctl.store.setSetting('maintenance','true');
    assert.equal((await ctl.app.inject({method:'POST',url:'/api/projects',headers,payload:{name:'Paused'}})).statusCode,503);
  }finally{await ctl.close();rmSync(stateDir,{recursive:true,force:true});}
});
