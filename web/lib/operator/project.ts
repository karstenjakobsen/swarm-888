import type {
  CatalogSource,
  ConnectorTool,
  SkillRef,
  VerificationClaim,
  CredentialField,
  DecisionOption,
  DnsRecordChange,
  EventData,
  OperatorEvent,
  SelfTest,
  VerificationMethod,
} from './types'

export type TrailKind =
  | 'received'
  | 'understood'
  | 'step'
  | 'change'
  | 'diagnose'
  | 'answer'
  | 'verification'
  | 'waiting'
  | 'resumed'
  | 'completed'
  | 'stopped'
  | 'credential'
  | 'decision'
  | 'message'
  | 'skill'
  | 'opened'
  | 'resolved'

export type TrailItem = {
  seq: number
  at: string
  kind: TrailKind
  title: string
  detail?: string
  command?: string
  output?: string
  routine?: boolean
  tone?: 'good' | 'bad' | 'attention'
  link?: { href: string; label: string }
  skill?: SkillRef
}

export type Verification = {
  seq: number
  at: string
  result: 'passed' | 'failed'
  method: VerificationMethod
  check: string
  command: string
  output: string
  claims?: VerificationClaim[]
}

export type Project = {
  id: string
  name: string
  description: string
  hostname: string
  repo: string
  upstream: string
  catalog: CatalogSource
  memory?: string
  registeredAt: string
  registeredSeq: number
  relatedTasks: string[]
}

export type Task = {
  recordedOutcome?: Outcome
  id: string
  title: string
  source: 'owner' | 'schedule' | 'incident'
  receivedAt: string
  incident?: string
  project?: string
  credentialRequest?: string
  interpretation?: string
  plan: string[]
  answer?: { text: string; seq: number; at: string }
  verification?: Verification
  waiting?: OperatorEvent<'task.waiting'>['data'] & { seq: number }
  stopped?: { seq: number; at: string }
  completed?: { seq: number; at: string; summary: string }
  skillUsed?: string
  used: TaskUsage
  trail: TrailItem[]
  lastAt: string
}

export type TaskUsage = {
  memoriesRead: { memory: string; seq: number; why: string }[]
  memoriesWritten: { memory: string; seq: number; updated: boolean }[]
  skillRuns: { skill: string; revision: string; seq: number }[]
  skillsBuilt: { skill: string; revision: string; seq: number }[]
  skillActivations: { skill: string; revision: string; seq: number }[]
  connectors: { connector: string; tool: string; seq: number }[]
}

const noUsage: TaskUsage = {
  memoriesRead: [],
  memoriesWritten: [],
  skillRuns: [],
  skillsBuilt: [],
  skillActivations: [],
  connectors: [],
}

export type MemoryVersion = {
  seq: number
  at: string
  text: string
  removed?: boolean
  source: { task?: string; incident?: string }
}

export type Memory = {
  id: string
  title: string
  kind: 'fact' | 'preference' | 'procedure'
  scope?: string
  versions: MemoryVersion[]
  readBy: { task: string; seq: number; at: string; why: string }[]
}

export type ConnectorUse = { seq: number; at: string; task: string; tool: string; summary: string; record?: DnsRecordChange }

export type Connector = {
  id: string
  name: string
  provider: string
  tools: ConnectorTool[]
  scope: string
  manages?: { label: string; value: string }
  credential: {
    label: string
    storage: string
    status: 'stored' | 'awaiting'
    fingerprint?: string
    request?: string
  }
  configuredAt: string
  catalog: CatalogSource
  uses: ConnectorUse[]
}

export type SkillRevision = {
  revision: string
  seq: number
  at: string
  summary: string
  task?: string
  procedure: string[]
}

export type SkillSelfTest = {
  seq: number
  at: string
  revision: string
  tests: SelfTest[]
  authoredBy: string
  task: string
}

export type SkillUse = {
  seq: number
  at: string
  task?: string
  incident?: string
  input: string
  novelty: string
  revision: string
}

