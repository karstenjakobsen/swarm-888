import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState,type Config } from '../src/config.ts';

class OfflineWorker extends EventEmitter {
  async connect():Promise<never>{throw new Error('Fixture worker is offline');}
  async request():Promise<never>{throw new Error('Model discovery must not execute work');}
  close(){}
}

async function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-models-api-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'models-api-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};
  initState(config);const controller=await createController(config,{client:new OfflineWorker() as any,startQueue:false,startBridge:false});
  const login=await controller.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});assert.equal(login.statusCode,200,login.body);
  const headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
  return {controller,config,headers,async close(){await controller.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('model dropdown API requires owner authentication and exposes only safe catalog metadata offline',async()=>{
  const f=await fixture();try{
    const models=[
      {slug:'fixture-coding-model',display_name:'Fixture Coding',description:'A local model fixture',visibility:'list',default_reasoning_level:'low',supported_reasoning_levels:[{effort:'low'},{effort:'high'}],base_instructions:'PRIVATE-RUNTIME-INSTRUCTIONS',private_provider_token:'PRIVATE-PROVIDER-TOKEN'},
      {slug:'fixture-hidden-model',display_name:'Internal fixture',visibility:'hide',supported_reasoning_levels:[{effort:'low'}]},
    ];
    writeFileSync(join(f.config.runtimeHome,'models_cache.json'),JSON.stringify({fetched_at:new Date().toISOString(),models}),{mode:0o600});
    assert.equal((await f.controller.app.inject({method:'GET',url:'/api/worker-models'})).statusCode,401);
    const response=await f.controller.app.inject({method:'GET',url:'/api/worker-models',headers:f.headers});assert.equal(response.statusCode,200,response.body);assert.match(response.headers['cache-control']??'',/no-store/);
    const catalog=response.json();assert.equal(catalog.source,'cache');assert.equal(catalog.models.length,1);assert.equal(catalog.models[0].id,'fixture-coding-model');assert.equal(catalog.models[0].name,'Fixture Coding');assert.deepEqual(catalog.models[0].supportedEfforts,['low','high']);
    assert.equal(response.body.includes('PRIVATE-'),false);assert.equal(response.body.includes('fixture-hidden-model'),false);assert.equal(response.body.includes('base_instructions'),false);
    assert.equal(f.controller.store.runs().length,0);assert.equal(f.controller.store.db.prepare('SELECT count(*) AS n FROM workers').get()?.n,0);
  }finally{await f.close();}
});

test('model dropdown API reports cold-start guidance when no worker catalog is available',async()=>{
  const f=await fixture();try{
    const response=await f.controller.app.inject({method:'GET',url:'/api/worker-models',headers:f.headers});assert.equal(response.statusCode,200,response.body);assert.deepEqual(response.json().models,[]);assert.equal(response.json().source,'unavailable');assert.match(response.json().detail,/start|worker|catalog/i);assert.equal(f.controller.store.runs().length,0);
  }finally{await f.close();}
});
