# Swarm 888

A local web operator that runs Codex in the background. Submit a task, close the browser, and return to the run history. Each workspace has its own directory, Codex conversation, and durable task queue. The worker pool is shared across workspaces.

## Run from this checkout

Install [uv](https://docs.astral.sh/uv/) and [Codex CLI](https://developers.openai.com/codex/cli/), then run:

```sh
uv sync --locked
uv run python -m swarm doctor
uv run python -m swarm
```

uv provisions Python **3.14** and installs Ruff in `.venv/`. Authenticate Codex with `codex login` under the same OS account or supply `OPENAI_API_KEY` to the service. Git uses that account's existing credential helper for private catalogs.

The server listens on **127.0.0.1:8787**. Open the private link printed in the terminal. To retrieve it again:

```sh
uv run python -m swarm url
```

The local development state lives in the ignored `.swarm/` directory. Two workers start by default. To run ten slots, stop the local server and restart it with:

```sh
uv run python -m swarm --workers 10
```

Idle slots do not start a Codex subprocess. Change the port, data directory, or operator name with `--port`, `--data`, and `--name`. Two operators on the same machine need distinct ports and data directories.

## Use the dashboard

- **Run desk** queues tasks in the selected workspace. Expand a run to see its actions and result. Send another task in that workspace to continue the conversation.
- **Worker pool** shows which slot owns each active task, its workspace, and its latest action. Different workspaces run concurrently. One worker at a time can change a given workspace.
- **Catalog** lists reusable assets. Create a workspace with a separate HTTPS or SSH Git repository and an optional branch, tag, or commit. The operator imports the asset directories and records the resolved Git commit.
- **Peer operators** pairs trusted operators. On the receiving operator, create an invitation. On the sending operator, enter the receiver's URL and invitation key. Select the peer under **Run on** when queuing a task. Each invitation has its own incoming workspace. Retried deliveries reuse the same request ID.

Two operators on one machine can use loopback HTTP. Between VPSs, expose only `/mesh/v1/` through an HTTPS reverse proxy or use a private SSH tunnel. Keep the dashboard on loopback. Treat invitation keys as credentials.

## Shared catalog

All workspaces can use the same external repository, `git@github.com:karstenjakobsen/packages-888.git`. Each operator uses its own checkout of `main`. By default the operator clones into `<operator-data>/catalog`. To adopt the existing checkout on this machine:

```sh
uv run python -m swarm --catalog-dir /home/karsten/projects/github/karstenjakobsen/packages-888
```

The operator remembers the directory in its SQLite database. Another instance can use its own path or the default. `--catalog-repo`, `SWARM_CATALOG_REPO`, and `SWARM_CATALOG_DIR` support other deployments. The running account needs read/write access to the checkout, and SSH credentials for this GitHub remote. A systemd installation can keep its checkout under its writable state directory.

**Catalog** shows the shared remote, local path, branch, and packages from every workspace. Choose **Work on catalog** to give Codex a task in that checkout. Shared packages belong in `skills/<name>/SKILL.md`, `connectors/<name>/`, and `projects/<name>/`. Ordinary project workers can read these packages and keep their own edits and memory in their private workspace.

**Sync catalog** fast-forwards the local branch. The operator also syncs at startup and before shared catalog tasks. **Publish changes** stages the three package directories and pushes to `main`; other operators can then sync them. Simultaneous pushes never force-update the shared branch. A conflicting change stops the job and leaves local work available for reconciliation. The catalog checkout has its own job queue and lock.

## Workspace repositories and memory

| Path in a catalog | Purpose |
| --- | --- |
| `projects/<name>/` | Reusable project code, manifests, and instructions. |
| `.agents/skills/<name>/SKILL.md` | A native Codex skill with its name, description, and workflow. |
| `connectors/<name>/` | Connector source with usage instructions and any tests. Workers can use project-local connector code inside their sandbox. |

**Publish workspace changes** commits the three workspace directories to a dedicated `swarm/<workspace-id>` branch in the source repository. Enable automatic publishing at workspace creation to queue a publish after each successful local task. Another operator can import the published branch or exact commit. An empty repository starts with a local catalog branch.

SQLite stores projects, prompts, run states, actions, peer registrations, and results. Codex retains its thread history in the service account's Codex home. Workers are instructed to record durable project decisions in workspace-local `MEMORY.md`. Memory and conversations stay local when publishing a catalog. Back up the data directory and Codex home together for continuity.

## Install on a Linux VPS

From a checkout:

```sh
# Install for the current user. Start the operator in the foreground.
./scripts/install.sh --user
~/.local/bin/swarm-operator

```

For an unattended VPS, include a trusted checkout of this release in the image at `/opt/swarm-888-src`. Have the provider run the system installer as root during provisioning. For example, this cloud-init user data starts both the operator and its host worker at first boot:

```yaml
#cloud-config
runcmd:
  - [/opt/swarm-888-src/scripts/install.sh, --system]
```

The installer builds a Python zipapp with the dashboard and Alpine.js included, creates a Python 3.14 virtual environment, and verifies Python's SQLite module. It provisions uv and the standalone Codex CLI when needed. Missing tools come from checksum-verified Linux x86-64 or arm64 release assets. A system installation on Debian or Ubuntu can also install the bootstrap Python interpreter, Git, and CA certificates with apt. The target needs no Go toolchain, SQLite CLI, Node.js, or frontend build.

System installation runs the operator as the dedicated `swarm-operator` account. State and Codex credentials live under `/var/lib/swarm-888/`. Supply `OPENAI_API_KEY` through the provider's secret provisioning in a root-owned, mode-0600 `/etc/swarm-888.env` before startup. The same file can set `SWARM_WORKERS=10`. The default SSH catalog needs an authorized Git key for that account. For a remote dashboard, forward the port with `ssh -L 8787:127.0.0.1:8787 user@vps` and open the service's private URL locally.

### Operate Nomad from a workspace

From the run desk, select a local project and ask the operator to install a single-node Nomad cluster. The operator first asks the connector to identify the Linux host, Docker runtime, and service prerequisites. You can also ask it to check the environment before installing anything. The systemd host worker runs as root and accepts installation and service lifecycle requests over a Unix socket owned by the operator account. The same worker serves all local slots and serializes host changes. It handles Docker dependencies, downloads the verified Nomad release, and runs the pinned catalog installer. The installer generates TLS certificates, gossip encryption and ACL credentials locally. An install request on an existing managed deployment rechecks ownership and readiness.

Ask the operator to run a small Python job and verify its output. Its batch connector uses a scoped credential to plan, submit, check status, read logs and purge the job. The cluster target for this release is x86-64 Linux with systemd, cgroup v2 and a local rootful Docker socket. Operator state and credentials stay on the host across restarts.

To inspect a machine directly from the catalog checkout, run `python3 -B connectors/local-nomad/batch.py environment`. The corresponding dashboard tool call is `nomad_batch(action="environment")`. Both work before Nomad credentials exist. Host and Docker are reported separately because WSL2 can use either Docker Desktop or a native Linux Engine.

The system installer copies the reviewed catalog files into a root-owned release under `/opt/swarm-888-host`. The file hashes and catalog revision are in `swarm/host_catalog.json`. A catalog edit becomes privileged code only when the host provisioner installs an operator release with the updated pin. A user-only installation can use the host worker once the machine provisioner enrolls that operator account with `/usr/bin/python3 -I scripts/host-worker/provision.py --user ACCOUNT`.

## Runtime boundaries

The service runs Codex App Server over stdio with workspace writes and unattended command approval policy. The background supervisor owns queueing, Git transfers, and peer delivery. On restart, it reclaims interrupted jobs, resumes the project thread, and asks the worker to verify previous effects before continuing. Three interruptions mark a job failed. Arbitrary external side effects require idempotency in the connector itself.

Workspaces share one OS account and preserve separate conversations. The operator advertises the Nomad tools to owner-created local project runs. Catalog editing and incoming peer tasks use their ordinary workspace toolsets. Treat peers and catalog sources as trusted under this shared-account model.

## Code map

| File | Responsibility |
| --- | --- |
| `swarm/__main__.py` | CLI, private access link, instance lock, startup and shutdown. |
| `swarm/store.py` | SQLite schema, atomic claims, recovery, and memory records. |
| `swarm/engine.py` | Worker slots, timeouts, scheduling, and job dispatch. |
| `swarm/codex.py` | Codex App Server protocol, thread continuity, actions, and final responses. |
| `swarm/host_tools.py` | Codex tool adapter for local Nomad service requests and scoped batch jobs. |
| `scripts/host-worker/` | First-boot enrollment and socket-activated root worker. |
| `swarm/catalog.py` | Git import, asset discovery, and branch publishing. |
| `swarm/mesh.py` | Authenticated task delivery and status polling. |
| `swarm/http.py` | Local browser API, session authentication, and scoped incoming peer requests. |
| `swarm/web/` | One template per screen in `views/`, with shared markup and CSS. Alpine state is divided into dashboard, workspace, and peer components. `api.js` handles the HTTP calls. |
| `scripts/` | Zipapp build, verified tool downloads, Linux installer, and systemd unit. |

```sh
uv run ruff format --check .
uv run ruff check .
uv run python -m unittest discover -s tests -v
uv run python scripts/build.py
```

The tests use a local Codex protocol fixture for deterministic runs, real SQLite databases, temporary Git repositories, and loopback HTTP. No model credentials are required for the test suite.
