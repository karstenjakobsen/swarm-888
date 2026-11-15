import { z } from 'zod';

export const RunStatus = z.enum(['queued','running','waiting','completed','failed','interrupted','uncertain']);
export type RunStatus = z.infer<typeof RunStatus>;
export const Id = z.string().min(1).max(200).regex(/^[a-zA-Z0-9_-]+$/);
export const PromptInput = z.object({prompt:z.string().trim().min(1).max(100_000),requestId:Id});
export const ReplyInput = z.object({requestId:z.union([z.string().max(200),z.number()]),answers:z.record(z.string(),z.object({answers:z.array(z.string().max(20_000)).max(20)}))});
export const WireRequest = z.object({id:z.union([z.string().max(200),z.number()]),token:z.string().max(256),method:z.string().max(100),params:z.unknown().optional()});
export interface Conversation {id:string; title:string; threadId:string|null; createdAt:string; updatedAt:string}
export interface Run {id:string; conversationId:string; prompt:string; status:RunStatus;kind:'user'|'improvement';summary:string;createdAt:string;startedAt:string|null;finishedAt:string|null;error:string|null;requestId:string;parentRunId:string|null}
export interface Message {id:string;conversationId:string;runId:string;role:'user'|'assistant';content:string;createdAt:string}
export interface AppEvent {seq:number;runId:string|null;conversationId:string|null;type:string;data:unknown;createdAt:string}
export const terminal = new Set<RunStatus>(['completed','failed','interrupted']);
export const ResolveInput=z.object({acknowledgeExternalEffects:z.boolean().optional()}).strict();

/** Older brokers may be root while their agent runs as a different user. */
export function rootExecution(health:{uid:number;root:boolean;executionUid?:number}|null|undefined):boolean {
  return health?.uid===0&&health.root===true&&(health.executionUid??health.uid)===0;
}
