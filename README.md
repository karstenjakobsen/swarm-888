# VPS AI Operator

A development MVP for one administrator on one Linux host. React/Vite talks to a normal-user Fastify controller that schedules durable tasks across registered Codex workers. Workers default to the launching user; root is an explicit option. Each named worker has its own startup-selected model, reasoning effort, profile, socket, and journal. A prompt guardrail reserves operator core source, build, dependencies, configuration, and launch definitions for the owner. Generated packages are explicitly editable in a controller-managed worktree of this same repository. This is an instruction, not filesystem isolation: root retains host access.

## Automated host setup

The [Ansible setup guide](ansible/README.md) installs the operator and persistent user/root worker services on Debian/Ubuntu, using either localhost or an SSH host. Ansible and Ruff use this repository's uv environment:

```sh
uv sync --dev
cp ansible/vars.example.yml ansible/vars.local.yml
chmod 600 ansible/vars.local.yml
# Edit private variables, including the administrator password for a new install.
uv run ansible-playbook ansible/setup.yml -i server-212, -e @ansible/vars.local.yml
# Local alternative: -i localhost, -c local --ask-become-pass
```

Existing configuration, persistent data, and worker sign-ins are retained. New profiles require **Workers → Sign in** after installation. See the guide for configuration, rebuilding, and validation with `make ops-check`.

For the existing `server-212` installation, push tested operator changes to `swarm-888/main`, then run the playbook locally with `-e @ansible/vars/server-212.yml`. It resolves the latest published `main` to an exact commit, reserves idle workers, stops services, updates `/home/swarm/swarm-888`, builds, restarts, and checks health. The server's `.env`, persistent data, and worker sign-ins are preserved. Add `--check` to preview deployment changes; a separate server login and `git pull` are no longer needed.

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

1. Open **Workers**, register a worker with an ID/name, choose a model from the dropdown, optionally choose one of its supported reasoning efforts, and select **User** mode.
2. Choose **Start worker**, or copy its generated command into a terminal. A normal worker requires no sudo. The pinned runtime checks the requested model and effort before becoming ready.
3. Choose **Sign in**, open the displayed device-code link, and finish ChatGPT authentication. Each named worker has its own profile under `APP_STATE_DIR/workers/<id>/runtime`.
4. Select a worker in the conversation's execution options, or set a project's default worker. Independent projects can run concurrently; edits to the same project wait for its execution and source commit to finish.

The model dropdown loads public model names and IDs from a connected worker, with its saved Codex catalog available offline. Use **Reload models** to refresh the list. On a fresh installation with no catalog, start the default worker from its card first, then return to registration and reload. New workers confirm model/effort availability when started; each profile may require its own sign-in.

ChatGPT sign-in uses the pinned app-server's supported [device-code authentication](https://developers.openai.com/codex/app-server#auth-endpoints). Device login must be enabled for your account/workspace. The UI receives the transient verification code/link; these are not persisted in history or memory. Named workers are independent; their native conversation threads cannot be resumed through another worker's profile.

The web controller and frontend remain normal-user processes. The worker has no public TCP listener. A private, per-session MCP proxy exposes authorized operator tools to the agent without unnecessarily forwarding the master IPC token, administrator password, or controller environment. This credential filtering is not isolation against the root agent. Memory, skills, project registration, and artifact publication go through these tools.

Browser sign-in in **Workers** is the ordinary authentication path. The legacy default profile remains at `APP_STATE_DIR/runtime`. Optional `npm run auth -- --device-auth`, stdin API-key login, and `npm run auth -- status` address that legacy profile only and do not overwrite `~/.codex`. Stop the default worker before a CLI login, then restart it.

`npm run build` checks TypeScript and builds the frontend into `dist/web`. For a built frontend, set `APP_ORIGINS=http://localhost:3001,http://127.0.0.1:3001` and run `npm run controller`; it serves both the built UI and authenticated API on port 3001.

## Worker identities, startup models, and prompt guardrail

No separate OS account, execution UID/GID, `setpriv`, or user-manager configuration is required. Worker processes, Codex, and helper scripts execute as the launching user. A named worker defaults to **User** mode; choose **Root** explicitly for host operations that require it. The web controller and Vite reject root execution.

