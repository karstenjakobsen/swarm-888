import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { projectRoot, loadConfig } from '../src/config.ts';

if(process.getuid?.()===0)throw new Error('Run npm run dev as a normal user. Only the separately launched worker should be root.');
const config=loadConfig({requireAdmin:true});
const children=[
  spawn(process.execPath,['--import','tsx','src/controller.ts'],{cwd:projectRoot,stdio:'inherit',env:process.env}),
  spawn(process.execPath,[resolve(projectRoot,'node_modules/vite/bin/vite.js')],{cwd:projectRoot,stdio:'inherit',env:{...process.env,VITE_API_TARGET:process.env.VITE_API_TARGET??`http://${config.host.includes(':')?'['+config.host+']':config.host}:${config.port}`}}),
];
let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const child of children)child.kill('SIGTERM');}
for(const child of children){child.on('error',error=>{console.error(error.message);process.exitCode=1;stop();});child.on('exit',code=>{if(!stopping){process.exitCode=code??1;stop();}});}
process.once('SIGINT',stop);process.once('SIGTERM',stop);
