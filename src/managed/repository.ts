import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { projectRoot, type Config } from '../config.ts';
import { managedCreateSchema, managedFilesSchema, managedKind, managedManifestSchema, managedPath, type ManagedCreate, type ManagedExport, type ManagedKind, type ManagedManifest, type ManagedSource } from './schemas.ts';

const branch='operator/generated', manifestFile='operator-package.json', maxBytes=8_000_000;
const failure=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** Source names deliberately exclude credentials, mutable state and generated dependencies/output. */
export function managedFilePath(name:string):string {
  if(!name||name==='__proto__'||name.length>240||/[\\\x00-\x1f\x7f]/.test(name)||isAbsolute(name))throw failure('Managed source paths must be relative package files without reserved filenames',400);
  const pieces=name.split('/');
  if(pieces.some((piece,index)=>!piece||piece==='.'||piece==='..'||/^\.env(?:\.|$)/i.test(piece)||/^(?:\.git|\.agents|\.ssh|\.codex|\.cache|node_modules|secrets|credentials)$/i.test(piece)||(index===0&&/^(?:dist|build|coverage|runtime|releases|logs)$/i.test(piece))||/^(?:auth|credentials|secrets)\.(?:json|ya?ml|toml)$/i.test(piece)||/\.(?:pem|key|p12|pfx|sqlite|sqlite3|db|log)$/i.test(piece)||piece.startsWith('.operator-tmp-')))throw failure('Credentials, runtime files, dependencies and build outputs do not belong in managed source',400);
  return name;
}

function validateFiles(files:Record<string,string>,kind:ManagedKind,id:string):ManagedManifest {
  managedFilesSchema.parse(files);
  for(const [name,body] of Object.entries(files)){
    managedFilePath(name);
    if(body.includes('\0')||Buffer.from(body,'utf8').toString('utf8')!==body)throw failure('Managed packages support UTF-8 text files only',400);
  }
  const names=new Set(Object.keys(files));
  for(const name of names){const pieces=name.split('/');while(pieces.length>1){pieces.pop();if(names.has(pieces.join('/')))throw failure('A managed source file cannot also be a parent directory',400);}}
  if(!files[manifestFile])throw failure(`Managed source requires ${manifestFile}`,400);
  let raw:unknown;try{raw=JSON.parse(files[manifestFile]);}catch{throw failure('Managed package manifest must contain valid JSON',400);}
  const manifest=managedManifestSchema.parse(raw);
  if(manifest.id!==id.toLowerCase()||manifest.kind!==kind)throw failure('Managed package manifest identity cannot change',400);
  return manifest;
}

