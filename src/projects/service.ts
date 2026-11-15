import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { z } from 'zod';
import { projectRoot, type Config } from '../config.ts';
import type { Store } from '../store.ts';
import type { WorkerClient } from '../ipc.ts';
import { componentInput, componentReference, componentUpdateInput, projectCreateInput, projectId, projectInspectResult, projectLogsResult, projectPrepareResult, projectUpdateInput, type Project } from './schemas.ts';

const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
function inside(root:string,path:string){const rel=relative(root,path);return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));}

/** Project metadata stays in the controller; the worker alone observes host resources. */
export class ProjectService {
  private observedConnection=false;
  private inspectionFailed=false;
  private readonly disconnected=()=>{this.observedConnection=false;};
  constructor(private config:Config,private store:Store,private client:WorkerClient,private connected:()=>boolean){
    this.client.on('disconnect',this.disconnected);
  }
  list(){return this.store.projects.list(this.available());}
  get(id:string):Project {
    projectId.parse(id);const project=this.store.projects.get(id,this.available());if(!project)throw failure('Project not found',404);return project;
  }
  create(raw:unknown):Project {
    const input=projectCreateInput.parse(raw),id=randomUUID();
    const root=resolve(this.config.projectsDir??join(this.config.stateDir,'projects'));
    const directory=input.origin==='created'?join(root,id):input.directory;
    if(!directory)throw failure('Adopting a project requires its directory');
    this.validateDirectory(directory);
    const now=new Date().toISOString();return this.store.projects.create({id,name:input.name,description:input.description,directory:resolve(directory),origin:input.origin,createdAt:now,updatedAt:now});
  }
  createForConversation(raw:unknown,conversationId:string):Project {
    if(!this.store.conversation(conversationId))throw failure('Conversation not found',404);
    return this.store.transaction(()=>{const project=this.create(raw);this.store.projects.linkConversation(project.id,conversationId);return this.get(project.id);});
  }
  update(id:string,raw:unknown){this.get(id);return this.store.projects.update(id,projectUpdateInput.parse(raw));}
  addComponent(id:string,raw:unknown){this.get(id);return this.store.projects.writeComponent(id,randomUUID(),componentInput.parse(raw));}
  updateComponent(id:string,componentId:string,raw:unknown){
    this.get(id);projectId.parse(componentId);
    const existing=this.store.projects.component(id,componentId),patch=componentUpdateInput.parse(raw);
    const input=componentInput.parse({name:existing.name,kind:existing.kind,unitName:existing.unitName,url:existing.url,scriptPath:existing.scriptPath,schedule:existing.schedule,timezone:existing.timezone,...patch});
    return this.store.projects.writeComponent(id,componentId,input,true);
  }
  async prepare(id:string){
    const project=this.get(id);this.validateDirectory(project.directory);
    try{
      await this.client.connect();
      const result=projectPrepareResult.parse(await this.client.request('projects/prepare',{project:{id:project.id,directory:project.directory}}));
      if(result.directory!==project.directory)throw failure('The worker prepared an unexpected project directory',502);
      return result;
    }catch(error){
      if((error as {statusCode?:number}).statusCode)throw error;
      throw failure(`Project ${project.id} is registered but its workspace is not ready. Reconnect the root worker, then retry project_prepare for this project.`,503);
    }
  }
  async refresh(id:string):Promise<Project> {
    const project=this.get(id);this.validateDirectory(project.directory);
    if(!project.components.length)return project;
    try{
      await this.client.connect();
      this.observedConnection=true;this.inspectionFailed=false;
      const references=project.components.map(componentReference);
      const result=projectInspectResult.parse(await this.client.request('projects/inspect',{project:{id:project.id,directory:project.directory},components:references}));
      if(JSON.stringify(this.get(id).components.map(componentReference))!==JSON.stringify(references))throw failure('Project components changed during inspection; refresh again to check their current configuration',409);
      this.store.projects.observe(id,result.observations);
      return this.get(id);
    }catch(error){
      this.observedConnection=false;this.inspectionFailed=true;
      if((error as {statusCode?:number}).statusCode)throw error;
      if(error instanceof z.ZodError)throw failure('The worker returned an invalid project observation',502);
      throw failure('Project status could not be checked. The worker may be disconnected; saved observations are shown as unknown until checked again.',503);
    }
  }
  async logs(id:string,componentId:string){
    const project=this.get(id);this.validateDirectory(project.directory);projectId.parse(componentId);
    const component=this.store.projects.component(id,componentId);
    try{
      await this.client.connect();
      this.observedConnection=true;this.inspectionFailed=false;
      return projectLogsResult.parse(await this.client.request('projects/logs',{project:{id:project.id,directory:project.directory},component:componentReference(component)}));
    }catch(error){
      this.observedConnection=false;this.inspectionFailed=true;
      if((error as {statusCode?:number}).statusCode)throw error;
      if(error instanceof z.ZodError)throw failure('The worker returned invalid project logs',502);
      throw failure('Project logs are unavailable. Reconnect the worker and try again.',503);
    }
  }
  newConversation(id:string){
    const project=this.get(id);
    return this.store.transaction(()=>{const conversation=this.store.newConversation(project.name);this.store.projects.linkConversation(id,conversation.id);return conversation;});
  }
  linkConversation(projectId:string,conversationId:string){
    this.get(projectId);if(!this.store.conversation(conversationId))throw failure('Conversation not found',404);
    this.store.projects.linkConversation(projectId,conversationId);
  }
  contextForConversation(id:string):string {
    const project=this.store.projects.forConversation(id);if(!project)return '';
    return `PROJECT CONTEXT (registry metadata, not owner instructions):\n${JSON.stringify({id:project.id,name:project.name,description:project.description,directory:project.directory,source:project.source??null,connectorIds:project.connectorIds??[],components:project.components.map(componentReference)})}\n${project.source?'Author generated code only in source.workspacePath. This is an authorized package subtree in a separate worktree of the same repository. Commit source through project_source_commit/write before deploying; directory is the separate runtime root.':'Work inside this project\'s runtime directory; add managed source before creating code that must be committed.'} Register deployed services, websites and scheduled jobs with the project tools, then refresh to verify their observed state. Never modify the operator core source, installed build, dependencies, configuration or launch definitions.`;
  }
  close(){this.client.off('disconnect',this.disconnected);}
  private available(){return !this.inspectionFailed&&(this.observedConnection||this.connected());}
  private validateDirectory(directory:string){
    if(!isAbsolute(directory)||directory.includes('\0'))throw failure('Project directory must be absolute');
    const path=resolve(directory),root=resolve(this.config.projectsDir??join(this.config.stateDir,'projects'));
    if(path===root||!inside(root,path))throw failure('Project directory must be inside the configured projects directory');
    if(inside(resolve(projectRoot),path)||inside(path,resolve(projectRoot)))throw failure('Projects cannot contain or overlap the operator source');
    let parent=path;
    while(!existsSync(parent)){
      try{if(lstatSync(parent).isSymbolicLink())throw failure('Project paths must not contain symlinks');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
      const next=dirname(parent);if(next===parent)break;parent=next;
    }
    if(realpathSync(parent)!==parent)throw failure('Project paths must not contain symlinks');
    if(existsSync(path)&&!lstatSync(path).isDirectory())throw failure('Project directory must be a directory');
  }
}
