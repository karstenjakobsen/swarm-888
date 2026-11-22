# V1 acceptance and handoff

The approved frontend was imported from `/home/karsten/projects/github/karstenjakobsen/self-learning-vps-operator-design` at `af0bb8cc4299ddc02c5a609323797fec205ab750`. The source checkout was clean and supplied no local changes. The 52 tracked files landed in `web/` in import commit `412278b257f20a6376f0a6d52aa09493294ec864`. The imported tree ID was `df57fc0bc1b0cb7a77788386a0d2f3363aaf4cfa`.

The live application adds an authenticated transport and a browser projection for the recorded skill, memory, connector, and incident facts. Demo fixtures continue to exercise the imported design. See the [WSL2 startup and acceptance commands](../README.md) and the [server-212 installation and restore runbook](../deploy/README.md).

## Verified Docker walkthrough

**Autonomous authoring verified.** Codex CLI 0.166.0 drove authoring through the local MCP server. Docker Desktop 29.3.1 ran the fixture containers in WSL2 using context `default`. The runner started with an empty bare catalog, initialized the bundled seed, and submitted the two requests through Chromium at 390 × 844.

| Record | ID or revision |
| --- | --- |
| Creating task | `67c1e918dd814d49b832f2e367fd9bb6` |
| Reuse task after worker restart | `5334e431cdee4b4e8335613f17c5996c` |
| `docker-container-state` | `b9a691ea41c67de657181731d3022ec20b181aeb` |

The creating task searched for Docker coverage and found no match. It read the foundational guide, committed and self-tested a new skill, activated that SHA and called it on both input labels. The runner observed one running container and one exited container with code 7. The empty label returned zero rows. After the worker restart, the second task invoked the same full SHA without an intervening catalog commit. Its different label matched one running container and one exited container with code 13. Both comparisons included the exact names, images and states from Docker. [Autonomous run observations](evidence/docker-codex.json)

The runner exported that state and restored it with a separate catalog checkout. Both original task pages opened at the saved cursor `24`. The restored revision ran against a new empty Docker selection. The local restored preview uses port 8083. Its owner key is in `/tmp/operator-docker-RUtS1K/restored/owner.key`. Open the [creating task](http://127.0.0.1:8083/work/67c1e918dd814d49b832f2e367fd9bb6), [reuse task](http://127.0.0.1:8083/work/5334e431cdee4b4e8335613f17c5996c), and [shared revision](http://127.0.0.1:8083/skills/docker-container-state?rev=b9a691ea41c67de657181731d3022ec20b181aeb).

## Slice review and acceptance

| Slice | Implementation review | Acceptance |
| --- | --- | --- |
| 1–2 | Next.js selects the data source on the server. FastAPI owns authentication, commands, and replay. Stable request IDs make retries idempotent. | **Real** loopback Caddy, Next.js, SQLite, and worker. Playwright covered unauthorized reads, mutations and streams, a lost receipt, and a backend outage without fixture fallback. Demo DNS/TLS and credential examples are **simulated**. |
| 3 | Git stores definitions and immutable revisions. The Python MCP server owns discovery, self-tests and activation. The model adapter owns Codex app-server messages. | **Real** test Git remote and MCP list-change notification. A newly activated tool became callable on the same connection. Start and resume ran through the worker. Steer and interrupt were verified with a controllable model double. |
| 4 | The Docker adapter returns selected fields. The independent grader compares the recorded call to separate engine observations. | **Real** autonomous Codex run and exact-SHA reuse. Also **integration verified with simulated authoring**, using real Git, Docker, MCP and persistence. [Simulated authoring observations](evidence/docker-simulated.json) |
| 5 | The worker journals authorization, target, pinned revision and dispatch count before changing a fixture. Rollback restores a previously active tested revision. | **Real** Docker start and worker termination followed by reconciliation. One dispatch. **Simulated unreadable target** ended unknown after bounded observations. MCP tests held an invocation open across activation and verified a rejected candidate and rollback. |
| 6 | Catalog updates fast-forward. Conflicts preserve both Git histories. Memory revisions retain their writers and exact reads. | **Real** two checkouts, conflict and offline retained invocation. A phone-width UI correction and later read used the **simulated model** with real memory persistence. |
| 7 | The authenticated request goes to FastAPI. The vault binds its token to an owner-approved destination before the MCP client can send it. | **Real** loopback Streamable HTTP with a synthetic token. Credential submission resumed the original task. A changed endpoint was blocked. A delayed read timed out and produced no successful call. The fixture's echoed token was redacted. |
| 8 | The worker owns scheduling and budgets. A file-mode skill can repair a single owned file in the external defense directory. | **Real** WSL2 file and permission reads. Controlled clock proved zero repair while paused, zero healthy model calls, one attention event, and retention of the incident budget across worker state reload and a corrected revision. |
| 9 | Backup locks the services, snapshots SQLite, and captures immutable contents, workspaces and the local catalog bundle. | **Real** WSL2 restored state, saved cursor and incident budget. Systemd units passed static verification with local executable paths. VPS installation, VPS reboot, and root worker execution on the VPS are **unrun**. The observed WSL2 worker identity was UID 1000 and GID 1000. |

## Repeat verification

```sh
make setup && make check
make test-live-ui
make acceptance-recovery
OPERATOR_ACCEPTANCE_MODEL=codex make acceptance-docker
OPERATOR_ACCEPTANCE_MEMORY=1 OPERATOR_ACCEPTANCE_CONNECTOR=1 OPERATOR_ACCEPTANCE_DEFENSE=1 make acceptance-docker
```

Use `CADDY=/absolute/path/to/caddy` where Caddy is outside PATH. The fixture image is `alpine:3.22`. Install Chromium as documented in the root README. Codex mode requires an authenticated CLI as the worker user.

The acceptance command also cleans up by its unique label after the browser process exits. A forced subprocess failure preserved exit status 17 and removed the fixture it created.