Start the controller/UI with `npm run dev` as your normal user. **Workers** generates exact user/root launch commands with the pinned Node/loader and registered model. A named worker can also register itself through CLI options (`--id`, `--name`, `--model`, `--effort`). For an explicitly privileged worker, run:

```sh
npm run worker:root
```

Run this without a `sudo` prefix: it reads your current `.env` and normal-user configuration before requesting sudo itself. Enter your password in that terminal when required. **Workers** provides an exact command containing the current controller's `APP_STATE_DIR`, `APP_CONTROLLER_UID`, `APP_PROJECTS_DIR`, pinned Node/loader, and checkout path. The legacy **Connect agent** dialog remains available for the default worker. Avoid plain `sudo npm run worker`, which can select root’s home and a different state directory.

The bootstrap and project context instruct the agent to leave operator core source, installed build, dependencies, configuration, startup definitions, and update mechanisms alone; requests to change the operator should be reported to the owner for an external release. Assigned generated package source is the explicit exception, edited and committed through source tools. Memory and skills remain editable through their application tools. This is a prompt-only guardrail. No OS protection claim is made, and root can override the instruction.

Root-required tasks and host deployment/stop require actual execution UID 0. Automatic user tasks exclude root workers; selecting a root worker requires a visible root-access grant. Stop an older broker that launches a different execution account before replacing it. Existing `APP_PROTECT_OPERATOR` and `APP_EXECUTION_*` settings are obsolete and ignored; they do not block startup. No existing OS accounts or systemd configuration are removed automatically.

Projects default to `APP_STATE_DIR/projects`. Legacy Codex state remains at `APP_STATE_DIR/runtime`; named state lives under `APP_STATE_DIR/workers/<id>`. `APP_PROJECTS_DIR` can select another absolute persistent directory. Explicit directory overrides are retained; existing projects continue to require their registered paths. The assigned worker prepares project workspaces using its actual permissions.

After changing `APP_PROJECTS_DIR`, restart `npm run dev`, stop each old worker, and use its current command from **Workers**. The running worker retains its startup configuration, and Node's explicit launch environment takes precedence over `.env`. For the legacy root worker, `npm run worker:root` can replace a mismatched idle process after verifying its identity and reserving execution; busy or uncertain workers must finish or be reconciled first. Older workers without replacement support require stopping in their terminal. Matching workers are reused, and saved ChatGPT sign-in is retained. Registered project paths are retained rather than moved automatically.

From your laptop, forward the loopback Vite port:

```sh
ssh -L 5173:127.0.0.1:5173 your-user@your-vps
```

Then open http://localhost:5173 or http://127.0.0.1:5173 locally. Vite proxies `/api`, including event streams, to the loopback controller. No firewall or public exposure is configured. The example configuration sets `APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` so either address works. Origins match the exact scheme, hostname and port; `localhost` and `127.0.0.1` are distinct. `APP_ORIGINS` takes precedence over the legacy single-origin `APP_ORIGIN` setting. Restart `npm run dev` after editing `.env`. For HTTPS, configure the corresponding origin and set `APP_SECURE_COOKIE=true`. Do not expose a development server as a public root control plane.

## Durable state, memory and skills

### Worker pool, delegation, and recurring jobs

Register multiple named workers in **Workers**. Model/effort/mode are pinned to that worker ID; register a new ID to change its startup configuration. Rename, disable, and drain are metadata changes. Draining finishes accepted work while refusing new tasks. Launch commands preserve the controller state/project paths before sudo; user-mode commands contain no sudo. The legacy default worker remains available for existing installations.

Tasks record requested and assigned worker, effective model, effort, attempt ID, execution limits, blocked reason, token usage when reported, and parent lineage. Initial prompt/context characters, assistant output, observed tool calls and elapsed execution time have configurable limits; these are not a hard monetary or total cached-context token cap. Prompts reserve 1,000 characters for bootstrap context; intrinsically oversized manual/delegated/job/event inputs reject before creating queued work. Scheduled/delegated tasks use fresh conversations and bounded context. Automatic improvement tasks retain the accepted connection/privilege grant and stay within the parent limits. Actual provider/account limits still apply.

