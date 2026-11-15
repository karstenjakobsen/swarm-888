# VPS AI Operator

A development MVP for one administrator on one Linux host. React/Vite talks to a normal-user Fastify controller. A trusted privileged worker broker launches Codex, authentication, and script checks as a separate non-root execution account. Operator source, installed build, dependencies, configuration, and launch definitions belong exclusively to the owner’s external development and release process.

## Prerequisites and first start

Verified with Ubuntu 24.04, **Node 26.13.1**, npm 11.16.0, **Codex CLI 0.166.0**, and Chromium 159 through Playwright 1.65.1. Dependencies are pinned in `package-lock.json`. The maintained Node `node:sqlite` binding supplies SQLite, FTS5, WAL and the online backup API; no database server is needed.

Install Node 26.13.1 using your usual Node version manager (`nvm install && nvm use` reads `.nvmrc`). On Ubuntu/Debian, install the system library required by the pinned Node binary before running npm commands:

```sh
sudo apt-get update
sudo apt-get install -y libatomic1
```

If Node reports `libatomic.so.1: cannot open shared object file`, run those commands in your host terminal, where you can enter your sudo password, then retry the npm command. The application cannot diagnose this from JavaScript because the loader fails before Node starts. No system services, Docker, or global Codex installation are required.

As your normal development user:

```sh
npm ci
cp .env.example .env
chmod 600 .env
# Edit .env: set a unique ADMIN_PASSWORD with at least 12 characters.
npm run init
```

The default state directory is `~/.local/share/vps-ai-operator`, mode `0700`. Set an **absolute** `APP_STATE_DIR` in `.env` to use another persistent location. The application rejects source/build directories and `/tmp` for ordinary use. Database initialization and migrations also run at controller startup.

Start the web application as your normal user:

```sh
npm run dev
```

Open **http://127.0.0.1:5173** (or localhost) and log in with `ADMIN_PASSWORD`.

1. Click **Connect agent** in the top bar.
2. Complete the dedicated execution-account setup below, then click **Start worker**. The controller attempts a noninteractive sudo launch of the trusted broker. If the OS requires your password, copy the exact command shown in the panel and run it in your VPS terminal. The UI displays the agent’s non-root execution UID separately from the broker UID and only enables sign-in when operator protection is verified. An older unrestricted root worker must be stopped and replaced.
3. Click **Continue with ChatGPT**, copy the displayed one-time code, and open the linked OpenAI sign-in page.
4. Finish signing in. The panel verifies the account, switches to **Agent connected**, and resumes saved tasks automatically. Refreshing or closing the panel does not cancel sign-in. Cancel, expiry and retry are supported in the same UI.

ChatGPT sign-in uses the pinned app-server's supported [device-code authentication](https://developers.openai.com/codex/app-server#auth-endpoints). Device login must be enabled for your account/workspace. Credentials remain in the dedicated execution-account profile at `APP_EXECUTION_HOME/codex`; the UI receives only the transient verification code/link. Neither credentials nor login codes enter task history or searchable memory. A controller restart can recover a pending login from the surviving worker. The protected worker stays running throughout UI sign-in; no terminal authentication or restart is needed.

The web controller and frontend remain normal-user processes. The broker has no public TCP listener. A private, per-session MCP proxy exposes authorized operator tools to the agent without providing the master IPC token, administrator password, or controller environment. Memory, skills, project registration, and artifact publication go through these tools.

Browser sign-in is the ordinary authentication path. For an optional offline CLI login, stop the worker first, then launch `npm run auth -- --device-auth` through the same administrator environment used for the broker (explicit `APP_STATE_DIR`, `APP_CONTROLLER_UID`, and execution settings). Protected CLI login requires root only to drop to the dedicated execution account; Codex itself never authenticates as root. The default `npm run auth` reads an API key from stdin and does not put it in command arguments. Read-only `npm run auth -- status` uses the same protected profile. The temporary test-only configuration retains the unprivileged fixture CLI path.

`npm run build` checks TypeScript and builds the frontend into `dist/web`. For a built frontend, set `APP_ORIGINS=http://localhost:3001,http://127.0.0.1:3001` and run `npm run controller`; it serves both the built UI and authenticated API on port 3001.

## Dedicated execution account and operator protection

Production worker startup fails closed until all of these conditions hold: the broker is root; agent UID/GID identify an existing dedicated account different from root, the controller, and release owners; operator files and ancestors are not writable by that account (including effective ACL access); `.env` and controller credentials cannot be read by it; execution directories are canonical, separately owned, and outside operator source/controller state; privilege dropping is available. Agent commands run through `setpriv` with no supplementary groups, no capabilities, and no-new-privileges. The account must have no sudo grants or supplementary groups, including NSS-resolved groups.

