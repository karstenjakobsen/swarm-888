import { readFileSync, readdirSync } from 'node:fs';

export function processStamp(pid: number): string | null {
  try { const stat = readFileSync(`/proc/${pid}/stat`, 'utf8'); return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null; } catch { return null; }
}
export function bootId(): string { try { return readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim(); } catch { return 'unsupported'; } }
export function groupMembers(pid: number): Array<{ pid: number; sid: number; start: string }> {
  const members: Array<{ pid: number; sid: number; start: string }> = [];
  for (const name of readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    try { const stat = readFileSync(`/proc/${name}/stat`, 'utf8'); const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' '); if (Number(fields[2]) === pid && fields[0] !== 'Z') members.push({ pid: Number(name), sid: Number(fields[3]), start: fields[19]! }); } catch {}
  }
  return members;
}
export async function terminateGroup(pid: number): Promise<void> {
  const pause = (ms: number) => new Promise(resolveWait => setTimeout(resolveWait, ms));
  if (!groupMembers(pid).length) return;
  try { process.kill(-pid, 'SIGTERM'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; }
  for (let attempt = 0; attempt < 30 && groupMembers(pid).length; attempt++) await pause(100);
  if (groupMembers(pid).length) { try { process.kill(-pid, 'SIGKILL'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error; } }
  for (let attempt = 0; attempt < 10 && groupMembers(pid).length; attempt++) await pause(100);
  if (groupMembers(pid).length) throw new Error('Owned process group did not terminate; execution remains uncertain');
}
