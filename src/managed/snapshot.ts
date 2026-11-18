import { createHash, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { closeSync, constants, copyFileSync, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { z } from 'zod';
import type { Config } from '../config.ts';

const metadataName='.operator-snapshot.json';
const maxFiles=100_000,maxBytes=2*1024*1024*1024,maxBlobBytes=256*1024*1024;
const hash=z.string().regex(/^[0-9a-f]{64}$/),commit=z.string().regex(/^[0-9a-f]{40,64}$/);
export const gitSnapshotSchema=z.object({directory:z.string().startsWith('/').max(4000),digest:hash}).strict();
export type GitSnapshot=z.infer<typeof gitSnapshotSchema>;
const entrySchema=z.object({path:z.string().min(1).max(4000),digest:hash,size:z.number().int().nonnegative().max(maxBlobBytes),executable:z.boolean()}).strict();
const metadataSchema=z.object({schemaVersion:z.literal(1),commit,path:z.string().max(4000),files:z.array(entrySchema).min(1).max(maxFiles)}).strict();
export type SnapshotMetadata=z.infer<typeof metadataSchema>;
export type OpenSnapshot={directory:string;metadata:SnapshotMetadata};

/** Package paths are portable Git paths; a root package uses a single dot. */
export function packageSnapshotPath(value:string):string {
  if(value==='.')return value;
  if(!value||value.length>4000||value.startsWith('/')||value.includes('\\')||/[\x00-\x1f\x7f]/.test(value)||value.split('/').some(piece=>!piece||piece==='.'||piece==='..'||piece.toLowerCase()==='.git'))throw new Error('Package paths must be safe repository-relative directories.');
  return value;
}
function sourceFilePath(value:string):string {
  packageSnapshotPath(value);
  if(value==='.'||[metadataName,'.operator-release.json'].includes(value))throw new Error('A committed package contains a reserved snapshot filename.');
  return value;
}
function canonicalDirectory(path:string):void {
  if(realpathSync(path)!==path||!lstatSync(path).isDirectory())throw new Error('Git snapshot directories must be canonical without symlinks.');
}
function artifactRoot(config:Config):string {return resolve(config.projectsDir??join(config.stateDir,'projects'),'artifacts');}
function metadataDigest(metadata:SnapshotMetadata):string {return createHash('sha256').update(JSON.stringify(metadata)).digest('hex');}
function readRegular(path:string,expectedSize?:number,onData?:(buffer:Buffer)=>void):{digest:string;size:number} {
  if(realpathSync(path)!==path)throw new Error('Snapshot files must remain canonical without symlinks.');
  const descriptor=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{
    const stat=fstatSync(descriptor);
    if(!stat.isFile()||stat.nlink!==1||stat.size>maxBlobBytes||(expectedSize!==undefined&&stat.size!==expectedSize)||readlinkSync(`/proc/self/fd/${descriptor}`)!==path)throw new Error('Snapshot source differs from its committed snapshot or expected size.');
    const digest=createHash('sha256'),buffer=Buffer.alloc(64*1024);let bytes=0,count;
    while((count=readSync(descriptor,buffer,0,buffer.length,null))>0){bytes+=count;if(bytes>stat.size)throw new Error('Snapshot source changed during inspection.');const chunk=buffer.subarray(0,count);digest.update(chunk);onData?.(chunk);}
    if(bytes!==stat.size)throw new Error('Snapshot source changed during inspection.');
    return {digest:digest.digest('hex'),size:bytes};
  }finally{closeSync(descriptor);}
}
function assertEntry(directory:string,entry:SnapshotMetadata['files'][number]):void {
  const path=join(directory,sourceFilePath(entry.path)),value=readRegular(path,entry.size);
  if(value.digest!==entry.digest||Boolean(lstatSync(path).mode&0o111)!==entry.executable)throw new Error('Snapshot source differs from its committed snapshot.');
}

/** Read and verify a shared, content-addressed Git artifact before a worker copies it. */
export function openGitSnapshot(config:Config,raw:GitSnapshot,expected:{commit:string;path:string}):OpenSnapshot {
  const pointer=gitSnapshotSchema.parse(raw),root=artifactRoot(config);
  if(pointer.directory!==join(root,pointer.digest))throw new Error('Git snapshot must be inside the configured artifact directory.');
  canonicalDirectory(root);canonicalDirectory(pointer.directory);
  const metadataPath=join(pointer.directory,metadataName),metadataFile=readRegular(metadataPath);
  if(metadataFile.size>32*1024*1024)throw new Error('Git snapshot metadata is too large.');
  const metadata=metadataSchema.parse(JSON.parse(readFileSync(metadataPath,'utf8')));
  if(metadataDigest(metadata)!==pointer.digest||metadata.commit!==expected.commit||metadata.path!==packageSnapshotPath(expected.path))throw new Error('Git snapshot identity or digest does not match the requested committed source.');
  const names=new Set<string>();let total=0;
  for(const entry of metadata.files){sourceFilePath(entry.path);if(names.has(entry.path))throw new Error('Git snapshot contains duplicate source paths.');names.add(entry.path);total+=entry.size;if(total>maxBytes)throw new Error('Git snapshot exceeds the 2 GiB source limit.');assertEntry(pointer.directory,entry);}
  // Extra files would make this artifact mutable or ambiguous, even though they are not copied.
  const visit=(directory:string,prefix='')=>{for(const name of readdirSync(directory)){if(!prefix&&name===metadataName)continue;const path=join(directory,name),relative=prefix?`${prefix}/${name}`:name,stat=lstatSync(path);if(stat.isDirectory()&&!stat.isSymbolicLink()){canonicalDirectory(path);visit(path,relative);}else if(!names.has(relative))throw new Error('Git snapshot contains unrecorded files.');}};
  visit(pointer.directory);return {directory:pointer.directory,metadata};
}

/** Copy bytes and executable bits, never Git metadata or links, into a fresh release. */
export function copyGitSnapshot(snapshot:OpenSnapshot,destination:string):void {
  canonicalDirectory(destination);
  for(const entry of snapshot.metadata.files){
    const source=join(snapshot.directory,entry.path),target=join(destination,entry.path);assertEntry(snapshot.directory,entry);
    mkdirSync(dirname(target),{recursive:true,mode:0o700});
    copyFileSync(source,target,constants.COPYFILE_EXCL);chmodSync(target,entry.executable?0o700:0o600);assertEntry(destination,entry);
  }
}
export function verifySnapshotRelease(snapshot:OpenSnapshot,directory:string):void {canonicalDirectory(directory);for(const entry of snapshot.metadata.files)assertEntry(directory,entry);}
export function snapshotText(snapshot:OpenSnapshot,path:string):string {const entry=snapshot.metadata.files.find(file=>file.path===path);if(!entry||entry.size>1_000_000)throw new Error('Committed source must include a bounded package manifest.');assertEntry(snapshot.directory,entry);return readFileSync(join(snapshot.directory,path),'utf8');}

/** Export Git objects directly, preserving binary files and ignoring mutable checkout data. */
export function createGitSnapshot(config:Config,repositoryPath:string,revision:string,packagePath:string):GitSnapshot {
  commit.parse(revision);packageSnapshotPath(packagePath);repositoryPath=resolve(repositoryPath);canonicalDirectory(repositoryPath);
  const env:NodeJS.ProcessEnv={...process.env};for(const key of Object.keys(env))if(key.startsWith('GIT_'))delete env[key];
  Object.assign(env,{GIT_TERMINAL_PROMPT:'0',GIT_LITERAL_PATHSPECS:'1',GIT_CONFIG_NOSYSTEM:'1',GIT_CONFIG_GLOBAL:'/dev/null',GIT_NO_REPLACE_OBJECTS:'1'});
  const git=(args:string[],maxBuffer=32*1024*1024)=>execFileSync('git',['-c','core.hooksPath=/dev/null','-c','core.fsmonitor=false','-C',repositoryPath,...args],{env,timeout:30_000,maxBuffer,stdio:['ignore','pipe','pipe']});
  const resolved=git(['rev-parse','--verify',`${revision}^{commit}`]).toString().trim();if(resolved!==revision)throw new Error('Git snapshot requires an exact committed revision.');
  const tree=git(['ls-tree','-r','-z','--full-tree',revision,...(packagePath==='.'?[]:['--',packagePath])]);
  if(!Buffer.from(tree.toString('utf8'),'utf8').equals(tree))throw new Error('Git snapshot filenames must use UTF-8.');
  const records=tree.toString('utf8').split('\0').filter(Boolean);
  if(!records.length||records.length>maxFiles)throw new Error('Git snapshot must contain between 1 and 100,000 committed files.');
  const root=artifactRoot(config);mkdirSync(root,{recursive:true,mode:0o700});canonicalDirectory(root);
  const staging=join(root,`.snapshot-${randomUUID()}`);mkdirSync(staging,{mode:0o700});
  try{
    const files:SnapshotMetadata['files']=[];let total=0;
    for(const record of records){
      const match=/^(100644|100755) blob ([0-9a-f]{40,64})\t([\s\S]+)$/.exec(record);if(!match)throw new Error('Git snapshots support regular files; symbolic links and submodules must be removed or vendored.');
      const path=sourceFilePath(packagePath==='.'?match[3]!:match[3]!.slice(packagePath.length+1));
      const data=git(['cat-file','blob',match[2]!],maxBlobBytes);
      const object=createHash(match[2]!.length===64?'sha256':'sha1').update(`blob ${data.length}\0`).update(data).digest('hex');if(object!==match[2])throw new Error('Git source bytes do not match their committed object.');
      total+=data.length;if(total>maxBytes)throw new Error('Git snapshot exceeds the 2 GiB source limit.');
      const target=join(staging,path);mkdirSync(dirname(target),{recursive:true,mode:0o700});const executable=match[1]==='100755';writeFileSync(target,data,{flag:'wx',mode:executable?0o700:0o600});files.push({path,digest:createHash('sha256').update(data).digest('hex'),size:data.length,executable});
    }
    files.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0);
    const metadata:SnapshotMetadata={schemaVersion:1,commit:revision,path:packagePath,files},digest=metadataDigest(metadata),directory=join(root,digest),pointer={directory,digest};
    writeFileSync(join(staging,metadataName),JSON.stringify(metadata),{flag:'wx',mode:0o600});
    if(existsSync(directory))openGitSnapshot(config,pointer,{commit:revision,path:packagePath});else renameSync(staging,directory);
    return pointer;
  }finally{rmSync(staging,{recursive:true,force:true});}
}
