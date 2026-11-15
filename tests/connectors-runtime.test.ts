import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, type Config } from '../src/config.ts';
import { callConnector, testConnector } from '../src/connectors/client.ts';
import { connectorInput, connectorServerName, connectorSnapshotSchema, connectorTransportSchema, type ConnectorSnapshot } from '../src/connectors/schemas.ts';
import { connectorConfiguration, CodexAdapter } from '../src/runtime/codex.ts';
import { groupMembers } from '../src/runtime/processes.ts';
import { WorkerServer } from '../src/worker.ts';
import { WorkerClient } from '../src/ipc.ts';
import { EventEmitter } from 'node:events';
import { managedManifestSchema } from '../src/managed/schemas.ts';

const id='11111111-1111-4111-8111-111111111111';
const tool={name:'echo',description:'Echo fixture text',inputSchema:{type:'object',properties:{text:{type:'string'}}}};
const serverSource=`
  const readline=require('node:readline');
  const send=value=>process.stdout.write(JSON.stringify({jsonrpc:'2.0',...value})+'\\n');
  readline.createInterface({input:process.stdin}).on('line',line=>{
    const request=JSON.parse(line);if(request.id===undefined)return;
    const result=request.method==='initialize'?{protocolVersion:request.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:
      request.method==='tools/list'?{tools:[{name:request.params.cursor?'second':'echo',inputSchema:{type:'object'}}],...(request.params.cursor?{}:{nextCursor:'page2'})}:
      {content:[{type:'text',text:request.params.arguments.text}],structuredContent:{admin:process.env.ADMIN_PASSWORD??null,modelKey:process.env.OPENAI_API_KEY??null,bridge:process.env.APP_BRIDGE_TOKEN??null}};
    send({id:request.id,result});
  });
`;
function local(source=serverSource):ConnectorSnapshot {return {id,name:'Local fixture',transport:'stdio',command:process.execPath,args:['-e',source]};}
const config={} as Config;

test('stdio connector initializes, follows tool pagination, calls tools, and withholds controller/model credentials',async()=>{
  const previous=process.env;
  try{
    process.env={...previous,ADMIN_PASSWORD:'private-fixture',OPENAI_API_KEY:'private-model-fixture'};
    assert.deepEqual((await testConnector(config,local())).tools.map(value=>value.name),['echo','second']);
    const result=await callConnector(config,local(),'echo',{text:'hello fixture'});
    assert.equal(result.content[0].text,'hello fixture');assert.deepEqual(result.structuredContent,{admin:null,modelKey:null,bridge:null});
  }finally{process.env=previous;}
});

test('a timed-out stdio connector terminates its entire owned process group',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-connector-timeout-')),pidPath=join(directory,'pid');
  const source=`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);`;
  try{
    await assert.rejects(testConnector(config,local(source),{timeoutMs:1000}),/timed out/);
    const pid=Number(readFileSync(pidPath,'utf8'));assert.deepEqual(groupMembers(pid),[]);
  }finally{rmSync(directory,{recursive:true,force:true});}
});

test('stdio connector rejects malformed messages, repeated cursors, and oversized output predictably',async()=>{
  await assert.rejects(testConnector(config,local(`console.log('not-json');setInterval(()=>{},1000);`)),/invalid MCP/);
  const repeated=serverSource.replace("...(request.params.cursor?{}:{nextCursor:'page2'})","nextCursor:'page2'");
  await assert.rejects(testConnector(config,local(repeated)),/pagination cursor/);
  await assert.rejects(testConnector(config,local(`process.stdout.write('x'.repeat(2*1024*1024+1));setInterval(()=>{},1000);`)),/exceeded 2 MiB/);
});

async function listen(server:Server):Promise<string> {await new Promise<void>(ok=>server.listen(0,'127.0.0.1',ok));return `http://127.0.0.1:${(server.address() as {port:number}).port}/mcp`;}
async function close(server:Server):Promise<void> {server.closeAllConnections();await new Promise<void>(ok=>server.close(()=>ok()));}

