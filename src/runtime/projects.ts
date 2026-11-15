import { execFile } from 'node:child_process';
import { lstatSync, readFileSync, readlinkSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import type { Config } from '../config.ts';
import type { ComponentObservation, ComponentReference, ProjectReference } from '../projects/schemas.ts';
import { executionCommand, executionEnvironment, inside } from './protection.ts';

const unitPattern=/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.(service|timer)$/;
type CommandResult={stdout:string;truncated:boolean};
export type ProjectCommand=(command:string,args:string[])=>Promise<CommandResult>;
export const projectCommand=(config:Config):ProjectCommand=>(command,args)=>new Promise((ok,no)=>{
  const userManager=command==='/usr/bin/systemctl'||command==='/usr/bin/journalctl';
  const invocation=userManager?executionCommand(config,command,['--user',...args],false):{command,args};
  execFile(invocation.command,invocation.args,{encoding:'utf8',timeout:5000,maxBuffer:200_000,env:userManager?{...executionEnvironment(config),LC_ALL:'C',LANG:'C'}:{PATH:'/usr/bin:/bin',LC_ALL:'C',LANG:'C'}},(error,stdout)=>{
    if(error){no(new Error(command.endsWith('journalctl')?'Project logs are unavailable from the service manager.':'Project service state is unavailable from the service manager.'));return;}
    ok({stdout,truncated:false});
  });
});

function executionAccount(config:Config):string {
  const uid=config.executionUid??process.getuid?.();
  const account=readFileSync('/etc/passwd','utf8').split('\n').map(line=>line.split(':')).find(fields=>Number(fields[2])===uid)?.[0];
  if(!account)throw new Error('The project execution account cannot be resolved.');return account;
}

function hostTimezone():string|null {
  const candidates:string[]=[];
  try{candidates.push(readFileSync('/etc/timezone','utf8').trim());}catch{}
  try{const zone=readlinkSync('/etc/localtime').split('/zoneinfo/')[1];if(zone)candidates.push(zone);}catch{}
  for(const zone of candidates)try{return new Intl.DateTimeFormat('en',{timeZone:zone}).resolvedOptions().timeZone;}catch{}
  return null;
}

async function cron(config:Config,project:ProjectReference,component:ComponentReference,command:ProjectCommand,checkedAt:string):Promise<ComponentObservation> {
  if(!component.scriptPath||!component.schedule)throw new Error('Cron jobs require a registered script and five-field schedule.');
  const path=resolve(project.directory,component.scriptPath);
  if(!inside(project.directory,path)||realpathSync(path)!==path||!lstatSync(path).isFile())throw new Error('The registered cron script is missing or is not canonical.');
  const content=(await command('/usr/bin/crontab',['-u',executionAccount(config),'-l'])).stdout;
  if(/^\s*CRON_TZ\s*=/m.test(content))throw new Error('This crontab uses CRON_TZ; schedule timezone semantics could not be independently verified.');
  const requested=component.schedule.trim().split(/\s+/).join(' ');
  const spellings=[path,JSON.stringify(path),`'${path.replaceAll("'","'\\''")}'`];
  const supported=new Set(spellings.flatMap(script=>[script,...['/usr/bin/node',process.execPath,'/usr/bin/python3','/bin/bash','/bin/sh'].map(interpreter=>`${interpreter} ${script}`)]));
  const matched=content.split('\n').some(line=>{
    const value=line.trim();if(!value||value.startsWith('#'))return false;
    const fields=value.split(/\s+/);return fields.slice(0,5).join(' ')===requested&&supported.has(fields.slice(5).join(' '));
  });
  if(!matched)return {status:'unknown',detail:'No exact supported crontab entry matches this schedule and project script. Complex shell commands are not inferred.',checkedAt,lastRunAt:null,nextRunAt:null,lastExitCode:null};
  const systemTimezone=hostTimezone();
  const requestedTimezone=component.timezone?new Intl.DateTimeFormat('en',{timeZone:component.timezone}).resolvedOptions().timeZone:null;
  if(requestedTimezone&&requestedTimezone!==systemTimezone)return {status:'unknown',detail:`Crontab entry matches, but its registered timezone could not be verified against the host timezone (${systemTimezone??'unavailable'}).`,checkedAt,lastRunAt:null,nextRunAt:null,lastExitCode:null};
  try{await command('/usr/bin/pgrep',['-x','-u','0','cron|crond']);}
  catch{return {status:'unknown',detail:'Crontab entry matches, but a running cron daemon could not be verified.',checkedAt,lastRunAt:null,nextRunAt:null,lastExitCode:null};}
  return {status:'scheduled',detail:'Exact project crontab entry and running cron daemon verified. Cron execution history and next-run time are unavailable.',checkedAt,lastRunAt:null,nextRunAt:null,lastExitCode:null};
}

export function validateProjectReference(config:Config,project:ProjectReference):void {
  const root=resolve(config.projectsDir??resolve(config.stateDir,'projects')),directory=resolve(project.directory);
  if(directory===root||!inside(root,directory))throw new Error('Project directory must be inside APP_PROJECTS_DIR.');
  let parent=directory;
  while(true){
    try{if(realpathSync(parent)!==parent)throw new Error('Project directories must be canonical without symlinks.');break;}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;const next=resolve(parent,'..');if(next===parent)throw error;parent=next;}
  }
}

