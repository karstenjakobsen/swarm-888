import { DatabaseSync } from 'node:sqlite';
import { readdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';

/** Rebase native Codex location metadata only; preserve quoted history and user content verbatim. */
export function rebaseNativeState(runtimeDir:string,sourceStateDir:string,targetStateDir:string){
  let databases=0,transcripts=0;
  const rebase=(value:unknown)=>{
    if(typeof value!=='string'||!isAbsolute(value))return value;
    const rel=relative(sourceStateDir,value);
    return rel!== '..'&&!rel.startsWith('../')&&!isAbsolute(rel)?join(targetStateDir,rel):value;
  };
  const quote=(identifier:string)=>`"${identifier.replaceAll('"','""')}"`;
  function visit(directory:string){
    for(const entry of readdirSync(directory,{withFileTypes:true})){
      const file=join(directory,entry.name);
      if(entry.isSymbolicLink())continue;
      if(entry.isDirectory()){visit(file);continue;}
      if(!entry.isFile())continue;
      if(entry.name.endsWith('.sqlite')||entry.name.endsWith('.db')){
        const db=new DatabaseSync(file);
        try{
          db.exec('BEGIN IMMEDIATE');
          const tables=db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as Array<{name:string}>;
          for(const table of tables){
            const columns=db.prepare(`PRAGMA table_info(${quote(table.name)})`).all() as Array<{name:string}>;
            for(const column of columns)if(['rollout_path','cwd'].includes(column.name)||(table.name==='project_roots'&&column.name==='path')){
              const field=quote(column.name),root=sourceStateDir.replace(/\/$/,'');
              db.prepare(`UPDATE ${quote(table.name)} SET ${field}=? || substr(${field},?) WHERE ${field}=? OR substr(${field},1,?)=?`)
                .run(targetStateDir,root.length+1,root,root.length+1,root+'/');
            }
          }
          db.exec('COMMIT;PRAGMA wal_checkpoint(TRUNCATE);');databases++;
        }catch(error){try{db.exec('ROLLBACK');}catch{}throw error;}finally{db.close();}
      }else if(entry.name.endsWith('.jsonl')){
        const content=readFileSync(file,'utf8');let changed=false;
        const lines=content.split('\n').map(line=>{
          if(!line.trim())return line;
          let event:any;try{event=JSON.parse(line);}catch{throw new Error(`Invalid native session transcript: ${entry.name}`);}
          if(['session_meta','turn_context'].includes(event.type)&&event.payload&&typeof event.payload==='object'){
            const value=rebase(event.payload.cwd);
            if(value!==event.payload.cwd){event.payload.cwd=value;changed=true;return JSON.stringify(event);}
          }
          return line;
        });
        if(changed){
          const temp=file+'.restore-'+randomUUID();writeFileSync(temp,lines.join('\n'),{flag:'wx',mode:0o600});renameSync(temp,file);transcripts++;
        }
      }
    }
  }
  visit(runtimeDir);return{databases,transcripts};
}
