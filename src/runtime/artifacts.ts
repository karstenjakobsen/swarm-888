import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chownSync, lstatSync, realpathSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';
import { executionCommand, executionEnvironment, inside } from './execution.ts';

export const publishArtifactInput=z.object({path:z.string().min(1).max(2000),filename:z.string().max(120).regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]*$/).optional()}).strict();
const limit=32*1024*1024;
const readArtifact=`
  const fs=require('node:fs'),path=require('node:path');
  const [root,file,limit]=process.argv.slice(1);
  const inside=(file)=>{const rel=path.relative(root,file);return rel&&!path.isAbsolute(rel)&&rel!=='..'&&!rel.startsWith('..'+path.sep);};
  if(!inside(file)||fs.realpathSync(file)!==file)throw new Error('Artifact must be a canonical project file');
  const descriptor=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);
  try{
    const info=fs.fstatSync(descriptor),actual=fs.readlinkSync('/proc/self/fd/'+descriptor);
    if(!inside(actual)||actual!==file||!info.isFile()||info.size>Number(limit))throw new Error('Artifact must be a regular project file no larger than 32 MiB');
    const chunk=Buffer.alloc(65536);let total=0,size;
    while((size=fs.readSync(descriptor,chunk,0,chunk.length,null))>0){total+=size;if(total>Number(limit))throw new Error('Artifact exceeds 32 MiB');process.stdout.write(chunk.subarray(0,size));}
  }finally{fs.closeSync(descriptor);}
`;

/** Publish bounded canonical project outputs through the authenticated artifact route. */
export async function publishArtifact(config:Config,raw:unknown):Promise<{path:string;url:string}> {
  const input=publishArtifactInput.parse(raw),source=resolve(input.path),root=resolve(config.projectsDir??join(config.stateDir,'projects'));
  if(!inside(root,source)||source===root)throw new Error('Artifacts must be published from APP_PROJECTS_DIR.');
  const filename=input.filename??basename(source);
  if(!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/.test(filename))throw new Error('Choose a safe artifact filename.');
  const destination=join(config.stateDir,'artifacts'),info=lstatSync(destination);
  if(!info.isDirectory()||info.isSymbolicLink()||realpathSync(destination)!==destination)throw new Error('Artifact destination must be a canonical controller directory.');
  const invocation=executionCommand(config,process.execPath,['-e',readArtifact,root,source,String(limit)]);
  const content=await new Promise<Buffer>((ok,no)=>execFile(invocation.command,invocation.args,{env:executionEnvironment(config),timeout:10_000,maxBuffer:limit+64*1024,encoding:'buffer'},(error,stdout)=>error?no(new Error('Artifact could not be read as a regular project file (maximum 32 MiB).')):ok(stdout)));
  const path=`${randomUUID()}-${filename}`,target=join(destination,path);
  writeFileSync(target,content,{flag:'wx',mode:0o600});
  if(process.getuid?.()===0)chownSync(target,config.controllerUid,-1);
  return {path,url:`/api/artifacts/${encodeURIComponent(path)}`};
}
