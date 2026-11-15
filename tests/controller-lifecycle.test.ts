import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { connect } from 'node:net';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createController } from '../src/controller.ts';
import { initState, type Config } from '../src/config.ts';

function configuration(stateDir:string):Config {
  const config:Config={stateDir,runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'lifecycle-test-password-only',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);return config;
}

test('controller shutdown closes idle bridge clients and is idempotent',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-controller-close-')),config=configuration(stateDir);
  const controller=await createController(config,{startQueue:false});
  const socket=connect(config.bridgeSocket);await once(socket,'connect');
  let timer:NodeJS.Timeout|undefined;
  const closing=controller.close();
  try{
    assert.equal(controller.close(),closing);
    await Promise.race([closing,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Idle bridge client blocked shutdown')),2000);})]);
    assert.equal(existsSync(config.bridgeSocket),false);
    assert.equal(controller.store.listenerCount('event'),0);
  }finally{if(timer)clearTimeout(timer);socket.destroy();await closing;rmSync(stateDir,{recursive:true,force:true});}
});

test('a controller without a bridge does not remove another controllers socket',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-bridge-owner-')),config=configuration(stateDir);
  const owner=await createController(config,{startQueue:false});
  try{
    const observer=await createController(config,{startQueue:false,startBridge:false});
    await observer.close();
    assert.equal(existsSync(config.bridgeSocket),true);
  }finally{await owner.close();rmSync(stateDir,{recursive:true,force:true});}
});

test('HTTP errors redact configured secrets at the transport boundary',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-http-redact-')),config=configuration(stateDir);
  const controller=await createController(config,{startQueue:false,startBridge:false});
  try{
    const login=await controller.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
    controller.brain.memoryWrite=()=>{throw new Error(`Failure included ${config.ipcToken} and ${config.adminPassword}`);};
    const response=await controller.app.inject({method:'POST',url:'/api/memory',headers:{cookie:String(login.headers['set-cookie']).split(';')[0],origin:config.origins[0],'x-csrf-token':login.json().csrfToken},payload:{}});
    assert.equal(response.statusCode,400);
    assert(!response.body.includes(config.ipcToken));assert(!response.body.includes(config.adminPassword));
    assert.match(response.json().error,/\[REDACTED\]/);
  }finally{await controller.close();rmSync(stateDir,{recursive:true,force:true});}
});

test('a large SSE catch-up closes at backpressure and remains resumable without blocking HTTP',{timeout:15_000},async()=>{
  // A child timeout also detects synchronous replay loops that would block this test runner.
  const stateDir=mkdtempSync(join(tmpdir(),'operator-sse-cap-')),config=configuration(stateDir);
  const script=`
    import assert from 'node:assert/strict';
    import { createController } from './src/controller.ts';
    const config=JSON.parse(process.argv[1]);
    const controller=await createController(config,{startQueue:false,startBridge:false});
    try{
      controller.store.transaction(()=>{for(let index=0;index<3500;index++)controller.store.addEvent('fixture',{text:'x'.repeat(1200)});});
      const login=await controller.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
      const cookie=String(login.headers['set-cookie']).split(';')[0];
      const base=await controller.app.listen({host:'127.0.0.1',port:0});
      const response=await fetch(base+'/api/events?after=0',{headers:{cookie}});
      assert.equal(response.status,200);
      const text=await response.text();
      const ids=[...text.matchAll(/^id: (\\d+)$/gm)].map(match=>Number(match[1]));
      assert(ids.length>0&&ids.length<3500,'Replay should end at the stream buffer limit');
      assert.equal(controller.store.listenerCount('event'),0);
      const next=await fetch(base+'/api/events?after='+ids.at(-1),{headers:{cookie}});
      const resumed=await next.text();
      assert(resumed.includes('id: '+(ids.at(-1)+1)+'\\n'),'Reconnect should resume at the next durable event');
      assert.equal((await fetch(base+'/api/session')).status,200);
      console.log('Replay bounded and resumable');
    }finally{await controller.close();}
  `;
  try{
    const result=await new Promise<{code:number|null;output:string}>((resolve,reject)=>{
      const child=spawn(process.execPath,['--import','tsx','--input-type=module','-e',script,JSON.stringify(config)],{cwd:process.cwd(),stdio:['ignore','pipe','pipe']});
      let output='';const timer=setTimeout(()=>{child.kill('SIGKILL');reject(new Error('Large SSE replay blocked the controller'));},10_000);
      child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{output+=chunk;});
      child.once('error',error=>{clearTimeout(timer);reject(error);});
      child.once('close',code=>{clearTimeout(timer);resolve({code,output});});
    });
    assert.equal(result.code,0,result.output);assert.match(result.output,/Replay bounded and resumable/);
  }finally{rmSync(stateDir,{recursive:true,force:true});}
});
