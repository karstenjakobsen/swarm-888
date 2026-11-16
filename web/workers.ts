import type { WorkerStatus } from '../src/workers/schemas';

export function workerState(status: WorkerStatus): string {
  if (!status.worker.enabled) return 'Disabled';
  if (status.worker.draining) return 'Draining';
  if (status.error) return 'Needs attention';
  if (!status.connected || !status.health) return 'Offline';
  if (status.health.uncertainRuns?.length || status.health.runtimeOperations?.some(operation => operation.status === 'uncertain')) return 'Needs inspection';
  if (!status.health.runtime.available) return 'Runtime unavailable';
  if (status.health.runtime.authenticating) return 'Signing in';
  if (!status.health.runtime.authenticated) return 'Sign-in required';
  if (status.health.replacementReserved) return 'Restart reserved';
  if (status.health.activeRunId || status.health.runtimeOperations?.length) return 'Busy';
  return 'Ready';
}

export const isWorkerReady = (status: WorkerStatus) => workerState(status) === 'Ready';