export type Incident = {
  id: string
  resource: string
  symptom: string
  detectedBy: string
  severity: 'high' | 'medium' | 'low'
  openedAt: string
  goal?: string
  unknown?: { seq: number; at: string; summary: string }
  changes: TrailItem[]
  verification?: { seq: number; at: string; check: string; command: string; output: string }
  resolved?: { seq: number; at: string; summary: string }
  decision?: {
    requestId: string
    seq: number
    known: string[]
    uncertain: string[]
    question: string
    options: DecisionOption[]
    decided?: { optionId: string; label: string; seq: number; at: string }
  }
  relatedTasks: string[]
  skillRuns: { skill: string; revision: string; seq: number }[]
  trail: TrailItem[]
  lastAt: string
}

export type Credential = {
  requestId: string
  task: string
  label: string
  why: string
  destination: string
  storage: string
  scope: string
  fields: CredentialField[]
  requestedAt: string
  supplied?: { seq: number; at: string; fingerprint: string }
}

export type Skill = {
  id: string
  name: string
  purpose: string
  createdAt: string
  createdSeq: number
  /** Empty for skills that shipped with the operator rather than being built on this VPS. */
  fromTask: string
  origin: 'learned' | 'installed'
  foundational: boolean
  source?: string
  catalog: CatalogSource
  builtWith?: SkillRef
  /** Revision the operator currently runs. Empty until a committed revision is activated. */
  revision: string
  revisions: SkillRevision[]
  selfTests: SkillSelfTest[]
  activations: { revision: string; seq: number; at: string; task?: string; reason: string }[]
  uses: SkillUse[]
  verifications: (EventData<'skill.verified'> & { seq: number; at: string })[]
}

export type Goal = {
  id: string
  text: string
  check: string
  status: 'holding' | 'drift' | 'blocked' | 'unknown'
  lifecycle?: 'active' | 'paused' | 'retired'
  observed?: string
  checkedAt?: string
  checkedSeq?: number
  command?: string
  output?: string
}

export type Message = {
  seq: number
  at: string
  from: 'owner' | 'operator'
  text: string
  task?: string
}

export type Projection = {
  lastSeq: number
  ownerLeft?: { seq: number; at: string }
  tasks: Record<string, Task>
  taskOrder: string[]
  incidents: Record<string, Incident>
  incidentOrder: string[]
  credentials: Record<string, Credential>
  skills: Record<string, Skill>
  skillOrder: string[]
  memories: Record<string, Memory>
  memoryOrder: string[]
  connectors: Record<string, Connector>
  connectorOrder: string[]
  projects: Record<string, Project>
  projectOrder: string[]
  goals: Record<string, Goal>
  goalOrder: string[]
  messages: Message[]
}

export function recordById<T>(records: Record<string, T>, id: string): T | undefined {
  return Object.hasOwn(records, id) ? records[id] : undefined
}

export const emptyProjection: Projection = {
  lastSeq: 0,
  tasks: {},
  taskOrder: [],
  incidents: {},
  incidentOrder: [],
  credentials: {},
  skills: {},
  skillOrder: [],
  memories: {},
  memoryOrder: [],
  connectors: {},
  connectorOrder: [],
  projects: {},
  projectOrder: [],
  goals: {},
  goalOrder: [],
  messages: [],
}

function withTask(p: Projection, id: string | undefined, fn: (t: Task) => Task): Projection {
  if (!id || !p.tasks[id]) return p
  return { ...p, tasks: { ...p.tasks, [id]: fn(p.tasks[id]) } }
}

function withIncident(
  p: Projection,
  id: string | undefined,
  fn: (i: Incident) => Incident,
): Projection {
  if (!id || !p.incidents[id]) return p
  return { ...p, incidents: { ...p.incidents, [id]: fn(p.incidents[id]) } }
}

function withSkill(p: Projection, id: string | undefined, fn: (s: Skill) => Skill): Projection {
  if (!id || !p.skills[id]) return p
  return { ...p, skills: { ...p.skills, [id]: fn(p.skills[id]) } }
}

function linkProject(p: Projection, projectId: string | undefined, taskId: string | undefined): Projection {
  const proj = projectId ? p.projects[projectId] : undefined
  if (!proj || !taskId || proj.relatedTasks.includes(taskId)) return p
  return { ...p, projects: { ...p.projects, [proj.id]: { ...proj, relatedTasks: [...proj.relatedTasks, taskId] } } }
}

function skillLink(id: string, revision: string, name?: string) {
  return { href: `/skills/${id}?rev=${revision}`, label: `${name ?? id} @ ${revision}` }
}