Worker events, receipt ACKs, clarifications, interruptions and native threads are scoped to their worker/journal owner. A lost heartbeat or changed journal leaves execution uncertain; work is not automatically duplicated elsewhere. Same-project write leases last through source finalization. Other projects may continue independently. Git commits remain serialized in the controller-owned worktree.

The operator tools include `worker_list`, `task_create/get/list/cancel`, and `job_list/create/update/trigger`. Children inherit only the accepted connections/root grant and bounded execution limits; task trees have depth and count limits. Assigning same-project children is asynchronous: finish the parent so its project lease can be released. Child results remain visible in their own linked conversations.

**Jobs** stores interval/cron schedules, worker choice, project, task template, connection scope and execution limits. Pause/resume, run once and history are available. Cron uses five fields and an IANA timezone. A delayed controller admits one due occurrence, skips an overlapping prior queued/running/uncertain run, and records the reason. Schedule errors disable only the affected job. Repeated event IDs do not create duplicate analysis runs.

An owner can generate a job-specific event token in **Jobs**. The value is shown once and is also saved as an encrypted credential for use by a deployed collector. POST `{eventId,input}` to the displayed `/api/job-events/<id>` endpoint with `Authorization: Bearer <token>`; the token grants only that job's fixed template, not administrator access. Regeneration revokes the previous token. Event data is bounded, stored as reference data, and cannot change worker/privilege grants. Keep tokens out of source and prompts.

### Credentials and project services

**Connections → Credentials** accepts write-only secret values and shows metadata/revisions afterward. Secrets are AES-GCM encrypted beneath `APP_STATE_DIR/secrets` with a private local key; this is application-level protection, not isolation against the same OS user or root. Bind only the needed fields to HTTP headers/bearer auth or a selected stdio child's environment. Owner grants are specific to a connection or project; model tools cannot attach an existing credential to another destination.

Generic OAuth uses authorization-code flow with PKCE, one-use state and a separate session-bound callback nonce. Configure standard POST or provider-specific GET token exchange and token response field mappings. Credentials refresh before dispatch; automatic token rotation preserves tested configuration. Failed/expired authorization blocks dependent tasks until repaired. Token expiry during an already running native MCP session can still require the next task/snapshot. Configure a public callback origin/URI accepted by the provider for hosted use.

Required connections must be enabled, successfully tested at their current configuration, and authorized before a task is dispatched. **Inherit project connections** captures the enabled assignment at acceptance; **Select connections** is explicit, and an empty selection grants none. Later project changes do not broaden an active task. Jobs can switch back to inheritance by clearing their explicit selection.

Managed projects have a **Runtime credentials** form. It stores credential/field references only. Selected values are injected into the deployed service, never build/check commands or the model's environment. Private launch descriptors contain references and literal arguments; a supervisor redacts selected credentials from service stdout/stderr before journal delivery. Saving/clearing bindings does not restart a service; explicitly redeploy/restart to apply changes. Managed systemd installation and stop remain privileged host operations using a root worker.

Known credential values are rejected from new task inputs, source and owner instructions and redacted from stored execution context/results. Source-created skills commit `SKILL.md`, helpers and checks in their registered repository folder and pin each validated immutable runtime version to its exact source revision.

Legacy `brain:export/restore` intentionally rejects named-worker/project layouts. For the expanded platform, stop the controller/workers and back up complete operator state (including encrypted credentials and their local key), the source repository/worktrees, and project runtime roots together. No provider-specific trading code, brokerage connection or real order execution is included in this platform release.

For a later analysis application, use a stronger worker to create the project, connector and checked skill through the operator. Keep market-data collection, candle aggregation, indicators and freshness checks in ordinary project code. A collector can trigger one bounded job when new data is ready; the selected small-model worker receives a prepared snapshot and returns a validated observation such as LONG, SHORT or WAIT with supporting data. Store those observations in the project and inspect task/job history in the UI. Evaluate model quality and token usage before selecting a cheaper model. Order execution, position sizing and risk limits belong in separately tested project code with their own authorization; an analysis connector need not expose order tools.

