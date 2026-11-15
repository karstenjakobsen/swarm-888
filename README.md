# VPS AI Operator

A development MVP for one administrator on one Linux host. React/Vite talks to a normal-user Fastify controller; a separately launched root worker runs Codex and host commands with actual UID 0. A prompt guardrail tells the agent not to change operator source, build, dependencies, configuration, or launch definitions. This is an instruction, not filesystem isolation: root retains the ability to change those files, and the owner accepts that risk.

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
2. Click **Start root worker**. The controller attempts a noninteractive sudo launch. If the OS requires your password, copy the exact command shown in the panel and run it in your VPS terminal. The UI displays the actual agent execution UID and requires root before sign-in and task dispatch. An older broker that launches a non-root agent must first be stopped and replaced.
3. Click **Continue with ChatGPT**, copy the displayed one-time code, and open the linked OpenAI sign-in page.
4. Finish signing in. The panel verifies the account, switches to **Agent connected**, and resumes saved tasks automatically. Refreshing or closing the panel does not cancel sign-in. Cancel, expiry and retry are supported in the same UI.

ChatGPT sign-in uses the pinned app-server's supported [device-code authentication](https://developers.openai.com/codex/app-server#auth-endpoints). Device login must be enabled for your account/workspace. Credentials remain in the application’s dedicated profile at `APP_STATE_DIR/runtime`; the UI receives only the transient verification code/link. Neither credentials nor login codes enter task history or searchable memory. A controller restart can recover a pending login from the surviving worker. The root worker stays running throughout UI sign-in; no terminal authentication or restart is needed.

The web controller and frontend remain normal-user processes. The worker has no public TCP listener. A private, per-session MCP proxy exposes authorized operator tools to the agent without unnecessarily forwarding the master IPC token, administrator password, or controller environment. This credential filtering is not isolation against the root agent. Memory, skills, project registration, and artifact publication go through these tools.

Browser sign-in is the ordinary authentication path. For optional CLI login, stop the worker first and use `npm run auth -- --device-auth`, or pipe an OpenAI API key into `npm run auth`. Authentication uses only `APP_STATE_DIR/runtime`; it does not overwrite `~/.codex`. The key is read from stdin, not command arguments. `npm run auth -- status` checks that dedicated profile. Restart the root worker after a CLI login.

`npm run build` checks TypeScript and builds the frontend into `dist/web`. For a built frontend, set `APP_ORIGINS=http://localhost:3001,http://127.0.0.1:3001` and run `npm run controller`; it serves both the built UI and authenticated API on port 3001.

## Root worker and prompt guardrail

No separate OS account, execution UID/GID, `setpriv`, user-manager configuration, or read-only release setup is required. The worker, Codex, and helper scripts execute as the worker’s actual user: root in the production configuration. The web controller and Vite continue to reject root execution.

Start the controller/UI with `npm run dev` as your normal user. In **Connect agent**, copy the generated root-worker command. It supplies the same `APP_STATE_DIR`, `APP_CONTROLLER_UID`, pinned Node/loader, and checkout path. Enter your sudo password in your terminal when required. Avoid plain `sudo npm run worker`, which can select root’s home and a different state directory.

The bootstrap and project context instruct the agent to leave operator source, installed build, dependencies, configuration, startup definitions, and update mechanisms alone; requests to change the operator should be reported to the owner for an external release. Memory and skills remain editable through their application tools. This is a prompt-only guardrail. No OS protection claim is made, and root can override the instruction.

The UI requires actual agent UID 0, including when an older broker reports a distinct execution UID. Stop an older dedicated-account worker in its terminal and run a fresh root-worker command. Existing `APP_PROTECT_OPERATOR` and `APP_EXECUTION_*` settings are obsolete and ignored; they do not block startup. No existing OS accounts or systemd configuration are removed automatically.

Projects default to `APP_STATE_DIR/projects`, and Codex state remains at `APP_STATE_DIR/runtime`. `APP_PROJECTS_DIR` can select another absolute persistent directory. Explicit directory overrides are retained; existing projects continue to require their registered paths. The root worker prepares new project workspaces, so the default layout needs no separate directory provisioning.

From your laptop, forward the loopback Vite port:

```sh
ssh -L 5173:127.0.0.1:5173 your-user@your-vps
```