function usage(p: Projection, id: string | undefined, fn: (u: TaskUsage) => TaskUsage): Projection {
  return withTask(p, id, (t) => ({ ...t, used: fn(t.used) }))
}

function trail<T extends { trail: TrailItem[]; lastAt: string }>(item: TrailItem) {
  return (x: T): T => ({ ...x, trail: [...x.trail, item], lastAt: item.at })
}

/**
 * Pure, idempotent fold over the event log. The live view applies events one at a
 * time; history replay folds the whole log. Both go through this function, so
 * they cannot disagree about an outcome.
 */
export function apply(p: Projection, e: OperatorEvent): Projection {
  if (e.seq <= p.lastSeq) return p
  const next = reduce({ ...p, lastSeq: e.seq }, e)
  const { outcome } = e
  if (!outcome) return next
  return withTask(next, e.ref.task, (t) => {
    const previous = t.recordedOutcome
    if (outcome.key === 'working' && previous && previous.key !== 'working' && previous.key !== 'needs-you') {
      return t
    }
    return { ...t, recordedOutcome: outcome }
  })
}

export function replay(events: OperatorEvent[]): Projection {
  return events.reduce(apply, emptyProjection)
}

function reduce(p: Projection, e: OperatorEvent): Projection {
  const base = { seq: e.seq, at: e.at }
  switch (e.type) {
    case 'owner.left':
      return { ...p, ownerLeft: base }
    case 'owner.message':
    case 'operator.message': {
      const msg: Message = {
        ...base,
        from: e.type === 'owner.message' ? 'owner' : 'operator',
        text: e.data.text,
        task: e.ref.task,
      }
      const withMsg = { ...p, messages: [...p.messages, msg] }
      return withTask(
        withMsg,
        e.ref.task,
        trail({
          ...base,
          kind: 'message',
          title: msg.from === 'owner' ? `You: ${msg.text}` : msg.text,
          routine: msg.from === 'operator',
        }),
      )
    }
    case 'goal.standing':
      if (!e.ref.goal) return p
      return {
        ...p,
        goals: {
          ...p.goals,
          [e.ref.goal]: { id: e.ref.goal, text: e.data.text, check: e.data.check, status: 'unknown' },
        },
        goalOrder: [...p.goalOrder, e.ref.goal],
      }
    case 'goal.checked': {
      const g = e.ref.goal ? p.goals[e.ref.goal] : undefined
      if (!g) return p
      return {
        ...p,
        goals: {
          ...p.goals,
          [g.id]: {
            ...g,
            status: e.data.status,
            observed: e.data.observed,
            checkedAt: e.at,
            checkedSeq: e.seq,
            command: e.data.command,
            output: e.data.output,
          },
        },
      }
    }
    case 'goal.status': {
      const goal = e.ref.goal ? recordById(p.goals, e.ref.goal) : undefined
      if (!goal) return p
      return { ...p, goals: { ...p.goals, [goal.id]: { ...goal, lifecycle: e.data.status } } }
    }
    case 'task.received': {
      const id = e.ref.task
      if (!id) return p
      const task: Task = {
        id,
        title: e.data.title,
        source: e.data.source,
        receivedAt: e.at,
        incident: e.ref.incident,
        project: e.ref.project,
        plan: [],
        used: noUsage,
        trail: [{ ...base, kind: 'received', title: `Received: ${e.data.title}` }],
        lastAt: e.at,
      }
      const withT = linkProject(
        { ...p, tasks: { ...p.tasks, [id]: task }, taskOrder: [...p.taskOrder, id] },
        e.ref.project,
        id,
      )
      return withIncident(withT, e.ref.incident, (i) => ({
        ...i,
        relatedTasks: [...i.relatedTasks, id],
      }))
    }
    case 'task.understood':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({
          ...base,
          kind: 'understood',
          title: 'Understood the goal',
          detail: e.data.interpretation,
        })(t),
        interpretation: e.data.interpretation,
        plan: e.data.plan,
      }))
    case 'task.step':
      return withTask(
        p,
        e.ref.task,
        trail({
          ...base,
          kind: 'step',
          title: e.data.summary,
          command: e.data.command,
          output: e.data.output,
          routine: e.data.routine,
          link: e.data.skill ? skillLink(e.data.skill.id, e.data.skill.revision) : undefined,
        }),
      )
    case 'task.answered':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({ ...base, kind: 'answer', title: 'Answered', detail: e.data.text })(t),
        answer: { text: e.data.text, ...base },
      }))
    case 'task.verification':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({
          ...base,
          kind: 'verification',
          title:
            e.data.result === 'passed'
              ? `Verification passed${e.data.method === 'independent' ? ' (independent check)' : ''}`
              : 'Verification failed',
          detail: e.data.check,
          command: e.data.command,
          output: e.data.output,
          tone: e.data.result === 'passed' ? 'good' : 'bad',
        })(t),
        verification: { ...base, ...e.data },
      }))
    case 'task.waiting':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({
          ...base,
          kind: 'waiting',
          title:
            e.data.on === 'credential'
              ? 'Paused: needs a credential'
              : e.data.on === 'decision'
                ? 'Paused: needs your decision'
                : 'Paused: waiting for your reply',
          tone: 'attention',
        })(t),
        waiting: { ...e.data, seq: e.seq },
      }))
    case 'task.resumed':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({ ...base, kind: 'resumed', title: 'Resumed', detail: e.data.reason })(t),
        waiting: undefined,
      }))
    case 'task.completed':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({ ...base, kind: 'completed', title: 'Finished', detail: e.data.summary })(t),
        completed: { ...base, summary: e.data.summary },
      }))
    case 'task.stopped':
      return withTask(p, e.ref.task, (t) => ({
        ...trail<Task>({ ...base, kind: 'stopped', title: 'Stopped by you', tone: 'attention' })(t),
        stopped: base,
        waiting: undefined,
      }))
    case 'credential.requested': {
      const id = e.ref.request
      if (!id || !e.ref.task) return p
      const cred: Credential = {
        requestId: id,
        task: e.ref.task,
        ...e.data,
        requestedAt: e.at,
      }
      const withC = { ...p, credentials: { ...p.credentials, [id]: cred } }
      return withTask(withC, e.ref.task, (t) => ({
        ...trail<Task>({
          ...base,
          kind: 'credential',
          title: `Requested credential: ${e.data.label}`,
          detail: `Will be sent to ${e.data.destination}`,
        })(t),
        credentialRequest: id,
        waiting: e.data.pause ? { ...base, on: 'credential' } : t.waiting,
      }))
    }
    case 'credential.supplied': {
      const id = e.ref.request
      const cred = id ? p.credentials[id] : undefined
      if (!cred) return p
      const connectors = { ...p.connectors }
      for (const c of Object.values(connectors)) {
        if (c.credential.request === cred.requestId)
          connectors[c.id] = { ...c, credential: { ...c.credential, status: 'stored', fingerprint: e.data.fingerprint } }
      }
      const withC = {
        ...p,
        connectors,
        credentials: {
          ...p.credentials,
          [cred.requestId]: { ...cred, supplied: { ...base, fingerprint: e.data.fingerprint } },
        },
      }
      return withTask(
        withC,
        cred.task,
        (task) => ({
          ...trail<Task>({
          ...base,
          kind: 'credential',
          title: 'You supplied the credential',
          detail: `Stored in the operator vault. Fingerprint ${e.data.fingerprint}. Value never entered this log.`,
          tone: 'good',
          })(task),
          waiting: e.data.resume ? undefined : task.waiting,
        }),
      )
    }
    case 'incident.opened': {
      const id = e.ref.incident
      if (!id) return p
      const inc: Incident = {
        id,
        ...e.data,
        goal: e.ref.goal,
        openedAt: e.at,
        changes: [],
        relatedTasks: e.ref.task ? [e.ref.task] : [],
        skillRuns: [],
        trail: [
          { ...base, kind: 'opened', title: `Detected: ${e.data.symptom}`, detail: e.data.detectedBy },
        ],
        lastAt: e.at,
      }
      return {
        ...p,
        incidents: { ...p.incidents, [id]: inc },
        incidentOrder: [...p.incidentOrder, id],
      }
    }
    case 'incident.step': {
      const item: TrailItem = {
        ...base,
        kind: e.data.kind === 'change' ? 'change' : e.data.kind === 'diagnose' ? 'diagnose' : 'step',
        title: e.data.summary,
        command: e.data.command,
        output: e.data.output,
        routine: e.data.kind === 'routine',
        skill: e.data.skill,
        link: e.data.skill
          ? skillLink(e.data.skill.id, e.data.skill.revision, p.skills[e.data.skill.id]?.name)
          : undefined,
      }
      return withIncident(p, e.ref.incident, (i) => ({
        ...trail<Incident>(item)(i),
        changes: e.data.kind === 'change' ? [...i.changes, item] : i.changes,
        skillRuns: e.data.skill ? [...i.skillRuns, {skill: e.data.skill.id, revision: e.data.skill.revision, seq: e.seq}] : i.skillRuns,
      }))
    }
    case 'incident.verified':
      return withIncident(p, e.ref.incident, (i) => ({
        ...trail<Incident>({
          ...base,
          kind: 'verification',
          title: 'Recovery verified',
          detail: e.data.check,
          command: e.data.command,
          output: e.data.output,
          tone: 'good',
        })(i),
        verification: { ...base, ...e.data },
        resolved: e.data.resolved ? { ...base, summary: e.data.check } : i.resolved,
      }))
    case 'incident.unknown':
      return withIncident(p, e.ref.incident, (i) => ({
        ...trail<Incident>({
          ...base, kind: 'verification', title: 'Outcome unknown',
          detail: e.data.summary, tone: 'attention',
        })(i),
        unknown: { ...base, summary: e.data.summary },
      }))
    case 'incident.resolved':
      return withIncident(p, e.ref.incident, (i) => ({
        ...trail<Incident>({
          ...base,
          kind: 'resolved',
          title: 'Resolved',
          detail: e.data.summary,
          tone: 'good',
        })(i),
        resolved: { ...base, summary: e.data.summary },
      }))
    case 'incident.decision_needed':
      return withIncident(p, e.ref.incident, (i) => ({
        ...trail<Incident>({
          ...base,
          kind: 'decision',
          title: 'Needs your decision',
          detail: e.data.question,
          tone: 'attention',
        })(i),
        decision: { requestId: e.ref.request ?? '', seq: e.seq, ...e.data },
      }))
    case 'incident.decided':
      return withIncident(p, e.ref.incident, (i) => ({
        ...trail<Incident>({
          ...base,
          kind: 'decision',
          title: `You decided: ${e.data.label}`,
          tone: 'good',
        })(i),
        decision: i.decision
          ? { ...i.decision, decided: { ...e.data, ...base } }
          : i.decision,
      }))
    case 'skill.installed': {
      const id = e.ref.skill
      if (!id) return p
      const withRead = withTask(p, e.ref.task, trail({
        ...base,
        kind: 'skill',
        title: `Read ${e.data.name} @ ${e.data.revision}`,
        link: skillLink(id, e.data.revision, e.data.name),
      }))
      if (recordById(withRead.skills, id)) return withRead
      const skill: Skill = {
        id,
        name: e.data.name,
        purpose: e.data.purpose,
        createdAt: e.at,
        createdSeq: e.seq,
        fromTask: '',
        origin: 'installed',
        foundational: e.data.foundational,
        source: e.data.source,
        catalog: e.data.catalog,
        revision: e.data.revision,
        revisions: [
          { revision: e.data.revision, ...base, summary: `Installed from ${e.data.source}`, procedure: e.data.procedure },
        ],
        selfTests: [],
        activations: [{ revision: e.data.revision, ...base, reason: 'Active from install' }],
        uses: [],
        verifications: [],
      }
      return { ...withRead, skills: { ...withRead.skills, [id]: skill }, skillOrder: [...withRead.skillOrder, id] }
    }
    case 'skill.created': {
      const id = e.ref.skill
      if (!id) return p
      const skill: Skill = {
        id,
        name: e.data.name,
        purpose: e.data.purpose,
        createdAt: e.at,
        createdSeq: e.seq,
        fromTask: e.data.fromTask,
        origin: 'learned',
        foundational: false,
        builtWith: e.data.builtWith,
        catalog: e.data.catalog,
        revision: '',
        revisions: [
          { revision: e.data.revision, ...base, summary: 'First version', task: e.data.fromTask, procedure: e.data.procedure },
        ],
        selfTests: [],
        activations: [],
        uses: [],
        verifications: [],
      }
      const withS = { ...p, skills: { ...p.skills, [id]: skill }, skillOrder: [...p.skillOrder, id] }
      const withT = withTask(
        withS,
        e.data.fromTask,
        trail({
          ...base,
          kind: 'skill',
          title: `Built a new skill: ${e.data.name} @ ${e.data.revision}`,
          detail: `Committed to ${e.data.catalog.path}. Not active until it passes its tests.`,
          link: skillLink(id, e.data.revision, e.data.name),
        }),
      )
      return usage(withT, e.data.fromTask, (u) => ({
        ...u,
        skillsBuilt: [...u.skillsBuilt, { skill: id, revision: e.data.revision, seq: e.seq }],
      }))
    }
    case 'skill.revised': {
      const withS = withSkill(p, e.ref.skill, (s) => ({
        ...s,
        revisions: [
          ...s.revisions,
          { revision: e.data.revision, ...base, summary: e.data.summary, task: e.data.task, procedure: e.data.procedure },
        ],
      }))
      return withTask(
        withS,
        e.data.task,
        trail({ ...base, kind: 'skill', title: `Committed skill revision ${e.data.revision}`, detail: e.data.summary }),
      )
    }
    case 'skill.activated': {
      const s = e.ref.skill ? p.skills[e.ref.skill] : undefined
      if (!s) return p
      const withS = withSkill(p, s.id, (x) => ({
        ...x,
        revision: e.data.revision,
        activations: [...x.activations, { revision: e.data.revision, ...base, task: e.data.task, reason: e.data.reason }],
      }))
      const withT = withTask(
        withS,
        e.data.task,
        trail({
          ...base,
          kind: 'skill',
          title: `Activated ${s.name} @ ${e.data.revision}`,
          detail: e.data.reason,
          tone: 'good',
          link: skillLink(s.id, e.data.revision, s.name),
        }),
      )
      return usage(withT, e.data.task, (u) => ({
        ...u,
        skillActivations: [...u.skillActivations, { skill: s.id, revision: e.data.revision, seq: e.seq }],
      }))
    }
    case 'project.registered': {
      const id = e.ref.project
      if (!id) return p
      const existing = recordById(p.projects, id)
      const project: Project = {
        id,
        ...e.data,
        registeredAt: e.at,
        registeredSeq: e.seq,
        relatedTasks: existing?.relatedTasks ?? [],
      }
      const withP = linkProject(
        {
          ...p,
          projects: { ...p.projects, [id]: project },
          projectOrder: existing ? p.projectOrder : [...p.projectOrder, id],
        },
        id,
        e.ref.task,
      )
      return withTask(
        withP,
        e.ref.task,
        (t) => ({
          ...trail<Task>({
            ...base,
            kind: 'skill',
            title: `Registered project: ${e.data.name}`,
            detail: `Definition at ${e.data.catalog.path}`,
            link: { href: `/inspect/projects/${id}`, label: e.data.name },
          })(t),
          project: t.project ?? id,
        }),
      )
    }
    case 'memory.written': {
      const id = e.ref.memory
      if (!id) return p
      const prev = p.memories[id]
      const version: MemoryVersion = { ...base, text: e.data.text, removed: e.data.removed, source: { task: e.ref.task, incident: e.ref.incident } }
      const mem: Memory = prev
        ? { ...prev, title: e.data.title, kind: e.data.kind, scope: e.data.scope ?? prev.scope, versions: [...prev.versions, version] }
        : { id, title: e.data.title, kind: e.data.kind, scope: e.data.scope, versions: [version], readBy: [] }
      const action = e.data.removed ? 'Removed' : prev ? 'Updated' : 'Wrote'
      const withM = {
        ...p,
        memories: { ...p.memories, [id]: mem },
        memoryOrder: e.data.removed ? p.memoryOrder.filter(existing => existing !== id) : prev ? p.memoryOrder : [...p.memoryOrder, id],
      }
      const withT = withTask(
        withM,
        e.ref.task,
        trail({ ...base, kind: 'skill', title: `${action} memory: ${e.data.title}`, detail: e.data.text, routine: true }),
      )
      const withI = withIncident(
        withT,
        e.ref.incident,
        trail({ ...base, kind: 'skill', title: `${action} memory: ${e.data.title}`, detail: e.data.text, routine: true }),
      )
      return usage(withI, e.ref.task, (u) => ({
        ...u,
        memoriesWritten: [...u.memoriesWritten, { memory: id, seq: e.seq, updated: Boolean(prev) }],
      }))
    }
    case 'memory.read': {
      const mem = e.ref.memory ? p.memories[e.ref.memory] : undefined
      if (!mem) return p
      const withM = {
        ...p,
        memories: {
          ...p.memories,
          [mem.id]: { ...mem, readBy: [...mem.readBy, { task: e.data.task, ...base, why: e.data.why }] },
        },
      }
      const withT = withTask(
        withM,
        e.data.task,
        trail({ ...base, kind: 'skill', title: `Read memory: ${mem.title}`, detail: e.data.why, routine: true }),
      )
      return usage(withT, e.data.task, (u) => ({
        ...u,
        memoriesRead: [...u.memoriesRead, { memory: mem.id, seq: e.seq, why: e.data.why }],
      }))
    }
    case 'connector.configured': {
      const id = e.ref.connector
      if (!id) return p
      const previous = recordById(p.connectors, id)
      const supplied = e.data.credential.request ? p.credentials[e.data.credential.request]?.supplied : undefined
      const connector: Connector = {
        id,
        name: e.data.name,
        provider: e.data.provider,
        tools: e.data.tools,
        scope: e.data.scope,
        manages: e.data.manages,
        credential: {
          label: e.data.credential.label,
          storage: e.data.credential.storage,
          request: e.data.credential.request,
          fingerprint: e.data.credential.fingerprint ?? supplied?.fingerprint,
          status: e.data.credential.fingerprint || supplied ? 'stored' : 'awaiting',
        },
        configuredAt: e.at,
        catalog: e.data.catalog,
        uses: previous?.uses ?? [],
      }
      return {
        ...p,
        connectors: { ...p.connectors, [id]: connector },
        connectorOrder: previous ? p.connectorOrder : [...p.connectorOrder, id],
      }
    }
    case 'connector.used': {
      const c = e.ref.connector ? p.connectors[e.ref.connector] : undefined
      if (!c) return p
      const withC = {
        ...p,
        connectors: { ...p.connectors, [c.id]: { ...c, uses: [...c.uses, { ...base, ...e.data }] } },
      }
      const r = e.data.record
      const withT = withTask(
        withC,
        e.data.task,
        trail({
          ...base,
          kind: 'change',
          title: `${c.name}: ${e.data.summary}`,
          command: `${c.id.replace(/^c-/, '')}.${e.data.tool}`,
          output: r ? `${r.change} ${r.name}.${r.zone} ${r.type} ${r.value} ttl=${r.ttl}` : e.data.output,
        }),
      )
      return usage(withT, e.data.task, (u) => ({
        ...u,
        connectors: [...u.connectors, { connector: c.id, tool: e.data.tool, seq: e.seq }],
      }))
    }
    case 'skill.self_tested': {
      const passed = e.data.tests.filter((t) => t.passed).length
      const withS = withSkill(p, e.ref.skill, (s) => ({ ...s, selfTests: [...s.selfTests, { ...base, ...e.data }] }))
      const name = e.ref.skill ? p.skills[e.ref.skill]?.name : undefined
      return withTask(
        withS,
        e.data.task,
        trail({
          ...base,
          kind: 'skill',
          title: `Revision ${e.data.revision} self-tests (${passed}/${e.data.tests.length} passed)`,
          detail: `Tests ${e.data.authoredBy}.`,
          link: e.ref.skill ? skillLink(e.ref.skill, e.data.revision, name) : undefined,
        }),
      )
    }
    case 'skill.used': {
      const skillId = e.ref.skill
      if (!skillId) return p
      const withS = withSkill(p, skillId, (s) => ({ ...s, uses: [...s.uses, { ...base, ...e.data }] }))
      const name = p.skills[skillId]?.name
      const item: TrailItem = {
        ...base,
        kind: 'skill',
        title: `Ran skill: ${name ?? skillId} @ ${e.data.revision}`,
        detail: e.data.novelty,
        output: e.data.output,
        link: skillLink(skillId, e.data.revision, name),
        skill: { id: skillId, revision: e.data.revision },
      }
      const run = { skill: skillId, revision: e.data.revision, seq: e.seq }
      const withT = withTask(withS, e.data.task, (t) => ({
        ...trail<Task>(item)(t),
        skillUsed: skillId,
        used: { ...t.used, skillRuns: [...t.used.skillRuns, run] },
      }))
      return withIncident(withT, e.data.incident, (i) => ({
        ...trail<Incident>(item)(i),
        skillRuns: [...i.skillRuns, run],
      }))
    }
    case 'skill.verified':
      return withSkill(p, e.ref.skill, (s) => {
        let revision = e.data.revision
        if (!revision) {
          // Older events identified only the task. Attribute them when its runs agree.
          const revisions = new Set(s.uses.filter(u => u.task === e.data.task).map(u => u.revision))
          if (revisions.size === 1) revision = revisions.values().next().value
        }
        return { ...s, verifications: [...s.verifications, { ...base, ...e.data, revision }] }
      })
    default:
      return p
  }
}

