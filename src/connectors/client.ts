import { spawn,type ChildProcessWithoutNullStreams } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { markCleanupUncertain, markExternalEffects, spawnOwned, terminateOwned } from '../runtime/operations.ts';
import { connectorCallResult, connectorSnapshotSchema, connectorToolSchema, connectorToolsResult, type ConnectorSnapshot } from './schemas.ts';
import { resolveConnectorSecrets } from '../credentials/runtime.ts';
import { redactSecrets } from '../credentials/files.ts';
const messageSchema=z.object({jsonrpc:z.literal('2.0'),id:z.union([z.string(),z.number()]).optional(),method:z.string().optional(),params:z.unknown().optional(),result:z.unknown().optional(),error:z.object({code:z.number(),message:z.string().max(20_000)}).passthrough().optional()});
const limit=2*1024*1024;
const versions=new Set(['2024-11-05','2025-03-26','2025-06-18','2025-11-25']);
type Message=z.infer<typeof messageSchema>;
function encodeMessage(message:unknown):string {
  const body=JSON.stringify(message);if(Buffer.byteLength(body)>limit)throw new Error('Connector request exceeded 2 MiB.');return body;
}

/** Local connectors receive ordinary process context, without controller/model credentials. */
export function connectorEnvironment():NodeJS.ProcessEnv {
  return Object.fromEntries(['PATH','HOME','USER','LOGNAME','LANG','LC_ALL','TZ','TMPDIR','TEMP','LD_LIBRARY_PATH'].flatMap(key=>process.env[key]===undefined?[]:[[key,process.env[key]]]));
}

