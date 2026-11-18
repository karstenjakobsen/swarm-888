# Operator setup with Ansible

`setup.yml` installs the operator on a Debian/Ubuntu host with systemd. It creates
a normal controller account, installs the pinned Node runtime and application
dependencies, builds the web UI, and enables persistent services for the
controller, default user worker, and named root worker.

Run it against localhost or an SSH host. The target needs Python 3 and either
root access or an account with sudo. The controller and user worker run as the
configured normal user; the root worker executes as root and can administer the
host.

## Prepare the control machine

Install uv and use Python 3.12 or newer. From the repository root, create the
project environment with the dependencies pinned by `pyproject.toml` and
`uv.lock`:

```sh
uv sync --dev
uv run ansible-playbook --version
```

This installs Ansible Core in the repository's `.venv`, with ansible-lint and
Ruff for development checks. The playbook uses built-in Ansible modules only.

From the repository root, create your private configuration:

```sh
cp ansible/vars.example.yml ansible/vars.local.yml
chmod 600 ansible/vars.local.yml
```

Edit `vars.local.yml` before running the playbook. Set an administrator password
of at least 12 characters for a new installation. This file is gitignored;
Ansible Vault can encrypt it with `uv run ansible-vault encrypt ansible/vars.local.yml`.
Add `--ask-vault-pass` when running with an encrypted file. Passwords and generated
environment contents are hidden from task output and diffs. For environment-file
quoting, the password must have no newlines and omit either single quotes or backticks.

## Run the setup

For an SSH alias such as `server-212`, Ansible can use your existing SSH config:

```sh
uv run ansible-playbook ansible/setup.yml -i server-212, -e @ansible/vars.local.yml
```

For the existing `server-212` installation, commit and push your tested operator
changes to `swarm-888/main`, then run Ansible from your local checkout with its
checked-in [server profile](vars/server-212.yml):

```sh
uv run ansible-playbook ansible/setup.yml -i server-212, \
  -e @ansible/vars/server-212.yml --check
# Deploy the latest published main and apply setup changes:
uv run ansible-playbook ansible/setup.yml -i server-212, \
  -e @ansible/vars/server-212.yml
```

This profile selects `/home/swarm/swarm-888/.env` on the remote host through
`operator_env_file` and preserves that file. It contains deployment settings only;
the administrator password and other environment secrets stay on the server.
No password variable is needed while the existing environment file is retained.
The profile deploys the latest published `main` to `/home/swarm/swarm-888` as
`swarm`. Ansible resolves the revision to an exact commit, reserves idle workers,
stops services, updates the source, builds, restarts, and verifies health. Local
uncommitted or unpushed changes are not deployed. No separate server login or
manual `git pull` is needed.

The trailing comma makes this a one-host inventory. Add `--ask-become-pass` if
the remote account requires a sudo password. The target also needs Git access to
the configured repository when creating or updating a checkout; a private repository may
require a deploy key already available to the configured controller user.

For the machine running Ansible:

```sh
uv run ansible-playbook ansible/setup.yml -i localhost, -c local \
  --ask-become-pass -e @ansible/vars.local.yml
```

Local setup installs system services and a dedicated account just like remote
setup. To build a checkout that you manage yourself, set
`operator_manage_checkout: false` and configure its path and controller account
in your private variables. That account must be able to read the checkout and
write its dependencies and build output.

## Configuration and repeated runs

Defaults are in [vars/defaults.yml](vars/defaults.yml), with editable examples in
[vars.example.yml](vars.example.yml). The default installation uses:

| Setting | Default |
| --- | --- |
| Controller account | `swarm` |
| Checkout | `/home/swarm/swarm-888` |
| Environment file | `/home/swarm/swarm-888/.env` |
| Persistent state | `/home/swarm/.local/share/vps-ai-operator` |
| Project workspaces | `/home/swarm/packages` |
| Node runtime | `/opt/node-v26.13.1` |
| Controller listener | `127.0.0.1:3001` |
| Root worker | `root`, `gpt-6.1-sol`, reasoning effort `high` |