test('Streamable HTTP supports JSON/SSE, negotiated session headers, pagination, tool errors and session cleanup',async()=>{
  const methods:string[]=[];let initialized=false;
  const server=createServer((request,response)=>{
    if(request.method==='DELETE'){assert.equal(request.headers['mcp-session-id'],'fixture-session');methods.push('DELETE');response.end();return;}
    let body='';request.on('data',chunk=>{body+=chunk;});request.on('end',()=>{
      const input=JSON.parse(body);methods.push(input.method??'response');
      assert.match(String(request.headers.accept),/application\/json.*text\/event-stream/);
      assert.equal(request.headers['mcp-protocol-version'],'2025-06-18');
      if(input.method==='initialize'){
        response.setHeader('Mcp-Session-Id','fixture-session');response.setHeader('content-type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{protocolVersion:'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}}));return;
      }
      assert.equal(request.headers['mcp-session-id'],'fixture-session');
      if(input.method==='notifications/initialized'){initialized=true;response.statusCode=202;response.end();return;}
      assert(initialized);
      if(input.method==='tools/list'){
        response.setHeader('content-type','text/event-stream');response.end(`: fixture comment\n\ndata: ${JSON.stringify({jsonrpc:'2.0',method:'notifications/tools/list_changed'})}\n\ndata: ${JSON.stringify({jsonrpc:'2.0',id:input.id,result:{tools:[tool],...(input.params.cursor?{}:{nextCursor:'second'})}})}\n\n`);return;
      }
      response.setHeader('content-type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:input.id,result:{content:[{type:'text',text:'Fixture tool failed'}],isError:true}}));
    });
  });
  const url=await listen(server),connector={id,name:'HTTP fixture',transport:'http',url};
  try{
    assert.equal((await testConnector(config,connector)).tools.length,2);
    assert.equal((await callConnector(config,connector,'echo',{})).isError,true);
    assert.equal(methods.filter(method=>method==='DELETE').length,2);
  }finally{await close(server);}
});

test('HTTP connector rejects non-success responses and aborts a hanging response',async()=>{
  let hang=false;const server=createServer((_request,response)=>{if(!hang){response.statusCode=401;response.end('requires authentication');}}),url=await listen(server);
  try{
    const connector={id,name:'Unauthenticated fixture',transport:'http',url};
    await assert.rejects(testConnector(config,connector),/401/);hang=true;
    await assert.rejects(testConnector(config,connector,{timeoutMs:100}),/timed out/);
  }finally{await close(server);}
});

test('unauthenticated connector snapshots reject credentials embedded in HTTP URLs',()=>{
  for(const url of ['https://user:password@example.test/mcp','https://example.test/mcp?token=secret','https://example.test/mcp#secret'])assert.equal(connectorSnapshotSchema.safeParse({id,name:'Fixture',transport:'http',url}).success,false);
});

test('connector transport constraints stay identical across registrations, manifests and task snapshots',()=>{
  for(const transport of [{transport:'stdio',command:'node',args:['']},{transport:'http',url:'http://127.0.0.1/mcp'}]){
    assert(connectorTransportSchema.safeParse(transport).success);assert(connectorInput.safeParse({name:'Fixture',...transport}).success);assert(connectorSnapshotSchema.safeParse({id,name:'Fixture',...transport}).success);assert(managedManifestSchema.safeParse({schemaVersion:1,id,kind:'connector',name:'Fixture',mcp:transport}).success);
  }
  for(const transport of [{transport:'stdio',command:'x'.repeat(2001),args:[]},{transport:'stdio',command:'node',args:['bad\0value']},{transport:'http',url:'https://example.test/mcp?token=value'}]){
    assert(!connectorTransportSchema.safeParse(transport).success);assert(!connectorInput.safeParse({name:'Fixture',...transport}).success);assert(!connectorSnapshotSchema.safeParse({id,name:'Fixture',...transport}).success);assert(!managedManifestSchema.safeParse({schemaVersion:1,id,kind:'connector',name:'Fixture',mcp:transport}).success);
  }
});

test('an already cancelled connector operation never starts its subprocess',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-connector-aborted-')),path=join(directory,'side-effect'),controller=new AbortController();controller.abort();
  try{await assert.rejects(testConnector(config,local(`require('node:fs').writeFileSync(${JSON.stringify(path)},'started')`),{signal:controller.signal}),/interrupted/);assert.equal(existsSync(path),false);}finally{rmSync(directory,{recursive:true,force:true});}
});

test('opaque empty pagination cursors are followed rather than mistaken for the end of discovery',async()=>{
  const source=serverSource.replace("request.params.cursor?'second':'echo'","request.params.cursor!==undefined?'second':'echo'").replace("...(request.params.cursor?{}:{nextCursor:'page2'})","...(request.params.cursor!==undefined?{}:{nextCursor:''})");
  assert.deepEqual((await testConnector(config,local(source))).tools.map(value=>value.name),['echo','second']);
});

