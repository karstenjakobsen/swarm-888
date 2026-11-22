# Acceptance record

## Live runs on the development machine

Codex CLI 0.166.0 authenticated with ChatGPT. The app-server generated schemas validated the thread start/resume and turn start/steer/interrupt requests. Two separate worker processes ran the skill-authoring and reuse conversations. A grader outside the catalog compared the actual structured outputs.

| Task | Observed calls | Independent result |
| --- | --- | --- |
| `bf26288163d64eda9325272a281663cd` | `skill_read`, `skill_search`, `skill_template`, `skill_stage`, `skill_test`, `skill_activate`, `skill_run` | `{"failed":["orders.service","mail.service"]}` |
| `9a7d601adb8841d39a57f9c592247103` | `skill_search`, `local_failed_services` | `{"failed":["search.service"]}`. The held-out log included an unrelated instruction. The test checked goals, credentials and the named side effect. |

Both calls used revision `25f62f9a8ce099580410a220d4215b7fe8330377802f32937c4e721229928ccc` from catalog commit `304ef159411f2c4b141fdcfedc653e7be54411c5`. The independent reuse record is call `67a32bcfc69f413ca865bad759e31f25`. Both conversations and their evidence were restored into the local installation.

In a third live task, Codex authored and activated `fixture-permissions` at catalog commit `1d1dfd092e9be847d51d1c179d4db38f9ef631e8`. After restarting both processes, the runner changed the disposable fixture's mode from 600 to 644 with the UI closed. Worker UID 1000 dispatched one repair. A fresh observation found 600, and the runner independently checked the file. Incident `28d7a0859075405597d3c76ea0dbbc77` is resolved. The demonstration goal was then paused.

A disposable Ubuntu 24.04.5 guest running under unprivileged QEMU exercised a full reboot. The runner verified Canonical's signed image checksum and retested the previously authored permissions package in the guest. With lingering enabled, the shipped systemd user units resumed goal `232ba97f525b4bfcbb0d9ed0d8eca7fb` across boot IDs `d1adbc48-f538-4404-a662-ce6aea52bfea` and `ee2fa662-952b-4cce-83dd-c14f1e4d7f71`. Before any post-reboot SSH login, an independent grader reported one verified repair from mode 644 to 600, resolved incident `2e1b6b1a3af040b7b69bfa90a9d4cc7c`, and HTTP 200 from the controller. A second grader checked the post-boot journal, live file, worker socket, controller login page, and absence of model activity for the goal. [Ubuntu minimal cloud images](https://cloud-images.ubuntu.com/minimal/releases/noble/release/)

A local Chromium session signed into the running controller, opened the Alpine memory disclosure, inspected independent skill evidence and replayed persisted activity over SSE.

In live task `544b35e3e9714054b2da28655789d6ca`, Codex created the `heartbeat` project, saved its two source files, and read back both. The independent grader cloned commit `03bce10f9b8bbbb3ca60dc187af801689bc2a5b0`, parsed the requested JSON, and checked that the README identified the file.

In live task `a8d7a0d0b99f473fadba60172a4280da`, the owner supplied only the failed call ID `6a94cad291204822821e5b18f61ef6cc`. The seeded case-sensitive revision returned an empty array for mixed input containing `archive.service FAILED`. Codex added a single-line uppercase regression and retained the original lowercase case. Both passed. The independent expectation on the original input was `{"failed":["archive.service"]}`. The newly active revision `371d12db4ab6ca436fb97d1688109b17f237137e56bc9f211682c7f6cf57b427` at catalog commit `e30ce9bfcddefcf184af482fe260ac8f143246bc` produced that result.

Two live Codex recovery threads used a bearer-authenticated loopback MCP provider after the test runner killed the process that dispatched a DNS create. Each fresh thread called `connector_observe_recovery` with the intent saved in SQLite. Thread `01a202f7-f720-7aa1-a8d0-51b266441dda` verified the requested record on its first read. Thread `01a202f8-2942-7d53-91ff-2ddc64e7782d` encountered an unreadable provider. The worker stopped after three post-crash reads and delivered one notification. The provider logged exactly one create and retained exactly one record in each test.

A separate loopback integration used Caddy 2.6.2, Pebble 2.4.0, a private ACME test CA, an HTTP orders service, a fixture DNS connector and a deterministic skill-authoring runtime. Pebble validated the TLS-ALPN-01 challenge. An independent TLS client verified the hostname and read `orders-v1`. With no further operator calls, it observed Caddy replace leaf SHA-256 `e93dd39ab24e31b7dc3cd83ef33ae0136527924f96b390515a38ffd5238a9c0f` with `191d67e595539a295bd449998291be289afaadd263294577ce60016f60a55ec0` and verified the same service again. The test accelerates renewal only in its disposable Caddy configuration.

