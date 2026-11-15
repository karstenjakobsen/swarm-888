# VPS AI Operator

A development MVP for one administrator on one Linux host. React/Vite talks to a normal-user Fastify controller; a separate root worker drives the pinned Codex app-server over stdio. Production configuration requires actual UID 0 before signing the agent in or executing queued work.

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
2. Click **Start root worker** if it is not already connected. The controller attempts a noninteractive sudo launch of only the separate worker. If the OS requires your password, copy the exact command shown in the panel and run it in your VPS terminal. Enter your OS password there. The UI detects the root worker automatically and displays **UID 0 · root**. It never substitutes a non-root worker.
3. Click **Continue with ChatGPT**, copy the displayed one-time code, and open the linked OpenAI sign-in page.
4. Finish signing in. The panel verifies the account, switches to **Agent connected**, and resumes saved tasks automatically. Refreshing or closing the panel does not cancel sign-in. Cancel, expiry and retry are supported in the same UI.

ChatGPT sign-in uses the pinned app-server's supported [device-code authentication](https://developers.openai.com/codex/app-server#auth-endpoints). Device login must be enabled for your account/workspace. Credentials remain in the dedicated server-side profile at `APP_STATE_DIR/runtime`; the UI receives only the transient verification code/link. Neither credentials nor login codes enter task history or searchable memory. A controller restart can recover a pending login from the surviving worker. The root worker stays running throughout UI sign-in; no terminal authentication or restart is needed.

The web controller and frontend remain normal-user processes. Root execution happens in the separate worker, whose private socket and actual UID the controller checks. No sudoers policies, system services, firewall rules or public listeners are installed automatically.

For an optional command-line login, stop the worker first and use `npm run auth -- --device-auth`. Alternatively, authenticate with an OpenAI API key:

```sh
read -rs OPENAI_API_KEY
printf '%s' "$OPENAI_API_KEY" | npm run auth
unset OPENAI_API_KEY
```

Enter your OpenAI API key at the `read` prompt. `npm run auth` runs the pinned `codex login --with-api-key` with `CODEX_HOME=$APP_STATE_DIR/runtime`. It reads the key from stdin, stores credentials server-side, and never overwrites `~/.codex` or puts a key in browser storage or command arguments. A valid API key needs access and usage capacity for the selected model. Set optional `CODEX_MODEL` to an available model ID; otherwise Codex uses its configured default. Check the dedicated profile at any time with `npm run auth -- status`. After a CLI login, launch the root worker using the command shown by Connect agent.

`npm run build` checks TypeScript and builds the frontend into `dist/web`. For a built frontend, set `APP_ORIGINS=http://localhost:3001,http://127.0.0.1:3001` and run `npm run controller`; it serves both the built UI and authenticated API on port 3001.

## VPS development and root mode

Create a controller-owned persistent directory if using `/var/lib`:

```sh
sudo install -d -m 700 -o "$(id -u)" -g "$(id -g)" /var/lib/vps-agent
# Set APP_STATE_DIR=/var/lib/vps-agent in .env, then initialize and start the UI.
npm run init
npm run dev
```

In a separate terminal, launch **only the worker** as root:

```sh
sudo env APP_STATE_DIR=/var/lib/vps-agent APP_CONTROLLER_UID="$(id -u)" \
  APP_REQUIRE_ROOT_WORKER=true PATH="$PWD/node_modules/.bin:$PATH" \
  "$PWD/node_modules/node/bin/node" \
  --env-file-if-exists="$PWD/.env" --import tsx "$PWD/src/root-worker.ts"
```

The UI supplies this command with your actual state directory, UID and checkout path. The launcher reuses an existing root worker. It replaces an idle non-root worker only after reserving its execution slot and verifying its PID, start identity, owner and entry point; busy or uncertain work is not stopped. Older workers without the reservation protocol must first be stopped in their terminal. `APP_REQUIRE_ROOT_WORKER=true` is the default and is set in the example configuration. A plain normal-user `npm run worker` refuses startup. Automated fixtures can explicitly disable the root requirement in isolated test state; the UI never offers that mode.

