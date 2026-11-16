import { spawn, type ChildProcess } from 'node:child_process';
import { openSync, closeSync, constants, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { Config } from './config.ts';
import { projectRoot } from './config.ts';
import { WorkerClient, type WorkerHealth } from './ipc.ts';
import { AgentConnectionSchema, type AgentConnection } from './agent-connection-schema.ts';
import type { Queue } from './queue.ts';
import { rootExecution } from './shared.ts';
import { workerLaunch } from './worker-launch.ts';

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
  private launch(){return workerLaunch(this.config);}
  private rootRequired(health:WorkerHealth){return this.config.requireRootWorker===true&&!rootExecution(health);}
  private projectDirectoryMismatch():string|undefined {
    const expected=resolve(this.config.projectsDir??join(this.config.stateDir,'projects')),reported=this.lastHealth?.projectsDir;
    if(reported===expected)return;
    return `The worker project directory does not match this controller: expected APP_PROJECTS_DIR=${expected}; reported ${reported??'unknown (older worker)'}. Restart it with its current command from Workers. Existing project paths are preserved.`;
  }
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
      if(method==='agent/status')return {state:'error',workerConnected:true,workerUid:health.uid,executionUid:health.executionUid??health.uid,workerSetupRequired:true,error:'The connected agent is not running as root. Launch the root worker from Connect agent.',rootWorkerCommand:this.launch().command};
    }
    const mismatch=this.projectDirectoryMismatch();
    if(mismatch&&method!=='agent/cancel'){
      if(method==='agent/connect')throw failure(mismatch,409);
      return {state:'error',workerConnected:true,workerUid:health.uid,executionUid:health.executionUid??health.uid,workerSetupRequired:true,error:mismatch,rootWorkerCommand:this.launch().command};
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
      if((error as {statusCode?:number}).statusCode===503&&this.lastHealth)return {state:'error',workerConnected:true,workerUid:this.lastHealth.uid,workerSetupRequired:true,error:(error as Error).message,rootWorkerCommand:this.launch().command};
      this.client.close();
      const launch=this.launch();
      return {state:'disconnected',workerConnected:false,workerUid:null,error:`The ${this.config.requireRootWorker?'root worker':'worker'} is unavailable. Start it here, or run its current command from Workers in your terminal.`,rootWorkerCommand:launch.command};
    }
  }
  connect():Promise<AgentConnection>{
    if(this.connecting)return this.connecting;
    const release=this.queue.holdAuthentication(this.config.workerId??'default');
    this.connecting=(async()=>{
      try{return await this.request('agent/connect');}
      catch(error){
        const code=(error as NodeJS.ErrnoException).code;
        if(code==='ENOENT'||code==='ECONNREFUSED')throw failure(`Start the ${this.config.requireRootWorker?'root worker':'worker'} before connecting your ChatGPT account.`,503);
        throw error;
      }finally{release();this.connecting=undefined;}
    })();
    return this.connecting;
  }
  async cancel():Promise<AgentConnection>{
    const release=this.queue.holdAuthentication(this.config.workerId??'default');
    try{return await this.request('agent/cancel');}finally{release();}
  }
  startWorker():Promise<AgentConnection>{
    if(this.starting)return this.starting;
    this.starting=this.launchWorker().finally(()=>{this.starting=undefined;});
    return this.starting;
  }
  private async launchWorker():Promise<AgentConnection>{
    const existing=await this.status();
    const root=this.config.requireRootWorker===true;
    if(existing.workerConnected&&(root?existing.workerUid===0:existing.workerUid===this.config.controllerUid)){
      if(!root){const mismatch=this.projectDirectoryMismatch();if(mismatch)throw failure(`${mismatch} Stop this worker in its terminal before restarting it.`,409);return existing;}
      if((existing.executionUid??existing.workerUid)!==0)throw failure('The existing worker launches agent commands as a non-root account. Stop it in its terminal and run the root worker command.',409);
      if(!this.projectDirectoryMismatch())return existing;
    }
    if(this.lastHealth?.activeRunId||this.lastHealth?.uncertainRuns.length||this.lastHealth?.runtimeOperations?.length||this.lastHealth?.runtime.authenticating)throw failure('Finish or reconcile existing execution and cancel any pending sign-in before restarting this worker.',409);
    if(process.getuid?.()===0||process.getuid?.()!==this.config.controllerUid)throw failure('Start the web controller as its normal owner; workers use their registered permissions.',403);
    if(this.closed)throw failure('The controller is shutting down.',503);
    const launch=this.launch();
    const log=openSync(join(this.config.workerDir??join(this.config.stateDir,'worker'),'development.log'),constants.O_WRONLY|constants.O_CREAT|constants.O_APPEND|constants.O_NOFOLLOW,0o600);
    let child:ChildProcess;
    try{
      child=spawn(root?'sudo':launch.args[0]!,root?['-n','--',...launch.args]:launch.args.slice(1),{
        cwd:projectRoot,detached:true,
        env:process.env,
        stdio:['ignore',log,log],
      });
    }finally{closeSync(log);}
    let spawnError:Error|undefined;child.on('error',error=>{spawnError=error;});child.unref();
    const deadline=Date.now()+15_000;
    while(Date.now()<deadline&&!this.closed){
      if(existsSync(this.config.socketPath)){
        const connection=await this.status();
        if(connection.workerConnected&&(root?connection.workerUid===0:connection.workerUid===this.config.controllerUid)){
          if(!root&&!this.projectDirectoryMismatch()){await this.queue.tick();return connection;}
          if(root){
            if((connection.executionUid??connection.workerUid)!==0)throw failure('The existing worker launches agent commands as a non-root account. Stop it in its terminal and run the root worker command.',409);
            if(!this.projectDirectoryMismatch()){await this.queue.tick();return connection;}
          }
        }
      }
      if(spawnError||child.exitCode!==null||child.signalCode!==null)throw failure(root?'Root access requires a privileged launch on this host. Run npm run worker:root as your normal user in your VPS terminal, or use the exact command shown in Workers. Enter your operating-system password in that terminal.':'The worker did not start. Run its exact command from Workers in your terminal and check its output. Stop any existing worker with the same ID before restarting it.',503);
      await new Promise(ok=>setTimeout(ok,100));
    }
    if(child.pid&&child.exitCode===null)child.kill('SIGTERM');
    throw failure(`The ${root?'root worker':'worker'} did not become available. Run its current command from Workers and check its terminal output.`,503);
  }
  close(){this.closed=true;this.client.off('disconnect',this.onDisconnect);this.client.close();}
}
