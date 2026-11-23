import {
  incidentOutcome,
  isTaskFinished,
  taskOutcome,
  type Credential,
  type Incident,
  type Projection,
  type Task,
} from './project'

export type NeedItem =
  | { kind: 'credential'; id: string; credential: Credential; task: Task; at: string }
  | { kind: 'decision'; id: string; incident: Incident; at: string }
  | { kind: 'unknown'; id: string; incident: Incident; at: string }
  | { kind: 'reply'; id: string; task: Task; at: string }

export function needsYou(p: Projection): NeedItem[] {
  const items: NeedItem[] = []
  for (const id of p.incidentOrder) {
    const i = p.incidents[id]
    if (i.unknown && !i.resolved)
      items.push({ kind: 'unknown', id: i.id, incident: i, at: i.unknown.at })
    if (i.decision && !i.decision.decided && !i.resolved)
      items.push({ kind: 'decision', id: i.id, incident: i, at: i.trail.find((t) => t.seq === i.decision!.seq)?.at ?? i.openedAt })
  }
  for (const c of Object.values(p.credentials)) {
    const task = p.tasks[c.task]
    if (!c.supplied && task && !task.stopped) items.push({ kind: 'credential', id: c.requestId, credential: c, task, at: c.requestedAt })
  }
  for (const id of p.taskOrder) {
    const t = p.tasks[id]
    if (t.waiting?.on === 'reply' && !t.stopped) items.push({ kind: 'reply', id: t.id, task: t, at: t.lastAt })
  }
  return items
}

export type WorkRow =
  | { kind: 'task'; id: string; title: string; at: string; task: Task }
  | { kind: 'incident'; id: string; title: string; at: string; incident: Incident }

export function workSince(p: Projection, sinceSeq: number): WorkRow[] {
  const rows: WorkRow[] = []
  for (const id of p.taskOrder) {
    const t = p.tasks[id]
    if (t.trail.some((x) => x.seq > sinceSeq) && t.source !== 'incident')
      rows.push({ kind: 'task', id, title: t.title,
        at: t.stopped?.at ?? t.verification?.at ?? t.completed?.at ?? t.lastAt, task: t })
  }
  for (const id of p.incidentOrder) {
    const i = p.incidents[id]
    if (i.trail.some((x) => x.seq > sinceSeq)) rows.push({ kind: 'incident', id, title: i.symptom, at: i.lastAt, incident: i })
  }
  return rows.sort((a, b) => (a.at < b.at ? 1 : -1))
}

export function summary(p: Projection) {
  const since = p.ownerLeft?.seq ?? 0
  const touched = p.taskOrder.map((id) => p.tasks[id]).filter((t) => t.trail.some((x) => x.seq > since))
  const finished = touched.filter((t) => isTaskFinished(t) && (t.completed?.seq ?? t.verification?.seq ?? t.stopped?.seq ?? 0) > since)
  const running = touched.filter((t) => !isTaskFinished(t) && !t.waiting)
  const incidents = p.incidentOrder.map((id) => p.incidents[id]).filter((i) => i.trail.some((x) => x.seq > since))
  const resolved = incidents.filter((i) => incidentOutcome(i).key === 'resolved')
  const goals = p.goalOrder.map((id) => p.goals[id]).filter((g) => g.lifecycle !== 'paused' && g.lifecycle !== 'retired')
  const holding = goals.filter((g) => g.status === 'holding')
  const off = goals.filter((g) => g.status !== 'holding')
  return { since, finished, running, incidents, resolved, goals, holding, off, needs: needsYou(p) }
}

export function plural(n: number, one: string, many = `${one}s`) {
  return `${n} ${n === 1 ? one : many}`
}

export function rowOutcome(r: WorkRow) {
  return r.kind === 'task' ? taskOutcome(r.task) : incidentOutcome(r.incident)
}

export function finishedRow(row: WorkRow) {
  return row.kind === 'task' ? isTaskFinished(row.task) : Boolean(row.incident.resolved)
}
