import { z } from 'zod';
import { workerEffort } from './schemas.ts';

export const workerModelSchema=z.object({
  id:z.string().min(1).max(200),name:z.string().min(1).max(200),description:z.string().max(4000),
  supportedEfforts:z.array(workerEffort).max(20),defaultEffort:workerEffort.nullable().optional(),isDefault:z.boolean(),
}).strict();
export const workerModelCatalogSchema=z.object({
  models:z.array(workerModelSchema).max(1000),source:z.enum(['worker','cache','unavailable']),detail:z.string().max(1000).optional(),
}).strict();
export type WorkerModel=z.infer<typeof workerModelSchema>;
export type WorkerModelCatalog=z.infer<typeof workerModelCatalogSchema>;