Stop previous workers before changing the setup. As the VPS administrator, create a **new** dedicated account and stable parent directories (skip account creation only if an equivalent dedicated account already exists):

```sh
sudo useradd --system --user-group --no-create-home \
  --home-dir /var/lib/vps-ai-executor/user --shell /usr/sbin/nologin vps-ai-projects
sudo passwd --lock vps-ai-projects
sudo install -d -m 755 -o root -g root /srv/vps-ai-projects /var/lib/vps-ai-executor
sudo install -d -m 700 -o vps-ai-projects -g vps-ai-projects /var/lib/vps-ai-executor/user
id -u vps-ai-projects
id -g vps-ai-projects
```

The default `APP_EXECUTION_USER=vps-ai-projects` resolves that account’s UID/GID automatically. Keep `APP_PROTECT_OPERATOR=true`, `APP_PROJECTS_DIR=/srv/vps-ai-projects`, and `APP_EXECUTION_HOME=/var/lib/vps-ai-executor`. Set `APP_CONTROLLER_UID` to your normal controller user’s `id -u` if launching the broker manually; the UI supplies it. Alternatively, remove `APP_EXECUTION_USER` and set both `APP_EXECUTION_UID` and `APP_EXECUTION_GID` to an existing dedicated account’s numeric IDs. Partial or conflicting identity settings are rejected. The broker creates its dedicated Codex profile and project workspaces under the stable parents.

For project user services and timers, configure the dedicated user manager before enabling it. Replace `EXECUTION_UID` with the numeric UID printed above:

```sh
sudo install -d -m 755 /etc/systemd/system/user@EXECUTION_UID.service.d
sudo tee /etc/systemd/system/user@EXECUTION_UID.service.d/operator-protection.conf >/dev/null <<'UNIT'
[Service]
NoNewPrivileges=yes
CapabilityBoundingSet=
AmbientCapabilities=
UNIT
sudo systemctl daemon-reload
sudo loginctl enable-linger vps-ai-projects
sudo systemctl restart user@EXECUTION_UID.service
```

These commands affect only the new execution account. Do not grant it sudo, Docker/LXD sockets, writable operator directories, or deployment credentials that can modify the operator. The broker rejects an existing user service manager whose processes can regain privilege. Missing user-manager support leaves service/timer observations unknown with setup details; website HTTP checks remain available.

Run the operator from a release directory readable but not writable by the execution account. Keep `.env` mode `0600` and controller state mode `0700`; making release code readable must not expose administrator credentials. A checkout beneath a private home directory may not be traversable by that account; use an administrator-managed location such as `/opt/vps-ai-operator` for the installed release. Keep its source, dependencies, and executable files owned by the controller/release administrator. Operator changes are made externally and released by you. Workers have no self-update or operator-edit operation. Memory and application-owned skills remain editable through their dedicated tools.

Start the UI/controller as your normal user. In **Connect agent**, copy the generated worker command: it includes the correct state directory, controller UID, dedicated execution IDs, source-protection setting, and paths. The controller never launches itself as root. Do not use plain `sudo npm run worker`, which can select root’s home and a different state directory.

The old assumption that agent commands execute as unrestricted host root is deliberately removed. Root is limited to the trusted broker; project execution uses the dedicated account. This POC shares that account across projects and does not isolate projects from each other. A separate control-plane host remains the stronger option if you later require unrestricted root on project machines.

From your laptop, forward the loopback Vite port:

```sh
ssh -L 5173:127.0.0.1:5173 your-user@your-vps
```

Then open http://localhost:5173 or http://127.0.0.1:5173 locally. Vite proxies `/api`, including event streams, to the loopback controller. No firewall or public exposure is configured. The example configuration sets `APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` so either address works. Origins match the exact scheme, hostname and port; `localhost` and `127.0.0.1` are distinct. `APP_ORIGINS` takes precedence over the legacy single-origin `APP_ORIGIN` setting. Restart `npm run dev` after editing `.env`. For HTTPS, configure the corresponding origin and set `APP_SECURE_COOKIE=true`. Do not expose a development server as a public root control plane.

## Durable state, memory and skills

Controller-owned durable data lives beneath `APP_STATE_DIR`. Project files and execution-account data use separate external directories:

