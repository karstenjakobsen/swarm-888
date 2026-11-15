import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState, type Config } from '../src/config.ts';
import { managedPath, type ManagedManifest } from '../src/managed/schemas.ts';
import { ManagedRuntime, managedCommand, type ManagedCommand, type ManagedServiceHost } from '../src/runtime/managed.ts';
import { groupMembers } from '../src/runtime/processes.ts';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-managed-runtime-'));
  const config={stateDir,projectsDir:join(stateDir,'projects'),controllerUid:process.getuid!(),runtimeHome:join(stateDir,'runtime'),ipcToken:''} as Config;initState(config);
  const project={id:'11111111-1111-4111-8111-111111111111',directory:join(config.projectsDir!,'fixture')};
  const manifest:ManagedManifest={schemaVersion:1,id:project.id,kind:'project',name:'Fixture website',description:'Local fixture',check:{command:process.execPath,args:['-e','require("node:fs").writeFileSync("checked","yes")']},build:{command:process.execPath,args:['-e','require("node:fs").writeFileSync("built","yes")']},run:{command:process.execPath,args:['server.mjs']}};
  const input={project,manifest,source:{commit:'a'.repeat(40),path:managedPath('project',project.id)},files:{'operator-package.json':JSON.stringify(manifest),'server.mjs':'console.log("fixture source")'}};
  return {config,project,manifest,input,close:()=>rmSync(stateDir,{recursive:true,force:true})};
}
function manager(config:Config){
  const helper=managedCommand(config),calls:Array<{command:string;args:string[];cwd?:string}>=[],units:string[]=[];let directory:string|undefined,running=false;
  const host:ManagedServiceHost={isRoot:()=>true,writeUnit:(_name,content)=>{units.push(content);directory=content.match(/^WorkingDirectory="(.*)"$/m)?.[1];}};
  const command:ManagedCommand=async(command,args,options)=>{
    calls.push({command,args,cwd:options.cwd});
    if(command==='/usr/bin/systemctl'){
      if(args[0]==='disable'){running=false;return {stdout:'',stderr:'',exitCode:0,truncated:false};}
      if(args[0]==='restart'){running=true;return {stdout:'',stderr:'',exitCode:0,truncated:false};}
      if(['daemon-reload','enable'].includes(args[0]))return {stdout:'',stderr:'',exitCode:0,truncated:false};
      return {stdout:args.includes('--property=Version')?'Version=fixture':directory?`LoadState=loaded\nActiveState=${running?'active':'inactive'}\nSubState=${running?'running':'dead'}\nWorkingDirectory=${directory}\nResult=success\n`:'LoadState=not-found\n',stderr:'',exitCode:0,truncated:false};
    }
    if(command==='/usr/bin/journalctl')return {stdout:'fixture service log',stderr:'',exitCode:0,truncated:false};
    return await helper(command,args,options);
  };
  return {command,calls,host,units};
}

test('managed deployment validates and builds a committed snapshot, observes an independent service, and exposes stop/logs',async()=>{
  const f=fixture(),fake=manager(f.config),runtime=new ManagedRuntime(f.config,fake.command,fake.host);
  try{
    const result=await runtime.deploy(f.input);assert.equal(result.status,'running');assert.equal(result.commit,f.input.source.commit);
    assert.equal(readFileSync(join(result.releaseDirectory,'checked'),'utf8'),'yes');assert.equal(readFileSync(join(result.releaseDirectory,'built'),'utf8'),'yes');
    assert.equal(readFileSync(join(result.releaseDirectory,'server.mjs'),'utf8'),f.input.files['server.mjs']);
    assert(fake.calls.find(call=>call.command==='/usr/bin/systemctl')?.args);
    assert.match(fake.units[0],/WantedBy=multi-user.target/);assert.match(fake.units[0],/Restart=on-failure/);
    assert(fake.calls.some(call=>call.args[0]==='enable'));
    assert(fake.calls.filter(call=>call.cwd).every(call=>call.cwd===result.releaseDirectory));
    assert.equal((await runtime.logs({project:f.project})).text,'fixture service log');
    assert.equal((await runtime.status({project:f.project})).status,'running');
    const checkedAndBuilt=fake.calls.filter(call=>call.cwd).length;
    await runtime.deploy(f.input);assert.equal(fake.units.length,1);assert.equal(fake.calls.filter(call=>call.cwd).length,checkedAndBuilt);assert.equal(fake.calls.filter(call=>call.args[0]==='restart').length,1);
    assert.equal((await runtime.stop({project:f.project})).status,'stopped');
  }finally{await runtime.close();f.close();}
});

