import { AsyncLocalStorage } from 'node:async_hooks';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { bootId, groupMembers, processStamp, terminateGroup } from './processes.ts';

export interface RuntimeOperationContext {
  reserve:()=>string;capture:(id:string,pid:number,start:string,boot:string)=>void;release:(id:string)=>void;
  external:()=>void;cleanupFailed:()=>void;
}
const current=new AsyncLocalStorage<RuntimeOperationContext>();
const identities=new WeakMap<ChildProcessWithoutNullStreams,{pid:number;start:string;boot:string}>();
export function inRuntimeOperation<T>(context:RuntimeOperationContext,operation:()=>Promise<T>):Promise<T>{return current.run(context,operation);}
export function markExternalEffects():void {current.getStore()?.external();}
export function markCleanupUncertain():void {current.getStore()?.cleanupFailed();}

/** No target executable starts until its detached supervisor identity is durable. */
export function spawnOwned(command:string,args:string[],options:{cwd?:string;env:NodeJS.ProcessEnv;beforeRelease?:(pid:number,start:string,boot:string)=>void}):ChildProcessWithoutNullStreams {
  const context=current.getStore(),reservation=context?.reserve();
  const {beforeRelease,...spawnOptions}=options,env=Object.fromEntries(Object.entries(options.env).filter(([key])=>!key.startsWith('NODE_TEST_')));
  const child=spawn(process.execPath,[fileURLToPath(new URL('./operation-runner.mjs',import.meta.url))],{...spawnOptions,env,stdio:['pipe','pipe','pipe','pipe'],detached:true}) as unknown as ChildProcessWithoutNullStreams;
  const control=child.stdio[3] as Writable;control.on('error',()=>{});
  try{
    if(child.pid){
      const start=processStamp(child.pid),boot=bootId();if(!start||boot==='unsupported')throw new Error('Owned helper identity is unavailable.');
      identities.set(child,{pid:child.pid,start,boot});
      if(context&&reservation)context.capture(reservation,child.pid,start,boot);
      beforeRelease?.(child.pid,start,boot);
      if(context&&reservation)context.release(reservation);
      control.write(JSON.stringify({command,args})+'\n');
    }
  }catch(error){
    context?.cleanupFailed();control.destroy();child.stdin.destroy();child.stdout.resume();child.stderr.resume();child.on('error',()=>{});
    throw new Error('Owned helper identity could not be durably recorded; its executable was not started.',{cause:error});
  }
  return child;
}

function ownedGroup(child:ChildProcessWithoutNullStreams):{pid:number;start:string;boot:string}|null {
  if(!child.pid)return null;
  const identity=identities.get(child);if(!identity)throw new Error('Owned helper identity is unavailable; cleanup requires host inspection.');
  if(identity.boot!==bootId())return null;
  const members=groupMembers(identity.pid);if(!members.length)return null;
  if(processStamp(identity.pid)!==identity.start||members.some(member=>member.sid!==identity.pid||BigInt(member.start)<BigInt(identity.start)))throw new Error('Owned helper leader is missing or its PID was reused; cleanup requires host inspection.');
  return identity;
}
export function signalOwned(child:ChildProcessWithoutNullStreams,signal:NodeJS.Signals):void {
  const identity=ownedGroup(child);if(identity)try{process.kill(-identity.pid,signal);}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
}
export async function terminateOwned(child:ChildProcessWithoutNullStreams):Promise<void>{
  const identity=ownedGroup(child);if(identity)await terminateGroup(identity.pid);
}
