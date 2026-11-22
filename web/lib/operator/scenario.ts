import { draft, type EventDraft } from './types'

const M = 60_000
const H = 60 * M
const D = 24 * H

export const SKILL_ID = 's-failed-services'
export const PRUNE_TASK = 't-prune'
export const BACKUP_TASK = 't-backup'
export const DISK_INCIDENT = 'i-disk'
export const S3_REQUEST = 'r-s3'
export const DISK_DECISION = 'r-disk'
export const CREATE_SKILL = 's-create-skill'
export const HTTPS_SKILL = 's-https-subdomain'
export const DO_CONNECTOR = 'c-digitalocean'
export const S3_CONNECTOR = 'c-aws-s3'
export const SETUP_TASK = 't-setup'
export const STATUS_TASK = 't-status'
export const API_TASK = 't-api'
export const MEM_INGRESS = 'm-ingress'
export const MEM_DB = 'm-postgres'
export const MEM_TTL = 'm-dns-ttl'
export const MEM_PHP = 'm-php-pool'
export const MEM_API = 'm-api-kj-dev'
export const DISK_SKILL = 's-reclaim-disk'
export const API_PROJECT = 'p-api'
export const DISK_REV = { id: DISK_SKILL, revision: 'd72c4a9' }
const VPS_IP = '46.101.23.7'
const CATALOG = 'github.com/kj-dev/operator-catalog'
const src = (path: string) => ({ repo: CATALOG, path })

/** History up to the moment the owner opens the app. Timestamps are relative to `now`. */
const HTTPS_V1 = [
  'Read the ingress memory to confirm Caddy terminates TLS',
  'Check the zone for an existing record; stop and ask if one exists',
  'Create the A record with the owner\u2019s TTL preference',
  'Add a site block to /etc/caddy/Caddyfile, validate, and reload',
  'Confirm DNS on 1.1.1.1 and read the certificate from outside',
]

const HTTPS_V2 = [
  HTTPS_V1[0],
  HTTPS_V1[1],
  HTTPS_V1[2],
  'Wait until 1.1.1.1 resolves the record (poll every 6 s, give up after 10 min)',
  HTTPS_V1[3],
  'Confirm DNS, the certificate, and the backend response from outside',
]

