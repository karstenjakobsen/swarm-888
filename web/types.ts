import type { Conversation, Message, Run } from '../src/shared';
export type { Conversation, Message, Run } from '../src/shared';
export interface ExecutionEvent { seq: number; runId: string | null; conversationId: string | null; type: string; data: Record<string, unknown>; createdAt: string }
export interface WorkerHealth { uid: number; root: boolean; executionUid?: number; pid: number; activeRunId: string | null; uncertainRuns?: string[]; runtime: { available: boolean; authenticated: boolean; authenticating?: boolean; version: string; detail: string; model?: string } }
export interface Status { worker: WorkerHealth | null; workerError: string | null; maintenance: boolean; queue: Run[] }
export interface ConversationDetail { conversation: Conversation; messages: Message[]; runs: Run[]; events: ExecutionEvent[] }
export type JsonObject = Record<string, any>;
