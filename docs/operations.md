# Operating the checkout

## Configuration and authority

Set `SWARM_PURPOSE` and `SWARM_INSTRUCTIONS` in the worker environment. A new thread receives these values, its checkpoint, recent sourced events and a compact skill index. Use conversation to create, update or delete project-scoped memories. Read-only artifact links identify immutable revisions.

The controller binds to loopback on `SWARM_PORT` (default 8880). An owner key creates a 12-hour HTTP-only, SameSite-strict session. Signed-in forms use per-session CSRF tokens. SSH forwarding protects remote traffic. The worker accepts RPC over a mode-0600 Unix socket in the owner's mode-0700 state directory. Processes running under this local account have owner authority. Treat the checkout, Codex installation and state directory as trusted.

Set `SWARM_CATALOG`, `SWARM_REMOTE` and `SWARM_BRANCH` before starting the worker to use a separate checkout, existing remote, and branch. Defaults are `$SWARM_STATE/catalog`, local Git only, and `main`. Give the development user normal Git authentication for the designated repository. Ask the operator to sync its catalog after adding a skill, project reference, or connector definition. Sync checks the configured origin, fetches and fast-forwards before pushing. Divergence requires the owner to reconcile the catalog in Git. Active local revisions can still run during a remote outage.

Ask `Create a project named heartbeat containing …` in a new conversation, or submit `/project heartbeat REQUEST`. A follow-up can revise the same project's sources. Each edit starts from the observed Git commit and changes only the supplied files. The catalog records a state-relative repository reference in `projects/heartbeat.json`. Source commits live in the private bare repository at `$SWARM_STATE/workspaces/projects/heartbeat.git` and travel with an installation backup. A normal Git clone produces an editable working tree. After an interrupted save, the worker checks the recorded commit against the branch before finishing the catalog update.

Skills can declare descriptive permissions, connector dependencies, and inline input/output JSON schemas. A generated SQL program runs in a resource-limited process with an in-memory database, a read-only statement authorizer, and an empty environment. A call pins its revision when it starts. Rollback changes future calls. Earlier activations, tests and independent observations remain available. Framework code, privilege policy, connector destination grants and recovery access are controlled by the checkout owner. To upgrade, stop the worker, export state, review the source change, and run the locked checks before restarting.

When an independent check finds an incorrect result, record its expected JSON with `python -m swarm attest CALL_ID EXPECTED_JSON OBSERVATION` using the prepared environment. Submit `/learn CALL_ID` to authorize a correction. The operator retrieves the redacted input and check, reproduces the failure, and tests a candidate against the inherited cases and a new regression case. The worker compares the candidate to the original independent expectation before activating it, then invokes the active revision again. The original failed call and the correction have separate records. Each learning task has a five-minute deadline and a budget of 24 actions, carried across restarts.

If a helper exits before returning JSON, its MCP error and the skill view give the failed call ID. Record the output the call should have returned with the same `attest` command. The worker retains the redacted input, error and observed process exit status. A learning run checks that the same failure occurs on the original revision before trying a correction.

## Standing goals and notifications

With the worker running, create a disposable fixture as the owner:

```sh
install -m 600 /dev/null "${SWARM_STATE:-$HOME/.local/state/swarm-888}/fixtures/demo"
uv run --locked python -m swarm submit '/maintain demo 600 fixture-permissions 5'
```

This authorizes observing the named fixture and restoring its mode every five seconds. When the skill is missing the operator authors it before the worker binds the tested revision. After activation, change the fixture to mode 644 and inspect the incident in the console. A healthy scheduled observation uses zero model calls. The worker rechecks drift before a conditional repair and observes the result independently. Symlinks, multiply linked files, and inconclusive checks lead to unknown observations.

Use `/pause GOAL_ID`, `/resume GOAL_ID`, and `/retire GOAL_ID` in new conversations. An open incident supports `/diagnose INCIDENT_ID`, `/improve INCIDENT_ID`, and `/rebind INCIDENT_ID FULL_REVISION`. Diagnostics and revisions consume the existing incident's attempt and wall-clock budgets. Inspect the follow-up task for its result and the incident for the independently observed host outcome. An unresolved incident stops dispatch. After owner remediation, retire the old goal and establish a new one if continued maintenance is wanted.

Set `SWARM_NOTIFY_DIR` to a monitored, owner-controlled local directory to receive one redacted JSON file per unresolved incident, including ambiguous DNS operations. The default is the state's `notifications/` directory. To deliver over HTTPS, set `SWARM_NOTIFY_URL` to an owner-controlled alert collection. The receiver must upsert the JSON alert on `PUT <collection>/<incident-id>` and honor its `Idempotency-Key`. This selects HTTPS as the delivery destination. The durable outbox retries failed delivery and publishes each ID atomically, including while the UI is closed.