export function seedHistory(now: number): EventDraft[] {
  const at = (ago: number) => new Date(now - ago).toISOString()
  const e: EventDraft[] = []

  // Standing goals, set two weeks ago.
  const goals: [string, string, string][] = [
    ['g-services', 'All enabled services stay active', 'systemctl --failed --no-legend'],
    ['g-tls', 'TLS certificate for kj.dev valid for more than 14 days', 'openssl x509 -enddate'],
    ['g-disk', 'Every mount stays under 80% used', 'df --output=target,pcent'],
    ['g-backup', 'Postgres backed up nightly, 14 days kept offsite', 'aws s3 ls s3://kj-backups/pg/'],
  ]
  for (const [id, text, check] of goals) {
    e.push(draft('goal.standing', { goal: id }, { text, check }, at(14 * D)))
  }

  // Shipped with the operator: the skill it uses to build every other skill.
  e.push(
    draft(
      'skill.installed',
      { skill: CREATE_SKILL },
      {
        name: 'create-skill',
        purpose:
          'Turn a request no existing skill covers into a new skill: write the procedure, capture fixtures from this VPS, write tests, and commit it to the skills repo.',
        revision: '9b2d0e1',
        foundational: true,
        source: 'operator base image v1.4.0',
        catalog: src('skills/create-skill/SKILL.md'),
        procedure: [
          'Search installed skills; stop and reuse one if it already covers the request',
          'Write the procedure as numbered steps with the exact commands',
          'Capture fixtures from this VPS into /var/lib/operator/skills/<name>/fixtures',
          'Write tests against the fixtures and run them',
          'Commit to the catalog only if every test passes',
          'Activate the committed revision and run it on the request that triggered it',
        ],
      },
      at(14 * D - 60_000),
    ),
    draft(
      'skill.self_tested',
      { skill: CREATE_SKILL },
      {
        task: '',
        revision: '9b2d0e1',
        authoredBy: 'shipped with the operator and re-run on this VPS at install',
        tests: [
          { name: 'Refuses to build a duplicate', input: 'request covered by an installed skill', expected: 'points to the existing skill', passed: true },
          { name: 'Writes tests before committing', input: 'new procedure', expected: 'commit blocked until tests pass', passed: true },
          { name: 'Fixtures stay local', input: 'journal excerpt with hostnames', expected: 'stored under /var/lib/operator/skills, not uploaded', passed: true },
        ],
      },
      at(14 * D - 70_000),
    ),
    draft(
      'skill.installed',
      { skill: DISK_SKILL },
      {
        name: 'reclaim-disk-space',
        purpose: 'When a mount crosses its standing goal, find what is growing, free space that can be recovered, stop the growth, and confirm the mount is back under target.',
        revision: 'd72c4a9',
        foundational: false,
        source: 'operator base image v1.4.0',
        catalog: src('skills/reclaim-disk-space/SKILL.md'),
        procedure: [
          'Measure the mount and the growth rate: df, then du on the top directories twice, 60 s apart',
          'Classify each large item: recoverable (cache, unused images), growing (logs), or unknown',
          'Free recoverable space without asking; it can be pulled or rebuilt again',
          'Stop the growth at its source, such as a log size cap, and keep the old config',
          'Ask the owner before deleting anything that is unknown or cannot be recreated',
          'Re-measure for 10 minutes and confirm the mount stays under the goal',
        ],
      },
      at(14 * D - 72_000),
    ),
    draft(
      'skill.self_tested',
      { skill: DISK_SKILL },
      {
        task: '',
        revision: 'd72c4a9',
        authoredBy: 'shipped with the operator and re-run on this VPS at install',
        tests: [
          { name: 'Unused images are freed without asking', input: 'docker images with no containers', expected: 'docker image prune -a', passed: true },
          { name: 'Unlabelled volume is not deleted', input: 'unattached volume, no labels', expected: 'asks the owner', passed: true },
          { name: 'Growth is capped, not just truncated', input: 'json-file log growing 1 GB/h', expected: 'max-size set before truncate', passed: true },
        ],
      },
      at(14 * D - 74_000),
    ),
  )

  // Connectors configured at setup. Only names, scopes and fingerprints enter the log.
  e.push(
    draft(
      'connector.configured',
      { connector: DO_CONNECTOR },
      {
        name: 'DigitalOcean',
        provider: 'DigitalOcean API v2',
        scope: 'DNS records in the kj.dev zone only. Token scopes: domain:read, domain:update. No droplet, volume, or billing access.',
        manages: { label: 'DNS zone', value: 'kj.dev' },
        tools: [
          { name: 'dns.list_records', description: 'List records in the managed zone', access: 'read' },
          { name: 'dns.create_record', description: 'Add an A, AAAA, CNAME, or TXT record', access: 'write' },
          { name: 'dns.update_record', description: 'Change the value or TTL of an existing record', access: 'write' },
          { name: 'dns.delete_record', description: 'Remove a record (asks you first)', access: 'write' },
        ],
        credential: {
          label: 'Personal access token',
          storage: 'Operator vault on vps-fra-1 (/etc/operator/vault, root-only)',
          fingerprint: 'sha256:3fa18c02d9',
        },
        catalog: src('connectors/digitalocean.yaml'),
      },
      at(14 * D - 90_000),
    ),
    draft(
      'connector.configured',
      { connector: S3_CONNECTOR },
      {
        name: 'AWS S3',
        provider: 'Amazon S3, eu-central-1',
        scope: 'Bucket kj-backups only: s3:PutObject, s3:ListBucket, s3:PutLifecycleConfiguration.',
        manages: { label: 'Bucket', value: 'kj-backups' },
        tools: [
          { name: 's3.list', description: 'List objects under a prefix', access: 'read' },
          { name: 's3.put_object', description: 'Upload a file', access: 'write' },
          { name: 's3.put_lifecycle', description: 'Set expiry rules on a prefix', access: 'write' },
        ],
        credential: {
          label: 'AWS access key for kj-backups',
          storage: 'Operator vault on vps-fra-1 (/etc/operator/vault, root-only)',
          request: S3_REQUEST,
        },
        catalog: src('connectors/aws-s3.yaml'),
      },
      at(14 * D - 95_000),
    ),
  )

  // Onboarding: the owner explains the box and the operator writes it down.
  e.push(
    draft(
      'owner.message',
      { task: SETUP_TASK },
      {
        text: 'Caddy fronts everything on this box and handles certificates. Postgres 16 holds the app database. Use TTL 300 for any DNS record you add.',
        intent: 'config',
      },
      at(14 * D - 2 * M),
    ),
    draft('task.received', { task: SETUP_TASK }, { title: 'Onboarding: how this VPS is laid out', source: 'owner' }, at(14 * D - 2 * M - 2_000)),
    draft(
      'task.step',
      { task: SETUP_TASK },
      {
        summary: 'Confirmed Caddy is the only process on :80 and :443',
        command: 'ss -ltnp "( sport = :80 or sport = :443 )"',
        output: 'LISTEN 0 4096 *:443 *:* users:(("caddy",pid=812))\nLISTEN 0 4096 *:80  *:* users:(("caddy",pid=812))',
        routine: true,
      },
      at(14 * D - 2 * M - 20_000),
    ),
    draft(
      'memory.written',
      { memory: MEM_INGRESS, task: SETUP_TASK },
      {
        title: 'Ingress: Caddy terminates TLS for every site',
        kind: 'fact',
        text: `Caddy 2.8 (caddy.service) is the only listener on :80 and :443 at ${VPS_IP}. Sites live in /etc/caddy/Caddyfile, one block per hostname. Caddy obtains and renews certificates itself via ACME (Let's Encrypt). Do not install certbot or nginx for new sites.`,
      },
      at(14 * D - 2 * M - 30_000),
    ),
    draft(
      'memory.written',
      { memory: MEM_DB, task: SETUP_TASK },
      {
        title: 'Postgres: database app on local 16',
        kind: 'fact',
        text: 'PostgreSQL 16 (postgresql@16-main). Application database is `app`, owned by role `app`. Data directory /var/lib/postgresql/16/main. Listens on 127.0.0.1:5432 only.',
      },
      at(14 * D - 2 * M - 32_000),
    ),
    draft(
      'memory.written',
      { memory: MEM_TTL, task: SETUP_TASK },
      {
        title: 'Owner preference: DNS TTL 300',
        kind: 'preference',
        text: 'Use TTL 300 seconds for any DNS record the operator creates in kj.dev, so mistakes can be corrected within five minutes.',
      },
      at(14 * D - 2 * M - 34_000),
    ),
    draft('task.completed', { task: SETUP_TASK }, { summary: 'Recorded 3 memory entries about this VPS.' }, at(14 * D - 2 * M - 40_000)),
  )

  // Ten days ago: first HTTPS subdomain. No skill covered it, so the operator built one.
  e.push(
    draft('owner.message', { task: STATUS_TASK }, { text: 'Serve the status page at status.kj.dev with HTTPS. It runs on port 3001.', intent: 'ask' }, at(10 * D)),
    draft('task.received', { task: STATUS_TASK }, { title: 'Serve status.kj.dev over HTTPS', source: 'owner' }, at(10 * D - 2_000)),
    draft('memory.read', { memory: MEM_INGRESS }, { task: STATUS_TASK, why: 'Find out what terminates TLS before adding a site' }, at(10 * D - 4_000)),
    draft(
      'task.understood',
      { task: STATUS_TASK },
      {
        interpretation: 'Add an A record for `status.kj.dev`, add a Caddy site that proxies to `localhost:3001`, and let Caddy obtain the certificate.',
        plan: ['Build a reusable skill for HTTPS subdomains', 'Create the DNS record', 'Add the Caddy site and reload', 'Verify DNS and the certificate from outside'],
      },
      at(10 * D - 6_000),
    ),
    draft('skill.used', { skill: CREATE_SKILL }, { task: STATUS_TASK, revision: '9b2d0e1', input: 'Request: HTTPS subdomain behind Caddy', novelty: 'Built add-https-subdomain.' }, at(10 * D - 8_000)),
    draft(
      'skill.created',
      { skill: HTTPS_SKILL },
      {
        name: 'add-https-subdomain',
        purpose: 'Point a kj.dev subdomain at this VPS and serve it over HTTPS through Caddy: DNS record, Caddy site block, reload, then check DNS and the certificate from outside.',
        fromTask: STATUS_TASK,
        revision: '3e07b18',
        builtWith: { id: CREATE_SKILL, revision: '9b2d0e1' },
        catalog: src('skills/add-https-subdomain/SKILL.md'),
        procedure: HTTPS_V1,
      },
      at(10 * D - 40_000),
    ),
    draft(
      'skill.self_tested',
      { skill: HTTPS_SKILL },
      {
        task: STATUS_TASK,
        revision: '3e07b18',
        authoredBy: 'written by the operator from a copy of this Caddyfile and a dry-run DNS zone',
        tests: [
          { name: 'Valid Caddyfile after adding a site', input: 'new block for test.kj.dev', expected: 'caddy validate passes', passed: true },
          { name: 'Existing record is not overwritten', input: 'A record already exists', expected: 'stops and asks', passed: true },
          { name: 'Uses the TTL preference', input: 'memory m-dns-ttl', expected: 'ttl=300', passed: true },
        ],
      },
      at(10 * D - 60_000),
    ),
    draft(
      'skill.activated',
      { skill: HTTPS_SKILL },
      { revision: '3e07b18', task: STATUS_TASK, reason: 'Passed 3 of 3 tests. The operator can now add HTTPS subdomains.' },
      at(10 * D - 62_000),
    ),
    draft(
      'skill.used',
      { skill: HTTPS_SKILL },
      {
        task: STATUS_TASK,
        revision: '3e07b18',
        input: 'status.kj.dev → localhost:3001',
        novelty: 'First run, on the request that caused it to be built.',
      },
      at(10 * D - 64_000),
    ),
    draft(
      'connector.used',
      { connector: DO_CONNECTOR },
      {
        task: STATUS_TASK,
        tool: 'dns.create_record',
        summary: 'Created status.kj.dev',
        record: { zone: 'kj.dev', name: 'status', type: 'A', value: VPS_IP, ttl: 300, change: 'created' },
      },
      at(10 * D - 70_000),
    ),
    draft(
      'task.verification',
      { task: STATUS_TASK },
      {
        result: 'passed',
        method: 'independent',
        check: 'Resolved through a public resolver and fetched the certificate over the internet, not through Caddy\u2019s own status.',
        command: 'dig +short status.kj.dev @1.1.1.1; curl -sI https://status.kj.dev | head -1',
        output: `${VPS_IP}\nHTTP/2 200`,
      },
      at(10 * D - 3 * M),
    ),
    draft('task.completed', { task: STATUS_TASK }, { summary: 'status.kj.dev live over HTTPS.' }, at(10 * D - 3 * M - 2_000)),
  )

  // Seven days ago: the operator meets a new kind of question and builds a skill.
  const origin = 't-0415'
  e.push(
    draft('owner.message', { task: origin }, { text: 'Which services failed this week?', intent: 'ask' }, at(7 * D)),
    draft('task.received', { task: origin }, { title: 'Which services failed this week?', source: 'owner' }, at(7 * D - 2_000)),
    draft(
      'task.understood',
      { task: origin },
      {
        interpretation: 'List units that entered a failed state in the last 7 days, with first failure, restart count, and likely cause.',
        plan: ['Read systemd state and journal', 'Group failures by unit', 'Attribute a cause from the surrounding log lines'],
      },
      at(7 * D - 5_000),
    ),
    draft(
      'task.step',
      { task: origin },
      { summary: 'No existing skill covers this. Building one so the next request is consistent.' },
      at(7 * D - 9_000),
    ),
    draft('skill.used', { skill: CREATE_SKILL }, { task: origin, revision: '9b2d0e1', input: 'Request: summarize failed services', novelty: 'Built summarize-failed-services.' }, at(7 * D - 10_000)),
    draft(
      'skill.created',
      { skill: SKILL_ID },
      {
        name: 'summarize-failed-services',
        purpose: 'Turn systemd state and the journal into a short list of failed units: first failure, restarts, and likely cause.',
        fromTask: origin,
        revision: 'c51d8e0',
        builtWith: { id: CREATE_SKILL, revision: '9b2d0e1' },
        catalog: src('skills/summarize-failed-services/SKILL.md'),
        procedure: [
          'List failed units: systemctl --failed',
          'Read errors for the window: journalctl --since <window> -p err',
          'Group by unit; record first failure and restart count',
          'Attribute a cause from the 20 log lines before each failure',
          'Mark units that are active again as recovered, not failing',
        ],
      },
      at(7 * D - 40_000),
    ),
    draft(
      'skill.self_tested',
      { skill: SKILL_ID },
      {
        task: origin,
        revision: 'c51d8e0',
        authoredBy: 'written by the operator from journal fixtures captured on this VPS',
        tests: [
          { name: 'Single crashed unit', input: 'certbot-renew.service exit 1', expected: '1 failure, cause: DNS lookup', passed: true },
          { name: 'Restart loop', input: 'node-exporter restarted 14x', expected: '1 failure, 14 restarts, port conflict', passed: true },
          { name: 'Recovered unit is not reported as failing', input: 'redis failed then active', expected: 'listed as recovered', passed: true },
          { name: 'Quiet week', input: 'no failed units', expected: '"No failures"', passed: true },
        ],
      },
      at(7 * D - 70_000),
    ),
    draft(
      'skill.activated',
      { skill: SKILL_ID },
      { revision: 'c51d8e0', task: origin, reason: 'Passed 4 of 4 tests.' },
      at(7 * D - 72_000),
    ),
    draft(
      'skill.used',
      { skill: SKILL_ID },
      { task: origin, revision: 'c51d8e0', input: 'Last 7 days of systemd and journal', novelty: 'First run, on the request that caused it to be built.' },
      at(7 * D - 74_000),
    ),
    draft(
      'task.answered',
      { task: origin },
      { text: '2 failed: certbot-renew.service (exit 1, DNS lookup failed) and node-exporter (restart loop, port 9100 in use).' },
      at(7 * D - 80_000),
    ),
    draft(
      'task.verification',
      { task: origin },
      {
        result: 'passed',
        method: 'self',
        check: 'Both units appear in the same journal query the skill read.',
        command: 'journalctl --since -7d -p err -o cat | grep -E "certbot|node-exporter"',
        output: 'certbot-renew.service: Main process exited, status=1/FAILURE\nnode-exporter.service: Start request repeated too quickly.',
      },
      at(7 * D - 85_000),
    ),
    draft('task.completed', { task: origin }, { summary: 'Reported 2 failed services.' }, at(7 * D - 86_000)),
  )

  // Five days ago: a certificate renewal raced DNS, so the skill was revised.
  e.push(
    draft(
      'skill.revised',
      { skill: HTTPS_SKILL },
      {
        revision: 'a41f9c2',
        summary: 'Wait until 1.1.1.1 resolves the new record before reloading Caddy, so the first ACME attempt does not fail on an unpropagated record.',
        procedure: HTTPS_V2,
      },
      at(5 * D),
    ),
    draft(
      'skill.self_tested',
      { skill: HTTPS_SKILL },
      {
        task: '',
        revision: 'a41f9c2',
        authoredBy: 're-run by the operator on the new revision, plus one test for the change',
        tests: [
          { name: 'Valid Caddyfile after adding a site', input: 'new block for test.kj.dev', expected: 'caddy validate passes', passed: true },
          { name: 'Existing record is not overwritten', input: 'A record already exists', expected: 'stops and asks', passed: true },
          { name: 'Uses the TTL preference', input: 'memory m-dns-ttl', expected: 'ttl=300', passed: true },
          { name: 'Waits for public DNS before reload', input: 'record not yet on 1.1.1.1', expected: 'no reload until it resolves', passed: true },
        ],
      },
      at(5 * D - 30_000),
    ),
    draft(
      'skill.activated',
      { skill: HTTPS_SKILL },
      { revision: 'a41f9c2', reason: 'Passed 4 of 4 tests, including the new propagation test. Replaces 3e07b18.' },
      at(5 * D - 32_000),
    ),
  )

  // Two days ago: the DNS and TLS run.
  const a0 = 2 * D + 3 * H
  e.push(
    draft('owner.message', { task: API_TASK }, { text: 'Put api.kj.dev on this box with HTTPS. The API listens on 8080.', intent: 'ask' }, at(a0)),
    draft('task.received', { task: API_TASK, project: API_PROJECT }, { title: 'Serve api.kj.dev over HTTPS from this VPS', source: 'owner' }, at(a0 - 2_000)),
    draft(
      'project.registered',
      { project: API_PROJECT, task: API_TASK },
      {
        name: 'kj API',
        description: 'The kj.dev JSON API. A Go service under systemd as kj-api.service, listening on 127.0.0.1:8080.',
        hostname: 'api.kj.dev',
        repo: 'github.com/kj-dev/api',
        upstream: 'localhost:8080',
        catalog: src('projects/api.yaml'),
        memory: MEM_API,
      },
      at(a0 - 2_500),
    ),
    draft('memory.read', { memory: MEM_INGRESS }, { task: API_TASK, why: 'Identify the ingress: which process terminates TLS and where sites are configured' }, at(a0 - 3_000)),
    draft('memory.read', { memory: MEM_TTL }, { task: API_TASK, why: 'TTL for the new record' }, at(a0 - 3_500)),
    draft(
      'task.understood',
      { task: API_TASK },
      {
        interpretation: 'Create an A record for `api.kj.dev` pointing at this VPS, add a Caddy site that proxies to `localhost:8080`, and let Caddy obtain the certificate.',
        plan: ['Create the A record in kj.dev', 'Wait for public DNS to resolve it', 'Add the Caddy site and reload', 'Verify DNS, the certificate, and the API response from outside'],
      },
      at(a0 - 5_000),
    ),
    draft(
      'skill.used',
      { skill: HTTPS_SKILL },
      {
        task: API_TASK,
        revision: 'a41f9c2',
        input: 'api.kj.dev → localhost:8080',
        novelty: 'First run of revision a41f9c2, and the first backend that is not a static or Node page. Neither case is in the skill\u2019s tests.',
      },
      at(a0 - 7_000),
    ),
    draft(
      'connector.used',
      { connector: DO_CONNECTOR },
      { task: API_TASK, tool: 'dns.list_records', summary: 'Checked that api.kj.dev did not already exist' },
      at(a0 - 9_000),
    ),
    draft(
      'connector.used',
      { connector: DO_CONNECTOR },
      {
        task: API_TASK,
        tool: 'dns.create_record',
        summary: 'Created api.kj.dev',
        record: { zone: 'kj.dev', name: 'api', type: 'A', value: VPS_IP, ttl: 300, change: 'created' },
      },
      at(a0 - 11_000),
    ),
    draft(
      'task.step',
      { task: API_TASK },
      { summary: 'Public DNS resolved the record after 48 s', command: 'until dig +short api.kj.dev @1.1.1.1 | grep -q .; do sleep 6; done', output: VPS_IP, routine: true },
      at(a0 - 60_000),
    ),
    draft(
      'task.step',
      { task: API_TASK },
      {
        summary: 'Added the api.kj.dev site to the Caddyfile and reloaded Caddy',
        command: 'caddy validate --config /etc/caddy/Caddyfile && systemctl reload caddy',
        output: 'Valid configuration',
      },
      at(a0 - 70_000),
    ),
    draft(
      'task.step',
      { task: API_TASK },
      {
        summary: 'Caddy obtained a Let\u2019s Encrypt certificate for api.kj.dev',
        command: 'journalctl -u caddy --since -2min -o cat | grep "certificate obtained"',
        output: '{"level":"info","msg":"certificate obtained successfully","identifier":"api.kj.dev"}',
      },
      at(a0 - 95_000),
    ),
    draft(
      'task.answered',
      { task: API_TASK },
      { text: `api.kj.dev resolves to ${VPS_IP} and serves kj-api over HTTPS. The certificate expires Feb 18, 2027, and Caddy is configured to renew it.` },
      at(a0 - 100_000),
    ),
    draft(
      'task.verification',
      { task: API_TASK },
      {
        result: 'passed',
        method: 'independent',
        check: 'DNS, certificate expiry, and the API response were checked externally. The operator checked renewal configuration on the VPS.',
        command: 'dig +short api.kj.dev @1.1.1.1; openssl s_client …; curl -s https://api.kj.dev/healthz',
        output: `${VPS_IP}\nissuer=C=US, O=Let's Encrypt, CN=E6\nHTTP/2 200 {"service":"kj-api"}`,
        claims: [
          {
            claim: `api.kj.dev resolves to this VPS (${VPS_IP})`,
            method: 'independent',
            command: 'dig +short api.kj.dev @1.1.1.1',
            output: VPS_IP,
          },
          {
            claim: 'Certificate presented by api.kj.dev expires Feb 18, 2027',
            method: 'independent',
            command: 'echo | openssl s_client -connect api.kj.dev:443 -servername api.kj.dev 2>/dev/null | openssl x509 -noout -issuer -enddate',
            output: "issuer=C=US, O=Let's Encrypt, CN=E6\nnotAfter=Feb 18 07:02:41 2027 GMT",
          },
          {
            claim: 'Renewal configured in Caddy',
            method: 'self',
            command: "caddy adapt --config /etc/caddy/Caddyfile | jq '.apps.http.servers[].automatic_https, .apps.tls'",
            output: 'null\nnull\n\n# no automatic_https.disable and no custom tls policy:\n# Caddy manages and renews api.kj.dev via ACME (default issuer)',
          },
          {
            claim: 'The public hostname serves kj-api',
            method: 'independent',
            command: 'curl -si https://api.kj.dev/healthz',
            output:
              'HTTP/2 200\ncontent-type: application/json\nvia: 1.1 Caddy\n\n{"service":"kj-api","version":"2.14.1","status":"ok"}',
          },
        ],
      },
      at(a0 - 2 * M),
    ),
    draft(
      'skill.verified',
      { skill: HTTPS_SKILL },
      {
        task: API_TASK,
        revision: 'a41f9c2',
        check: 'DNS, certificate, and the API health response read from outside the VPS, without the skill.',
        command: 'dig @1.1.1.1; openssl s_client; curl https://api.kj.dev/healthz',
        output: `api.kj.dev A ${VPS_IP}\nLet's Encrypt E6, valid to Feb 18 2027\n{"service":"kj-api","status":"ok"}`,
        matched: 'Record, certificate, and backend all match what the skill reported.',
      },
      at(a0 - 2 * M - 1_000),
    ),
    draft(
      'memory.written',
      { memory: MEM_API, task: API_TASK },
      {
        title: 'Site: api.kj.dev',
        kind: 'fact',
        text: `api.kj.dev is an A record to ${VPS_IP} (TTL 300) in the kj.dev zone on DigitalOcean. Caddy proxies it to localhost:8080. The certificate is issued by Let\u2019s Encrypt through Caddy and expires Feb 18 2027 unless renewed. Created on owner request.`,
      },
      at(a0 - 2 * M - 3_000),
    ),
    draft('task.completed', { task: API_TASK }, { summary: 'api.kj.dev live over HTTPS.' }, at(a0 - 2 * M - 5_000)),
  )

  // Last evening: owner hands over work and leaves.
  const ev = 9 * H + 25 * M
  e.push(
    draft(
      'owner.message',
      { task: BACKUP_TASK },
      { text: 'Back up Postgres every night to my S3 bucket kj-backups and keep 14 days.', intent: 'ask' },
      at(ev),
    ),
    draft(
      'task.received',
      { task: BACKUP_TASK },
      { title: 'Nightly Postgres backups to S3, keep 14 days', source: 'owner' },
      at(ev - 3_000),
    ),
    draft('memory.read', { memory: MEM_DB }, { task: BACKUP_TASK, why: 'Which database to dump and as which role' }, at(ev - 5_000)),
    draft(
      'task.understood',
      { task: BACKUP_TASK },
      {
        interpretation:
          'Dump the `app` database every night at 02:30, upload it to s3://kj-backups/pg/, expire copies after 14 days, and tell you if a night is missed.',
        plan: [
          'Install a systemd timer for 02:30',
          'Write the dump + upload script with a checksum',
          'Set an S3 lifecycle rule for 14-day expiry',
          'Run once now and confirm the object lands',
        ],
      },
      at(ev - 8_000),
    ),
    draft(
      'operator.message',
      { task: BACKUP_TASK },
      { text: 'Got it. Starting with the timer. I will need S3 credentials for the upload step.' },
      at(ev - 10_000),
    ),
    draft(
      'task.step',
      { task: BACKUP_TASK },
      {
        summary: 'Created pg-backup.service and pg-backup.timer',
        command: 'systemctl list-timers pg-backup.timer',
        output: 'NEXT                LEFT     UNIT             ACTIVATES\n02:30:00 tomorrow   ~5h      pg-backup.timer  pg-backup.service',
        routine: true,
      },
      at(ev - 50_000),
    ),
    draft(
      'task.step',
      { task: BACKUP_TASK },
      {
        summary: 'Local dump works: 412 MB in 41 s',
        command: 'pg_dump -Fc app | gzip > /var/backups/pg/app-test.sql.gz',
        output: '-rw-r----- 1 postgres postgres 412M app-test.sql.gz\nreal 0m41.2s',
        routine: true,
      },
      at(ev - 2 * M),
    ),
    draft(
      'credential.requested',
      { task: BACKUP_TASK, request: S3_REQUEST },
      {
        label: 'AWS access key for kj-backups',
        why: 'Upload nightly dumps and set the 14-day lifecycle rule.',
        destination: 's3.eu-central-1.amazonaws.com, bucket kj-backups only',
        storage: 'Operator vault on vps-fra-1 (/etc/operator/vault, root-only). Never written to chat, logs, or event history.',
        scope: 's3:PutObject, s3:ListBucket, s3:PutLifecycleConfiguration on kj-backups',
        fields: [
          { name: 'access_key_id', label: 'Access key ID', secret: false },
          { name: 'secret_access_key', label: 'Secret access key', secret: true },
        ],
      },
      at(ev - 2 * M - 5_000),
    ),
    draft('task.waiting', { task: BACKUP_TASK }, { on: 'credential' }, at(ev - 2 * M - 6_000)),
    draft(
      'goal.checked',
      { goal: 'g-backup' },
      {
        status: 'blocked',
        observed: 'No offsite copy yet. Waiting on S3 credential.',
        command: 'aws s3 ls s3://kj-backups/pg/',
        output: 'Unable to locate credentials.',
      },
      at(ev - 2 * M - 7_000),
    ),
    draft('owner.left', {}, { note: 'Owner closed the app' }, at(9 * H + 20 * M)),
  )

  // Routine overnight checks.
  e.push(
    draft(
      'goal.checked',
      { goal: 'g-tls' },
      {
        status: 'holding',
        observed: 'Valid for 61 more days',
        command: 'echo | openssl s_client -connect kj.dev:443 2>/dev/null | openssl x509 -noout -enddate',
        output: 'notAfter=Jan 22 09:14:03 2027 GMT',
      },
      at(8 * H),
    ),
  )

  // 02:13-ish: resolved incident.
  const inc = 'i-502'
  const t0 = 5 * H + 47 * M
  e.push(
    draft(
      'incident.opened',
      { incident: inc },
      {
        resource: 'php8.3-fpm behind nginx (kj.dev)',
        symptom: '38% of requests to kj.dev returned 502 for 4 minutes',
        detectedBy: 'Services check found php8.3-fpm failed. Nginx error log confirms upstream resets.',
        severity: 'high',
      },
      at(t0),
    ),
    draft(
      'goal.checked',
      { goal: 'g-services' },
      {
        status: 'drift',
        observed: 'php8.3-fpm.service failed',
        command: 'systemctl --failed --no-legend',
        output: 'php8.3-fpm.service loaded failed failed The PHP 8.3 FastCGI Process Manager',
      },
      at(t0 - 5_000),
    ),
    draft(
      'incident.step',
      { incident: inc },
      {
        kind: 'diagnose',
        summary: 'Kernel OOM killer stopped php-fpm workers',
        command: 'journalctl -k --since -10min | grep -i "killed process"',
        output:
          'Out of memory: Killed process 48211 (php-fpm8.3) total-vm:412880kB, anon-rss:59232kB\nOut of memory: Killed process 48219 (php-fpm8.3) total-vm:409116kB, anon-rss:58904kB\n(+11 more)',
      },
      at(t0 - 40_000),
    ),
    draft(
      'incident.step',
      { incident: inc },
      {
        kind: 'diagnose',
        summary: 'Pool allows 40 workers at ~58 MB each: 2.3 GB, more than the 2 GB free',
        command: 'grep max_children /etc/php/8.3/fpm/pool.d/www.conf; free -m',
        output: 'pm.max_children = 40\n               total   used   free\nMem:            3936   1862   2074',
      },
      at(t0 - 70_000),
    ),
    draft(
      'incident.step',
      { incident: inc },
      {
        kind: 'change',
        summary: 'Lowered pm.max_children from 40 to 24 (backup kept as www.conf.bak)',
        command: 'diff www.conf.bak www.conf',
        output: '< pm.max_children = 40\n---\n> pm.max_children = 24',
      },
      at(t0 - 2 * M),
    ),
    draft(
      'incident.step',
      { incident: inc },
      {
        kind: 'change',
        summary: 'Restarted php8.3-fpm',
        command: 'systemctl restart php8.3-fpm && systemctl is-active php8.3-fpm',
        output: 'active',
      },
      at(t0 - 2 * M - 10_000),
    ),
    draft(
      'incident.verified',
      { incident: inc },
      {
        check: '50 of 50 requests returned 200 over 5 minutes. No new OOM kills. 410 MB memory headroom at peak.',
        command: 'for i in $(seq 50); do curl -s -o /dev/null -w "%{http_code}\\n" https://kj.dev/; sleep 6; done | sort | uniq -c',
        output: '     50 200',
      },
      at(t0 - 8 * M),
    ),
    draft(
      'incident.resolved',
      { incident: inc },
      { summary: 'kj.dev served normally again after 8 minutes. Cause: worker pool sized larger than available RAM.' },
      at(t0 - 8 * M - 5_000),
    ),
    draft(
      'memory.written',
      { memory: MEM_PHP, incident: inc },
      {
        title: 'php8.3-fpm pool: keep max_children at 24',
        kind: 'procedure',
        text: 'Each php-fpm worker uses about 58 MB. With 2 GB free, more than 24 workers triggers the OOM killer and kj.dev returns 502. If traffic needs more workers, add RAM first. The old value (40) is kept in www.conf.bak.',
      },
      at(t0 - 8 * M - 7_000),
    ),
    draft(
      'goal.checked',
      { goal: 'g-services' },
      {
        status: 'holding',
        observed: 'All 31 enabled services active',
        command: 'systemctl --failed --no-legend | wc -l',
        output: '0',
      },
      at(t0 - 8 * M - 10_000),
    ),
  )

  // 04:40-ish: disk incident that needs a decision.
  const d0 = 3 * H + 20 * M
  e.push(
    draft(
      'incident.opened',
      { incident: DISK_INCIDENT },
      {
        resource: '/var on vps-fra-1 (80 GB volume)',
        symptom: '/var reached 91% and is growing about 1.2 GB per hour',
        detectedBy: 'Standing goal: every mount under 80%.',
        severity: 'medium',
      },
      at(d0),
    ),
    draft(
      'goal.checked',
      { goal: 'g-disk' },
      {
        status: 'drift',
        observed: '/var at 91%',
        command: 'df --output=target,pcent /var',
        output: 'Mounted on Use%\n/var        91%',
      },
      at(d0 - 2_000),
    ),
    draft(
      'skill.used',
      { skill: DISK_SKILL },
      {
        incident: DISK_INCIDENT,
        revision: 'd72c4a9',
        input: '/var at 91%, goal 80%',
        novelty: 'Standard case: the mount crossed its standing goal.',
      },
      at(d0 - 4_000),
    ),
    draft(
      'incident.step',
      { incident: DISK_INCIDENT },
      {
        kind: 'diagnose',
        skill: DISK_REV,
        summary: '38 GB is unused Docker images',
        command: 'docker system df',
        output:
          'TYPE            TOTAL   ACTIVE   SIZE      RECLAIMABLE\nImages          67      6        44.1GB    38.2GB (86%)\nContainers      6       6        1.1GB     0B\nLocal Volumes   4       3        13.4GB    12.0GB (89%)',
      },
      at(d0 - 60_000),
    ),
    draft(
      'incident.step',
      { incident: DISK_INCIDENT },
      {
        kind: 'diagnose',
        skill: DISK_REV,
        summary: 'Container ingest-worker has a 14 GB log, growing 1.2 GB/h, with no rotation',
        command: 'du -h /var/lib/docker/containers/*/*-json.log | sort -h | tail -1',
        output: '14G  /var/lib/docker/containers/7f3c…/7f3c…-json.log',
      },
      at(d0 - 2 * M),
    ),
    draft(
      'incident.step',
      { incident: DISK_INCIDENT },
      {
        kind: 'diagnose',
        skill: DISK_REV,
        summary: 'Volume staging-db (12 GB) has not been attached to any container for 9 days',
        command: 'docker volume inspect staging-db --format "{{.CreatedAt}} {{.Labels}}"',
        output: '2026-10-02T11:40:12Z map[]',
      },
      at(d0 - 3 * M),
    ),
    draft(
      'task.received',
      { task: PRUNE_TASK, incident: DISK_INCIDENT },
      { title: 'Remove unused Docker images', source: 'incident' },
      at(d0 - 4 * M),
    ),
    draft(
      'task.understood',
      { task: PRUNE_TASK },
      {
        interpretation:
          'Free space now with the reversible step: delete unused images (they can be pulled again). Leave volumes and logs alone until you decide.',
        plan: ['List images not used by any container', 'Remove them in batches', 'Confirm /var usage dropped'],
      },
      at(d0 - 4 * M - 3_000),
    ),
    draft(
      'incident.decision_needed',
      { incident: DISK_INCIDENT, request: DISK_DECISION },
      {
        known: [
          'Removing unused images frees about 38 GB and is reversible (they can be pulled again). Already in progress.',
          'ingest-worker logs at debug level since Nov 13 and will refill the disk in about 30 hours without a cap.',
          'staging-db is 12 GB, unattached for 9 days, has no labels and no backup.',
        ],
        uncertain: [
          'Whether staging-db holds data you still need. Nothing on the VPS says what it is for.',
          'Why ingest-worker switched to debug logging. It may be intentional.',
        ],
        question: 'Can I cap ingest-worker logs at 500 MB, and what should happen to staging-db?',
        options: [
          {
            id: 'cap',
            label: 'Cap logs, keep staging-db',
            consequence: 'Stops the growth. /var settles near 45%. staging-db stays as is.',
            recommended: true,
          },
          {
            id: 'both',
            label: 'Cap logs and delete staging-db',
            consequence: 'Frees another 12 GB. staging-db is gone permanently, with no backup.',
          },
          {
            id: 'snapshot',
            label: 'Cap logs, snapshot staging-db to S3 first',
            consequence: 'Safest. The snapshot waits for the S3 credential you have not supplied yet.',
          },
        ],
      },
      at(d0 - 5 * M),
    ),
    draft(
      'task.step',
      { task: PRUNE_TASK },
      {
        summary: 'Found 61 images not used by any container',
        command: 'docker images --filter dangling=true -q | wc -l',
        output: '61',
        routine: true,
      },
      at(d0 - 5 * M - 10_000),
    ),
  )

  // 06:00: scheduled morning report reuses the skill on new input.
  const r = 'cron-morning'
  const r0 = 2 * H
  e.push(
    draft('task.received', { task: r }, { title: 'Morning report: failed services, last 24 h', source: 'schedule' }, at(r0)),
    draft(
      'task.understood',
      { task: r },
      {
        interpretation: 'Summarize failed services for the last 24 hours using summarize-failed-services.',
        plan: ['Run the skill on the last 24 h', 'Check its result against systemd directly'],
      },
      at(r0 - 2_000),
    ),
    draft(
      'skill.used',
      { skill: SKILL_ID },
      {
        task: r,
        revision: 'c51d8e0',
        input: 'Last 24 h of journal and systemd state',
        novelty:
          'Input includes OOM kills and a oneshot timer unit (apt-daily-upgrade). Neither appears in the skill\u2019s own tests.',
      },
      at(r0 - 5_000),
    ),
    draft('memory.read', { memory: MEM_PHP }, { task: r, why: 'Explain the overnight php8.3-fpm failure without re-diagnosing it' }, at(r0 - 10_000)),
    draft(
      'task.answered',
      { task: r },
      {
        text: '1 failing now: apt-daily-upgrade.service (dpkg lock held by unattended-upgrades). php8.3-fpm failed overnight from OOM kills and recovered after the pool change.',
      },
      at(r0 - 20_000),
    ),
    draft(
      'task.verification',
      { task: r },
      {
        result: 'passed',
        method: 'independent',
        check: 'Compared the skill\u2019s result with systemd and the journal, queried separately without the skill.',
        command: 'systemctl --failed --no-legend; journalctl --since -24h -p err -o cat | grep -c "Failed with result"',
        output: 'apt-daily-upgrade.service loaded failed failed Daily apt upgrade and clean activities\n2',
      },
      at(r0 - 35_000),
    ),
    draft(
      'skill.verified',
      { skill: SKILL_ID },
      {
        task: r,
        revision: 'c51d8e0',
        check: 'Ground truth taken directly from systemd and the journal, without the skill.',
        command: 'systemctl --failed; journalctl --since -24h -p err',
        output: 'apt-daily-upgrade.service failed\nphp8.3-fpm.service failed (02:13), active since',
        matched: '2 of 2 failures matched. None missed, none invented.',
      },
      at(r0 - 36_000),
    ),
    draft('task.completed', { task: r }, { summary: 'Morning report delivered.' }, at(r0 - 37_000)),
  )

  return e
}