Durable data and project files live beneath `APP_STATE_DIR` by default. Set `APP_PROJECTS_DIR` to keep projects elsewhere:

| Path | Contents |
| --- | --- |
| `operator.sqlite` | Repositories/packages/import history, project/components, workers, task attempts/leases/source finalization, jobs/history, credential metadata, conversations, events, web sessions, memory and skill metadata/evidence |
| `runtime/` | Dedicated Codex profile and native thread/session files |
| `workers/<id>/` | Named worker manifest, private socket, lock, journal and native runtime profile |
| `skills/staging/` | Candidate revisions and declared deterministic checks |
| `skills/packages/NAME/vN/` | Published immutable version contents |
| `skills/active/` | Recoverable active-version symlinks |
| `workspaces/` | Persistent generic conversation workspaces and temporary fixture checks |
| `projects/` | Project runtimes plus `repositories/` source checkouts and content-addressed Git `artifacts/` (unless `APP_PROJECTS_DIR` overrides the default) |
| `artifacts/` | Generated files available through authenticated download routes |
| `worker/journal.sqlite` | Worker acceptance ledger and bounded unacknowledged event outbox |
| `secrets/ipc-token` | Local IPC credential, excluded from searchable memory |
| `secrets/` | Private credential encryption key and encrypted secret material; never commit or publish |

Rebuilding the frontend preserves controller state and project workspaces. The worker repairs ownership of its normal in-state runtime/workspace/artifact/journal/project data for controller maintenance. The root agent can access and modify host data; filesystem permissions here protect against unrelated normal users, not the agent itself.

The agent receives a bounded bootstrap with purpose, explicit owner instructions, recent checkpoints, memory procedures and a small skill catalogue. Detailed memory and skill bodies load on demand. Memory records retain stable IDs, provenance, fact/observation/inference kind, tags/project/category, checked timestamps, links, revisions and supersession. SQLite FTS5 indexes update transactionally. The Memory screen can search, inspect revisions, edit entries and set standing instructions.

The configured `operator` **stdio MCP server** exposes real `memory_*`, `progress_checkpoint`, `skill_*`, `project_*`, `connector_*`, `worker_list`, `task_*`, `job_*`, and `artifact_publish` tools. The MCP process forwards authenticated calls to the controller; it does not open the application database as root. Tool results return to the same calling turn. The browser's skill controls act on the same service.

Skill creation requires `SKILL.md` metadata, declared files, and deterministic checks asserting stdout or output files. The controller validates structure; the worker executes helpers against fresh temporary fixtures and records UID, output, duration and pass/fail evidence. Validation must succeed and the package digest must still match before publication. Versions are preserved; activation, disable, retirement and rollback update the active pointer. A crash between rename and metadata update is reconciled on startup. Per-run `.agents/skills` links point to immutable versions; the adapter verifies actual Codex `skills/list` discovery before the turn. Availability records and reported outcomes are separate from claims that a skill caused a result.

`skill-maintenance` is seeded once, checked through the worker, then activated; subsequent owner/agent changes and disabling survive restarts. After successful user runs, a separate low-priority improvement run can record lessons or improve a skill. It has a configurable timeout and observed tool-call budget, cannot spawn another improvement run, and retains its own task/events. Disable it with `APP_IMPROVEMENT_ENABLED=false`. `APP_IMPROVEMENT_MAX_TURNS` bounds observed tool calls in that single improvement turn (default 3); `APP_IMPROVEMENT_TIMEOUT_MS` defaults to 90000.

## Managed source, deployments and MCP connections

Open **Repositories → Add repository** first. A remote URL is required: **Create locally** initializes a checkout and configures `origin` without contacting it; **Clone existing** reads the remote and follows its default branch unless you select another. Remote publishing starts disabled. New projects, connector code and reusable skills must belong to a registered repository. Existing runtime directories and services are preserved.

To remove an obsolete entry, open **Projects**, select it, choose **Remove project**, and confirm. This removes its registry entry and project-owned connection registrations, including their assignments to other projects. Conversations, source files, Git history, and runtime files are retained; existing services continue running. Removal works for missing directories and projects outside the current `APP_PROJECTS_DIR`, without a worker connection. Finish or reconcile pending work before removing its registration.