test('managed preparation pins connector code without invoking systemd or accepting changed source at the same revision',async()=>{
  const f=fixture();f.input.manifest={schemaVersion:1,id:f.project.id,kind:'connector',name:'Fixture connector',description:'',mcp:{transport:'stdio',command:process.execPath,args:['server.mjs']}};f.input.source.path=managedPath('connector',f.project.id);f.input.files['operator-package.json']=JSON.stringify(f.input.manifest);
  const runtime=new ManagedRuntime(f.config,async()=>{throw new Error('No host commands may run during preparation');});
  try{
    const prepared=await runtime.prepare(f.input);assert(existsSync(join(prepared.releaseDirectory,'server.mjs')));
    assert.equal((await runtime.prepare(f.input)).releaseDirectory,prepared.releaseDirectory);
    await assert.rejects(runtime.prepare({...f.input,files:{...f.input.files,'server.mjs':'changed source'}}),/different runtime snapshot/);
    writeFileSync(join(prepared.releaseDirectory,'server.mjs'),'runtime modification');await assert.rejects(runtime.prepare(f.input),/differs from its committed snapshot|expected size/);
  }finally{await runtime.close();f.close();}
});

test('managed HTTP connectors deploy and retain their connector source identity while skills remain prepare-only',async()=>{
  const f=fixture(),fake=manager(f.config),runtime=new ManagedRuntime(f.config,fake.command,fake.host);
  try{
    const manifest:ManagedManifest={...f.manifest,kind:'connector',mcp:{transport:'http',url:'http://127.0.0.1:8123/mcp'}};
    const input={...f.input,manifest,source:{...f.input.source,path:managedPath('connector',f.project.id)},files:{...f.input.files,'operator-package.json':JSON.stringify(manifest)}};
    const deployed=await runtime.deploy(input);assert.equal(deployed.status,'running');assert.equal(deployed.commit,input.source.commit);
    assert.equal((await runtime.status({project:f.project})).status,'running');assert.equal((await runtime.stop({project:f.project})).status,'stopped');
    const skill:ManagedManifest={...manifest,kind:'skill'};
    await assert.rejects(runtime.deploy({...input,manifest:skill,source:{...input.source,path:managedPath('skill',f.project.id)},files:{...input.files,'operator-package.json':JSON.stringify(skill)}}),/project or connector manifest/);
    assert.equal(fake.units.length,1);
  }finally{await runtime.close();f.close();}
});

test('persistent units preserve literal argv and refuse an unrelated existing working directory',async()=>{
  const f=fixture(),fake=manager(f.config),runtime=new ManagedRuntime(f.config,fake.command,fake.host);
  try{
    const manifest={...f.manifest,run:{command:'node',args:['server.mjs','percent %s','cost $VALUE','quote " slash \\']}};
    await runtime.deploy({...f.input,manifest,files:{...f.input.files,'operator-package.json':JSON.stringify(manifest)}});
    assert(fake.units[0].includes(`ExecStart="${process.execPath}"`));assert(fake.units[0].includes('"percent %%s"'));assert(fake.units[0].includes('"cost $$VALUE"'));assert(fake.units[0].includes('"quote \\" slash \\\\"'));
    const second={...manifest,run:{command:'node',args:['invalid\nargument']}},revision={...f.input.source,commit:'b'.repeat(40)};
    await assert.rejects(runtime.deploy({...f.input,source:revision,manifest:second,files:{...f.input.files,'operator-package.json':JSON.stringify(second)}}),/control characters/);
  }finally{await runtime.close();f.close();}
  const other=fixture();let written=false;
  const unrelated=new ManagedRuntime(other.config,async(_command,args)=>({stdout:args.includes('--property=Version')?'Version=fixture':'LoadState=loaded\nActiveState=active\nWorkingDirectory=/opt/unrelated\n',stderr:'',exitCode:0,truncated:false}),{isRoot:()=>true,writeUnit:()=>{written=true;}});
  try{
    const manifest={...other.manifest,check:undefined,build:undefined};await assert.rejects(unrelated.deploy({...other.input,manifest,files:{...other.input.files,'operator-package.json':JSON.stringify(manifest)}}),/working directory/);assert.equal(written,false);
  }finally{await unrelated.close();other.close();}
});

