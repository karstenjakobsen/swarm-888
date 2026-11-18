import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { mkdtempSync,rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState,type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { ProjectService } from '../src/projects/service.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { connectorSnapshotSchema } from '../src/connectors/schemas.ts';
import { managedManifestSchema } from '../src/managed/schemas.ts';
import { CredentialVault } from '../src/credentials/vault.ts';
import { resolveConnectorSecrets } from '../src/credentials/runtime.ts';
import type { ManagedService } from '../src/managed/service.ts';
import type { WorkerClient } from '../src/ipc.ts';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-connector-auth-policy-'));
  const config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:[],adminPassword:'connector-auth-policy-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true};
  initState(config);const store=new Store(stateDir),vault=new CredentialVault(stateDir,store.db),client=new EventEmitter() as WorkerClient,projects=new ProjectService(config,store,client,()=>false);
  return {config,store,vault,client,projects,close(){projects.close();store.close();rmSync(stateDir,{recursive:true,force:true});}};
}

test('portable connector manifests cannot configure credential references',()=>{
  const id=randomUUID(),auth={type:'bearer' as const,credentialId:randomUUID(),field:'token'},base={schemaVersion:1,id,kind:'connector',name:'Portable fixture',description:''};
  for(const mcp of [{transport:'http',url:'https://example.invalid/mcp'},{transport:'stdio',command:'node',args:['server.mjs']}]){
    assert(managedManifestSchema.safeParse({...base,mcp}).success);
    const binding=mcp.transport==='stdio'?{type:'env',credentialId:auth.credentialId,bindings:{PROVIDER_TOKEN:'token'}}:auth;
    assert.equal(managedManifestSchema.safeParse({...base,mcp:{...mcp,auth:binding}}).success,false,'Portable source cannot attach owner credentials');
  }
  assert(connectorSnapshotSchema.safeParse({id,name:'Owner snapshot',transport:'http',url:'https://example.invalid/mcp',auth,credentialRevision:1}).success);
});

test('managed snapshots derive authorization only from owner metadata, including legacy source extras',async()=>{
  const f=fixture();try{
    const project=f.projects.create({name:'Managed connector'}),conversation=f.projects.newConversation(project.id),credential=f.vault.create({name:'Owner secret',values:{token:'fixture-formerly-granted-token'}});
    const source={repositoryPath:f.config.stateDir,branch:'fixture',path:`generated/connectors/${project.id}`,workspacePath:f.config.stateDir,commit:'a'.repeat(40),dirty:false};
    f.store.managed.saveSource(project.id,'connector',source);
    // A legacy/malformed manifest is kept here to exercise the service boundary
    // independently of the strict portable-manifest parser.
    let destination='https://example.invalid/changed-endpoint';
    const auth={type:'bearer' as const,credentialId:credential.id,field:'token'},managed={readReleaseSource:async()=>({source,manifest:{name:project.name,description:project.description,mcp:{transport:'http',url:destination,auth}}}),withConnectorName:(_name:string,operation:()=>unknown)=>operation()} as unknown as ManagedService;
    const connectors=new ConnectorService(f.store,f.client,f.projects,managed,undefined,f.vault),connector=connectors.create({name:'Unbound connector',projectId:project.id,transport:'http',url:'https://example.invalid/original-endpoint'});
    f.vault.grant(credential.id,connector.id); // Residual grants from an older installation.
    let snapshots=await connectors.snapshots(conversation.id,[connector.id]);
    assert.equal(snapshots[0]!.auth,undefined);assert.deepEqual({...resolveConnectorSecrets(f.config,snapshots[0]!).headers},{});
    connectors.setAuth(connector.id,auth);snapshots=await connectors.snapshots(conversation.id,[connector.id]);
    assert.deepEqual(snapshots[0]!.auth,auth);assert.equal(snapshots[0]!.credentialRevision,credential.revision);
    destination='https://example.invalid/revised-endpoint';
    await assert.rejects(connectors.snapshots(conversation.id,[connector.id]),/changed its MCP destination/);
    await assert.rejects(connectors.registerProject(project.id),/Remove the credential binding/);
    assert.deepEqual(connectors.get(connector.id).auth,auth);
    connectors.setAuth(connector.id,null);
    const revised=await connectors.registerProject(project.id);
    assert(revised.transport==='http');assert.equal(revised.url,destination);
    assert.equal(revised.auth,undefined);assert.equal(revised.status,'untested');

  }finally{f.close();}
});

test('replacing or clearing authorization revokes old snapshots without revoking unrelated grants',async()=>{
  const f=fixture();try{
    const connectors=new ConnectorService(f.store,f.client,f.projects,{} as ManagedService,undefined,f.vault),connector=connectors.create({name:'Owner-bound connector',transport:'http',url:'https://example.invalid/mcp'}),other=randomUUID();
    const first=f.vault.create({name:'First secret',values:{token:'fixture-first-owner-token'}}),second=f.vault.create({name:'Second secret',values:{token:'fixture-second-owner-token'}}),firstAuth={type:'bearer' as const,credentialId:first.id,field:'token'},secondAuth={...firstAuth,credentialId:second.id};
    f.vault.grant(first.id,connector.id);f.vault.grant(first.id,other);connectors.setAuth(connector.id,firstAuth);
    const snapshot={...connectors.get(connector.id),credentialRevision:first.revision};assert(resolveConnectorSecrets(f.config,snapshot).headers.Authorization);
    f.vault.grant(second.id,connector.id);connectors.setAuth(connector.id,secondAuth);
    assert.equal(f.vault.readiness(firstAuth,connector.id).ready,false);assert.equal(f.vault.readiness(firstAuth,other).ready,true);assert.throws(()=>resolveConnectorSecrets(f.config,snapshot),/granted/);
    connectors.setAuth(connector.id,null);assert.equal(f.vault.readiness(secondAuth,connector.id).ready,false);assert.equal(connectors.get(connector.id).auth,undefined);
  }finally{f.close();}
});

test('changing OAuth authorization cancels only the obsolete pending exchange',async()=>{
  const f=fixture();try{
    const connectors=new ConnectorService(f.store,f.client,f.projects,{} as ManagedService,undefined,f.vault),connector=connectors.create({name:'OAuth connector',transport:'http',url:'https://example.invalid/mcp'}),session='a'.repeat(64);
    f.store.createSession(session,'csrf',Date.now()+600_000);
    const first=await f.vault.startOAuth(connector.id,{authorizationUrl:'https://example.invalid/authorize',tokenUrl:'https://example.invalid/token',clientId:'fixture'},session,'http://localhost/api/credentials/oauth/callback');connectors.setAuth(connector.id,{type:'oauth2',credentialId:first.credential.id});
    const second=await f.vault.startOAuth(connector.id,{authorizationUrl:'https://example.invalid/authorize',tokenUrl:'https://example.invalid/token',clientId:'fixture'},session,'http://localhost/api/credentials/oauth/callback');connectors.setAuth(connector.id,{type:'oauth2',credentialId:second.credential.id});
    const state=new URL(second.authorizationUrl).searchParams.get('state')!;
    assert.equal(f.vault.callbackTarget(state,second.cookie).credentialId,second.credential.id,'Replacing the old grant must retain the newly initiated exchange');
    connectors.setAuth(connector.id,null);assert.throws(()=>f.vault.callbackTarget(state,second.cookie),/expired|initiating browser/);
  }finally{f.close();}
});
