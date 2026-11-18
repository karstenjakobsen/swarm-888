import Fastify from 'fastify';
import { z } from 'zod';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { createServer, type Server as NetServer, type Socket } from 'node:net';
import { unlinkSync, existsSync, statSync, lstatSync, realpathSync, readdirSync, createReadStream, chmodSync } from 'node:fs';
import { join, relative, isAbsolute, extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig, projectRoot, type Config } from './config.ts';
import { Store } from './store.ts';
import { Queue } from './queue.ts';
import { Brain } from './brain/index.ts';
import { Id, ReplyInput, ResolveInput, WireRequest, type AppEvent } from './shared.ts';
import { acquireLock } from './lock.ts';
import type { WorkerClient } from './ipc.ts';
import { AgentConnectionService } from './agent-connection.ts';
import { toolSchemas } from './brain/schemas.ts';
import { ProjectService } from './projects/service.ts';
import { ManagedService } from './managed/service.ts';
import { ConnectorService } from './connectors/service.ts';
import { RuntimeReceipts } from './runtime-receipts.ts';
import { CredentialVault } from './credentials/vault.ts';
import { registerCredentialRoutes,oauthCallbackPath } from './credentials/routes.ts';
import { JobService } from './jobs/service.ts';
import { TaskService } from './tasks/service.ts';
import { createPlatformTools } from './tasks/tools.ts';
import { ownWorkerConfig } from './workers/config.ts';
import { WorkerModelCatalogService } from './workers/models.ts';
import { registerProjectEnvironmentRoutes } from './projects/environment.ts';
import { registerPackageRoutes } from './packages/routes.ts';

function equal(a:string,b:string){const x=createHash('sha256').update(a).digest(),y=createHash('sha256').update(b).digest();return timingSafeEqual(x,y);}
const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const safeId=(s:unknown)=>Id.parse(s);

