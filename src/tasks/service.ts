import { createHash } from 'node:crypto';
import { delegatedTaskInput,taskOptions,type TaskOptions } from './schemas.ts';
import { PromptInput,terminal,type Run } from '../shared.ts';
import { taskPromptCapacity } from './budgets.ts';
import type { Store } from '../store.ts';
import type { Queue } from '../queue.ts';
import type { ProjectService } from '../projects/service.ts';
import type { ConnectorService } from '../connectors/service.ts';

const fail=(message:string,statusCode=409)=>Object.assign(new Error(message),{statusCode});
/** Scheduling policy and inherited grants are independent of model instructions. */
export class TaskService {
  constructor(private store:Store,private queue:Queue,private projects:ProjectService,private connectors:ConnectorService,private assertSafe:(input:unknown)=>void=()=>{}){}
  validate(options:TaskOptions,prompt?:string){
    const input=taskOptions.parse(Object.fromEntries(Object.entries(options).filter(([key])=>key in taskOptions.shape)));
    if(prompt!==undefined&&prompt.length>taskPromptCapacity(input))throw fail('The task prompt exceeds its context budget. Increase the limit or provide a smaller focused prompt.',400);
    if(input.workerId){const worker=this.queue.registry.get(input.workerId);if(worker.mode==='root'&&!input.requiredRoot)throw fail('Selecting a root worker requires the explicit root-access option');if(worker.mode==='user'&&input.requiredRoot)throw fail('This task requires root but the selected worker runs as a normal user');}
    for(const id of input.requiredConnectorIds??[])this.connectors.get(id);
  }
  submit(conversationId:string,raw:unknown){const input=PromptInput.parse(raw);if(!this.store.conversation(conversationId))throw fail('Conversation not found',404);this.assertSafe(input);this.validate(input,input.prompt);const {prompt,requestId,...options}=input;const run=this.store.enqueue(conversationId,prompt,requestId,'user',null,options);setImmediate(()=>void this.queue.tick());return run;}
  rootGranted(parent:Run):boolean{return Boolean(parent.requiredRoot||parent.attemptId&&this.store.attempt(parent.attemptId)?.uid===0);}
  inherited(parent:Run,raw:TaskOptions):TaskOptions {
    raw=taskOptions.parse(Object.fromEntries(Object.entries(raw).filter(([key])=>key in taskOptions.shape)));
    if(raw.requiredRoot&&!this.rootGranted(parent))throw fail('A delegated task cannot grant itself root access');
    const project=this.store.projects.forConversation(parent.conversationId),allowed=parent.attemptId?parent.grantedConnectorIds??[]:parent.connectionScope==='explicit'?parent.requiredConnectorIds??[]:this.store.connectors.assigned(project?.id??'',true);
    const ids=raw.requiredConnectorIds??allowed;if(ids.some(id=>!allowed.includes(id)))throw fail('Delegation cannot add connections beyond the parent task grant');
    for(const key of ['timeoutMs','maxToolCalls','maxContextChars','maxOutputChars'] as const)if(raw[key]!==undefined&&raw[key]!>(parent[key]??Infinity))throw fail('Delegation cannot increase the parent task execution limits');
    const options={...raw,requiredRoot:raw.requiredRoot??false,requiredConnectorIds:ids,timeoutMs:raw.timeoutMs??Math.min(parent.timeoutMs??600000,120000),maxToolCalls:raw.maxToolCalls??Math.min(parent.maxToolCalls??32,16),maxContextChars:raw.maxContextChars??Math.min(parent.maxContextChars??32000,12000),maxOutputChars:raw.maxOutputChars??Math.min(parent.maxOutputChars??64000,16000)};
    this.validate(options);return options;
  }
  create(parentId:string,raw:unknown){
    const parent=this.store.run(parentId);if(!parent||!['running','waiting'].includes(parent.status))throw fail('Delegation requires an active parent task');
    const input=delegatedTaskInput.parse(raw);this.assertSafe(input);
    const requestId=`delegate_${parent.id}_${createHash('sha256').update(input.requestId).digest('hex').slice(0,32)}`,prior=this.store.db.prepare('SELECT id,conversationId FROM runs WHERE requestId=?').get(requestId);
    if(!prior)this.checkTree(parent);
    const {prompt,requestId:_request,...rawOptions}=input,options=this.inherited(parent,rawOptions);
    this.validate(options,prompt);
    const project=this.store.projects.forConversation(parent.conversationId),conversation=prior?this.store.conversation(String(prior.conversationId),true)!:project?this.projects.newConversation(project.id):this.store.newConversation(`Delegated: ${prompt.slice(0,65)}`);
    const run=this.store.enqueue(conversation.id,prompt,requestId,'user',parent.id,{...options,taskType:'delegated'});setImmediate(()=>void this.queue.tick());return run;
  }
  checkTree(parent:Run){
    let ancestor=parent,depth=0;while(ancestor.parentRunId){depth++;const next=this.store.run(ancestor.parentRunId);if(!next)throw fail('Parent task history is incomplete');ancestor=next;}if(depth>=3)throw fail('Delegation depth is limited to three levels');
    const count=this.store.db.prepare('WITH RECURSIVE descendants(id) AS (SELECT ? UNION ALL SELECT r.id FROM runs r JOIN descendants d ON r.parentRunId=d.id) SELECT count(*) AS n FROM descendants').get(ancestor.id);if(Number(count?.n??0)>=32)throw fail('A task tree is limited to 32 tasks');
  }
  get(id:string,parentId?:string){const run=this.store.run(id);if(!run)throw fail('Task not found',404);if(parentId&&!this.descendant(run,parentId))throw fail('This task is outside the current task tree');return run;}
  list(parentId?:string){return this.store.runs().filter(run=>!parentId||this.descendant(run,parentId));}
  async cancel(id:string,parentId?:string){const run=this.get(id,parentId);if(terminal.has(run.status))return run;await this.queue.interrupt(id);return this.store.run(id);}
  private descendant(run:Run,parentId:string):boolean{let current:Run|undefined=run;for(let depth=0;current&&depth<10;depth++){if(current.id===parentId)return true;current=current.parentRunId?this.store.run(current.parentRunId):undefined;}return false;}
}