The controller owns checkouts at `APP_PROJECTS_DIR/repositories/<repository-id>` on an operator branch, normally `operator/work`. A repository can contain several projects, connectors and skills, each in a separate folder. Registered folders cannot overlap. Use `.` when the repository contains a single root package. **Discover packages** previews committed manifests (up to 200 manifests/50,000 tracked repository files), then **Import selected** registers them without running check/build/run commands. **Fetch & preview remote** explicitly reads remote updates; importing them only fast-forwards clean local history. Divergence requires manual reconciliation. One writing task holds the repository through source finalization; tasks in different repositories can run concurrently. Git must be installed.

Set **Remote branch to fetch** before fetching a preview to inspect another branch, such as `release/stable` or `operator/work`. It defaults to the repository's registered source branch; a `main` branch is optional. The preview shows the selected branch and exact commit. Fetching preserves the working branch and registered source branch; importing still requires a clean checkout and compatible history.

In **Remote publishing**, the owner can enable pushes, choose a push URL and branch, and turn on **Automatically push package commits**. A blank URL keeps the configured Git push URL, so HTTPS fetching can coexist with SSH publishing. The default push branch is the registered operator working branch. Configure SSH authentication for the normal controller account on the host; private keys and tokens do not belong in repository settings or conversations.

Package creation and source saves remain committed locally before publishing. Automatic pushes use a durable queue and wait for task source finalization. **Push now** and the operator's `repository_push` tool queue the latest commit using the owner's saved destination. The UI shows queued, pushing, pushed and failed states with commit IDs. A failed remote push preserves the local package and commit; use **Retry push** after fixing access or network problems. Pushes do not force updates or rewrite remote history, and an operator cannot enable publishing or change its destination through a model tool.

Every package has a strict v1 `operator-package.json`:

```json
{
  "schemaVersion": 1,
  "id": "be1f4a84-9762-4a01-a768-3b1ab5dd0941",
  "kind": "project",
  "name": "website",
  "version": "0.1.0",
  "description": "My website",
  "run": { "command": "node", "args": ["server.mjs"] }
}
```

`kind` is `project`, `connector`, or `skill`. Connector packages require `mcp`; skill packages require matching `SKILL.md` metadata. Optional `check`, `build`, and project `run` commands use `{command,args}`. The canonical UUID survives renames and moves inside the repository. Independent copies in other repositories need new UUIDs. `schemaVersion` describes the file format, semantic `version` is the package release label, and the imported Git SHA identifies the exact revision. Reimporting the same revision is idempotent. SQLite stores every attempted import and its outcome; a failed update preserves the last successful package revision. Imported, validated and deployed are separate states.

Use **Create package** for new code or **Adopt folder** to add a manifest to existing code. The text editor displays a bounded subset of regular UTF-8 files (up to 500 files/8 MB; 1 MB each); binary and additional files remain in Git and are preserved. Builds use exact Git snapshots with binary assets and executable permissions, up to 100,000 files/2 GiB (256 MiB per file). Packages must have self-contained build inputs within their folder; shared monorepo root dependencies are not copied into a package release. Symlinks/submodules, credentials, runtime state and dependencies are excluded. `.env.example` templates are supported. Connection credentials and configured external endpoint references stay in SQLite rather than portable package source.

Legacy `generated/` sources remain readable. In **Projects → Source & deployment → Migrate source**, explicitly choose the registered repository and folder before starting new coding work. Migration preserves the package UUID, old Git history, runtime directory and service registration; it does not move runtime files. `APP_REPOSITORY_PATH` is retained only to read/migrate the old checkout. The bundled maintenance skill belongs to the operator distribution; newly authored application skills require registered source. Importing a skill with `skill-checks.json` creates an inactive runtime candidate; validate and publish it separately. Without checks, the source imports successfully and the UI reports what is needed for a candidate.