export class ConnectorSession {
  private child?:ChildProcessWithoutNullStreams;
  private pending=new Map<number,{resolve:(message:Message)=>void;reject:(error:Error)=>void}>();
  private serial=0;
  private buffer='';
  private bytes=0;
  private controller=new AbortController();
  private timer?:NodeJS.Timeout;
  private secrets=new Set<string>();
  private session?:string;
  private version='2025-06-18';
  private closed=false;
  private parentAbort?:()=>void;
  constructor(private config:Pick<Config,'stateDir'>,private connector:ConnectorSnapshot,private timeoutMs=15_000,private parentSignal?:AbortSignal,private inParentGroup=false){
    if(!inParentGroup)this.arm();
    this.parentAbort=()=>this.fail(new Error('Connector was interrupted; tool side effects may be uncertain.'));parentSignal?.addEventListener('abort',this.parentAbort,{once:true});if(parentSignal?.aborted)this.parentAbort();
  }
  private arm(){clearTimeout(this.timer);this.timer=setTimeout(()=>this.fail(new Error('Connector request timed out; tool side effects may be uncertain.')),this.timeoutMs);}
  private material(){const value=resolveConnectorSecrets(this.config,this.connector);for(const secret of value.secrets)this.secrets.add(secret);return value;}
  redact(value:unknown):any{return redactSecrets(value,[...this.secrets]);}
  async start():Promise<void> {
    this.controller.signal.throwIfAborted();
    if(this.connector.transport==='stdio'){
      if(this.connector.cwd&&realpathSync(this.connector.cwd)!==resolve(this.connector.cwd))throw new Error('Connector working directory must be canonical.');
      const options={cwd:this.connector.cwd,env:{...connectorEnvironment(),...this.material().env}};
      const child=this.inParentGroup?spawn(this.connector.command,this.connector.args,{...options,stdio:'pipe',detached:false}):spawnOwned(this.connector.command,this.connector.args,options);this.child=child;
      child.stdout.setEncoding('utf8');child.stdout.on('data',(chunk:string)=>this.consume(chunk));child.stderr.resume();
      child.stdin.on('error',()=>this.fail(new Error('Connector input closed.')));
      child.on('error',()=>this.fail(new Error('Connector process could not start.')));
      child.on('exit',()=>this.fail(new Error('Connector exited before its request completed.')));
    }
    const result=z.object({protocolVersion:z.string(),capabilities:z.object({tools:z.unknown().optional()}).passthrough(),serverInfo:z.object({name:z.string(),version:z.string()}).passthrough()}).parse(await this.request('initialize',{protocolVersion:this.version,capabilities:{},clientInfo:{name:'vps_ai_operator',version:'0.1.0'}}));
    if(!versions.has(result.protocolVersion))throw new Error('Connector negotiated an unsupported MCP protocol version.');
    if(!result.capabilities.tools)throw new Error('Connector does not expose MCP tools.');
    this.version=result.protocolVersion;
    await this.notify('notifications/initialized');
  }
  async tools():Promise<z.infer<typeof connectorToolSchema>[]> {
    const tools:z.infer<typeof connectorToolSchema>[]=[];const cursors=new Set<string>();let cursor:string|undefined;
    for(let page=0;page<20;page++){
      const result=z.object({tools:z.array(connectorToolSchema).max(500),nextCursor:z.string().max(2000).optional()}).parse(await this.request('tools/list',cursor!==undefined?{cursor}:{}));
      tools.push(...result.tools);if(tools.length>500)throw new Error('Connector exposes more than 500 tools.');
      if(result.nextCursor===undefined)return this.redact(tools);
      if(cursors.has(result.nextCursor))throw new Error('Connector repeated a tools pagination cursor.');
      cursors.add(result.nextCursor);cursor=result.nextCursor;
    }
    throw new Error('Connector tools pagination exceeded 20 pages.');
  }
  async call(name:string,args:Record<string,unknown>):Promise<z.infer<typeof connectorCallResult>> { return this.redact(connectorCallResult.parse(await this.request('tools/call',{name,arguments:args}))); }
  private fail(error:Error):void {
    if(!this.controller.signal.aborted)this.controller.abort(error);
    this.buffer='';
    for(const request of this.pending.values())request.reject(error);this.pending.clear();
  }
  private consume(chunk:string):void {
    if(this.controller.signal.aborted||this.closed)return;
    this.bytes+=Buffer.byteLength(chunk);this.buffer+=chunk;
    if(this.bytes>limit||Buffer.byteLength(this.buffer)>limit){this.fail(new Error('Connector response exceeded 2 MiB.'));return;}
    let newline:number;
    while((newline=this.buffer.indexOf('\n'))>=0){
      const line=this.buffer.slice(0,newline);this.buffer=this.buffer.slice(newline+1);if(!line.trim())continue;
      try{this.receive(messageSchema.parse(JSON.parse(line)));}catch{this.fail(new Error('Connector returned an invalid MCP message.'));return;}
    }
  }
  private receive(message:Message):void {
    if(message.method){
      if(message.id!==undefined){const response=message.method==='ping'?{jsonrpc:'2.0',id:message.id,result:{}}:{jsonrpc:'2.0',id:message.id,error:{code:-32601,message:'Client method is not supported'}};if(this.child)this.child.stdin.write(encodeMessage(response)+'\n');}
      return;
    }
    if(typeof message.id!=='number')return;const pending=this.pending.get(message.id);if(!pending)return;
    this.pending.delete(message.id);pending.resolve(message);
  }
  private async request(method:string,params:unknown):Promise<unknown> {
    if(this.inParentGroup){this.bytes=0;this.arm();}
    try{
    this.controller.signal.throwIfAborted();const id=++this.serial,message={jsonrpc:'2.0',id,method,params};let response:Message;
    if(this.child){const body=encodeMessage(message);if(method==='tools/call')markExternalEffects();response=await new Promise<Message>((resolve,reject)=>{this.pending.set(id,{resolve,reject});this.child!.stdin.write(body+'\n');});}
    else response=await this.http(message,id);
    if(response.error)throw new Error(this.redact(`Connector MCP error ${response.error.code}: ${response.error.message}`));
    if(!('result' in response))throw new Error('Connector response has no result.');
    return response.result;
    }finally{if(this.inParentGroup)clearTimeout(this.timer);}
  }
  private async notify(method:string):Promise<void> {
    if(this.inParentGroup)this.arm();try{const message={jsonrpc:'2.0',method};if(this.child)this.child.stdin.write(encodeMessage(message)+'\n');else await this.http(message);}finally{if(this.inParentGroup)clearTimeout(this.timer);}
  }
  private async http(message:Record<string,unknown>,id?:number):Promise<Message> {
    if(this.connector.transport!=='http')throw new Error('Invalid connector transport.');
    const headers:Record<string,string>={'content-type':'application/json',accept:'application/json, text/event-stream','MCP-Protocol-Version':this.version,...this.material().headers};if(this.session)headers['Mcp-Session-Id']=this.session;
    markExternalEffects();const response=await fetch(this.connector.url,{method:'POST',headers,body:encodeMessage(message),redirect:'error',signal:this.controller.signal});
    if(!response.ok){await response.body?.cancel();throw new Error(`Connector HTTP request failed (${response.status}).`);}
    const session=response.headers.get('Mcp-Session-Id');if(session){if(session.length>2000||!/^[\x21-\x7e]+$/.test(session))throw new Error('Connector returned an invalid session ID.');this.session=session;}
    if(id===undefined){await response.body?.cancel();if(response.status!==202)throw new Error('Connector did not acknowledge its initialization notification.');return {jsonrpc:'2.0'};}
    const type=response.headers.get('content-type')??'';
    if(!type.includes('application/json')&&!type.includes('text/event-stream')){await response.body?.cancel();throw new Error('Connector returned an unsupported HTTP content type.');}
    if(!response.body)throw new Error('Connector returned an empty HTTP response.');
    const reader=response.body.getReader(),decoder=new TextDecoder();let text='',bytes=0;
    try{
      while(true){
        const chunk=await reader.read();if(chunk.done)break;bytes+=chunk.value.length;this.bytes+=chunk.value.length;if(bytes>limit||this.bytes>limit)throw new Error('Connector response exceeded 2 MiB.');text+=decoder.decode(chunk.value,{stream:true});
        if(type.includes('text/event-stream')){
          text=text.replaceAll('\r\n','\n');let end:number;
          while((end=text.indexOf('\n\n'))>=0){
            const event=text.slice(0,end);text=text.slice(end+2);const data=event.split('\n').filter(line=>line.startsWith('data:')).map(line=>line.slice(5).replace(/^ /,'')).join('\n');if(!data)continue;
            const result=messageSchema.parse(JSON.parse(data));if(result.id===id&&!result.method)return result;
            if(result.method&&result.id!==undefined)await this.http(result.method==='ping'?{jsonrpc:'2.0',id:result.id,result:{}}:{jsonrpc:'2.0',id:result.id,error:{code:-32601,message:'Client method is not supported'}});
          }
        }
      }
      if(type.includes('application/json')){const result=messageSchema.parse(JSON.parse(text+decoder.decode()));if(result.id===id&&!result.method)return result;}
      throw new Error('Connector closed without the matching MCP response.');
    }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }
  async close():Promise<void> {
    if(this.closed)return;this.closed=true;clearTimeout(this.timer);
    if(this.parentAbort)this.parentSignal?.removeEventListener('abort',this.parentAbort);
    if(this.connector.transport==='http'&&this.session){
      try{const response=await fetch(this.connector.url,{method:'DELETE',headers:{'Mcp-Session-Id':this.session,'MCP-Protocol-Version':this.version,...this.material().headers},redirect:'error',signal:AbortSignal.timeout(1000)});await response.body?.cancel();}catch{}
    }
    this.fail(new Error('Connector session closed.'));this.child?.stdin.end();
    if(this.child)try{
      if(this.inParentGroup){if(this.child.exitCode===null&&this.child.signalCode===null){this.child.kill('SIGTERM');let timer:NodeJS.Timeout|undefined;try{await Promise.race([new Promise<void>(resolve=>this.child!.once('exit',()=>resolve())),new Promise<void>(resolve=>{timer=setTimeout(resolve,1000);})]);}finally{clearTimeout(timer);}if(this.child.exitCode===null&&this.child.signalCode===null)this.child.kill('SIGKILL');}}
      else await terminateOwned(this.child);
    }catch(error){markCleanupUncertain();throw error;}
  }
}

export async function testConnector(config:Config,raw:unknown,options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<z.infer<typeof connectorToolsResult>> {
  const connector=connectorSnapshotSchema.parse(raw),client=new ConnectorSession(config,connector,options.timeoutMs??15_000,options.signal);
  try{await client.start();return {tools:await client.tools(),checkedAt:new Date().toISOString()};}catch(error){throw new Error(client.redact(error instanceof Error?error.message:'Connection failed'));}finally{await client.close();}
}
export async function callConnector(config:Config,raw:unknown,name:string,args:Record<string,unknown>={},options:{timeoutMs?:number;signal?:AbortSignal}={}):Promise<z.infer<typeof connectorCallResult>> {
  const connector=connectorSnapshotSchema.parse(raw),client=new ConnectorSession(config,connector,options.timeoutMs??15_000,options.signal);
  try{await client.start();return await client.call(z.string().min(1).max(200).parse(name),args);}catch(error){throw new Error(client.redact(error instanceof Error?error.message:'Connection failed'));}finally{await client.close();}
}