test('connector preparation runs its declared checks and rejects source mutation by checks',async()=>{
  const f=fixture(),runtime=new ManagedRuntime(f.config);
  try{
    const manifest:ManagedManifest={schemaVersion:1,id:f.project.id,kind:'connector',name:'Checked connector',description:'',check:{command:process.execPath,args:['-e','process.exit(6)']},mcp:{transport:'stdio',command:'node',args:['server.mjs']}};
    const input={...f.input,source:{...f.input.source,path:managedPath('connector',f.project.id)},manifest,files:{...f.input.files,'operator-package.json':JSON.stringify(manifest)}};
    await assert.rejects(runtime.prepare(input),/exit code 6/);
    const changed={...manifest,check:{command:process.execPath,args:['-e','require("node:fs").writeFileSync("server.mjs","changed")']}};
    await assert.rejects(runtime.prepare({...input,source:{...input.source,commit:'c'.repeat(40)},manifest:changed,files:{...input.files,'operator-package.json':JSON.stringify(changed)}}),/differs from its committed snapshot|expected size/);
  }finally{await runtime.close();f.close();}
});

test('failed checks and unavailable systemd report failure without starting or stopping a service',async()=>{
  const f=fixture(),fake=manager(f.config),runtime=new ManagedRuntime(f.config,fake.command,fake.host);
  try{
    const manifest={...f.manifest,check:{command:process.execPath,args:['-e','process.exit(7)']}};
    const input={...f.input,manifest,files:{...f.input.files,'operator-package.json':JSON.stringify(manifest)}};
    await assert.rejects(runtime.deploy(input),/exit code 7/);assert(!fake.calls.some(call=>call.command.includes('systemd')||call.args[0]==='stop'));
  }finally{await runtime.close();f.close();}
  const other=fixture(),unavailable=new ManagedRuntime(other.config,async()=>({stdout:'',stderr:'No system manager',exitCode:1,truncated:false}),{isRoot:()=>true,writeUnit:()=>{throw new Error('Must not install a unit');}});
  try{await assert.rejects(unavailable.deploy({...other.input,manifest:{...other.manifest,check:undefined,build:undefined},files:{...other.input.files,'operator-package.json':JSON.stringify({...other.manifest,check:undefined,build:undefined})}}),/Systemd is unavailable/);}finally{await unavailable.close();other.close();}
});

test('release path checks reject traversal, identity mismatches, and symlinked runtime paths before commands execute',async()=>{
  const f=fixture(),runtime=new ManagedRuntime(f.config,async()=>{throw new Error('Host commands must not run');});
  try{
    await assert.rejects(runtime.prepare({...f.input,files:{...f.input.files,'../outside':'bad'}}),/relative paths/);
    await assert.rejects(runtime.prepare({...f.input,source:{...f.input.source,path:'src/operator'}}),/identity/);
    const outside=join(f.config.stateDir,'outside');mkdirSync(outside);symlinkSync(outside,f.project.directory);
    await assert.rejects(runtime.prepare(f.input),/canonical/);assert.equal(existsSync(join(outside,'releases')),false);
  }finally{await runtime.close();f.close();}
});

