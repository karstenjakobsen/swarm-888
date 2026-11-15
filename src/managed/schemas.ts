import { z } from 'zod';
import { connectorTransportSchema } from '../connectors/schemas.ts';

export const managedKind = z.enum(['project', 'connector', 'skill']);
export type ManagedKind = z.infer<typeof managedKind>;
const command = z.object({command:z.string().min(1).max(2000).refine(value=>!value.includes('\0'),'Commands cannot contain NUL'),args:z.array(z.string().max(16_000).refine(value=>!value.includes('\0'),'Arguments cannot contain NUL')).max(100).default([])}).strict();

export const managedManifestSchema = z.object({
  schemaVersion:z.literal(1),id:z.string().uuid().toLowerCase(),kind:managedKind,
  name:z.string().trim().min(1).max(120),description:z.string().max(4000).default(''),
  check:command.optional(),build:command.optional(),run:command.optional(),
  mcp:connectorTransportSchema.optional(),
}).strict();
export type ManagedManifest = z.infer<typeof managedManifestSchema>;
export const managedSourceSchema = z.object({
  repositoryPath:z.string(),branch:z.string(),path:z.string(),workspacePath:z.string(),
  commit:z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),dirty:z.boolean(),
}).strict();
export type ManagedSource = z.infer<typeof managedSourceSchema>;
export interface ManagedExport {source:ManagedSource;manifest:ManagedManifest;files:Record<string,string>}
const commitSha=z.string().regex(/^[0-9a-f]{40,64}$/);
const absoluteDirectory=z.string().startsWith('/').max(4000).refine(value=>!value.includes('\0'));
export const managedServiceStatus=z.enum(['running','stopped','failed','unknown']);
export const managedStatusResult=z.object({unitName:z.string().min(1).max(200),status:managedServiceStatus,detail:z.string().max(4000),checkedAt:z.string().datetime(),releaseDirectory:absoluteDirectory.optional(),commit:commitSha.optional()}).strict();
export const managedPreparedResult=z.object({releaseDirectory:absoluteDirectory,commit:commitSha,checkedAt:z.string().datetime()}).strict();
export const managedDeploymentResult=managedStatusResult.extend({releaseDirectory:absoluteDirectory,commit:commitSha});
export const managedLogsResult=z.object({text:z.string().max(200_000),truncated:z.boolean(),checkedAt:z.string().datetime()}).strict();
// Zod records otherwise silently discard this special own property before validation.
const textFiles=(value:z.ZodString)=>z.preprocess((input,context)=>{if(input&&typeof input==='object'&&Object.hasOwn(input,'__proto__'))context.addIssue({code:'custom',message:'Reserved source filename'});return input;},z.record(z.string(),value));
export const managedFilesSchema = textFiles(z.string()).refine(files=>Object.keys(files).length<=500,'At most 500 source files').refine(files=>Object.entries(files).reduce((size,[name,body])=>size+Buffer.byteLength(name)+Buffer.byteLength(body),0)<=8_000_000,'Managed source must not exceed 8 MB').refine(files=>Buffer.byteLength(JSON.stringify(files))<=8_000_000,'Serialized managed source must not exceed 8 MB');
export const sourceCreateInput=z.object({kind:z.enum(['project','connector','skill']).default('project'),template:z.enum(['service','connector','empty']).default('empty')}).strict();
export const sourceWriteInput=z.object({files:textFiles(z.string().max(1_000_000)),removedFiles:z.array(z.string()).max(100).optional(),message:z.string().trim().min(1).max(300).optional(),expectedCommit:z.string().regex(/^[0-9a-f]{40,64}$/).nullable().optional()}).strict();
export const sourceCommitInput=z.object({message:z.string().trim().min(1).max(300).optional()}).strict();
export const managedCreateSchema = z.object({
  id:z.string().uuid().toLowerCase(),kind:managedKind,name:z.string().trim().min(1).max(120),description:z.string().max(4000).default(''),
  template:z.enum(['service','connector','empty']).default('empty'),
}).strict();
export type ManagedCreate = z.input<typeof managedCreateSchema>;

export function managedPath(kind:ManagedKind,id:string):string {
  managedKind.parse(kind);const packageId=z.string().uuid().parse(id).toLowerCase();
  return `generated/${{project:'projects',connector:'connectors',skill:'skills'}[kind]}/${packageId}`;
}
