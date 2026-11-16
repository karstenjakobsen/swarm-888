import type { DatabaseSync } from 'node:sqlite';
import { createHash,randomBytes,randomUUID } from 'node:crypto';
import { z } from 'zod';
import { credentialCreate,credentialUpdate,credentialSecretValue,connectorAuthSchema,projectEnvironmentSchema,oauthStart,type CredentialMetadata,type OAuthConfiguration } from './schemas.ts';
import { readCredentialSecret,writeCredentialSecret,removeCredentialSecret,redactSecrets,type CredentialSecret } from './files.ts';

const fail=(message:string,statusCode=400)=>Object.assign(new Error(message),{statusCode});
const hash=(value:string)=>createHash('sha256').update(value).digest('hex');
type Row={id:string;name:string;kind:'secret'|'oauth2';fields:string;revision:number;ready:number;expiresAt:string|null;updatedAt:string};
export class CredentialVault {
  private seen=new Set<string>();private refreshing=new Map<string,Promise<void>>();
  constructor(readonly stateDir:string,private db:DatabaseSync,knownSecrets:readonly string[]=[]){for(const secret of knownSecrets)if(secret)this.seen.add(secret);for(const row of this.rows())try{this.remember(readCredentialSecret(stateDir,row.id));}catch{}}
  private rows(){return this.db.prepare('SELECT * FROM credentials ORDER BY name,id').all() as Row[];}
  private remember(secret:CredentialSecret){for(const [name,value]of Object.entries(secret.values))if(value&&name!=='__expires_at')this.seen.add(value);}
  private row(id:string){z.string().uuid().parse(id);const row=this.db.prepare('SELECT * FROM credentials WHERE id=?').get(id) as Row|undefined;if(!row)throw fail('Credential not found',404);return row;}
  private public(row:Row):CredentialMetadata {return {...row,name:this.redact(row.name),fields:(JSON.parse(row.fields)as string[]).map(field=>this.redact(field)),ready:row.ready===1};}
  list(){return this.rows().map(row=>this.public(row));}
  get(id:string){return this.public(this.row(id));}
  private save(id:string,name:string,kind:Row['kind'],secret:CredentialSecret,ready=true,configurationChanged=true){
    const previous=this.db.prepare('SELECT revision FROM credentials WHERE id=?').get(id) as {revision:number}|undefined;
    const revision=previous?previous.revision+(configurationChanged?1:0):1;
    secret={...secret,revision,materialRevision:(secret.materialRevision??secret.revision??0)+1,ready};
    this.remember(secret);writeCredentialSecret(this.stateDir,id,secret);
    const fields=Object.keys(secret.values).filter(name=>!name.startsWith('__'));
    const expiresAt=secret.values.__expires_at||null;
    this.db.prepare('INSERT INTO credentials(id,name,kind,fields,revision,ready,expiresAt,updatedAt) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET fields=excluded.fields,revision=excluded.revision,ready=excluded.ready,expiresAt=excluded.expiresAt,updatedAt=excluded.updatedAt').run(id,name,kind,JSON.stringify(fields),revision,ready?1:0,expiresAt,new Date().toISOString());
    return this.get(id);
  }
  create(raw:unknown){const input=credentialCreate.parse(raw);if(this.rows().length>=1000)throw fail('At most 1000 credentials');return this.save(randomUUID(),input.name,'secret',{values:input.values});}
  update(id:string,raw:unknown){const row=this.row(id),input=credentialUpdate.parse(raw);if(row.kind!=='secret')throw fail('OAuth tokens are updated through the authorization flow');const secret=readCredentialSecret(this.stateDir,id);return this.save(id,row.name,row.kind,{...secret,values:{...secret.values,...input.values}});}
  remove(id:string){this.row(id);removeCredentialSecret(this.stateDir,id);this.db.prepare('DELETE FROM credentials WHERE id=?').run(id);this.db.prepare('DELETE FROM oauth_requests WHERE credentialId=?').run(id);return {ok:true};}
  grant(id:string,connectorId:string){this.row(id);const secret=readCredentialSecret(this.stateDir,id);z.string().uuid().parse(connectorId);writeCredentialSecret(this.stateDir,id,{...secret,connectorIds:[...new Set([...(secret.connectorIds??[]),connectorId])]});this.db.prepare('UPDATE credentials SET updatedAt=? WHERE id=?').run(new Date().toISOString(),id);return this.get(id);}
  revoke(id:string,connectorId:string){this.row(id);z.string().uuid().parse(connectorId);const secret=readCredentialSecret(this.stateDir,id);writeCredentialSecret(this.stateDir,id,{...secret,connectorIds:(secret.connectorIds??[]).filter(value=>value!==connectorId)});this.db.prepare('DELETE FROM oauth_requests WHERE credentialId=? AND connectorId=?').run(id,connectorId);this.db.prepare('UPDATE credentials SET updatedAt=? WHERE id=?').run(new Date().toISOString(),id);return this.get(id);}
  grantProject(id:string,projectId:string){this.row(id);z.string().uuid().parse(projectId);const secret=readCredentialSecret(this.stateDir,id);writeCredentialSecret(this.stateDir,id,{...secret,projectIds:[...new Set([...(secret.projectIds??[]),projectId])]});this.db.prepare('UPDATE credentials SET updatedAt=? WHERE id=?').run(new Date().toISOString(),id);return this.get(id);}
  revokeProject(id:string,projectId:string){this.row(id);z.string().uuid().parse(projectId);const secret=readCredentialSecret(this.stateDir,id);writeCredentialSecret(this.stateDir,id,{...secret,projectIds:(secret.projectIds??[]).filter(value=>value!==projectId)});this.db.prepare('UPDATE credentials SET updatedAt=? WHERE id=?').run(new Date().toISOString(),id);return this.get(id);}
  projectReadiness(raw:unknown,projectId:string):{ready:boolean;reason?:string;credentialId?:string;revision?:number;materialRevision?:number}{
    if(!raw)return {ready:true};const binding=projectEnvironmentSchema.parse(raw);
    try{const row=this.row(binding.credentialId),secret=readCredentialSecret(this.stateDir,row.id),fields=Object.values(binding.bindings);if(!secret.projectIds?.includes(projectId))return {ready:false,reason:'This credential needs an owner grant for the project.',credentialId:row.id};if(!row.ready||fields.some(field=>!Object.hasOwn(secret.values,field)||!secret.values[field]))return {ready:false,reason:'Configure the selected project credential fields.',credentialId:row.id};if(fields.includes('access_token')&&row.expiresAt&&Date.parse(row.expiresAt)<=Date.now())return {ready:false,reason:'The selected access token expired. Authorize the account again before deploying.',credentialId:row.id};return {ready:true,credentialId:row.id,revision:row.revision,materialRevision:secret.materialRevision??secret.revision??row.revision};}catch{return {ready:false,reason:'Project credentials are missing. Configure them before deploying.',credentialId:binding.credentialId};}
  }
  redact(value:unknown){return redactSecrets(value,[...this.seen]);}
  assertSafe(value:unknown){if(JSON.stringify(value)!==JSON.stringify(this.redact(value)))throw fail('Credential values cannot be stored in source, memory, or task input');}
  readiness(raw:unknown,connectorId:string):{ready:boolean;reason?:string;credentialId?:string}{
    if(!raw)return {ready:true};const binding=connectorAuthSchema.parse(raw);
    try{
      const row=this.row(binding.credentialId),secret=readCredentialSecret(this.stateDir,row.id);
      if(!secret.connectorIds?.includes(connectorId))return {ready:false,reason:'This credential needs an owner grant for the connection.',credentialId:row.id};
      const fields=binding.type==='bearer'?[binding.field]:binding.type==='oauth2'?['access_token']:Object.values(binding.bindings);
      if(!row.ready||fields.some(name=>!Object.hasOwn(secret.values,name)||!secret.values[name]))return {ready:false,reason:'Configure or authorize this connection in Connections.',credentialId:row.id};
      if(binding.type==='oauth2'&&row.expiresAt&&Date.parse(row.expiresAt)<=Date.now()+60_000&&!secret.values.refresh_token)return {ready:false,reason:'Authorization expired. Connect this account again.',credentialId:row.id};
      return {ready:true,credentialId:row.id};
    }catch{return {ready:false,reason:'Connection credentials are missing. Configure them in Connections.',credentialId:binding.credentialId};}
  }
  async ensure(raw:unknown,connectorId:string){if(!raw)return;const binding=connectorAuthSchema.parse(raw),initial=this.readiness(binding,connectorId);if(!initial.ready)throw fail(initial.reason??'Connection needs credentials',409);if(binding.type==='oauth2')await this.refresh(binding.credentialId);const state=this.readiness(binding,connectorId);if(!state.ready)throw fail(state.reason??'Connection needs credentials',409);}
  async startOAuth(connectorId:string,raw:unknown,sessionHash:string,redirectUri:string){
    z.string().uuid().parse(connectorId);if(this.rows().length>=1000)throw fail('At most 1000 credentials');const input=oauthStart.parse(raw),id=randomUUID(),state=randomBytes(32).toString('base64url'),cookie=randomBytes(32).toString('base64url'),verifier=randomBytes(32).toString('base64url'),expiresAt=Date.now()+600_000;
    const oauth:OAuthConfiguration={authorizationUrl:input.authorizationUrl,tokenUrl:input.tokenUrl,clientId:input.clientId,scopes:input.scopes,tokenAuthMethod:input.tokenAuthMethod,tokenMethod:input.tokenMethod,tokenFields:input.tokenFields,redirectUri};
    const credential=this.save(id,input.name??'OAuth connection','oauth2',{values:{__verifier:verifier,...(input.clientSecret?{client_secret:input.clientSecret}:{})},oauth,connectorIds:[connectorId]},false);
    this.db.prepare('DELETE FROM oauth_requests WHERE connectorId=? OR sessionHash=? OR expiresAt<?').run(connectorId,sessionHash,Date.now());
    this.db.prepare('INSERT INTO oauth_requests(stateHash,connectorId,credentialId,sessionHash,cookieHash,expiresAt,verifier,redirectUri) VALUES(?,?,?,?,?,?,?,?)').run(hash(state),connectorId,id,sessionHash,hash(cookie),expiresAt,'encrypted-in-vault',redirectUri);
    const url=new URL(input.authorizationUrl);for(const [key,value]of Object.entries({response_type:'code',client_id:input.clientId,redirect_uri:redirectUri,state,code_challenge:createHash('sha256').update(verifier).digest('base64url'),code_challenge_method:'S256',...(input.scopes.length?{scope:input.scopes.join(' ')}:{})}))url.searchParams.set(key,value);
    return {authorizationUrl:url.href,expiresAt:new Date(expiresAt).toISOString(),credential,cookie};
  }
  cancelOAuth(connectorId:string){this.db.prepare('DELETE FROM oauth_requests WHERE connectorId=?').run(connectorId);return {ok:true};}
  callbackTarget(state:string,cookie:string){
    const row=this.db.prepare('SELECT * FROM oauth_requests WHERE stateHash=?').get(hash(state)) as {stateHash:string;connectorId:string;credentialId:string;sessionHash:string;cookieHash:string;expiresAt:number;redirectUri:string;verifier:string}|undefined;
    if(!row||row.verifier!=='encrypted-in-vault'||row.expiresAt<Date.now()||row.cookieHash!==hash(cookie)||!this.db.prepare('SELECT 1 FROM sessions WHERE hash=? AND expiresAt>?').get(row.sessionHash,Date.now()))throw fail('OAuth request expired or does not match the initiating browser session',403);return row;
  }
  async completeOAuth(state:string,cookie:string,code:string){
    const row=this.callbackTarget(state,cookie);
    if(this.db.prepare("UPDATE oauth_requests SET verifier='exchanging' WHERE stateHash=? AND verifier='encrypted-in-vault'").run(row.stateHash).changes!==1)throw fail('OAuth request was already consumed',403);
    if(!code)throw fail('Authorization was cancelled or denied. Start again.');
    const secret=readCredentialSecret(this.stateDir,row.credentialId);if(!secret.oauth)throw fail('OAuth configuration is missing');
    const tokens=await this.tokens(secret,{grant_type:'authorization_code',code,redirect_uri:row.redirectUri,code_verifier:secret.values.__verifier});
    if(!this.db.prepare("SELECT 1 FROM oauth_requests WHERE stateHash=? AND verifier='exchanging' AND expiresAt>?").get(row.stateHash,Date.now())||!this.db.prepare('SELECT 1 FROM sessions WHERE hash=? AND expiresAt>?').get(row.sessionHash,Date.now()))throw fail('OAuth request was cancelled or its session expired',403);delete secret.values.__verifier;
    const metadata=this.row(row.credentialId),latest=readCredentialSecret(this.stateDir,row.credentialId);delete latest.values.__verifier;
    this.save(row.credentialId,metadata.name,'oauth2',{...latest,values:{...latest.values,...tokens}},true);this.db.prepare('DELETE FROM oauth_requests WHERE stateHash=?').run(row.stateHash);return {connectorId:row.connectorId,redirectUri:row.redirectUri};
  }
  private async tokens(secret:CredentialSecret,grant:Record<string,string>):Promise<Record<string,string>>{
    const oauth=secret.oauth!;const body=new URLSearchParams({...grant,client_id:oauth.clientId}),headers:Record<string,string>={'content-type':'application/x-www-form-urlencoded',accept:'application/json'};
    if(oauth.tokenAuthMethod==='client_secret_basic')headers.Authorization=`Basic ${Buffer.from(`${encodeURIComponent(oauth.clientId)}:${encodeURIComponent(secret.values.client_secret??'')}`).toString('base64')}`;
    else if(oauth.tokenAuthMethod==='client_secret_post')body.set('client_secret',secret.values.client_secret??'');
    const method=oauth.tokenMethod??'POST',endpoint=new URL(oauth.tokenUrl);if(method==='GET')for(const [name,value]of body)endpoint.searchParams.set(name,value);
    // Some providers require GET query parameters. Never return the expanded URL,
    // upstream error, or response body: any of them can contain client secrets.
    let response:Response;try{response=await fetch(endpoint,{method,headers,...(method==='POST'?{body}:{}),redirect:'error',signal:AbortSignal.timeout(10_000)});}catch{throw fail('OAuth token exchange failed. Start authorization again.',409);}
    const length=Number(response.headers.get('content-length')??0);if(length>64_000){await response.body?.cancel();throw fail('OAuth token response exceeded its size limit');}
    const reader=response.body?.getReader();let text='',bytes=0;if(reader)try{while(true){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>64_000)throw fail('OAuth token response exceeded its size limit');text+=Buffer.from(next.value).toString();}}catch{throw fail('OAuth token response could not be read within its size limit. Start authorization again.',409);}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
    if(!response.ok)throw fail('OAuth authorization was rejected. Connect the account again.',409);
    let raw:unknown;try{raw=JSON.parse(text);}catch{throw fail('OAuth server returned an invalid token response');}
    const fields=oauth.tokenFields??{accessToken:'access_token',refreshToken:'refresh_token',expiresIn:'expires_in'},value=(name:string)=>raw&&typeof raw==='object'&&Object.hasOwn(raw,name)?(raw as Record<string,unknown>)[name]:undefined;
    const parsed=z.object({access_token:credentialSecretValue,token_type:z.string().optional(),refresh_token:credentialSecretValue.optional(),expires_in:z.union([z.number(),z.string()]).optional()}).safeParse({access_token:value(fields.accessToken),refresh_token:value(fields.refreshToken),expires_in:value(fields.expiresIn),token_type:value('token_type')});if(!parsed.success)throw fail('OAuth server returned invalid token fields. Tokens must contain at least 8 characters.');const result=parsed.data;
    if(result.token_type&&result.token_type.toLowerCase()!=='bearer')throw fail('Only OAuth bearer tokens are supported');
    const expires=result.expires_in===undefined?undefined:Number(result.expires_in);if(expires!==undefined&&(!Number.isFinite(expires)||expires<=0||expires>31536000))throw fail('OAuth token lifetime is invalid');
    return {access_token:result.access_token,...(result.refresh_token?{refresh_token:result.refresh_token}:{}),__expires_at:expires?new Date(Date.now()+expires*1000).toISOString():''};
  }
  refresh(id:string):Promise<void>{
    const running=this.refreshing.get(id);if(running)return running;
    const operation=(async()=>{const row=this.row(id),secret=readCredentialSecret(this.stateDir,id);if(row.kind!=='oauth2'||!secret.oauth||!row.ready)return;if(!row.expiresAt||Date.parse(row.expiresAt)>Date.now()+60_000)return;if(!secret.values.refresh_token)throw fail('Authorization expired. Connect the account again.',409);
      try{const tokens=await this.tokens(secret,{grant_type:'refresh_token',refresh_token:secret.values.refresh_token});const current=this.db.prepare('SELECT revision FROM credentials WHERE id=?').get(id)as{revision:number}|undefined;if(!current||current.revision!==row.revision)throw fail('Credential changed while refreshing');const latest=readCredentialSecret(this.stateDir,id);this.save(id,row.name,row.kind,{...latest,values:{...latest.values,...tokens}},true,false);}catch{if((this.db.prepare('SELECT revision FROM credentials WHERE id=?').get(id)as{revision:number}|undefined)?.revision===row.revision)try{const latest=readCredentialSecret(this.stateDir,id);writeCredentialSecret(this.stateDir,id,{...latest,ready:false});}catch{}this.db.prepare('UPDATE credentials SET ready=0,updatedAt=? WHERE id=? AND revision=?').run(new Date().toISOString(),id,row.revision);throw fail('Authorization needs reconnecting. Its refresh result was not accepted.',409);}})();
    this.refreshing.set(id,operation);void operation.finally(()=>this.refreshing.delete(id)).catch(()=>{});return operation;
  }
}