function properties(text:string):Record<string,string> {
  return Object.fromEntries(text.split('\n').filter(line=>line.includes('=')).map(line=>{const end=line.indexOf('=');return [line.slice(0,end),line.slice(end+1)];}));
}
function timestamp(value:string|undefined):string|null {
  if(!value||value==='n/a'||value==='0')return null;
  const time=Date.parse(value);return Number.isNaN(time)?null:new Date(time).toISOString();
}
async function service(unit:string,command:ProjectCommand):Promise<Record<string,string>> {
  if(!unitPattern.test(unit))throw new Error('Invalid registered service unit.');
  const result=await command('/usr/bin/systemctl',['show','--no-pager','--property=LoadState,ActiveState,SubState,Result,ExecMainStatus,ExecMainExitTimestamp,LastTriggerUSec,NextElapseUSecRealtime,Unit,WorkingDirectory,User','--',unit]);
  const state=properties(result.stdout);
  if(state.LoadState==='not-found'||!state.ActiveState)throw new Error('The registered service unit is missing.');
  return state;
}

function verifyServiceOwner(config:Config,project:ProjectReference,state:Record<string,string>):void {
  const directory=state.WorkingDirectory;
  if(!directory||!inside(project.directory,directory)||realpathSync(directory)!==resolve(directory))throw new Error('Registered service does not have a verified working directory inside this project.');
  if(config.protectOperator===true){
    const user=state.User??'';
    if(!user)return; // The command ran in the dedicated user's own service manager.
    const uid=/^\d+$/.test(user)?Number(user):Number(readFileSync('/etc/passwd','utf8').split('\n').map(line=>line.split(':')).find(fields=>fields[0]===user)?.[2]);
    if(uid!==config.executionUid)throw new Error('Registered service must run as the dedicated project execution account.');
  }
}