test('oversized outgoing tool arguments are rejected before invoking the connector tool',async()=>{
  await assert.rejects(callConnector(config,local(),'echo',{text:'x'.repeat(2*1024*1024)}),/request exceeded 2 MiB/);
});

test('worker passes immutable connector snapshots before startup and aborts owned connector processes during shutdown',async()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-connectors-worker-'));
  const config:Config={stateDir:directory,projectsDir:join(directory,'projects'),socketPath:join(directory,'worker.sock'),bridgeSocket:join(directory,'bridge.sock'),runtimeHome:join(directory,'runtime'),controllerUid:process.getuid!(),ipcToken:'',codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'fixture-only',secureCookie:false,improvementEnabled:false,improvementMaxTurns:1,improvementTimeoutMs:1000,allowTempState:true};initState(config);
  let received:ConnectorSnapshot[]|undefined;
  class Adapter extends EventEmitter {
    version='fixture';async start(){}async health(){return {authenticated:true,detail:'Fixture only'};}async close(){}
    async run(){setImmediate(()=>this.emit('event','completed',{status:'completed'}));}
  }
  const worker=new WorkerServer(config,(_config,runId,connectors)=>{if(runId)received=connectors;return new Adapter() as any;}),client=new WorkerClient(config),pidPath=join(directory,'connector.pid');let closed=false;
  try{
    await worker.listen();await client.connect();
    const completed=new Promise<void>(ok=>client.on('event',event=>{if(event.runId==='with_connector'&&event.type==='completed')ok();}));
    await client.request('submit',{runId:'with_connector',conversationId:'fixture',prompt:'fixture',bootstrap:'',cwd:join(directory,'workspaces','fixture'),skills:[],connectors:[local()]});await completed;
    assert.deepEqual(received,[local()]);
    const pending=client.request('connectors/test',{connector:local(`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));setInterval(()=>{},1000);`)}).then(()=>null,error=>error);
    for(let attempt=0;attempt<200&&!existsSync(pidPath);attempt++)await new Promise(ok=>setTimeout(ok,10));
    assert(existsSync(pidPath));await assert.rejects(client.request('worker/reserve-root-replacement',{}),/runtime operations/);
    closed=true;const closing=worker.close();assert.equal(worker.close(),closing);await closing;await worker.close();assert.match(String(await pending),/interrupted|disconnected/);assert.deepEqual(groupMembers(Number(readFileSync(pidPath,'utf8'))),[]);
  }finally{client.close();if(!closed)await worker.close();rmSync(directory,{recursive:true,force:true});}
});

test('task connector configuration uses stable unique namespaces and the installed app-server accepts it', {timeout:30_000},async()=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-connector-codex-')),connector=local();
  const args=connectorConfiguration([connector]);assert(args.some(value=>value.startsWith(`mcp_servers.${connectorServerName(connector)}.command=`)));
  assert.throws(()=>connectorConfiguration([connector,connector]),/only once/);
  const adapter=new CodexAdapter({stateDir:directory,runtimeHome:join(directory,'runtime'),bridgeSocket:join(directory,'bridge.sock'),ipcToken:'a'.repeat(64),codexBin:join(process.cwd(),'node_modules/.bin/codex')} as Config,'fixture-run',[connector]);
  const previous=process.env;
  try{
    process.env={...previous,OPENAI_API_KEY:'fixture-model-key'};
    await adapter.start();const thread=await adapter.request('thread/start',{cwd:directory,approvalPolicy:'never',sandbox:'danger-full-access'});
    const status=await adapter.request('mcpServerStatus/list',{threadId:thread.thread.id,serverName:connectorServerName(connector),detail:'toolsAndAuthOnly'});
    assert(JSON.stringify(status).includes('echo'),JSON.stringify(status));
    const result=await adapter.request('mcpServer/tool/call',{threadId:thread.thread.id,server:connectorServerName(connector),tool:'echo',arguments:{text:'via actual Codex'}});
    assert.equal(result.content[0].text,'via actual Codex');assert.deepEqual(result.structuredContent,{admin:null,modelKey:null,bridge:null});
  }finally{process.env=previous;const closing=adapter.close();assert.equal(adapter.close(),closing);await closing;await adapter.close();rmSync(directory,{recursive:true,force:true});}
});
