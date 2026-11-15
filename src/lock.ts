import { readFileSync, writeFileSync, unlinkSync, existsSync } from 'node:fs';

function identity(pid:number):string|null {
  try {const stat=readFileSync(`/proc/${pid}/stat`,'utf8');return stat.slice(stat.lastIndexOf(')')+2).split(' ')[19]??null;}catch{return null;}
}
export function lockAlive(path:string):boolean {
  try {const record=JSON.parse(readFileSync(path,'utf8'));return Boolean(record.pid&&identity(record.pid)===record.start);}catch{return false;}
}
export function acquireLock(path:string):()=>void {
  if(existsSync(path)){if(lockAlive(path))throw new Error(`Another process owns ${path}`);unlinkSync(path);}
  const record={pid:process.pid,start:identity(process.pid)};
  writeFileSync(path,JSON.stringify(record),{flag:'wx',mode:0o600});
  return ()=>{try{const value=JSON.parse(readFileSync(path,'utf8'));if(value.pid===process.pid&&value.start===record.start)unlinkSync(path);}catch{}};
}
