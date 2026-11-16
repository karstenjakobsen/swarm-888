import { z } from 'zod';

export const credentialField=z.string().regex(/^[A-Za-z_][A-Za-z0-9_.-]{0,99}$/).refine(value=>!value.startsWith('__'),'Reserved credential field');
export const credentialSecretValue=z.string().min(8,'Credential values must contain at least 8 characters').max(32_000).refine(value=>!value.includes('\0'));
export const credentialValues=z.preprocess((value,context)=>{if(value&&typeof value==='object'&&Object.hasOwn(value,'__proto__'))context.addIssue({code:'custom',message:'Reserved credential field'});return value;},z.record(credentialField,credentialSecretValue)).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=40);
export const credentialCreate=z.object({name:z.string().trim().min(1).max(120),values:credentialValues}).strict();
export const credentialUpdate=z.object({values:credentialValues}).strict();
const identity={credentialId:z.string().uuid()};
const header=z.string().regex(/^[A-Za-z0-9-]{1,100}$/).refine(value=>!['host','content-length','connection','cookie','set-cookie','mcp-session-id','mcp-protocol-version','content-type','accept'].includes(value.toLowerCase()),'Reserved transport header');
const environment=z.string().regex(/^[A-Z_][A-Z0-9_]{0,99}$/).refine(value=>!['PATH','HOME','NODE_OPTIONS','NODE_PATH','LD_PRELOAD','LD_LIBRARY_PATH','CODEX_HOME','APP_STATE_DIR','APP_BRIDGE_TOKEN','ADMIN_PASSWORD'].includes(value)&&!value.startsWith('OPERATOR_'),'Reserved process environment');
export const projectEnvironmentSchema=z.object({...identity,bindings:z.record(environment,credentialField).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=20)}).strict();
export type ProjectEnvironment=z.infer<typeof projectEnvironmentSchema>;
export const connectorAuthSchema=z.discriminatedUnion('type',[
  z.object({...identity,type:z.literal('bearer'),field:credentialField.default('token')}).strict(),
  z.object({...identity,type:z.literal('headers'),bindings:z.record(header,credentialField).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=20)}).strict(),
  z.object({...identity,type:z.literal('env'),bindings:z.record(environment,credentialField).refine(value=>Object.keys(value).length>0&&Object.keys(value).length<=20)}).strict(),
  z.object({...identity,type:z.literal('oauth2')}).strict(),
]);
export type ConnectorAuth=z.infer<typeof connectorAuthSchema>;
export interface CredentialMetadata {id:string;name:string;kind:'secret'|'oauth2';fields:string[];revision:number;ready:boolean;expiresAt:string|null;updatedAt:string}
export const oauthEndpoint=z.string().url().max(2000).refine(value=>{const url=new URL(value);return !url.username&&!url.password&&!url.hash&&!url.search&&(url.protocol==='https:'||url.protocol==='http:'&&['localhost','127.0.0.1','[::1]'].includes(url.hostname));},'Use an HTTPS endpoint without query parameters, or a loopback HTTP fixture endpoint');
export const oauthTokenFields=z.object({accessToken:credentialField.default('access_token'),refreshToken:credentialField.default('refresh_token'),expiresIn:credentialField.default('expires_in')}).strict();
export const oauthStart=z.object({name:z.string().min(1).max(120).optional(),authorizationUrl:oauthEndpoint,tokenUrl:oauthEndpoint,clientId:z.string().min(1).max(1000),clientSecret:credentialSecretValue.optional(),scopes:z.array(z.string().min(1).max(200)).max(30).default([]),tokenAuthMethod:z.enum(['none','client_secret_post','client_secret_basic']).default('none'),tokenMethod:z.enum(['POST','GET']).default('POST'),tokenFields:oauthTokenFields.default({accessToken:'access_token',refreshToken:'refresh_token',expiresIn:'expires_in'})}).strict().refine(value=>value.tokenAuthMethod==='none'||Boolean(value.clientSecret),'Client authentication requires a client secret');
export type OAuthConfiguration=Omit<z.infer<typeof oauthStart>,'name'|'clientSecret'>&{redirectUri:string};
