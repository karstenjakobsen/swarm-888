import type { Config } from '../config.ts';
import { connectorAuthSchema,projectEnvironmentSchema } from './schemas.ts';
import { z } from 'zod';
import { readCredentialSecret,redactSecrets } from './files.ts';

export function resolveConnectorSecrets(config:Pick<Config,'stateDir'>,connector:{id:string;transport:'http'|'stdio';auth?:unknown;credentialRevision?:number}){
  const headers:Record<string,string>=Object.create(null),env:Record<string,string>=Object.create(null);let secrets:string[]=[];
  if(connector.auth){
    const binding=connectorAuthSchema.parse(connector.auth),stored=readCredentialSecret(config.stateDir,binding.credentialId);secrets=Object.entries(stored.values).filter(([name])=>name!=='__expires_at').map(([,value])=>value);
    if(!stored.connectorIds?.includes(connector.id))throw new Error('The credential has not been granted to this connection');
    if(stored.ready===false)throw new Error('Connection credentials need authorization');
    if(connector.credentialRevision!==undefined&&connector.credentialRevision!==stored.revision)throw new Error('Connection credentials changed; prepare the current connection again');
    const field=(name:string)=>{const value=Object.hasOwn(stored.values,name)?stored.values[name]:undefined;if(!value)throw new Error('Connection credentials need configuration');return value;};
    if(binding.type==='env'){if(connector.transport!=='stdio')throw new Error('Environment credentials require stdio');for(const [name,key]of Object.entries(binding.bindings))env[name]=field(key);}
    else{
      if(connector.transport!=='http')throw new Error('HTTP credentials require an HTTP connection');
      if(binding.type==='headers')for(const [name,key]of Object.entries(binding.bindings)){const value=field(key);if(/[\r\n]/.test(value))throw new Error('Credential headers must not contain line breaks');headers[name]=value;}
      else {const value=field(binding.type==='oauth2'?'access_token':binding.field);if(/[\r\n]/.test(value))throw new Error('Credential headers must not contain line breaks');headers.Authorization=`Bearer ${value}`;}
    }
  }
  return {headers,env,secrets,redact:(value:unknown)=>redactSecrets(value,secrets)};
}

/** Deployed services receive only values explicitly granted to their project. */
export function resolveProjectSecrets(config:Pick<Config,'stateDir'>,projectId:string,raw:unknown){
  z.string().uuid().parse(projectId);const environment=projectEnvironmentSchema.parse(raw),stored=readCredentialSecret(config.stateDir,environment.credentialId);
  if(!stored.projectIds?.includes(projectId))throw new Error('The credential has not been granted to this project');
  if(stored.ready===false)throw new Error('Project credentials need authorization');
  const env:Record<string,string>=Object.create(null),secrets=Object.entries(stored.values).filter(([name])=>name!=='__expires_at').map(([,value])=>value);
  for(const [name,field]of Object.entries(environment.bindings)){const value=Object.hasOwn(stored.values,field)?stored.values[field]:undefined;if(!value)throw new Error('Project credential fields need configuration');if(field==='access_token'&&stored.values.__expires_at&&Date.parse(stored.values.__expires_at)<=Date.now())throw new Error('Project access token expired; authorize it before starting the service');env[name]=value;}
  return {env,secrets,revision:stored.revision??1,materialRevision:stored.materialRevision??stored.revision??1,redact:(value:unknown)=>redactSecrets(value,secrets)};
}