| Path | Contents |
| --- | --- |
| `operator.sqlite` | Projects/components, linked conversations, messages, queue, events, web sessions, memory/revisions, skill metadata/evidence |
| `runtime/` | Legacy/test profile only; protected execution uses `APP_EXECUTION_HOME/codex` |
| `skills/staging/` | Candidate revisions and declared deterministic checks |
| `skills/packages/NAME/vN/` | Published immutable version contents |
| `skills/active/` | Recoverable active-version symlinks |
| `workspaces/` | Legacy/test workspaces; protected project workspaces use `APP_PROJECTS_DIR` |
| `artifacts/` | Generated files available through authenticated download routes |
| `worker/journal.sqlite` | Worker acceptance ledger and bounded unacknowledged event outbox |
| `secrets/ipc-token` | Local IPC credential, excluded from searchable memory |

Rebuilding the frontend preserves controller state, `APP_PROJECTS_DIR`, and `APP_EXECUTION_HOME`. The agent cannot access controller state directly. The broker stages skill snapshots and accepts bounded artifact publication from regular project-owned files; it does not recursively chown agent-controlled project trees.

The agent receives a bounded bootstrap with purpose, explicit owner instructions, recent checkpoints, memory procedures and a small skill catalogue. Detailed memory and skill bodies load on demand. Memory records retain stable IDs, provenance, fact/observation/inference kind, tags/project/category, checked timestamps, links, revisions and supersession. SQLite FTS5 indexes update transactionally. The Memory screen can search, inspect revisions, edit entries and set standing instructions.

The configured `operator` **stdio MCP server** exposes real `memory_*`, `progress_checkpoint`, `skill_*`, `project_*`, and `artifact_publish` tools. The MCP process forwards authenticated calls to the controller; it does not open the application database as root. Tool results return to the same calling turn. The browser's skill controls act on the same service.

Skill creation requires `SKILL.md` metadata, declared files, and deterministic checks asserting stdout or output files. The controller validates structure; the worker executes helpers against fresh temporary fixtures and records UID, output, duration and pass/fail evidence. Validation must succeed and the package digest must still match before publication. Versions are preserved; activation, disable, retirement and rollback update the active pointer. A crash between rename and metadata update is reconciled on startup. Per-run `.agents/skills` links point to immutable versions; the adapter verifies actual Codex `skills/list` discovery before the turn. Availability records and reported outcomes are separate from claims that a skill caused a result.

`skill-maintenance` is seeded once, checked through the worker, then activated; subsequent owner/agent changes and disabling survive restarts. After successful user runs, a separate low-priority improvement run can record lessons or improve a skill. It has a configurable timeout and observed tool-call budget, cannot spawn another improvement run, and retains its own task/events. Disable it with `APP_IMPROVEMENT_ENABLED=false`. `APP_IMPROVEMENT_MAX_TURNS` bounds observed tool calls in that single improvement turn (default 3); `APP_IMPROVEMENT_TIMEOUT_MS` defaults to 90000.

## Projects and deployed components

**Projects** is the durable inventory of what the operator builds or explicitly adopts. A project can contain websites, background services, scheduled jobs, and manual scripts. Registration stores purpose, directory, component references, and links to task history. It never claims deployment succeeded.

Create or adopt a project, register its components, then **Refresh status** to inspect the actual host. Website HTTP health is separate from service state. Scheduled jobs show schedule/timezone, next/last execution when available, and last exit result. Logs are bounded and credentials are redacted. **Ask operator** creates a linked conversation; subsequent tasks use the project directory and registry context. Generic chats use a separate conversation workspace under `APP_PROJECTS_DIR`.

The agent has model-callable project registration, preparation, update, and refresh tools. Its bootstrap instructs it to register deployments and verify them, and explicitly forbids operator-source changes. The OS account boundary enforces release ownership independently of those instructions. Create/register metadata is available even when the worker is offline. Observations become **Unknown** when disconnected or older than 60 seconds; the previous observation and checked time remain visible.

Only registered resources are inspected. New continuous processes and schedules should use the dedicated account’s user services/timers; shared host services are not automatically adopted. Existing cron entries can be registered using their project-relative script, five-field expression, and optional timezone. Only exact supported entries are verified; complex shell commands and unavailable cron history/next-run times remain explicitly unknown. Host-level package installation, reverse-proxy/public-port setup, and operator releases remain owner-controlled. The first increment exposes website links, logs, refresh, and linked agent work. Direct Stop/Restart/Run-now and automatic host-wide discovery are intentionally deferred.

