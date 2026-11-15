import { spawnSync } from 'node:child_process';
import { accessSync, chmodSync, chownSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, type Stats } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { projectRoot, type Config } from '../config.ts';

const setpriv = '/usr/bin/setpriv';
const privilegedGroups = new Set(['root','sudo','wheel','docker','lxd','incus','disk','libvirt']);

export function inside(root:string,path:string):boolean {
  const rel=relative(resolve(root),resolve(path));
  return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));
}

function identity(config:Config):{uid:number;gid:number} {
  const uid=config.executionUid,gid=config.executionGid;
  if(uid===undefined||gid===undefined)throw new Error(`Protected worker requires a dedicated non-root execution account. ${config.executionUser?`Local account ${config.executionUser} was not found. Create it using the README dedicated-account setup, then retry the worker command.`:'Set APP_EXECUTION_USER=vps-ai-projects after creating that account, or configure both APP_EXECUTION_UID and APP_EXECUTION_GID in .env.'}`);
  if(!Number.isSafeInteger(uid)||!Number.isSafeInteger(gid)||uid<=0||gid<=0||uid===config.controllerUid)throw new Error('Protected worker requires dedicated non-root APP_EXECUTION_UID/GID different from the controller UID. Do not use root or your controller account.');
  return {uid:uid!,gid:gid!};
}

function writableBy(info:Stats,uid:number,gid:number):boolean {
  return Boolean(info.mode&0o002)||(info.uid===uid&&Boolean(info.mode&0o200))||(info.gid===gid&&Boolean(info.mode&0o020));
}

/** Verify the release and its ancestors cannot be rewritten by the execution identity. */
export function verifyProtectedTree(root:string,uid:number,gid:number):string[] {
  const protectedPaths=new Set<string>();
  function ancestors(path:string){
    let ancestor=resolve(path);
    while(true){
      if(protectedPaths.has(ancestor))break;
      const info=statSync(ancestor);protectedPaths.add(ancestor);
      if(info.uid===uid||writableBy(info,uid,gid))throw new Error(`Operator protection failed: execution UID can modify ${ancestor}`);
      const parent=dirname(ancestor);if(parent===ancestor)break;ancestor=parent;
    }
  }
  ancestors(root);
  const visited=new Set<string>();
  function visit(path:string){
    const canonical=realpathSync(path);if(visited.has(canonical))return;visited.add(canonical);
    ancestors(canonical);
    const info=statSync(canonical);
    if(info.uid===uid||writableBy(info,uid,gid))throw new Error(`Operator protection failed: execution UID can modify ${path}`);
    if(info.isDirectory())for(const name of readdirSync(canonical))visit(join(canonical,name));
  }
  visit(resolve(root));
  return [...protectedPaths];
}

export function verifyEffectiveAccess(config:Config,paths:string[]):void {
  if(paths.some(path=>/[\r\n]/.test(path)))throw new Error('Protected release paths must not contain newlines.');
  // Use the OS shell with no custom loader path: the application executable itself
  // is among the files whose effective ACL permissions are being verified.
  const script='while IFS= read -r path; do if [ -w "$path" ]; then printf "%s\\n" "$path"; exit 2; fi; done; printf "protected\\n"';
  const invocation=executionCommand(config,'/bin/sh',['-c',script],false);
  const result=spawnSync(invocation.command,invocation.args,{encoding:'utf8',env:executionEnvironment(config),input:paths.join('\n')+'\n',timeout:30_000,maxBuffer:16_000});
  if(result.error||result.status!==0||result.stdout.trim()!=='protected')throw new Error(`Operator protection failed: effective execution-account write access or ACL check failed${result.status===2?` at ${result.stdout.trim().slice(0,2000)}`:''}.`);
}

export function verifyPrivateAccess(config:Config,paths:string[]):void {
  if(paths.some(path=>/[\r\n]/.test(path)))throw new Error('Private operator paths must not contain newlines.');
  const script='while IFS= read -r path; do if [ -r "$path" ]; then printf "%s\\n" "$path"; exit 2; fi; done; printf "private\\n"';
  const invocation=executionCommand(config,'/bin/sh',['-c',script],false);
  const result=spawnSync(invocation.command,invocation.args,{encoding:'utf8',env:executionEnvironment(config),input:paths.join('\n')+'\n',timeout:5000,maxBuffer:16_000});
  if(result.error||result.status!==0||result.stdout.trim()!=='private')throw new Error(`Operator configuration and controller state must be private to the controller account. Set .env mode 0600 and controller state mode 0700; execution-account read access was detected${result.status===2?` at ${result.stdout.trim().slice(0,2000)}`:''}.`);
}

