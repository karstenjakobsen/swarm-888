import type { components } from './api'

export type OwnerAction =
  | { kind: 'message'; text: string; taskId?: string }
  | { kind: 'stop'; taskId: string }
  | { kind: 'decide'; requestId: string; optionId: string }
  | { kind: 'reset' }

export type Ref = {
  task?: string
  incident?: string
  skill?: string
  goal?: string
  request?: string
  memory?: string
  connector?: string
  project?: string
}

/** Where a reusable definition lives in the external Git catalog the operator reads from. */
export type CatalogSource = { repo: string; path: string; branch?: string }

export type VerificationClaim = {
  claim: string
  method: VerificationMethod
  command: string
  output: string
}

export type SkillRef = { id: string; revision: string }

export type ConnectorTool = { name: string; description: string; access: 'read' | 'write' }

export type DnsRecordChange = {
  zone: string
  name: string
  type: string
  value: string
  ttl: number
  change: 'created' | 'updated' | 'deleted'
}

export type CredentialField = { name: string; label: string; secret: boolean }

export type DecisionOption = {
  id: string
  label: string
  consequence: string
  recommended?: boolean
}

export type SelfTest = { name: string; input: string; expected: string; passed: boolean }

export type VerificationMethod = 'self' | 'independent'

type DataMap = {
  'owner.left': { note: string }
  'owner.message': { text: string; intent: 'ask' | 'steer' | 'config' | 'reply' }
  'operator.message': { text: string }
  'goal.standing': { text: string; check: string }
  'goal.status': { status: 'active' | 'paused' | 'retired' }
  'goal.checked': {
    status: 'holding' | 'drift' | 'blocked'
    observed: string
    command: string
    output: string
  }
  'task.received': { title: string; source: 'owner' | 'schedule' | 'incident'; request?: string }
  'task.understood': { interpretation: string; plan: string[] }
  'task.step': { summary: string; command?: string; output?: string; routine?: boolean; package?: {id: string; kind: 'project' | 'connector'; revision: string}; skill?: SkillRef }
  'task.answered': { text: string }
  'task.verification': {
    result: 'passed' | 'failed'
    method: VerificationMethod
    check: string
    command: string
    output: string
    claims?: VerificationClaim[]
  }
  'task.waiting': {
    on: 'credential' | 'decision' | 'reply' | 'sign-in'
    question?: string
  }
  'task.resumed': { reason: string; reviewingAnswer?: boolean }
  'task.completed': { summary: string }
  'task.stopped': { by: 'owner' }
  'credential.requested': {
    label: string
    why: string
    destination: string
    storage: string
    scope: string
    fields: CredentialField[]
    pause?: boolean
  }
  'credential.supplied': { fingerprint: string; fields: string[]; resume?: boolean }
  'incident.opened': {
    resource: string
    symptom: string
    detectedBy: string
    severity: 'high' | 'medium' | 'low'
  }
  'incident.step': {
    summary: string
    kind: 'diagnose' | 'change' | 'routine'
    command?: string
    output?: string
    skill?: SkillRef
  }
  'incident.verified': { check: string; command: string; output: string; resolved?: boolean }
  'incident.unknown': { summary: string }
  'incident.resolved': { summary: string }
  'incident.decision_needed': {
    known: string[]
    uncertain: string[]
    question: string
    options: DecisionOption[]
  }
  'incident.decided': { optionId: string; label: string }
  'skill.installed': {
    name: string
    purpose: string
    revision: string
    foundational: boolean
    source: string
    catalog: CatalogSource
    procedure: string[]
  }
  'skill.created': {
    name: string
    purpose: string
    fromTask: string
    revision: string
    builtWith?: SkillRef
    catalog: CatalogSource
    procedure: string[]
  }
  'skill.revised': { revision: string; summary: string; task?: string; procedure: string[] }
  'skill.self_tested': { tests: SelfTest[]; authoredBy: string; task: string; revision: string }
  /** A committed revision becomes the one the operator runs. Separate from committing it. */
  'skill.activated': { revision: string; task?: string; reason: string }
  'skill.used': { task?: string; incident?: string; input: string; novelty: string; revision: string; output?: string }
  'project.registered': {
    name: string
    description: string
    hostname: string
    repo: string
    upstream: string
    catalog: CatalogSource
    memory?: string
  }
  'memory.written': { title: string; kind: 'fact' | 'preference' | 'procedure'; text: string; scope?: string; removed?: boolean }
  'memory.read': { task: string; why: string }
  'connector.configured': {
    name: string
    provider: string
    tools: ConnectorTool[]
    scope: string
    manages?: { label: string; value: string }
    credential: { label: string; storage: string; fingerprint?: string; request?: string }
    catalog: CatalogSource
  }
  'connector.used': { task: string; tool: string; summary: string; record?: DnsRecordChange; output?: string }
  'skill.verified': {
    task: string
    revision?: string
    check: string
    command: string
    output: string
    matched: string
  }
}

export type EventType = keyof DataMap
export type EventData<K extends EventType> = DataMap[K]

export type OperatorEvent<K extends EventType = EventType> = {
  [T in K]: { seq: number; at: string; type: T; ref: Ref; data: DataMap[T]; outcome?: components['schemas']['Outcome'] }
}[K]

export type EventDraft<K extends EventType = EventType> = {
  [T in K]: { at?: string; type: T; ref: Ref; data: DataMap[T] }
}[K]

export function draft<K extends EventType>(
  type: K,
  ref: Ref,
  data: DataMap[K],
  at?: string,
): EventDraft<K> {
  return { type, ref, data, at } as EventDraft<K>
}
