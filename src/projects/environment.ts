import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Store } from '../store.ts';
import type { CredentialVault } from '../credentials/vault.ts';
import { projectEnvironmentSchema } from '../credentials/schemas.ts';
import type { ProjectService } from './service.ts';

export const projectEnvironmentInput=z.object({environment:projectEnvironmentSchema.nullable()}).strict();

/** Only authenticated owner routes can grant service credentials; model tools have no setter. */
export function registerProjectEnvironmentRoutes(app:FastifyInstance,options:{vault:CredentialVault;projects:ProjectService;store:Store;writable:()=>void}){
  const {vault,projects,store,writable}=options;
  const current=(id:string)=>{projects.get(id);const environment=store.projects.environment(id);return {environment,readiness:vault.projectReadiness(environment,id)};};
  app.get('/api/projects/:id/environment',async(request:any)=>current(request.params.id));
  app.put('/api/projects/:id/environment',async(request:any)=>{
    writable();const id=request.params.id;projects.get(id);const {environment}=projectEnvironmentInput.parse(request.body);vault.assertSafe(environment);
    const previous=store.projects.environment(id);
    if(environment)vault.grantProject(environment.credentialId,id);
    store.projects.setEnvironment(id,environment);
    if(previous&&previous.credentialId!==environment?.credentialId)try{vault.revokeProject(previous.credentialId,id);}catch(error){if((error as {statusCode?:number}).statusCode!==404&&(error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
    return current(id);
  });
}
