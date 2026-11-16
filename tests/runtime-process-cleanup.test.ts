import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { groupMembers, processStamp } from '../src/runtime/processes.ts';
import { signalOwned, spawnOwned, terminateOwned } from '../src/runtime/operations.ts';

for(const drains of [true,false])test(drains?'verified SIGKILL cleanup waits for descendants without signaling an unanchored group':'verified SIGKILL cleanup fails closed when descendants do not disappear',async t=>{
  const directory=mkdtempSync(join(tmpdir(),'operator-kill-drain-')),ready=join(directory,'ready');
  const child=spawnOwned(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000);`],{env:process.env});child.stdout.resume();child.stderr.resume();
  const originalKill=process.kill.bind(process);let groupSignals=0;
  try{
    const deadline=Date.now()+5000;while(!existsSync(ready)&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,10));assert(existsSync(ready));
    const mocked=t.mock.method(process,'kill',(pid:number,signal?:number|NodeJS.Signals)=>{
      if(pid===-child.pid!){groupSignals++;if(signal==='SIGKILL'&&groupSignals===1)return originalKill(child.pid!,'SIGKILL');}
      return originalKill(pid,signal);
    });
    // Simulate the kernel reaping the verified supervisor before killed members.
    const exited=once(child,'exit');signalOwned(child,'SIGKILL');await exited;
    assert.equal(processStamp(child.pid!),null);assert(groupMembers(child.pid!).length>0);
    signalOwned(child,'SIGKILL');
    const cleanup=terminateOwned(child).then(()=>null,error=>error as Error);
    if(drains)originalKill(-child.pid!,'SIGKILL');
    const error=await cleanup;
    if(drains)assert.equal(error,null);else assert.match(error?.message??'',/survived a verified SIGKILL/);
    assert.equal(groupSignals,1,'Cleanup must not signal the now-unanchored group');mocked.mock.restore();
  }finally{
    try{originalKill(-child.pid!,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}
    const deadline=Date.now()+3000;while(groupMembers(child.pid!).length&&Date.now()<deadline)await new Promise(ok=>setTimeout(ok,10));
    assert.equal(groupMembers(child.pid!).length,0);rmSync(directory,{recursive:true,force:true});
  }
});
