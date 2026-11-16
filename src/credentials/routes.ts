import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Config } from '../config.ts';
import type { ConnectorService } from '../connectors/service.ts';
import { connectorAuthSchema } from './schemas.ts';
import type { CredentialVault } from './vault.ts';

export const oauthCallbackPath='/api/credentials/oauth/callback';
export function registerCredentialRoutes(app:FastifyInstance,options:{vault:CredentialVault;connectors:ConnectorService;config:Config;session:(request:any)=>{hash:string}|null;writable:()=>void}){
  const {vault,connectors,config,session,writable}=options;
  const cookie=(value:string)=>`operator_oauth=${value}; Path=${oauthCallbackPath}; HttpOnly; SameSite=Lax; Max-Age=${value?600:0}${config.secureCookie?'; Secure':''}`;
  app.get('/api/credentials',async()=>vault.list());
  app.post('/api/credentials',async request=>{writable();return vault.create(request.body);});
  app.put('/api/credentials/:id',async(request:any)=>{writable();return vault.update(request.params.id,request.body);});
  app.delete('/api/credentials/:id',async(request:any)=>{writable();return vault.remove(request.params.id);});
  app.put('/api/connectors/:id/auth',async(request:any)=>{writable();const {auth}=z.object({auth:connectorAuthSchema.nullable()}).strict().parse(request.body),connector=connectors.get(request.params.id);if(auth&&(connector.transport==='stdio')!==(auth.type==='env'))throw new Error('Credential binding does not match connection transport');if(auth)vault.grant(auth.credentialId,request.params.id);return connectors.setAuth(request.params.id,auth);});
  app.post('/api/connectors/:id/oauth/start',async(request:any,reply)=>{
    writable();const current=session(request);if(!current)throw Object.assign(new Error('Administrator login required'),{statusCode:401});
    const connector=connectors.get(request.params.id);if(connector.transport!=='http')throw new Error('OAuth bearer authorization requires an HTTP connection');
    const origin=String(request.headers.origin??'');if(!config.origins.includes(origin))throw new Error('Configured browser Origin required');
    const redirectUri=new URL(oauthCallbackPath,origin).href,result=await vault.startOAuth(connector.id,request.body,current.hash,redirectUri);
    connectors.setAuth(connector.id,{type:'oauth2',credentialId:result.credential.id});reply.header('set-cookie',cookie(result.cookie));const {cookie:_secret,...publicResult}=result;return publicResult;
  });
  app.get('/api/connectors/:id/oauth/status',async(request:any)=>{const connector=connectors.get(request.params.id);return {readiness:connector.readiness,...(connector.auth?{credential:vault.get(connector.auth.credentialId)}:{})};});
  app.post('/api/connectors/:id/oauth/cancel',async(request:any)=>{writable();z.object({}).strict().parse(request.body??{});connectors.get(request.params.id);return vault.cancelOAuth(request.params.id);});
  // Main controller exempts only this exact GET from its normal SameSite=Strict
  // cookie hook. The independent Lax nonce is bound to a live initiating session.
  app.get(oauthCallbackPath,async(request:any,reply)=>{
    const input=z.object({state:z.string().min(1).max(200),code:z.string().max(32_000).optional(),error:z.string().max(200).optional()}).passthrough().parse(request.query);
    const nonce=String(request.headers.cookie??'').split(';').map(value=>value.trim()).find(value=>value.startsWith('operator_oauth='))?.slice('operator_oauth='.length)??'';
    const target=vault.callbackTarget(input.state,nonce);let success=false;
    try{await vault.completeOAuth(input.state,nonce,input.code??'');success=true;}catch{}
    reply.header('set-cookie',cookie(''));const redirect=new URL('/',target.redirectUri);redirect.searchParams.set('oauth',success?'connected':'error');redirect.searchParams.set('connector',target.connectorId);return reply.redirect(redirect.href);
  });
}
