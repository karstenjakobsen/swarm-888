import type { components } from './api'
import type { OperatorMode } from './mode'
import type { CatalogSource, OperatorEvent, OwnerAction } from './types'

type API = components['schemas']
type Snapshot = { events: OperatorEvent[]; cursor: number; epoch?: string; name: string; catalog?: API['CatalogInfo'] }
export class AccessError extends Error {
  constructor(readonly status: number, message = 'Operator request failed') {
    super(message)
  }
}

function liveEvent(e: API['Event']): OperatorEvent {
  const meta = { seq: e.seq, at: e.at, ref: { task: e.task }, outcome: e.kind === 'system' ? undefined : e.outcome }
  switch (e.kind) {
    case 'received': return { ...meta, type: 'task.received', data: { title: e.text, source: 'owner' } }
    case 'owner_message': return { ...meta, type: 'owner.message',
      data: { text: e.text, intent: e.data?.intent === 'steer' ? 'steer' : 'ask' } }
    case 'started':
      if (e.data?.action === 'owner_replied' || e.data?.action === 'answer_review')
        return { ...meta, type: 'task.resumed', data: { reason: e.text, reviewingAnswer: e.data.action === 'answer_review' } }
      return { ...meta, type: 'task.step', data: { summary: e.text } }
    case 'answered': return { ...meta, type: 'task.answered', data: { text: e.text } }
    case 'completed': return { ...meta, type: 'task.completed', data: { summary: e.text } }
    case 'failed':
    case 'unknown': return { ...meta, type: 'task.completed', data: { summary: e.text } }
    case 'stopped': return { ...meta, type: 'task.stopped', data: {by: 'owner'} }
    case 'evidence':
    case 'waiting':
    case 'system':
    case 'verified': return evidenceEvent(meta, e)
  }
}

