import type { components } from './api'
import type { OperatorMode } from './mode'
import type { OperatorEvent, OwnerAction } from './types'

type API = components['schemas']
type Snapshot = { events: OperatorEvent[]; cursor: number; epoch?: string; name: string }
export class AccessError extends Error {
  constructor(readonly status: number, message = 'Operator request failed') {
    super(message)
  }
}

function liveEvent(e: API['Event']): OperatorEvent {
  const meta = { seq: e.seq, at: e.at, ref: { task: e.task }, outcome: e.outcome }
  switch (e.kind) {
    case 'received': return { ...meta, type: 'task.received', data: { title: e.text, source: 'owner' } }
    case 'owner_message': return { ...meta, type: 'owner.message', data: { text: e.text, intent: 'ask' } }
    case 'started': return { ...meta, type: 'task.step', data: { summary: e.text } }
    case 'answered': return { ...meta, type: 'task.answered', data: { text: e.text } }
    case 'completed': return { ...meta, type: 'task.completed', data: { summary: e.text } }
  }
}

async function post(path: string, body: unknown) {
  const response = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Operator-Action': '1' },
    body: JSON.stringify(body), cache: 'no-store',
  })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new AccessError(response.status, error?.error ?? error?.detail ?? 'Operator unavailable')
  }
  if (response.status !== 204) return response.json()
}

export async function signIn(key: string) {
  await post('/api/session', { key } satisfies API['OwnerLogin'])
}

// Keep the retry ID through an outage or a reload in this tab. Store only a
// digest of the message. Acknowledgment releases the ID for a new submission.
async function messageKey(text: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return 'operator.pending.' + Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('')
}

type StreamHandlers = {
  event: (event: OperatorEvent) => void
  reset: () => void
  caughtUp: () => void
}

export function operatorSource(mode: OperatorMode) {
  const pending = new Map<string, string>()
  return {
    async snapshot(signal: AbortSignal): Promise<Snapshot> {
      const response = await fetch('/api/snapshot', { cache: 'no-store', signal })
      if (!response.ok) throw new AccessError(response.status)
      if (mode === 'live') {
        const snapshot: API['Snapshot'] = await response.json()
        return { events: snapshot.events.map(liveEvent), cursor: snapshot.cursor, epoch: snapshot.profile.id, name: snapshot.profile.name }
      }
      const demo = await response.json()
      if (!demo.epoch) throw new Error('Expected a demo snapshot')
      return { events: demo.events, cursor: demo.cursor, epoch: demo.epoch, name: 'vps-fra-1 · kj.dev' }
    },
    async checkSession(signal: AbortSignal) {
      if (mode !== 'live') return
      const response = await fetch('/api/session', { cache: 'no-store', signal })
      if (!response.ok) throw new AccessError(response.status)
    },
    subscribe(after: number, epoch: string | undefined, handlers: StreamHandlers) {
      const params = new URLSearchParams({ after: String(after) })
      if (epoch) params.set('epoch', epoch)
      const stream = new EventSource('/api/events?' + params)
      stream.addEventListener('op', e => {
        const event = JSON.parse(e.data)
        handlers.event(mode === 'live' ? liveEvent(event) : event)
      })
      stream.addEventListener('hello', e => {
        if (epoch && JSON.parse(e.data).epoch !== epoch) handlers.reset()
      })
      stream.addEventListener('reset', handlers.reset)
      stream.addEventListener('caught-up', handlers.caughtUp)
      return stream
    },
    async submit(action: OwnerAction) {
      if (mode === 'demo') return post('/api/commands', action)
      if (action.kind !== 'message' || action.taskId) throw new Error('Unsupported action')

      const key = await messageKey(action.text)
      let requestId = pending.get(key) ?? crypto.randomUUID()
      try {
        requestId = sessionStorage.getItem(key) ?? requestId
        sessionStorage.setItem(key, requestId)
      } catch {
        // Browsers with storage disabled can still retry while this page is open.
      }
      pending.set(key, requestId)
      const command: API['OwnerMessage'] = { kind: 'message', text: action.text, requestId }
      const receipt: API['Receipt'] = await post('/api/commands', command)
      if (!receipt.taskId) throw new Error('Missing task receipt')
      if (pending.get(key) === requestId) pending.delete(key)
      try {
        if (sessionStorage.getItem(key) === requestId) sessionStorage.removeItem(key)
      } catch { /* Storage may be disabled. */ }
    },
    async applyDemoCredential(requestId: string) {
      if (mode !== 'demo') throw new Error('Demo credentials require demo mode')
      await post('/api/secrets', { requestId })
    },
  }
}
