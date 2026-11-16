import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState,type Config } from '../src/config.ts';
import { createController } from '../src/controller.ts';

test('configured administrator, IPC and environment secrets share task, metadata and event guards',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-configured-secret-')),previous=process.env.OPERATOR_REVIEW_TOKEN;
  process.env.OPERATOR_REVIEW_TOKEN='fixture-configured-environment-token';
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'fixture-configured-administrator-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const ctl=await createController(config,{startQueue:false,startBridge:false});
  try{
    const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
    assert.equal(login.statusCode,200,login.body);
    const headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken},project=ctl.projects.create({name:'Guarded project'}),conversation=ctl.projects.newConversation(project.id);
    for(const [index,secret] of [config.adminPassword,config.ipcToken,process.env.OPERATOR_REVIEW_TOKEN].entries()){
      const input={prompt:`Do not retain ${secret}`,requestId:`configured-secret-${index}`};
      let response=await ctl.app.inject({method:'POST',url:`/api/conversations/${conversation.id}/runs`,headers,payload:input});assert.equal(response.statusCode,400,response.body);assert.equal(response.body.includes(secret),false);
      assert.throws(()=>ctl.tasks.submit(conversation.id,input),/Credential values/,'Direct task admission must use the same guard');
      response=await ctl.app.inject({method:'POST',url:'/api/jobs',headers,payload:{name:'Guarded analysis',projectId:project.id,prompt:`Do not retain ${secret}`,schedule:{type:'interval',seconds:60}}});assert.equal(response.statusCode,400,response.body);
      response=await ctl.app.inject({method:'PATCH',url:`/api/projects/${project.id}`,headers,payload:{name:`Do not retain ${secret}`}});assert.equal(response.statusCode,400,response.body);
      assert.throws(()=>ctl.brain.setInstructions(`Do not retain ${secret}`),/Credential values/);
      await assert.rejects(ctl.brain.callTool('memory_write',{content:secret,kind:'user_fact',source:'Configured-secret regression'}),/Credential values/);
      const event=ctl.store.addEvent('tool',{message:`Observed ${secret}`,nested:{[secret]:secret}});
      assert.equal(JSON.stringify(event).includes(secret),false);assert.match(JSON.stringify(event),/REDACTED/);
    }
    assert.deepEqual(ctl.store.runs(),[]);assert.deepEqual(ctl.store.messages(conversation.id),[]);assert.deepEqual(ctl.jobs.list(),[]);assert.equal(ctl.projects.get(project.id).name,'Guarded project');
    const credential=await ctl.app.inject({method:'POST',url:'/api/credentials',headers,payload:{name:'Explicit owner secret',values:{token:config.adminPassword}}});assert.equal(credential.statusCode,200,credential.body);assert.equal(credential.body.includes(config.adminPassword),false,'Explicit credential writes remain write-only');
    const persisted=JSON.stringify(ctl.store.db.prepare('SELECT data FROM events').all());for(const secret of [config.adminPassword,config.ipcToken,process.env.OPERATOR_REVIEW_TOKEN])assert.equal(persisted.includes(secret),false);
  }finally{await ctl.close();if(previous===undefined)delete process.env.OPERATOR_REVIEW_TOKEN;else process.env.OPERATOR_REVIEW_TOKEN=previous;rmSync(stateDir,{recursive:true,force:true});}
});
