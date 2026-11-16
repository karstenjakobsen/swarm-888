import { createInterface } from 'node:readline';
import { connectorSnapshotSchema } from './schemas.ts';
import { ConnectorSession } from './client.ts';

const connector=connectorSnapshotSchema.parse(JSON.parse(process.env.OPERATOR_CONNECTOR_CONFIG??'null'));
if(!process.env.APP_STATE_DIR)throw new Error('Connector proxy requires its private state directory');
const session=new ConnectorSession({stateDir:process.env.APP_STATE_DIR},connector,15_000,undefined,true);
let started:Promise<void>|undefined,queue=Promise.resolve();
const input=createInterface({input:process.stdin,crlfDelay:Infinity});
input.on('line',line=>{queue=queue.then(async()=>{
  if(Buffer.byteLength(line)>2*1024*1024)throw new Error('Connector request exceeds 2 MiB');
  let message:any;try{message=JSON.parse(line);if(message.id===undefined)return;let result:unknown;
    if(message.method==='initialize'){started??=session.start();await started;result={protocolVersion:message.params?.protocolVersion??'2025-06-18',capabilities:{tools:{}},serverInfo:{name:'operator-credential-connector',version:'1.0.0'}};}
    else if(message.method==='ping')result={};
    else {await (started??=session.start());if(message.method==='tools/list')result={tools:await session.tools()};else if(message.method==='tools/call')result=await session.call(message.params?.name,message.params?.arguments??{});else throw new Error('Unsupported MCP method');}
    process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,result})+'\n');
  }catch{if(message?.id!==undefined)process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:message.id,error:{code:-32603,message:'Connection request failed. Check authorization and connection status in the operator.'}})+'\n');}
}).catch(()=>{});});
input.on('close',()=>void queue.finally(()=>session.close()));
for(const signal of ['SIGTERM','SIGINT']as const)process.once(signal,()=>void session.close().finally(()=>process.exit(0)));
