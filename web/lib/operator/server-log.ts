import { createHash, randomUUID } from 'node:crypto'
import { draft, type EventDraft, type OperatorEvent } from './types'
import {
  BACKUP_TASK,
  DISK_DECISION,
  DISK_INCIDENT,
  DISK_REV,
  S3_REQUEST,
  S3_CONNECTOR,
  liveScript,
  seedHistory,
} from './scenario'
import { replay } from './project'

type Pending = { due: number; ev: EventDraft }

class OperatorLog {
  readonly epoch = randomUUID()
  private events: OperatorEvent[] = []
  private pending: Pending[] = []
  private started = false
  private counter = 0
  /** Secret values live only here: never in events, never returned to any client. */
  private vault = new Map<string, Record<string, string>>()

  constructor() {
    for (const d of seedHistory(Date.now())) this.append(d)
  }

  private append(d: EventDraft): OperatorEvent {
    const e = { ...d, seq: this.events.length + 1, at: d.at ?? new Date().toISOString() } as OperatorEvent
    this.events.push(e)
    return e
  }

  private schedule(items: [number, EventDraft][]) {
    const now = Date.now()
    for (const [delay, ev] of items) this.pending.push({ due: now + delay, ev })
    this.pending.sort((a, b) => a.due - b.due)
  }

  private flush() {
    const now = Date.now()
    while (this.pending.length && this.pending[0].due <= now) {
      const p = this.pending.shift()!
      const task = p.ev.ref.task
      if (task && this.state().tasks[task]?.stopped) continue
      this.append(p.ev)
    }
  }

  private state() {
    return replay(this.events)
  }

  /** The overnight task keeps running from the moment the owner first connects. */
  begin() {
    if (this.started) return
    this.started = true
    this.schedule(liveScript())
  }

  readAfter(seq: number) {
    this.flush()
    return this.events.filter((e) => e.seq > seq)
  }

  private nextTaskId() {
    this.counter += 1
    return `t-new-${this.counter}`
  }

  message(text: string, taskId?: string) {
    this.flush()
    const s = this.state()
    const task = taskId ? s.tasks[taskId] : undefined

    if (task) {
      if (task.waiting?.on === 'reply') {
        this.append(draft('owner.message', { task: task.id }, { text, intent: 'reply' }))
        if (/^\s*(apply|go|yes|ok|do it|confirm)/i.test(text)) {
          this.schedule([
            [600, draft('task.resumed', { task: task.id }, { reason: 'You confirmed the change.' })],
            [2_500, draft('task.step', { task: task.id }, { summary: 'Applied the change and reloaded the affected service', command: 'systemctl reload <unit>', output: 'ok' })],
            [4_500, draft('task.verification', { task: task.id }, { result: 'passed', method: 'independent', check: 'Re-read the live configuration and confirmed the service is active.', command: 'systemctl is-active <unit>', output: 'active' })],
            [5_000, draft('task.completed', { task: task.id }, { summary: 'Change applied and confirmed.' })],
          ])
        } else {
          this.schedule([[1_500, draft('operator.message', { task: task.id }, { text: 'Noted. I will hold the change. Reply "apply" when you want it made.' })]])
        }
        return
      }
      this.append(draft('owner.message', { task: task.id }, { text, intent: 'steer' }))
      this.schedule([
        [1_500, draft('operator.message', { task: task.id }, { text: `Noted for "${task.title}". I will apply that from the next step.` })],
      ])
      return
    }

    const id = this.nextTaskId()
    const isConfig = /\b(change|set|enable|disable|config|configure|update|install|increase|lower|raise|turn|allow|block|open|close)\b/i.test(text)
    this.append(draft('owner.message', { task: id }, { text, intent: isConfig ? 'config' : 'ask' }))
    this.append(draft('task.received', { task: id }, { title: text.length > 72 ? `${text.slice(0, 70)}…` : text, source: 'owner' }))

    if (isConfig) {
      this.schedule([
        [1_200, draft('task.understood', { task: id }, { interpretation: `Configuration change: ${text}`, plan: ['Read the current configuration', 'Show you the exact change', 'Apply only after you confirm', 'Verify the service afterwards'] })],
        [3_000, draft('task.step', { task: id }, { summary: 'Read the current configuration', routine: true })],
        [4_500, draft('operator.message', { task: id }, { text: 'I have the change ready and have not applied it. Reply "apply" on this task to go ahead.' })],
        [4_600, draft('task.waiting', { task: id }, { on: 'reply' })],
      ])
      return
    }

    const answer = this.cannedAnswer(text)
    this.schedule([
      [1_200, draft('task.understood', { task: id }, { interpretation: `Answer: ${text}`, plan: ['Read the live state', 'Answer', 'Re-check the values I quote'] })],
      [3_000, draft('task.step', { task: id }, { summary: 'Read the live state', command: answer.command, output: answer.output, routine: true })],
      [4_500, draft('task.answered', { task: id }, { text: answer.text })],
      [6_000, draft('task.verification', { task: id }, { result: 'passed', method: 'independent', check: 'Re-ran the source command and compared the values quoted in the answer.', command: answer.command, output: answer.output })],
      [6_300, draft('task.completed', { task: id }, { summary: 'Answered.' })],
    ])
  }

