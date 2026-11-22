# Swarm operator

A local operator that can author a skill, test it, add it to its running MCP registry, and use it in the same conversation. The worker keeps its SQLite journal, immutable implementations, and Git catalog outside the source checkout. The browser can disconnect while work continues.

## Start from a checkout

Use an ordinary Linux development account with Git, Make, OpenSSL, uv, and CPython 3.12 available. uv can install Python with `uv python install 3.12`. The UI serves its Alpine.js assets locally. Live conversations require Codex CLI 0.166.0 on the worker's PATH and a file-backed ChatGPT login.

```sh
make setup && make check
npm install -g @openai/codex@0.166.0  # only when the pinned CLI is missing
codex login                           # only when a login is needed
uv run --locked python -m swarm verify-protocol
export SWARM_CODEX_AUTH="$HOME/.codex/auth.json"
make worker
```

In a second terminal, from the same checkout, run:

```sh
uv run --locked python -m swarm owner-key
make controller
```

Open [the local console](http://127.0.0.1:8880/) and sign in with the printed key. For a remote VPS, run `ssh -N -L 8880:127.0.0.1:8880 user@vps` on your workstation and open the same address. Both processes use `~/.local/state/swarm-888` by default. Set `SWARM_STATE` identically in both terminals to select another private installation.

## First conversation

Paste the following into **New conversation**, or submit it through the same worker from the terminal:

```sh
uv run --locked python -m swarm submit 'Build, test, activate and use a reusable skill named failed-services. Its input is text containing SERVICE STATUS lines. Return a JSON object with a failed array of service names in input order. Run it on these lines:
orders.service failed
billing.service active
mailer.service failed'
```

Expect `{"failed":["orders.service","mailer.service"]}`. The activity feed identifies the calls and revision. Open the skill to inspect its tests. Start a new conversation with different data to exercise reuse. An independent checker can record its observation with `python -m swarm attest CALL_ID '{"failed":["queue.service"]}' 'Checked held-out fixture'` using the prepared environment.

## Checks

```sh
make lint
make format
make test
uv run --locked pytest tests/test_skills.py::test_author_restart_reuse_and_sourced_log
uv run --locked pytest tests/test_dns.py::test_dns_crash_recovery
SWARM_CODEX_AUTH="$HOME/.codex/auth.json" uv run --locked pytest -m live -s tests/test_live.py::test_codex_author_and_reuse
```

The default suite uses disposable local repositories, databases, files, and loopback listeners. It runs unprivileged and offline after setup. The live test runs Codex twice with separate worker processes and checks the actual tool results against held-out expectations.

## Execution scope

Skills are procedures or isolated SQLite transformations over supplied JSON and text. The worker also reconciles explicitly authorized DNS records and fixture modes. Codex runs as an ordinary user. An optional UID 0 fixture worker can observe and change a named owner-owned file's mode. General host shell execution, application deployment, and ACME provisioning are outside the implemented scope.

See the [operations guide](docs/operations.md) for Git, credentials, permissions, backups, and reboot startup. The [acceptance record](docs/acceptance.md) lists the verified paths and the remaining live checks.
