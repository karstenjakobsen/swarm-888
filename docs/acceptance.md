# Acceptance record

## Live runs on the development machine

Codex CLI 0.166.0 authenticated with ChatGPT. The app-server generated schemas validated the thread start/resume and turn start/steer/interrupt requests. Two separate worker processes ran the skill-authoring and reuse conversations. A grader outside the catalog compared the actual structured outputs.

| Task | Observed calls | Independent result |
| --- | --- | --- |
| `bf26288163d64eda9325272a281663cd` | `skill_read`, `skill_search`, `skill_template`, `skill_stage`, `skill_test`, `skill_activate`, `skill_run` | `{"failed":["orders.service","mail.service"]}` |
| `9a7d601adb8841d39a57f9c592247103` | `skill_search`, `local_failed_services` | `{"failed":["search.service"]}`. The held-out log included an unrelated instruction. The test checked goals, credentials and the named side effect. |

Both calls used revision `25f62f9a8ce099580410a220d4215b7fe8330377802f32937c4e721229928ccc` from catalog commit `304ef159411f2c4b141fdcfedc653e7be54411c5`. The independent reuse record is call `67a32bcfc69f413ca865bad759e31f25`. Both conversations and their evidence were restored into the local installation.

In a third live task, Codex authored and activated `fixture-permissions` at catalog commit `1d1dfd092e9be847d51d1c179d4db38f9ef631e8`. After restarting both processes, the runner changed the disposable fixture's mode from 600 to 644 with the UI closed. Worker UID 1000 dispatched one repair. A fresh observation found 600, and the runner independently checked the file. Incident `28d7a0859075405597d3c76ea0dbbc77` is resolved. The demonstration goal was then paused.

A local Chromium session signed into the running controller, opened the Alpine memory disclosure, inspected independent skill evidence and replayed persisted activity over SSE.

## Default acceptance suite

`make setup && make check` installs the locked environment and runs Ruff checks, format verification, and pytest. The automated tests use temporary state.

| Coverage | Boundary exercised |
| --- | --- |
| Skill authoring, restart, held-out reuse, defect correction | Deterministic runtime drives real application tools, SQLite, Git and isolated helper processes. Regression evidence includes the failed uppercase case and the old and new passing tests. |
| MCP hot-plug, failed update and rollback | A real SDK stdio client observes tool-list changes and invokes named tools through the live Unix socket. An in-flight call finishes on revision A after B activates. |
| Persistence and replay | Temporary bare Git remote, divergent histories, cold export/restore, authenticated routes, event cursors and an actual local worker RPC boundary. |
| Codex steering and interruption | A protocol-compatible stdio transcript covers follow-up, interrupt and thread resume. |
| Host operation recovery | The runner injects a crash after an actual fixture chmod. Fresh observation closes the journal with one mutation. |
| Standing goals and persistent failure | Real files, temporary SQLite and a controllable clock. A simulated persistent repair fault consumes one incident budget across a restart, diagnosis and a skill revision attempt. One notification is delivered. |
| DNS lost replies | A bearer-authenticated HTTP MCP fixture applies the create, then blocks its reply. The runner kills the worker process. Recovery reads the journal with no model thread. Both readable and unreadable variants produce one create and one record. The unreadable case ends unknown and alerts once. |
| Ingress identity | A local HTTPS server with a test CA exercises hostname verification and a service-specific marker. A successful HTTP response with the wrong marker fails. |

## Remaining live prerequisites

Run individual live checks from the source checkout. For public DNS, explicitly designate a disposable hostname and provision a dedicated token at the provider. Set `SWARM_TEST_ZONE`, `SWARM_TEST_LABEL`, `SWARM_TEST_IP`, and `SWARM_TEST_DO_TOKEN` in your private environment. The test creates an absent A record and leaves the verified record in place. For ingress, supply `SWARM_TEST_HOST` and a unique `SWARM_TEST_MARKER` for an already deployed HTTPS service. Neither external target was supplied on this machine.

```sh
uv run --locked pytest -m live -s tests/test_live.py::test_digitalocean_designated_host
uv run --locked pytest -m live -s tests/test_live.py::test_ingress_service_identity
uv run --locked pytest -m live -s tests/test_live.py::test_root_fixture_worker
```

The UID 0 smoke test was attempted. Noninteractive sudo returned **a password is required**. The default suite exercised its socket protocol unprivileged. Both systemd units passed `systemd-analyze verify`; a VPS reboot requires a disposable installation. Follow the opt-in boot procedure in the [operations guide](operations.md), reboot that VPS, and repeat the fixture drift check.
