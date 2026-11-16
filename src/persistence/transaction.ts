import type { DatabaseSync } from 'node:sqlite';

let sequence=0;

/** Keep nested store writes atomic without committing the caller's transaction. */
export function transaction<T>(db:DatabaseSync,action:()=>T):T {
  const nested=db.isTransaction,name=`operator_${++sequence}`;
  db.exec(nested?`SAVEPOINT ${name}`:'BEGIN IMMEDIATE');
  try{const value=action();db.exec(nested?`RELEASE ${name}`:'COMMIT');return value;}
  catch(error){db.exec(nested?`ROLLBACK TO ${name}`:'ROLLBACK');if(nested)db.exec(`RELEASE ${name}`);throw error;}
}
