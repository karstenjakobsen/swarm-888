import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter,once } from 'node:events';
import { createRequire } from 'node:module';
import { existsSync,mkdtempSync,readFileSync,readdirSync,rmSync,statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initState,type Config } from '../src/config.ts';
import { Store } from '../src/store.ts';
import { CredentialVault } from '../src/credentials/vault.ts';
import { resolveProjectSecrets } from '../src/credentials/runtime.ts';
import { ManagedRuntime,managedCommand,type ManagedCommand,type ManagedServiceHost } from '../src/runtime/managed.ts';
import { ServiceOutputRedactor,serviceDescriptorPath,serviceLaunchSchema } from '../src/runtime/service-launch.ts';
import { managedPath,type ManagedManifest } from '../src/managed/schemas.ts';
import { createController } from '../src/controller.ts';

function fixture(){
  const stateDir=mkdtempSync(join(tmpdir(),'operator-service-env-')),config:Config={stateDir,projectsDir:join(stateDir,'projects'),runtimeHome:join(stateDir,'runtime'),socketPath:join(stateDir,'worker.sock'),bridgeSocket:join(stateDir,'bridge.sock'),ipcToken:'',controllerUid:process.getuid!(),codexBin:'unused',host:'127.0.0.1',port:3001,origins:['http://localhost:5173'],adminPassword:'service-env-fixture-password',secureCookie:false,improvementEnabled:false,improvementTimeoutMs:1000,improvementMaxTurns:1,allowTempState:true,requireRootWorker:false};initState(config);
  return {config,close(){rmSync(stateDir,{recursive:true,force:true});}};
}
function fakeHost(config:Config){
  let directory:string|undefined,description:string|undefined,running=false;const units:string[]=[],calls:Array<{command:string;args:string[];cwd?:string}>=[],helper=managedCommand(config);
  const host:ManagedServiceHost={isRoot:()=>true,writeUnit:(_name,content)=>{units.push(content);directory=content.match(/^WorkingDirectory="(.*)"$/m)?.[1];description=content.match(/^Description=(.*)$/m)?.[1];}};
  const command:ManagedCommand=async(command,args,options)=>{
    calls.push({command,args,cwd:options.cwd});if(command!=='/usr/bin/systemctl')return helper(command,args,options);
    if(args[0]==='restart')running=true;if(args[0]==='disable')running=false;
    return {stdout:args.includes('--property=Version')?'Version=fixture':directory?`LoadState=loaded\nActiveState=${running?'active':'inactive'}\nSubState=${running?'running':'dead'}\nWorkingDirectory=${directory}\nDescription=${description}\nResult=success\n`:'LoadState=not-found\n',stderr:'',exitCode:0,truncated:false};
  };return {host,command,units,calls};
}

class DeploymentWorker extends EventEmitter {
  deployments:any[]=[];
  constructor(private config:Config){super();}
  async connect(){return {connected:true,uid:0,executionUid:0,root:true,pid:1234,workerId:'default',activeRunId:null,uncertainRuns:[],runtimeOperations:[],projectsDir:this.config.projectsDir,runtime:{available:true,authenticated:true,version:'fixture',detail:'No host operations'}};}
  async request(method:string,input:any){assert.equal(method,'managed/deploy');this.deployments.push(input);return {unitName:`vps-ai-project-${input.project.id}.service`,commit:input.source.commit,releaseDirectory:join(input.project.directory,'releases',input.source.commit),status:'running',detail:'Simulated service',checkedAt:new Date().toISOString()};}
  close(){}
}

