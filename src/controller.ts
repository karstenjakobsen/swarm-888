import Fastify from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as NetServer } from 'node:net';
import { unlinkSync, existsSync, statSync, lstatSync, realpathSync, readdirSync, createReadStream, chmodSync } from 'node:fs';
import { join, relative, isAbsolute, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, projectRoot, type Config } from './config.ts';
import { Store } from './store.ts';
import { Queue } from './queue.ts';
import { Brain } from './brain/index.ts';
import { Id, PromptInput, ReplyInput, WireRequest, type AppEvent } from './shared.ts';
import { acquireLock } from './lock.ts';
import type { WorkerClient } from './ipc.ts';
import { AgentConnectionService } from './agent-connection.ts';

function equal(a:string,b:string){const x=createHash('sha256').update(a).digest(),y=createHash('sha256').update(b).digest();return timingSafeEqual(x,y);}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const safeId=(s:unknown)=>Id.parse(s);

export async function createController(config:Config, options:{client?:WorkerClient;agentClient?:WorkerClient;startQueue?:boolean;startBridge?:boolean}={}) {
  const app=Fastify({logger:false,bodyLimit:8_100_000,trustProxy:false});
  const store=new Store(config.stateDir),brain=new Brain(store.db,config.stateDir);
  await brain.initialize();
  const queue=new Queue(config,store,brain,options.client);
  const agentConnection=new AgentConnectionService(config,queue,options.agentClient??options.client);
  brain.setExecutor(spec=>queue.client.request('checkSkill',spec));
  let bridge:NetServer|undefined;
  let pendingTools=0;
  const streams=new Set<()=>void>();
  const attempts=new Map<string,{count:number;until:number}>();
  function redacted(value:unknown):any {
    if(typeof value==='string'){
      let text=value;
      for(const secret of [config.ipcToken,config.adminPassword,...Object.entries(process.env).filter(([key])=>/(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key)).map(([,value])=>value)])if(secret&&secret.length>=6){
        text=text.split(JSON.stringify(secret).slice(1,-1)).join('[REDACTED]');
        text=text.split(secret).join('[REDACTED]');
      }
      return text;
    }
    if(Array.isArray(value))return value.map(redacted);
    if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,entry])=>[key,redacted(entry)]));
    return value;
  }
  function memoryInput(value:unknown){if(JSON.stringify(value)!==JSON.stringify(redacted(value)))throw fail('Known credentials cannot be stored in searchable memory. Use server-side configuration.');return value;}
  function session(req:any){
    const raw=String(req.headers.cookie??'').split(';').map((s:string)=>s.trim()).find((s:string)=>s.startsWith('operator_session='))?.slice(17);
    if(!raw||!/^[a-f0-9]{64}$/.test(raw))return null;
    const entry=store.db.prepare('SELECT * FROM sessions WHERE hash=? AND expiresAt>?').get(hash(raw),Date.now()) as {hash:string;csrf:string;expiresAt:number}|undefined;
    return entry??null;
  }
  app.addHook('onRequest',async(req,reply)=>{
    if(!req.url.startsWith('/api/'))return;
    const origin=req.headers.origin;
    if(origin&&!config.origins.includes(origin))throw fail('Origin is not permitted',403);
    if(req.headers['sec-fetch-site']==='cross-site')throw fail('Cross-site access is not permitted',403);
    reply.header('cache-control','no-store').header('x-content-type-options','nosniff');
    if(req.method!=='GET'&&req.method!=='HEAD'&&(!origin||!config.origins.includes(origin)))throw fail('A configured Origin is required',403);
    if(req.url.split('?')[0]==='/api/login'||req.url.split('?')[0]==='/api/session')return;
    const current=session(req);if(!current)throw fail('Administrator login required',401);
    if(!['GET','HEAD'].includes(req.method)&&!equal(String(req.headers['x-csrf-token']??''),current.csrf))throw fail('CSRF token is missing or invalid',403);
  });
  app.setErrorHandler((error:any,_req,reply)=>{
    const status=error instanceof z.ZodError?400:(error.statusCode??400);
    reply.code(status).send({error:error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):String(error.message??'Operation failed')});
  });
  const writable=()=>{if(queue.maintenance&&!store.active())throw fail('Maintenance window: writes are paused',503);};
  app.get('/api/session',async req=>{const current=session(req);return {authenticated:Boolean(current),...(current?{csrfToken:current.csrf}:{})};});
  app.post('/api/login',async(req,reply)=>{
    const {password}=z.object({password:z.string().max(4096)}).parse(req.body);
    const now=Date.now();let limit=attempts.get(req.ip);
    if(!limit||limit.until<now){limit={count:0,until:now+60_000};attempts.set(req.ip,limit);}
    if(limit.count>=8)throw fail('Too many login attempts. Try again in one minute.',429);
    limit.count++;
    if(!equal(password,config.adminPassword)||!config.adminPassword)throw fail('Invalid administrator credential',401);
    attempts.delete(req.ip);
    const token=randomBytes(32).toString('hex'),csrf=randomBytes(32).toString('hex');
    store.db.prepare('DELETE FROM sessions WHERE expiresAt<?').run(now);
    store.db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token),csrf,now+12*3600_000);
    reply.header('set-cookie',`operator_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${config.secureCookie?'; Secure':''}`);
    return {csrfToken:csrf};
  });
  app.post('/api/logout',async(req,reply)=>{const current=session(req);if(current)store.db.prepare('DELETE FROM sessions WHERE hash=?').run(current.hash);reply.header('set-cookie','operator_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return {ok:true};});
  app.get('/api/status',async()=>queue.status());
  app.get('/api/agent/connection',async()=>agentConnection.status());
  app.post('/api/agent/connect',async req=>{z.object({}).strict().parse(req.body??{});return agentConnection.connect();});
  app.post('/api/agent/cancel',async req=>{z.object({}).strict().parse(req.body??{});return agentConnection.cancel();});
  app.post('/api/agent/worker',async req=>{z.object({}).strict().parse(req.body??{});return agentConnection.startWorker();});
  app.get('/api/conversations',async()=>store.conversations());
  app.post('/api/conversations',async req=>{writable();const body=z.object({title:z.string().trim().min(1).max(150).optional()}).parse(req.body??{});return store.newConversation(body.title);});
  app.get('/api/conversations/:id',async(req:any)=>{
    const id=safeId(req.params.id),conversation=store.conversation(id);if(!conversation)throw fail('Conversation not found',404);
    // Full durable history is paginated internally; the event stream uses the same cursor.
    const events:AppEvent[]=[];let after=0;
    while(true){const chunk=store.events(after,id);events.push(...chunk);if(chunk.length<2000)break;after=chunk.at(-1)!.seq;}
    return {conversation,messages:store.messages(id),runs:store.runs(id),events};
  });
  app.post('/api/conversations/:id/runs',async(req:any)=>{writable();const body=PromptInput.parse(req.body);const run=store.enqueue(safeId(req.params.id),body.prompt,body.requestId);setImmediate(()=>void queue.tick());return run;});
  app.post('/api/runs/:id/interrupt',async(req:any)=>queue.interrupt(safeId(req.params.id)));
  app.post('/api/runs/:id/reply',async(req:any)=>queue.reply(safeId(req.params.id),ReplyInput.parse(req.body)));
  app.post('/api/runs/:id/resolve',async(req:any)=>queue.resolve(safeId(req.params.id)));
  app.get('/api/memory',async(req:any)=>{const q=z.string().max(1000).parse(req.query.q??'');return brain.memorySearch(q,{project:req.query.project,category:req.query.category,tag:req.query.tag});});
  app.get('/api/memory/:id',async(req:any)=>{const found=brain.memoryGet(safeId(req.params.id));if(!found)throw fail('Memory entry not found',404);return found;});
  app.post('/api/memory',async req=>{writable();return brain.memoryWrite(memoryInput(req.body));});
  app.get('/api/instructions',async()=>({text:brain.getInstructions()}));
  app.put('/api/instructions',async req=>{writable();const {text}=z.object({text:z.string().max(4000)}).parse(req.body);brain.setInstructions(text);return {text:brain.getInstructions()};});
  app.get('/api/skills',async()=>brain.skillList());
  app.get('/api/skills/:name',async(req:any)=>{const found=brain.skillGet(safeId(req.params.name));if(!found)throw fail('Skill not found',404);return found;});
  app.post('/api/skills/:name/action',async(req:any)=>{writable();const body=z.object({action:z.enum(['activate','disable','retire','rollback']),version:z.union([z.string(),z.number().int().positive()]).optional()}).parse(req.body);return brain.skillAction(safeId(req.params.name),body.action,body.version===undefined?undefined:String(body.version));});
  app.get('/api/events',async(req:any,reply)=>{
    let cursor=z.coerce.number().int().min(0).parse(req.headers['last-event-id']??req.query.after??0);
    reply.hijack();const res=reply.raw;
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
    const send=(event:AppEvent)=>{if(event.seq<=cursor)return;if(res.writableLength>1_000_000){res.end();return;}res.write(`id: ${event.seq}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`);cursor=event.seq;};
    store.on('event',send);
    while(true){const events=store.events(cursor);events.forEach(send);if(events.length<2000)break;}
    const sendStatus=()=>res.write(`event: status\ndata: ${JSON.stringify(queue.status())}\n\n`);
    queue.on('status',sendStatus);sendStatus();
    const heartbeat=setInterval(()=>{if(!session(req))res.end();else res.write(': heartbeat\n\n');},15_000);heartbeat.unref();
    const cleanup=()=>{clearInterval(heartbeat);store.off('event',send);queue.off('status',sendStatus);streams.delete(end);};
    const end=()=>{cleanup();res.end();};streams.add(end);res.on('close',cleanup);
  });
  const artifacts=join(config.stateDir,'artifacts');
  function artifactRoot(){if(lstatSync(artifacts).isSymbolicLink()||realpathSync(artifacts)!==artifacts)throw fail('Artifact root has changed or is not a canonical directory',403);return artifacts;}
  app.get('/api/artifacts',async()=>{
    artifactRoot();
    const files:Array<{path:string;size:number}>=[];
    function visit(dir:string){for(const e of readdirSync(dir,{withFileTypes:true})){if(files.length>=1000)return;const path=join(dir,e.name);if(e.isDirectory())visit(path);else if(e.isFile())files.push({path:relative(artifacts,path),size:statSync(path).size});}}
    visit(artifacts);return files;
  });
  app.get('/api/artifacts/*',async(req:any,reply)=>{
    artifactRoot();
    const target=String(req.params['*']);
    if(isAbsolute(target)||target.split(/[\\/]/).includes('..')||target.includes('\0'))throw fail('Invalid artifact path',403);
    let path:string;try{path=realpathSync(join(artifacts,target));}catch{throw fail('Artifact not found',404);}
    const rel=relative(realpathSync(artifacts),path);if(rel.startsWith('..')||isAbsolute(rel)||!statSync(path).isFile())throw fail('Artifact is outside the allowed root',403);
    reply.header('content-type','application/octet-stream').header('content-disposition',`attachment; filename="${encodeURIComponent(target.split('/').at(-1)!)}"`);
    return reply.send(createReadStream(path));
  });
  app.get('/*',async(req,reply)=>{
    if(req.url.startsWith('/api/'))throw fail('API route not found',404);
    const root=join(projectRoot,'dist/web');let path=resolve(root,req.url.split('?')[0].replace(/^\//,''));
    if(!path.startsWith(root+'/')&&path!==root)throw fail('Not found',404);
    if(!existsSync(path)||!statSync(path).isFile())path=join(root,'index.html');
    if(!existsSync(path))return reply.code(404).send({error:'Frontend is not built. Use npm run dev, or npm run build first.'});
    const mime:Record<string,string>={'.html':'text/html; charset=utf-8','.js':'text/javascript','.css':'text/css','.svg':'image/svg+xml'};
    reply.header('content-type',mime[extname(path)]??'application/octet-stream').header('x-content-type-options','nosniff');return reply.send(createReadStream(path));
  });
  if(options.startBridge!==false){
    if(existsSync(config.bridgeSocket)){
      if(!lstatSync(config.bridgeSocket).isSocket())throw new Error('Refusing to replace a non-socket MCP bridge path');
      unlinkSync(config.bridgeSocket);
    }
    bridge=createServer(socket=>{
      socket.setEncoding('utf8');
      let buffer='';socket.setTimeout(120_000,()=>socket.destroy());socket.on('error',()=>{});
      socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>8_100_000){socket.destroy();return;}
        let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);void handle(line);}
      });
      async function handle(line:string){let id:unknown=null;try{
        const msg=WireRequest.parse(JSON.parse(line));id=msg.id;
        if(!equal(msg.token,config.ipcToken))throw new Error('Unauthorized bridge request');
        if(msg.method==='tools/list'){socket.write(JSON.stringify({id,result:{tools:brain.listTools()}})+'\n');return;}
        if(msg.method!=='tools/call')throw new Error('Unsupported bridge method');
        const params=z.object({name:z.string().max(100),arguments:z.unknown().optional(),runId:Id}).parse(msg.params);
        const run=store.run(params.runId);if(!run||!['running','waiting'].includes(run.status))throw new Error('Tool caller is not an active run');
        writable();pendingTools++;
        try{
          const arguments_=params.name==='memory_write'?memoryInput(params.arguments??{}):params.arguments??{};
          const result=await brain.callTool(params.name,arguments_,{runId:run.id,conversationId:run.conversationId});
          store.addEvent('tool',redacted({name:params.name,result}),run.id);
          socket.write(JSON.stringify({id,result:redacted(result)})+'\n');
        }finally{pendingTools--;}
      }catch(error){socket.write(JSON.stringify(redacted({id,error:{message:String((error as Error).message)}}))+'\n');}}
    });
    await new Promise<void>((ok,no)=>{bridge!.once('error',no);bridge!.listen(config.bridgeSocket,ok);});
    chmodSync(config.bridgeSocket,0o600);
  }
  if(options.startQueue!==false)await queue.start();
  const close=async()=>{for(const end of streams)end();agentConnection.close();queue.close();if(bridge)await new Promise<void>(ok=>bridge!.close(()=>ok()));if(existsSync(config.bridgeSocket))unlinkSync(config.bridgeSocket);await app.close();store.close();};
  return {app,store,brain,queue,agentConnection,close,get pendingTools(){return pendingTools;}};
}

async function main(){
  if(process.getuid?.()===0)throw new Error('Run the controller and frontend as a normal user; launch only the worker as root.');
  const config=loadConfig({requireAdmin:true});const release=acquireLock(join(config.stateDir,'controller.lock'));
  try{
    const controller=await createController(config);
    await controller.app.listen({host:config.host,port:config.port});
    console.log(`Controller listening on http://${config.host}:${config.port}; persistent state ${config.stateDir}`);
    let closing=false;const stop=async()=>{if(closing)return;closing=true;await controller.close();release();};
    process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  }catch(error){release();throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