With `operator_manage_checkout: true`, every run resolves `operator_repo_version`
(default `main`) from `operator_repo_url` and deploys that exact commit. The
version can be a branch, tag, or full commit SHA. Checkout happens after worker
reservation and service shutdown. Managed deployments use a detached HEAD so a
branch moving during deployment cannot change the selected release. Subsequent
updates go through Ansible rather than `git pull` in that checkout.

Local source changes and revisions that do not retain the deployed history are
rejected. Reconcile those changes before retrying; the playbook does not reset
local commits. `operator_manage_checkout: false` skips source updates and builds
the files already present. Use `-e operator_rebuild=true` to force dependency
installation and rebuilding on a run.

Build inputs are fingerprinted. An unchanged commit and configuration do not
cause another build or service restart. Dependencies include development
dependencies because the running application uses the pinned TypeScript loader.
After health checks pass, `APP_STATE_DIR/deployment.commit` records the deployed
commit.

The running controller reports its startup commit at `/api/version`. Deployment
verifies that value and checkout `HEAD` against the selected commit before recording
success. If the checkout was updated manually while the controller kept running,
Ansible detects the old running version and restarts it.

## Package repository authentication

`operator_git_ssh_keys` lists controller-owned SSH identities and their package
checkout directories. Ansible creates missing keys, preserves existing keys, and
selects each identity through that repository's local Git configuration. With
`operator_github_ssh_known_hosts: true`, it installs the SSH host keys published
by GitHub over verified HTTPS.

The `server-212` profile uses `/home/swarm/.ssh/id_ed25519_packages_888` for
`packages-888`. Its public key is registered as a write-enabled deploy key for
that repository. Private keys stay on the VPS. For a new host or repository,
register the generated `.pub` file in the repository's **Settings → Deploy keys**
with write access before enabling remote publishing.

In **Repositories → Remote publishing**, the owner enables pushing and chooses
the destination branch. Automatic publishing queues accepted package commits;
the controller sends them as `swarm` after source finalization. Git authentication
and these per-repository publishing settings are separate, and both are retained
across operator deployments.

`operator_env_file` selects the target host's environment file and defaults to
`{{ operator_checkout }}/.env`. An existing file is preserved. Inventory changes
to environment settings take effect when you set `operator_replace_env: true`;
provide the administrator password again when regenerating it. Existing application state, worker profiles,
and saved authentication remain in their persistent directories. Existing named
worker model, effort, and permission mode must match the requested settings.

Repeated runs retain unchanged services. Maintenance that requires stopping a
worker first reserves idle execution; busy or uncertain work must finish or be
reconciled before retrying setup.

Default browser origins use the built UI on localhost port 3001. For a domain,
configure its exact HTTPS origin before creating or replacing `.env`. A reverse
proxy, TLS certificate, and public networking are configured separately. For
loopback access from another machine, use:

```sh
ssh -L 3001:127.0.0.1:3001 server-212
```

Then open `http://localhost:3001`. New worker profiles need their own **Workers →
Sign in** in the UI. An installed, running service can still be waiting for its
first model sign-in; existing profiles retain their saved sign-in.

## Check and inspect

These commands validate the playbook or list its tasks without changing a host:

```sh
uv run ansible-playbook ansible/setup.yml -i localhost, --syntax-check
uv run ansible-playbook ansible/setup.yml -i localhost, --list-tasks
uv run ansible-lint ansible/setup.yml
uv run ruff check .
make ops-check
```

`make ops-check` also runs template, fingerprint, and source-update tests. The Node environment-file
round-trip test uses the pinned runtime from `npm ci` when available.

Use `--check` to resolve the requested remote revision and preview changes on a
prepared host without downloading or replacing source files. History and checkout
checks run during apply after fetching the pinned commit. A fresh host may lack
the checkout, runtime, or dependencies needed for later checks, so check mode
cannot verify the complete first installation.

If an apply fails after services stop, they remain stopped and Ansible reports
the failure. Resolve the cause and rerun; source rollback is a separate operation.

Inspect the installed services on the target:

```sh
sudo systemctl status swarm-888 swarm-888-worker swarm-888-root-worker
sudo journalctl -u swarm-888-root-worker -f
```
