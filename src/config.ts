import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync, statSync, lstatSync, realpathSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join, isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
export interface Config {
  stateDir: string; socketPath: string; bridgeSocket: string; ipcToken: string;
  controllerUid: number; codexBin: string; runtimeHome: string; model?: string;
  host: string; port: number; origins: string[]; adminPassword: string;
  secureCookie: boolean; improvementEnabled: boolean; improvementTimeoutMs: number;
  improvementMaxTurns: number; allowTempState: boolean;
  requireRootWorker?: boolean;
  protectOperator?: boolean;
  executionUid?: number; executionGid?: number;
  executionUser?: string;
  projectsDir?: string; executionHome?: string;
}

function integer(value: string | undefined, fallback: number, min: number, max: number): number {
  const n = value === undefined ? fallback : Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`Expected integer ${min}..${max}, received ${value}`);
  return n;
}

function containsPath(root:string,path:string):boolean {
  const rel=relative(resolve(root),resolve(path));
  return rel===''||(!isAbsolute(rel)&&rel!=='..'&&!rel.startsWith(`..${sep}`));
}

/** Resolve a local dedicated account without preventing the controller from opening before setup. */
export function resolveExecutionIdentity(env:NodeJS.ProcessEnv,controllerUid:number,accounts=readFileSync('/etc/passwd','utf8')):{executionUser?:string;executionUid?:number;executionGid?:number} {
  const executionUser=env.APP_EXECUTION_USER??(env.APP_EXECUTION_UID===undefined&&env.APP_EXECUTION_GID===undefined?'vps-ai-projects':undefined);
  if(executionUser!==undefined&&!/^[a-z_][a-z0-9_-]{0,31}$/.test(executionUser))throw new Error('APP_EXECUTION_USER must be a valid local account name');
  let executionUid=env.APP_EXECUTION_UID===undefined?undefined:integer(env.APP_EXECUTION_UID,0,1,2**31-1);
  let executionGid=env.APP_EXECUTION_GID===undefined?undefined:integer(env.APP_EXECUTION_GID,0,1,2**31-1);
  if(executionUid===controllerUid)throw new Error('APP_EXECUTION_UID must differ from the controller UID so agents cannot modify operator releases');
  if((executionUid===undefined)!==(executionGid===undefined))throw new Error('Set APP_EXECUTION_UID and APP_EXECUTION_GID together, or use APP_EXECUTION_USER for a dedicated account');
  const account=executionUser?accounts.split('\n').map(line=>line.split(':')).find(fields=>fields[0]===executionUser):undefined;
  if(account){
    const uid=integer(account[2],0,1,2**31-1),gid=integer(account[3],0,1,2**31-1);
    if(executionUid!==undefined&&(executionUid!==uid||executionGid!==gid))throw new Error(`APP_EXECUTION_UID/GID do not match the local account ${executionUser}`);
    executionUid=uid;executionGid=gid;
  }else if(executionUser&&executionUid!==undefined)throw new Error(`APP_EXECUTION_USER ${executionUser} is not an existing local account; remove the name to configure both numeric IDs explicitly`);
  if(executionUid===controllerUid)throw new Error('APP_EXECUTION_USER must differ from the controller account so agents cannot modify operator releases');
  return {executionUser,executionUid,executionGid};
}

