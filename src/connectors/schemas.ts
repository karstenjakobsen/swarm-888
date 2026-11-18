import { z } from 'zod';
import { connectorAuthSchema,type ConnectorAuth } from '../credentials/schemas.ts';

const argument=z.string().max(16_000).refine(value=>!value.includes('\0'),'Arguments cannot contain NUL');
const stdio=z.object({transport:z.literal('stdio'),command:z.string().min(1).max(2000).refine(value=>!value.includes('\0'),'Commands cannot contain NUL'),args:z.array(argument).max(100).default([])}).strict();
const http=z.object({transport:z.literal('http'),url:z.string().max(2000).refine(value=>{
  const url=URL.parse(value);
  return url!==null&&['http:','https:'].includes(url.protocol)&&!url.username&&!url.password&&!url.search&&!url.hash;
},'Use an HTTP(S) URL without credentials, query parameters, or fragments')}).strict();
const cwd=z.string().startsWith('/').max(2000).refine(value=>!value.includes('\0'));
const identity={id:z.string().uuid(),name:z.string().trim().min(1).max(120)};

/** Portable MCP transport configuration shared by manifests, registrations, and snapshots. */
export const connectorTransportSchema=z.discriminatedUnion('transport',[stdio,http]);
export type ConnectorTransport=z.infer<typeof connectorTransportSchema>;
const auth={auth:connectorAuthSchema.optional()};
function scoped(value:{transport:'stdio'|'http';auth?:ConnectorAuth},context:z.RefinementCtx){if(value.auth&&(value.transport==='stdio')!==(value.auth.type==='env'))context.addIssue({code:'custom',message:'Use environment credentials for stdio, or HTTP credentials for HTTP connections'});}
export const connectorSnapshotSchema=z.discriminatedUnion('transport',[stdio.extend({...identity,...auth,cwd:cwd.optional(),credentialRevision:z.number().int().positive().optional()}),http.extend({...identity,...auth,credentialRevision:z.number().int().positive().optional()})]).superRefine(scoped);
export type ConnectorSnapshot=z.infer<typeof connectorSnapshotSchema>;
export type ConnectorTool=z.infer<typeof connectorToolSchema>;
export type ConnectorStatus='untested'|'connected'|'error';
export type Connector=ConnectorSnapshot&{
  description:string;enabled:boolean;projectId:string|null;packageId?:string|null;tools:ConnectorTool[];status:ConnectorStatus;detail:string;
  checkedAt:string|null;createdAt:string;updatedAt:string;source?:import('../managed/schemas.ts').ManagedSource|null;
  readiness?:{ready:boolean;reason?:string;credentialId?:string};
};
const registration={
  name:z.string().trim().min(1).max(120),description:z.string().max(4000).default(''),enabled:z.boolean().default(true),
  projectId:z.string().uuid().nullable().optional(),
};
export const connectorInput=z.discriminatedUnion('transport',[stdio.extend({...registration,cwd:cwd.optional()}),http.extend(registration)]);
export const connectorAdoptInput=z.object({repositoryId:z.string().uuid(),packagePath:z.string().min(1).max(500)}).strict();
const packagedRegistration={name:registration.name,description:registration.description,enabled:registration.enabled,...connectorAdoptInput.shape};
/** Owner registrations and model tools create portable definitions; local paths and auth remain private. */
export const connectorPackageInput=z.discriminatedUnion('transport',[stdio.extend(packagedRegistration),http.extend(packagedRegistration)]);
export const connectorPatchInput=z.object({name:z.string().trim().min(1).max(120).optional(),description:z.string().max(4000).optional(),enabled:z.boolean().optional()}).strict();
export const connectorAssignmentInput=z.object({connectorIds:z.array(z.string().uuid()).max(20)}).strict();
export const connectorCall=z.object({name:z.string().min(1).max(200),arguments:z.record(z.string(),z.unknown()).default({})}).strict();
export const connectorTestInput=z.object({connector:connectorSnapshotSchema}).strict();
export const connectorCallInput=connectorCall.extend({connector:connectorSnapshotSchema});
export const connectorToolSchema=z.object({name:z.string().min(1).max(200),description:z.string().max(20_000).optional(),inputSchema:z.object({type:z.literal('object')}).passthrough()}).passthrough();
export const connectorToolsResult=z.object({tools:z.array(connectorToolSchema).max(500),checkedAt:z.string().datetime()});
export const connectorCallResult=z.object({content:z.array(z.object({type:z.string()}).passthrough()).max(1000),isError:z.boolean().optional(),structuredContent:z.record(z.string(),z.unknown()).optional()}).passthrough();

export function connectorServerName(connector:Pick<ConnectorSnapshot,'id'>):string { return `connector_${connector.id.replaceAll('-','')}`; }