Creating source and saving files commits immediately. Editor saves carry their loaded commit and return 409 if a newer revision exists, preserving the draft. Direct package edits from a model task are committed when its confirmed terminal result is recorded. Pending commit finalization is durable and recovered before another task writes that repository; Git errors remain visible until resolved. Tasks that change files outside their assigned package cannot silently finalize. Stale Git locks fail closed: confirm no controller/source operation remains before removing `APP_STATE_DIR/workspaces/repository-<repository-id>.lock` (or the legacy `managed-repository.lock`).

**Source & deployment** in Projects displays source and deployed commits separately. **Deploy committed source** exports that exact revision into `<project-runtime>/releases/<commit>`, runs declared checks/builds, and asks the root worker to install and enable `vps-ai-project-<id>.service`. Deployment requires systemd. Failed checks leave the previous service unchanged; failures after a service-manager mutation require inspecting status/logs before retrying. **Stop service** disables and stops that unit; source, release files, and application data are retained. Services run independently of the chat and worker process. Source files are checked against the committed snapshot after checks/builds; write build output into separate output files rather than modifying committed inputs.

**Connections** registers stdio commands or HTTP MCP endpoints, tests initialization/tool discovery, enables/disables them, and offers a JSON tool-call form. **Create local example** generates and commits a deterministic echo connector. Managed stdio connectors execute from a checked committed runtime snapshot; source changes invalidate the previous tool test. HTTP connections support JSON/SSE Streamable HTTP with bounded requests, responses and deadlines. Connections support owner-configured bearer/custom headers, selected stdio environment fields, and generic OAuth authorization/refresh. URLs cannot include credentials, query parameters or fragments. Secret values belong in the credential forms, never source, command arguments or chat.

When an imported connector changes its HTTP endpoint or stdio command or arguments, an existing credential binding blocks use of the changed transport. Remove the binding in **Connections**, review and register the updated package, then authorize and test the connection again.

Assign up to 20 enabled connections in a project's **Connections** section. Their tools receive unique MCP namespaces at the next model task start. The operator MCP bridge enforces each task's connection grants. In generic chat, `package_create` with kind `connector` creates the source and registers its connection. Use `project_source_write` to edit it and `connector_test` to discover its tools. A timed-out tool may have caused side effects and is never automatically repeated.

To test locally after restarting the controller and the chosen worker:

1. Open **Repositories → Add repository**, enter a remote URL, and create it locally. In **Connections → Create local example**, select that repository and a package folder, then **Test connection**. Select `echo`, enter `{"text":"hello from the operator"}`, and call it. The result should contain that text, and the connector's source should show a Git commit.
2. Open **Projects → Create project**, use the Node service template, edit a source file, and **Save & commit**. Confirm the new source revision while the deployed revision remains unchanged.
3. With a root worker and systemd available, choose **Deploy committed source**, inspect logs/status, then **Stop service**. The example listens on the VPS's loopback port 8080; change its source if that port is occupied. This does not expose a public port.
4. Assign the example connection to the project. With model authentication configured, use **Ask operator** to request its echo tool. Source editing, standalone connection tests and deployment controls do not require model authentication.

The review brought runtime crash recovery forward from slice 8. Effectful runtime operations are journaled before execution. Detached helper supervisors use a private launch gate: the worker records PID/start/boot identity durably before allowing code to start. Codex startup uses the same gate for task-owned native MCP servers. A worker restart marks unfinished work uncertain and blocks new effectful operations and tasks; status/log inspection remains available. **Execution recovery** verifies tracked local process groups, requires explicit acknowledgement for uncertain external effects, and never retries or rolls back provider actions. Missing/reused process identities fail closed instead of guessing which process to kill. Persistent deployed systemd services are independent and are not orphan helpers.

Confirmed external results are retained on the worker until the controller stores a durable receipt and acknowledges it. After a lost acknowledgement, recovery retries only that acknowledgement, never the original operation. Authenticated `GET /api/runtime-receipts` lists bounded receipt metadata; `GET /api/runtime-receipts/:id` retrieves an individual recorded result. Older workers must be stopped and restarted before the new deployment/MCP APIs are used. Existing legacy chat status remains compatible.

Automated acceptance uses temporary Git repositories, real local MCP processes/HTTP fixtures, actual worker SIGKILL cases, and the pinned app-server's tool discovery/calls. Service-manager tests use an injected fake host and never install a real systemd unit. Live root/systemd deployment remains a host acceptance step.

