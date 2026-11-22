import { z } from 'zod';
import { connectorTransportSchema } from '../connectors/schemas.ts';

export const packageKind=z.enum(['project','connector','skill']);
export type PackageKind=z.infer<typeof packageKind>;
export const packageManifestMaxBytes=64_000;
export const packageCommandSchema=z.object({
  command:z.string().min(1).max(2000).refine(value=>!value.includes('\0'),'Commands cannot contain NUL'),
  args:z.array(z.string().max(16_000).refine(value=>!value.includes('\0'),'Arguments cannot contain NUL')).max(100).default([]),
}).strict();
export const packageVersion=z.string().max(100).regex(/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,'Use a semantic package version such as 0.1.0');
export const packageManifestSchema=z.object({
  schemaVersion:z.literal(1),id:z.string().uuid().toLowerCase(),kind:packageKind,
  name:z.string().trim().min(1).max(120),version:packageVersion,description:z.string().max(4000).default(''),
  check:packageCommandSchema.optional(),build:packageCommandSchema.optional(),run:packageCommandSchema.optional(),mcp:connectorTransportSchema.optional(),
}).strict().superRefine((value,context)=>{
  if(Buffer.byteLength(`${JSON.stringify(value,null,2)}\n`)>packageManifestMaxBytes)context.addIssue({code:'custom',message:'Package manifest must be at most 64 KB when serialized as UTF-8'});
  if(value.kind==='connector'&&!value.mcp)context.addIssue({code:'custom',path:['mcp'],message:'Connector packages must declare their MCP transport'});
  if(value.kind!=='connector'&&value.mcp)context.addIssue({code:'custom',path:['mcp'],message:'Only connector packages can declare an MCP transport'});
  if(value.kind==='skill'&&value.run)context.addIssue({code:'custom',path:['run'],message:'Skills use SKILL.md rather than a service run command'});
  if(value.kind==='skill'&&!/^[a-z][a-z0-9-]{0,63}$/.test(value.name))context.addIssue({code:'custom',path:['name'],message:'Skill names must use a lowercase slug of at most 64 characters'});
});
export type PackageManifest=z.infer<typeof packageManifestSchema>;

export function packagePath(value:string):string {
  if(value==='.')return value;
  if(!value||value.length>500||value.startsWith('/')||/[\\\x00-\x1f\x7f]/.test(value)||value.split('/').some(piece=>!piece||piece==='.'||piece==='..'||/^(?:\.git|\.agents|\.ssh|\.codex|\.cache|node_modules|secrets|credentials)$/i.test(piece)))throw Object.assign(new Error('Package path must be a relative repository folder, or . for its root'),{statusCode:400});
  return value;
}
export const packagePathSchema=z.string().transform(packagePath);
export const remoteUrlSchema=z.string().trim().min(1).max(2000).refine(value=>{
  if(/[\x00-\x20\x7f]/.test(value)||value.startsWith('-'))return false;
  if(value.startsWith('/'))return !value.includes('?')&&!value.includes('#');
  if(/^[\w.-]+@[\w.-]+:[\w./~-]+$/.test(value))return true;
  try{const url=new URL(value);return ['https:','http:','ssh:','git:','file:'].includes(url.protocol)&&!url.password&&!url.search&&!url.hash&&(!url.username||url.protocol==='ssh:')&&(url.protocol!=='file:'||(!url.hostname&&!url.username));}catch{return false;}
},'Use a Git remote URL without embedded credentials, query parameters, or fragments');
export const repositoryBranchSchema=z.string().min(1).max(200).regex(/^[\w][\w./-]*$/).refine(value=>!value.includes('..')&&value.split('/').every(piece=>piece&&!piece.startsWith('.')&&!piece.endsWith('.')&&!piece.endsWith('.lock')),'Use a Git branch name such as release/packages');
export const repositoryInput=z.object({name:z.string().trim().min(1).max(120),remoteUrl:remoteUrlSchema,branch:z.literal('main').optional(),mode:z.enum(['create','clone']).default('create')}).strict();
export const repositoryPushSettingsInput=z.object({enabled:z.boolean(),autoPush:z.boolean(),pushUrl:remoteUrlSchema.nullable().optional(),branch:repositoryBranchSchema.optional()}).strict().refine(value=>value.enabled||!value.autoPush,'Enable remote pushing before enabling automatic pushes');
export const packageImportInput=z.object({paths:z.array(packagePathSchema).min(1).max(200),expectedCommit:z.string().regex(/^[0-9a-f]{40,64}$/).optional()}).strict();

export interface RepositoryPushStatus {enabled:boolean;autoPush:boolean;pushUrl:string|null;branch:string|null;state:'disabled'|'idle'|'pending'|'pushing'|'pushed'|'failed';commit:string|null;pushedCommit:string|null;error:string|null;updatedAt:string|null}
export interface RepositoryRecord {id:string;name:string;remoteUrl:string;directory:string;branch:string;sourceBranch:string;syncMode?:'legacy'|'main';status:'ready'|'error';error:string|null;createdAt:string;updatedAt:string;head?:string|null;dirty?:boolean;ahead?:number;behind?:number;hasRemoteBranch?:boolean;localOnly?:boolean;push?:RepositoryPushStatus}
export interface PackageRecord {id:string;repositoryId:string;path:string;kind:PackageKind;name:string;version:string;description:string;manifest:PackageManifest;lastImportedCommit:string;lastImportedAt:string;createdAt:string;updatedAt:string}
export interface PackageImport {id:string;repositoryId:string;packageId:string|null;path:string;schemaVersion:number|null;packageVersion:string|null;commit:string;status:'pending'|'importing'|'imported'|'failed';error:string|null;createdAt:string;startedAt:string|null;finishedAt:string|null}
export interface PackageDiscovery {repository:RepositoryRecord;commit:string;remoteBranch?:string;packages:Array<{path:string;manifest?:PackageManifest;error?:string;imported?:boolean}>;errors:string[]}
