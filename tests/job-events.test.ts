import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState,type Config } from '../src/config.ts';
import { createController } from '../src/controller.ts';

async function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-job-events-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'job-event-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};initState(config);
  const ctl=await createController(config,{startQueue:false,startBridge:false}),login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}}),headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  const project=ctl.projects.create({name:'Market data collector'}),job=ctl.jobs.create({name:'Analyze prepared candle data',projectId:project.id,prompt:'Analyze this prepared snapshot and return a recorded result',schedule:{type:'interval',seconds:300},requiredConnectorIds:[]});
  return {ctl,config,headers,project,job,async close(){await ctl.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('job event credentials permit only scoped deduplicated triggers and are issued to an authenticated owner',async()=>{
  const f=await fixture();try{
    const issuance=`/api/jobs/${f.job.id}/trigger-token`;
    assert.equal((await f.ctl.app.inject({method:'POST',url:issuance,headers:{origin:f.headers.origin},payload:{}})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'POST',url:issuance,headers:{origin:f.headers.origin,cookie:f.headers.cookie},payload:{}})).statusCode,403);
    const response=await f.ctl.app.inject({method:'POST',url:issuance,headers:f.headers,payload:{}});assert.equal(response.statusCode,200,response.body);
    const issued=response.json();assert.match(issued.token,/^[A-Za-z0-9_-]{43}$/);assert.equal(issued.endpoint,`/api/job-events/${f.job.id}`);assert.deepEqual(issued.credential.fields,['token']);
    const machineHeaders={authorization:`Bearer ${issued.token}`},payload={eventId:'EURUSD-H1-2026-11-16T12_00',input:{dataAsOf:'2026-11-16T12:00:00Z',features:{fixture:true}}};
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,payload})).statusCode,401);
    const first=await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers:machineHeaders,payload});assert.equal(first.statusCode,200,first.body);
    const repeated=await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers:machineHeaders,payload});assert.equal(repeated.json().runId,first.json().runId);assert.equal(f.ctl.jobs.get(f.job.id).history.length,1);
    assert.equal((await f.ctl.app.inject({method:'GET',url:'/api/credentials',headers:machineHeaders})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'PATCH',url:`/api/jobs/${f.job.id}`,headers:machineHeaders,payload:{requiredRoot:true}})).statusCode,403);
    const other=f.ctl.jobs.create({name:'Different job',projectId:f.project.id,prompt:'Other analysis',schedule:{type:'interval',seconds:60}});
    assert.equal((await f.ctl.app.inject({method:'POST',url:`/api/job-events/${other.id}`,headers:machineHeaders,payload})).statusCode,401);
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers:{...machineHeaders,origin:'https://untrusted.example'},payload})).statusCode,403);
    const metadata=await f.ctl.app.inject({method:'GET',url:'/api/jobs',headers:f.headers});assert.equal(metadata.body.includes(issued.token),false);assert.equal(JSON.stringify(f.ctl.store.events()).includes(issued.token),false);
    const stored=f.ctl.store.db.prepare('SELECT tokenHash FROM job_trigger_tokens WHERE jobId=?').get(f.job.id);assert.notEqual(stored?.tokenHash,issued.token);
    const rotated=await f.ctl.app.inject({method:'POST',url:issuance,headers:f.headers,payload:{}});assert.equal(rotated.statusCode,200,rotated.body);assert.notEqual(rotated.json().token,issued.token);
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers:machineHeaders,payload})).statusCode,401);
    const currentHeaders={authorization:`Bearer ${rotated.json().token}`};assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers:currentHeaders,payload})).json().runId,first.json().runId);
    f.ctl.jobs.update(f.job.id,{enabled:false});assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers:currentHeaders,payload:{eventId:'later'}})).statusCode,409);
  }finally{await f.close();}
});

test('event payload limits and secrets are rejected, and deleting a project revokes its machine job credential',async()=>{
  const f=await fixture();try{
    const issued=(await f.ctl.app.inject({method:'POST',url:`/api/jobs/${f.job.id}/trigger-token`,headers:f.headers,payload:{}})).json(),headers={authorization:`Bearer ${issued.token}`};
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers,payload:{eventId:'large',input:'x'.repeat(32_001)}})).statusCode,400);
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers,payload:{eventId:'secret',input:issued.token}})).statusCode,400);
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers,payload:{eventId:'grant',requiredRoot:true}})).statusCode,400);
    assert.equal(f.ctl.store.runs().length,0);f.ctl.projects.remove(f.project.id);
    assert.equal((await f.ctl.app.inject({method:'POST',url:issued.endpoint,headers,payload:{eventId:'deleted'}})).statusCode,401);
    assert.deepEqual(f.ctl.store.db.prepare('PRAGMA foreign_key_check').all(),[]);
  }finally{await f.close();}
});