export class ManagedRepository {
  readonly repositoryPath:string;
  readonly workspacePath:string;
  private readonly lockPath:string;
  private pending:Promise<unknown>=Promise.resolve();
  private secretGuard?:(value:unknown)=>void;
  constructor(private config:Config){
    this.repositoryPath=resolve(config.repositoryPath??projectRoot);
    this.workspacePath=resolve(config.stateDir,'workspaces','managed');
    this.lockPath=resolve(config.stateDir,'workspaces','managed-repository.lock');
  }
  setSecretGuard(guard:(value:unknown)=>void){this.secretGuard=guard;}
  private git(cwd:string,args:string[],allowFailure=false):string {
    const env={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
    env.GIT_TERMINAL_PROMPT='0';env.GIT_LITERAL_PATHSPECS='1';
    try{return execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-c','commit.gpgSign=false','-c','core.quotePath=false','-C',cwd,...args],{encoding:'utf8',env,timeout:15_000,maxBuffer:10_000_000,stdio:['ignore','pipe','pipe']});}
    catch(error){
      if(allowFailure)return '';
      const detail=(error as {stderr?:Buffer|string}).stderr?.toString().trim().slice(0,1000);
      throw failure(`Managed Git operation failed${detail?`: ${detail}`:'.'}`);
    }
  }
  private async exclusive<T>(operation:()=>T|Promise<T>):Promise<T>{
    const run=this.pending.then(async()=>{
      if(process.getuid?.()!==this.config.controllerUid)throw failure('Managed Git operations must run as the normal controller owner',403);
      const parent=dirname(this.lockPath);mkdirSync(parent,{recursive:true,mode:0o700});
      if(realpathSync(parent)!==parent)throw failure('Managed repository state must use canonical directories');
      try{mkdirSync(this.lockPath,{mode:0o700});}
      catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw failure('Managed repository is busy. If its previous controller stopped unexpectedly, remove the managed-repository.lock directory only after confirming no managed source operation is running.');throw error;}
      try{writeFileSync(join(this.lockPath,'owner.json'),JSON.stringify({pid:process.pid,createdAt:new Date().toISOString()}),{mode:0o600});return await operation();}
      finally{rmSync(this.lockPath,{recursive:true,force:true});}
    });
    this.pending=run.catch(()=>{});return run;
  }
  private ensureUnlocked():void {
    if(realpathSync(this.repositoryPath)!==this.repositoryPath||!lstatSync(this.repositoryPath).isDirectory())throw failure('Managed source repository must be a canonical checkout');
    if(lstatSync(this.repositoryPath).uid!==this.config.controllerUid)throw failure('Managed source repository must belong to the controller owner');
    if(resolve(this.git(this.repositoryPath,['rev-parse','--show-toplevel']).trim())!==this.repositoryPath)throw failure('APP_REPOSITORY_PATH must identify the repository checkout root');
    this.git(this.repositoryPath,['rev-parse','--verify','HEAD']);
    if(!existsSync(this.workspacePath)){
      const exists=Boolean(this.git(this.repositoryPath,['show-ref','--verify',`refs/heads/${branch}`],true));
      this.git(this.repositoryPath,['worktree','add',...(exists?[]:['-b',branch]),this.workspacePath,exists?branch:'HEAD']);
    }
    if(realpathSync(this.workspacePath)!==this.workspacePath||lstatSync(this.workspacePath).uid!==this.config.controllerUid)throw failure('Managed worktree must be canonical and owned by the controller');
    const common=(path:string)=>resolve(path,this.git(path,['rev-parse','--git-common-dir']).trim());
    if(common(this.workspacePath)!==common(this.repositoryPath)||this.git(this.workspacePath,['symbolic-ref','--short','HEAD']).trim()!==branch)throw failure('Managed workspace belongs to another repository or branch; it has not been modified');
    if(this.git(this.workspacePath,['ls-files','--unmerged','-z']))throw failure('Managed source has unresolved merge conflicts');
  }
  ensure():Promise<void>{return this.exclusive(()=>this.ensureUnlocked());}
  private directory(kind:ManagedKind,id:string):string {
    const path=join(this.workspacePath,managedPath(kind,id));
    let parent=path;while(!existsSync(parent)){const next=dirname(parent);if(next===parent)throw failure('Managed source parent is unavailable');parent=next;}
    if(realpathSync(parent)!==parent)throw failure('Managed source must not contain symlinks');
    return path;
  }
  private diskFiles(kind:ManagedKind,id:string):Record<string,string>{
    const directory=this.directory(kind,id),files:Record<string,string>=Object.create(null);let bytes=0;
    if(!existsSync(directory))throw failure('Managed source package not found',404);
    const visit=(folder:string,prefix='')=>{
      for(const name of readdirSync(folder)){
        if(!prefix&&name==='.agents')continue;
        const path=join(folder,name),key=prefix?`${prefix}/${name}`:name;managedFilePath(key);
        const info=lstatSync(path);
        if(info.isSymbolicLink()||(!info.isDirectory()&&!info.isFile()))throw failure('Managed source must contain only real directories and regular text files',400);
        if(info.isDirectory())visit(path,key);
        else{
          if(info.nlink!==1)throw failure('Managed source files must not be hard links',400);
          bytes+=info.size+Buffer.byteLength(key);if(bytes>maxBytes||Object.keys(files).length>=500)throw failure('Managed source must not exceed 8 MB or 500 files',400);
          const data=readFileSync(path);const body=data.toString('utf8');if(!Buffer.from(body,'utf8').equals(data))throw failure('Managed packages support UTF-8 text files only',400);files[key]=body;
        }
      }
    };
    visit(directory);validateFiles(files,kind,id);return files;
  }
  private changes():{changed:string[];staged:string[]}{
    const paths=(args:string[])=>this.git(this.workspacePath,args).split('\0').filter(Boolean);
    const staged=paths(['diff','--cached','--name-only','-z','--no-renames']);
    const tracked=[...staged,...paths(['diff','--name-only','-z','--no-renames'])];
    const discovered=[...paths(['ls-files','--others','--exclude-standard','-z']),...paths(['ls-files','--others','--ignored','--exclude-standard','-z'])].filter(path=>!/^generated\/(?:projects|connectors|skills)\/[0-9a-f-]{36}\/\.agents(?:\/|$)/.test(path));
    return {staged,changed:[...new Set([...tracked,...discovered])]};
  }
  private validateChanges(target:string):void {
    const {changed,staged}=this.changes();
    for(const path of changed){
      const match=/^generated\/(projects|connectors|skills)\/([0-9a-f-]{36})\/(.+)$/.exec(path);
      if(!match)throw failure(`Changes outside managed source are not allowed: ${path}`);
      const kind=managedKind.parse(({projects:'project',connectors:'connector',skills:'skill'} as const)[match[1] as 'projects'|'connectors'|'skills']);managedPath(kind,match[2]!);managedFilePath(match[3]!);
    }
    if(staged.some(path=>!path.startsWith(`${target}/`)))throw failure('Another package has staged changes in the managed worktree; they have not been committed');
  }
  private sourceUnlocked(kind:ManagedKind,id:string):ManagedSource {
    const path=managedPath(kind,id);this.directory(kind,id);
    const commit=this.git(this.workspacePath,['log','-1','--format=%H','--',path],true).trim()||null;
    return {repositoryPath:this.repositoryPath,branch,path,workspacePath:join(this.workspacePath,path),commit,dirty:this.changes().changed.some(value=>value===path||value.startsWith(`${path}/`))};
  }
  source(kind:ManagedKind,id:string):Promise<ManagedSource>{return this.exclusive(()=>{this.ensureUnlocked();return this.sourceUnlocked(kind,id);});}
  private validateCommit(files:Record<string,string>,message:string,runId?:string):void {
    this.secretGuard?.({files,message,runId});
    const secrets=[this.config.adminPassword,this.config.ipcToken,...Object.entries(process.env).filter(([key])=>/(?:KEY|TOKEN|PASSWORD|SECRET)$/.test(key)).map(([,value])=>value)].filter((value):value is string=>Boolean(value&&value.length>=6));
    for(const content of [...Object.values(files),message,runId??''])for(const secret of secrets){if(content.includes(secret)||content.includes(JSON.stringify(secret).slice(1,-1)))throw failure('Known credentials cannot be committed into generated source. Remove the credential value and use external configuration.',400);}
    if(!message.trim()||message.length>2000||message.includes('\0'))throw failure('Commit message must contain 1–2000 characters',400);
    if(runId!==undefined&&(!/^[A-Za-z0-9_-]{1,120}$/.test(runId)))throw failure('Invalid source commit run ID',400);
  }
  private commitUnlocked(kind:ManagedKind,id:string,message:string,runId?:string):ManagedSource {
    const path=managedPath(kind,id);this.validateChanges(path);const files=this.diskFiles(kind,id);this.validateCommit(files,message,runId);
    if(!this.changes().changed.some(value=>value.startsWith(`${path}/`)))return this.sourceUnlocked(kind,id);
    this.git(this.workspacePath,['add','--',...this.changes().changed.filter(value=>value.startsWith(`${path}/`))]);
    if(!this.git(this.workspacePath,['diff','--cached','--name-only','--',path]).trim())return this.sourceUnlocked(kind,id);
    this.git(this.workspacePath,['-c','user.name=VPS AI Operator','-c','user.email=operator@localhost','commit','--no-verify','-m',`${message.trim()}${runId?`\n\nOperator-Run: ${runId}`:''}`,'--only','--',path]);
    return this.sourceUnlocked(kind,id);
  }
  commit(kind:ManagedKind,id:string,message:string,runId?:string):Promise<ManagedSource>{return this.exclusive(()=>{this.ensureUnlocked();return this.commitUnlocked(kind,id,message,runId);});}
  private exportUnlocked(kind:ManagedKind,id:string,commit?:string):ManagedExport {
    const current=this.sourceUnlocked(kind,id),revision=commit??current.commit;
    if(!revision||!/^[0-9a-f]{40,64}$/.test(revision))throw failure('A committed managed source revision is required',400);
    this.git(this.workspacePath,['merge-base','--is-ancestor',revision,branch]);
    const files:Record<string,string>=Object.create(null);let bytes=0;
    for(const record of this.git(this.workspacePath,['ls-tree','-rz','--full-tree',revision,'--',current.path]).split('\0').filter(Boolean)){
      const match=/^(\d+) blob ([0-9a-f]+)\t(.+)$/.exec(record);
      if(!match||!['100644','100755'].includes(match[1]!))throw failure('Committed source contains a symlink or unsupported entry',400);
      const key=match[3]!.slice(current.path.length+1);managedFilePath(key);
      const body=this.git(this.workspacePath,['cat-file','blob',match[2]!]);
      const hash=createHash(match[2]!.length===64?'sha256':'sha1').update(`blob ${Buffer.byteLength(body)}\0`).update(body).digest('hex');
      if(hash!==match[2])throw failure('Committed packages support UTF-8 text files only',400);
      bytes+=Buffer.byteLength(key)+Buffer.byteLength(body);
      if(bytes>maxBytes||Object.keys(files).length>=500)throw failure('Managed source must not exceed 8 MB or 500 files',400);files[key]=body;
    }
    const manifest=validateFiles(files,kind,id);
    return {source:{...current,commit:revision,dirty:commit?false:current.dirty},manifest,files};
  }
  export(kind:ManagedKind,id:string,commit?:string):Promise<ManagedExport>{return this.exclusive(()=>{this.ensureUnlocked();return this.exportUnlocked(kind,id,commit);});}
  create(raw:ManagedCreate):Promise<ManagedExport>{return this.exclusive(()=>{
    this.ensureUnlocked();const input=managedCreateSchema.parse(raw),path=managedPath(input.kind,input.id);
    if(existsSync(this.directory(input.kind,input.id))){
      if(this.sourceUnlocked(input.kind,input.id).commit)return this.exportUnlocked(input.kind,input.id);
      throw failure('Managed source package already exists without a committed revision; inspect its draft before creating it again');
    }
    this.validateChanges(path);
    const {manifest,files}=scaffold(input);files[manifestFile]=JSON.stringify(manifest,null,2)+'\n';
    validateFiles(files,input.kind,input.id);this.validateCommit(files,`Create ${input.kind}: ${input.name}`);
    this.writeFiles(input.kind,input.id,files,[]);this.commitUnlocked(input.kind,input.id,`Create ${input.kind}: ${input.name}`);
    return this.exportUnlocked(input.kind,input.id);
  });}
  private writeFiles(kind:ManagedKind,id:string,files:Record<string,string>,removedFiles:string[]):void {
    const directory=this.directory(kind,id);mkdirSync(directory,{recursive:true,mode:0o700});
    for(const name of removedFiles){managedFilePath(name);const path=join(directory,name);if(existsSync(path)&&!lstatSync(path).isFile())throw failure('Only regular source files can be removed',400);rmSync(path,{force:true});}
    for(const [name,body] of Object.entries(files)){
      const path=join(directory,name);let parent=dirname(path);while(!existsSync(parent))parent=dirname(parent);
      if(realpathSync(parent)!==parent)throw failure('Managed source must not contain symlinks');
      mkdirSync(dirname(path),{recursive:true,mode:0o700});
      const temporary=join(dirname(path),`.operator-tmp-${randomUUID()}`);
      try{writeFileSync(temporary,body,{flag:'wx',mode:0o600});renameSync(temporary,path);}finally{rmSync(temporary,{force:true});}
    }
  }
  write(kind:ManagedKind,id:string,files:Record<string,string>,removedFiles:string[]=[],options:{message?:string;runId?:string;expectedCommit?:string|null}={}):Promise<ManagedExport>{return this.exclusive(()=>{
    this.ensureUnlocked();const path=managedPath(kind,id);this.validateChanges(path);managedFilesSchema.parse(files);
    if(options.expectedCommit!==undefined&&options.expectedCommit!==this.sourceUnlocked(kind,id).commit)throw failure('Managed source changed since it was loaded. Reload the source before saving.');
    if(removedFiles.length>500)throw failure('At most 500 source files can be removed',400);
    removedFiles.forEach(managedFilePath);Object.keys(files).forEach(managedFilePath);
    const merged=Object.assign(Object.create(null),this.diskFiles(kind,id)) as Record<string,string>;for(const name of removedFiles)delete merged[name];Object.assign(merged,files);validateFiles(merged,kind,id);this.validateCommit(merged,options.message??`Update ${kind} source`,options.runId);
    const directory=this.directory(kind,id);
    for(const name of [...removedFiles,...Object.keys(files)]){const target=join(directory,name);if(existsSync(target)&&!lstatSync(target).isFile())throw failure('Only regular source files can be replaced or removed',400);}
    this.writeFiles(kind,id,files,removedFiles);this.commitUnlocked(kind,id,options.message??`Update ${kind} source`,options.runId);
    return this.exportUnlocked(kind,id);
  });}
}

function scaffold(input:ReturnType<typeof managedCreateSchema.parse>):{manifest:ManagedManifest;files:Record<string,string>}{
  const manifest:ManagedManifest={schemaVersion:1,id:input.id,kind:input.kind,name:input.name,description:input.description};
  const files:Record<string,string>={'README.md':`# ${input.name}\n\n${input.description}\n\nManaged source. Credentials and runtime data belong outside this package.\n`};
  if(input.template==='service'){
    manifest.check={command:'node',args:['--test','service.test.mjs']};manifest.run={command:'node',args:['server.mjs']};
    files['server.mjs']="import { createServer } from 'node:http';\nimport { pathToFileURL } from 'node:url';\nexport function createService() { return createServer((_request, response) => { response.writeHead(200, {'content-type':'text/plain'}); response.end('Managed service ready\\n'); }); }\nif (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {\n  const server = createService();\n  server.listen(Number(process.env.PORT ?? 8080), '127.0.0.1');\n  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));\n}\n";
    files['service.test.mjs']="import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { createService } from './server.mjs';\ntest('service responds over HTTP', async () => { const server = createService(); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); try { const response = await fetch(`http://127.0.0.1:${server.address().port}`); assert.equal(response.status, 200); assert.equal(await response.text(), 'Managed service ready\\n'); } finally { await new Promise(resolve => server.close(resolve)); } });\n";
  }else if(input.template==='connector'){
    manifest.check={command:'node',args:['--test','connector.test.mjs']};manifest.mcp={transport:'stdio',command:'node',args:['server.mjs']};
    files['server.mjs']="import { createInterface } from 'node:readline';\nconst input = createInterface({input:process.stdin});\ninput.on('line', line => {\n  let request;\n  try {\n    request = JSON.parse(line);\n    if (request.id === undefined) return;\n    let result;\n    if (request.method === 'initialize') result = {protocolVersion:request.params?.protocolVersion ?? '2025-03-26',capabilities:{tools:{}},serverInfo:{name:'managed-fixture',version:'1.0.0'}};\n    else if (request.method === 'tools/list') result = {tools:[{name:'echo',description:'Echo fixture text',inputSchema:{type:'object',properties:{text:{type:'string'}},required:['text'],additionalProperties:false}}]};\n    else if (request.method === 'tools/call' && request.params?.name === 'echo') result = {content:[{type:'text',text:String(request.params.arguments?.text ?? '')}]};\n    else { process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32601,message:'Method not found'}}) + '\\n'); return; }\n    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,result}) + '\\n');\n  } catch { if (request?.id !== undefined) process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:request.id,error:{code:-32602,message:'Invalid request'}}) + '\\n'); }\n});\n";
    files['connector.test.mjs']="import test from 'node:test';\nimport assert from 'node:assert/strict';\nimport { spawnSync } from 'node:child_process';\ntest('MCP initializes, lists tools and calls echo over stdio', () => { const requests = [{jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'fixture',version:'1'}}},{jsonrpc:'2.0',id:2,method:'tools/list',params:{}},{jsonrpc:'2.0',id:3,method:'tools/call',params:{name:'echo',arguments:{text:'fixture evidence'}}}]; const child = spawnSync(process.execPath, ['server.mjs'], {input:requests.map(JSON.stringify).join('\\n') + '\\n',encoding:'utf8',timeout:5000}); assert.equal(child.status, 0); const replies = child.stdout.trim().split('\\n').map(line => JSON.parse(line)); assert.equal(replies[0].result.serverInfo.name, 'managed-fixture'); assert.equal(replies[1].result.tools[0].name, 'echo'); assert.equal(replies[2].result.content[0].text, 'fixture evidence'); });\n";
  }
  return {manifest,files};
}
