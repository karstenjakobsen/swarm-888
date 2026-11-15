import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import net from 'node:net';
import readline from 'node:readline';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Brain } from '../src/brain/index.js';
import { bridgeRequest, handleMcpMessage } from '../src/mcp.js';

test('MCP initialization, supported methods and tool errors use standard protocol results',async()=>{
  const init:any=await handleMcpMessage({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}});
  assert.equal(init.result.protocolVersion,'2025-06-18');assert.ok(init.result.capabilities.tools);
  assert.equal(await handleMcpMessage({jsonrpc:'2.0',method:'notifications/initialized'}),undefined);
  const failed:any=await handleMcpMessage({id:2,method:'tools/call',params:{name:'memory_get',arguments:{id:'missing'}}},async()=>{throw new Error('Memory not found');});
  assert.equal(failed.result.isError,true);assert.equal(failed.result.content[0].text,'Memory not found');
  const unknown:any=await handleMcpMessage({id:3,method:'invented/method'});assert.equal(unknown.error.code,-32601);
});

test('real stdio MCP child calls durable memory through an authenticated Unix bridge',async()=>{
  const state=mkdtempSync(path.join(tmpdir(),'operator-mcp-')),socketPath=path.join(state,'bridge.sock'),token='test-secret-credential';
  const db=new DatabaseSync(path.join(state,'brain.sqlite'));db.exec('PRAGMA foreign_keys=ON;PRAGMA journal_mode=WAL;');
  const brain=new Brain(db,state);await brain.initialize();
  const server=net.createServer(socket=>{
    let buffer='';socket.on('data',chunk=>{
      buffer+=chunk.toString();const end=buffer.indexOf('\n');if(end<0)return;
      const input=JSON.parse(buffer.slice(0,end));buffer=buffer.slice(end+1);
      void(async()=>{
        try{
          if(input.token!==token)throw new Error('Unauthorized bridge');
          const result=input.method==='tools/list'?brain.listTools():await brain.callTool(input.params.name,input.params.arguments,{runId:input.params.runId});
          socket.end(JSON.stringify({id:input.id,result})+'\n');
        }catch(error){socket.end(JSON.stringify({id:input.id,error:(error as Error).message})+'\n');}
      })();
    });
  });
  await new Promise<void>(resolve=>server.listen(socketPath,resolve));chmodSync(socketPath,0o600);
  const child=spawn(process.execPath,['--import','tsx','src/mcp.ts'],{cwd:path.resolve('.'),env:{...process.env,APP_STATE_DIR:state,APP_BRIDGE_SOCKET:socketPath,APP_BRIDGE_TOKEN:token},stdio:['pipe','pipe','pipe']});
  let stderr='';child.stderr.on('data',chunk=>stderr+=chunk.toString());
  const responses=new Map<number,(value:any)=>void>();readline.createInterface({input:child.stdout}).on('line',line=>{const result=JSON.parse(line);responses.get(result.id)?.(result);});
  const request=(id:number,method:string,params:unknown={})=>new Promise<any>((resolve,reject)=>{
    const timer=setTimeout(()=>reject(new Error(`No MCP response for ${method}; ${stderr}`)),10_000);responses.set(id,result=>{clearTimeout(timer);responses.delete(id);resolve(result);});
    child.stdin.write(JSON.stringify({jsonrpc:'2.0',id,method,params})+'\n');
  });
  try{
    assert.equal((await request(1,'initialize',{protocolVersion:'2025-03-26'})).result.serverInfo.name,'vps-operator');
    const tools=await request(2,'tools/list');assert.ok(tools.result.tools.some((tool:any)=>tool.name==='skill_publish'));
    const write=await request(3,'tools/call',{name:'memory_write',arguments:{content:'mcpunique durable fact',kind:'user_fact',source:'MCP integration fixture'}});
    assert.ok(!write.result.isError);const stored=JSON.parse(write.result.content[0].text);assert.equal(brain.memoryGet(stored.id).source,'MCP integration fixture');
    const search=await request(4,'tools/call',{name:'memory_search',arguments:{query:'mcpunique'}});assert.equal(JSON.parse(search.result.content[0].text)[0].id,stored.id);
    await assert.rejects(bridgeRequest('tools/list',{}, {socketPath,token:'wrong'}),/Unauthorized bridge/);
    assert.ok(!stderr.includes(token));
  }finally{
    child.kill();await new Promise<void>(resolve=>server.close(()=>resolve()));db.close();rmSync(state,{recursive:true,force:true});
  }
});
