# Single-host VPS operator

The private UI accepts owner messages and replays their durable task timelines. With an external catalog initialized, the worker uses Codex app-server and local MCP tools to build and run versioned skills. Without a catalog, the worker acknowledges messages.

See the [V1 acceptance and handoff](docs/HANDOFF.md) for the Docker checkpoints and the [private VPS deployment runbook](deploy/README.md) for systemd, SSH access, backups, and restore.

## Run on WSL2

Use Python 3.12 or newer, uv, Node.js 24 with Corepack, and Make. Running the private origin also requires Caddy 2 on your PATH, or an absolute executable path in `CADDY`. Run the services as your ordinary user.

```sh
make setup
make check
make owner-key
```

`make owner-key` creates a private owner key once and prints the file path. The default state directory is `~/.local/state/vps-operator`. To use another location, export `OPERATOR_STATE_DIR` in each terminal before initialization. Choose a private directory outside the source tree. SQLite stores the operator profile, task checkpoints, messages, ordered events and hashed sessions there. The directory also holds the worker socket and key. On first initialization, `OPERATOR_NAME`, `OPERATOR_PURPOSE` and `OPERATOR_INSTRUCTIONS` set the persisted profile.

Start each foreground service in its own terminal using the same configuration.

| Command | Service |
| --- | --- |
| `make controller` | FastAPI on loopback port 8000 |
| `make worker` | Message worker listening on the private Unix socket |
| `make web` | Next.js in live mode on loopback port 3000 |
| `make gateway` | Caddy on loopback port 8080 |

Open [the private UI](http://127.0.0.1:8080), sign in with the key from the file, and submit a message. Open the task from the brief to see its timeline. An offline worker leaves the task queued. Starting it picks up the saved message. A controller outage shows an unavailable state and the browser reconnects when the controller returns.

If a submission loses its receipt, retry the same text in the same tab. The browser keeps the request ID across reloads when session storage is available. The controller returns the original task for a matching retry. Once the receipt arrives, sending the same text again starts a new task.

### Initialize the external catalog

Create a separate, empty Git repository with write access and use a separate directory for its checkout. The initializer commits the versioned authoring guide and template, pushes the seed to the configured branch, and activates it in SQLite. Repeating initialization preserves existing revisions and the original configuration. Authenticate Git through SSH or a credential helper.

```sh
export OPERATOR_CATALOG_REMOTE='<external catalog URL>'
export OPERATOR_CATALOG_BRANCH=main
export OPERATOR_CATALOG_CHECKOUT="$HOME/vps-operator-catalog"
make catalog-init
```

Run `codex login status` as the account running the worker. Restart the worker after initializing the catalog. The worker defaults to Codex when the catalog exists. Set `OPERATOR_MODEL=acknowledge` to keep acknowledgment-only behavior or use `OPERATOR_MODEL=simulated` for the deterministic Docker acceptance scenario. The live authoring tools accept a declarative skill definition and launch the pinned read-only program in a separate process.

Use `make catalog-pull` to fast-forward the clean catalog checkout and `make catalog-push` to publish its commits. A divergent remote leaves the local branch and the fetched branch intact for a normal Git merge. Previously activated revisions run from retained contents during an outage. Define a project in `projects/<id>.json` with `name`, `description`, and its separate `repo` URL. The operator's `project_read` tool links that definition to the current task.

Ask the operator to remember an entry or open Inspect → Memory and select **Ask the operator to correct this**. Corrections record a new revision with its task and retain the previous text. Reads record the exact revision and the reading task.

For a local fixture connector, commit `connectors/<id>.json` with `name`, `endpoint`, `secret_ref`, `auth` set to `bearer`, the read-only MCP `tool`, and an optional timeout in seconds. Separately create a private `connector-bindings.json` in the state directory with the connector ID as the key and an object containing the exact `endpoint` and `secret_ref`. Use a literal loopback HTTP endpoint. Supply the token from the task's credential dialog.

To exercise file defense, create an ordinary test-owned file in the private state directory's `defense/` subdirectory. Ask the operator to maintain its permission bits with a tested file-mode skill. Use a separate owner message to pause, resume, or retire the goal. The worker records each repair and its observed result.

Caddy sends `/api/*` directly to FastAPI. The session cookie is HTTP-only and scoped to `/api`. Browser writes require the configured origin and a custom request header. If you change the gateway port, set both `OPERATOR_PORT` and `OPERATOR_ORIGIN` (for example, `http://127.0.0.1:8081`). `WEB_PORT` and `CONTROLLER_PORT` configure the upstream ports.

## Demo and verification

To run the public fixture UI locally, use `cd web && OPERATOR_MODE=demo corepack pnpm run dev --hostname 127.0.0.1` and open its port directly. The demo supports its placeholder credential and modeled DNS/TLS examples. The server selects the mode.

- `make check` checks Ruff lint and formatting, runs pytest with temporary state, checks generated API types, builds Next.js and typechecks the UI. The locked font packages supply IBM Plex at build time.
- `make format` applies Ruff formatting and fixes. After a backend contract change, regenerate the frontend types with `make api-types`.
- `make check-fresh` clones the current local commit into a temporary directory, then runs `make setup` and `make check` there.
- `make test-live-ui` runs Playwright against the production UI, a real loopback Caddy origin, FastAPI and a separate worker using disposable state. Install the test browser once with `cd web && corepack pnpm exec playwright install chromium`. The browser check covers owner sign-in, task submission, unauthorized and cross-origin requests, a controller outage during a queued task, stream catch-up and reload.
- `make acceptance-docker` creates a fresh external catalog and starts a temporary live stack. It creates uniquely labeled Docker fixtures, submits two tasks through the phone-width browser, compares tool output with independent Docker observations, and verifies revision reuse after a worker restart. The runner removes its containers and retains the private state path and `evidence.json` so the task pages can be reopened.
- `make acceptance-recovery` interrupts a disposable worker after one authorized start of a stopped fixture. It checks the recovered SQLite checkpoint, the independent Docker state, and the absence of a second dispatch. The separate unreadable-target test verifies a bounded unknown outcome.

Before running the Docker walkthrough, check the intended engine and prepare the fixture image.

```sh
docker context show
docker info
docker pull alpine:3.22
make acceptance-docker
OPERATOR_ACCEPTANCE_MODEL=codex make acceptance-docker
OPERATOR_ACCEPTANCE_MEMORY=1 OPERATOR_ACCEPTANCE_CONNECTOR=1 OPERATOR_ACCEPTANCE_DEFENSE=1 make acceptance-docker
```

Pass `CADDY=/absolute/path/to/caddy` to either run when needed. The default run is **integration verified with simulated authoring** when it passes. Report **autonomous authoring verified** only after the Codex run passes. To reopen the task and skill URLs printed by the runner, set `OPERATOR_STATE_DIR` to the retained run directory's `state` subdirectory in each terminal, start the four services, and sign in using that directory's owner key.
