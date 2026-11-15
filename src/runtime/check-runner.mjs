// A private child-process handshake: no helper can execute before the worker has
// durably recorded this session's PID/start identity and sends its first message.
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

let launched = false;
let finished = false;
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  if (launched) return;
  let command;
  try {
    command = JSON.parse(line);
    if (line.length > 1_000_000 || typeof command.command !== 'string' || !Array.isArray(command.args) || command.args.some(value => typeof value !== 'string')) throw new Error('Invalid check-runner invocation');
  } catch { process.exit(125); }
  launched = true;
  // Inherit this already journaled process group; the worker can terminate the
  // entire helper tree even when the immediate helper exits before descendants.
  const child = spawn(command.command, command.args, { stdio: ['ignore', 'inherit', 'inherit'], detached: false });
  child.once('error', () => { finished = true; process.exit(127); });
  child.once('close', (code, signal) => { finished = true; process.exit(code ?? (signal ? 128 : 1)); });
});
lines.on('close', () => {
  if (!launched || finished) process.exit(0);
  // A worker crash closes stdin. Journal reconciliation still records uncertainty,
  // while this best-effort termination prevents abandoned fixture work continuing.
  try { process.kill(-process.pid, 'SIGTERM'); } catch { process.exit(1); }
});