  private cannedAnswer(text: string) {
    const s = this.state()
    if (/disk|space|storage|var/i.test(text)) {
      const g = s.goals['g-disk']
      return { text: `${g?.observed ?? '/var usage unknown'}. Largest consumer is the ingest-worker log.`, command: 'df -h /var', output: g?.output ?? '' }
    }
    if (/backup|postgres|s3/i.test(text)) {
      const g = s.goals['g-backup']
      return { text: g?.observed ?? 'No backup status yet.', command: 'aws s3 ls s3://kj-backups/pg/', output: g?.output ?? '' }
    }
    if (/tls|cert|ssl|https/i.test(text)) {
      return { text: 'kj.dev certificate is valid for 61 more days and renews automatically.', command: 'openssl x509 -noout -enddate', output: 'notAfter=Jan 22 09:14:03 2027 GMT' }
    }
    return { text: 'Load is normal (0.42), 31 services active, last reboot 12 days ago.', command: 'uptime; systemctl list-units --state=active --type=service | tail -1', output: 'load average: 0.42, 0.38, 0.35\n31 loaded units listed.' }
  }

  stop(taskId: string) {
    this.flush()
    const t = this.state().tasks[taskId]
    if (!t || t.stopped || t.completed) return false
    this.pending = this.pending.filter((p) => p.ev.ref.task !== taskId)
    this.append(draft('task.stopped', { task: taskId }, { by: 'owner' }))
    return true
  }

  decide(requestId: string, optionId: string) {
    this.flush()
    const s = this.state()
    const inc = Object.values(s.incidents).find((i) => i.decision?.requestId === requestId)
    const option = inc?.decision?.options.find((o) => o.id === optionId)
    if (!inc || !option || inc.decision?.decided) return false
    const ref = { incident: inc.id }
    this.append(draft('incident.decided', { ...ref, request: requestId }, { optionId, label: option.label }))

    const cap: [number, EventDraft][] = [
      [2_000, draft('incident.step', ref, { kind: 'change', skill: DISK_REV, summary: 'Capped ingest-worker logs: max-size 100m, max-file 5', command: 'docker update is not enough; recreated with --log-opt max-size=100m --log-opt max-file=5', output: 'ingest-worker  Up 2 seconds' })],
      [4_000, draft('incident.step', ref, { kind: 'change', skill: DISK_REV, summary: 'Truncated the old 14 GB log after the container restarted', command: 'truncate -s 0 /var/lib/docker/containers/7f3c…/7f3c…-json.log', output: '' })],
    ]
    if (optionId === 'cap' || optionId === 'both') {
      const extra: [number, EventDraft][] =
        optionId === 'both'
          ? [[5_500, draft('incident.step', ref, { kind: 'change', skill: DISK_REV, summary: 'Deleted volume staging-db (12 GB)', command: 'docker volume rm staging-db', output: 'staging-db' })]]
          : []
      this.schedule([
        ...cap,
        ...extra,
        [8_000, draft('incident.verified', ref, { check: `/var measured at ${optionId === 'both' ? '12' : '27'}% and flat over 2 minutes; ingest-worker log bounded at 100 MB.`, command: 'df --output=pcent /var; sleep 120; df --output=pcent /var', output: `Use%\n ${optionId === 'both' ? '12' : '27'}%\nUse%\n ${optionId === 'both' ? '12' : '27'}%` })],
        [8_500, draft('incident.resolved', ref, { summary: optionId === 'both' ? 'Log growth stopped and staging-db deleted.' : 'Log growth stopped. staging-db kept.' })],
      ])
    } else {
      this.schedule([
        ...cap,
        [5_000, draft('incident.step', ref, { kind: 'diagnose', summary: 'Snapshot of staging-db is queued until the S3 credential arrives' })],
      ])
    }
    return true
  }

