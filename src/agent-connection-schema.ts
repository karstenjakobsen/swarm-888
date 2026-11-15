import { z } from 'zod';

/** Browser-safe connection state. Tokens and API credentials never belong here. */
export const AgentConnectionSchema = z.object({
  state:z.enum(['disconnected','connecting','connected','error']),
  workerConnected:z.boolean(),
  workerUid:z.number().int().nullable(),
  executionUid:z.number().int().nullable().optional(),
  verificationUrl:z.string().url().refine(value=>{
    const url=new URL(value);
    return url.origin==='https://auth.openai.com'&&url.pathname==='/codex/device'&&!url.search&&!url.hash&&!url.username&&!url.password;
  },'Unexpected ChatGPT device verification URL').optional(),
  userCode:z.string().min(1).max(100).optional(),
  expiresAt:z.string().datetime().optional(),
  error:z.string().max(4000).optional(),
  rootWorkerCommand:z.string().max(16_000).optional(),
}).strict();
export type AgentConnection = z.infer<typeof AgentConnectionSchema>;
