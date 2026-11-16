import { z } from 'zod';
import { taskOptions } from '../tasks/schemas.ts';

export const jobSchedule = z.discriminatedUnion('type', [
  z.object({type:z.literal('interval'),seconds:z.number().int().min(10).max(31_536_000)}).strict(),
  z.object({type:z.literal('cron'),expression:z.string().trim().min(9).max(200),timezone:z.string().max(100).default('UTC').refine(value=>{try{new Intl.DateTimeFormat('en',{timeZone:value});return true;}catch{return false;}},'Use an IANA timezone')}).strict(),
]);
export const jobInput = taskOptions.extend({
  name:z.string().trim().min(1).max(120),
  projectId:z.string().uuid(),
  prompt:z.string().trim().min(1).max(50_000),
  schedule:jobSchedule,
  enabled:z.boolean().default(true),
}).strict();
export const jobPatch = jobInput.partial().extend({requiredConnectorIds:z.array(z.string().uuid()).max(20).nullable().optional()}).strict();
export type JobInput=z.infer<typeof jobInput>;
export interface Job extends JobInput {
  id:string;createdAt:string;updatedAt:string;nextRunAt:string|null;lastRunAt:string|null;blockedReason:string|null;
  history:Array<{runId:string;scheduledFor:string;status:string;workerId:string|null;model:string|null}>;
}
