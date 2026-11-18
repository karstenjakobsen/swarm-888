// Reserve idle workers before changing shared code, configuration, or services.
// No runs, authentication material, IPC tokens, or process environments are printed.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const [checkout, action, rootId = 'root', expectedIds = `default,${rootId}`] = process.argv.slice(2);
if (!checkout || !['reserve', 'release', 'health'].includes(action)) {
  throw new Error('Usage: worker-maintenance.mjs CHECKOUT reserve|release|health ROOT_ID');
}
const source = name => pathToFileURL(join(checkout, 'src', name)).href;
const { loadConfig } = await import(source('config.ts'));
const { WorkerClient } = await import(source('ipc.ts'));
const { ownWorkerConfig, workerDirectory } = await import(source('workers/config.ts'));
const { workerManifests } = await import(source('workers/manifest.ts'));
const { processStamp } = await import(source('runtime/processes.ts'));
const base = loadConfig();
const workers = [
  { id: 'default', config: base },
  ...workerManifests(base).map(record => ({ id: record.id, config: ownWorkerConfig(base, record) })),
];
const reserved = [];
const pendingHealth = new Set(expectedIds.split(',').filter(Boolean));
function checkStartingWorker(id, config) {
  const lock = join(workerDirectory(config), 'lock.json');
  if (action !== 'reserve' || !existsSync(lock)) return;
  const { pid, start } = JSON.parse(readFileSync(lock, 'utf8'));
  if (start && processStamp(pid) === start) {
    throw new Error(`Worker ${id} is running without a responding socket. Retry after it starts.`);
  }
}
async function release() {
  for (const client of reserved) {
    try { await client.request('worker/release-root-replacement', {}); } catch { /* Stopped workers release their reservation. */ }
  }
}
try {
  for (const { id, config } of workers) {
    if (action === 'health' && !pendingHealth.has(id)) continue;
    if (!existsSync(config.socketPath)) {
      checkStartingWorker(id, config);
      continue;
    }
    const client = new WorkerClient(config);
    try {
      let health;
      try { health = await client.connect(); }
      catch (error) {
        if (error.code !== 'ECONNREFUSED') throw error;
        checkStartingWorker(id, config);
        continue;
      }
      if (action === 'reserve') {
        const unit = id === 'default' ? 'swarm-888-worker.service' : id === rootId ? 'swarm-888-root-worker.service' : null;
        if (!unit || !readFileSync(`/proc/${health.pid}/cgroup`, 'utf8').split('\n').some(line => line.endsWith(`/${unit}`))) {
          throw new Error(`Worker ${id} runs outside the managed services. Stop it before changing this installation.`);
        }
        await client.request('worker/reserve-root-replacement', {});
        reserved.push(client);
      } else if (action === 'release') {
        await client.request('worker/release-root-replacement', {});
      } else {
        await client.request('agent/status', {});
        health = await client.connect();
        const correctIdentity = id === rootId
          ? health.root && health.uid === 0 && health.executionUid === 0
          : !health.root && health.uid === base.controllerUid && health.executionUid === base.controllerUid;
        if (!health.runtime.available || !correctIdentity) {
          throw new Error(`Worker ${id} is not healthy: ${health.runtime.detail}`);
        }
        pendingHealth.delete(id);
        console.log(JSON.stringify({ id, uid: health.uid, authenticated: health.runtime.authenticated, model: health.model }));
      }
    } finally {
      if (!reserved.includes(client)) client.close();
    }
  }
  if (action === 'health' && pendingHealth.size) {
    throw new Error(`Required workers did not respond: ${[...pendingHealth].join(', ')}`);
  }
} catch (error) {
  await release();
  throw error;
} finally {
  for (const client of reserved) client.close();
}
