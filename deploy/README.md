# Install the operator on server-212

The local SSH configuration resolves `server-212` to `root@212.132.68.43:22`. Use that alias for installation administration. Use an ordinary SSH account for the day-to-day tunnel when one is available.

## Deploy the pinned VPS release with Ansible

From the repository root, run the single-host playbook with Ansible Core 2.19 and the framework commit `13f3819` available in the local Git checkout. The host needs systemd, x86-64 Linux, Python with `venv`, Git, and Caddy. The playbook archives the pinned commit, builds it with a private Node 24 runtime, and starts the operator on loopback ports. The owner state and private Git catalog live under `/var/lib/swarm-operator`. The worker runs as root in acknowledgment mode and processes the standing-goal queue.

```sh
ansible-playbook -i server-212, deploy/ansible/deploy.yml
```

Open the private tunnel from your workstation and visit [the operator UI](http://127.0.0.1:18080). Sign in with the owner key at `/var/lib/swarm-operator/state/owner.key`. Keep the local port at `18080` to match the configured browser origin.

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:18080:127.0.0.1:18080 server-212
```

The acceptance playbook creates a baseline once, using a command dispatch probe and one permissions fixture in the operator state directory. For persistence acceptance, run the reboot playbook during an authorized maintenance window. It reboots the entire VPS. Rerun deployment after SSH returns and then verify the persisted baseline.

```sh
ansible-playbook -i server-212, deploy/ansible/acceptance.yml
ansible-playbook -i server-212, deploy/ansible/reboot.yml -e '{"operator_reboot_authorized":true}'
ansible-playbook -i server-212, deploy/ansible/deploy.yml
ansible-playbook -i server-212, deploy/ansible/acceptance.yml -e acceptance_phase=after
```

### Server-212 acceptance on 2026-11-22

- Framework revision `13f38198f37d320d397e4bec260400bf51924f6a`. Ansible reported zero changes on the first post-reboot deployment. Chromium completed owner sign-in through the tunnel before and after reboot.
- Effective UIDs before and after reboot were `0` for the worker, `994` for the API, `993` for the web, and `992` for the gateway. All three TCP listeners were bound to IPv4 loopback.
- The executable skill `9ff7cb6195702f672327a2016d14e3d17c0d6e8e` dispatched the approved probe argument once. The executor denied the other argument and the probe recorded zero additional dispatches. The acceptance driver supplied these skills through task-bound MCP.
- Goal `baa05670ddad497e90fececf8d85bae4` repaired the induced change from mode `0600` to `0644` once, at journal event `18`. An independent file stat showed `0600` after reboot. The worker logged a fresh healthy check with zero further repairs.
- Boot ID changed from `28042fb6-a062-4a83-8090-ad33a9d0ff4f` to `6b767fc4-2f24-4173-9244-cc1e00916300`. The post-reboot check recovered the same operator profile `c3b19cd5596f426fa594dbd32968b95f`, memory `06759c45ae7146f6bff7d37049a80ce2` at revision `1`, both active skills including the file mode skill `8d30307c79553c65c1035d77ecc5e1ffbc3f7f84`, and the active standing goal.
- After the reboot, the existing Caddy, Docker, and `grime-steer` services were active and seven Grime containers were up. `grime-works-grime-crew-1` was still restarting with exit code `1` at the last check.

## Prepare a manual installation

Check the host before reserving ports or installing dependencies. Record the OS, architecture, free disk, running Docker context and the existing listeners. These commands only inspect the host.

```sh
ssh server-212 'cat /etc/os-release; uname -m; df -h /opt /var/lib; ss -ltn; docker context show; docker info --format "{{.Name}} {{.ServerVersion}}"'
```

Use the tested framework commit, Python 3.12 or newer with uv, Node.js 24 with Corepack, Git, Make, Caddy 2, and the Codex CLI. The units expect system-wide Node and Caddy and an explicit Codex binary path. Keep the framework at `/opt/swarm-operator`, the private state and catalog under `/var/lib/swarm-operator`, and the editable catalog in a separate Git remote. Use a host-specific catalog branch or repository if this host should learn independently of WSL2.

As the administrator, create two service users. The controller and worker share the operator account for SQLite and IPC. The web account can read the framework build. Grant Docker access only to the worker service when needed. The Docker group grants root-equivalent access to a rootful daemon. [Docker Engine access](https://docs.docker.com/engine/install/linux-postinstall/)

```sh
sudo useradd --system --user-group --home-dir /var/lib/swarm-operator --shell /usr/sbin/nologin swarm-operator
sudo useradd --system --user-group --no-create-home --shell /usr/sbin/nologin swarm-operator-web
sudo install -d -m 0700 -o swarm-operator -g swarm-operator /var/lib/swarm-operator
sudo install -d -m 0755 /opt/swarm-operator
sudo install -d -m 0750 /etc/swarm-operator
```

Put the checked-out release in `/opt/swarm-operator` using your normal Git deployment access. With the release writable by its build account, run `make setup && make check`. Use a Python interpreter in a shared location readable by the service account so the virtual environment does not point into a private build account home. Keep the completed release readable by both app accounts. Use an administrator-owned release checkout when enabling a root worker. The tested Codex CLI version is 0.166.0.

Initialize under the operator account. Supply the catalog remote as an SSH URL or use a credential helper. The service environment file contains paths and ports.

```sh
cd /opt/swarm-operator
sudo -u swarm-operator -H env OPERATOR_STATE_DIR=/var/lib/swarm-operator/state make owner-key
sudo -u swarm-operator -H env \
  OPERATOR_STATE_DIR=/var/lib/swarm-operator/state \
  OPERATOR_CATALOG_REMOTE='<private external Git remote>' \
  OPERATOR_CATALOG_BRANCH=main \
  OPERATOR_CATALOG_CHECKOUT=/var/lib/swarm-operator/catalog \
  make catalog-init
sudo -u swarm-operator -H /usr/local/bin/codex login status
```

Run the ordinary Codex login flow as `swarm-operator` if the account lacks credentials. Keep the service account's SSH deploy credentials, Codex session, and owner key in its private home.

## Enable the units and tunnel

```sh
cd /opt/swarm-operator
sudo install -m 0600 deploy/operator.env.example /etc/swarm-operator/operator.env
sudo install -m 0644 deploy/systemd/* /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now swarm-operator.target
sudo systemctl status swarm-operator-{controller,worker,web,gateway}.service
sudo journalctl -u swarm-operator-worker.service -n 30 --no-pager
```

Use the worker log's effective UID and GID to confirm its execution identity. On a host where the worker should use the rootful Docker socket, add a worker-only drop-in with `SupplementaryGroups=docker`, then restart that unit. For a rootless engine, configure its owner and socket access for the worker and confirm the chosen context as that account.

An explicit root worker can process the fixture-operation and standing-goal queues using this worker drop-in. Initialize the catalog and owner state under the service account before switching identities, then confirm `effective UID=0` in the journal. Use the ordinary worker for Codex authoring.

```ini
[Service]
User=root
Group=root
Environment=OPERATOR_ALLOW_ROOT_WORKER=1 OPERATOR_MODEL=acknowledge
```

Open the tunnel from your workstation. Keep the browser port equal to the configured owner origin so browser writes pass the same-origin check. [OpenSSH local forwarding](https://man.openbsd.org/ssh#-L)

```sh
ssh -NT -o ExitOnForwardFailure=yes -L 127.0.0.1:18080:127.0.0.1:18080 server-212
```

Open [the private origin](http://127.0.0.1:18080) and sign in with the key in `/var/lib/swarm-operator/state/owner.key`. Check the port bindings on the VPS and confirm an unauthenticated snapshot returns 401. Send a message, reload the task, and restart the worker to check persistence before enabling the VPS acceptance reboot.

## Back up and restore

Quiesce the stack so export can lock the controller, worker and catalog. The archive is mode 0600 and contains the owner key, credential vault, SQLite, retained revisions, workspaces, fixture files, and a bundle of the local catalog commits. Keep it in private encrypted storage.

```sh
sudo systemctl stop swarm-operator.target
sudo -u swarm-operator -H env OPERATOR_STATE_DIR=/var/lib/swarm-operator/state \
  make backup OPERATOR_BACKUP=/var/lib/swarm-operator/operator.tar.gz
sudo -u swarm-operator -H env OPERATOR_STATE_DIR=/var/lib/swarm-operator/restored \
  make restore OPERATOR_BACKUP=/var/lib/swarm-operator/operator.tar.gz \
  OPERATOR_RESTORE_CATALOG=/var/lib/swarm-operator/restored-catalog
```

Point the environment file at the restored directory, run `sudo systemctl start swarm-operator.target`, sign in again, and open a known task and revision. Restore expires old browser sessions. To return to the original state, stop the target and restore the original state path in the environment file. Systemd manages the four processes as a unit. [Systemd service environments](https://www.freedesktop.org/software/systemd/man/latest/systemd.exec.html)
