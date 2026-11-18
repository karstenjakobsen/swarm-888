import type { ExecutionEvent } from './types';

export function RuntimeNotice({ events, active }: { events: ExecutionEvent[]; active: boolean }) {
  if (!active) return null;
  const notice = [...events].reverse().find(event => event.type === 'activity' && event.data.method === 'error');
  if (!notice) return null;
  const progressed = events.some(event => event.seq > notice.seq && (
    event.type === 'delta' || event.type === 'clarification' ||
    event.type === 'activity' && typeof event.data.method === 'string' &&
      (event.data.method.startsWith('item/') || event.data.method === 'turn/started')
  ));
  if (progressed) return null;
  const error = notice.data.error;
  if (!error || typeof error !== 'object' || !('message' in error) || typeof error.message !== 'string') return null;
  return <p className="management-warning" role="status" data-testid="runtime-notice"><strong>{notice.data.willRetry === true ? 'Runtime retry: ' : 'Runtime error: '}</strong>{error.message}</p>;
}
