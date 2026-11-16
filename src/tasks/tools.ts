import type { z } from 'zod';
import type { ToolContext } from '../brain/index.ts';
import type { toolSchemas } from '../brain/schemas.ts';
import type { Store } from '../store.ts';
import type { Queue } from '../queue.ts';
import type { JobService } from '../jobs/service.ts';
import type { TaskService } from './service.ts';

type ToolName='worker_list'|'task_create'|'task_get'|'task_list'|'task_cancel'|'job_list'|'job_create'|'job_update'|'job_trigger';
type PlatformTools={[Name in ToolName]:(input:z.infer<(typeof toolSchemas)[Name]>,context:ToolContext)=>unknown};
const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});

/** Application policy shared by model tools; HTTP only wires these services. */
export function createPlatformTools(store:Store,queue:Queue,tasks:TaskService,jobs:JobService):PlatformTools {
  const activeParent=(context:ToolContext)=>{const run=context.runId?store.run(context.runId):undefined;if(!run||!['running','waiting'].includes(run.status))throw fail('This operation requires an active parent task');return run;};
  const scopedJob=(id:string,context:ToolContext)=>{const parent=activeParent(context),job=jobs.get(id),project=store.projects.forConversation(parent.conversationId);if(!project||job.projectId!==project.id)throw fail('This job belongs to a different project',403);return {parent,job};};
  return {
    worker_list:()=>queue.workerStatuses(),
    task_create:(input,context)=>tasks.create(activeParent(context).id,input),
    task_get:(input,context)=>tasks.get(input.id,activeParent(context).id),
    task_list:(_input,context)=>tasks.list(activeParent(context).id),
    task_cancel:(input,context)=>tasks.cancel(input.id,activeParent(context).id),
    job_list:(input,context)=>{const parent=activeParent(context),project=store.projects.forConversation(parent.conversationId);return jobs.list().filter(job=>job.projectId===project?.id&&(!input.projectId||job.projectId===input.projectId));},
    job_create:(input,context)=>{const parent=activeParent(context),project=store.projects.forConversation(parent.conversationId);if(!project||input.projectId!==project.id)throw fail('Recurring jobs must belong to the parent project',403);return jobs.create({...input,...tasks.inherited(parent,input)});},
    job_update:(input,context)=>{
      const {id,...patch}=input,{parent,job}=scopedJob(id,context);
      if(patch.projectId&&patch.projectId!==job.projectId)throw fail('A delegated job cannot change projects',403);
      const options={...job,...patch,requiredConnectorIds:patch.requiredConnectorIds===null?undefined:patch.requiredConnectorIds??job.requiredConnectorIds};
      // A model may restore inheritance only from its accepted parent grant.
      return jobs.update(id,{...patch,...tasks.inherited(parent,options)});
    },
    job_trigger:(input,context)=>{const {parent,job}=scopedJob(input.id,context);tasks.checkTree(parent);const run=jobs.run(input.id,tasks.inherited(parent,job),parent.id);setImmediate(()=>void queue.tick());return run;},
  };
}