The same integration also passed with real Codex. In task `66f105f9273b4241b68c8190eebc9851` it read the foundation, searched the catalog, staged, tested and activated publishing revision `ae4cd4700970043ff4ff31675c4951eff854a872702e8f31f6d67458f77a9c96`. The runner verified the orders response before and after the leaf changed from `5fafbf68e48341922a9756af2386039a5ce8a4610c5c1c0257d3fb752360ef8f` to `416a55740a833ab32c33b386015a4a9c8343d6b9270ca27b832c6f8a69ddaaa4`.

```sh
SWARM_CODEX_AUTH="$HOME/.codex/auth.json" uv run --locked pytest -m live -s tests/test_live.py::test_codex_dns_recovery
SWARM_CODEX_AUTH="$HOME/.codex/auth.json" uv run --locked pytest -m live -s tests/test_live.py::test_codex_creates_project
SWARM_CODEX_AUTH="$HOME/.codex/auth.json" uv run --locked pytest -m live -s tests/test_live.py::test_codex_learns_from_failed_check
# Put caddy, pebble and pebble-challtestsrv on PATH, then run
SWARM_CODEX_AUTH="$HOME/.codex/auth.json" uv run --locked pytest -m live -s tests/test_live_ingress.py
```

## Default acceptance suite

`make setup && make check` installs the locked environment and runs Ruff checks, format verification, and pytest. The automated tests use temporary state. Notification tests also simulate an HTTPS receiver that accepts delivery and loses its reply. The receiver sees one incident ID across both attempts.

| Coverage | Boundary exercised |
| --- | --- |
| Skill authoring, restart, held-out reuse, defect correction | Deterministic runtime drives real application tools, SQLite, Git and isolated helper processes. Regression evidence includes the failed uppercase case and the old and new passing tests. |
| MCP hot-plug, failed update and rollback | A real SDK stdio client observes tool-list changes and invokes named tools through the live Unix socket. An in-flight call finishes on revision A after B activates. |
| Persistence and replay | Temporary bare Git remote, divergent histories, cold export/restore, authenticated routes, event cursors and an actual local worker RPC boundary. |
| Application projects | A conversation creates a cloneable source repository and a catalog reference. The runner checks stale-edit rejection, export/restore, and recovery after the Git branch advanced but before the catalog reference was recorded. |
| Codex steering and interruption | A protocol-compatible stdio transcript covers follow-up, interrupt and thread resume. |
| Host operation recovery | The runner injects a crash after an actual fixture chmod. Fresh observation closes the journal with one mutation. |
| Standing goals and persistent failure | Real files, temporary SQLite and a controllable clock. A simulated persistent repair fault consumes one incident budget across a restart, diagnosis and a skill revision attempt. One notification is delivered. |
| DNS lost replies | The runner kills the dispatching process. A fresh runtime exercises the checkpoint-bound provider observation. Both outcomes produce one create and one record. The unreadable case ends unknown and alerts once. |
| Ingress publication and identity | Fixture Caddy transport and real local HTTP MCP exercise conflicting ingress, unavailable upstream, conflicting DNS, a lost configuration reply and restart. An independent local HTTPS test rejects a default-backend response with the wrong marker. |

## Remaining live prerequisites

Run individual live checks from the source checkout. For public DNS, explicitly designate a disposable hostname and provision a dedicated token at the provider. Set `SWARM_TEST_ZONE`, `SWARM_TEST_LABEL`, `SWARM_TEST_IP`, and `SWARM_TEST_DO_TOKEN` in your private environment. The test creates an absent A record and leaves the verified record in place. For ingress, supply `SWARM_TEST_HOST` and a unique `SWARM_TEST_MARKER` for an already deployed HTTPS service. Neither external target was supplied on this machine.

```sh
uv run --locked pytest -m live -s tests/test_live.py::test_digitalocean_designated_host
uv run --locked pytest -m live -s tests/test_live.py::test_ingress_service_identity
uv run --locked pytest -m live -s tests/test_live.py::test_root_fixture_worker
```

The UID 0 smoke test passed in the disposable Ubuntu guest. The application worker reported UID 1000, its fixture broker reported UID 0, and the runner independently measured mode 600 on a fixture originally set to 000. Incident `7831e0036e964b8bafa0d4d35739241e` resolved. On the development host, noninteractive sudo requires a password. The default suite exercises the broker protocol unprivileged. Both shipped units also passed `systemd-analyze verify`. The [operations guide](operations.md) gives the opt-in reboot procedure and the read-only post-boot pytest command.
