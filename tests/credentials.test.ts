import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash,randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdirSync,mkdtempSync,readFileSync,rmSync,writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import type { Config } from '../src/config.ts';
import { initState } from '../src/config.ts';
import { createController } from '../src/controller.ts';
import { CredentialVault } from '../src/credentials/vault.ts';
import { resolveConnectorSecrets,resolveProjectSecrets } from '../src/credentials/runtime.ts';
import { connectorAuthSchema,projectEnvironmentSchema } from '../src/credentials/schemas.ts';
import { testConnector,callConnector } from '../src/connectors/client.ts';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { CodexAdapter,connectorConfiguration } from '../src/runtime/codex.ts';
import { connectorServerName,type ConnectorSnapshot } from '../src/connectors/schemas.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import type { WorkerClient } from '../src/ipc.ts';
import type { ProjectService } from '../src/projects/service.ts';
import type { ManagedService } from '../src/managed/service.ts';

function fixture(){const stateDir=mkdtempSync(join(tmpdir(),'operator-credentials-'));mkdirSync(join(stateDir,'secrets'));const store=new Store(stateDir);store.db.exec(readFileSync(new URL('../migrations/007-credentials.sql',import.meta.url),'utf8'));return {stateDir,store,vault:new CredentialVault(stateDir,store.db),config:{stateDir}as Config,close(){store.close();rmSync(stateDir,{recursive:true,force:true});}};}

test('credential storage is encrypted, write-only, redacted and granted to exact connections',()=>{
  const f=fixture();try{
    const token='fixture-private-provider-token',credential=f.vault.create({name:'Provider',values:{token}}),id=randomUUID();
    assert.throws(()=>f.vault.create({name:'Short value',values:{token:'a'}}),/at least 8 characters/);
    assert.equal(JSON.stringify(credential).includes(token),false);assert.equal(JSON.stringify(f.vault.list()).includes(token),false);assert.equal(readFileSync(join(f.stateDir,'secrets','credentials',`${credential.id}.json`),'utf8').includes(token),false);
    assert.equal(JSON.stringify(f.store.db.prepare('SELECT * FROM credentials').all()).includes(token),false);
    const auth={type:'bearer' as const,credentialId:credential.id,field:'token'};assert.equal(f.vault.readiness(auth,id).ready,false);f.vault.grant(credential.id,id);
    assert.equal(resolveConnectorSecrets(f.config,{id,transport:'http',auth}).headers.Authorization,`Bearer ${token}`);assert.throws(()=>resolveConnectorSecrets(f.config,{id:randomUUID(),transport:'http',auth}),/granted/);
    assert.throws(()=>f.vault.assertSafe({files:{'source.ts':token}}),/Credential values/);assert.equal(JSON.stringify(f.vault.redact({[token]:token})).includes(token),false);
    assert.equal(connectorAuthSchema.safeParse({type:'env',credentialId:credential.id,bindings:{NODE_OPTIONS:'token'}}).success,false);
    f.vault.update(credential.id,{values:{token:'fixture-private-provider-token-two'}});assert.equal(JSON.stringify(f.vault.redact(token)).includes(token),false,'Old tokens remain redacted after rotation');
  }finally{f.close();}
});

