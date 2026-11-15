import { randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, chownSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Socket } from 'node:net';
import { join } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { bridgeRequest } from '../mcp.ts';
import { trustedExecutionDirectory } from './protection.ts';

const requestSchema=z.object({id:z.union([z.string().max(200),z.number()]),token:z.string().length(64),method:z.enum(['tools/list','tools/call']),params:z.unknown().optional()}).strict();
const callSchema=z.object({name:z.string().max(100),arguments:z.unknown().optional(),runId:z.unknown().optional()}).strict();

export async function forwardToolRequest(raw:unknown,runId:string|undefined,token:string,forward:(method:string,params:unknown)=>Promise<unknown>):Promise<{id:string|number;result:unknown}> {
  const request=requestSchema.parse(raw);
  if(!timingSafeEqual(Buffer.from(request.token),Buffer.from(token)))throw new Error('Unauthorized operator tool session');
  let params:unknown={};
  if(request.method==='tools/call'){
    if(!runId)throw new Error('Operator tools require an active task');
    const input=callSchema.parse(request.params);params={name:input.name,arguments:input.arguments??{},runId};
  }
  return {id:request.id,result:await forward(request.method,params)};
}

/** The agent sees a per-session tool credential, never the controller/worker secret. */
export async function createToolProxy(config:Config,runId?:string):Promise<{socketPath:string;token:string;close:()=>Promise<void>}> {
  if(!config.executionHome||!config.executionUid)throw new Error('Protected tool proxy requires a configured execution account.');
  const parent=trustedExecutionDirectory(config,'tool-proxies');
  const directory=mkdtempSync(join(parent,'session-'));chmodSync(directory,0o711);
  const socketPath=join(directory,'tools.sock'),token=randomBytes(32).toString('hex');
  const sockets=new Set<Socket>(),pending=new Set<Promise<void>>();let closing=false;
  const server=createServer(socket=>{
    if(closing){socket.destroy();return;}
    sockets.add(socket);socket.on('error',()=>{});socket.once('close',()=>sockets.delete(socket));
    socket.setEncoding('utf8');socket.setTimeout(120_000,()=>socket.destroy());let buffer='';
    socket.on('data',chunk=>{
      buffer+=chunk;
      if(Buffer.byteLength(buffer)>8_100_000){socket.destroy();return;}
      let end:number;
      while((end=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,end);buffer=buffer.slice(end+1);const operation=handle(line);pending.add(operation);void operation.finally(()=>pending.delete(operation));}
    });
    async function handle(line:string){
      let id:string|number|null=null;
      try{
        if(closing)throw new Error('The operator tool session is closing');
        const request=JSON.parse(line);id=request.id;
        const response=await forwardToolRequest(request,runId,token,(method,params)=>bridgeRequest(method,params,{socketPath:config.bridgeSocket,token:config.ipcToken}));
        if(!socket.destroyed)socket.write(JSON.stringify(response)+'\n');
      }catch(error){if(!socket.destroyed)socket.write(JSON.stringify({id,error:{message:error instanceof z.ZodError?'Invalid operator tool request':String((error as Error).message)}})+'\n');}
    }
  });
  try{
    await new Promise<void>((ok,no)=>{server.once('error',no);server.listen(socketPath,ok);});
    chmodSync(socketPath,0o600);chownSync(socketPath,config.executionUid,config.executionGid??-1);
  }catch(error){server.close();rmSync(directory,{recursive:true,force:true});throw error;}
  let shutdown:Promise<void>|undefined;
  return {socketPath,token,close:()=>shutdown??=(async()=>{
    closing=true;for(const socket of sockets)socket.destroy();
    await new Promise<void>((ok,no)=>server.close(error=>error?no(error):ok()));
    await Promise.allSettled([...pending]);rmSync(directory,{recursive:true,force:true});
  })()};
}