## Queue, reconnect and interruption

One durable queue serializes runs across all conversations. States are queued, running, waiting for input, completed, failed, interrupted and uncertain. Browser disconnects do not stop work. Events commit before broadcasting; SSE event IDs support ordered replay, cursor catch-up and browser deduplication. Worker run IDs make submission idempotent. Its outbox retains unacknowledged events up to 10,000 events/32 MiB, with reserved failure reporting space; saturation stops work instead of dropping execution history. Reconnect drains bounded replay pages before acknowledging durable history. A single structured event is limited to 1 MiB; oversized events fail the run explicitly. Generate large outputs as artifact files.

A controller restart reconciles the ledger and reattaches to the surviving worker. A **worker** crash loses its stdio connection to Codex, so that run is marked uncertain rather than restarted. New work stays blocked until owned orphan execution is resolved. Inspect the host, then use the UI's reconciliation control; it verifies/terminates the recorded owned process group before admitting another run. A run that never reached worker acceptance can also be explicitly acknowledged as reconciled. No uncertain shell action is automatically repeated.

Interrupt requests reach `turn/interrupt`; the UI waits for the observed outcome. Worker shutdown terminates its owned runtime group. Deliberately detached applications/services with their own process session can continue independently; the agent is instructed to identify these. Browser, agent and application lifetimes are separate.

Artifact downloads require an administrator session and stay within the canonical `artifacts/` root, including symlink checks. Files download as attachments. Host tool paths intentionally remain broad. Model output renders as text, not executable HTML. Mutating browser requests require an allowed Origin, a live HttpOnly/SameSite session and its CSRF token; event streams require the same session. Runtime stderr and account/config events are excluded from execution logs; known credentials are redacted from persisted tool/runtime events.

## Snapshot and restore

The existing brain snapshot format supports only the legacy in-state layout. Protected external execution profiles, external project workspaces, and registered-project snapshots are rejected explicitly: the old archive cannot safely capture and restore those directories. Back up those deployments through an owner-controlled procedure; this release does not silently omit them.

For compatible legacy/test state, snapshots use an explicit **offline maintenance window**. Finish or interrupt active work, reconcile uncertain runs, then stop both the controller/frontend and worker. Export refuses live process locks or unresolved execution. Do not copy a live `.sqlite` file with `cp`.

```sh
# Both processes stopped; DEST must be a new directory outside APP_STATE_DIR.
npm run brain:export -- /home/YOUR_USER/operator-snapshot-2026-11-15
```

The export uses SQLite's online backup API for both application and worker databases, and includes skill packages, native sessions, workspaces and artifacts. Session cookies, the IPC secret and Codex `auth.json` are omitted. Protect the snapshot as private administrator data; native conversations and agent-created files may contain sensitive user content. Backup storage management and scheduling are outside this MVP.

On a fresh checkout using the same pinned versions, as the intended controller user:

```sh
npm ci
cp .env.example .env
# Set ADMIN_PASSWORD and APP_STATE_DIR to a fresh persistent directory in .env.
npm run brain:restore -- /home/YOUR_USER/operator-snapshot-2026-11-15
npm run init
# Authenticate the dedicated profile again, then start the two processes.
```

Restore validates database integrity, foreign keys and package locations before publishing staged data. It rebases indexed skill paths, Codex native rollout/workspace location metadata and discovery links to the new state directory while preserving quoted memory/history. Active pointers are rebuilt on initialization. The destination must have no existing database or durable files. For root mode, the state directory must still belong to the normal controller user, mode `0700`; pass that user's UID to the worker.

## Checks and remaining live verification

```sh
npm exec playwright install chromium
npm run check
```

Automated checks cover SQLite durability, serialized transitions, idempotency, uncertain-run handling, event replay/deduplication, authenticated routes/IPC/SSE, memory FTS/revisions, checkpoints, actual deterministic skill helpers, publication/recovery/rollback, snapshot/restore, runtime protocol fixtures, and desktop/phone browser flows. The runtime suite also launches the **actual pinned app-server** to verify initialization, missing authentication, effective unrestricted thread policy and local skill discovery. Protocol fixtures are explicitly test doubles and are never used by production.

The Projects/protected-execution check on 2026-11-15 passed **112 unit/integration tests and 12 browser tests**, plus TypeScript and the production build. Four checks were skipped: optional network device login and three tests requiring a real root test runner (one also needs `setfacl`). Regression coverage includes durable project registration/context, honest observations, cron/timer references, protected identity admission, proxy run binding, credential isolation, atomic history, IPC/replay recovery, and responsive UI workflows. No separate lint task is configured; `npm run check` runs the configured tests and build. Root-only permission checks can be run by the release administrator against isolated fixtures before VPS activation; they are not reported as passed here.

