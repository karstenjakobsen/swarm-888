import type { DatabaseSync } from 'node:sqlite';
import { storedRun } from '../persistence/runs.ts';
import { transaction } from '../persistence/transaction.ts';
import { acquireRepository,projectRepository } from '../packages/leases.ts';
import { componentObservation, type ComponentInput, type ComponentObservation, type Project, type ProjectComponent, type ProjectStatus, type ProjectDeployment } from './schemas.ts';

type ProjectRow = Pick<Project,'id'|'name'|'description'|'directory'|'origin'|'createdAt'|'updatedAt'>;
type ComponentRow = Omit<ProjectComponent,'observation'|'status'|'stale'> & {observation:string|null};
const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});

/** Durable registry. Host observations are supplied by the worker, never by a model. */
export class ProjectStore {
  constructor(private db:DatabaseSync){}
  list(connected=false,now=Date.now()):Project[]{
    const rows=this.db.prepare('SELECT * FROM projects ORDER BY updatedAt DESC,id').all() as unknown as ProjectRow[];
    return rows.map(row=>this.expand(row,connected,now));
  }
  get(id:string,connected=false,now=Date.now()):Project|undefined {
    const row=this.db.prepare('SELECT * FROM projects WHERE id=?').get(id) as ProjectRow|undefined;
    return row?this.expand(row,connected,now):undefined;
  }
  forConversation(conversationId:string):Project|undefined {
    const row=this.db.prepare('SELECT p.* FROM projects p JOIN project_conversations pc ON pc.projectId=p.id WHERE pc.conversationId=?').get(conversationId) as ProjectRow|undefined;
    return row?this.expand(row,false,Date.now()):undefined;
  }
  create(row:ProjectRow):Project {
    if(this.db.prepare('SELECT id FROM projects WHERE directory=?').get(row.directory))throw failure('That project directory is already registered',409);
    this.db.prepare('INSERT INTO projects(id,name,description,directory,origin,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?)').run(row.id,row.name,row.description,row.directory,row.origin,row.createdAt,row.updatedAt);
    return this.get(row.id)!;
  }
  discardUninitialized(id:string):void {
    this.transaction(()=>{
      if(this.db.prepare('SELECT 1 FROM project_sources WHERE projectId=? UNION ALL SELECT 1 FROM project_components WHERE projectId=? UNION ALL SELECT 1 FROM project_deployments WHERE projectId=? LIMIT 1').get(id,id,id))throw failure('Project initialization cannot be rolled back after source or runtime resources were registered.',409);
      this.db.prepare('DELETE FROM project_conversations WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM project_leases WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
  }
  update(id:string,input:{name?:string;description?:string;defaultWorkerId?:string|null}):Project {
    const project=this.get(id);if(!project)throw failure('Project not found',404);
    if(input.defaultWorkerId&&input.defaultWorkerId!=='default'&&!this.db.prepare('SELECT 1 FROM workers WHERE id=?').get(input.defaultWorkerId))throw failure('Default worker is not registered',404);
    this.db.prepare('UPDATE projects SET name=?,description=?,defaultWorkerId=?,updatedAt=? WHERE id=?').run(input.name??project.name,input.description??project.description,input.defaultWorkerId===undefined?project.defaultWorkerId??null:input.defaultWorkerId,new Date().toISOString(),id);
    return this.get(id)!;
  }
  environment(id:string):{credentialId:string;bindings:Record<string,string>}|null {const row=this.db.prepare('SELECT environment FROM project_environment WHERE projectId=?').get(id);return row?JSON.parse(String(row.environment)):null;}
  setEnvironment(id:string,environment:{credentialId:string;bindings:Record<string,string>}|null):void {
    if(!this.db.prepare('SELECT 1 FROM projects WHERE id=?').get(id))throw failure('Project not found',404);
    if(environment)this.db.prepare('INSERT INTO project_environment(projectId,environment,updatedAt) VALUES(?,?,?) ON CONFLICT(projectId) DO UPDATE SET environment=excluded.environment,updatedAt=excluded.updatedAt').run(id,JSON.stringify(environment),new Date().toISOString());
    else this.db.prepare('DELETE FROM project_environment WHERE projectId=?').run(id);
  }
  remove(id:string):void {
    this.transaction(()=>{
      if(!this.db.prepare('SELECT id FROM projects WHERE id=?').get(id))throw failure('Project not found',404);
      const affected=`WITH affected_projects(id) AS (
        SELECT ? UNION SELECT pc.projectId FROM project_connectors pc JOIN connectors c ON c.id=pc.connectorId WHERE c.projectId=? OR c.packageId=?
      )`;
      if(this.db.prepare(`${affected} SELECT r.id FROM runs r JOIN project_conversations pc ON pc.conversationId=r.conversationId JOIN affected_projects a ON a.id=pc.projectId WHERE r.status IN ('queued','running','waiting','uncertain') LIMIT 1`).get(id,id,id))throw failure('Finish or reconcile tasks for this project and projects using its connections before removing it.',409);
      if(this.db.prepare(`${affected} SELECT sf.runId FROM source_finalizations sf JOIN affected_projects a ON a.id=sf.projectId WHERE sf.state='pending' LIMIT 1`).get(id,id,id))throw failure('Finish pending source commits before removing this project.',409);
      const repositoryId=projectRepository(this.db,id);
      if(repositoryId&&this.db.prepare('SELECT 1 FROM repository_leases WHERE repositoryId=?').get(repositoryId))throw failure('Finish or reconcile the task writing this repository before removing its project.',409);
      // Connector receipts may have no project ID, so every unacknowledged result
      // must be recovered before registrations can be removed.
      if(this.db.prepare('SELECT operationId FROM runtime_receipts WHERE acknowledgedAt IS NULL LIMIT 1').get())throw failure('Acknowledge pending runtime result receipts before removing project registrations.',409);
      this.db.prepare('DELETE FROM project_connectors WHERE projectId=? OR connectorId IN (SELECT id FROM connectors WHERE projectId=? OR packageId=?)').run(id,id,id);
      this.db.prepare('DELETE FROM connector_checks WHERE connectorId IN (SELECT id FROM connectors WHERE projectId=? OR packageId=?)').run(id,id);
      this.db.prepare('DELETE FROM connectors WHERE projectId=? OR packageId=?').run(id,id);
      this.db.prepare('DELETE FROM job_runs WHERE jobId IN (SELECT id FROM jobs WHERE projectId=?)').run(id);
      this.db.prepare('DELETE FROM jobs WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM project_leases WHERE projectId=?').run(id);
      this.db.prepare('DELETE FROM project_environment WHERE projectId=?').run(id);
      for(const table of ['project_components','project_conversations','project_sources','project_deployments','source_finalizations'])this.db.prepare(`DELETE FROM ${table} WHERE projectId=?`).run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
  }
  component(projectId:string,id:string):ProjectComponent {
    const project=this.get(projectId);if(!project)throw failure('Project not found',404);
    const component=project.components.find(item=>item.id===id);if(!component)throw failure('Project component not found',404);return component;
  }
  writeComponent(projectId:string,id:string,input:ComponentInput,update=false):ProjectComponent {
    const project=this.get(projectId);if(!project)throw failure('Project not found',404);
    if(!update&&project.components.length>=100)throw failure('A project can register at most 100 components');
    if(update)this.component(projectId,id);
    const existing=this.db.prepare('SELECT id FROM project_components WHERE projectId=? AND name=? AND id<>?').get(projectId,input.name,id);
    if(existing)throw failure('A component with that name already exists in this project',409);
    const now=new Date().toISOString(),values=[input.name,input.kind,input.unitName??null,input.url??null,input.scriptPath??null,input.schedule??null,input.timezone??null];
    this.transaction(()=>{
      if(update)this.db.prepare('UPDATE project_components SET name=?,kind=?,unitName=?,url=?,scriptPath=?,schedule=?,timezone=?,observation=NULL,updatedAt=? WHERE id=? AND projectId=?').run(...values,now,id,projectId);
      else this.db.prepare('INSERT INTO project_components(id,projectId,name,kind,unitName,url,scriptPath,schedule,timezone,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?,?,?,?)').run(id,projectId,...values,now,now);
      this.db.prepare('UPDATE projects SET updatedAt=? WHERE id=?').run(now,projectId);
    });
    return this.component(projectId,id);
  }
  observe(projectId:string,observations:Array<ComponentObservation & {componentId:string}>):void {
    const project=this.get(projectId);if(!project)throw failure('Project not found',404);
    const ids=new Set(project.components.map(item=>item.id));
    if(observations.length!==ids.size||new Set(observations.map(item=>item.componentId)).size!==ids.size||observations.some(item=>!ids.has(item.componentId)))throw failure('Worker returned an incomplete or invalid project observation',502);
    this.transaction(()=>{
      for(const {componentId,...observation} of observations){
        componentObservation.parse(observation);
        this.db.prepare('UPDATE project_components SET observation=? WHERE projectId=? AND id=?').run(JSON.stringify(observation),projectId,componentId);
      }
    });
  }
  linkConversation(projectId:string,conversationId:string):void {
    this.transaction(()=>{
      if(!this.get(projectId))throw failure('Project not found',404);
      if(!this.db.prepare('SELECT 1 FROM conversations WHERE id=? AND deletedAt IS NULL').get(conversationId))throw failure('Conversation not found',404);
      const linked=this.db.prepare('SELECT projectId FROM project_conversations WHERE conversationId=?').get(conversationId) as {projectId:string}|undefined;
      if(linked){if(linked.projectId!==projectId)throw failure('Conversation already belongs to another project',409);return;}
      const active=this.db.prepare("SELECT id,attemptId FROM runs WHERE conversationId=? AND status IN ('running','waiting','uncertain') LIMIT 1").get(conversationId);
      if(active){
        const repositoryId=projectRepository(this.db,projectId);if(repositoryId)acquireRepository(this.db,repositoryId,String(active.id));
        const conflict=this.db.prepare("SELECT 1 FROM project_leases WHERE projectId=? AND runId<>? UNION ALL SELECT 1 FROM runs r JOIN project_conversations pc ON pc.conversationId=r.conversationId WHERE pc.projectId=? AND r.id<>? AND r.status IN ('running','waiting','uncertain') UNION ALL SELECT 1 FROM source_finalizations WHERE projectId=? AND state='pending' LIMIT 1").get(projectId,active.id,projectId,active.id,projectId);
        if(conflict)throw failure('Another task owns this project until execution and source finalization finish.',409);
        this.db.prepare('INSERT INTO project_leases(projectId,runId,attemptId,acquiredAt) VALUES(?,?,?,?) ON CONFLICT(projectId) DO NOTHING').run(projectId,active.id,active.attemptId??'legacy',new Date().toISOString());
      }
      this.db.prepare('INSERT INTO project_conversations(conversationId,projectId) VALUES(?,?)').run(conversationId,projectId);
    });
  }
  private expand(row:ProjectRow,connected:boolean,now:number):Project {
    const rows=this.db.prepare('SELECT * FROM project_components WHERE projectId=? ORDER BY createdAt,id').all(row.id) as unknown as ComponentRow[];
    const components=rows.map(item=>{
      const observation=item.observation?componentObservation.parse(JSON.parse(item.observation)):null;
      const age=observation?now-Date.parse(observation.checkedAt):Infinity;
      const stale=!connected||!observation||age>60_000||age< -5000;
      return {...item,observation,stale,status:stale?'unknown' as const:observation!.status};
    });
    const checked=components.flatMap(item=>item.observation?[item.observation.checkedAt]:[]).sort();
    const statuses=components.map(item=>item.status);
    const status:ProjectStatus=statuses.includes('failed')?'failed':!statuses.length||statuses.includes('unknown')?'unknown':statuses.includes('stopped')?'stopped':statuses.includes('healthy')?'healthy':statuses.includes('running')?'running':statuses.includes('scheduled')?'scheduled':'ready';
    const conversationIds=(this.db.prepare('SELECT pc.conversationId FROM project_conversations pc JOIN conversations c ON c.id=pc.conversationId WHERE pc.projectId=? AND c.deletedAt IS NULL ORDER BY pc.rowid DESC').all(row.id) as {conversationId:string}[]).map(item=>item.conversationId);
    const runs=this.db.prepare('SELECT r.* FROM runs r JOIN project_conversations pc ON pc.conversationId=r.conversationId JOIN conversations c ON c.id=r.conversationId WHERE pc.projectId=? AND c.deletedAt IS NULL ORDER BY r.createdAt DESC,r.rowid DESC LIMIT 20').all(row.id).map(storedRun);
    const source=this.db.prepare('SELECT source FROM project_sources WHERE projectId=?').get(row.id) as {source:string}|undefined;
    const deployed=this.db.prepare('SELECT commitSha,releaseDirectory,unitName,status,detail,checkedAt FROM project_deployments WHERE projectId=?').get(row.id) as ({commitSha:string}&Omit<ProjectDeployment,'commit'>)|undefined;
    const connectorIds=(this.db.prepare('SELECT connectorId FROM project_connectors WHERE projectId=? ORDER BY connectorId').all(row.id) as {connectorId:string}[]).map(item=>item.connectorId);
    return {...row,components,status,lastCheckedAt:checked.at(-1)??null,conversationIds,runs,
      ...(source?{source:JSON.parse(source.source)}:{}),...(deployed?{deployment:{commit:deployed.commitSha,releaseDirectory:deployed.releaseDirectory,unitName:deployed.unitName,status:deployed.status,detail:deployed.detail,checkedAt:deployed.checkedAt}}:{}),
      ...(connectorIds.length?{connectorIds}:{}),
    };
  }
  private transaction<T>(action:()=>T):T {
    return transaction(this.db,action);
  }
}