test('only owner routes save project environment references and deployment carries no secret values',async()=>{
  const f=fixture(),worker=new DeploymentWorker(f.config),ctl=await createController(f.config,{client:worker as any,startQueue:false,startBridge:false});
  try{
    const project=ctl.projects.create({name:'Credential service'}),credential=ctl.vault.create({name:'Service key',values:{token:'fixture-project-service-token'}}),environment={credentialId:credential.id,bindings:{SERVICE_TOKEN:'token'}},url=`/api/projects/${project.id}/environment`;
    assert.equal((await ctl.app.inject({method:'GET',url})).statusCode,401);
    const login=await ctl.app.inject({method:'POST',url:'/api/login',headers:{origin:f.config.origins[0]},payload:{password:f.config.adminPassword}}),headers={origin:f.config.origins[0],cookie:String(login.headers['set-cookie']).split(';')[0],'x-csrf-token':login.json().csrfToken};
    assert.equal((await ctl.app.inject({method:'PUT',url,headers:{cookie:headers.cookie,origin:headers.origin},payload:{environment}})).statusCode,403);
    assert.equal((await ctl.app.inject({method:'PUT',url,headers:{...headers,origin:'https://outside.invalid'},payload:{environment}})).statusCode,403);
    for(const binding of [{NODE_OPTIONS:'token'},{APP_STATE_DIR:'token'},{SERVICE_TOKEN:'token',LD_PRELOAD:'token'}])assert.equal((await ctl.app.inject({method:'PUT',url,headers,payload:{environment:{credentialId:credential.id,bindings:binding}}})).statusCode,400);
    const saved=await ctl.app.inject({method:'PUT',url,headers,payload:{environment}});assert.equal(saved.statusCode,200,saved.body);assert.deepEqual(saved.json().environment,environment);assert.equal(saved.json().readiness.ready,true);assert.equal(saved.body.includes('fixture-project-service-token'),false);
    assert.deepEqual({...resolveProjectSecrets(f.config,project.id,environment).env},{SERVICE_TOKEN:'fixture-project-service-token'});
    assert.equal(JSON.stringify(ctl.store.db.prepare('SELECT * FROM project_environment').all()).includes('fixture-project-service-token'),false);
    assert.equal(ctl.brain.listTools().some(tool=>tool.name.includes('environment')),false,'Model tools cannot grant service credentials');
    const manifest:ManagedManifest={schemaVersion:1,id:project.id,kind:'project',name:'Bound service',description:'',run:{command:'node',args:['server.mjs']}};
    ctl.managed.readSource=async()=>({source:{commit:'a'.repeat(40),path:managedPath('project',project.id),dirty:false},manifest,files:{'operator-package.json':JSON.stringify(manifest),'server.mjs':''}}) as any;
    await ctl.managed.deploy(project.id);assert.deepEqual(worker.deployments[0].environment,environment);assert.equal(JSON.stringify(worker.deployments).includes('fixture-project-service-token'),false);
    const invalid=await ctl.app.inject({method:'PUT',url,headers,payload:{environment,values:{token:'fixture-project-service-token'}}});assert.equal(invalid.statusCode,400);
    const cleared=await ctl.app.inject({method:'PUT',url,headers,payload:{environment:null}});assert.equal(cleared.statusCode,200,cleared.body);assert.deepEqual(cleared.json(),{environment:null,readiness:{ready:true}});assert.throws(()=>resolveProjectSecrets(f.config,project.id,environment),/granted/);
    await ctl.managed.deploy(project.id);assert.equal(worker.deployments[1].environment,undefined);
  }finally{await ctl.close();f.close();}
});

test('service deployment uses private reference descriptors, isolates build env, and restarts when credential material changes',async()=>{
  const f=fixture(),store=new Store(f.config.stateDir),vault=new CredentialVault(f.config.stateDir,store.db),fake=fakeHost(f.config),runtime=new ManagedRuntime(f.config,fake.command,fake.host),token='fixture-deployed-secret-token';
  try{
    const project={id:'11111111-1111-4111-8111-111111111111',directory:join(f.config.projectsDir!,'fixture')},credential=vault.create({name:'Service',values:{token}}),environment={credentialId:credential.id,bindings:{SERVICE_TOKEN:'token'}};vault.grantProject(credential.id,project.id);
    const args=['server.mjs','percent %s','cost $VALUE','quote " slash \\',''];
    const manifest:ManagedManifest={schemaVersion:1,id:project.id,kind:'project',name:'Environment fixture',description:'',check:{command:process.execPath,args:['-e','require("node:fs").writeFileSync("check-env",process.env.SERVICE_TOKEN??"missing")']},build:{command:process.execPath,args:['-e','require("node:fs").writeFileSync("build-env",process.env.SERVICE_TOKEN??"missing")']},run:{command:'node',args}};
    const input={project,environment,source:{commit:'a'.repeat(40),path:managedPath('project',project.id)},manifest,files:{'operator-package.json':JSON.stringify(manifest),'server.mjs':'console.log("fixture")'}};
    const deployed=await runtime.deploy(input),directory=join(project.directory,'.operator-service'),firstPath=join(directory,readdirSync(directory)[0]!);
    assert.equal(readFileSync(join(deployed.releaseDirectory,'check-env'),'utf8'),'missing');assert.equal(readFileSync(join(deployed.releaseDirectory,'build-env'),'utf8'),'missing');
    const descriptor=serviceLaunchSchema.parse(JSON.parse(readFileSync(firstPath,'utf8')));assert.deepEqual(descriptor.args,args);assert.deepEqual(descriptor.environment,environment);assert.equal(firstPath,serviceDescriptorPath(descriptor));assert.equal(statSync(firstPath).mode&0o777,0o600);assert.equal(readFileSync(firstPath,'utf8').includes(token),false);
    assert(fake.units[0].includes('service-launch.ts'));assert.equal(JSON.stringify({units:fake.units,calls:fake.calls}).includes(token),false);
    await runtime.deploy(input);assert.equal(fake.units.length,1,'Same source and environment must not rebuild/restart');
    vault.update(credential.id,{values:{token:'fixture-rotated-service-token'}});await runtime.deploy(input);assert.equal(fake.units.length,2);assert.equal(readdirSync(directory).length,2);assert.notEqual(fake.units[0],fake.units[1]);assert.equal(readFileSync(firstPath,'utf8'),JSON.stringify(descriptor),'Old launch references remain immutable');
    await runtime.deploy({...input,environment:null});assert.equal(fake.units.length,3);assert.equal(fake.units[2].includes('service-launch.ts'),false);await runtime.deploy({...input,environment:null});assert.equal(fake.units.length,3);
    const other={...input,project:{id:'22222222-2222-4222-8222-222222222222',directory:join(f.config.projectsDir!,'foreign')}};await assert.rejects(runtime.deploy(other),/identity/);
    const foreignManifest={...manifest,id:other.project.id};await assert.rejects(runtime.deploy({...other,manifest:foreignManifest,source:{...input.source,path:managedPath('project',other.project.id)},files:{...input.files,'operator-package.json':JSON.stringify(foreignManifest)}}),/granted/);assert.equal(fake.units.length,3);
  }finally{await runtime.close();store.close();f.close();}
});