export type OutcomeKey =
  | 'verified'
  | 'failed'
  | 'unknown'
  | 'stopped'
  | 'needs-you'
  | 'unverified'
  | 'working'
  | 'resolved'
  | 'mitigating'
  | 'investigating'

export type Outcome = { key: OutcomeKey; label: string; seq: number; why: string }

/**
 * Outcome is decided by evidence precedence, never by which event arrived last.
 * An answer that lands after its verification (as happens on reconnect) cannot
 * downgrade a verified task.
 */
export function taskOutcome(t: Task): Outcome {
  if (t.recordedOutcome) return t.recordedOutcome
  if (t.stopped) return { key: 'stopped', label: 'Stopped', seq: t.stopped.seq, why: 'You stopped this task.' }
  if (t.verification?.result === 'failed')
    return { key: 'failed', label: 'Verification failed', seq: t.verification.seq, why: t.verification.check }
  if (t.verification?.result === 'passed')
    return {
      key: 'verified',
      label: t.verification.method === 'independent' ? 'Verified independently' : 'Verified',
      seq: t.verification.seq,
      why: t.verification.check,
    }
  if (t.waiting)
    return {
      key: 'needs-you',
      label:
        t.waiting.on === 'credential'
          ? 'Needs a credential'
          : t.waiting.on === 'decision'
            ? 'Needs your decision'
            : 'Needs your reply',
      seq: t.waiting.seq,
      why: 'Paused until you act.',
    }
  if (t.answer)
    return {
      key: 'unverified',
      label: 'Answered, not yet verified',
      seq: t.answer.seq,
      why: 'The operator has an answer but has not checked it yet.',
    }
  const last = t.trail[t.trail.length - 1]
  return { key: 'working', label: 'Working', seq: last?.seq ?? 0, why: last?.title ?? '' }
}