test('selected stdio environment credentials reach only the provider child and echoed values are redacted',async()=>{
  const f=fixture(),previous=process.env.UNRELATED_SECRET;process.env.UNRELATED_SECRET='fixture-secret-not-selected';
  try{
    const token='fixture-selected-stdio-token',id=randomUUID(),credential=f.vault.create({name:'Stdio',values:{token}});f.vault.grant(credential.id,id);
    const path=join(f.stateDir,'server.mjs');writeFileSync(path,`import {createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:process.env.PROVIDER_TOKEN,inputSchema:{type:'object'}}]}:{content:[{type:'text',text:JSON.stringify({selected:process.env.PROVIDER_TOKEN,unrelated:process.env.UNRELATED_SECRET})}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));});`);
    const connector={id,name:'Credential fixture',transport:'stdio',command:process.execPath,args:[path],auth:{type:'env',credentialId:credential.id,bindings:{PROVIDER_TOKEN:'token'}}};
    const discovered=await testConnector(f.config,connector);assert.equal(discovered.tools[0].description,'[REDACTED]');const result=await callConnector(f.config,connector,'echo');const text=JSON.stringify(result);assert.equal(text.includes(token),false);assert.equal(text.includes('fixture-secret-not-selected'),false);assert(text.includes('[REDACTED]'));
  }finally{if(previous===undefined)delete process.env.UNRELATED_SECRET;else process.env.UNRELATED_SECRET=previous;f.close();}
});

test('deployed project credentials require separate exact grants and expose only selected environment values',()=>{
  const f=fixture();try{
    const projectId=randomUUID(),other=randomUUID(),token='fixture-project-private-token',credential=f.vault.create({name:'Project deployment',values:{token,unused:'fixture-unused-project-secret'}}),environment={credentialId:credential.id,bindings:{PROVIDER_TOKEN:'token'}};
    f.vault.grant(credential.id,projectId);assert.equal(f.vault.projectReadiness(environment,projectId).ready,false);assert.throws(()=>resolveProjectSecrets(f.config,projectId,environment),/granted to this project/,'A connection grant must not authorize a project with the same UUID');
    f.vault.grantProject(credential.id,projectId);assert.equal(f.vault.projectReadiness(environment,projectId).ready,true);
    const resolved=resolveProjectSecrets(f.config,projectId,environment);assert.deepEqual({...resolved.env},{PROVIDER_TOKEN:token});assert.equal(JSON.stringify(resolved.env).includes('fixture-unused-project-secret'),false);assert.equal(resolved.redact({token,unused:'fixture-unused-project-secret'}).token,'[REDACTED]');assert.throws(()=>resolveProjectSecrets(f.config,other,environment),/granted/);
    assert.equal(projectEnvironmentSchema.safeParse({credentialId:credential.id,bindings:{NODE_OPTIONS:'token'}}).success,false);assert.equal(projectEnvironmentSchema.safeParse({credentialId:credential.id,bindings:{LD_PRELOAD:'token'}}).success,false);
    const previous=resolved.materialRevision;f.vault.update(credential.id,{values:{token:'fixture-updated-project-token'}});assert(resolveProjectSecrets(f.config,projectId,environment).materialRevision>previous);assert.equal(f.vault.projectReadiness(environment,projectId).ready,true);
    f.vault.revokeProject(credential.id,projectId);assert.equal(f.vault.projectReadiness(environment,projectId).ready,false);assert.throws(()=>resolveProjectSecrets(f.config,projectId,environment),/granted/);assert.equal(f.vault.readiness({type:'bearer',credentialId:credential.id},projectId).ready,true,'Revoking a project grant must retain its separate connection grant');
  }finally{f.close();}
});

