import { createCipheriv,createDecipheriv,randomBytes } from 'node:crypto';
import { constants,closeSync,fstatSync,fsyncSync,lstatSync,mkdirSync,openSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync } from 'node:fs';
import { join,resolve } from 'node:path';
import { z } from 'zod';
import type { OAuthConfiguration } from './schemas.ts';

export interface CredentialSecret {values:Record<string,string>;oauth?:OAuthConfiguration;connectorIds?:string[];projectIds?:string[];revision?:number;materialRevision?:number;ready?:boolean}
function privateFile(path:string):Buffer {
  const fd=openSync(path,constants.O_RDONLY|constants.O_NOFOLLOW);
  try{const info=fstatSync(fd);if(!info.isFile()||(info.mode&0o077)!==0||info.size>2_000_000)throw new Error('Credential storage permissions are invalid');return readFileSync(fd);}finally{closeSync(fd);}
}
function storage(stateDir:string){const parent=join(resolve(stateDir),'secrets');if(realpathSync(parent)!==parent)throw new Error('Credential storage must be canonical');const directory=join(parent,'credentials');mkdirSync(directory,{recursive:true,mode:0o700});if(realpathSync(directory)!==directory||!lstatSync(directory).isDirectory())throw new Error('Credential storage must be canonical');return {directory,key:join(parent,'credential-key')};}
function syncDirectory(path:string){const descriptor=openSync(path,constants.O_RDONLY);try{fsyncSync(descriptor);}finally{closeSync(descriptor);}}
function key(stateDir:string,create=false):Buffer {const path=storage(stateDir).key;if(create)try{writeFileSync(path,randomBytes(32),{flag:'wx',mode:0o600,flush:true});syncDirectory(join(resolve(stateDir),'secrets'));}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}const value=privateFile(path);if(value.length!==32)throw new Error('Invalid credential encryption key');return value;}
export function readCredentialSecret(stateDir:string,id:string):CredentialSecret {
  z.string().uuid().parse(id);const {directory}=storage(stateDir),raw=JSON.parse(privateFile(join(directory,`${id}.json`)).toString()),decipher=createDecipheriv('aes-256-gcm',key(stateDir),Buffer.from(raw.iv,'base64'));
  decipher.setAAD(Buffer.from(id));decipher.setAuthTag(Buffer.from(raw.tag,'base64'));return JSON.parse(Buffer.concat([decipher.update(Buffer.from(raw.data,'base64')),decipher.final()]).toString()) as CredentialSecret;
}
export function writeCredentialSecret(stateDir:string,id:string,secret:CredentialSecret):void {
  z.string().uuid().parse(id);const iv=randomBytes(12),cipher=createCipheriv('aes-256-gcm',key(stateDir,true),iv);cipher.setAAD(Buffer.from(id));const data=Buffer.concat([cipher.update(JSON.stringify(secret)),cipher.final()]);
  const target=join(storage(stateDir).directory,`${id}.json`),temporary=`${target}.${randomBytes(12).toString('hex')}`;
  try{writeFileSync(temporary,JSON.stringify({iv:iv.toString('base64'),tag:cipher.getAuthTag().toString('base64'),data:data.toString('base64')}),{flag:'wx',mode:0o600,flush:true});renameSync(temporary,target);syncDirectory(storage(stateDir).directory);}finally{rmSync(temporary,{force:true});}
}
export function removeCredentialSecret(stateDir:string,id:string){z.string().uuid().parse(id);rmSync(join(storage(stateDir).directory,`${id}.json`),{force:true});}
export function redactSecrets(value:unknown,secrets:string[]):any {
  if(typeof value==='string'){let text=value;for(const secret of [...new Set(secrets.filter(Boolean))].sort((a,b)=>b.length-a.length)){text=text.split(JSON.stringify(secret).slice(1,-1)).join('[REDACTED]');text=text.split(secret).join('[REDACTED]');}return text;}
  if(Array.isArray(value))return value.map(entry=>redactSecrets(entry,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([name,entry])=>[redactSecrets(name,secrets),redactSecrets(entry,secrets)]));return value;
}