The implementation environment runs as a non-root user without a separately provisioned execution account. **A live protected root broker, authenticated model completion, and model-driven deployment have not been demonstrated here.** They require the administrator account setup above and ChatGPT/API authentication. Model processes are expected to report the non-root execution UID, never UID 0. The exact model-backed acceptance procedure is supplied in `scripts/live-smoke.ts`; see its invocation below once authenticated. Independently tested helper execution, MCP transport, skill discovery and backup restoration do not substitute for that live model check.

```sh
# With authenticated controller + worker already running; creates only fixture workspaces/artifacts/memories/skills.
npm run smoke:live

# Stop both processes, start them again with the same state directory:
npm run smoke:live -- --verify-restart

# After exporting, restoring to a fresh APP_STATE_DIR, authenticating and starting:
npm run smoke:live -- --verify-restore
```

## Troubleshooting and protocol maintenance

- **Missing password:** set `ADMIN_PASSWORD` (12+ characters) in `.env`. No default administrator credential exists.
- **Worker disconnected:** use the generated worker command with the same `APP_STATE_DIR`, controller UID, and execution settings. Check controller ownership and `0700` state/`0600` private socket permissions.
- **Dedicated execution account missing:** create `vps-ai-projects` and the two execution parent directories using the setup block above. Numeric IDs are optional when the account name is configured. Restart `npm run dev` after updating the application, then copy a fresh command from **Connect agent**. The controller reports missing account setup before attempting sudo.
- **Worker tries to create `/root/.local/share/vps-ai-operator`:** plain `sudo npm run worker` can select root's home instead of the controller's state. Run `npm run init` as your normal user, then use the complete command shown by **Connect agent**, which supplies the shared `APP_STATE_DIR` and controller UID. A writable state directory does not grant UID 0; root mode still requires host permission to launch the separate privileged worker.
- **Worker connected but tasks stay queued:** the broker must verify source protection and a distinct non-root execution UID before sign-in or task dispatch. Complete account setup, replace older workers, then sign in using **Connect agent**. Saved tasks resume after verified authentication.
- **Policy narrowed:** managed host/Codex requirements may override full-access requests. The adapter fails before the turn and reports this instead of claiming root access.
- **Protection verification fails:** inspect the reported account, path, sudo policy, or user-manager setting. Restore release ownership and restrictive permissions through your external administration process. Do not disable protection to run production tasks; `APP_PROTECT_OPERATOR=false` is accepted only with explicit temporary test state.
- **Origin/CSRF errors:** use the configured URL and reload after login expiry. For development at either loopback address, set `APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` in `.env` and restart `npm run dev`. If the scheme or port changes, include that exact origin too. `APP_ORIGINS` overrides `APP_ORIGIN`; changing the latter has no effect while the former is set.
- **Uncertain task:** inspect task events and the host, reconnect the worker, then reconcile. Reinstalling dependencies or refreshing the browser must not be used to retry it.
- **Node cannot load libatomic:** run `sudo apt-get install -y libatomic1` in your host terminal and retry the npm command. Installation may require your sudo password; the application cannot supply it. For this execution environment only, checks used a privately unpacked library through `LD_LIBRARY_PATH`; this is not an application dependency installer.
- **Browser dependencies missing:** install the Playwright Chromium prerequisites for your Linux distribution; the ordinary platform does not need a browser binary on the server.

To regenerate the adapter's transitive protocol types from **the pinned binary**:

```sh
npm run protocol:generate
```

Experimental app-server support is confined to the adapter, principally user clarification/elicitation handling. There is no general runtime-plugin abstraction beyond the small Codex adapter yet. No OS installer, systemd installation, deployment pipeline, marketplace, vector database or production hosting configuration is included.

Official implementation references: [Codex app-server](https://developers.openai.com/codex/app-server), [skill format and discovery](https://developers.openai.com/codex/skills/), [Node release schedule](https://nodejs.org/en/about/previous-releases), [node:sqlite](https://nodejs.org/api/sqlite.html), [SQLite FTS5](https://www.sqlite.org/fts5.html), [WAL](https://www.sqlite.org/wal.html), and [online backup](https://www.sqlite.org/backup.html). The generated 0.166.0 types and real-binary tests define compatibility when current documentation describes a newer API.