test('managed command timeout terminates descendants and bounds captured output',async()=>{
  const f=fixture(),run=managedCommand(f.config),pidPath=join(f.config.stateDir,'helper.pid');
  try{
    await assert.rejects(run(process.execPath,['-e',`require('node:fs').writeFileSync(${JSON.stringify(pidPath)},String(process.pid));require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});setInterval(()=>{},1000);`],{timeoutMs:1000,signal:new AbortController().signal}),/timed out/);
    assert.deepEqual(groupMembers(Number(readFileSync(pidPath,'utf8'))),[]);
    await assert.rejects(run(process.execPath,['-e',`process.stdout.write('x'.repeat(300000));setInterval(()=>{},1000);`],{timeoutMs:3000,signal:new AbortController().signal}),/exceeded 256 kB/);
  }finally{f.close();}
});

test('status and logs remain responsive while another revision is building',async()=>{
  const f=fixture(),fake=manager(f.config);let beginBuild!:()=>void,finishBuild!:()=>void;
  const building=new Promise<void>(ok=>{beginBuild=ok;}),completed=new Promise<void>(ok=>{finishBuild=ok;});
  const command:ManagedCommand=async(path,args,options)=>{if(path==='fixture-build'){beginBuild();await completed;return {stdout:'',stderr:'',exitCode:0,truncated:false};}return fake.command(path,args,options);};
  const runtime=new ManagedRuntime(f.config,command,fake.host);let deployment:Promise<unknown>|undefined;
  try{
    await runtime.deploy(f.input);
    const manifest={...f.manifest,build:{command:'fixture-build',args:[]}};
    deployment=runtime.deploy({...f.input,manifest,source:{...f.input.source,commit:'b'.repeat(40)},files:{...f.input.files,'operator-package.json':JSON.stringify(manifest)}});await building;
    let timer:NodeJS.Timeout|undefined;
    try{
      const [status,logs]=await Promise.race([Promise.all([runtime.status({project:f.project}),runtime.logs({project:f.project})]),new Promise<never>((_ok,no)=>{timer=setTimeout(()=>no(new Error('Observation waited for the build')),1000);})]);
      assert.equal(status.status,'running');assert.equal(status.commit,f.input.source.commit);assert.equal(logs.text,'fixture service log');
    }finally{clearTimeout(timer);}
  }finally{finishBuild();await deployment;await runtime.close();f.close();}
});

test('a verified service can be stopped while its current state is transitional',async()=>{
  const f=fixture(),fake=manager(f.config);let transitional=false;
  const command:ManagedCommand=async(path,args,options)=>{const result=await fake.command(path,args,options);return transitional?{...result,stdout:result.stdout.replace('ActiveState=active\n','ActiveState=activating\n')}:result;};
  const runtime=new ManagedRuntime(f.config,command,fake.host);
  try{
    await runtime.deploy(f.input);transitional=true;assert.equal((await runtime.status({project:f.project})).status,'unknown');
    assert.equal((await runtime.stop({project:f.project})).status,'stopped');assert(fake.calls.some(call=>call.args[0]==='disable'));
  }finally{await runtime.close();f.close();}
});

test('deployment reports the observed revision and completion time, and rejects a manager still using the prior release',async()=>{
  const f=fixture(),fake=manager(f.config);let writes=0,builtAt=0;
  const host:ManagedServiceHost={...fake.host,writeUnit:(name,content)=>{if(writes++===0)fake.host.writeUnit(name,content);}};
  const command:ManagedCommand=async(path,args,options)=>{const result=await fake.command(path,args,options);if(options.cwd)builtAt=Date.now();return result;};
  const runtime=new ManagedRuntime(f.config,command,host);
  try{
    const initial=await runtime.deploy(f.input);assert(Date.parse(initial.checkedAt)>=builtAt);
    await assert.rejects(runtime.deploy({...f.input,source:{...f.input.source,commit:'b'.repeat(40)}}),/requested committed release/);
    assert.equal((await runtime.status({project:f.project})).commit,f.input.source.commit);
  }finally{await runtime.close();f.close();}
});
