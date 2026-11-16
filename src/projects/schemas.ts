import { z } from 'zod';
import type { Run } from '../shared.ts';
import type { ManagedSource,managedServiceStatus } from '../managed/schemas.ts';
import { workerId } from '../tasks/schemas.ts';

export const projectStatus = z.enum(['healthy','running','scheduled','ready','stopped','failed','unknown']);
export const componentKind = z.enum(['website','service','scheduled_job','script']);
export const projectId = z.string().uuid();
const name = z.string().trim().min(1).max(120);
const description = z.string().trim().max(4000);
const httpUrl = z.string().url().max(2000).refine(value => {
  const url = new URL(value);
  return ['http:','https:'].includes(url.protocol) && !url.username && !url.password;
}, 'Use an HTTP(S) URL without credentials');
const relativePath = z.string().min(1).max(1000).refine(value => !value.startsWith('/') && !value.includes('\\') && !value.includes('\0') && value.split('/').every(part => part && part !== '.' && part !== '..'), 'Use a relative path inside the project directory');
const unit = z.string().max(200).regex(/^[a-zA-Z0-9][a-zA-Z0-9_.@:-]*\.(service|timer)$/);
export const cronSchedule = z.string().trim().max(200).refine(value=>value.split(/\s+/).length===5&&value.split(/\s+/).every(field=>/^[a-zA-Z0-9*,/\-]+$/.test(field)),'Use a five-field cron schedule');
const timezone = z.string().max(100).refine(value => { try { new Intl.DateTimeFormat('en',{timeZone:value});return true; } catch { return false; } }, 'Use an IANA timezone');

export const projectCreateInput = z.object({
  name, description:description.default(''), origin:z.enum(['created','adopted']).default('created'),
  directory:z.string().min(1).max(2000).optional(),
  managed:z.boolean().optional(),template:z.enum(['service','empty']).optional(),
}).strict().refine(value => value.origin === 'adopted' || value.directory === undefined, 'Created projects receive a server-assigned directory');
export const projectUpdateInput = z.object({name:name.optional(),description:description.optional(),defaultWorkerId:workerId.nullable().optional()}).strict();
export const componentInput = z.object({
  name, kind:componentKind, unitName:unit.nullable().optional(), url:httpUrl.nullable().optional(),
  scriptPath:relativePath.nullable().optional(), schedule:z.string().trim().max(200).nullable().optional(), timezone:timezone.nullable().optional(),
}).strict().superRefine((value,ctx)=>{
  if(value.kind==='website'&&!value.url)ctx.addIssue({code:'custom',path:['url'],message:'Websites require a URL'});
  if(value.kind==='service'&&!value.unitName?.endsWith('.service'))ctx.addIssue({code:'custom',path:['unitName'],message:'Services require a .service unit'});
  if(value.kind==='scheduled_job'){
    if(value.unitName&&!value.unitName.endsWith('.timer'))ctx.addIssue({code:'custom',path:['unitName'],message:'Scheduled systemd jobs require a .timer unit'});
    if(!value.unitName&&(!value.scriptPath||!value.schedule||!cronSchedule.safeParse(value.schedule).success))ctx.addIssue({code:'custom',path:['schedule'],message:'Cron jobs require a relative script path and a five-field cron schedule'});
  }
  if(value.kind==='website'&&value.unitName&&!value.unitName.endsWith('.service'))ctx.addIssue({code:'custom',path:['unitName'],message:'Website services require a .service unit'});
  if(value.kind==='script'&&!value.scriptPath)ctx.addIssue({code:'custom',path:['scriptPath'],message:'Scripts require a relative script path'});
  if(value.kind!=='website'&&value.url)ctx.addIssue({code:'custom',path:['url'],message:'Only websites have a URL'});
});
export const componentUpdateInput = z.object({name:name.optional(),kind:componentKind.optional(),unitName:unit.nullable().optional(),url:httpUrl.nullable().optional(),scriptPath:relativePath.nullable().optional(),schedule:z.string().trim().max(200).nullable().optional(),timezone:timezone.nullable().optional()}).strict();
export const componentObservation = z.object({
  status:projectStatus, detail:z.string().max(4000), checkedAt:z.string().datetime(),
  serviceState:z.string().max(100).nullable().optional(), healthStatus:z.enum(['healthy','unhealthy','unknown']).optional(),
  lastRunAt:z.string().datetime().nullable().optional(), nextRunAt:z.string().datetime().nullable().optional(),
  lastExitCode:z.number().int().nullable().optional(),
}).strict();
export const projectInspectResult = z.object({observations:z.array(componentObservation.extend({componentId:projectId})).max(100)}).strict();
export const projectLogsResult = z.object({text:z.string().max(200_000),truncated:z.boolean(),checkedAt:z.string().datetime()}).strict();
export type ComponentObservation = z.infer<typeof componentObservation>;
export type ProjectStatus = z.infer<typeof projectStatus>;
export type ComponentKind = z.infer<typeof componentKind>;
export type ComponentInput = z.infer<typeof componentInput>;
export type ProjectCreateInput = z.infer<typeof projectCreateInput>;
export interface ProjectComponent {
  id:string;projectId:string;name:string;kind:ComponentKind;unitName:string|null;url:string|null;scriptPath:string|null;schedule:string|null;timezone:string|null;
  observation:ComponentObservation|null;status:ProjectStatus;stale:boolean;createdAt:string;updatedAt:string;
}
export interface Project {
  id:string;name:string;description:string;directory:string;origin:'created'|'adopted';createdAt:string;updatedAt:string;
  components:ProjectComponent[];status:ProjectStatus;lastCheckedAt:string|null;conversationIds:string[];runs:Run[];
  source?:ManagedSource;
  deployment?:ProjectDeployment;
  connectorIds?:string[];
  defaultWorkerId?:string|null;
}
export interface ProjectDeployment {
  commit:string;releaseDirectory:string;unitName:string|null;status:z.infer<typeof managedServiceStatus>;detail:string;checkedAt:string;
}
export type ProjectReference = Pick<Project,'id'|'directory'>;
export type ComponentReference = Pick<ProjectComponent,'id'|'kind'|'unitName'|'url'|'scriptPath'|'schedule'|'timezone'>;
export function componentReference(component:ProjectComponent):ComponentReference {
  const {id,kind,unitName,url,scriptPath,schedule,timezone}=component;return {id,kind,unitName,url,scriptPath,schedule,timezone};
}

export const projectReferenceSchema = z.object({id:projectId,directory:z.string().min(1).max(2000).startsWith('/')}).strict();
export const componentReferenceSchema = z.object({
  id:projectId,kind:componentKind,unitName:unit.nullable(),url:httpUrl.nullable(),scriptPath:relativePath.nullable(),
  schedule:z.string().max(200).nullable(),timezone:timezone.nullable(),
}).strict();
export const projectInspectInput = z.object({project:projectReferenceSchema,components:z.array(componentReferenceSchema).max(100)}).strict();
export const projectLogsInput = z.object({project:projectReferenceSchema,component:componentReferenceSchema}).strict();

export const projectPrepareResult = z.object({directory:z.string().startsWith('/').max(2000),ready:z.literal(true)}).strict();
export const projectPrepareInput = z.object({project:projectReferenceSchema}).strict();