## Projects and deployed components

**Projects** is the durable inventory of what the operator builds or explicitly adopts. A project can contain websites, background services, scheduled jobs, and manual scripts. Registration stores purpose, directory, component references, and links to task history. It never claims deployment succeeded.

Create or adopt a project, register its components, then **Refresh status** to inspect the actual host. Website HTTP health is separate from service state. Scheduled jobs show schedule/timezone, next/last execution when available, and last exit result. Logs are bounded and credentials are redacted. **Ask operator** creates a linked conversation; subsequent tasks use the project directory and registry context. Generic chats use a separate conversation workspace under `APP_STATE_DIR/workspaces`.

The agent has model-callable project registration, preparation, update, and refresh tools. Its bootstrap instructs it to register deployments and verify them, and explicitly forbids operator-source changes. The no-edit instruction is a soft guardrail and is not enforced through OS account separation. Create/register metadata is available even when the worker is offline. Observations become **Unknown** when disconnected or older than 60 seconds; the previous observation and checked time remain visible.

Only registered resources are inspected. New continuous processes and schedules can use system services/timers or cron; shared host services are not automatically adopted. Existing cron entries can be registered using their project-relative script, five-field expression, and optional timezone. Only exact supported entries are verified; complex shell commands and unavailable cron history/next-run times remain explicitly unknown. Project work can include host-level package installation and reverse-proxy/public-port setup when requested. Operator releases remain the owner’s responsibility under the prompt guardrail. Managed source deployments provide Deploy, Stop and logs; other adopted components retain their observation-only controls. Host-wide discovery and general Run-now/Restart controls remain deferred.

## Queue, reconnect and interruption

Use the trash button beside a conversation to remove it from the workspace after confirmation. Queued, active or uncertain work, related task-tree work, pending tools, source commits and execution leases must finish or be reconciled first. Removed conversations disappear from the sidebar, project conversation history and future task context. Execution/chat records and native runtime files remain stored for recovery and job deduplication. Saved memory, projects, source/runtime files, artifacts and running services are kept.

One durable queue assigns runs across registered workers. Each worker executes one task at a time; a conversation and project remain serialized, while independent projects may run concurrently. States are queued, running, waiting for input, completed, failed, interrupted and uncertain. Browser disconnects do not stop work. Events commit before broadcasting; SSE event IDs support ordered replay, cursor catch-up and browser deduplication. Worker run IDs make submission idempotent. Each worker's outbox retains unacknowledged events up to 10,000 events/32 MiB, with reserved failure reporting space; saturation stops work instead of dropping execution history. Reconnect drains bounded replay pages before acknowledging durable history. A single structured event is limited to 1 MiB; oversized events fail the run explicitly. Generate large outputs as artifact files.

A controller restart reconciles each worker's ledger and reattaches to surviving workers. A **worker** crash loses its stdio connection to Codex, so that run is marked uncertain rather than restarted. Its worker and project stay blocked until owned orphan execution is resolved; independent workers/projects may continue. Inspect the host and affected external services, then use the UI's reconciliation control; it verifies/terminates recorded owned process groups before admitting another run. A run that never reached worker acceptance can also be explicitly acknowledged as reconciled. No uncertain shell action is automatically repeated.

Interrupt requests reach `turn/interrupt`; the UI waits for the observed outcome. Worker shutdown terminates its owned runtime group. Deliberately detached applications/services with their own process session can continue independently; the agent is instructed to identify these. Browser, agent and application lifetimes are separate.

Structured runtime error notifications appear in execution activity and on active task cards. A retry notice clears when execution resumes; it does not mark the task complete or repeat its actions. Native task deadlines still apply. Codex 0.166.0 can suppress its first WebSocket retry notification, so an upstream capacity backoff may initially show only as a running task. Runtime stderr and raw provider diagnostics remain excluded.

Artifact downloads require an administrator session and stay within the canonical `artifacts/` root, including symlink checks. Files download as attachments. Host tool paths intentionally remain broad. Model output renders as text, not executable HTML. Mutating browser requests require an allowed Origin, a live HttpOnly/SameSite session and its CSRF token; event streams require the same session. Runtime stderr and account/config events are excluded from execution logs; known credentials are redacted from persisted tool/runtime events.

