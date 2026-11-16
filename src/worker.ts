import { createServer, type Server, type Socket } from 'node:net';
import { timingSafeEqual, randomUUID } from 'node:crypto';
import { chownSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve, relative, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { z } from 'zod';
import { loadConfig, type Config } from './config.js';
import { checkSkillSchema, readFrames, submitSchema, type Submission, type WorkerEvent, type WorkerHealth } from './ipc.js';
import { CodexAdapter, CODEX_VERSION } from './runtime/codex.js';
import { AgentAuthenticator } from './runtime/auth.js';
import { checkSkill } from './runtime/fixtures.js';
import { WorkerJournal, type JournalRun, type JournalCheck } from './runtime/journal.js';
import { processStamp, bootId, groupMembers, terminateGroup } from './runtime/processes.js';
import { inside, prepareExecutionDirectory } from './runtime/execution.ts';
import { projectInspectInput, projectLogsInput, projectReferenceSchema } from './projects/schemas.ts';
import { inspectProject, projectLogs, validateProjectReference } from './runtime/projects.ts';
import { publishArtifact } from './runtime/artifacts.ts';
import { ManagedRuntime } from './runtime/managed.ts';
import { managedDeployInput,managedLifecycleInput, managedPrepareInput } from './runtime/managed.ts';
import { inRuntimeOperation, type RuntimeOperationContext } from './runtime/operations.ts';
import { callConnector, testConnector } from './connectors/client.ts';
import { connectorCallInput, connectorTestInput, type ConnectorSnapshot } from './connectors/schemas.ts';
import { prepareWorkerDirectory, workerDirectory } from './workers/config.ts';
import { loadWorkerConfig } from './workers/startup.ts';
import type { WorkerModel } from './workers/models-schema.ts';

const runIdInput = z.object({ runId: z.string().min(1) });
const emptyInput = z.object({}).strict();
type Active = { submission: Submission; adapter: CodexAdapter; completed: boolean; interruptRequested: boolean; outputChars:number;timer?: NodeJS.Timeout; delta?: { text: string; itemId: string }; deltaTimer?: NodeJS.Timeout };

export class WorkerServer {
  private server?: Server;
  private clients = new Set<Socket>();
  private active?: Active;
  private runtime: WorkerHealth['runtime'] = { available: false, version: CODEX_VERSION, authenticated: false, detail: 'Codex runtime has not been checked' };
  private healthCheckedAt = 0;
  private probing?: Promise<void>;
  private listingModels?:Promise<WorkerModel[]>;
  private lockPath: string;
  journal!: WorkerJournal;
  private checks: Promise<unknown> = Promise.resolve();
  private pendingChecks = 0;
  private authenticator: AgentAuthenticator;
  private replacementReserved = false;
  private closing = false;
  private lockOwned = false;
  private managed:ManagedRuntime;
  private runtimeOperations=new Set<Promise<unknown>>();
  private runtimeController=new AbortController();
  private closingOperation?:Promise<void>;
  private runtimeUncertain=new Set<string>();
  constructor(private config: Config, private adapterFactory: (config: Config, runId?: string,connectors?:ConnectorSnapshot[]) => CodexAdapter = (config, runId,connectors) => new CodexAdapter(config, runId,connectors), options: { authTimeoutMs?: number } = {}) {
    this.managed=new ManagedRuntime(config);
    this.lockPath = resolve(workerDirectory(config),'lock.json');
    this.authenticator = new AgentAuthenticator(() => this.adapterFactory(this.config), {
      timeoutMs: options.authTimeoutMs,
      beforeStart: async () => { while (this.probing) await this.probing; if (this.closing) throw new Error('Worker is stopping'); },
      changed: (connection, busy, health) => {
        this.runtime = { ...this.runtime, authenticating: busy, ...(health ? { available: true, ...health } : {}),
          ...(connection.state === 'connecting' && !health ? { detail: 'Waiting for ChatGPT sign-in' } : {}),
          ...(connection.error ? { authenticated: false, detail: connection.error } : {}),
          ...(connection.state === 'disconnected' && !busy ? { authenticated: false, detail: 'Model authentication missing. Connect the agent to sign in with ChatGPT.' } : {}) };
        if (!busy) { this.healthCheckedAt = Date.now(); this.repairOwnership(); }
      },
    });
  }
  async listen(): Promise<void> {
    if (this.config.requireRootWorker === true && process.getuid?.() !== 0) throw new Error('Root worker required. Use the root-worker command shown by Connect agent; it includes the controller state directory and UID.');
    if(this.config.workerMode==='user'&&process.getuid?.()===0)throw new Error('This worker is registered in user mode. Start it as the controller user, without sudo.');
    if(this.config.workerId)prepareWorkerDirectory(this.config);
    this.acquireLock();
    this.journal = new WorkerJournal(this.config.stateDir,undefined,{directory:workerDirectory(this.config),workerId:this.config.workerId??'default'});
    // A different stdio client cannot reattach after a worker crash. Keep uncertain runs
    // blocked until their owned process group has been resolved; never resubmit them.
    for (const run of this.journal.active()) this.journal.status(run.id, 'uncertain');
    for (const check of this.journal.checks()) this.journal.checkStatus(check.id, 'uncertain');
    for(const operation of this.journal.runtimeOperations())this.journal.runtimeStatus(operation.id,'uncertain');
    if (existsSync(this.config.socketPath)) {
      if (!lstatSync(this.config.socketPath).isSocket()) throw new Error('Refusing to replace a non-socket worker path');
      rmSync(this.config.socketPath);
    }
    this.server = createServer(socket => this.connection(socket));
    await new Promise<void>((resolveListen, reject) => { this.server!.once('error', reject); this.server!.listen(this.config.socketPath, resolveListen); });
    chmodSync(this.config.socketPath, 0o600);
    if (process.getuid?.() === 0) chownSync(this.config.socketPath, this.config.controllerUid, -1);
    await this.probe();
    this.repairOwnership();
  }
  private acquireLock(): void {
    if (existsSync(this.lockPath)) {
      const previous = z.object({ pid: z.number(), start: z.string().nullable() }).parse(JSON.parse(readFileSync(this.lockPath, 'utf8')));
      if (previous.start !== null && processStamp(previous.pid) === previous.start) throw new Error(`Worker already owns the state directory (PID ${previous.pid})`);
      rmSync(this.lockPath);
    }
    writeFileSync(this.lockPath, JSON.stringify({ pid: process.pid, start: processStamp(process.pid) }), { flag: 'wx', mode: 0o600 });
    this.lockOwned = true;
  }
  private async probe(): Promise<void> {
    if (this.active || this.authenticator.busy || Date.now() - this.healthCheckedAt < 30_000) return;
    if (this.probing) return this.probing;
    const probing = (async () => {
      const adapter = this.adapterFactory(this.config);
      adapter.on('fault', () => {}); adapter.on('exit', () => {});
      try { await adapter.start(); const health = await adapter.health(); this.runtime = { available: true, version: adapter.version, ...health, authenticating: this.authenticator.busy, ...(this.config.model ? { model: this.config.model } : {}) }; }
      catch (error) { this.runtime = { available: false, version: CODEX_VERSION, authenticated: false, authenticating: this.authenticator.busy, detail: this.redact(error instanceof Error ? error.message : String(error)) }; }
      finally { await adapter.close(); this.healthCheckedAt = Date.now(); }
    })();
    this.probing=probing;
    try { await probing; } finally { if(this.probing===probing)this.probing = undefined; }
  }
  health(): WorkerHealth {
    const runtimeOperations=this.journal.runtimeOperations().map(({id,method,status,requiresExternalInspection})=>({id,method,status:this.runtimeUncertain.has(id)?'uncertain' as const:status,requiresExternalInspection}));
    return { connected: true, uid: process.getuid?.() ?? -1, pid: process.pid, root: process.getuid?.() === 0,workerId:this.config.workerId??'default',journalId:this.journal.journalId,model:this.config.model??null,...(this.config.effort?{effort:this.config.effort}:{}),workerMode:this.config.workerMode??(this.config.requireRootWorker?'root':'user'),executionUid:process.getuid?.(),sourceProtected:false,runtime: this.runtime, replacementReserved: this.replacementReserved,
      projectsDir:resolve(this.config.projectsDir??resolve(this.config.stateDir,'projects')),
      runtimeOperations,activeRunId: this.active?.submission.runId ?? null, uncertainRuns: [...new Set([...this.journal.active().filter(run => run.status === 'uncertain').map(run => run.id), ...this.journal.checks().filter(check => check.status === 'uncertain').map(check => check.run_id ?? check.id),...runtimeOperations.filter(operation=>operation.status==='uncertain').map(operation=>operation.id)])] };
  }
  private models():Promise<WorkerModel[]> {
    if(this.listingModels)return this.listingModels;
    const operation=(async()=>{
      while(this.probing)await this.probing;
      if(this.closing||this.replacementReserved||this.authenticator.busy)throw new Error('Worker model discovery is unavailable during sign-in or restart. Retry afterward.');
      if(this.active)return this.active.adapter.listModels();
      const adapter=this.adapterFactory({...this.config,model:undefined,effort:undefined});
      adapter.on('fault',()=>{});adapter.on('exit',()=>{});
      const lookup=(async()=>{try{await adapter.start();return await adapter.listModels();}finally{await adapter.close();this.repairOwnership();}})();
      const probe=lookup.then(()=>{},()=>{});this.probing=probe;
      try{return await lookup;}finally{if(this.probing===probe)this.probing=undefined;}
    })();
    this.listingModels=operation;void operation.finally(()=>{if(this.listingModels===operation)this.listingModels=undefined;}).catch(()=>{});return operation;
  }
  private hasUncertainRuntime():boolean{return this.runtimeUncertain.size>0||this.journal.runtimeOperations().some(operation=>operation.status==='uncertain');}
  private async runtimeEffect(method:string,operation:()=>Promise<unknown>):Promise<unknown>{
    if(this.hasUncertainRuntime())throw new Error('Reconcile uncertain runtime operations before starting another effect.');
    const id=`runtime_${randomUUID()}`;this.journal.beginRuntimeOperation(id,method);let cleanupFailed=false;
    const context:RuntimeOperationContext={
      reserve:()=>{const launch=`launch_${randomUUID()}`;this.journal.reserveRuntimeProcess(id,launch);return launch;},
      capture:(launch,pid,start,boot)=>this.journal.captureRuntimeProcess(launch,pid,start,boot),release:launch=>this.journal.releaseRuntimeProcess(launch),
      external:()=>this.journal.runtimeExternal(id),cleanupFailed:()=>{cleanupFailed=true;},
    };
    try{
      const result=await inRuntimeOperation(context,operation),record=this.journal.runtimeOperations().find(item=>item.id===id);
      if(cleanupFailed)throw new Error('Owned helper cleanup is uncertain; reconcile the runtime operation.');
      if(record?.requiresExternalInspection){this.journal.completeRuntimeOperation(id);return {...result as Record<string,unknown>,__runtimeOperationId:id};}
      this.journal.finishRuntimeOperation(id);return result;
    }catch(error){
      const record=this.journal.runtimeOperations().find(item=>item.id===id);
      if(cleanupFailed||record?.requiresExternalInspection){this.runtimeUncertain.add(id);try{this.journal.runtimeStatus(id,'uncertain');}catch{}}
      else try{this.journal.finishRuntimeOperation(id);}catch{this.runtimeUncertain.add(id);}
      throw error;
    }
  }
  private connection(socket: Socket): void {
    let authenticated = false;
    const authDeadline = setTimeout(() => { if (!authenticated) socket.destroy(); }, 5000);
    socket.on('error', () => {}); socket.on('close', () => { clearTimeout(authDeadline); this.clients.delete(socket); });
    readFrames(socket, frame => {
      void (async () => {
        if (frame.id === undefined || !frame.method) throw new Error('IPC requests require id and method');
        if (!authenticated) {
          const input = z.object({ token: z.string().length(64) }).parse(frame.params);
          if (frame.method !== 'hello' || !timingSafeEqual(Buffer.from(input.token), Buffer.from(this.config.ipcToken))) throw new Error('Worker authentication failed');
          authenticated = true; clearTimeout(authDeadline); this.clients.add(socket); return this.health();
        }
        return await this.dispatch(frame.method, frame.params);
      })().then(result => { if (!socket.destroyed) socket.write(JSON.stringify({ id: frame.id, result }) + '\n'); })
        .catch(error => { if (!socket.destroyed) socket.write(JSON.stringify({ id: frame.id, error: { message: this.redact(error instanceof Error ? error.message : String(error)) } }) + '\n'); if (!authenticated) socket.end(); });
    });
  }
  private async dispatch(method: string, raw: unknown): Promise<unknown> {
    if (this.closing) throw new Error('Worker is stopping');
    if(method==='models/list'){emptyInput.parse(raw);return this.models();}
    if(method==='runtime/acknowledge'){
      const {operationId}=z.object({operationId:z.string().regex(/^runtime_[0-9a-f-]{36}$/)}).strict().parse(raw),operation=this.journal.runtimeOperations().find(item=>item.id===operationId);
      if(operation&&!operation.completed)throw new Error('An unfinished runtime operation requires explicit reconciliation, not a receipt acknowledgement.');
      if(operation)this.journal.finishRuntimeOperation(operationId);this.runtimeUncertain.delete(operationId);return {acknowledged:true,operationId};
    }
    if(method.startsWith('managed/')||method==='connectors/test'||method==='connectors/call'){
      if(this.replacementReserved)throw new Error('Worker replacement is reserved. Wait before starting runtime operations.');
      let effect:(()=>Promise<unknown>)|undefined,observation:(()=>Promise<unknown>)|undefined;
      if(method==='managed/prepare'||method==='managed/deploy'){const input=(method==='managed/deploy'?managedDeployInput:managedPrepareInput).parse(raw);effect=()=>method==='managed/prepare'?this.managed.prepare(input):this.managed.deploy(input);}
      else if(method==='managed/stop'){const input=managedLifecycleInput.parse(raw);effect=()=>this.managed.stop(input);}
      else if(method==='managed/status'||method==='managed/logs'){const input=managedLifecycleInput.parse(raw);observation=()=>method==='managed/status'?this.managed.status(input):this.managed.logs(input);}
      else if(method==='connectors/test'){const input=connectorTestInput.parse(raw);effect=()=>testConnector(this.config,input.connector,{signal:this.runtimeController.signal});}
      else if(method==='connectors/call'){const input=connectorCallInput.parse(raw);effect=()=>callConnector(this.config,input.connector,input.name,input.arguments,{signal:this.runtimeController.signal});}
      else throw new Error(`Unsupported worker method: ${method}`);
      const operation=(async()=>{
        return effect?await this.runtimeEffect(method,effect):await observation!();
      })();
      this.runtimeOperations.add(operation);
      try{return this.clean(await operation);}finally{this.runtimeOperations.delete(operation);this.repairOwnership();}
    }
    if(method==='projects/prepare'){const input=z.object({project:projectReferenceSchema}).strict().parse(raw);validateProjectReference(this.config,input.project);prepareExecutionDirectory(this.config,input.project.directory);return {directory:input.project.directory,ready:true};}
    if(method==='projects/inspect'){const input=projectInspectInput.parse(raw);return this.clean(await inspectProject(this.config,input.project,input.components));}
    if(method==='projects/logs'){const input=projectLogsInput.parse(raw);return this.clean(await projectLogs(this.config,input.project,input.component));}
    if(method==='artifacts/publish')return publishArtifact(this.config,raw);
    if (method === 'worker/reserve-root-replacement') {
      emptyInput.parse(raw);
      if (this.active || this.pendingChecks || this.runtimeOperations.size || this.journal.runtimeOperations().length || this.journal.active().length || this.journal.checks().length || this.authenticator.busy) throw new Error('The worker has active or uncertain execution, pending skill checks or runtime operations, or ChatGPT sign-in. Finish or reconcile it before replacing the worker.');
      // Reserve admission synchronously before waiting for an existing read-only probe.
      this.replacementReserved = true;
      try {
        while (this.probing) await this.probing;
        if (this.closing || !this.replacementReserved) throw new Error('Worker replacement reservation was released or the worker is stopping');
        return { reserved: true, pid: process.pid, uid: process.getuid?.() ?? -1 };
      } catch (error) { this.replacementReserved = false; throw error; }
    }
    if (method === 'worker/release-root-replacement') { emptyInput.parse(raw); this.replacementReserved = false; return { reserved: false }; }
    if (this.replacementReserved && ['submit', 'checkSkill', 'agent/connect'].includes(method)) throw new Error('Worker replacement is reserved. Release the reservation or wait for the root worker before submitting tasks, skill checks, or sign-in.');
    if (method === 'agent/status') { emptyInput.parse(raw); await this.probe(); return this.authenticator.status(this.runtime.authenticated); }
    if (method === 'agent/connect') {
      emptyInput.parse(raw);
      if(this.hasUncertainRuntime())throw new Error('Reconcile uncertain runtime operations before connecting the agent.');
      if (this.authenticator.busy) return await this.authenticator.connect();
      if (this.runtime.authenticated) return this.authenticator.status(true);
      if (this.active || this.pendingChecks || this.journal.active().length || this.journal.checks().length) throw new Error('Wait for the active run or skill check, and resolve any uncertain execution, before connecting the agent');
      return await this.authenticator.connect();
    }
    if (method === 'agent/cancel') { emptyInput.parse(raw); return await this.authenticator.cancel(this.runtime.authenticated); }
    if (method === 'health') { await this.probe(); return this.health(); }
    if (method === 'sync') {
      const { after } = z.object({ after: z.number().int().nonnegative() }).parse(raw);
      return { health: this.health(), ...this.journal.replayPage(after), activeRunId: this.active?.submission.runId ?? null, knownRuns: this.journal.active().map(run => ({ runId: run.id, status: run.status })) };
    }
    if (method === 'acknowledge') { const { cursor } = z.object({ cursor: z.number().int().nonnegative() }).parse(raw); this.journal.acknowledge(cursor); return { acknowledged: cursor }; }
    if (method === 'submit') {
      const submission = submitSchema.parse(raw);
      if(submission.workerId&&submission.workerId!==(this.config.workerId??'default'))throw new Error('The task is assigned to a different worker.');
      if(submission.journalId&&submission.journalId!==this.journal.journalId)throw new Error('The worker journal identity changed; reconcile task ownership before retrying.');
      if(submission.maxContextChars&&submission.prompt.length+submission.bootstrap.length>submission.maxContextChars)throw new Error('Submitted prompt and bootstrap exceed the configured context character limit.');
      const known = this.journal.get(submission.runId);
      if (known) {
        if (known.submission !== JSON.stringify(submission)) throw new Error('Run ID already accepted with different input');
        return { accepted: true, duplicate: true, status: known.status };
      }
      if(this.journal.runtimeOperations().length||this.runtimeUncertain.size)throw new Error('Worker has running or uncertain runtime operations; reconcile them before submitting tasks.');
      if (this.authenticator.busy) throw new Error('ChatGPT sign-in is in progress. Finish or cancel the agent connection before running tasks');
      if (this.active || this.journal.active().length || this.journal.checks().some(check => check.status === 'uncertain')) throw new Error('Worker is occupied or has an unresolved orphan run/check');
      if (!this.runtime.available || !this.runtime.authenticated) { await this.probe(); if (!this.runtime.available || !this.runtime.authenticated) throw new Error(this.runtime.detail); }
      let pendingChecks: Promise<unknown>;
      do { while(this.probing)await this.probing;pendingChecks = this.checks; await pendingChecks; } while (this.probing||pendingChecks !== this.checks);
      if(this.closing)throw new Error('Worker is stopping');
      if (this.active || this.journal.active().length || this.journal.checks().length) throw new Error('Worker became occupied or has an orphan check while waiting for representative checks');
      if(this.journal.runtimeOperations().length||this.runtimeUncertain.size)throw new Error('Worker has running or uncertain runtime operations; reconcile them before submitting tasks.');
      if (this.journal.count() >= this.journal.maxEvents - 10) throw new Error('Worker outbox needs controller acknowledgement before another run');
      if (!this.runtime.available || !this.runtime.authenticated)throw new Error(this.runtime.detail);
      if (this.authenticator.busy) throw new Error('ChatGPT sign-in is in progress. Finish or cancel the agent connection before running tasks');
      if (this.replacementReserved) throw new Error('Worker replacement is reserved. Wait for the root worker before submitting tasks.');
      this.journal.accept(submission);
      const adapter = this.adapterFactory(this.config, submission.runId,submission.connectors);
      const active: Active = { submission, adapter, completed: false, interruptRequested: false,outputChars:0 }; this.active = active;
      this.record(active, 'status', { status: 'running', accepted: true });
      if(submission.timeoutMs)active.timer=setTimeout(()=>void this.abort(active,'Configured task timeout exceeded'),submission.timeoutMs);
      setImmediate(() => void this.execute(active));
      return { accepted: true, duplicate: false, status: 'accepted' };
    }
    if (method === 'interrupt') {
      const { runId } = runIdInput.parse(raw); const active = this.requireActive(runId); active.interruptRequested = true;
      if (active.adapter.turnId) await active.adapter.interrupt();
      this.record(active, 'activity', { method: 'operator/interrupt', message: 'Interruption requested; waiting for observed runtime outcome. Detached services may continue.' });
      return { requested: true };
    }
    if (method === 'reply') {
      const input = z.object({ runId: z.string(), requestId: z.string(), answers: z.unknown() }).parse(raw);
      const active = this.requireActive(input.runId); active.adapter.reply(input.requestId, input.answers); this.journal.status(input.runId, 'running'); return { answered: true };
    }
    if (method === 'resolve') {
      const {runId,acknowledgeExternalEffects}=runIdInput.extend({acknowledgeExternalEffects:z.boolean().optional()}).parse(raw);
      const runtime=this.journal.runtimeOperations().find(item=>item.id===runId);
      if(runtime){
        if(runtime.status!=='uncertain'&&!this.runtimeUncertain.has(runId))throw new Error('A running runtime operation cannot be reconciled.');
        if(runtime.requiresExternalInspection&&!acknowledgeExternalEffects)throw new Error('Inspect external HTTP/service effects and explicitly acknowledge them before reconciliation.');
        if(!runtime.completed)for(const process of this.journal.runtimeProcesses(runId)){
          if(!process.released&&!process.pid)continue;
          if(!process.pid||!process.start||!/^\d+$/.test(process.start)||!process.boot)throw new Error('Cannot verify the runtime helper identity; inspect the host before reconciliation.');
          if(process.boot!==bootId())continue;
          const members=groupMembers(process.pid);if(!members.length)continue;
          if(processStamp(process.pid)!==process.start||members.some(member=>member.sid!==process.pid||BigInt(member.start)<BigInt(process.start!)))throw new Error('Cannot verify runtime process group ownership; the recorded leader is missing or its PID was reused. Inspect the host.');
          await terminateGroup(process.pid);
        }
        this.journal.finishRuntimeOperation(runId);this.runtimeUncertain.delete(runId);this.repairOwnership();return {resolved:true,known:true,kind:'runtimeOperation',message:'Recorded local helper groups were reconciled. External effects were acknowledged where required; no effects were replayed or rolled back.'};
      }
      const run = this.journal.get(runId);
      const standalone = this.journal.checks().find(check => check.id === runId && check.run_id === null && check.status === 'uncertain');
      if (standalone) { await this.resolveOrphan(standalone); this.journal.finishCheck(standalone.id); this.repairOwnership(); return { resolved: true, known: true, kind: 'skillCheck', message: 'Owned orphan fixture check terminated/confirmed absent; its side effects were not repeated' }; }
      if (!run && !this.active && this.journal.active().length === 0 && this.journal.checks().length === 0) return { resolved: true, known: false, message: 'No worker acceptance record; owner acknowledged host reconciliation' };
      if (run && ['completed', 'failed', 'interrupted'].includes(run.status) && !this.active) { await this.resolveOrphan(run); for (const check of this.journal.checks().filter(check => check.run_id === runId)) { await this.resolveOrphan(check); this.journal.finishCheck(check.id); } return { resolved: true, known: true, status: run.status }; }
      if (!run || run.status !== 'uncertain') throw new Error('Only an uncertain orphan run can be resolved');
      await this.resolveOrphan(run);
      for (const check of this.journal.checks().filter(check => check.run_id === runId)) { await this.resolveOrphan(check); this.journal.finishCheck(check.id); }
      this.journal.status(runId, 'failed'); const event = this.journal.append(runId, 'completed', { status: 'failed', error: 'Worker restarted; owned orphan execution was terminated/confirmed absent. Side effects are uncertain and were not repeated.' }, true); this.broadcast(event);
      this.repairOwnership(); return { resolved: true };
    }
    if (method === 'checkSkill') {
      if(this.hasUncertainRuntime())throw new Error('Reconcile uncertain runtime operations before validating a skill.');
      if (this.authenticator.busy) throw new Error('Finish or cancel ChatGPT sign-in before validating a skill');
      if (this.active?.completed) throw new Error('Run is finishing; retry validation once execution is idle');
      const input = checkSkillSchema.parse(raw);
      const root = realpathSync(resolve(this.config.stateDir, 'skills')); const path = realpathSync(input.candidatePath); const rel = relative(root, path);
      if (rel.startsWith(`..${sep}`) || rel === '..') throw new Error('Skill checks require an application-owned candidate package');
      if (this.journal.checks().some(check => check.status === 'uncertain')) throw new Error('Resolve the owned orphan fixture check before validating another package');
      this.pendingChecks++;
      const operation = this.checks.then(async () => {
        const id = `fixture_${randomUUID()}`;
        this.journal.beginCheck(id, this.active?.submission.runId ?? null, path);
        try {
          const result = await checkSkill(this.config.stateDir, { ...input, candidatePath: path }, { spawned: pid => this.journal.checkChild(id, pid, processStamp(pid) ?? '', bootId()),config:this.config });
          this.journal.finishCheck(id); this.repairOwnership(); return result;
        } catch (error) { this.journal.checkStatus(id, 'uncertain'); throw error; }
      }).finally(() => { this.pendingChecks--; });
      this.checks = operation.catch(() => undefined); return await operation;
    }
    throw new Error(`Unsupported worker method: ${method}`);
  }
  private requireActive(runId: string): Active { if (!this.active || this.active.submission.runId !== runId || this.active.completed) throw new Error('Run is not active in this worker'); return this.active; }
  private prepareSkills(submission: Submission): Submission {
    prepareExecutionDirectory(this.config,submission.cwd);
    const agents = resolve(submission.cwd, '.agents');
    if (existsSync(agents) && lstatSync(agents).isSymbolicLink()) throw new Error('Workspace .agents may not be a symlink');
    mkdirSync(agents, { recursive: true, mode: 0o700 });
    const discovery = resolve(agents, 'skills');
    if (existsSync(discovery)) rmSync(discovery, { recursive: true, force: true });
    mkdirSync(discovery, { mode: 0o700 });
    const skillRoot = realpathSync(resolve(this.config.stateDir, 'skills'));
    for (const skill of submission.skills) {
      const path = realpathSync(skill.path); const rel = relative(skillRoot, path);
      if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Skill path is outside application skill packages');
      symlinkSync(path, resolve(discovery, skill.name), 'dir');
    }
    return submission;
  }
  private async execute(active: Active): Promise<void> {
    if(active.completed)return;
    const adapter = active.adapter;
    adapter.on('spawn', ({ pid,start,boot }: { pid: number;start?:string;boot?:string }) => {
      const identity=start??processStamp(pid),kernel=boot??bootId();if(!identity||kernel==='unsupported')throw new Error('Cannot durably capture the Codex process identity.');
      this.journal.child(active.submission.runId,pid,identity,kernel);
    });
    adapter.on('event', (type: string, data: unknown) => {
      if (active.completed) return;
      try {
        if (type === 'completed') { void this.finish(active, data as { status: string; error?: unknown }); return; }
        if (type === 'clarification') this.journal.status(active.submission.runId, 'waiting');
        this.record(active, type, data);
      } catch (error) { void this.abort(active, error instanceof Error ? error.message : String(error)); }
    });
    adapter.on('fault', (error: Error) => void this.abort(active, error.message));
    adapter.on('exit', () => { if (!active.completed) void this.finish(active, { status: 'failed', error: 'Codex app-server exited before completion; side effects may have occurred' }); });
    try {
      const prepared=this.prepareSkills(active.submission); this.journal.status(active.submission.runId, 'running');
      await adapter.start();
      if(active.completed)return;
      const health = await adapter.health(); if(active.completed)return;if (!health.authenticated) throw new Error(health.detail);
      await adapter.run(prepared);
      if (active.interruptRequested && !active.completed) await adapter.interrupt();
    } catch (error) { await this.abort(active, error instanceof Error ? error.message : String(error)); }
  }
  private record(active: Active, type: string, data: unknown): void {
    if (active.completed) return;
    if (type === 'delta') {
      const delta = z.object({ text: z.string(), itemId: z.string() }).parse(data);
      active.outputChars+=delta.text.length;
      if(active.submission.maxOutputChars&&active.outputChars>active.submission.maxOutputChars)throw new Error('Configured assistant output character limit exceeded; execution was interrupted.');
      if (active.delta && active.delta.itemId !== delta.itemId) this.flush(active, true);
      if (active.delta) active.delta.text += delta.text; else active.delta = delta;
      if (!active.deltaTimer) active.deltaTimer = setTimeout(() => { try { this.flush(active); } catch (error) { void this.abort(active, error instanceof Error ? error.message : String(error)); } }, 50);
      return;
    }
    this.flush(active, true);
    const clean = this.clean(data);
    this.broadcast(this.journal.append(active.submission.runId, type, clean));
  }
  private flush(active: Active, force = false): void {
    if (active.deltaTimer) { clearTimeout(active.deltaTimer); active.deltaTimer = undefined; }
    if (!active.delta) return;
    const delta = active.delta; const clean = this.redact(delta.text); let held = 0;
    // Keep only a suffix that could be a split configured credential. Ordinary text
    // still streams immediately, and item boundaries force the final flush.
    if (!force) for (const secret of this.secretVariants()) {
      for (let length = Math.min(secret.length - 1, clean.length); length > held; length--) if (clean.endsWith(secret.slice(0, length))) { held = length; break; }
    }
    const text = held ? clean.slice(0, -held) : clean;
    active.delta = held ? { text: clean.slice(-held), itemId: delta.itemId } : undefined;
    if (text) this.broadcast(this.journal.append(active.submission.runId, 'delta', { itemId: delta.itemId, text }));
  }
  private async abort(active: Active, reason: string): Promise<void> {
    if (active.completed) return;
    await this.finish(active, { status: 'failed', error: this.redact(reason) });
  }
  private async finish(active: Active, result: { status: string; error?: unknown }): Promise<void> {
    if (active.completed) return;
    try { this.flush(active, true); }
    catch (error) {
      active.delta = undefined;
      result = { status: 'failed', error: this.redact(error instanceof Error ? error.message : String(error)) };
    }
    active.completed = true; clearTimeout(active.timer); clearTimeout(active.deltaTimer);
    try {
      await active.adapter.close();
      for (const check of this.journal.checks().filter(check => check.run_id === active.submission.runId)) await this.resolveOrphan(check);
      await this.checks;
      this.journal.status(active.submission.runId, result.status);
      this.broadcast(this.journal.append(active.submission.runId, 'completed', this.clean(result), true));
    } catch (error) {
      this.journal.status(active.submission.runId, 'uncertain');
      this.broadcast(this.journal.append(active.submission.runId, 'completed', { status: 'failed', uncertain: true, error: this.redact(error instanceof Error ? error.message : String(error)) }, true));
    }
    if (this.active === active) this.active = undefined;
    this.repairOwnership();
  }
  private broadcast(event: WorkerEvent): void { for (const client of this.clients) { if (client.writableLength > 4 * 1024 * 1024) client.destroy(); else client.write(JSON.stringify({ method: 'event', params: event }) + '\n'); } }
  private redact(value: string): string {
    for (const secret of this.secretVariants()) value = value.split(secret).join('[REDACTED]');
    return value;
  }
  private clean(value: unknown): unknown {
    if (typeof value === 'string') return this.redact(value);
    if (Array.isArray(value)) return value.map(item => this.clean(item));
    if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, this.clean(item)]));
    return value;
  }
  private secretVariants(): string[] {
    const variants = new Set<string>();
    for (const secret of [this.config.ipcToken, this.config.adminPassword,this.active?.submission.leaseToken, ...Object.entries(process.env).filter(([key]) => /(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key)).map(([, value]) => value)]) {
      if (secret && secret.length >= 6) { variants.add(JSON.stringify(secret).slice(1, -1)); variants.add(secret); }
    }
    return [...variants].sort((a, b) => b.length - a.length);
  }
  private async resolveOrphan(run: JournalRun | JournalCheck): Promise<void> {
    if (!run.child_pid || run.boot_id !== bootId()) return;
    const members = groupMembers(run.child_pid);
    if (!members.length) return;
    if (!run.child_start || members.some(member => member.sid !== run.child_pid || BigInt(member.start) < BigInt(run.child_start!))) throw new Error('Cannot verify orphan process group ownership; inspect the host before resolving');
    const current = processStamp(run.child_pid);
    if (current !== run.child_start) throw new Error('Orphan process leader is missing or its PID was reused; inspect the host before resolving');
    await terminateGroup(run.child_pid);
  }
  private repairOwnership(): void {
    if (process.getuid?.() !== 0) return;
    const visit = (path: string) => {
      try { const stat = lstatSync(path); if (stat.isSymbolicLink()) return; chownSync(path, this.config.controllerUid, -1); if (stat.isDirectory()) for (const name of readdirSync(path)) visit(resolve(path, name)); } catch {}
    };
    // Controller remains the owner of durable data so maintenance-window snapshots work.
    // Agent-created paths outside these roots intentionally retain host semantics.
    for (const path of this.config.workerId?['workspaces','artifacts']:['runtime', 'workspaces', 'artifacts', 'worker']) visit(resolve(this.config.stateDir, path));
    if(this.config.workerId)visit(workerDirectory(this.config));
    const projects=resolve(this.config.projectsDir??resolve(this.config.stateDir,'projects'));
    if(inside(this.config.stateDir,projects))visit(projects);
  }
  close(): Promise<void> {
    return this.closingOperation??=(async()=>{
      this.closing = true;
      this.runtimeController.abort();
      await this.managed.close();
      await Promise.allSettled([...this.runtimeOperations]);
      await this.authenticator.close();
      while (this.probing) await this.probing;
      if (this.active) await this.finish(this.active, { status: 'interrupted', error: 'Worker shut down and terminated its owned runtime process group. Detached services may continue.' });
      await this.checks;
      for (const socket of this.clients) socket.destroy(); this.clients.clear();
      if (this.server) await new Promise<void>(resolveClose => this.server!.close(() => resolveClose()));
      this.journal?.close();
      if (this.lockOwned) { rmSync(this.config.socketPath, { force: true }); rmSync(this.lockPath, { force: true }); this.lockOwned = false; }
      this.repairOwnership();
    })();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const config = loadWorkerConfig(); const worker = new WorkerServer(config);
  try {
    await worker.listen();
    const health=worker.health();
    console.log(`Worker listening on private Unix socket; broker UID ${health.uid}, execution UID ${health.executionUid} (operator-source guardrail: prompt only), Codex ${CODEX_VERSION}`);
    let stopping = false;
    for (const signal of ['SIGINT', 'SIGTERM'] as const) process.on(signal, () => { if (!stopping) { stopping = true; void worker.close().then(() => process.exit(0)); } });
  } catch (error) { console.error(error instanceof Error ? error.message : String(error)); process.exitCode = 1; }
}
