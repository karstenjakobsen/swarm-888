# V1 acceptance and handoff

The approved frontend was imported from `/home/karsten/projects/github/karstenjakobsen/self-learning-vps-operator-design` at `af0bb8cc4299ddc02c5a609323797fec205ab750`. The source checkout was clean and supplied no local changes. The 52 tracked files landed in `web/` in import commit `412278b257f20a6376f0a6d52aa09493294ec864`. The imported tree ID was `df57fc0bc1b0cb7a77788386a0d2f3363aaf4cfa`.

The live application adds an authenticated transport and a browser projection for the recorded skill, memory, connector, and incident facts. Demo fixtures continue to exercise the imported design. See the [WSL2 startup and acceptance commands](../README.md) and the [server-212 installation and restore runbook](../deploy/README.md).

## Verified Docker walkthrough

**Executable skill authoring verified.** Codex CLI 0.166.0 wrote the inspection procedure on a fresh v2 catalog containing only the generic authoring skill. Docker Desktop 29.3.1 ran the fixtures in WSL2 using context `default`. The two owner requests went through Chromium at 390 × 844.

| Record | ID or revision |
| --- | --- |
| Creating task | `dd9f74b358b143df9667c1c1fa81198c` |
| Reuse task after worker restart | `327388abcbe84a529cd72cd6d2bec65f` |
| `container-status-by-label` | `8839aa367ac3e6f2240939d94b2ad870d49c5a74` |

Codex committed the [entry point](evidence/docker-executable/run.lua), [manifest](evidence/docker-executable/skill.json), and [self-tests](evidence/docker-executable/tests.json) together in the [recorded Git tree](evidence/docker-executable/git-tree.txt). The Lua entry point owns label selection, inspection, name normalization, field selection, exit-code handling, and ordering. The framework executes the pinned entry point and passes only commands allowed by the owner policy. The Docker command policy and independent grading live in the acceptance runner. The former `docker.inspect_labeled` provider has been removed.

The first task invoked the new revision on a running container, an exited container with code 7, and an empty selection. The second task invoked the same full SHA after the worker restarted, using a new label with different container names and exit code 13. Independent engine observations matched the exact rows and their order. [Creating task record](evidence/docker-executable/creating-task.json) · [Reuse task record](evidence/docker-executable/reuse-task.json) · [Independent observations](evidence/docker-executable/observations.json)

The local preview uses port 8084 and the owner key in `/tmp/operator-docker-wNmbaj/state/owner.key`. Open the [creating task](http://127.0.0.1:8084/work/dd9f74b358b143df9667c1c1fa81198c), [reuse task](http://127.0.0.1:8084/work/327388abcbe84a529cd72cd6d2bec65f), and [shared revision](http://127.0.0.1:8084/skills/container-status-by-label?rev=8839aa367ac3e6f2240939d94b2ad870d49c5a74).

The [earlier Codex](evidence/docker-codex.json) and [simulated](evidence/docker-simulated.json) records cover the previous declarative wrappers. Those runs verified the tool lifecycle and exact-SHA reuse. The wrapper records remain readable as historical evidence.

## Slice review and acceptance

| Slice | Implementation review | Acceptance |
| --- | --- | --- |
| 1–2 | Next.js selects the data source on the server. FastAPI owns authentication, commands, and replay. Stable request IDs make retries idempotent. | **Real** loopback Caddy, Next.js, SQLite, and worker. Playwright covered unauthorized reads, mutations and streams, a lost receipt, and a backend outage without fixture fallback. Demo DNS/TLS and credential examples are **simulated**. |
| 3 | Git stores definitions and immutable revisions. The Python MCP server owns discovery, self-tests and activation. The model adapter owns Codex app-server messages. | **Real** test Git remote and MCP list-change notification. A newly activated tool became callable on the same connection. Start and resume ran through the worker. Steer and interrupt were verified with a controllable model double. |
| 4 | The catalog entry point owns Docker inspection. The independent grader compares the recorded calls against separate Docker observations. | **Real** Codex-authored executable and same-SHA reuse after worker restart. [Executable run observations](evidence/docker-executable/observations.json) |
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