Then open http://localhost:5173 or http://127.0.0.1:5173 locally. Vite proxies `/api`, including event streams, to the loopback controller. No firewall or public exposure is configured. The example configuration sets `APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` so either address works. Origins match the exact scheme, hostname and port; `localhost` and `127.0.0.1` are distinct. `APP_ORIGINS` takes precedence over the legacy single-origin `APP_ORIGIN` setting. Restart `npm run dev` after editing `.env`. For HTTPS, configure the corresponding origin and set `APP_SECURE_COOKIE=true`. Do not expose a development server as a public root control plane.

## Durable state, memory and skills

Durable data and project files live beneath `APP_STATE_DIR` by default. Set `APP_PROJECTS_DIR` to keep projects elsewhere:

| Path | Contents |
| --- | --- |
| `operator.sqlite` | Projects/components, linked conversations, messages, queue, events, web sessions, memory/revisions, skill metadata/evidence |
| `runtime/` | Dedicated Codex profile and native thread/session files |
| `skills/staging/` | Candidate revisions and declared deterministic checks |
| `skills/packages/NAME/vN/` | Published immutable version contents |
| `skills/active/` | Recoverable active-version symlinks |
| `workspaces/` | Persistent generic conversation workspaces and temporary fixture checks |
| `projects/` | Project workspaces (unless `APP_PROJECTS_DIR` overrides the default) |
| `artifacts/` | Generated files available through authenticated download routes |
| `worker/journal.sqlite` | Worker acceptance ledger and bounded unacknowledged event outbox |
| `secrets/ipc-token` | Local IPC credential, excluded from searchable memory |

Rebuilding the frontend preserves controller state and project workspaces. The worker repairs ownership of its normal in-state runtime/workspace/artifact/journal/project data for controller maintenance. The root agent can access and modify host data; filesystem permissions here protect against unrelated normal users, not the agent itself.

The agent receives a bounded bootstrap with purpose, explicit owner instructions, recent checkpoints, memory procedures and a small skill catalogue. Detailed memory and skill bodies load on demand. Memory records retain stable IDs, provenance, fact/observation/inference kind, tags/project/category, checked timestamps, links, revisions and supersession. SQLite FTS5 indexes update transactionally. The Memory screen can search, inspect revisions, edit entries and set standing instructions.

The configured `operator` **stdio MCP server** exposes real `memory_*`, `progress_checkpoint`, `skill_*`, `project_*`, and `artifact_publish` tools. The MCP process forwards authenticated calls to the controller; it does not open the application database as root. Tool results return to the same calling turn. The browser's skill controls act on the same service.

Skill creation requires `SKILL.md` metadata, declared files, and deterministic checks asserting stdout or output files. The controller validates structure; the worker executes helpers against fresh temporary fixtures and records UID, output, duration and pass/fail evidence. Validation must succeed and the package digest must still match before publication. Versions are preserved; activation, disable, retirement and rollback update the active pointer. A crash between rename and metadata update is reconciled on startup. Per-run `.agents/skills` links point to immutable versions; the adapter verifies actual Codex `skills/list` discovery before the turn. Availability records and reported outcomes are separate from claims that a skill caused a result.

`skill-maintenance` is seeded once, checked through the worker, then activated; subsequent owner/agent changes and disabling survive restarts. After successful user runs, a separate low-priority improvement run can record lessons or improve a skill. It has a configurable timeout and observed tool-call budget, cannot spawn another improvement run, and retains its own task/events. Disable it with `APP_IMPROVEMENT_ENABLED=false`. `APP_IMPROVEMENT_MAX_TURNS` bounds observed tool calls in that single improvement turn (default 3); `APP_IMPROVEMENT_TIMEOUT_MS` defaults to 90000.

## Projects and deployed components

**Projects** is the durable inventory of what the operator builds or explicitly adopts. A project can contain websites, background services, scheduled jobs, and manual scripts. Registration stores purpose, directory, component references, and links to task history. It never claims deployment succeeded.

Create or adopt a project, register its components, then **Refresh status** to inspect the actual host. Website HTTP health is separate from service state. Scheduled jobs show schedule/timezone, next/last execution when available, and last exit result. Logs are bounded and credentials are redacted. **Ask operator** creates a linked conversation; subsequent tasks use the project directory and registry context. Generic chats use a separate conversation workspace under `APP_STATE_DIR/workspaces`.

The agent has model-callable project registration, preparation, update, and refresh tools. Its bootstrap instructs it to register deployments and verify them, and explicitly forbids operator-source changes. The no-edit instruction is a soft guardrail and is not enforced through OS account separation. Create/register metadata is available even when the worker is offline. Observations become **Unknown** when disconnected or older than 60 seconds; the previous observation and checked time remain visible.