## Snapshot and restore

The existing brain snapshot format supports only the legacy in-state layout. Named-worker layouts, custom external runtime profiles, external project workspaces, registered repositories and registered-project snapshots are rejected explicitly: the old archive cannot safely capture and restore those directories. Back up expanded deployments through the complete stopped-state procedure described above; this release does not silently omit them.

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

Automated verification makes no paid inference calls, broker requests or real systemd changes. It covers the creation/connection/job/result/restart workflow with a simulated small-model worker, real temporary Git repositories and real credential-bound local MCP processes. Native MCP discovery/calls also run against the pinned app-server without inference. Normal workers execute as their launching user; privileged host operations require an explicitly selected root worker. Live model authentication/completion and systemd deployment remain host acceptance steps. The legacy model-backed acceptance procedure is supplied in `scripts/live-smoke.ts`; see its invocation below once authenticated.

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
- **Worker tries to create `/root/.local/share/vps-ai-operator`:** plain `sudo npm run worker` can select root's home instead of the controller's state. Run `npm run init` as your normal user, then use the complete command shown by **Workers**, which supplies the shared `APP_STATE_DIR` and controller UID. A writable state directory does not grant UID 0; root mode still requires host permission to launch the separate privileged worker.
- **Worker connected but tasks stay queued:** inspect the task's blocked reason and **Workers** status. The chosen worker must be authenticated, enabled, idle, have matching user/root permissions, and be free of uncertain execution. Required connections must be configured and tested. Same-project children wait for the parent's source finalization. Ordinary tasks do not require root.
- **Policy narrowed:** managed host/Codex requirements may override full-access requests. The adapter fails before the turn and reports this instead of claiming root access.
- **Old execution-account settings:** remove obsolete `APP_PROTECT_OPERATOR` and `APP_EXECUTION_*` entries from `.env` for clarity; the application ignores them. Restart `npm run dev` and copy a fresh worker command. `APP_REQUIRE_ROOT_WORKER=true` retains legacy default-worker behavior; new named workers default to user mode.
- **Origin/CSRF errors:** use the configured URL and reload after login expiry. For development at either loopback address, set `APP_ORIGINS=http://localhost:5173,http://127.0.0.1:5173` in `.env` and restart `npm run dev`. If the scheme or port changes, include that exact origin too. `APP_ORIGINS` overrides `APP_ORIGIN`; changing the latter has no effect while the former is set.
- **Uncertain task:** inspect task events and the host, reconnect the worker, then reconcile. Reinstalling dependencies or refreshing the browser must not be used to retry it.
- **Node cannot load libatomic:** run `sudo apt-get install -y libatomic1` in your host terminal and retry the npm command. Installation may require your sudo password; the application cannot supply it. For this execution environment only, checks used a privately unpacked library through `LD_LIBRARY_PATH`; this is not an application dependency installer.
- **Browser dependencies missing:** install the Playwright Chromium prerequisites for your Linux distribution; the ordinary platform does not need a browser binary on the server.

To regenerate the adapter's transitive protocol types from **the pinned binary**:

```sh
npm run protocol:generate
```

Experimental app-server support is confined to the adapter, principally user clarification/elicitation handling. Model workers use the Codex adapter; application integrations use pluggable MCP connections. There is no OS installer, operator release pipeline, plugin marketplace, vector database or public hosting configuration included. Managed project deployment can install its own systemd unit through an explicitly authorized root worker.

Official implementation references: [Codex app-server](https://developers.openai.com/codex/app-server), [skill format and discovery](https://developers.openai.com/codex/skills/), [Node release schedule](https://nodejs.org/en/about/previous-releases), [node:sqlite](https://nodejs.org/api/sqlite.html), [SQLite FTS5](https://www.sqlite.org/fts5.html), [WAL](https://www.sqlite.org/wal.html), and [online backup](https://www.sqlite.org/backup.html). The generated 0.166.0 types and real-binary tests define compatibility when current documentation describes a newer API.
