import { z } from 'zod';
import { connectorTransportSchema } from '../connectors/schemas.ts';
import { packageCommandSchema, packageKind } from '../packages/schemas.ts';

export const managedKind = packageKind;
export type ManagedKind = z.infer<typeof managedKind>;

export const managedManifestSchema = z.object({
  schemaVersion:z.literal(1),id:z.string().uuid().toLowerCase(),kind:managedKind,
  name:z.string().trim().min(1).max(120),description:z.string().max(4000).default(''),version:z.string().max(100).optional(),
  check:packageCommandSchema.optional(),build:packageCommandSchema.optional(),run:packageCommandSchema.optional(),
  mcp:connectorTransportSchema.optional(),
}).strict();
export type ManagedManifest = z.infer<typeof managedManifestSchema>;
export const managedSourceSchema = z.object({
  repositoryPath:z.string(),branch:z.string(),path:z.string(),workspacePath:z.string(),
  commit:z.string().regex(/^[0-9a-f]{40,64}$/).nullable(),dirty:z.boolean(),
  repositoryId:z.string().uuid().optional(),packageId:z.string().uuid().optional(),
  workspaceDiverged:z.boolean().optional(),
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
export const sourceCreateInput=z.object({kind:managedKind.default('project'),template:z.enum(['service','connector','empty']).default('empty'),repositoryId:z.string().uuid().optional(),packagePath:z.string().min(1).max(1000).optional()}).strict();
export const sourceWriteInput=z.object({
  files:textFiles(z.string().max(1_000_000)),
  removedFiles:z.array(z.string()).max(100).optional(),
  createOnly:z.array(z.string().min(1).max(240)).max(500).optional(),
  message:z.string().trim().min(1).max(300).optional(),
  expectedCommit:z.string().regex(/^[0-9a-f]{40,64}$/).nullable().optional(),
}).strict();
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