export function loadConfig(options: {requireAdmin?: boolean} = {}): Config {
  if(Number(process.versions.node.split('.')[0])!==26)throw new Error(`Node 26 LTS is required; running ${process.versions.node}. Use npm scripts after npm ci or select .nvmrc.`);
  const stateDir = process.env.APP_STATE_DIR ?? join(homedir(), '.local/share/vps-ai-operator');
  if (!isAbsolute(stateDir)) throw new Error('APP_STATE_DIR must be absolute');
  const normalized = resolve(stateDir);
  const allowTempState = process.env.APP_ALLOW_TEMP_STATE === 'true';
  if (!allowTempState && (normalized === '/tmp' || normalized.startsWith('/tmp/') || normalized === '/var/tmp' || normalized.startsWith('/var/tmp/'))) {
    throw new Error('APP_STATE_DIR must be persistent, outside /tmp. Tests may explicitly set APP_ALLOW_TEMP_STATE=true.');
  }
  if (containsPath(projectRoot,normalized)||containsPath(normalized,projectRoot)) {
    throw new Error('APP_STATE_DIR must be outside the source checkout and build output');
  }
  const controllerUid = integer(process.env.APP_CONTROLLER_UID, process.getuid?.() ?? 0, 0, 2 ** 31 - 1);
  const protectOperator=process.env.APP_PROTECT_OPERATOR!=='false';
  if(!protectOperator&&!allowTempState)throw new Error('Operator protection can only be disabled in explicit temporary test state');
  const {executionUser,executionUid,executionGid}=protectOperator?resolveExecutionIdentity(process.env,controllerUid):{
    executionUser:process.env.APP_EXECUTION_USER,
    executionUid:process.env.APP_EXECUTION_UID===undefined?undefined:integer(process.env.APP_EXECUTION_UID,0,1,2**31-1),
    executionGid:process.env.APP_EXECUTION_GID===undefined?undefined:integer(process.env.APP_EXECUTION_GID,0,1,2**31-1),
  };
  function externalDirectory(value:string,label:string):string {
    if(!isAbsolute(value))throw new Error(`${label} must be absolute`);
    const directory=resolve(value);
    if(containsPath(projectRoot,directory)||containsPath(directory,projectRoot)||containsPath(normalized,directory)||containsPath(directory,normalized))throw new Error(`${label} must be separate from the operator source and controller state directories`);
    if(!allowTempState&&(directory==='/tmp'||directory.startsWith('/tmp/')||directory==='/var/tmp'||directory.startsWith('/var/tmp/')))throw new Error(`${label} must be persistent, outside temporary directories`);
    return directory;
  }
  const projectsDir=protectOperator?externalDirectory(process.env.APP_PROJECTS_DIR??'/srv/vps-ai-projects','APP_PROJECTS_DIR'):join(normalized,'projects');
  const executionHome=protectOperator?externalDirectory(process.env.APP_EXECUTION_HOME??'/var/lib/vps-ai-executor','APP_EXECUTION_HOME'):join(normalized,'runtime');
  if(protectOperator&&(containsPath(projectsDir,executionHome)||containsPath(executionHome,projectsDir)))throw new Error('APP_PROJECTS_DIR and APP_EXECUTION_HOME must be separate directories');
  const origins=(process.env.APP_ORIGINS ?? process.env.APP_ORIGIN ?? 'http://localhost:5173,http://127.0.0.1:5173').split(',').map(s => {
    const url=new URL(s.trim());
    if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw new Error('APP_ORIGIN(S) must contain HTTP(S) browser origins without credentials');
    return url.origin;
  });
  const adminPassword = process.env.ADMIN_PASSWORD ?? '';
  if (options.requireAdmin && adminPassword.length < 12) throw new Error('Set ADMIN_PASSWORD to a unique credential of at least 12 characters in .env');
  const config: Config = {
    stateDir: normalized, socketPath: join(normalized, 'worker.sock'), bridgeSocket: join(normalized, 'bridge.sock'), ipcToken: '',
    controllerUid, codexBin: process.env.CODEX_BIN ?? join(projectRoot, 'node_modules/.bin/codex'), runtimeHome: protectOperator?join(executionHome,'codex'):join(normalized,'runtime'),
    model: process.env.CODEX_MODEL || undefined, host: process.env.APP_HOST ?? '127.0.0.1',
    port: integer(process.env.APP_PORT, 3001, 1, 65535),
    origins,
    adminPassword, secureCookie: process.env.APP_SECURE_COOKIE === 'true'||origins.some(origin=>origin.startsWith('https://')),
    improvementEnabled: process.env.APP_IMPROVEMENT_ENABLED !== 'false',
    improvementTimeoutMs: integer(process.env.APP_IMPROVEMENT_TIMEOUT_MS, 90_000, 1000, 600_000),
    improvementMaxTurns: integer(process.env.APP_IMPROVEMENT_MAX_TURNS, 3, 1, 10), allowTempState,
    requireRootWorker:protectOperator||process.env.APP_REQUIRE_ROOT_WORKER!=='false',
    protectOperator,executionUser,executionUid,executionGid,projectsDir,executionHome,
  };
  initState(config);
  return config;
}

export function initState(config: Config): void {
  process.umask(0o077);
  try { mkdirSync(config.stateDir, { recursive: true, mode: 0o700 }); }
  catch (error) {
    const code=(error as NodeJS.ErrnoException).code;
    if(code!=='EACCES'&&code!=='EPERM')throw error;
    throw Object.assign(new Error(`Cannot create APP_STATE_DIR ${config.stateDir}: permission denied. Initialize a writable persistent directory as the normal controller user with npm run init. Launch the worker with the exact command from Connect agent, which includes APP_STATE_DIR and APP_CONTROLLER_UID; plain sudo npm run worker can select /root instead.`,{cause:error}),{code});
  }
  const info = statSync(config.stateDir);
  if (realpathSync(config.stateDir) !== config.stateDir) throw new Error('APP_STATE_DIR must be a canonical path without symlinks');
  if (info.uid !== config.controllerUid) throw new Error(`State directory belongs to UID ${info.uid}; expected controller UID ${config.controllerUid}. Initialize it as the controller user first.`);
  if ((info.mode & 0o077) !== 0) throw new Error('APP_STATE_DIR must have mode 0700 (chmod 700 the directory)');
  for (const dir of ['secrets', 'runtime', 'skills', 'workspaces', 'artifacts', 'worker']) {
    const path = join(config.stateDir, dir);
    mkdirSync(path, {recursive:true, mode:0o700});
    const subdir=lstatSync(path);
    if(subdir.isSymbolicLink()||!subdir.isDirectory()||realpathSync(path)!==path)throw new Error(`State subdirectory must be a real canonical directory, not a symlink: ${path}`);
    if (subdir.uid !== config.controllerUid && process.getuid?.() !== 0) throw new Error(`Incorrect owner of ${path}; restore controller ownership before starting.`);
  }
  const tokenPath = join(config.stateDir, 'secrets/ipc-token');
  try { writeFileSync(tokenPath, randomBytes(32).toString('hex'), { flag:'wx', mode:0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const secretInfo = lstatSync(tokenPath);
  if (!secretInfo.isFile()||secretInfo.isSymbolicLink()||(secretInfo.mode & 0o077) !== 0 || secretInfo.uid !== config.controllerUid) throw new Error('IPC secret must be a regular file owned by the controller UID with mode 0600');
  config.ipcToken = readFileSync(tokenPath, 'utf8').trim();
  if (!/^[0-9a-f]{64}$/.test(config.ipcToken)) throw new Error('Invalid IPC secret file');
  chmodSync(config.stateDir, 0o700);
}