function evidenceEvent(meta: Pick<OperatorEvent, 'seq' | 'at' | 'ref' | 'outcome'>, event: API['Event']): OperatorEvent {
  const step: OperatorEvent = { ...meta, type: 'task.step', data: { summary: event.text } }
  const data = event.data
  if (event.kind === 'waiting' && data?.action === 'worker_signin')
    return { ...meta, type: 'task.waiting', data: { on: 'sign-in', question: event.text } }
  if (event.kind === 'waiting' && data?.action === 'reply_required')
    return { ...meta, type: 'task.waiting', data: { on: 'reply', question: event.text } }
  if (typeof data?.goal === 'string') {
    const ref = {...meta.ref, goal: data.goal, incident: typeof data.incident === 'string' ? data.incident : undefined}
    if (data.action === 'goal_created' && typeof data.filename === 'string' && typeof data.expected === 'string') {
      return { ...meta, ref, type: 'goal.standing',
        data: {text: `Keep ${data.filename} at mode ${data.expected}`, check: 'Read the file permission bits.'} }
    }
    if (data.action === 'goal_status' && (data.status === 'active' || data.status === 'paused' || data.status === 'retired')) {
      return {...meta, ref, type: 'goal.status', data: {status: data.status}}
    }
    if (data.action === 'goal_checked' && (data.status === 'holding' || data.status === 'drift' || data.status === 'blocked')
      && typeof data.actual === 'string') {
      return {...meta, ref, type: 'goal.checked',
        data: {status: data.status, observed: event.text, command: 'Read file permission bits', output: data.actual}}
    }
    if (data.action === 'incident_opened' && typeof data.filename === 'string') {
      return {...meta, ref, type: 'incident.opened',
        data: {resource: data.filename, symptom: event.text, detectedBy: 'Standing goal', severity: 'medium'}}
    }
    if (data.action === 'incident_repair' && typeof data.skill === 'string' && typeof data.revision === 'string') {
      return {...meta, ref, type: 'incident.step',
        data: {kind: 'change', summary: event.text, skill: {id: data.skill, revision: data.revision}}}
    }
    if (data.action === 'incident_observation') {
      return {...meta, ref, type: 'incident.step', data: {kind: 'diagnose', summary: event.text}}
    }
    if (data.action === 'incident_recovered' && typeof data.actual === 'string') {
      return {...meta, ref, type: 'incident.verified',
        data: {check: event.text, command: 'Independent file permission read', output: data.actual, resolved: true}}
    }
    if (data.action === 'incident_unknown') {
      return {...meta, ref, type: 'incident.unknown', data: {summary: event.text}}
    }
  }
  if (data?.action === 'package_activated' && typeof data.revision === 'string' && Array.isArray(data.tests)) {
    const project = typeof data.project === 'string'
    const id = project ? data.project : data.connector
    if (typeof id === 'string') return { ...meta, type: 'task.step', data: {
      summary: event.text, output: data.tests.join('\n'),
      package: { id, kind: project ? 'project' : 'connector', revision: data.revision },
    }}
  }
  if (data?.action === 'credential_requested' && typeof data.request === 'string'
    && typeof data.connector === 'string' && typeof data.destination === 'string') {
    return { ...meta, ref: {...meta.ref, request: data.request}, type: 'credential.requested',
      data: {label: typeof data.label === 'string' ? data.label : `Bearer token for ${data.connector}`,
        why: event.text, destination: data.destination,
        storage: 'Private operator vault', scope: typeof data.scope === 'string' ? data.scope : 'Read-only MCP tool',
        fields: [{name: 'value', label: 'Bearer token', secret: true}], pause: true} }
  }
  if (data?.action === 'credential_supplied' && typeof data.request === 'string'
    && typeof data.fingerprint === 'string') {
    return { ...meta, ref: {...meta.ref, request: data.request}, type: 'credential.supplied',
      data: {fingerprint: data.fingerprint, fields: ['value'], resume: true} }
  }
  if (typeof data?.connector === 'string') {
    const ref = {...meta.ref, connector: data.connector}
    if (data.action === 'connector_configured' && typeof data.name === 'string'
      && typeof data.fingerprint === 'string' && Array.isArray(data.tools) && readSource(data.catalog)) {
      const tools = data.tools.flatMap(tool => {
        if (!tool || typeof tool !== 'object' || Array.isArray(tool)
          || typeof tool.name !== 'string' || typeof tool.description !== 'string') return []
        return [{name: tool.name, description: tool.description, access: tool.access === 'write' ? 'write' as const : 'read' as const}]
      })
      return { ...meta, ref, type: 'connector.configured',
        data: { name: data.name, provider: typeof data.provider === 'string' ? data.provider : 'MCP', tools, scope: typeof data.scope === 'string' ? data.scope : 'Read-only MCP',
          credential: {label: 'Bearer token', storage: 'Private operator vault', fingerprint: data.fingerprint},
          catalog: data.catalog } }
    }
    if (data.action === 'connector_used' && typeof data.tool === 'string') {
      return { ...meta, ref, type: 'connector.used',
        data: {task: event.task, tool: data.tool, summary: event.text, output: JSON.stringify(data.result, null, 2)} }
    }
  }
  if ((data?.action === 'project_read' || data?.action === 'project_registered') && typeof data.project === 'string'
    && typeof data.name === 'string' && typeof data.description === 'string'
    && typeof data.hostname === 'string' && typeof data.repo === 'string'
    && typeof data.upstream === 'string' && readSource(data.catalog)) {
    return { ...meta, ref: { ...meta.ref, project: data.project }, type: 'project.registered',
      data: {name: data.name, description: data.description, hostname: data.hostname,
        repo: data.repo, upstream: data.upstream, catalog: data.catalog} }
  }
  if (event.kind === 'verified' && !data?.skill && typeof data?.command === 'string' && typeof data.output === 'string') {
    return { ...meta, type: 'task.verification',
      data: { result: 'passed', method: 'independent', check: event.text, command: data.command, output: data.output } }
  }
  if (typeof data?.memory === 'string') {
    const ref = { ...meta.ref, memory: data.memory }
    if (data.action === 'memory_read' && typeof data.why === 'string') {
      return { ...meta, ref, type: 'memory.read', data: { task: event.task, why: data.why } }
    }
    if ((data.action === 'memory_written' || data.action === 'memory_removed')
      && typeof data.title === 'string' && typeof data.text === 'string'
      && (data.kind === 'fact' || data.kind === 'preference' || data.kind === 'procedure')) {
      return {
        ...meta, ref, type: 'memory.written',
        data: { title: data.title, text: data.text, kind: data.kind,
          scope: typeof data.scope === 'string' ? data.scope : undefined,
          removed: data.action === 'memory_removed' },
      }
    }
  }
  if (!data || typeof data.skill !== 'string' || typeof data.revision !== 'string') return step
  const { skill, revision } = data
  const ref = { ...meta.ref, skill }
  const task = event.task
  const procedure = Array.isArray(data.procedure) ? data.procedure.filter(value => typeof value === 'string') : []
  switch (data.action) {
    case 'authoring_guide':
      if (readSource(data.catalog)) return {
        ...meta, ref, type: 'skill.installed',
        data: { name: skill, revision, foundational: true, source: 'Framework seed',
          purpose: 'Create reusable skills from observed needs.', catalog: data.catalog, procedure },
      }
      break
    case 'skill_built':
      if (readSource(data.catalog) && typeof data.authoring_revision === 'string'
        && typeof data.name === 'string' && typeof data.purpose === 'string') {
        return {
          ...meta, ref, type: 'skill.created',
          data: { name: data.name, purpose: data.purpose, fromTask: task, revision, procedure,
            catalog: data.catalog, builtWith: { id: 'create-skill', revision: data.authoring_revision } },
        }
      }
      break
    case 'skill_revised':
      return { ...meta, ref, type: 'skill.revised', data: { revision, task, summary: event.text, procedure } }
    case 'operation_authorized':
      return { ...step, type: 'task.step', data: { summary: event.text, skill: {id: skill, revision} } }
    case 'skill_tested':
      if (Array.isArray(data.tests)) {
        const tests = data.tests.flatMap(test => {
          if (!test || typeof test !== 'object' || Array.isArray(test)
            || typeof test.name !== 'string' || typeof test.passed !== 'boolean') return []
          return [{ name: test.name, passed: test.passed, input: JSON.stringify(test.rows ?? []), expected: JSON.stringify(test.expected) }]
        })
        return { ...meta, ref, type: 'skill.self_tested', data: { revision, task, tests, authoredBy: 'authored by the operator' } }
      }
      break
    case 'skill_activated':
      return { ...meta, ref, type: 'skill.activated',
        data: { revision, task, reason: typeof data.reason === 'string' ? data.reason : 'Passed self-tests on this revision.' } }
    case 'skill_invoked':
      return {
        ...meta, ref, type: 'skill.used',
        data: { revision, task, input: JSON.stringify(data.arguments), novelty: event.text, output: JSON.stringify(data.result, null, 2) },
      }
    case 'skill_verified':
      if (typeof data.command === 'string' && typeof data.output === 'string') return {
        ...meta, ref, type: 'skill.verified',
        data: { revision, task, check: event.text, command: data.command, output: data.output, matched: event.text },
      }
  }
  return step
}