  supplyDemoCredential(requestId: string) {
    this.flush()
    const req = this.state().credentials[requestId]
    if (!req || req.supplied) return { ok: false as const, error: 'This request is no longer open.' }
    return this.supplyCredential(requestId, Object.fromEntries(req.fields.map((f) => [f.name, `demo-placeholder-${f.name}`])))
  }

  private supplyCredential(requestId: string, fields: Record<string, string>) {
    this.flush()
    const s = this.state()
    const req = s.credentials[requestId]
    if (!req || req.supplied) return { ok: false as const, error: 'This request is no longer open.' }
    for (const f of req.fields) {
      const v = fields[f.name]
      if (typeof v !== 'string' || !v.trim() || v.length > 512) {
        return { ok: false as const, error: `${f.label} is required.` }
      }
    }
    this.vault.set(requestId, Object.fromEntries(req.fields.map((f) => [f.name, fields[f.name].trim()])))
    const fingerprint =
      'sha256:' +
      createHash('sha256').update(req.fields.map((f) => fields[f.name]).join('\u0000')).digest('hex').slice(0, 10)
    this.append(draft('credential.supplied', { task: req.task, request: requestId }, { fingerprint, fields: req.fields.map((f) => f.name) }))

    const t = req.task
    const items: [number, EventDraft][] = [
      [800, draft('task.resumed', { task: t }, { reason: 'Credential received. Continuing where it paused.' })],
    ]
    if (t === BACKUP_TASK && requestId === S3_REQUEST) {
      items.push(
        [3_000, draft('connector.used', { connector: S3_CONNECTOR }, { task: t, tool: 's3.list', summary: 'Bucket reachable with the new key' })],
        [6_000, draft('connector.used', { connector: S3_CONNECTOR }, { task: t, tool: 's3.put_lifecycle', summary: 'Set lifecycle rule: expire pg/ after 14 days' })],
        [10_000, draft('connector.used', { connector: S3_CONNECTOR }, { task: t, tool: 's3.put_object', summary: 'Uploaded first dump: pg/app-latest.sql.gz (412 MB)' })],
        [12_000, draft('task.answered', { task: t }, { text: 'Nightly backups run at 02:30 and land in s3://kj-backups/pg/. Copies expire after 14 days.' })],
        [14_500, draft('task.verification', { task: t }, { result: 'passed', method: 'independent', check: 'Fetched the uploaded object\u2019s checksum from S3 and compared it with the local file. Read back the lifecycle rule.', command: 'aws s3api head-object --bucket kj-backups --key pg/app-latest.sql.gz --query ETag; md5sum app-latest.sql.gz', output: '"9c2e41b07fd3a1e5"\n9c2e41b07fd3a1e5  app-latest.sql.gz' })],
        [15_000, draft('goal.checked', { goal: 'g-backup' }, { status: 'holding', observed: 'Latest copy uploaded today, 14-day expiry set', command: 'aws s3 ls s3://kj-backups/pg/', output: '412 MiB  app-latest.sql.gz' })],
        [15_500, draft('task.completed', { task: t }, { summary: 'Backups configured and first copy verified offsite.' })],
      )
      const disk = s.incidents[DISK_INCIDENT]
      if (disk?.decision?.decided?.optionId === 'snapshot' && !disk.resolved) {
        const ref = { incident: DISK_INCIDENT, request: DISK_DECISION }
        items.push(
          [18_000, draft('incident.step', ref, { kind: 'change', summary: 'Snapshot of staging-db uploaded to s3://kj-backups/volumes/', command: 'docker run --rm -v staging-db:/v alpine tar cz /v | aws s3 cp - s3://kj-backups/volumes/staging-db.tgz', output: 'ok' })],
          [20_000, draft('incident.step', ref, { kind: 'change', summary: 'Deleted volume staging-db', command: 'docker volume rm staging-db', output: 'staging-db' })],
          [22_000, draft('incident.verified', ref, { check: 'Snapshot readable in S3; /var at 12% and flat.', command: 'aws s3 ls s3://kj-backups/volumes/; df --output=pcent /var', output: '1.9 GiB staging-db.tgz\nUse%\n 12%' })],
          [22_500, draft('incident.resolved', ref, { summary: 'Logs capped, staging-db snapshotted offsite and removed.' })],
        )
      }
    }
    this.schedule(items)
    return { ok: true as const }
  }
}

const g = globalThis as unknown as { __operatorLog?: OperatorLog }

export function getLog() {
  g.__operatorLog ??= new OperatorLog()
  return g.__operatorLog
}

export function resetLog() {
  g.__operatorLog = new OperatorLog()
  return g.__operatorLog
}
