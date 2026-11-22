"""Opt-in ACME integration. All listeners and certificate authorities are local."""

import asyncio
import contextlib
import hashlib
import json
import os
import shutil
import socket
import ssl
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

import httpx
import pytest
from test_dns import provider_server
from test_live import worker_rpc
from test_publishing import configure, publication_app

from swarm.runtime import CodexRuntime

pytestmark = pytest.mark.live


def unused_ports(count):
    with contextlib.ExitStack() as stack:
        ports = []
        for _ in range(count):
            sock = stack.enter_context(socket.socket())
            sock.bind(("127.0.0.1", 0))
            ports.append(sock.getsockname()[1])
        return ports


def independent_request(host, port, roots):
    ctx = ssl.create_default_context(cafile=str(roots))
    with (
        socket.create_connection(("127.0.0.1", port), timeout=3) as tcp,
        ctx.wrap_socket(tcp, server_hostname=host) as tls,
    ):
        certificate = tls.getpeercert(binary_form=True)
        assert certificate is not None
        fingerprint = hashlib.sha256(certificate).hexdigest()
        tls.sendall(f"GET / HTTP/1.0\r\nHost: {host}\r\nConnection: close\r\n\r\n".encode())
        with tls.makefile("rb") as response:
            body = response.read(8192)
        assert b"200 OK" in body.partition(b"\r\n")[0]
        assert body.partition(b"\r\n\r\n")[2] == b"orders-v1"
        return fingerprint


