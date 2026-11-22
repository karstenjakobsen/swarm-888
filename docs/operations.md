# Operating the checkout

## Configuration and authority

Set `SWARM_PURPOSE` and `SWARM_INSTRUCTIONS` in the worker environment. A new thread receives these values, its checkpoint, recent sourced events and a compact skill index. Use conversation to create, update or delete project-scoped memories. Read-only artifact links identify immutable revisions.

The controller binds to loopback on `SWARM_PORT` (default 8880). An owner key creates a 12-hour HTTP-only, SameSite-strict session. Signed-in forms use per-session CSRF tokens. SSH forwarding protects remote traffic. The worker accepts RPC over a mode-0600 Unix socket in the owner's mode-0700 state directory. Processes running under this local account have owner authority. Treat the checkout, Codex installation and state directory as trusted.

Set `SWARM_CATALOG`, `SWARM_REMOTE` and `SWARM_BRANCH` before starting the worker to use a separate checkout, existing remote, and branch. Defaults are `$SWARM_STATE/catalog`, local Git only, and `main`. Give the development user normal Git authentication for the designated repository. Ask the operator to sync its catalog after adding a skill, project reference, or connector definition. Sync checks the configured origin, fetches and fast-forwards before pushing. Divergence requires the owner to reconcile the catalog in Git. Active local revisions can still run during a remote outage.

Skills can declare descriptive permissions, connector dependencies, and inline input/output JSON schemas. A generated SQL program runs in a resource-limited process with an in-memory database, a read-only statement authorizer, and an empty environment. A call pins its revision when it starts. Rollback changes future calls. Earlier activations, tests and independent observations remain available. Framework code, privilege policy, connector destination grants and recovery access are controlled by the checkout owner. To upgrade, stop the worker, export state, review the source change, and run the locked checks before restarting.

## Standing goals and notifications

With the worker running, create a disposable fixture as the owner:

```sh
install -m 600 /dev/null "${SWARM_STATE:-$HOME/.local/state/swarm-888}/fixtures/demo"
uv run --locked python -m swarm submit '/maintain demo 600 fixture-permissions 5'
```

This authorizes observing the named fixture and restoring its mode every five seconds. When the skill is missing the operator authors it before the worker binds the tested revision. After activation, change the fixture to mode 644 and inspect the incident in the console. A healthy scheduled observation uses zero model calls. The worker rechecks drift before a conditional repair and observes the result independently. Symlinks, multiply linked files, and inconclusive checks lead to unknown observations.

Use `/pause GOAL_ID`, `/resume GOAL_ID`, and `/retire GOAL_ID` in new conversations. An open incident supports `/diagnose INCIDENT_ID`, `/improve INCIDENT_ID`, and `/rebind INCIDENT_ID FULL_REVISION`. Diagnostics and revisions consume the existing incident's attempt and wall-clock budgets. Inspect the follow-up task for its result and the incident for the independently observed host outcome. An unresolved incident stops dispatch. After owner remediation, retire the old goal and establish a new one if continued maintenance is wanted.

Set `SWARM_NOTIFY_DIR` to a monitored, owner-controlled local directory to receive one redacted JSON file per unresolved incident, including ambiguous DNS operations. The default is the state's `notifications/` directory. The durable outbox retries failed delivery and publishes each ID atomically, including while the UI is closed.

## Optional UID 0 fixture worker

Stop the ordinary worker before starting this alternative. Use the prepared virtual environment and the same unprivileged controller:

```sh
uv run --locked python -m swarm owner-key
sudo .venv/bin/python -I -S swarm/root_worker.py --owner "$(id -un)" \
  --state "${SWARM_STATE:-$HOME/.local/state/swarm-888}" --user-path "$PATH"
```

The privileged parent opens the private state directory and handles fixture observations and conditional mode changes through an inherited Unix socket. The child permanently drops UID, GID and supplementary groups to the specified account before it starts the application. The console shows both observed execution identities. An owner-controlled root process can change host code and local data and can read locally available credentials. Protect the interpreter and launcher that you invoke with sudo. The CLI's existing file-backed login can also be configured directly in the private `sessions/` Codex home.

## DNS and ingress

Submit `/dns ZONE RELATIVE_NAME IPV4` as a new owner conversation. This grants a create-if-absent operation for that exact A record. For a missing token the console displays a write-only field bound to the waiting task. Supply a dedicated bearer token there. The worker discovers the provider's tools and checks their input schemas. It paginates observations, preserves conflicts, journals dispatch before a create, and verifies by reading the provider. After the owner resolves a conflicting record, send `recheck` as a follow-up to that conversation.

The example connector targets DigitalOcean's networking MCP service. An independent destination binding allows the credential only at its exact HTTPS endpoint. The HTTP client disables redirects. Set hard cloud limits using the provider account/token scopes or an independently administered gateway. A local target check cannot narrow a stolen provider token's authority. [DigitalOcean MCP documentation](https://docs.digitalocean.com/reference/mcp/)

The publishing procedure template covers existing ingress, DNS conflicts, an existing automatic ACME renewal mechanism, and service-specific verification. The independent HTTPS probe validates the certificate chain and hostname, then checks an expected application marker. An actual ingress deployment needs separately implemented host capabilities.

## Export, recovery and boot

Stop the worker and any independent process editing the external catalog before exporting. The worker lock prevents inconsistent application snapshots. Keep the archive private and restore only trusted archives. Export includes SQLite, skill objects, the catalog, workspaces, fixtures and runtime session files. Provision the owner key and connector/Codex credentials separately. An external catalog is restored into the new state's `catalog/` directory.

```sh
uv run --locked python -m swarm backup "$HOME/swarm-state.zip"
SWARM_STATE="$HOME/.local/state/swarm-restored" uv run --locked python -m swarm restore "$HOME/swarm-state.zip"
```

Restore requires a new destination. Unset `SWARM_CATALOG` to use the bundled restored checkout. Start both processes with the restored `SWARM_STATE`. Interrupted model work starts from the checkpoint. A dispatched DNS operation resumes observation and stays unknown if the provider cannot establish its outcome.

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
