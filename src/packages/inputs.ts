import { z } from 'zod';
import { connectorTransportSchema } from '../connectors/schemas.ts';
import { packageCommandSchema, packageKind, packagePathSchema, packageVersion } from './schemas.ts';

export const createPackageInput = z.object({
  path: packagePathSchema,
  kind: packageKind,
  name: z.string().trim().min(1).max(120),
  description: z.string().max(4000).default(''),
  version: packageVersion.default('0.1.0'),
  template: z.enum(['empty', 'service', 'connector']).optional(),
  adopt: z.boolean().default(false),
  mcp: connectorTransportSchema.optional(),
  run: packageCommandSchema.optional(),
}).strict().superRefine((input,ctx)=>{
  if(input.template==='service'&&input.kind!=='project')
    ctx.addIssue({code:'custom',path:['template'],message:'The service template requires a project package.'});
  if(input.template==='connector'&&input.kind!=='connector')
    ctx.addIssue({code:'custom',path:['template'],message:'The connector template requires a connector package.'});
});

export type CreatePackageInput = z.infer<typeof createPackageInput>;