export async function inspectProject(config:Config,project:ProjectReference,components:ComponentReference[],command:ProjectCommand=projectCommand(config)):Promise<{observations:Array<ComponentObservation&{componentId:string}>}> {
  validateProjectReference(config,project);
  const observations:Array<ComponentObservation&{componentId:string}>=[];
  const deadline=Date.now()+15_000;
  for(const component of components){
    const checkedAt=new Date().toISOString();
    let observation:ComponentObservation={status:'unknown',detail:'No verified runtime state is available.',checkedAt};
    if(Date.now()>=deadline){observations.push({componentId:component.id,...observation,detail:'Refresh budget reached; refresh again to check remaining components.'});continue;}
    try{
      if(component.kind==='script'){
        if(!component.scriptPath)throw new Error('No script path is registered.');
        const path=resolve(project.directory,component.scriptPath);
        if(!inside(project.directory,path)||realpathSync(path)!==path||!lstatSync(path).isFile())throw new Error('The registered script is missing or is not a canonical regular file.');
        observation={status:'ready',detail:'Script exists. It has not been executed by this check.',checkedAt};
      }else if(component.kind==='scheduled_job'){
        if(!component.unitName){observation=await cron(config,project,component,command,checkedAt);observations.push({componentId:component.id,...observation});continue;}
        if(!component.unitName.endsWith('.timer'))throw new Error('No systemd timer is registered.');
        const state=await service(component.unitName,command);
        let lastExitCode:number|null=null,lastRunAt=timestamp(state.LastTriggerUSec),result:string|undefined;
        const target=state.Unit??component.unitName.replace(/\.timer$/,'.service');
        if(unitPattern.test(target)){
          const last=await service(target,command);verifyServiceOwner(config,project,last);result=last.Result;const completedAt=timestamp(last.ExecMainExitTimestamp);lastExitCode=completedAt&&last.ExecMainStatus&&/^\d+$/.test(last.ExecMainStatus)?Number(last.ExecMainStatus):null;lastRunAt=completedAt??lastRunAt;
        }else throw new Error('The timer target service cannot be verified.');
        const enabled=state.ActiveState==='active';
        observation={status:state.ActiveState==='failed'?'failed':enabled?'scheduled':'stopped',serviceState:`${state.ActiveState}/${state.SubState??'unknown'}`,lastRunAt,nextRunAt:timestamp(state.NextElapseUSecRealtime),lastExitCode,checkedAt,detail:enabled?`Timer is scheduled.${result&&result!=='success'?` Last execution result: ${result}.`:''}`:'The registered timer is not active.'};
      }else{
        let state:Record<string,string>|undefined;
        if(component.unitName){state=await service(component.unitName,command);verifyServiceOwner(config,project,state);}
        const running=state?.ActiveState==='active';
        observation={status:state?.ActiveState==='failed'?'failed':running?'running':state?'stopped':'unknown',checkedAt,detail:state?`Service is ${state.ActiveState}.`:'No service unit is registered.',...(state?{serviceState:`${state.ActiveState}/${state.SubState??'unknown'}`}:{})};
        if(component.kind==='website'){
          if(!component.url)throw new Error('No website URL is registered.');
          const url=new URL(component.url);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('Invalid website URL.');
          try{
            const response=await fetch(url,{method:'GET',redirect:'manual',signal:AbortSignal.timeout(5000),headers:{'user-agent':'VPS-AI-Operator-health/1'}});
            await response.body?.cancel();const healthy=response.status>=200&&response.status<400;
            observation={...observation,status:healthy&&(!state||running)?'healthy':'failed',healthStatus:healthy?'healthy':'unhealthy',detail:`Website returned HTTP ${response.status}.${state?` Service is ${state.ActiveState}.`:''}`};
          }catch{observation={...observation,status:'failed',healthStatus:'unhealthy',detail:`Website did not respond successfully.${state?` Service is ${state.ActiveState}.`:''}`};}
        }
      }
    }catch(error){observation={status:'unknown',detail:(error as Error).message,checkedAt};}
    observations.push({componentId:component.id,...observation});
  }
  return {observations};
}

export async function projectLogs(config:Config,project:ProjectReference,component:ComponentReference,command:ProjectCommand=projectCommand(config)):Promise<{text:string;truncated:boolean;checkedAt:string}> {
  validateProjectReference(config,project);
  if(!component.unitName||!unitPattern.test(component.unitName))return {text:'No service logs are available for this component. Script output is available in its linked operator task history.',truncated:false,checkedAt:new Date().toISOString()};
  const state=await service(component.unitName,command);
  let logUnit=component.unitName;
  if(component.unitName.endsWith('.timer')){
    const target=state.Unit??component.unitName.replace(/\.timer$/,'.service');
    verifyServiceOwner(config,project,await service(target,command));logUnit=target;
  }else verifyServiceOwner(config,project,state);
  const result=await command('/usr/bin/journalctl',['--no-pager','--output=short-iso','--lines=200',`--unit=${logUnit}`]);
  return {text:result.stdout.slice(-180_000),truncated:result.truncated||result.stdout.length>180_000,checkedAt:new Date().toISOString()};
}
