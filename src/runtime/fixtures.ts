import { spawn, spawnSync } from 'node:child_process';
import { chownSync, cpSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { z } from 'zod';
import { checkSkillSchema } from '../ipc.js';
import { terminateGroup } from './processes.js';
import type { Config } from '../config.ts';
import { executionCommand, executionEnvironment, trustedExecutionDirectory } from './protection.ts';

function within(root: string, path: string): string {
  if (isAbsolute(path)) throw new Error('Fixture paths must be relative');
  const absolute = resolve(root, path); const rel = relative(root, absolute);
  if (rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Fixture path leaves temporary directory');
  return absolute;
}

function compareProtectedOutputs(config:Config,fixture:string,expected:Record<string,string>):void {
  const script=`const fs=require('node:fs'),path=require('node:path');const input=JSON.parse(fs.readFileSync(0,'utf8'));for(const [name,expected] of Object.entries(input.expected)){const file=path.resolve(input.root,name),rel=path.relative(input.root,file);if(!rel||rel==='..'||rel.startsWith('..'+path.sep)||path.isAbsolute(rel)||fs.realpathSync(file)!==file)throw new Error('Output must be a canonical fixture file');const fd=fs.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW|fs.constants.O_NONBLOCK);try{const info=fs.fstatSync(fd),actual=fs.readlinkSync('/proc/self/fd/'+fd);if(!info.isFile()||info.uid!==process.getuid()||actual!==file)throw new Error('Output must be an execution-owned regular fixture file');const size=Buffer.byteLength(expected),buffer=Buffer.alloc(size+1);let total=0,n;while(total<buffer.length&&(n=fs.readSync(fd,buffer,total,buffer.length-total,null))>0)total+=n;if(total!==size||buffer.subarray(0,total).toString()!==expected)throw new Error('Output did not match the expected fixture result');}finally{fs.closeSync(fd);}}console.log('matched');`;
  const invocation=executionCommand(config,process.execPath,['-e',script]);
  const result=spawnSync(invocation.command,invocation.args,{input:JSON.stringify({root:fixture,expected}),env:executionEnvironment(config),encoding:'utf8',timeout:5000,maxBuffer:2000});
  if(result.error||result.status!==0||result.stdout.trim()!=='matched')throw new Error('Representative output did not match or could not be read safely by the execution account.');
}
export async function checkSkill(stateDir: string, input: z.infer<typeof checkSkillSchema>, hooks?: { spawned: (pid: number) => void;config?:Config }) {
  const config=hooks?.config;
  const parent = config?.protectOperator?trustedExecutionDirectory(config,'checks'):resolve(stateDir, 'workspaces/checks'); mkdirSync(parent, { recursive: true, mode:config?.protectOperator?0o711:0o700 });
  const checks: Array<{ name: string; exitCode: number | null; stdout: string; stderr: string; passed: boolean; error?: string; durationMs: number }> = [];
  for (const check of input.checks) {
    const started = Date.now(); const fixture = mkdtempSync(resolve(parent, 'fixture-')); const skill = resolve(fixture, 'skill');
    let stdout = ''; let stderr = ''; let exitCode: number | null = null; let error: string | undefined;
    let childPid: number | undefined;
    try {
      cpSync(input.candidatePath, skill, { recursive: true, dereference: false, errorOnExist: true });
      for (const [name, content] of Object.entries(check.fixtures)) { const path = within(fixture, name); mkdirSync(resolve(path, '..'), { recursive: true }); writeFileSync(path, content); }
      if(config?.protectOperator){
        const assign=(path:string)=>{const info=lstatSync(path);if(info.isSymbolicLink())throw new Error('Protected fixture packages cannot contain symlinks');if(info.isDirectory())for(const name of readdirSync(path))assign(resolve(path,name));chownSync(path,config.executionUid!,config.executionGid!);};
        assign(fixture);
      }
      const replace = (arg: string) => arg.replaceAll('{skill}', skill).replaceAll('{fixture}', fixture);
      await new Promise<void>((finish, reject) => {
        const invocation=config?executionCommand(config,process.execPath,[fileURLToPath(new URL('./check-runner.mjs',import.meta.url))]):{command:process.execPath,args:[fileURLToPath(new URL('./check-runner.mjs',import.meta.url))]};
        const child = spawn(invocation.command, invocation.args, { cwd: fixture,env:config?executionEnvironment(config):process.env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
        childPid = child.pid;
        if (childPid) hooks?.spawned(childPid);
        // The runner blocks until PID/start/boot is committed by the hook above.
        child.stdin.write(JSON.stringify({ command: replace(check.command), args: check.args.map(replace) }) + '\n');
        child.stdin.on('error', () => {});
        const timer = setTimeout(() => { error = 'Representative check timed out'; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }, check.timeoutMs ?? 15_000);
        let overflow = false;
        const capture = (which: 'stdout' | 'stderr', data: Buffer) => {
          if (which === 'stdout') stdout += data.toString(); else stderr += data.toString();
          if (stdout.length + stderr.length > 512_000 && !overflow) { overflow = true; error = 'Representative check output exceeded 512 kB'; try { process.kill(-child.pid!, 'SIGKILL'); } catch {} }
        };
        child.stdout.on('data', data => capture('stdout', data)); child.stderr.on('data', data => capture('stderr', data));
        child.once('error', err => { clearTimeout(timer); reject(err); });
        child.once('close', code => { clearTimeout(timer); exitCode = code; finish(); });
      });
      if (exitCode !== 0) error ??= `Helper exited with code ${exitCode}`;
      if (check.expectedStdout !== undefined && stdout !== check.expectedStdout) error ??= 'stdout did not match the expected fixture result';
      if(config?.protectOperator)compareProtectedOutputs(config,fixture,check.expectedFiles??{});
      else for (const [path, expected] of Object.entries(check.expectedFiles ?? {})) {
        const output=within(fixture,path),canonical=realpathSync(output),rel=relative(fixture,canonical);
        if(rel==='..'||rel.startsWith(`..${sep}`)||canonical!==output||!lstatSync(output).isFile())throw new Error('Representative output must be a canonical regular fixture file');
        if(readFileSync(output,'utf8')!==expected)error??=`Output ${path} did not match the expected fixture result`;
      }
    } catch (err) { error = err instanceof Error ? err.message : String(err); }
    finally { if (childPid) await terminateGroup(childPid); rmSync(fixture, { recursive: true, force: true }); }
    checks.push({ name: check.name, exitCode, stdout: stdout.slice(0, 256_000), stderr: stderr.slice(0, 256_000), passed: !error && exitCode === 0, ...(error ? { error } : {}), durationMs: Date.now() - started });
  }
  return { passed: checks.every(check => check.passed), checks, workerUid:config?.protectOperator?config.executionUid!:process.getuid?.() ?? -1, checkedAt: new Date().toISOString() };
}
