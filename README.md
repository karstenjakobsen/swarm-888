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

In the live UI, sign in and choose **Connect a catalog**. Enter the GitHub SSH URL and branch. Use the SSH identity available to the controller, or generate a dedicated deploy key and register the displayed public key on the repository before connecting. Select the seed option only when you want to initialize an empty branch. **Inspect → Catalog** shows remote read status, the active authoring revision, and the explicit **Publish** action. Publishing checks that changed skills match their active revisions. The first successful push of a new revision verifies publishing.

Use the CLI for another Git host or a local bare remote.

Use a separate Git repository with write access and a separate directory for its checkout. The initializer accepts a repository with no branches or a branch with an empty tree. It commits the versioned authoring guide and template, pushes the seed to the configured branch, and activates it in SQLite. Repeating initialization preserves existing revisions and the original configuration.

Set up Git authentication before initializing the catalog. For local development, reuse your existing GitHub SSH credentials or credential helper. For an unattended VPS, configure repository-scoped access for the service account before running the initializer. Catalog configuration stores the repository URL and branch, while SSH manages the private key. [GitHub SSH setup](https://docs.github.com/en/authentication/connecting-to-github-with-ssh), [GitHub deploy keys](https://docs.github.com/en/authentication/connecting-to-github-with-ssh/managing-deploy-keys)

```sh
export OPERATOR_CATALOG_REMOTE='<external catalog URL>'
export OPERATOR_CATALOG_BRANCH=main
export OPERATOR_CATALOG_CHECKOUT="$HOME/vps-operator-catalog"
git ls-remote "$OPERATOR_CATALOG_REMOTE"
make catalog-init
```

The worker defaults to Codex when the catalog exists. If **Inspect → Workers** shows **Sign-in required**, choose **Connect** and follow the device sign-in steps. Queued model tasks resume when the worker is ready. Set `OPERATOR_MODEL=acknowledge` to keep acknowledgment-only behavior or use `OPERATOR_MODEL=simulated` for the deterministic acceptance scenario.

Codex work ends with a complete answer or a question under **Needs you**. Reply on the work item to continue the same task. After a restart or four minutes without model progress, the worker checks the saved turn. It can restore the final answer or summarize recorded evidence with tools disabled. If the evidence is insufficient, the task keeps one question open until you respond.

Executable skills commit `skill.json`, `run.lua`, and `tests.json` together. The generic executor runs the retained entry point from the selected revision in a separate process. Self-tests supply mock command outputs. Live calls use dependency names and argument rules approved in `skill-dependencies.json` in the owner-controlled state directory. The acceptance runner supplies this file for its Docker fixtures. Catalog data can declare dependencies and can only call arguments permitted by that policy.

For a legacy catalog, use `make catalog-pull` to fast-forward the clean checkout and `make catalog-push` to publish its commits. A divergent remote leaves the local branch and the fetched branch intact for a normal Git merge. Previously activated revisions run from retained contents during an outage. Legacy project definitions live at `projects/<id>.json`.

To inspect typed YAML manifests, run `.venv/bin/python -m operator_v1.catalog_cli discover`. It reads `operator.yaml` at the root and in immediate subfolders of the accepted catalog commit. Use `--revision <full-sha>` to inspect another local commit and `--kind skill` to select a kind. Discovery reports committed contents and leaves the checkout and active revisions untouched.

The default `skill_type` is `executable`, which requires a sibling Lua file and a sibling JSON self-test file. A skill with `skill_type: guide` references a sibling Markdown file through `guide` and can reference a sibling JSON object through `template`. The framework loads the bundled `create-skill` and `connect-catalog` guides from the same manifest format before a catalog is connected.

Connectors, skills, and projects live in the external catalog. Ask the operator to extend a connector or register a project in a connected catalog. It reads the existing definition, tests the proposed connector against its HTTP request and response fixtures, and commits the tested revision locally. Project references are checked against the connected catalogs. The work page links the package and lists the checks. Publishing remains an explicit catalog action.

A connector manifest declares named HTTP operations, JSON input schemas, provider scopes, request paths, optional pagination, and fixtures. A write includes a verification GET that compares the observed resource with the requested fields. Supplying a token in the private dialog delegates that operation at its destination. An interrupted write with a saved resource ID resumes at the verification read. A lost response with no ID leaves the outcome unknown for reconciliation. Existing loopback MCP connectors use their configured read tool and private destination binding.

A skill can use `run("connector", id, operation, arguments_json)` or `run("host-admin", operation, ...argv)` after declaring the dependency. Both return JSON text. The machine administrator delegates privileged operations through the systemd administration socket and the root-owned policy described in the deployment runbook.

In **Inspect → Catalog**, enter the repository and branch once and select the kinds that share it. **Pull branch** refreshes discovery and keeps active skill revisions pinned. **Preview publish** shows every outgoing commit and path, including connector or project files on a branch connected only for skills. Use **Publish reviewed commits** after reviewing the branch preview.

### Migrate an existing catalog

Run the migration as the operator service account with the existing state directory and legacy catalog checkout. For `packages-888/main`, use the publisher `karstenjakobsen`. The dry run shows the proposed bindings, canonical IDs, and file changes.

```sh
.venv/bin/python -m operator_v1.catalog_cli migrate --publisher karstenjakobsen
```

Stop the controller and worker, then back up and apply. Use a new private backup path outside the state directory.

```sh
make backup OPERATOR_BACKUP=/path/to/operator-before-typed-catalog.tar.gz
.venv/bin/python -m operator_v1.catalog_cli migrate --publisher karstenjakobsen --apply
```

Repeat the apply command after an interruption. It resumes the recorded commit and completes the bindings. The migration creates a local commit for owner review. Start the controller and worker, open an original task and its revision link, and review the migrated branch in **Inspect → Catalog**. Review and test any newly converted skill before approving publication. To recover before publication, restore the backup into a separate state directory and point the services at that restored state.

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
- `make acceptance-catalog` runs the typed catalog and copied-state migration browser scenarios against temporary bare repositories. Set `OPERATOR_CATALOG_ACCEPTANCE_DIR` to a private directory outside the checkout to retain the state and `evidence.json` files. Pass `NEXT_BUILD_FLAGS=--webpack` when local restrictions prevent Turbopack from binding its build socket.
- To rehearse with saved Docker acceptance state, set `OPERATOR_CATALOG_MIGRATION_SOURCE` to its retained directory containing `state/` and `evidence.json`. The walkthrough copies the state, uses a temporary bare remote, opens the original task and revision, and independently checks the recorded empty-selection case against Docker.

The recovery fixture uses an owner-installed engine command in `fixture-engine.json`. The acceptance test writes that configuration for its temporary state. The worker keeps authorization and journaling in the framework and invokes the configured command for observation and dispatch.

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
