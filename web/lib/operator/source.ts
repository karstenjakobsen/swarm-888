import type { components } from './api'
import type { OperatorMode } from './mode'
import type { OperatorEvent } from './types'

type API = components['schemas']
export type Action =
  | { kind: 'message'; text: string; taskId?: string; requestId?: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'decide'; requestId: string; optionId: string }
  | { kind: 'reset' }

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

export async function post(path: string, body: unknown) {
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

export function operatorSource(mode: OperatorMode) {
  return {
    async snapshot(signal: AbortSignal): Promise<Snapshot> {
      const response = await fetch('/api/snapshot', { cache: 'no-store', signal })
      if (!response.ok) throw new AccessError(response.status)
      if (mode === 'live') {
        const snapshot: API['Snapshot'] = await response.json()
        return { events: snapshot.events.map(liveEvent), cursor: snapshot.cursor, name: snapshot.profile.name }
      }
      const demo = await response.json()
      if (!demo.epoch) throw new Error('Expected a demo snapshot')
      return { events: demo.events, cursor: demo.cursor, epoch: demo.epoch, name: 'vps-fra-1 · kj.dev' }
    },
    subscribe(after: number, epoch: string | undefined, receive: (e: OperatorEvent) => void) {
      const params = new URLSearchParams({ after: String(after) })
      if (epoch) params.set('epoch', epoch)
      const stream = new EventSource('/api/events?' + params)
      stream.addEventListener('op', e => {
        const event = JSON.parse(e.data)
        receive(mode === 'live' ? liveEvent(event) : event)
      })
      return stream
    },
    async submit(action: Action) {
      if (mode === 'demo') return post('/api/commands', action)
      if (action.kind !== 'message' || action.taskId) throw new Error('Unsupported action')
      const command: API['OwnerMessage'] = {
        kind: 'message', text: action.text, requestId: action.requestId ?? crypto.randomUUID(),
      }
      const receipt: API['Receipt'] = await post('/api/commands', command)
      if (!receipt.taskId) throw new Error('Missing task receipt')
    },
  }
}