function readSource(value: unknown): value is CatalogSource {
  return !!value && typeof value === 'object' && 'repo' in value && typeof value.repo === 'string'
    && 'path' in value && typeof value.path === 'string'
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

export async function readWorkerStatus(signal: AbortSignal): Promise<API['WorkerStatus']> {
  const response = await fetch('/api/worker', { cache: 'no-store', signal })
  if (!response.ok) throw new AccessError(response.status)
  return response.json()
}

export async function changeWorkerAuth(action: 'connect' | 'cancel' | 'disconnect'): Promise<API['WorkerAuthStatus']> {
  return post('/api/worker/auth/' + action, {})
}

export async function readCatalogStatus(signal: AbortSignal): Promise<API['CatalogStatus']> {
  const response = await fetch('/api/catalog', { cache: 'no-store', signal })
  if (!response.ok) throw new AccessError(response.status, 'Could not load catalog status.')
  return response.json()
}

export async function connectCatalog(body: API['CatalogConnection']): Promise<API['CatalogStatus']> {
  return post('/api/catalog', body)
}

export async function runCatalogAction(action: 'key' | 'check' | 'publish'): Promise<API['CatalogStatus']> {
  return post(`/api/catalog/${action}`, {})
}

export async function pullCatalogBranch(branch: string): Promise<API['CatalogStatus']> {
  return post(`/api/catalog/branches/${encodeURIComponent(branch)}/pull`, {})
}

export async function previewCatalogPublish(branch: string): Promise<API['CatalogPublishPreview']> {
  const response = await fetch(`/api/catalog/branches/${encodeURIComponent(branch)}/publish`, { cache: 'no-store' })
  if (!response.ok) {
    const error = await response.json().catch(() => null)
    throw new AccessError(response.status, error?.detail ?? 'Could not preview publishing.')
  }
  return response.json()
}

export async function publishCatalogBranch(branch: string, tips: API['CatalogPublishTips']): Promise<API['CatalogStatus']> {
  return post(`/api/catalog/branches/${encodeURIComponent(branch)}/publish`, tips)
}

export async function activateCatalogSkill(skill: string, revision: string): Promise<API['CatalogStatus']> {
  return post('/api/catalog/skills/activate', { skill, revision })
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
        return { events: snapshot.events.map(liveEvent), cursor: snapshot.cursor, epoch: snapshot.profile.id,
          name: snapshot.profile.name, catalog: snapshot.catalog ?? undefined }
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
      if (action.kind !== 'message' && action.kind !== 'stop') throw new Error('Unsupported action')

      const key = await messageKey(action.kind === 'message' && !action.taskId ? action.text : JSON.stringify(action))
      let requestId = pending.get(key) ?? crypto.randomUUID()
      try {
        requestId = sessionStorage.getItem(key) ?? requestId
        sessionStorage.setItem(key, requestId)
      } catch {
        // Browsers with storage disabled can still retry while this page is open.
      }
      pending.set(key, requestId)
      if (action.kind === 'stop' || action.taskId) {
        const command: API['OwnerStop'] | API['OwnerSteer'] = action.kind === 'stop'
          ? {kind: 'stop', requestId} : {kind: 'steer', requestId, text: action.text}
        await post(`/api/tasks/${encodeURIComponent(action.taskId!)}/control`, command)
      } else {
        const command: API['OwnerMessage'] = { kind: 'message', text: action.text, requestId }
        const receipt: API['Receipt'] = await post('/api/commands', command)
        if (!receipt.taskId) throw new Error('Missing task receipt')
      }
      if (pending.get(key) === requestId) pending.delete(key)
      try {
        if (sessionStorage.getItem(key) === requestId) sessionStorage.removeItem(key)
      } catch { /* Storage may be disabled. */ }
    },
    async supplyCredential(requestId: string, value?: string) {
      if (mode === 'demo') await post('/api/secrets', { requestId })
      else if (value) await post('/api/secrets', { requestId, value } satisfies API['SupplyCredential'])
      else throw new Error('Enter the requested credential')
    },
  }
}