function executionCanWrite(config:Config,path:string):boolean {
  const script='if [ -w "$1" ]; then printf "yes\\n"; else printf "no\\n"; fi';
  const invocation=executionCommand(config,'/bin/sh',['-c',script,'operator-permission-check',path],false);
  const result=spawnSync(invocation.command,invocation.args,{encoding:'utf8',env:executionEnvironment(config),timeout:5000,maxBuffer:1000});
  if(result.error||result.status!==0||!['yes','no'].includes(result.stdout.trim()))throw new Error('Unable to verify workspace parent permissions as the execution account.');
  return result.stdout.trim()==='yes';
}

/** Called before accepting work. No flag alone is treated as proof of protection. */
export function verifyExecutionProtection(config:Config):void {
  if(config.protectOperator!==true)return;
  if(process.getuid?.()!==0)throw new Error('Protected worker broker must run as root; agent commands always use the separate execution UID.');
  const {uid,gid}=identity(config);
  const account=readFileSync('/etc/passwd','utf8').split('\n').map(line=>line.split(':')).find(fields=>Number(fields[2])===uid);
  if(!account||Number(account[3])!==gid)throw new Error('APP_EXECUTION_UID/GID must identify an existing dedicated account and its primary group.');
  const group=readFileSync('/etc/group','utf8').split('\n').map(line=>line.split(':')).find(fields=>Number(fields[2])===gid);
  if(group&&privilegedGroups.has(group[0]!))throw new Error('The execution account must use a dedicated unprivileged primary group.');
  const memberships=readFileSync('/etc/group','utf8').split('\n').map(line=>line.split(':')).filter(fields=>fields[3]?.split(',').includes(account[0]!));
  if(memberships.some(fields=>privilegedGroups.has(fields[0]!)))throw new Error('The execution account must not belong to privileged supplementary groups.');
  const resolvedGroups=spawnSync('/usr/bin/id',['-G',account[0]!],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
  const accountGroups=resolvedGroups.stdout.trim().split(/\s+/).map(Number);
  if(resolvedGroups.error||resolvedGroups.status!==0||!accountGroups.length||accountGroups.some(group=>group!==gid))throw new Error('The dedicated execution account must have no supplementary groups, including groups resolved through NSS.');
  if(existsSync('/usr/bin/sudo')){
    const sudo=spawnSync('/usr/bin/sudo',['-n','-l','-U',account[0]!],{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin',LC_ALL:'C'}});
    if(sudo.error||sudo.status!==1)throw new Error('The execution account must have no sudo grants; its effective policy could not be verified as denied.');
  }
  let managerVerified=false;
  for(const pid of readdirSync('/proc').filter(name=>/^\d+$/.test(name))){
    let status:string,args:string[];
    try{status=readFileSync(`/proc/${pid}/status`,'utf8');args=readFileSync(`/proc/${pid}/cmdline`,'utf8').split('\0');}catch{continue;}
    if(Number(/^Uid:\s+\d+\s+(\d+)/m.exec(status)?.[1])!==uid||!args.includes('--user')||!args.some(arg=>arg==='systemd'||arg.endsWith('/systemd')))continue;
    const caps=/^CapBnd:\s+([0-9a-f]+)$/mi.exec(status)?.[1];
    const effectiveGid=Number(/^Gid:\s+\d+\s+(\d+)/m.exec(status)?.[1]),groupText=/^Groups:[ \t]*(.*)$/m.exec(status)?.[1];
    const managerGroups=groupText?.trim()?groupText.trim().split(/\s+/).map(Number):[];
    if(effectiveGid!==gid||groupText===undefined||managerGroups.some(group=>group!==gid))throw new Error('The project user service manager must use only the dedicated execution group. Restart it after correcting account and service group configuration.');
    if(!/^NoNewPrivs:\s+1$/m.test(status)||caps===undefined||BigInt(`0x${caps}`)!==0n)throw new Error('The project user service manager must have NoNewPrivileges=yes and an empty CapabilityBoundingSet. Run the documented administrator worker setup.');
    managerVerified=true;
  }
  if(existsSync(`/run/user/${uid}/bus`)&&!managerVerified)throw new Error('The project user service manager could not be verified; stop it or run the documented administrator setup before starting the worker.');
  if(!config.projectsDir||!config.executionHome)throw new Error('Protected worker requires APP_PROJECTS_DIR and APP_EXECUTION_HOME outside operator state and source.');
  const protectedPaths=new Set<string>();
  for(const path of [config.projectsDir,config.executionHome]){
    if(!isAbsolute(path)||inside(projectRoot,path)||inside(config.stateDir,path)||inside(path,projectRoot)||inside(path,config.stateDir))throw new Error('Execution directories must be separate from the operator release and controller state.');
    const info=lstatSync(path);
    if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==resolve(path)||(info.uid!==0&&info.uid!==config.controllerUid)||writableBy(info,uid,gid))throw new Error(`Execution parent must be a canonical controller/root-owned directory that the agent cannot replace: ${path}`);
    let parent=dirname(path);
    protectedPaths.add(path);
    while(parent!=='/'){
      const parentInfo=statSync(parent);
      if(parentInfo.uid===uid||writableBy(parentInfo,uid,gid))throw new Error(`Execution parent can be replaced by the agent: ${parent}`);
      protectedPaths.add(parent);
      parent=dirname(parent);
    }
  }
  if(inside(config.projectsDir,config.executionHome)||inside(config.executionHome,config.projectsDir))throw new Error('APP_PROJECTS_DIR and APP_EXECUTION_HOME must be separate directories.');
  for(const path of verifyProtectedTree(projectRoot,uid,gid))protectedPaths.add(path);
  for(const executable of [process.execPath,config.codexBin,setpriv]){
    accessSync(executable,constants.X_OK);
    const actual=realpathSync(executable),info=statSync(actual);
    if(info.uid===uid||writableBy(info,uid,gid))throw new Error(`Execution binary is writable by the execution account: ${actual}`);
    let path=actual;while(true){const ancestor=statSync(path);if(ancestor.uid===uid||writableBy(ancestor,uid,gid))throw new Error(`Execution binary or its parent can be replaced by the agent: ${path}`);protectedPaths.add(path);const parent=dirname(path);if(parent===path)break;path=parent;}
  }
  verifyEffectiveAccess(config,[...protectedPaths]);
  verifyPrivateAccess(config,[join(projectRoot,'.env'),config.stateDir,join(config.stateDir,'secrets/ipc-token')].filter(existsSync));
  const probe=spawnSync(setpriv,executionArguments(config,'/usr/bin/id',['-u'],false),{encoding:'utf8',timeout:5000,env:{PATH:'/usr/bin:/bin'}});
  if(probe.error||probe.status!==0||probe.stdout.trim()!==String(uid))throw new Error('Cannot enforce the dedicated execution identity with setpriv, cleared groups/capabilities and no-new-privileges.');
}

function executionArguments(config:Config,command:string,args:string[],inheritLibraryPath=true):string[] {
  const {uid,gid}=identity(config);
  // Loader overrides apply only after setpriv has dropped privilege.
  const executable=inheritLibraryPath&&process.env.LD_LIBRARY_PATH?['/usr/bin/env',`LD_LIBRARY_PATH=${process.env.LD_LIBRARY_PATH}`,command,...args]:[command,...args];
  return [`--reuid=${uid}`,`--regid=${gid}`,'--clear-groups','--no-new-privs','--bounding-set=-all','--inh-caps=-all','--ambient-caps=-all','--',...executable];
}

export function executionCommand(config:Config,command:string,args:string[],inheritLibraryPath=true):{command:string;args:string[]} {
  return config.protectOperator===true?{command:setpriv,args:executionArguments(config,command,args,inheritLibraryPath)}:{command,args};
}

/** Minimal child environment: never give model processes controller credentials. */
export function executionEnvironment(config:Config):NodeJS.ProcessEnv {
  if(config.protectOperator!==true)return {...process.env};
  const home=join(config.executionHome!,'user'),runtime=`/run/user/${config.executionUid}`;
  return {PATH:[dirname(process.execPath),join(projectRoot,'node_modules/.bin'),'/usr/local/bin','/usr/bin','/bin'].join(':'),HOME:home,XDG_CONFIG_HOME:join(home,'.config'),XDG_RUNTIME_DIR:runtime,...(existsSync(join(runtime,'bus'))?{DBUS_SESSION_BUS_ADDRESS:`unix:path=${runtime}/bus`}:{}),LANG:'C.UTF-8',LC_ALL:'C.UTF-8',TERM:'dumb'};
}

export function trustedExecutionDirectory(config:Config,name:string):string {
  const {uid,gid}=identity(config);
  if(!config.executionHome||!/^[a-z][a-z-]*$/.test(name))throw new Error('Invalid broker-owned execution directory.');
  const path=join(config.executionHome,name);
  if(!existsSync(path)){mkdirSync(path,{mode:0o711});chmodSync(path,0o711);}
  const info=lstatSync(path);
  if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(path)!==path||(info.uid!==0&&info.uid!==config.controllerUid)||writableBy(info,uid,gid))throw new Error('Broker control directories must remain owned by the controller or root.');
  verifyEffectiveAccess(config,[path]);
  return path;
}

/** Only stable, non-agent-writable parents are changed by the privileged broker. */
export function prepareExecutionDirectory(config:Config,directory:string):void {
  if(config.protectOperator!==true){mkdirSync(directory,{recursive:true,mode:0o700});return;}
  const {uid,gid}=identity(config),root=resolve(config.projectsDir!);
  if(!inside(root,directory)||resolve(directory)===root)throw new Error('Execution workspace must be inside APP_PROJECTS_DIR.');
  const pieces=relative(root,resolve(directory)).split(sep);let current=root;
  for(let index=0;index<pieces.length;index++){
    const parentInfo=statSync(current);
    if(parentInfo.uid===uid||writableBy(parentInfo,uid,gid)||executionCanWrite(config,current)){
      const invocation=executionCommand(config,'/usr/bin/mkdir',['-p','-m','700','--',resolve(directory)]);
      const result=spawnSync(invocation.command,invocation.args,{encoding:'utf8',timeout:5000,env:executionEnvironment(config)});
      if(result.error||result.status!==0)throw new Error('Unable to prepare the project workspace as the execution account.');
      if(realpathSync(directory)!==resolve(directory))throw new Error('Execution workspace must be canonical without symlinks.');
      if(!executionCanWrite(config,directory))throw new Error('Project workspace is not writable by the execution account.');
      return;
    }
    if(parentInfo.uid!==0&&parentInfo.uid!==config.controllerUid)throw new Error('Workspace parent belongs to an unrelated account.');
    current=join(current,pieces[index]!);
    if(!existsSync(current)){
      mkdirSync(current,{mode:index===pieces.length-1?0o700:0o755});
      if(index===pieces.length-1)chownSync(current,uid,gid);else chmodSync(current,0o755);
    }
    const info=lstatSync(current);
    if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(current)!==current)throw new Error('Execution workspace must be canonical without symlinks.');
    if(index===pieces.length-1&&info.uid!==uid){
      // Its parent is still trusted, so the entry cannot be swapped by the agent.
      if(info.uid!==0&&info.uid!==config.controllerUid)throw new Error('Execution workspace belongs to an unrelated account.');
      if(readdirSync(current).length)throw new Error('Initialize a fresh execution workspace; existing controller-owned files are not reassigned automatically.');
      chownSync(current,uid,gid);
    }
  }
  if(!executionCanWrite(config,directory))throw new Error('Project workspace is not writable by the execution account.');
}

export function prepareExecutionProfile(config:Config):void {
  if(config.protectOperator!==true){mkdirSync(config.runtimeHome,{recursive:true,mode:0o700});return;}
  const {uid,gid}=identity(config);
  if(!config.executionHome||resolve(config.runtimeHome)!==join(resolve(config.executionHome),'codex'))throw new Error('Protected Codex profile must be APP_EXECUTION_HOME/codex.');
  for(const path of [config.runtimeHome,join(config.executionHome,'user')]){
    if(!existsSync(path)){mkdirSync(path,{mode:0o700});chownSync(path,uid,gid);}
    const info=lstatSync(path);
    if(!info.isDirectory()||info.isSymbolicLink()||info.uid!==uid||(info.mode&0o077)!==0||realpathSync(path)!==path)throw new Error('Codex profile and user home must be private canonical execution-account-owned directories.');
  }
}
