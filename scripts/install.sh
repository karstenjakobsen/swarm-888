#!/bin/sh
# User install is local and immediately runnable. --system installs a boot service.
set -eu
umask 022
src=$(CDPATH='' cd -- "$(dirname -- "$0")/.." && pwd)
mode=${1:---user}
case "$mode" in --user|--system) ;; *) echo "Usage: scripts/install.sh [--user|--system]" >&2; exit 2;; esac
if [ "$mode" = --system ]; then
    [ "$(id -u)" = 0 ] || { echo "Run the system installer as root." >&2; exit 1; }
    if ! command -v python3 >/dev/null || ! command -v git >/dev/null || ! python3 -c 'import sqlite3' 2>/dev/null; then
        if command -v apt-get >/dev/null; then
            apt-get update && apt-get install -y python3 libsqlite3-0 git ca-certificates
        else
            echo "Install a bootstrap Python 3 interpreter and Git using your OS package manager." >&2; exit 1
        fi
    fi
    app=/opt/swarm-888; bin=/usr/local/bin; state=/var/lib/swarm-888
else
    app="${XDG_DATA_HOME:-$HOME/.local/share}/swarm-888/app"; bin="${SWARM_BIN_DIR:-$HOME/.local/bin}"
    state="${XDG_STATE_HOME:-$HOME/.local/state}/swarm-888"
fi
command -v python3 >/dev/null || { echo "A bootstrap Python 3 interpreter is required." >&2; exit 1; }
command -v git >/dev/null || { echo "Git is required for catalog imports." >&2; exit 1; }
mkdir -p "$app" "$bin"
uv_bin=$(command -v uv || true)
if [ -z "$uv_bin" ]; then
    uv_bin="$app/uv"
    if [ ! -x "$uv_bin" ]; then
        python3 "$src/scripts/install_tool.py" uv "$uv_bin" --version 0.12.5
    fi
fi
if [ "$mode" = --system ]; then
    # Keep the service interpreter outside root's home directory.
    export UV_PYTHON_INSTALL_DIR="$app/python"
    "$uv_bin" python install --no-bin 3.14
    runtime=$("$uv_bin" python find --managed-python 3.14)
else
    runtime=3.14
fi
"$uv_bin" venv --allow-existing --no-project --python "$runtime" "$app/venv"
python="$app/venv/bin/python"
"$python" -c 'import sqlite3,sys; assert sys.version_info[:2] == (3,14)'
codex=${SWARM_CODEX:-}
if [ -z "$codex" ] && [ -x "$app/codex" ]; then codex="$app/codex"; fi
if [ -z "$codex" ]; then
    if [ "$mode" = --user ]; then codex=$(command -v codex || true)
    else
        for candidate in /usr/local/bin/codex /usr/bin/codex; do
            if [ -x "$candidate" ]; then codex=$candidate; break; fi
        done
    fi
fi
if [ -z "$codex" ]; then
    codex="$app/codex"
    "$python" "$src/scripts/install_tool.py" codex "$codex" --version "${SWARM_CODEX_VERSION:-0.166.0}"
fi
[ -x "$codex" ] || { echo "SWARM_CODEX must name an executable." >&2; exit 1; }
stage=$(mktemp -d "$app/.install.XXXXXX")
trap 'rm -rf "$stage"' EXIT
"$python" "$src/scripts/build.py" --output "$stage/operator.pyz"
chmod 755 "$stage/operator.pyz"
# Use Python quoting for install paths, including paths containing spaces or quotes.
python3 - "$app" "$codex" "$state" "$stage/launcher" <<'PY'
import pathlib,shlex,sys
app,codex,state,launcher=sys.argv[1:]
q=shlex.quote
pathlib.Path(launcher).write_text("#!/bin/sh\n"+ "export SWARM_DATA="+q(state)+"\n"+
    "export SWARM_CODEX="+q(codex)+"\n"+"export PATH="+q(app+"/venv/bin")+':"$PATH"\n'+'exec '+q(app+"/venv/bin/python")+' '+q(app+"/operator.pyz")+' "$@"\n')
PY
chmod 755 "$stage/launcher"
mv "$stage/operator.pyz" "$app/operator.pyz"
mv "$stage/launcher" "$app/launcher"
ln -sfn "$app/launcher" "$bin/swarm-operator"
if [ "$mode" = --user ]; then
    echo "Installed. Start with $bin/swarm-operator"
    exit 0
fi
command -v systemctl >/dev/null || { echo "System install requires systemd." >&2; exit 1; }
if ! id swarm-operator >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$state" --shell /usr/sbin/nologin swarm-operator
fi
install -d -m 0700 -o swarm-operator -g swarm-operator "$state"
python3 -I "$src/scripts/host-worker/provision.py" --user swarm-operator
install -m 0644 "$src/scripts/swarm-operator.service" /etc/systemd/system/swarm-operator.service
systemctl daemon-reload
systemctl enable swarm-operator.service
systemctl restart swarm-operator.service
echo "Operator and host worker installed. Private dashboard link: $state/access.url"
