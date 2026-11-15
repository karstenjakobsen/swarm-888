// fd3 is a private launch/liveness channel. stdin remains untouched for MCP.
import { spawn } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { Socket } from 'node:net';
const control=new Socket({fd:3,readable:true,writable:false});
let buffer='',launched=false,exitCode=null,terminating=false,watcher;
function members(){
  const result=[];
  for(const name of readdirSync('/proc')){
    if(!/^\d+$/.test(name)||Number(name)===process.pid)continue;
    try{const value=readFileSync(`/proc/${name}/stat`,'utf8'),fields=value.slice(value.lastIndexOf(')')+2).split(' ');if(Number(fields[2])===process.pid&&fields[0]!=='Z')result.push(Number(name));}catch{}
  }
  return result;
}
function poll(){if(!members().length&&exitCode!==null)process.exit(exitCode);}
function watch(){watcher??=setInterval(poll,50);poll();}
function terminate(){
  if(terminating)return;terminating=true;
  if(!launched)process.exit(0);
  try{process.kill(-process.pid,'SIGTERM');}catch{}
  setTimeout(()=>{try{process.kill(-process.pid,'SIGKILL');}catch{}},1000);
  watch();
}
// Keep the recorded supervisor identity alive until its group is empty.
process.on('SIGTERM',terminate);process.on('SIGINT',terminate);
control.on('data',chunk=>{
  if(launched)return;buffer+=chunk.toString();if(Buffer.byteLength(buffer)>2*1024*1024)process.exit(125);
  const end=buffer.indexOf('\n');if(end<0)return;
  let input;try{input=JSON.parse(buffer.slice(0,end));if(typeof input.command!=='string'||!Array.isArray(input.args)||input.args.some(value=>typeof value!=='string'))throw new Error('Invalid launch');}catch{process.exit(125);}
  launched=true;buffer='';
  const child=spawn(input.command,input.args,{stdio:['inherit','inherit','inherit'],detached:false});
  child.once('error',()=>{exitCode=127;watch();});
  child.once('exit',(code,signal)=>{exitCode=code??(signal?128:1);watch();});
});
control.on('end',terminate);control.on('error',terminate);