test('OAuth PKCE is session-bound and one-use, refreshes once, and binds bearer credentials without leaking tokens',async()=>{
  const f=fixture();let expectedChallenge='',exchanges=0,refreshes=0;
  const server=createServer(async(request,response)=>{
    let text='';for await(const chunk of request)text+=chunk.toString();const input=new URLSearchParams(text);
    if(input.get('grant_type')==='authorization_code'){exchanges++;assert.equal(createHash('sha256').update(input.get('code_verifier')!).digest('base64url'),expectedChallenge);assert.equal(input.get('client_secret'),'fixture-oauth-client-secret');response.setHeader('content-type','application/json');response.end(JSON.stringify({access_token:'fixture-oauth-first-access',refresh_token:'fixture-oauth-refresh-token',token_type:'Bearer',expires_in:1}));}
    else{refreshes++;assert.equal(input.get('refresh_token'),'fixture-oauth-refresh-token');response.setHeader('content-type','application/json');response.end(JSON.stringify({access_token:'fixture-oauth-second-access',refresh_token:'fixture-oauth-refresh-rotated',token_type:'bearer',expires_in:3600}));}
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address()as{port:number}).port,connectorId=randomUUID(),session='f'.repeat(64);f.store.createSession(session,'csrf',Date.now()+600_000,Date.now());
    const start=await f.vault.startOAuth(connectorId,{authorizationUrl:`http://127.0.0.1:${port}/authorize`,tokenUrl:`http://127.0.0.1:${port}/token`,clientId:'fixture-client',clientSecret:'fixture-oauth-client-secret',tokenAuthMethod:'client_secret_post',scopes:['read']},session,'http://localhost:5173/api/credentials/oauth/callback');
    const authorize=new URL(start.authorizationUrl),state=authorize.searchParams.get('state')!;expectedChallenge=authorize.searchParams.get('code_challenge')!;assert.equal(authorize.searchParams.get('code_challenge_method'),'S256');
    await assert.rejects(f.vault.completeOAuth(state,'wrong-browser-cookie','fixture-code'),/browser session/);assert.equal(exchanges,0);
    await f.vault.completeOAuth(state,start.cookie,'fixture-code');await assert.rejects(f.vault.completeOAuth(state,start.cookie,'fixture-code'),/expired|session/);assert.equal(exchanges,1);
    await Promise.all([f.vault.refresh(start.credential.id),f.vault.refresh(start.credential.id)]);assert.equal(refreshes,1);
    const material=resolveConnectorSecrets(f.config,{id:connectorId,transport:'http',auth:{type:'oauth2',credentialId:start.credential.id}});assert.equal(material.headers.Authorization,'Bearer fixture-oauth-second-access');assert.equal(f.vault.get(start.credential.id).ready,true);
    assert.equal(JSON.stringify(f.vault.list()).includes('fixture-oauth-second-access'),false);assert.equal(JSON.stringify(f.vault.redact('fixture-oauth-first-access fixture-oauth-second-access fixture-oauth-client-secret')).includes('fixture-oauth'),false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('OAuth providers can use GET token exchange and configurable response fields for authorization and refresh',async()=>{
  const f=fixture();let exchanges=0,refreshes=0;
  const server=createServer(async(request,response)=>{
    assert.equal(request.method,'GET');let body='';for await(const chunk of request)body+=chunk.toString();assert.equal(body,'');
    const input=new URL(request.url!,'http://fixture.invalid').searchParams;assert.equal(input.get('client_id'),'fixture-camel-client');assert.equal(input.get('client_secret'),'fixture-camel-client-secret');
    if(input.get('grant_type')==='authorization_code'){exchanges++;assert.equal(input.get('code'),'fixture-camel-code');assert(input.get('code_verifier'));response.setHeader('content-type','application/json');response.end(JSON.stringify({accessToken:'fixture-camel-first-access',refreshToken:'fixture-camel-refresh-token',expiresIn:1}));}
    else{refreshes++;assert.equal(input.get('grant_type'),'refresh_token');assert.equal(input.get('refresh_token'),'fixture-camel-refresh-token');response.setHeader('content-type','application/json');response.end(JSON.stringify({accessToken:'fixture-camel-rotated-access',refreshToken:'fixture-camel-rotated-refresh',expiresIn:'3600'}));}
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address()as{port:number}).port,id=randomUUID(),session='b'.repeat(64);f.store.createSession(session,'csrf',Date.now()+600_000,Date.now());
    const start=await f.vault.startOAuth(id,{authorizationUrl:`http://127.0.0.1:${port}/authorize`,tokenUrl:`http://127.0.0.1:${port}/apps/token`,clientId:'fixture-camel-client',clientSecret:'fixture-camel-client-secret',tokenAuthMethod:'client_secret_post',tokenMethod:'GET',tokenFields:{accessToken:'accessToken',refreshToken:'refreshToken',expiresIn:'expiresIn'}},session,'http://localhost:5173/api/credentials/oauth/callback');
    const state=new URL(start.authorizationUrl).searchParams.get('state')!;assert.equal(start.authorizationUrl.includes('fixture-camel-client-secret'),false);await f.vault.completeOAuth(state,start.cookie,'fixture-camel-code');const revision=f.vault.get(start.credential.id).revision;
    await f.vault.refresh(start.credential.id);assert.equal(exchanges,1);assert.equal(refreshes,1);assert.equal(f.vault.get(start.credential.id).revision,revision);
    assert.equal(resolveConnectorSecrets(f.config,{id,transport:'http',auth:{type:'oauth2',credentialId:start.credential.id}}).headers.Authorization,'Bearer fixture-camel-rotated-access');
    const encrypted=readFileSync(join(f.stateDir,'secrets','credentials',`${start.credential.id}.json`),'utf8');assert.equal(encrypted.includes('fixture-camel-client-secret'),false);assert.equal(encrypted.includes('tokenFields'),false);assert.equal(JSON.stringify(f.vault.list()).includes('fixture-camel'),false);assert.equal(JSON.stringify(f.vault.redact('fixture-camel-client-secret fixture-camel-first-access fixture-camel-rotated-access')).includes('fixture-camel'),false);
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('HTTP auth is attached to the selected endpoint and echoed header values are scrubbed',async()=>{
  const f=fixture(),token='fixture-private-header-value';let requests=0;
  const server=createServer(async(request,response)=>{assert.equal(request.headers['x-provider-key'],token);requests++;let text='';for await(const chunk of request)text+=chunk.toString();const message=JSON.parse(text);if(message.id===undefined){response.writeHead(202).end();return;}const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'header-fixture',version:'1'}}:{content:[{type:'text',text:token}]};response.setHeader('content-type','application/json');response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const id=randomUUID(),credential=f.vault.create({name:'Header',values:{apiKey:token}});f.vault.grant(credential.id,id);const connector={id,name:'Header fixture',transport:'http',url:`http://127.0.0.1:${(server.address()as{port:number}).port}/mcp`,auth:{type:'headers',credentialId:credential.id,bindings:{'X-Provider-Key':'apiKey'}}};const result=await callConnector(f.config,connector,'echo');const content=result.content[0];assert(content&&'text'in content);assert.equal(content.text,'[REDACTED]');assert.equal(requests,3);
    await assert.rejects(callConnector(f.config,{...connector,id:randomUUID()},'echo'),/granted/);assert.equal(requests,3,'Unauthorized connection must not send any request');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('the native MCP credential facade returns sanitized results with only opaque references in its configuration',async()=>{
  const f=fixture(),token='fixture-native-facade-token';
  try{const id=randomUUID(),credential=f.vault.create({name:'Facade',values:{token}});f.vault.grant(credential.id,id);const provider=join(f.stateDir,'provider.mjs');writeFileSync(provider,`import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.PROVIDER_TOKEN}]};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));});`);
    const snapshot={id,name:'Native fixture',transport:'stdio',command:process.execPath,args:[provider],auth:{type:'env',credentialId:credential.id,bindings:{PROVIDER_TOKEN:'token'}}},configuration=JSON.stringify(snapshot);assert.equal(configuration.includes(token),false);
    const child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),new URL('../src/connectors/proxy.ts',import.meta.url).pathname],{env:{...process.env,APP_STATE_DIR:f.stateDir,OPERATOR_CONNECTOR_CONFIG:configuration},stdio:['pipe','pipe','pipe']});let output='',error='';child.stdout.on('data',value=>{output+=value;});child.stderr.on('data',value=>{error+=value;});
    child.stdin.end([{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-06-18'}},{jsonrpc:'2.0',id:2,method:'tools/list'},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'echo',arguments:{}}}].map(value=>JSON.stringify(value)).join('\n')+'\n');const [code]=await once(child,'exit');assert.equal(code,0,error);assert.equal(output.includes(token),false);const replies=output.trim().split('\n').map(value=>JSON.parse(value));assert.equal(replies[2].result.content[0].text,'[REDACTED]');
  }finally{f.close();}
});

test('cancelling an OAuth exchange prevents late token storage',async()=>{
  const f=fixture();let release!:()=>void,entered!:()=>void;const waiting=new Promise<void>(resolve=>{entered=resolve;}),gate=new Promise<void>(resolve=>{release=resolve;});
  const server=createServer(async(request,response)=>{for await(const _chunk of request){}entered();await gate;response.setHeader('content-type','application/json');response.end(JSON.stringify({access_token:'fixture-cancelled-access-token',token_type:'Bearer',expires_in:3600}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const port=(server.address()as{port:number}).port,connectorId=randomUUID(),session='e'.repeat(64);f.store.createSession(session,'csrf',Date.now()+600_000,Date.now());const start=await f.vault.startOAuth(connectorId,{authorizationUrl:`http://127.0.0.1:${port}/authorize`,tokenUrl:`http://127.0.0.1:${port}/token`,clientId:'fixture'},session,'http://localhost:5173/api/credentials/oauth/callback');const state=new URL(start.authorizationUrl).searchParams.get('state')!,completion=f.vault.completeOAuth(state,start.cookie,'fixture-code');await waiting;f.vault.cancelOAuth(connectorId);release();await assert.rejects(completion,/cancelled/);assert.equal(f.vault.get(start.credential.id).ready,false);
  }finally{release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('OAuth token completion and refresh preserve grants added while the provider is responding',async()=>{
  const f=fixture();let entered!:()=>void,release!:()=>void,gate:Promise<void>,waiting:Promise<void>;
  const pause=()=>{waiting=new Promise<void>(resolve=>{entered=resolve;});gate=new Promise<void>(resolve=>{release=resolve;});};pause();let calls=0;
  const server=createServer(async(request,response)=>{for await(const _chunk of request){}entered();await gate;calls++;response.setHeader('content-type','application/json');response.end(JSON.stringify({access_token:`fixture-grant-race-access-${calls}`,refresh_token:'fixture-grant-race-refresh',token_type:'Bearer',expires_in:calls===1?1:3600}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address()as{port:number}).port,id=randomUUID(),second=randomUUID(),third=randomUUID(),session='d'.repeat(64);f.store.createSession(session,'csrf',Date.now()+600_000,Date.now());
    const start=await f.vault.startOAuth(id,{authorizationUrl:`http://127.0.0.1:${port}/authorize`,tokenUrl:`http://127.0.0.1:${port}/token`,clientId:'fixture'},session,'http://localhost:5173/api/credentials/oauth/callback'),auth={type:'oauth2' as const,credentialId:start.credential.id};
    const completion=f.vault.completeOAuth(new URL(start.authorizationUrl).searchParams.get('state')!,start.cookie,'fixture-code');await waiting!;f.vault.grant(start.credential.id,second);release();await completion;assert.equal(f.vault.readiness(auth,second).ready,true);
    pause();const refresh=f.vault.refresh(start.credential.id);await waiting!;f.vault.grant(start.credential.id,third);release();await refresh;
    for(const connectorId of [id,second,third])assert.equal(f.vault.readiness(auth,connectorId).ready,true,'A completed refresh must retain each owner grant');
  }finally{release();server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('automatic OAuth token refresh preserves tested connection configuration and scheduled-task readiness',async()=>{
  const f=fixture();let refreshed=0,rejectRefresh=false;
  const server=createServer(async(request,response)=>{
    let text='';for await(const chunk of request)text+=chunk.toString();response.setHeader('content-type','application/json');
    if(request.url==='/token'){const input=new URLSearchParams(text),refresh=input.get('grant_type')==='refresh_token';if(refresh)refreshed++;if(refresh&&rejectRefresh){response.writeHead(400).end(JSON.stringify({error:'invalid_grant'}));return;}response.end(JSON.stringify({access_token:refresh?'fixture-rotated-ready-token':'fixture-initial-ready-token',refresh_token:'fixture-ready-refresh-token',token_type:'Bearer',expires_in:3600}));return;}
    const message=JSON.parse(text);assert.equal(request.headers.authorization,`Bearer ${refreshed?'fixture-rotated-ready-token':'fixture-initial-ready-token'}`);
    if(message.id===undefined){response.writeHead(202).end();return;}
    const result=message.method==='initialize'?{protocolVersion:message.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'oauth-ready',version:'1'}}:message.method==='tools/list'?{tools:[{name:'echo',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:'fixture-rotated-ready-token'}]};response.end(JSON.stringify({jsonrpc:'2.0',id:message.id,result}));
  });await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const port=(server.address()as{port:number}).port,session='c'.repeat(64);f.store.createSession(session,'csrf',Date.now()+600_000,Date.now());
    const client={connect:async()=>({runtimeOperations:[]}),request:async(method:string,input:any)=>{if(method==='connectors/test')return testConnector(f.config,input.connector);if(method==='connectors/call')return callConnector(f.config,input.connector,input.name,input.arguments);throw new Error(`Unexpected fixture method ${method}`);}} as unknown as WorkerClient;
    const connectors=new ConnectorService(f.store,client,{}as ProjectService,{}as ManagedService,undefined,f.vault),connector=connectors.create({name:'OAuth readiness',transport:'http',url:`http://127.0.0.1:${port}/mcp`});
    const start=await f.vault.startOAuth(connector.id,{authorizationUrl:`http://127.0.0.1:${port}/authorize`,tokenUrl:`http://127.0.0.1:${port}/token`,clientId:'fixture'},session,'http://localhost:5173/api/credentials/oauth/callback');
    connectors.setAuth(connector.id,{type:'oauth2',credentialId:start.credential.id});await f.vault.completeOAuth(new URL(start.authorizationUrl).searchParams.get('state')!,start.cookie,'fixture-code');
    await connectors.test(connector.id);const revision=f.vault.get(start.credential.id).revision;assert.equal(connectors.get(connector.id).status,'connected');
    f.store.db.prepare('UPDATE credentials SET expiresAt=? WHERE id=?').run(new Date(Date.now()+30_000).toISOString(),start.credential.id);
    const snapshots=await connectors.snapshots(f.store.newConversation('Scheduled readiness').id,[connector.id]);assert.equal(refreshed,1);assert.equal(f.vault.get(start.credential.id).revision,revision,'Automatic material rotation must not change the owner configuration revision');assert.equal(snapshots[0]?.credentialRevision,revision);
    assert.equal(connectors.get(connector.id).status,'connected');assert.deepEqual(connectors.readiness([connector.id]),{ready:true});
    const result=await connectors.call(connector.id,{name:'echo'});const content=result.content[0];assert(content&&'text'in content);assert.equal(content.text,'[REDACTED]');
    connectors.setAuth(connector.id,{type:'oauth2',credentialId:start.credential.id});assert.equal(connectors.get(connector.id).status,'untested','Owner binding changes still require a fresh test');assert.equal(connectors.readiness([connector.id]).ready,false);
    const projectId=randomUUID(),environment={credentialId:start.credential.id,bindings:{ACCESS_TOKEN:'access_token'}};f.vault.grantProject(start.credential.id,projectId);rejectRefresh=true;f.store.db.prepare('UPDATE credentials SET expiresAt=? WHERE id=?').run(new Date(Date.now()+30_000).toISOString(),start.credential.id);await assert.rejects(f.vault.refresh(start.credential.id),/reconnecting/);
    assert.equal(f.vault.projectReadiness(environment,projectId).ready,false);assert.throws(()=>resolveProjectSecrets(f.config,projectId,environment),/authorization/);assert.throws(()=>resolveConnectorSecrets(f.config,snapshots[0]!),/authorization/,'A failed refresh must also fence already-issued native snapshots');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));f.close();}
});

test('the pinned app-server discovers and calls a credential-bound native MCP connection without exposing its token', {timeout:30_000},async()=>{
  const f=fixture(),token='fixture-pinned-codex-provider-token';let adapter:CodexAdapter|undefined;const previous=process.env;
  try{const id=randomUUID(),credential=f.vault.create({name:'Codex facade',values:{token}});f.vault.grant(credential.id,id);const provider=join(f.stateDir,'codex-provider.mjs');writeFileSync(provider,`import{createInterface}from'node:readline';createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(m.id===undefined)return;const result=m.method==='initialize'?{protocolVersion:m.params.protocolVersion,capabilities:{tools:{}},serverInfo:{name:'fixture',version:'1'}}:m.method==='tools/list'?{tools:[{name:'echo',description:'Credential fixture',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:process.env.PROVIDER_TOKEN}],structuredContent:{modelKey:process.env.OPENAI_API_KEY??null,bridge:process.env.APP_BRIDGE_TOKEN??null}};process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+String.fromCharCode(10));});`);
    const connector:ConnectorSnapshot={id,name:'Pinned credential fixture',transport:'stdio',command:process.execPath,args:[provider],auth:{type:'env',credentialId:credential.id,bindings:{PROVIDER_TOKEN:'token'}}};assert.equal(JSON.stringify(connectorConfiguration([connector],f.config)).includes(token),false);
    process.env={...previous,OPENAI_API_KEY:'fixture-model-key'};adapter=new CodexAdapter({...f.config,runtimeHome:join(f.stateDir,'runtime'),bridgeSocket:join(f.stateDir,'bridge.sock'),ipcToken:'b'.repeat(64),codexBin:join(process.cwd(),'node_modules/.bin/codex')},'credential-fixture',[connector]);
    await adapter.start();const thread=await adapter.request('thread/start',{cwd:f.stateDir,approvalPolicy:'never',sandbox:'danger-full-access'});const status=await adapter.request('mcpServerStatus/list',{threadId:thread.thread.id,serverName:connectorServerName(connector),detail:'toolsAndAuthOnly'});assert(JSON.stringify(status).includes('echo'),JSON.stringify(status));assert.equal(JSON.stringify(status).includes(token),false);
    const result=await adapter.request('mcpServer/tool/call',{threadId:thread.thread.id,server:connectorServerName(connector),tool:'echo',arguments:{}});assert.equal(result.content[0].text,'[REDACTED]');assert.equal(JSON.stringify(result).includes(token),false);assert.deepEqual(result.structuredContent,{modelKey:null,bridge:null});
  }finally{process.env=previous;await adapter?.close();f.close();}
});

test('credential routes require owner CSRF, expose metadata only, and bind OAuth callbacks to the initiating browser',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-credential-api-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'credential-api-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const ctl=await createController(config,{startQueue:false,startBridge:false});let exchanges=0;
  const server=createServer(async(request,response)=>{for await(const _chunk of request){}exchanges++;response.setHeader('content-type','application/json');response.end(JSON.stringify({access_token:'fixture-api-oauth-access-token',token_type:'Bearer',expires_in:3600}));});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{
    const token='fixture-api-private-token',credentialBody={name:'API credential',values:{token}};
    assert.equal((await ctl.app.inject({method:'POST',url:'/api/credentials',headers:{origin:config.origins[0]},payload:credentialBody})).statusCode,401);
    const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:config.origins[0]},payload:{password:config.adminPassword}});
    const headers={origin:config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
    assert.equal((await ctl.app.inject({method:'POST',url:'/api/credentials',headers:{...headers,'x-csrf-token':'wrong'},payload:credentialBody})).statusCode,403);
    let response=await ctl.app.inject({method:'POST',url:'/api/credentials',headers,payload:credentialBody});assert.equal(response.statusCode,200,response.body);assert.equal(response.body.includes(token),false);const credential=response.json();
    response=await ctl.app.inject({method:'GET',url:'/api/credentials',headers});assert.equal(response.body.includes(token),false);assert.deepEqual(response.json()[0].fields,['token']);
    const connection=ctl.connectors.create({name:'API bearer',transport:'http',url:'http://127.0.0.1:1/mcp'});
    const auth={type:'bearer',credentialId:credential.id,field:'token'};
    assert.equal((await ctl.app.inject({method:'PUT',url:`/api/connectors/${connection.id}/auth`,headers:{...headers,'x-csrf-token':'wrong'},payload:{auth}})).statusCode,403);
    assert.equal(ctl.vault.readiness(auth,connection.id).ready,false,'Rejected request must not grant credentials');
    response=await ctl.app.inject({method:'PUT',url:`/api/connectors/${connection.id}/auth`,headers,payload:{auth}});assert.equal(response.statusCode,200,response.body);assert.equal(response.json().readiness.ready,true);assert.equal(response.body.includes(token),false);
    const port=(server.address()as{port:number}).port;
    response=await ctl.app.inject({method:'POST',url:`/api/connectors/${connection.id}/oauth/start`,headers,payload:{authorizationUrl:`http://127.0.0.1:${port}/authorize`,tokenUrl:`http://127.0.0.1:${port}/token`,clientId:'fixture-api-client'}});
    assert.equal(response.statusCode,200,response.body);const start=response.json(),state=new URL(start.authorizationUrl).searchParams.get('state')!,oauthCookie=String(response.headers['set-cookie']).split(';')[0];
    assert.equal('cookie'in start,false);assert.equal(response.body.includes(oauthCookie.split('=')[1]),false);
    const callback=`/api/credentials/oauth/callback?state=${encodeURIComponent(state)}&code=fixture-api-code`;
    response=await ctl.app.inject({method:'GET',url:callback,headers:{'sec-fetch-site':'cross-site'}});assert.equal(response.statusCode,403);assert.equal(exchanges,0);
    response=await ctl.app.inject({method:'GET',url:callback,headers:{cookie:oauthCookie,'sec-fetch-site':'cross-site'}});assert.equal(response.statusCode,302,response.body);assert.equal(exchanges,1);assert.equal(new URL(String(response.headers.location)).searchParams.get('oauth'),'connected');assert.equal(response.headers['cache-control'],'no-store');
    assert.equal((await ctl.app.inject({method:'GET',url:callback,headers:{cookie:oauthCookie}})).statusCode,403);assert.equal(exchanges,1,'A replay must not exchange the authorization code again');
    response=await ctl.app.inject({method:'GET',url:'/api/credentials',headers});assert.equal(response.body.includes('fixture-api-oauth-access-token'),false);assert.equal(ctl.connectors.get(connection.id).readiness?.ready,true);
    const conversation=ctl.store.newConversation('Credential audit');
    response=await ctl.app.inject({method:'POST',url:`/api/conversations/${conversation.id}/runs`,headers,payload:{prompt:`Use ${token}`,requestId:'credential-prompt-fixture'}});assert.equal(response.statusCode,400,response.body);assert.deepEqual(ctl.store.runs(conversation.id),[],'Rejected secret must not create durable task or message');
    response=await ctl.app.inject({method:'PUT',url:'/api/instructions',headers,payload:{text:`Remember ${token}`}});assert.equal(response.statusCode,400,response.body);assert.equal(ctl.brain.getInstructions(),'');
  }finally{server.closeAllConnections();await new Promise<void>(resolve=>server.close(()=>resolve()));await ctl.close();rmSync(stateDir,{recursive:true,force:true});}
});
