import type { DatabaseSync } from 'node:sqlite';
import { connectorSnapshotSchema, connectorToolsResult, type Connector, type ConnectorTool } from './schemas.ts';

type Row={id:string;name:string;description:string;enabled:number;definition:string;projectId:string|null;tools:string;status:Connector['status'];detail:string;checkedAt:string|null;createdAt:string;updatedAt:string};

/** Connection definitions and observed tools, without process or network concerns. */
export class ConnectorStore {
  constructor(private db:DatabaseSync){}
  private expand(row:Row):Connector {
    return {...connectorSnapshotSchema.parse({id:row.id,name:row.name,...JSON.parse(row.definition)}),description:row.description,enabled:row.enabled===1,projectId:row.projectId,tools:JSON.parse(row.tools),status:row.status,detail:row.detail,checkedAt:row.checkedAt,createdAt:row.createdAt,updatedAt:row.updatedAt};
  }
  list():Connector[]{return (this.db.prepare('SELECT * FROM connectors ORDER BY name,id').all() as Row[]).map(row=>this.expand(row));}
  get(id:string):Connector|undefined {const row=this.db.prepare('SELECT * FROM connectors WHERE id=?').get(id) as Row|undefined;return row?this.expand(row):undefined;}
  nameExists(name:string,except=''){return Boolean(this.db.prepare('SELECT id FROM connectors WHERE name=? AND id<>?').get(name,except));}
  create(value:Connector){
    const definition=value.transport==='stdio'?{transport:value.transport,command:value.command,args:value.args,...(value.cwd?{cwd:value.cwd}:{})}:{transport:value.transport,url:value.url};
    this.db.prepare('INSERT INTO connectors(id,name,description,enabled,definition,projectId,createdAt,updatedAt) VALUES(?,?,?,?,?,?,?,?)').run(value.id,value.name,value.description,value.enabled?1:0,JSON.stringify(definition),value.projectId,value.createdAt,value.updatedAt);
  }
  update(id:string,input:Pick<Connector,'name'|'description'|'enabled'>){
    this.db.prepare('UPDATE connectors SET name=?,description=?,enabled=?,updatedAt=? WHERE id=?').run(input.name,input.description,input.enabled?1:0,new Date().toISOString(),id);
  }
  setAuth(id:string,auth:Connector['auth']|null){
    const row=this.db.prepare('SELECT definition FROM connectors WHERE id=?').get(id) as {definition:string}|undefined;if(!row)throw new Error('Connection not found');
    const definition=JSON.parse(row.definition);if(auth)definition.auth=auth;else delete definition.auth;
    this.db.prepare("UPDATE connectors SET definition=?,tools='[]',status='untested',detail='Connection authorization changed; test it again.',checkedAt=NULL,updatedAt=? WHERE id=?").run(JSON.stringify(definition),new Date().toISOString(),id);this.db.prepare('DELETE FROM connector_checks WHERE connectorId=?').run(id);
  }
  observed(id:string,tools:ConnectorTool[],checkedAt:string,snapshot:string){
    connectorToolsResult.parse({tools,checkedAt});
    this.db.prepare("UPDATE connectors SET tools=?,status='connected',detail=?,checkedAt=? WHERE id=?").run(JSON.stringify(tools),`Discovered ${tools.length} MCP tools.`,checkedAt,id);
    this.db.prepare('INSERT INTO connector_checks(connectorId,snapshot) VALUES(?,?) ON CONFLICT(connectorId) DO UPDATE SET snapshot=excluded.snapshot').run(id,snapshot);
  }
  failed(id:string,message:string){
    this.db.prepare("UPDATE connectors SET tools='[]',status='error',detail=?,checkedAt=? WHERE id=?").run(message.slice(0,4000),new Date().toISOString(),id);
    this.db.prepare('DELETE FROM connector_checks WHERE connectorId=?').run(id);
  }
  testedSnapshot(id:string):string|undefined{return (this.db.prepare('SELECT snapshot FROM connector_checks WHERE connectorId=?').get(id) as {snapshot:string}|undefined)?.snapshot;}
  assigned(projectId:string,enabledOnly=false):string[]{
    return (this.db.prepare(`SELECT c.id FROM connectors c JOIN project_connectors pc ON pc.connectorId=c.id WHERE pc.projectId=?${enabledOnly?' AND c.enabled=1':''} ORDER BY c.id`).all(projectId) as {id:string}[]).map(row=>row.id);
  }
  assign(projectId:string,ids:string[]){
    this.db.prepare('DELETE FROM project_connectors WHERE projectId=?').run(projectId);
    for(const id of new Set(ids))this.db.prepare('INSERT INTO project_connectors VALUES(?,?)').run(projectId,id);
  }
}
