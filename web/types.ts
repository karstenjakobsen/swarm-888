export interface Conversation { id: string; title: string; threadId?: string | null; createdAt: string; updatedAt: string }
export interface Message { id: string; conversationId: string; runId: string | null; role: 'user' | 'assistant'; content: string; createdAt: string }
export interface Run { id: string; conversationId: string; prompt: string; status: string; kind: string; summary?: string; createdAt: string; startedAt?: string | null; finishedAt?: string | null; error?: string | null }
export interface ExecutionEvent { seq: number; runId: string | null; conversationId: string | null; type: string; data: Record<string, unknown>; createdAt: string }
export interface WorkerHealth { uid: number; root: boolean; pid: number; activeRunId: string | null; uncertainRuns?: string[]; runtime: { available: boolean; authenticated: boolean; authenticating?: boolean; version: string; detail: string; model?: string } }
export interface Status { worker: WorkerHealth | null; workerError: string | null; maintenance: boolean; queue: Run[] }
export interface ConversationDetail { conversation: Conversation; messages: Message[]; runs: Run[]; events: ExecutionEvent[] }
export type JsonObject = Record<string, any>;