@pytest.mark.parametrize("real_model", [False, True], ids=["fixture-model", "codex"])
def test_real_caddy_pebble_publish_and_renew(app, tmp_path, monkeypatch, clock, real_model):
    if real_model and not Path(os.getenv("SWARM_CODEX_AUTH", "")).is_file():
        pytest.skip("Set SWARM_CODEX_AUTH to a Codex file-backed ChatGPT login")
    binaries = {
        binary: shutil.which(binary) for binary in ("caddy", "pebble", "pebble-challtestsrv")
    }
    if not all(binaries.values()):
        pytest.skip("Put caddy, pebble and pebble-challtestsrv on PATH")
    acme, management, resolver, challenge_admin, https_port, http_port = unused_ports(6)
    tls_cert = tmp_path / "directory.pem"
    key = tmp_path / "directory.key"
    subprocess.run(
        [
            "openssl",
            "req",
            "-x509",
            "-newkey",
            "rsa:2048",
            "-nodes",
            "-days",
            "1",
            "-subj",
            "/CN=localhost",
            "-addext",
            "subjectAltName=IP:127.0.0.1,DNS:localhost",
            "-keyout",
            key,
            "-out",
            tls_cert,
        ],
        check=True,
        capture_output=True,
    )
    directory_config = tmp_path / "pebble.json"
    directory_config.write_text(
        json.dumps(
            {
                "pebble": {
                    "listenAddress": f"127.0.0.1:{acme}",
                    "managementListenAddress": f"127.0.0.1:{management}",
                    "certificate": str(tls_cert),
                    "privateKey": str(key),
                    "httpPort": http_port,
                    "tlsPort": https_port,
                }
            }
        )
    )

    class Orders(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.end_headers()
            self.wfile.write(b"orders-v1")

        def log_message(self, format, *args):
            pass

    env = {
        **os.environ,
        "PEBBLE_VA_NOSLEEP": "1",
        "PEBBLE_WFE_NONCEREJECT": "0",
        "XDG_DATA_HOME": str(tmp_path / "data"),
        "XDG_CONFIG_HOME": str(tmp_path / "config"),
        "XDG_CACHE_HOME": str(tmp_path / "cache"),
    }
    env.pop("PEBBLE_VA_ALWAYS_VALID", None)

    def start(stack, name, *args):
        log = stack.enter_context((tmp_path / (name + ".log")).open("w"))
        binary = binaries[name]
        assert binary is not None
        process = subprocess.Popen(
            [binary, *args], cwd=tmp_path, env=env, stdout=log, stderr=subprocess.STDOUT
        )

        def finish():
            process.terminate()
            try:
                process.wait(5)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait()

        stack.callback(finish)
        return process

    with contextlib.ExitStack() as stack:
        upstream = stack.enter_context(HTTPServer(("127.0.0.1", 0), Orders))
        thread = threading.Thread(target=upstream.serve_forever, daemon=True)
        thread.start()
        stack.callback(upstream.shutdown)
        start(
            stack,
            "pebble-challtestsrv",
            "-dns01",
            f"127.0.0.1:{resolver}",
            "-defaultIPv6",
            "",
            "-http01",
            "",
            "-https01",
            "",
            "-tlsalpn01",
            "",
            "-management",
            f"127.0.0.1:{challenge_admin}",
        )
        ca = start(
            stack, "pebble", "-config", str(directory_config), "-dnsserver", f"127.0.0.1:{resolver}"
        )
        root = tmp_path / "issued-root.pem"
        deadline = time.monotonic() + 10
        with httpx.Client(
            trust_env=False, verify=ssl.create_default_context(cafile=str(tls_cert)), timeout=1
        ) as client:
            while True:
                try:
                    response = client.get(f"https://127.0.0.1:{management}/roots/0")
                    response.raise_for_status()
                    root.write_bytes(response.content)
                    break
                except httpx.HTTPError:
                    assert ca.poll() is None and time.monotonic() < deadline
                    time.sleep(0.1)
        admin = tmp_path / "caddy.sock"
        site = configure(tmp_path, monkeypatch, admin, https_port, upstream.server_port, root)
        settings = {
            "admin": {
                "listen": "unix/" + str(admin),
                "origins": ["http://localhost"],
                "enforce_origin": True,
            },
            "apps": {
                "http": {
                    "http_port": http_port,
                    "https_port": https_port,
                    "servers": {
                        "edge": {
                            "listen": [f"127.0.0.1:{https_port}"],
                            "tls_connection_policies": [{}],
                            "automatic_https": {"disable_redirects": True},
                            "routes": [
                                {"handle": [{"handler": "static_response", "status_code": 404}]}
                            ],
                        }
                    },
                },
                "tls": {
                    "automation": {
                        "renew_interval": "2s",
                        "policies": [
                            {
                                "subjects": [site.hostname],
                                "renewal_window_ratio": 0.999999999,
                                "issuers": [
                                    {
                                        "module": "acme",
                                        "ca": f"https://127.0.0.1:{acme}/dir",
                                        "trusted_roots_pem_files": [str(tls_cert)],
                                        "challenges": {"http": {"disabled": True}},
                                    }
                                ],
                            }
                        ],
                    }
                },
            },
        }
        caddy_config = tmp_path / "caddy.json"
        caddy_config.write_text(json.dumps(settings))
        caddy = start(stack, "caddy", "run", "--config", str(caddy_config))
        deadline = time.monotonic() + 10
        while not admin.exists():
            assert caddy.poll() is None and time.monotonic() < deadline, (
                tmp_path / "caddy.log"
            ).read_text()[-3000:]
            time.sleep(0.1)
        # The independent clients use the same local address as Pebble's fixture DNS.
        getaddrinfo = socket.getaddrinfo
        monkeypatch.setattr(
            socket,
            "getaddrinfo",
            lambda host, *args, **kwargs: getaddrinfo(
                "127.0.0.1" if host == site.hostname else host, *args, **kwargs
            ),
        )
        zone, endpoint = stack.enter_context(provider_server())
        app = publication_app(app, endpoint)
        app.state.secret("digitalocean", "synthetic-access-token")
        if real_model:
            app.runtime = CodexRuntime()
            stack.enter_context(worker_rpc(app))
        task = app.submit(f"Publish orders at {site.hostname} with TLS")
        deadline = time.monotonic() + (180 if real_model else 50)
        while time.monotonic() < deadline:
            asyncio.run(app.step())
            observed = app.state.one("SELECT status FROM tasks WHERE id=?", task)["status"]
            if observed != "observing":
                break
            clock.advance(5)
            time.sleep(0.4)
        assert observed == "verified", (
            app.state.events()[-8:],
            (tmp_path / "caddy.log").read_text()[-3000:],
        )
        assert zone.records == [{"name": "orders", "type": "A", "data": "127.0.0.1"}]
        original = independent_request(site.hostname, https_port, root)
        count = app.state.one("SELECT count(*) AS n FROM events")["n"]
        # No further operator scheduler ticks or model calls. Only Caddy and the CA renew.
        deadline = time.monotonic() + 35
        while time.monotonic() < deadline:
            time.sleep(0.5)
            renewed = independent_request(site.hostname, https_port, root)
            if renewed != original:
                break
        assert renewed != original, (tmp_path / "caddy.log").read_text()[-4000:]
        assert app.state.one("SELECT count(*) AS n FROM events")["n"] == count
        if real_model:
            calls = [
                json.loads(e["data"])["tool"]
                for e in app.state.rows(
                    "SELECT data FROM events WHERE task=? AND kind='tool.completed' ORDER BY id",
                    task,
                )
            ]
            assert {"skill_stage", "skill_test", "skill_activate"} <= set(calls)
            print(
                "task",
                task,
                "publishing revision",
                app.catalog.active("publish-service"),
                "tools",
                calls,
            )
        print(
            f"ACME leaf SHA-256 changed from {original} to {renewed}; HTTPS returned orders-v1 on both connections."
        )
