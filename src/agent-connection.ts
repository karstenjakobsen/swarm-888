import { spawn, type ChildProcess } from 'node:child_process';
import { createRequire } from 'node:module';
import { openSync, closeSync, constants, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import type { Config } from './config.ts';
import { projectRoot } from './config.ts';
import { WorkerClient, type WorkerHealth } from './ipc.ts';
import { AgentConnectionSchema, type AgentConnection } from './agent-connection-schema.ts';
import type { Queue } from './queue.ts';
import { rootExecution } from './shared.ts';

const failure=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});

/** An authenticated observer connection; execution replay remains exclusively owned by Queue. */
export class AgentConnectionService {
  private client:WorkerClient;
  private connecting?:Promise<AgentConnection>;
  private starting?:Promise<AgentConnection>;
  private closed=false;
  private lastHealth?:WorkerHealth;
  private readonly onDisconnect=()=>{this.lastHealth=undefined;};
  constructor(private config:Config,private queue:Queue,client?:WorkerClient){
    this.client=client??new WorkerClient(config);
    this.client.on('disconnect',this.onDisconnect);
  }
  private launch(){
    const loader=createRequire(import.meta.url).resolve('tsx');
    const runtimePath=[join(projectRoot,'node_modules/.bin'),dirname(process.execPath),'/usr/local/sbin','/usr/local/bin','/usr/sbin','/usr/bin','/sbin','/bin'].join(':');
    const env=[`APP_STATE_DIR=${this.config.stateDir}`,`APP_CONTROLLER_UID=${this.config.controllerUid}`,'APP_REQUIRE_ROOT_WORKER=true',`CODEX_BIN=${this.config.codexBin}`,`PATH=${runtimePath}`,
      ...(this.config.projectsDir?[`APP_PROJECTS_DIR=${this.config.projectsDir}`]:[]),
      ...(this.config.allowTempState?['APP_ALLOW_TEMP_STATE=true']:[]),...(this.config.model?[`CODEX_MODEL=${this.config.model}`]:[])];
    const args=['env',...env,process.execPath,`--env-file-if-exists=${join(projectRoot,'.env')}`,'--import',loader,join(projectRoot,'src/root-worker.ts')];
    const quote=(value:string)=>`'${value.replaceAll("'","'\\''")}'`;
    return {args,command:['sudo','--',...args].map(quote).join(' ')};
  }
  private rootRequired(health:WorkerHealth){return this.config.requireRootWorker===true&&!rootExecution(health);}
  private safe(raw:unknown,health:WorkerHealth):AgentConnection {
    try{
      const value=raw as Record<string,unknown>;
      // Never forward runtime account objects, tokens, login IDs, or unknown fields.
      return AgentConnectionSchema.parse({
        state:value.state,workerConnected:true,workerUid:health.uid,
        ...(health.executionUid===undefined?{}:{executionUid:health.executionUid}),
        ...(value.state==='connecting'?{verificationUrl:value.verificationUrl,userCode:value.userCode,expiresAt:value.expiresAt}:{}),
        ...(typeof value.error==='string'?{error:value.error}:{}),
      });
    }catch{throw failure('The worker returned an invalid agent connection response.',502);}
  }
  private async request(method:string):Promise<AgentConnection>{
    const health=await this.client.connect();
    this.lastHealth=health;
    if(this.rootRequired(health)){
      if(method==='agent/connect')throw failure('A root worker is required. Start the root worker from Connect agent.',409);
      if(method==='agent/status')return {state:'error',workerConnected:true,workerUid:health.uid,executionUid:health.executionUid??health.uid,error:'The connected agent is not running as root. Stop the previous worker and launch the root worker from Connect agent.',rootWorkerCommand:this.launch().command};
    }
    let raw:unknown;
    try{raw=await this.client.request(method,{});}catch(error){
      if(String((error as Error).message).includes('Unsupported worker method'))throw failure('Restart the worker to enable browser sign-in for this update.',503);
      throw error;
    }
    const connection=this.safe(raw,health);
    if(connection.state==='connected'){
      await this.queue.tick();this.queue.emit('status');
    }
    return connection;
  }
  async status():Promise<AgentConnection>{
    try{return await this.request('agent/status');}
    catch(error){
      if((error as {statusCode?:number}).statusCode===502)throw error;
      if((error as {statusCode?:number}).statusCode===503&&this.lastHealth)return {state:'error',workerConnected:true,workerUid:this.lastHealth.uid,error:(error as Error).message,rootWorkerCommand:this.launch().command};
      this.client.close();
      const launch=this.launch();
      return {state:'disconnected',workerConnected:false,workerUid:null,error:'The root worker is unavailable. Start it here, or run the root worker command on the VPS.',rootWorkerCommand:launch.command};
    }
  }
  connect():Promise<AgentConnection>{
    if(this.connecting)return this.connecting;
    const release=this.queue.holdAuthentication();
    this.connecting=(async()=>{
      try{return await this.request('agent/connect');}
      catch(error){
        const code=(error as NodeJS.ErrnoException).code;
        if(code==='ENOENT'||code==='ECONNREFUSED')throw failure('Start the root worker before connecting your ChatGPT account.',503);
        throw error;
      }finally{release();this.connecting=undefined;}
    })();
    return this.connecting;
  }
  async cancel():Promise<AgentConnection>{
    const release=this.queue.holdAuthentication();
    try{return await this.request('agent/cancel');}finally{release();}
  }
  startWorker():Promise<AgentConnection>{
    if(this.starting)return this.starting;
    this.starting=this.launchWorker().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  private async launchWorker():Promise<AgentConnection>{
    const existing=await this.status();
    if(existing.workerConnected&&existing.workerUid===0){
      if((existing.executionUid??existing.workerUid)===0)return existing;
      throw failure('The existing worker launches agent commands as a non-root account. Stop it in its terminal and run the root worker command.',409);
    }
    if(this.lastHealth?.activeRunId||this.lastHealth?.uncertainRuns.length||this.lastHealth?.runtime.authenticating)throw failure('Finish or reconcile existing execution and cancel any pending sign-in before starting the root worker.',409);
    if(process.getuid?.()===0||process.getuid?.()!==this.config.controllerUid)throw failure('Start the web controller as its normal owner; it launches only the separate worker with root privileges.',403);
    if(this.closed)throw failure('The controller is shutting down.',503);
    const launch=this.launch();
    const log=openSync(join(this.config.stateDir,'worker/development.log'),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    let child:ChildProcess;
    try{
      child=spawn('sudo',['-n','--',...launch.args],{
        cwd:projectRoot,detached:true,
        env:process.env,
        stdio:['ignore',log,log],
      });
    }finally{closeSync(log);}
    let spawnError:Error|undefined;child.on('error',error=>{spawnError=error;});child.unref();
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline&&!this.closed){
      if(spawnError||child.exitCode!==null)throw failure('Root access requires a privileged launch on this host. Run the root-worker command shown in Connect agent in your VPS terminal, then retry. Your operating-system password is entered there.',503);
      if(existsSync(this.config.socketPath)){
        const connection=await this.status();
        if(connection.workerConnected&&connection.workerUid===0){await this.queue.tick();return connection;}
      }
      await new Promise(ok=>setTimeout(ok,100));
    }
    if(child.pid&&child.exitCode===null)child.kill('SIGTERM');
    throw failure('The root worker did not become available. Run the privileged command shown in Connect agent and check its terminal output.',503);
  }
  close(){this.closed=true;this.client.off('disconnect',this.onDisconnect);this.client.close();}
}
