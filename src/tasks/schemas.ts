import { z } from 'zod';
import { workerId } from '../workers/schemas.ts';

export { workerId } from '../workers/schemas.ts';
export const taskOptions = z.object({
  workerId: workerId.nullable().optional(),
  requiredRoot: z.boolean().optional(),
  requiredConnectorIds: z.array(z.string().uuid()).max(20).optional(),
  timeoutMs: z.number().int().min(1000).max(86_400_000).optional(),
  maxToolCalls: z.number().int().min(1).max(1000).optional(),
  maxContextChars: z.number().int().min(1000).max(200_000).optional(),
  maxOutputChars: z.number().int().min(1000).max(1_000_000).optional(),
}).strict();
export type TaskOptions = z.infer<typeof taskOptions>;
export const delegatedTaskInput = taskOptions.extend({
  prompt: z.string().trim().min(1).max(50_000),
  requestId: z.string().min(1).max(150),
}).strict();
