import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Store } from '../src/store.ts';
import { Brain } from '../src/brain/index.ts';
import { ManagedService } from '../src/managed/service.ts';
import { ConnectorService } from '../src/connectors/service.ts';
import { ProjectService } from '../src/projects/service.ts';
import { initState, projectRoot, type Config } from '../src/config.ts';
import type { WorkerClient } from '../src/ipc.ts';
import type { Project, ProjectComponent } from '../src/projects/schemas.ts';

test('project tools register and prepare current-turn workspaces and retain linked task context',async()=>{
  const stateDir=mkdtempSync(join(tmpdir(),'operator-project-tools-'));
  const config:Config={stateDir,runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'',host:'127.0.0.1',port:3001,origins:[],adminPassword:'project-tools-fixture',secureCookie:false,improvementEnabled:false,improvementMaxTurns:1,improvementTimeoutMs:1000,allowTempState:true,projectsDir:join(stateDir,'projects')};
  initState(config);
  const store=new Store(stateDir),brain=new Brain(store.db,stateDir);await brain.initialize();
  const requests:Array<{method:string;params:any}>=[];
  // Only the transport boundary is simulated; no real service or account is changed.
  class Fixture extends EventEmitter {
    async connect(){return {connected:true,uid:process.getuid!(),pid:process.pid,root:false,runtime:{available:true,version:'fixture',authenticated:true,detail:'No model execution'},activeRunId:null,uncertainRuns:[]};}
    async request(method:string,params:any){requests.push({method,params});if(method==='projects/prepare')return {directory:params.project.directory,ready:true};throw new Error('Unexpected fixture method');}
  }
  const client=new Fixture() as unknown as WorkerClient,service=new ProjectService(config,store,client,()=>false),managed=new ManagedService(config,store,service,client),connectors=new ConnectorService(store,client,service,managed);brain.setProjects(service);brain.setManaged(managed,connectors);
  const repository=await managed.packages.register({name:'Tool packages',remoteUrl:'https://example.test/project-tools.git',mode:'create'});
  try{
    const conversation=store.newConversation(),run=store.enqueue(conversation.id,'Build a project','project-tools-create');store.transition(run.id,'running');
    const project=await brain.callTool('project_create',{name:'Fixture website',repositoryId:repository.id,packagePath:'apps/website'},{conversationId:conversation.id,runId:run.id}) as Project;
    assert(project.source?.repositoryId===repository.id);assert.equal(project.source?.path,'apps/website');
    await brain.callTool('project_prepare',{id:project.id});assert.equal(requests.length,1);assert.equal(requests[0].method,'projects/prepare');
    assert.equal(requests[0].params.project.directory,project.directory);
    assert.equal(store.projects.forConversation(conversation.id)?.id,project.id);
    assert(brain.projectContext(conversation.id).includes(project.directory));
    assert(brain.projectContext(conversation.id).includes('Never modify the operator'));
    assert(brain.bootstrap().includes(projectRoot));assert(brain.bootstrap().includes('externally')||brain.bootstrap().includes('released separately'));
    assert.match(brain.bootstrap(),/OPERATOR SOURCE GUARDRAIL \(prompt-only\)/);
    assert.match(brain.bootstrap(),/Never change its source/);
    assert(!brain.bootstrap().includes('Never attempt to regain root'));
    const component=await brain.callTool('project_component_add',{projectId:project.id,name:'Report script',kind:'script',scriptPath:'scripts/report.mjs'}) as ProjectComponent;
    assert.equal(component.kind,'script');assert.equal(component.status,'unknown');
    await assert.rejects(brain.callTool('project_component_add',{projectId:project.id,name:'Escape',kind:'script',scriptPath:'../src/worker.ts'}));
    await assert.rejects(brain.callTool('project_create',{name:'Duplicate chat association',repositoryId:repository.id,packagePath:'apps/duplicate'},{conversationId:conversation.id,runId:run.id}),/already belongs/);
    assert.equal(service.list().length,1,'Failed chat linkage must roll back the new project');
    await brain.callTool('project_prepare',{id:project.id});assert.equal(requests.length,2);
    const names=brain.listTools().map(tool=>tool.name);assert(names.includes('project_prepare'));assert(names.includes('artifact_publish'));
  }finally{service.close();store.close();rmSync(stateDir,{recursive:true,force:true});}
});
