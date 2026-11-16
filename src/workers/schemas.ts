import { z } from 'zod';
import type { WorkerHealth } from '../ipc.ts';

export const workerId=z.string().min(1).max(64).regex(/^[a-z0-9][a-z0-9_-]*$/);
export const workerEffort=z.enum(['none','minimal','low','medium','high','xhigh','max','ultra']);
export const workerMode=z.enum(['user','root']);
const model=z.string().trim().min(1).max(200).refine(value=>!/[\0\r\n]/.test(value));
export const workerCreateInput=z.object({id:workerId.refine(value=>value!=='default','The default ID belongs to the legacy worker'),name:z.string().trim().min(1).max(120),model,effort:workerEffort.optional(),mode:workerMode.default('user'),enabled:z.boolean().default(true)}).strict();
export const workerUpdateInput=z.object({name:z.string().trim().min(1).max(120).optional(),enabled:z.boolean().optional(),draining:z.boolean().optional()}).strict();
export const workerRecordSchema=z.object({id:workerId,name:z.string().min(1).max(120),model:model.nullable(),effort:workerEffort.optional(),mode:workerMode,enabled:z.boolean(),draining:z.boolean(),createdAt:z.string().datetime(),updatedAt:z.string().datetime()}).strict().refine(record=>record.id==='default'||record.model!==null,'Named workers require an explicit model');
export type WorkerRecord=z.infer<typeof workerRecordSchema>;
export type WorkerCreateInput=z.input<typeof workerCreateInput>;
export type WorkerUpdateInput=z.infer<typeof workerUpdateInput>;
export interface WorkerStatus {worker:WorkerRecord;connected:boolean;health:WorkerHealth|null;error:string|null;command:string}