Only registered resources are inspected. New continuous processes and schedules can use system services/timers or cron; shared host services are not automatically adopted. Existing cron entries can be registered using their project-relative script, five-field expression, and optional timezone. Only exact supported entries are verified; complex shell commands and unavailable cron history/next-run times remain explicitly unknown. Project work can include host-level package installation and reverse-proxy/public-port setup when requested. Operator releases remain the owner’s responsibility under the prompt guardrail. The first increment exposes website links, logs, refresh, and linked agent work. Direct Stop/Restart/Run-now and automatic host-wide discovery are intentionally deferred.

## Queue, reconnect and interruption

One durable queue serializes runs across all conversations. States are queued, running, waiting for input, completed, failed, interrupted and uncertain. Browser disconnects do not stop work. Events commit before broadcasting; SSE event IDs support ordered replay, cursor catch-up and browser deduplication. Worker run IDs make submission idempotent. Its outbox retains unacknowledged events up to 10,000 events/32 MiB, with reserved failure reporting space; saturation stops work instead of dropping execution history. Reconnect drains bounded replay pages before acknowledging durable history. A single structured event is limited to 1 MiB; oversized events fail the run explicitly. Generate large outputs as artifact files.

A controller restart reconciles the ledger and reattaches to the surviving worker. A **worker** crash loses its stdio connection to Codex, so that run is marked uncertain rather than restarted. New work stays blocked until owned orphan execution is resolved. Inspect the host, then use the UI's reconciliation control; it verifies/terminates the recorded owned process group before admitting another run. A run that never reached worker acceptance can also be explicitly acknowledged as reconciled. No uncertain shell action is automatically repeated.

Interrupt requests reach `turn/interrupt`; the UI waits for the observed outcome. Worker shutdown terminates its owned runtime group. Deliberately detached applications/services with their own process session can continue independently; the agent is instructed to identify these. Browser, agent and application lifetimes are separate.

Artifact downloads require an administrator session and stay within the canonical `artifacts/` root, including symlink checks. Files download as attachments. Host tool paths intentionally remain broad. Model output renders as text, not executable HTML. Mutating browser requests require an allowed Origin, a live HttpOnly/SameSite session and its CSRF token; event streams require the same session. Runtime stderr and account/config events are excluded from execution logs; known credentials are redacted from persisted tool/runtime events.

## Snapshot and restore

The existing brain snapshot format supports only the legacy in-state layout. Custom external runtime profiles, external project workspaces, and registered-project snapshots are rejected explicitly: the old archive cannot safely capture and restore those directories. Back up those deployments through an owner-controlled procedure; this release does not silently omit them.

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

Run `npm run check` for unit/integration tests, TypeScript, production build, and browser flows. Regression coverage includes durable project registration/context, honest observations, cron/timer references, actual root identity, prompt guardrails, run-bound tool proxy calls, credential redaction, atomic history, IPC/replay recovery, and responsive UI workflows. No separate lint task is configured.

The implementation environment runs as a non-root user and requires an interactive sudo password. **A live root worker, authenticated model completion, and model-driven deployment have not been demonstrated here.** They require the root-worker terminal launch and ChatGPT/API authentication. Production model processes are expected to report UID 0; fixtures use their real test-runner identity. The exact model-backed acceptance procedure is supplied in `scripts/live-smoke.ts`; see its invocation below once authenticated. Independently tested helper execution, MCP transport, skill discovery and backup restoration do not substitute for that live model check.

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
- **Worker tries to create `/root/.local/share/vps-ai-operator`:** plain `sudo npm run worker` can select root's home instead of the controller's state. Run `npm run init` as your normal user, then use the complete command shown by **Connect agent**, which supplies the shared `APP_STATE_DIR` and controller UID. A writable state directory does not grant UID 0; root mode still requires host permission to launch the separate privileged worker.
- **Worker connected but tasks stay queued:** the actual agent must run as UID 0 and be authenticated. Stop older dedicated-account workers, launch the root worker, and sign in using **Connect agent**. Saved tasks resume after verified authentication.
- **Policy narrowed:** managed host/Codex requirements may override full-access requests. The adapter fails before the turn and reports this instead of claiming root access.
- **Old execution-account settings:** remove obsolete `APP_PROTECT_OPERATOR` and `APP_EXECUTION_*` entries from `.env` for clarity; the application ignores them. Restart `npm run dev` and copy a fresh root-worker command.
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