## Optional UID 0 fixture worker

For a supervised development run, stop the ordinary worker and use the prepared virtual environment and the same unprivileged controller.

```sh
uv run --locked python -m swarm owner-key
sudo .venv/bin/python -I -S swarm/root_worker.py --owner "$(id -un)" \
  --state "${SWARM_STATE:-$HOME/.local/state/swarm-888}" --user-path "$PATH"
```

The privileged parent opens the private state directory and handles fixture observations and conditional mode changes through an inherited Unix socket. Before starting the application, the child loads the selected account's supplementary groups with `initgroups` and switches its real, effective and saved UID and GID to that account. The console reports both process UIDs. Check `id ACCOUNT` for the privileges the worker inherits.

For unattended privileged startup, use a dedicated account without Docker socket access or sudo grants. The interpreter, privileged launcher and their parent directories must be controlled by root. An account that can edit or replace the launcher controls what executes at the next privileged start. The development command above assumes an owner-supervised checkout. The CLI's existing file-backed login can also be configured directly in the private `sessions/` Codex home.

## DNS and ingress

Submit `/dns ZONE RELATIVE_NAME IPV4` as a new owner conversation. This grants a create-if-absent operation for that exact A record. For a missing token the console displays a write-only field bound to the waiting task. Supply a dedicated bearer token there. The worker discovers the provider's tools and checks their input schemas. It paginates observations, preserves conflicts, journals dispatch before a create, and verifies by reading the provider. After the owner resolves a conflicting record, send `recheck` as a follow-up to that conversation.