export function incidentOutcome(i: Incident): Outcome {
  if (i.resolved)
    return {
      key: 'resolved',
      label: i.verification ? 'Resolved, recovery verified' : 'Resolved',
      seq: i.verification?.seq ?? i.resolved.seq,
      why: i.verification?.check ?? i.resolved.summary,
    }
  if (i.unknown) return { key: 'unknown', label: 'Outcome unknown', seq: i.unknown.seq, why: i.unknown.summary }
  if (i.decision && !i.decision.decided)
    return { key: 'needs-you', label: 'Needs your decision', seq: i.decision.seq, why: i.decision.question }
  if (i.decision?.decided)
    return {
      key: 'mitigating',
      label: 'Applying your decision',
      seq: i.decision.decided.seq,
      why: i.decision.decided.label,
    }
  return { key: 'investigating', label: 'Investigating', seq: i.trail[0]?.seq ?? 0, why: i.symptom }
}

export function isTaskFinished(t: Task) {
  return Boolean(t.stopped || t.completed || t.verification)
}

/** Compact fingerprint of everything the owner sees as a verdict. */
export function verdictDigest(p: Projection) {
  const tasks = p.taskOrder.map((id) => `${id}:${taskOutcome(p.tasks[id]).key}`)
  const incidents = p.incidentOrder.map((id) => `${id}:${incidentOutcome(p.incidents[id]).key}`)
  const goals = p.goalOrder.map((id) => `${id}:${p.goals[id].status}`)
  return [p.lastSeq, ...tasks, ...incidents, ...goals].join('|')
}