The controller and Vite reject root execution. The worker owns no public TCP listener. Its Unix socket is `APP_STATE_DIR/worker.sock`, mode `0600`, owned by the controller UID; IPC also requires a random server-side token. The private MCP bridge uses a separate mode `0600` Unix socket. **Access to these sockets, the state directory, or the administrator session is root-equivalent when the worker is root.** This process separation does not isolate local data from a host-root agent.

Codex is explicitly configured with `approval_policy="never"` and `sandbox_mode="danger-full-access"`. The adapter checks the effective thread response before starting a turn and fails if policy narrows it. There are no command allowlists or routine command approval gates. Upstream/host policy failures remain visible. The application's own tests never change unrelated host services to demonstrate privileges.

From your laptop, forward the loopback Vite port:

```sh
ssh -L 5173:127.0.0.1:5173 your-user@your-vps
```

Then open http://localhost:5173 or http://127.0.0.1:5173 locally. Vite proxies `/api`, including event streams, to the loopback controller. No firewall or public exposure is configured. The example configuration sets `APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` so either address works. Origins match the exact scheme, hostname and port; `localhost` and `127.0.0.1` are distinct. `APP_ORIGINS` takes precedence over the legacy single-origin `APP_ORIGIN` setting. Restart `npm run dev` after editing `.env`. For HTTPS, configure the corresponding origin and set `APP_SECURE_COOKIE=true`. Do not expose a development server as a public root control plane.

## Durable state, memory and skills

Everything durable lives beneath `APP_STATE_DIR`:

| Path | Contents |
| --- | --- |
| `operator.sqlite` | Conversations, messages, queue, ordered events, web sessions, memory/revisions, skill metadata/evidence |
| `runtime/` | Dedicated Codex profile and native thread/session files |
| `skills/staging/` | Candidate revisions and declared deterministic checks |
| `skills/packages/NAME/vN/` | Published immutable version contents |
| `skills/active/` | Recoverable active-version symlinks |
| `workspaces/` | Persistent conversation workspaces and temporary fixture checks |
| `artifacts/` | Generated files available through authenticated download routes |
| `worker/journal.sqlite` | Worker acceptance ledger and bounded unacknowledged event outbox |
| `secrets/ipc-token` | Local IPC credential, excluded from searchable memory |

Rebuilding or reinstalling dependencies preserves this directory. A root worker repairs ownership of its durable runtime/workspace/artifact/journal files for normal-user maintenance.

The agent receives a bounded bootstrap with purpose, explicit owner instructions, recent checkpoints, memory procedures and a small skill catalogue. Detailed memory and skill bodies load on demand. Memory records retain stable IDs, provenance, fact/observation/inference kind, tags/project/category, checked timestamps, links, revisions and supersession. SQLite FTS5 indexes update transactionally. The Memory screen can search, inspect revisions, edit entries and set standing instructions.

The configured `operator` **stdio MCP server** exposes real `memory_*`, `progress_checkpoint`, and `skill_*` tools. The MCP process forwards authenticated calls to the controller; it does not open the application database as root. Tool results return to the same calling turn. The browser's skill controls act on the same service.

Skill creation requires `SKILL.md` metadata, declared files, and deterministic checks asserting stdout or output files. The controller validates structure; the worker executes helpers against fresh temporary fixtures and records UID, output, duration and pass/fail evidence. Validation must succeed and the package digest must still match before publication. Versions are preserved; activation, disable, retirement and rollback update the active pointer. A crash between rename and metadata update is reconciled on startup. Per-run `.agents/skills` links point to immutable versions; the adapter verifies actual Codex `skills/list` discovery before the turn. Availability records and reported outcomes are separate from claims that a skill caused a result.

`skill-maintenance` is seeded once, checked through the worker, then activated; subsequent owner/agent changes and disabling survive restarts. After successful user runs, a separate low-priority improvement run can record lessons or improve a skill. It has a configurable timeout and observed tool-call budget, cannot spawn another improvement run, and retains its own task/events. Disable it with `APP_IMPROVEMENT_ENABLED=false`. `APP_IMPROVEMENT_MAX_TURNS` bounds observed tool calls in that single improvement turn (default 3); `APP_IMPROVEMENT_TIMEOUT_MS` defaults to 90000.