The default connector targets DigitalOcean's networking MCP service. For direct access, provision a dedicated token with the `domain:create` and required `domain:read` scopes in the designated team. DigitalOcean enforces those scopes at its API. They cover domains and records in that team. The worker discovers the networking tools and checks the provider's input and output schemas. [DigitalOcean scope documentation](https://docs.digitalocean.com/reference/api/scopes/domain/create/) · [DigitalOcean networking tools](https://docs.digitalocean.com/reference/mcp/networking-mcp-tools/)

For an independently administered gateway that enforces individual record restrictions, configure its HTTPS endpoint and a dedicated gateway secret reference under `digitalocean` in both the Git connector and the owner's grants file described below. The gateway must expose `domain-record-list` and `domain-record-create` with the DigitalOcean networking schemas. Keep the upstream DigitalOcean token at the gateway and enter only the gateway token in the console. Restart the worker when changing the DNS provider. A pending DNS operation retains its original endpoint and secret reference across restart and waits if that binding changes.

To publish an existing service, provide a running loopback HTTP upstream, a Caddy HTTPS listener and curl. Caddy must expose its admin API on a private Unix socket accessible by the worker. Set the admin options `"origins":["http://localhost"]` and `"enforce_origin":true`. Access to this socket grants configuration authority to local processes that can open it. Keep Caddy's autosave enabled, preserve its certificate storage, and configure its supervisor to load the saved configuration with `caddy run --resume` after restart. Caddy handles ACME issuance and renewal while the operator is offline. [Caddy automatic HTTPS](https://caddyserver.com/docs/automatic-https)

Set `SWARM_INGRESS_CONFIG` in the worker environment to the absolute path of an owner-maintained JSON file outside the catalog. Replace the example addresses, marker and socket with values for the designated service. For a private CA, set `ca_file` to an absolute PEM trust bundle. The default probe uses system roots.

```json
{
  "admin_socket": "/run/caddy/admin.sock",
  "server": "edge",
  "https_port": 443,
  "services": {
    "orders": {
      "zone": "example.com",
      "label": "orders",
      "address": "192.0.2.8",
      "upstream_port": 9001,
      "marker": "orders-service-v1"
    }
  }
}
```

Submit `Publish the orders service at orders.example.com with TLS` or `/publish orders`. The operator acquires the publishing skill, checks the listener, probes the upstream, reconciles DNS and installs an exact-host reverse proxy. A wildcard or ambiguous existing route or record can require owner direction. Send `recheck` after resolving it. The task records the Caddy route ID, pinned revision, certificate fingerprint, expiry and application check. A lost configuration reply enters observation. A concurrent Caddy edit invalidates the conditional write. [Caddy API concurrency](https://caddyserver.com/docs/api#concurrent-config-changes)

For a deliberate reversal, inspect the current full configuration and the recorded route ID. Confirm the route still points to the recorded host and upstream before using the Caddy admin API to delete that exact route with the observed ETag. Review DNS separately because another service may now depend on the record.

## Using another MCP provider

Define a catalog connector through the conversation. For example, ask the operator to create a connector named `monitoring` with endpoint `https://monitor.example.com/mcp`, bearer authentication and secret reference `monitoring-reader`. Configure its actual read-only credential at the provider. Set `SWARM_CONNECTOR_GRANTS` in the worker environment to an owner-maintained JSON file outside the catalog and the operator's writable projects. Replace the example endpoint, tool and arguments with values from the designated provider.

```json
{
  "monitoring": {
    "endpoint": "https://monitor.example.com/mcp",
    "authentication": "bearer",
    "secret": "monitoring-reader",
    "observations": {
      "orders": {"tool": "unit-report", "arguments": {"service": "orders"}}
    }
  }
}
```

Submit `/observe monitoring orders` to read and journal the report. Add an instruction to have a skill process it, for example `/observe monitoring orders Use failed-services on the returned text`. On first use, the authenticated password field identifies the credential destination. The worker checks the owner binding and Git definition, discovers the tool, and invokes it with the granted arguments. The credential stays bound to that endpoint. Owner-defined observations must be read-only at the service. The worker makes at most four attempts in three minutes before recording an unknown outcome. Use `recheck` on that task to retry after resolving a problem.

A successful observation stays available through `connector_result` with its source task ID. Follow-ups reuse the saved, redacted result after a restart. Submit a new observation task for fresh data.

## Export, recovery and boot

Stop the worker and any independent process editing the external catalog before exporting. The worker lock prevents inconsistent application snapshots. Keep the archive private and restore only trusted archives. Export includes SQLite, skill objects, the catalog, workspaces, fixtures and runtime session files. Provision the owner key and connector/Codex credentials separately. An external catalog is restored into the new state's `catalog/` directory.

```sh
uv run --locked python -m swarm backup "$HOME/swarm-state.zip"
SWARM_STATE="$HOME/.local/state/swarm-restored" uv run --locked python -m swarm restore "$HOME/swarm-state.zip"
```

Restore requires a new destination. Unset `SWARM_CATALOG` to use the bundled restored checkout. Start both processes with the restored `SWARM_STATE`. Interrupted model work starts from the checkpoint. After a crash during a DNS create, a fresh Codex thread can query the provider through one observation tool bound to the recorded operation. The worker retains the attempt budget across recovery and alerts once if the outcome stays unknown.

For opt-in reboot startup on a systemd VPS, the two user units in `deploy/` use this checkout's path under the owner's home. Adjust the paths for a different checkout. With the foreground processes stopped, run:

```sh
install -d -m 700 "$HOME/.config/swarm-888"
printf 'PATH=%s\nSWARM_CODEX_AUTH=%s/.codex/auth.json\n' "$PATH" "$HOME" > "$HOME/.config/swarm-888/environment"
systemctl --user link "$PWD/deploy/swarm-worker.service" "$PWD/deploy/swarm-controller.service"
systemctl --user daemon-reload
systemctl --user enable --now swarm-worker.service swarm-controller.service
sudo loginctl enable-linger "$(id -un)"
systemctl --user status swarm-worker.service swarm-controller.service
```

After reboot, the worker resumes scheduling from SQLite and serves the controller on its private socket. Disable startup with `systemctl --user disable --now swarm-controller.service swarm-worker.service`. Keep linger enabled if other user services depend on it.

To exercise reboot recovery on a disposable VPS, enable the units and lingering as above. Create a fresh fixture and submit the standing goal while the worker is running.

```sh
install -m 600 /dev/null "${SWARM_STATE:-$HOME/.local/state/swarm-888}/fixtures/boot-demo"
uv run --locked python -m swarm submit '/maintain boot-demo 600 fixture-permissions 3'
```

Record the goal ID shown in the console and wait for its first healthy observation. Save the current boot ID from `cat /proc/sys/kernel/random/boot_id`. Stop the two units with `systemctl --user stop swarm-controller.service swarm-worker.service`, change the fixture to mode 644, and reboot the disposable VPS. After it comes back, run the following from the checkout with the two saved values. The grader reads the boot identity, post-boot journal, fixture, socket and HTTP endpoint.

```sh
SWARM_TEST_PREVIOUS_BOOT_ID=PREVIOUS_BOOT_UUID SWARM_TEST_BOOT_GOAL=GOAL_ID \
  uv run --locked pytest -m live -s tests/test_live_boot.py
```