test('stream redaction retains split and escaped credentials without leaking chunk boundaries',()=>{
  const secret='split-secret-"value\\tail',filter=new ServiceOutputRedactor([secret]),escaped=JSON.stringify(secret).slice(1,-1),input=`before ${secret} middle ${escaped} after`;
  let output='';for(const char of input)output+=filter.write(Buffer.from(char));output+=filter.end();assert.equal(output,'before [REDACTED] middle [REDACTED] after');
  const plain=new ServiceOutputRedactor([]);assert.equal(plain.write(Buffer.from('safe output')),'safe output');assert.equal(plain.end(),'');
});

test('the persistent service supervisor forwards signals and redacts stdout/stderr before journal delivery',{timeout:10000},async()=>{
  const f=fixture(),store=new Store(f.config.stateDir),vault=new CredentialVault(f.config.stateDir,store.db),fake=fakeHost(f.config),runtime=new ManagedRuntime(f.config,fake.command,fake.host),token='fixture-supervised-private-token';let child:ReturnType<typeof spawn>|undefined,closed=false;
  try{
    const project={id:'33333333-3333-4333-8333-333333333333',directory:join(f.config.projectsDir!,'fixture')},credential=vault.create({name:'Service',values:{token}}),environment={credentialId:credential.id,bindings:{SERVICE_TOKEN:'token'}};vault.grantProject(credential.id,project.id);
    const manifest:ManagedManifest={schemaVersion:1,id:project.id,kind:'project',name:'Supervised fixture',description:'',run:{command:'node',args:['server.mjs','percent %s','cost $VALUE','quote " slash \\','']}};
    const program=`import{writeFileSync}from'node:fs';const value=process.env.SERVICE_TOKEN;process.stdout.write('argv '+JSON.stringify(process.argv.slice(2))+'\\n');process.stdout.write('token '+value.slice(0,8));setTimeout(()=>{process.stdout.write(value.slice(8)+'\\n');process.stderr.write('error '+value+'\\n');process.stdout.write('ambient '+JSON.stringify({model:process.env.OPENAI_API_KEY??null,bridge:process.env.APP_BRIDGE_TOKEN??null})+'\\n');writeFileSync('ready','yes');},20);process.on('SIGTERM',()=>{process.stdout.write('forwarded termination\\n');process.exit(0);});setInterval(()=>{},1000);`;
    const deployed=await runtime.deploy({project,environment,manifest,source:{commit:'b'.repeat(40),path:managedPath('project',project.id)},files:{'operator-package.json':JSON.stringify(manifest),'server.mjs':program}}),descriptor=join(project.directory,'.operator-service',readdirSync(join(project.directory,'.operator-service'))[0]!);
    child=spawn(process.execPath,['--import',createRequire(import.meta.url).resolve('tsx'),new URL('../src/runtime/service-launch.ts',import.meta.url).pathname,descriptor],{env:{...process.env,OPENAI_API_KEY:'fixture-model-key',APP_BRIDGE_TOKEN:'fixture-bridge-key'},stdio:['ignore','pipe','pipe']});let stdout='',stderr='';child.stdout!.on('data',chunk=>{stdout+=chunk.toString();});child.stderr!.on('data',chunk=>{stderr+=chunk.toString();});child.once('close',()=>{closed=true;});
    const deadline=Date.now()+5000;while(!existsSync(join(deployed.releaseDirectory,'ready'))){assert(Date.now()<deadline,`Service did not start: ${stderr}`);await new Promise(ok=>setTimeout(ok,10));}
    child.kill('SIGTERM');const [code]=await once(child,'close');assert.equal(code,0,stderr);assert.equal(stdout.includes(token),false);assert.equal(stderr.includes(token),false);assert.match(stdout,/token \[REDACTED\]/);assert.match(stderr,/error \[REDACTED\]/);assert.match(stdout,/forwarded termination/);assert.match(stdout,/"model":null,"bridge":null/);assert(stdout.includes(JSON.stringify(manifest.run!.args.slice(1))));
  }finally{if(child&&!closed)child.kill('SIGTERM');await runtime.close();store.close();f.close();}
});