## Queue, reconnect and interruption

One durable queue serializes runs across all conversations. States are queued, running, waiting for input, completed, failed, interrupted and uncertain. Browser disconnects do not stop work. Events commit before broadcasting; SSE event IDs support ordered replay, cursor catch-up and browser deduplication. Worker run IDs make submission idempotent. Its outbox retains unacknowledged events up to 10,000 events/32 MiB, with reserved failure reporting space; saturation stops work instead of dropping execution history. Reconnect drains bounded replay pages before acknowledging durable history. A single structured event is limited to 1 MiB; oversized events fail the run explicitly. Generate large outputs as artifact files.

A controller restart reconciles the ledger and reattaches to the surviving worker. A **worker** crash loses its stdio connection to Codex, so that run is marked uncertain rather than restarted. New work stays blocked until owned orphan execution is resolved. Inspect the host, then use the UI's reconciliation control; it verifies/terminates the recorded owned process group before admitting another run. A run that never reached worker acceptance can also be explicitly acknowledged as reconciled. No uncertain shell action is automatically repeated.

Interrupt requests reach `turn/interrupt`; the UI waits for the observed outcome. Worker shutdown terminates its owned runtime group. Deliberately detached applications/services with their own process session can continue independently; the agent is instructed to identify these. Browser, agent and application lifetimes are separate.

Artifact downloads require an administrator session and stay within the canonical `artifacts/` root, including symlink checks. Files download as attachments. Host tool paths intentionally remain broad. Model output renders as text, not executable HTML. Mutating browser requests require an allowed Origin, a live HttpOnly/SameSite session and its CSRF token; event streams require the same session. Runtime stderr and account/config events are excluded from execution logs; known credentials are redacted from persisted tool/runtime events.

## Snapshot and restore

Snapshots use an explicit **offline maintenance window**. Finish or interrupt active work, reconcile uncertain runs, then stop both the controller/frontend and worker. Export refuses live process locks or unresolved execution. Do not copy a live `.sqlite` file with `cp`.

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

The main-branch POC review on 2026-11-15 passed **92 unit/integration tests and 9 browser tests**, plus TypeScript and the production build. One optional network device-login test was skipped. Regression coverage includes atomic run/history writes, idempotency conflicts, snapshot symlink confinement, concurrent IPC connections, bounded SSE replay, shutdown cleanup, stale panel responses, and draft preservation. No separate lint task is configured; `npm run check` runs the configured tests and build.

The implementation environment had no model credential in the dedicated profile and ran as a non-root user. **Live model completion, a model-initiated MCP call, later live invocation of a newly installed skill, and UID 0 host execution have not been demonstrated here.** These checks require the configured API key and an explicitly launched root worker. The exact model-backed acceptance procedure is supplied in `scripts/live-smoke.ts`; see its invocation below once authenticated. Independently tested helper execution, MCP transport, skill discovery and backup restoration do not substitute for that live model check.

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
- **Worker disconnected:** start the second process, check `APP_STATE_DIR` matches, and check controller ownership plus `0700` state/`0600` socket/token permissions. Root worker requires `APP_CONTROLLER_UID`.
- **Worker tries to create `/root/.local/share/vps-ai-operator`:** plain `sudo npm run worker` can select root's home instead of the controller's state. Run `npm run init` as your normal user, then use the complete command shown by **Connect agent**, which supplies the shared `APP_STATE_DIR` and controller UID. A writable state directory does not grant UID 0; root mode still requires host permission to launch the separate privileged worker.
- **Worker connected but tasks stay queued:** click **Connect agent**. The worker must show UID 0 and have a connected model account. Start the root worker and complete ChatGPT sign-in in that panel; the existing task resumes automatically. A non-root worker is blocked even if its account is already authenticated. Your personal Codex login and web administrator login are separate.
- **Policy narrowed:** managed host/Codex requirements may override full-access requests. The adapter fails before the turn and reports this instead of claiming root access.
- **Permission errors after root work:** stop the worker cleanly so ownership repair completes. Restore controller ownership of the durable subdirectories if recovering a killed root worker; do not make the socket or state world-accessible.
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