/** Remaining work on the prune task, delivered live after the owner arrives. */
export function liveScript(): [number, EventDraft][] {
  return [
    [
      7_000,
      draft(
        'task.step',
        { task: PRUNE_TASK },
        { summary: 'Removed 31 of 61 images', command: 'docker image prune -af --filter until=72h', output: 'Deleted Images: 31 …', routine: true },
      ),
    ],
    [
      15_000,
      draft(
        'task.step',
        { task: PRUNE_TASK },
        {
          summary: 'Removed 61 of 61 images, reclaimed 38.2 GB',
          command: 'docker image prune -af --filter until=72h',
          output: 'Total reclaimed space: 38.2GB',
        },
      ),
    ],
    [
      22_000,
      draft(
        'task.verification',
        { task: PRUNE_TASK },
        {
          result: 'passed',
          method: 'independent',
          check: '/var usage measured with df after the prune, not taken from Docker\u2019s own report.',
          command: 'df --output=pcent /var; docker system df --format "{{.Type}} {{.Reclaimable}}" | head -1',
          output: 'Use%\n 44%\nImages 0B',
        },
      ),
    ],
    [
      23_000,
      draft(
        'goal.checked',
        { goal: 'g-disk' },
        { status: 'holding', observed: '/var at 44%', command: 'df --output=target,pcent /var', output: 'Mounted on Use%\n/var        44%' },
      ),
    ],
    // Deliberately late: the answer is persisted after the verification. A view that
    // shows "the last thing that happened" would regress to "answered" here.
    [
      25_000,
      draft('task.answered', { task: PRUNE_TASK }, { text: 'Reclaimed 38.2 GB. /var is at 44%.' }),
    ],
    [26_000, draft('task.completed', { task: PRUNE_TASK }, { summary: 'Reclaimed 38.2 GB on /var.' })],
  ]
}