export async function createController(config:Config, options:{client?:WorkerClient;agentClient?:WorkerClient;startQueue?:boolean;startBridge?:boolean}={}) {
  const app=Fastify({logger:false,bodyLimit:8_100_000,trustProxy:false});
  const knownSecrets=[config.ipcToken,config.adminPassword,...Object.entries(process.env).filter(([key])=>/(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key)).map(([,value])=>value)].filter((value):value is string=>Boolean(value&&value.length>=6));
  const store=new Store(config.stateDir),vault=new CredentialVault(config.stateDir,store.db,knownSecrets),brain=new Brain(store.db,config.stateDir);
  store.setRedactor(value=>vault.redact(value));brain.setSecretGuard(value=>vault.assertSafe(value));
  brain.setTaskContext(()=>store.recentWork());
  try{await brain.initialize();}catch(error){store.close();await app.close();throw error;}
  const queue=new Queue(config,store,brain,options.client);
  const workerModels=new WorkerModelCatalogService(config,queue.registry);
  const agentConnection=new AgentConnectionService(config,queue,options.agentClient??options.client);
  const projects=new ProjectService(config,store,queue.client,()=>Boolean(queue.health));
  const receipts=new RuntimeReceipts(store.db,queue.client,config.projectsDir??join(config.stateDir,'projects'),queue.registry);
  const managed=new ManagedService(config,store,projects,queue.client,receipts);
  managed.repository.setSecretGuard(value=>vault.assertSafe(value));
  managed.packages.setSecretGuard(value=>vault.assertSafe(value));
  const connectors=new ConnectorService(store,queue.client,projects,managed,receipts,vault);
  const tasks=new TaskService(store,queue,projects,connectors,value=>vault.assertSafe(value));
  queue.setTaskInheritance((parent,options)=>{tasks.checkTree(parent);return tasks.inherited(parent,options);});
  const jobs=new JobService(store,projects,(input,prompt)=>tasks.validate(input,prompt));
  const workerConnections=new Map<string,AgentConnectionService>();
  const workerConnection=(id:string)=>{let connection=workerConnections.get(id);if(!connection){connection=new AgentConnectionService(ownWorkerConfig(config,queue.registry.get(id)),queue,queue.registry.client(id));workerConnections.set(id,connection);}return connection;};
  queue.setManaged(managed,connectors,receipts);
  const registration=brain.setManaged(managed,connectors);
  brain.setProjects(projects);
  brain.setExecutor(spec=>queue.client.request('checkSkill',spec));
  brain.setArtifactPublisher(input=>queue.client.request('artifacts/publish',input));
  brain.setPlatformTools(createPlatformTools(store,queue,tasks,jobs));
  let bridge:NetServer|undefined;
  let bridgeOwned=false;
  const bridgeSockets=new Set<Socket>();
  const toolCalls=new Set<Promise<void>>();
  let closing=false;
  let pendingTools=0;
  const pendingToolRuns=new Map<string,number>();
  const resourceRequests=new Set<string>();
  const streams=new Set<()=>void>();
  const attempts=new Map<string,{count:number;until:number}>();
  const redacted=(value:unknown)=>vault.redact(value);
  function memoryInput(value:unknown){if(JSON.stringify(value)!==JSON.stringify(redacted(value)))throw fail('Known credentials cannot be stored in searchable memory. Use server-side configuration.');return value;}
  function session(req:any){
    const raw=String(req.headers.cookie??'').split(';').map((s:string)=>s.trim()).find((s:string)=>s.startsWith('operator_session='))?.slice(17);
    if(!raw||!/^[a-f0-9]{64}$/.test(raw))return null;
    return store.session(hash(raw))??null;
  }
  app.addHook('onRequest',async(req,reply)=>{
    if(closing)throw fail('The controller is shutting down',503);
    if(!req.url.startsWith('/api/'))return;
    if(req.method==='GET'&&req.url.split('?')[0]===oauthCallbackPath){reply.header('cache-control','no-store').header('referrer-policy','no-referrer');return;}
    const eventPath=/^\/api\/job-events\/([0-9a-f-]{36})$/.exec(req.url.split('?')[0]!);
    if(req.method==='POST'&&eventPath){if(req.headers.origin&&!config.origins.includes(req.headers.origin))throw fail('Origin is not permitted',403);jobs.authenticateTrigger(eventPath[1]!,req.headers.authorization);reply.header('cache-control','no-store');return;}
    const origin=req.headers.origin;
    if(origin&&!config.origins.includes(origin))throw fail('Origin is not permitted',403);
    if(req.headers['sec-fetch-site']==='cross-site')throw fail('Cross-site access is not permitted',403);
    reply.header('cache-control','no-store').header('x-content-type-options','nosniff');
    if(req.method!=='GET'&&req.method!=='HEAD'&&(!origin||!config.origins.includes(origin)))throw fail('A configured Origin is required',403);
    if(req.url.split('?')[0]==='/api/login'||req.url.split('?')[0]==='/api/session')return;
    const current=session(req);if(!current)throw fail('Administrator login required',401);
    if(!['GET','HEAD'].includes(req.method)&&!equal(String(req.headers['x-csrf-token']??''),current.csrf))throw fail('CSRF token is missing or invalid',403);
  });
  app.addHook('onRoute',route=>{
    if(!/^\/api\/(projects|connectors|repositories|packages)(?:\/|$)/.test(route.url))return;
    const handler=route.handler;
    route.handler=async function(req,reply){
      resourceRequests.add(req.id);
      try{return await handler.call(this,req,reply);}finally{resourceRequests.delete(req.id);}
    };
  });
  app.addHook('preHandler',async request=>{
    const path=request.url.split('?')[0]!;
    const acceptsSecrets=path==='/api/login'||/^\/api\/credentials(?:\/[^/]+)?$/.test(path)||/^\/api\/connectors\/[^/]+\/oauth\/start$/.test(path);
    if(!acceptsSecrets&&!['GET','HEAD'].includes(request.method)&&request.body!==undefined)vault.assertSafe(request.body);
  });
  app.setErrorHandler((error:any,_req,reply)=>{
    const status=error instanceof z.ZodError?400:(error.statusCode??400);
    reply.code(status).send({error:redacted(error instanceof z.ZodError?error.issues.map(i=>`${i.path.join('.')}: ${i.message}`).join('; '):String(error.message??'Operation failed'))});
  });
  const writable=()=>{if(queue.maintenance&&!store.active())throw fail('Maintenance window: writes are paused',503);};
  registerCredentialRoutes(app,{vault,connectors,config,session,writable});
  registerProjectEnvironmentRoutes(app,{vault,projects,store,writable});
  registerPackageRoutes(app,{packages:managed.packages,registration,writable});
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
    store.createSession(hash(token),csrf,now+12*3600_000,now);
    reply.header('set-cookie',`operator_session=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=43200${config.secureCookie?'; Secure':''}`);
    return {csrfToken:csrf};
  });
  app.post('/api/logout',async(req,reply)=>{const current=session(req);if(current)store.deleteSession(current.hash);reply.header('set-cookie','operator_session=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0');return {ok:true};});
  app.get('/api/status',async()=>queue.status());
  app.get('/api/worker-models',async()=>redacted(await workerModels.list()));
  app.get('/api/workers',async()=>{await queue.registry.refreshAll();return queue.workerStatuses();});
  app.post('/api/workers',async req=>{writable();const worker=queue.registry.register(req.body);return queue.registry.status(worker.id);});
  app.patch('/api/workers/:id',async(req:any)=>{writable();queue.registry.update(req.params.id,req.body);return queue.registry.status(req.params.id);});
  app.get('/api/workers/:id/commands',async(req:any)=>({command:queue.registry.command(req.params.id)}));
  app.post('/api/workers/:id/drain',async(req:any)=>{writable();const {draining}=z.object({draining:z.boolean()}).strict().parse(req.body);queue.registry.drain(req.params.id,draining);return queue.registry.status(req.params.id);});
  app.get('/api/workers/:id/connection',async(req:any)=>workerConnection(req.params.id).status());
  for(const action of ['connect','cancel','start'] as const)app.post(`/api/workers/:id/${action}`,async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});const connection=workerConnection(req.params.id);return action==='start'?connection.startWorker():connection[action]();});
  app.get('/api/runs',async(req:any)=>{const input=z.object({parentRunId:Id.optional()}).parse(req.query);return tasks.list(input.parentRunId);});
  app.get('/api/runs/:id',async(req:any)=>tasks.get(safeId(req.params.id)));
  app.get('/api/jobs',async()=>jobs.list());
  app.post('/api/jobs',async req=>{writable();vault.assertSafe(req.body);return jobs.create(req.body);});
  app.get('/api/jobs/:id',async(req:any)=>jobs.get(safeId(req.params.id)));
  app.patch('/api/jobs/:id',async(req:any)=>{writable();vault.assertSafe(req.body);return jobs.update(safeId(req.params.id),req.body);});
  app.delete('/api/jobs/:id',async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});return jobs.remove(safeId(req.params.id));});
  for(const action of ['pause','resume','run'] as const)app.post(`/api/jobs/:id/${action}`,async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});const result=action==='run'?jobs.run(safeId(req.params.id)):jobs.update(safeId(req.params.id),{enabled:action==='resume'});setImmediate(()=>void queue.tick());return result;});
  app.post('/api/jobs/:id/trigger',async(req:any)=>{writable();const input=z.object({eventId:Id,input:z.unknown().optional()}).strict().parse(req.body);vault.assertSafe(input);const run=jobs.trigger(safeId(req.params.id),input.eventId,input.input);setImmediate(()=>void queue.tick());return run;});
  app.post('/api/jobs/:id/trigger-token',async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});const id=safeId(req.params.id),job=jobs.get(id),token=randomBytes(32).toString('base64url'),credential=vault.create({name:`${job.name.slice(0,92)} event trigger`,values:{token}});jobs.issueTriggerToken(id,token);return {token,credential,endpoint:`/api/job-events/${id}`};});
  app.post('/api/job-events/:id',async(req:any)=>{writable();const input=z.object({eventId:Id,input:z.unknown().optional()}).strict().parse(req.body);vault.assertSafe(input);const run=jobs.trigger(safeId(req.params.id),input.eventId,input.input);setImmediate(()=>void queue.tick());return {runId:run.id,status:run.status};});
  app.get('/api/runtime-receipts',async()=>redacted(receipts.list()));
  app.get('/api/runtime-receipts/:id',async(req:any)=>redacted(receipts.get(safeId(req.params.id))));
  app.get('/api/agent/connection',async()=>agentConnection.status());
  app.post('/api/agent/connect',async req=>{z.object({}).strict().parse(req.body??{});return agentConnection.connect();});
  app.post('/api/agent/cancel',async req=>{z.object({}).strict().parse(req.body??{});return agentConnection.cancel();});
  app.post('/api/agent/worker',async req=>{z.object({}).strict().parse(req.body??{});return agentConnection.startWorker();});
  app.get('/api/projects',async()=>projects.list());
  app.post('/api/projects',async req=>{writable();return managed.createProject(req.body);});
  app.get('/api/projects/:id',async(req:any)=>projects.get(req.params.id));
  app.patch('/api/projects/:id',async(req:any)=>{writable();return projects.update(req.params.id,req.body);});
  app.delete('/api/projects/:id',async(req:any)=>{
    writable();z.object({}).strict().parse(req.body===undefined?{}:req.body);
    if([...resourceRequests].some(id=>id!==req.id))throw fail('Wait for other project and connection requests to finish before removing a project.',409);
    const workers=[queue.health,...queue.workerStatuses().map(status=>status.health)];
    if(pendingTools||store.active()||workers.some(health=>health?.activeRunId||health?.uncertainRuns?.length||health?.runtimeOperations?.length))throw fail('Finish or reconcile active execution and tool operations before removing a project.',409);
    return projects.remove(req.params.id);
  });
  app.post('/api/projects/:id/components',async(req:any)=>{writable();return projects.addComponent(req.params.id,req.body);});
  app.patch('/api/projects/:id/components/:componentId',async(req:any)=>{writable();return projects.updateComponent(req.params.id,req.params.componentId,req.body);});
  app.post('/api/projects/:id/refresh',async(req:any)=>{z.object({}).strict().parse(req.body??{});return managed.refreshProject(req.params.id);});
  app.get('/api/projects/:id/components/:componentId/logs',async(req:any)=>redacted(await projects.logs(req.params.id,req.params.componentId)));
  app.post('/api/projects/:id/conversations',async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});return projects.newConversation(req.params.id);});
  const sourceWritable=(id:string)=>{writable();projects.get(id);if(store.db.prepare('SELECT 1 FROM project_leases WHERE projectId=?').get(id)||store.runs().some(run=>['running','waiting','uncertain'].includes(run.status)&&store.projects.forConversation(run.conversationId)?.id===id))throw fail('Finish or reconcile the active project task before changing source from the UI.',409);};
  app.post('/api/projects/:id/source',async(req:any)=>{sourceWritable(req.params.id);return managed.createSource(req.params.id,req.body??{});});
  app.post('/api/projects/:id/source/migrate',async(req:any)=>{sourceWritable(req.params.id);return managed.migrateSource(req.params.id,z.object({repositoryId:z.string().uuid(),packagePath:z.string().min(1).max(500)}).strict().parse(req.body));});
  app.get('/api/projects/:id/source',async(req:any)=>managed.readSource(req.params.id));
  app.put('/api/projects/:id/source',async(req:any)=>{sourceWritable(req.params.id);return managed.writeSource(req.params.id,req.body);});
  app.post('/api/projects/:id/source/commit',async(req:any)=>{sourceWritable(req.params.id);return managed.commitSource(req.params.id,req.body??{});});
  app.post('/api/projects/:id/deploy',async(req:any)=>{sourceWritable(req.params.id);z.object({}).strict().parse(req.body??{});return managed.deploy(req.params.id);});
  app.get('/api/projects/:id/deployment',async(req:any)=>managed.deploymentAction(req.params.id,'status'));
  app.post('/api/projects/:id/deployment/stop',async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});return managed.deploymentAction(req.params.id,'stop');});
  app.get('/api/projects/:id/deployment/logs',async(req:any)=>redacted(await managed.deploymentAction(req.params.id,'logs')));
  app.put('/api/projects/:id/connectors',async(req:any)=>{writable();return connectors.assign(req.params.id,req.body);});
  app.get('/api/connectors',async()=>connectors.list());
  app.post('/api/connectors',async req=>{writable();return connectors.create(req.body);});
  app.post('/api/connectors/examples',async req=>{writable();return connectors.createExample(req.body);});
  app.get('/api/connectors/:id',async(req:any)=>connectors.get(req.params.id));
  app.patch('/api/connectors/:id',async(req:any)=>{writable();return connectors.update(req.params.id,req.body);});
  app.post('/api/connectors/:id/test',async(req:any)=>{writable();z.object({}).strict().parse(req.body??{});return connectors.test(req.params.id);});
  app.post('/api/connectors/:id/call',async(req:any)=>{writable();return redacted(await connectors.call(req.params.id,req.body));});
  app.get('/api/conversations',async()=>store.conversations());
  app.post('/api/conversations',async req=>{writable();const body=z.object({title:z.string().trim().min(1).max(150).optional()}).parse(req.body??{});return store.newConversation(body.title);});
  app.delete('/api/conversations/:id',async(req:any)=>{
    writable();z.object({}).strict().parse(req.body===undefined?{}:req.body);
    return store.removeConversation(safeId(req.params.id),[...pendingToolRuns.keys()]);
  });
  app.get('/api/conversations/:id',async(req:any)=>{
    const id=safeId(req.params.id),conversation=store.conversation(id);if(!conversation)throw fail('Conversation not found',404);
    // Full durable history is paginated internally; the event stream uses the same cursor.
    const events:AppEvent[]=[];let after=0;
    while(true){const chunk=store.events(after,id);events.push(...chunk);if(chunk.length<2000)break;after=chunk.at(-1)!.seq;}
    return {conversation,messages:store.messages(id),runs:store.runs(id),events};
  });
  app.post('/api/conversations/:id/runs',async(req:any)=>{writable();return tasks.submit(safeId(req.params.id),req.body);});
  app.post('/api/runs/:id/interrupt',async(req:any)=>queue.interrupt(safeId(req.params.id)));
  app.post('/api/runs/:id/reply',async(req:any)=>queue.reply(safeId(req.params.id),ReplyInput.parse(req.body)));
  app.post('/api/runs/:id/resolve',async(req:any)=>queue.resolve(safeId(req.params.id),ResolveInput.parse(req.body??{})));
  app.get('/api/memory',async(req:any)=>{const q=z.string().max(1000).parse(req.query.q??'');return brain.memorySearch(q,{project:req.query.project,category:req.query.category,tag:req.query.tag});});
  app.get('/api/memory/:id',async(req:any)=>{const found=brain.memoryGet(safeId(req.params.id));if(!found)throw fail('Memory entry not found',404);return found;});
  app.post('/api/memory',async req=>{writable();return brain.memoryWrite(memoryInput(req.body));});
  app.get('/api/instructions',async()=>({text:brain.getInstructions()}));
  app.put('/api/instructions',async req=>{writable();const {text}=z.object({text:z.string().max(4000)}).parse(req.body);brain.setInstructions(text);return {text:brain.getInstructions()};});
  app.get('/api/skills',async()=>brain.skillList());
  app.get('/api/skills/:name',async(req:any)=>{const found=brain.skillGet(safeId(req.params.name));if(!found)throw fail('Skill not found',404);return found;});
  app.post('/api/skills/:name/action',async(req:any)=>{writable();const body=toolSchemas.skill_action.parse({...req.body,name:req.params.name});return brain.skillAction(body.name,body.action,body.version);});
  app.get('/api/events',async(req:any,reply)=>{
    let cursor=z.coerce.number().int().min(0).parse(req.headers['last-event-id']??req.query.after??0);
    reply.hijack();const res=reply.raw;
    res.writeHead(200,{'content-type':'text/event-stream','cache-control':'no-cache, no-transform','connection':'keep-alive','x-accel-buffering':'no','x-content-type-options':'nosniff'});
    const write=(frame:string)=>{
      if(res.destroyed||res.writableEnded)return false;
      if(res.writableLength>1_000_000){end();return false;}
      res.write(frame);return true;
    };
    const send=(event:AppEvent)=>{if(event.seq<=cursor)return true;if(!write(`id: ${event.seq}\nevent: event\ndata: ${JSON.stringify(event)}\n\n`))return false;cursor=event.seq;return true;};
    const sendStatus=()=>write(`event: status\ndata: ${JSON.stringify(queue.status())}\n\n`);
    const heartbeat=setInterval(()=>{if(!session(req))end();else write(': heartbeat\n\n');},15_000);heartbeat.unref();
    const cleanup=()=>{clearInterval(heartbeat);store.off('event',send);queue.off('status',sendStatus);streams.delete(end);};
    const end=()=>{cleanup();if(!res.writableEnded)res.end();};streams.add(end);res.on('close',cleanup);
    store.on('event',send);queue.on('status',sendStatus);
    while(!res.destroyed&&!res.writableEnded){const events=store.events(cursor);if(!events.every(send)||events.length<2000)break;}
    sendStatus();
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
  let closePromise:Promise<void>|undefined;
  const close=()=>closePromise??=(async()=>{
    closing=true;
    for(const end of streams)end();
    projects.close();agentConnection.close();queue.close();
    jobs.close();for(const connection of workerConnections.values())connection.close();
    await queue.drainSource();
    for(const socket of bridgeSockets)socket.destroy();
    if(bridge?.listening)await new Promise<void>((ok,no)=>bridge!.close(error=>error?no(error):ok()));
    await Promise.allSettled([...toolCalls]);
    if(bridgeOwned&&existsSync(config.bridgeSocket))unlinkSync(config.bridgeSocket);
    await app.close();store.close();
  })();
  try{
  if(options.startBridge!==false){
    if(existsSync(config.bridgeSocket)){
      if(!lstatSync(config.bridgeSocket).isSocket())throw new Error('Refusing to replace a non-socket MCP bridge path');
      unlinkSync(config.bridgeSocket);
    }
    bridge=createServer(socket=>{
      if(closing){socket.destroy();return;}
      bridgeSockets.add(socket);socket.once('close',()=>bridgeSockets.delete(socket));
      socket.setEncoding('utf8');
      let buffer='';socket.setTimeout(120_000,()=>socket.destroy());socket.on('error',()=>{});
      socket.on('data',chunk=>{buffer+=chunk.toString();if(buffer.length>8_100_000){socket.destroy();return;}
        let pos;while((pos=buffer.indexOf('\n'))>=0){const line=buffer.slice(0,pos);buffer=buffer.slice(pos+1);const call=handle(line);toolCalls.add(call);void call.finally(()=>toolCalls.delete(call));}
      });
      async function handle(line:string){let id:unknown=null;try{
        if(closing)throw new Error('The controller is shutting down');
        const msg=WireRequest.parse(JSON.parse(line));id=msg.id;
        if(!equal(msg.token,config.ipcToken))throw new Error('Unauthorized bridge request');
        if(msg.method==='tools/list'){if(!socket.destroyed)socket.write(JSON.stringify({id,result:{tools:brain.listTools()}})+'\n');return;}
        if(msg.method!=='tools/call')throw new Error('Unsupported bridge method');
        const params=z.object({name:z.string().max(100),arguments:z.unknown().optional(),runId:Id}).parse(msg.params);
        const run=store.run(params.runId);if(!run||!['running','waiting'].includes(run.status))throw new Error('Tool caller is not an active run');
        if(['project_deploy','project_deployment_stop'].includes(params.name)&&!tasks.rootGranted(run)&&!(run.assignedWorkerId==='default'&&config.requireRootWorker))throw fail('This task was not granted root host operations',403);
        const args=(params.arguments??{}) as Record<string,unknown>,project=store.projects.forConversation(run.conversationId);
        const granted=run.attemptId?run.grantedConnectorIds??[]:run.connectionScope==='explicit'?run.requiredConnectorIds??[]:store.connectors.assigned(project?.id??'',true);
        const target=args.projectId??(params.name.startsWith('project_')?args.id:undefined);
        if(project&&typeof target==='string'&&target!==project.id)throw fail('Project tools are scoped to the current task project',403);
        if(project&&params.name==='package_create'&&args.repositoryId!==project.source?.repositoryId)throw fail('Create packages in the repository assigned to this project, or use a generic conversation.',403);
        if(project&&params.name==='repository_import')throw fail('Import repository packages from a generic conversation or the Repositories UI; this task is scoped to its existing project.',403);
        if(['connector_call','connector_test','connector_update'].includes(params.name)&&typeof args.id==='string'&&!granted.includes(args.id))throw fail('This connection is outside the task grant',403);
        if(params.name==='project_connectors'&&Array.isArray(args.connectorIds)&&args.connectorIds.some(id=>!granted.includes(String(id))))throw fail('Project assignments cannot expand the accepted task connection grant',403);
        const charged=store.db.prepare("UPDATE runs SET toolCalls=toolCalls+1 WHERE id=? AND toolCalls<maxToolCalls AND status IN ('running','waiting')").run(run.id);
        if(Number(charged.changes)!==1){void queue.interrupt(run.id).catch(()=>{});throw fail('The task operator-tool call limit was reached',409);}
        writable();pendingTools++;pendingToolRuns.set(run.id,(pendingToolRuns.get(run.id)??0)+1);
        try{
          const arguments_=params.name==='memory_write'?memoryInput(params.arguments??{}):params.arguments??{};
          const result=await queue.registry.withWorker(run.assignedWorkerId??'default',()=>brain.callTool(params.name,arguments_,{runId:run.id,conversationId:run.conversationId,workerId:run.assignedWorkerId??'default',attemptId:run.attemptId??undefined}));
          const registeredConnection=params.name==='package_create'?result?.connection:
            ['connector_register','connector_register_project'].includes(params.name)?result:undefined;
          if(run.connectionScope==='project'&&!run.parentRunId&&typeof registeredConnection?.id==='string'){
            const connection=connectors.get(registeredConnection.id);
            if(!connection.auth&&Date.parse(connection.createdAt)>=Date.parse(run.startedAt??run.createdAt))store.db.prepare('UPDATE runs SET grantedConnectorIds=? WHERE id=?').run(JSON.stringify([...new Set([...(store.run(run.id)?.grantedConnectorIds??[]),connection.id])]),run.id);
          }
          const historyResult=params.name.startsWith('project_source_')&&result&&typeof result==='object'&&'files' in result?{...result,files:undefined}:result;
          store.addEvent('tool',redacted({name:params.name,result:historyResult}),run.id);
          if(!socket.destroyed)socket.write(JSON.stringify({id,result:redacted(result)})+'\n');
        }finally{pendingTools--;const remaining=(pendingToolRuns.get(run.id)??1)-1;if(remaining)pendingToolRuns.set(run.id,remaining);else pendingToolRuns.delete(run.id);}
      }catch(error){if(!socket.destroyed)socket.write(JSON.stringify(redacted({id,error:{message:String((error as Error).message)}}))+'\n');}}
    });
    await new Promise<void>((ok,no)=>{bridge!.once('error',no);bridge!.listen(config.bridgeSocket,ok);});
    bridgeOwned=true;chmodSync(config.bridgeSocket,0o600);
  }
  if(options.startQueue!==false){jobs.start();await queue.start();}

  return {app,store,brain,queue,agentConnection,projects,managed,connectors,vault,tasks,jobs,close,get pendingTools(){return pendingTools;}};
  }catch(error){await close();throw error;}
}

async function main(){
  if(process.getuid?.()===0)throw new Error('Run the controller and frontend as a normal user; launch only the worker as root.');
  const config=loadConfig({requireAdmin:true});const release=acquireLock(join(config.stateDir,'controller.lock'));
  let close:(()=>Promise<void>)|undefined;
  try{
    const controller=await createController(config);close=controller.close;
    await controller.app.listen({host:config.host,port:config.port});
    console.log(`Controller listening on http://${config.host}:${config.port}; persistent state ${config.stateDir}`);
    let closing=false;const stop=async()=>{if(closing)return;closing=true;await controller.close();release();};
    process.once('SIGTERM',()=>void stop());process.once('SIGINT',()=>void stop());
  }catch(error){try{await close?.();}finally{release();}throw error;}
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href)main().catch(error=>{console.error(error.message);process.exitCode=1;});
