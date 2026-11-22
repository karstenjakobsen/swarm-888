"""Publish a declared application through its existing Caddy HTTPS listener."""

from __future__ import annotations

import asyncio
import fnmatch
import json
import os
import subprocess
import tempfile
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Literal

import httpx
from pydantic import Field, field_validator

from .catalog import Catalog, Contract
from .dns import DNSReconciler, Intent
from .ingress import verify_ingress
from .state import NAME, State, digest, encode, name


class Service(Contract):
    zone: str
    label: str
    address: str
    upstream_port: int = Field(ge=1, le=65535)
    marker: str = Field(min_length=1, max_length=1024)

    @field_validator("marker")
    @classmethod
    def service_marker(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("Supply a service-specific response marker")
        return value

    def dns(self) -> Intent:
        return Intent(self.zone, self.label, self.address)


class Site(Contract):
    admin_socket: Path
    server: str = Field(pattern=f"^{NAME}$")
    https_port: int = Field(default=443, ge=1, le=65535)
    ca_file: Path | None = None
    service: Service

    @field_validator("admin_socket", "ca_file")
    @classmethod
    def absolute_path(cls, value: Path | None) -> Path | None:
        if value is not None and not value.is_absolute():
            raise ValueError("Use absolute paths for the local socket and CA")
        return value

    @classmethod
    def configured(cls, key: str, hostname: str | None) -> Site:
        path = os.getenv("SWARM_INGRESS_CONFIG")
        if not path:
            raise ValueError("Set SWARM_INGRESS_CONFIG to the owner's ingress configuration")
        doc = json.loads(Path(path).read_text())
        services = doc.pop("services")
        if key not in services:
            raise ValueError("Service has no configured ingress binding")
        site = cls.model_validate({**doc, "service": services[name(key)]})
        if hostname and site.service.dns().hostname != hostname:
            raise ValueError("Requested hostname differs from the owner's service binding")
        return site

    @property
    def hostname(self) -> str:
        return self.service.dns().hostname

    def route(self) -> dict:
        return {
            "@id": "swarm-" + digest(self.hostname)[:24],
            "match": [{"host": [self.hostname]}],
            "handle": [
                {
                    "handler": "reverse_proxy",
                    "upstreams": [{"dial": f"127.0.0.1:{self.service.upstream_port}"}],
                }
            ],
            "terminal": True,
        }


@dataclass(frozen=True)
class IngressObservation:
    status: Literal["configured", "absent", "conflict", "unknown"]
    evidence: str
    etag: str = ""
    method: str = ""
    suffix: str = ""


def covers(pattern: str, hostname: str) -> bool:
    return fnmatch.fnmatchcase(hostname, pattern.rstrip(".").lower())


def inspect_config(site: Site, config: dict, etag: str) -> IngressObservation:
    """Only add a host to a listener whose current routing and TLS policy are understood."""
    app = config["apps"]["http"]
    servers = app["servers"]
    server = servers[site.server]
    port = site.https_port
    if int(app.get("http_port", 80)) == port or any(
        key != site.server and any(addr.rpartition(":")[2] == str(port) for addr in item["listen"])
        for key, item in servers.items()
    ):
        return IngressObservation(
            "conflict", "Review the declared HTTPS port and overlapping listeners"
        )
    if not any(addr.rpartition(":")[2] == str(port) for addr in server["listen"]):
        return IngressObservation(
            "conflict", "Selected server does not listen on the declared HTTPS port"
        )
    auto = server.get("automatic_https", {})
    skips = auto.get("skip", []) + auto.get("skip_certificates", [])
    if (
        auto.get("disable")
        or auto.get("disable_certificates")
        or any(covers(s, site.hostname) for s in skips)
    ):
        return IngressObservation(
            "conflict", "Automatic certificate management is disabled for this host"
        )
    if config.get("admin", {}).get("config", {}).get("persist") is False:
        return IngressObservation("conflict", "Caddy configuration persistence is disabled")
    tls = config["apps"].get("tls", {})
    if set(tls.get("certificates", {})) - {"automate"}:
        return IngressObservation(
            "conflict", "Inspect loaded certificates before adding an automated host"
        )
    for policy in tls.get("automation", {}).get("policies", []):
        if policy.get("subjects") and not any(covers(s, site.hostname) for s in policy["subjects"]):
            continue
        if (
            policy.get("on_demand")
            or policy.get("get_certificate")
            or any(i["module"] != "acme" for i in policy.get("issuers", []))
        ):
            return IngressObservation(
                "conflict", "The existing issuer policy needs owner direction"
            )
        break
    wanted = site.route()
    routes = server.get("routes", [])
    matched = False
    for route in routes:
        if route == wanted:
            if matched:
                return IngressObservation("conflict", "Duplicate routes for this host")
            matched = True
            continue
        if route.get("@id") == wanted["@id"]:
            return IngressObservation(
                "conflict", "Existing route with this ID has different settings"
            )
        # A plain 404 fallback may remain behind the new exact-host route.
        handlers = route.get("handle", [])
        if (
            not route.get("match")
            and len(handlers) == 1
            and handlers[0].get("handler") == "static_response"
            and str(handlers[0].get("status_code")) == "404"
        ):
            continue
        for match in route.get("match") or [{}]:
            hosts = match.get("host")
            if not hosts or any("{" in h or covers(h, site.hostname) for h in hosts):
                return IngressObservation(
                    "conflict", "An existing ingress rule may already serve this host"
                )
    if matched:
        return IngressObservation(
            "configured", "Exact host and upstream present with automatic HTTPS", etag
        )
    if not etag:
        return IngressObservation("unknown", "Caddy supplied no concurrency token")
    if routes:
        return IngressObservation("absent", "No route for this host", etag, "PUT", "/routes/0")
    if "routes" in server:
        return IngressObservation("absent", "Empty route list", etag, "POST", "/routes")
    return IngressObservation("absent", "No existing routes", etag, "PUT", "/routes")


class Caddy:
    def request(
        self, site: Site, method: str, path: str, etag: str = "", body: dict | list | None = None
    ) -> tuple[int, str, bytes]:
        # curl preserves Caddy's chunked ETag trailer as well as ordinary ETag headers.
        with tempfile.NamedTemporaryFile() as headers:
            cmd = [
                "curl",
                "--disable",
                "--silent",
                "--show-error",
                "--noproxy",
                "*",
                "--header",
                "Origin: http://localhost",
                "--max-time",
                "8",
                "--max-filesize",
                "4194304",
                "--unix-socket",
                str(site.admin_socket),
                "-D",
                headers.name,
                "--request",
                method,
                "--write-out",
                "\n%{response_code}",
                "http://localhost" + path,
            ]
            if body is not None:
                cmd.extend(
                    [
                        "--header",
                        "Content-Type: application/json",
                        "--header",
                        "If-Match: " + etag,
                        "--data-binary",
                        "@-",
                    ]
                )
            response = subprocess.run(
                cmd,
                input=encode(body).encode() if body is not None else b"",
                capture_output=True,
                timeout=10,
            )
            if response.returncode:
                raise OSError("Local Caddy admin request did not complete")
            data, code = response.stdout.rsplit(b"\n", 1)
            tag = next(
                (
                    line.partition(b":")[2].strip().decode("ascii")
                    for line in headers
                    if line.lower().startswith(b"etag:")
                ),
                "",
            )
            return int(code), tag, data

    def observe(self, site: Site) -> IngressObservation:
        try:
            status, etag, data = self.request(site, "GET", "/config/")
            if status == 200:
                return inspect_config(site, json.loads(data), etag)
        except (
            OSError,
            subprocess.SubprocessError,
            KeyError,
            TypeError,
            ValueError,
            AttributeError,
        ):
            pass
        return IngressObservation(
            "unknown", "Cannot establish the current Caddy listener and routing policy"
        )

    def install(self, site: Site, observation: IngressObservation) -> int:
        if observation.status != "absent" or not observation.etag:
            raise ValueError("A fresh absent-route observation is required")
        first = observation.method == "PUT" and observation.suffix == "/routes"
        path = f"/config/apps/http/servers/{site.server}" + observation.suffix
        status, _, _ = self.request(
            site,
            observation.method,
            path,
            observation.etag,
            [site.route()] if first else site.route(),
        )
        return status

    def backend_ready(self, site: Site) -> bool:
        with httpx.Client(trust_env=False, follow_redirects=False, timeout=5) as client:
            with client.stream(
                "GET",
                f"http://127.0.0.1:{site.service.upstream_port}/",
                headers={"Host": site.hostname},
            ) as response:
                if response.status_code != 200:
                    return False
                data = bytearray()
                for piece in response.iter_bytes(16384):
                    data.extend(piece)
                    if len(data) >= 1048576:
                        break
                return site.service.marker.encode() in data

    def verify(self, site: Site) -> dict:
        return verify_ingress(
            site.hostname,
            site.service.marker,
            port=site.https_port,
            ca_file=str(site.ca_file) if site.ca_file else None,
        )


class Publisher:
    def __init__(
        self, state: State, catalog: Catalog, dns: DNSReconciler, ingress: Caddy | None = None
    ):
        self.state, self.catalog, self.dns = state, catalog, dns
        self.ingress = ingress or Caddy()

    def record(self, task: str, op: str, status: str, evidence: dict) -> None:
        with self.state.tx() as conn:
            conn.execute(
                "UPDATE operations SET status=?,evidence=? WHERE id=?",
                (status, encode(evidence), op),
            )
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
            )
            checkpoint["last_verified"] = evidence
            checkpoint["next"] = "Read the live route and verify HTTPS before repeating any change"
            if status == "verified":
                checkpoint["outstanding"] = [k for k in checkpoint["outstanding"] if k != op]
            conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
            self.state.event(task, "ingress." + status, {"operation": op, **evidence}, conn)

    async def step(self, task: str, site: Site, revision: str) -> str:
        s = self.state
        op = digest([task, "publish", site.hostname])
        params = site.model_dump(mode="json")
        with s.tx() as conn:
            conn.execute(
                """INSERT OR IGNORE INTO operations(id,task,authority,target,intent,rev,status,evidence,deadline)
                            VALUES (?,?,?,?,?,?,'prepared','{}',?)""",
                (
                    op,
                    task,
                    task,
                    "https://" + site.hostname,
                    encode(params),
                    revision,
                    s.clock() + 600,
                ),
            )
            checkpoint = json.loads(
                conn.execute("SELECT checkpoint FROM tasks WHERE id=?", (task,)).fetchone()[0]
            )
            checkpoint["publish_revision"] = revision
            checkpoint["criteria"] = (
                f"Trusted HTTPS for {site.hostname} returns the declared service marker"
            )
            if op not in checkpoint["operations"]:
                checkpoint.setdefault("outstanding", []).append(op)
            for key, value in (("operations", op), ("revisions", revision)):
                if value not in checkpoint.setdefault(key, []):
                    checkpoint[key].append(value)
            conn.execute("UPDATE tasks SET checkpoint=? WHERE id=?", (encode(checkpoint), task))
        row = s.one("SELECT * FROM operations WHERE id=?", op)
        if row["intent"] != encode(params) or row["rev"] != revision:
            s.event(
                task,
                "question",
                {"text": "The ingress binding changed. Review it and submit a new publication."},
            )
            return "waiting"
        if row["status"] == "verified":
            return "verified"
        if row["attempts"] >= 60 or s.clock() >= row["deadline"]:
            s.alert(op, "Publication needs attention for " + site.hostname + ". " + row["evidence"])
            return "unknown"
        observed = await asyncio.to_thread(self.ingress.observe, site)
        evidence = {
            "target": site.hostname,
            "status": observed.status,
            "observation": observed.evidence,
            "at": s.clock(),
        }
        s.change(
            "UPDATE operations SET attempts=attempts+1,evidence=? WHERE id=?", encode(evidence), op
        )
        s.event(task, "ingress.observation", evidence)
        if observed.status == "conflict":
            s.event(task, "question", {"text": observed.evidence})
            return "waiting"
        if observed.status == "unknown":
            return "observing"
        dns_id = digest([task, "dns", asdict(site.service.dns())])
        dns = s.rows("SELECT status FROM operations WHERE id=?", dns_id)
        dns_status = dns[0]["status"] if dns else "unobserved"
        decision = self.catalog.evaluate(
            revision, {"ingress": observed.status, "dns": dns_status, "hostname": site.hostname}
        )
        action = decision.get("action")
        reconcile = dns_status != "verified" and action == "reconcile_dns"
        configure = (
            dns_status == "verified" and observed.status == "absent" and action == "configure_https"
        )
        if configure and row["status"] == "dispatched":
            return "observing"
        if reconcile or configure:
            try:
                ready = await asyncio.to_thread(self.ingress.backend_ready, site)
            except (OSError, httpx.HTTPError):
                ready = False
            if not ready:
                s.event(
                    task,
                    "question",
                    {
                        "text": "Local upstream did not return the declared service marker. Correct the binding or service, then recheck."
                    },
                )
                return "waiting"
        if reconcile:
            status = await self.dns.step(task, site.service.dns(), revision=revision)
            if status == "unknown":
                return "unknown"
            return "waiting" if status == "conflict" else "observing"
        if configure:
            earlier = s.rows(
                "SELECT id FROM operations WHERE target=? AND status='dispatched' AND id<>? LIMIT 1",
                "https://" + site.hostname,
                op,
            )
            if earlier:
                s.event(
                    task,
                    "question",
                    {
                        "text": "An earlier route update still has an unknown outcome. Recheck its publication first.",
                        "operation": earlier[0]["id"],
                    },
                )
                return "waiting"
            checked = await self.dns.provider.observe(site.service.dns())
            s.event(task, "dns.prepublish", asdict(checked))
            if checked.status != "healthy":
                if checked.status == "unknown":
                    return "observing"
                s.event(
                    task,
                    "question",
                    {"text": "DNS changed since verification. Review the record, then recheck."},
                )
                return "waiting"
            # ETag covers the whole inspected configuration. A concurrent edit invalidates the write.
            with s.tx() as conn:
                active = conn.execute("SELECT status FROM tasks WHERE id=?", (task,)).fetchone()
                if active["status"] != "running":
                    return "interrupted"
                conn.execute("UPDATE operations SET status='dispatched' WHERE id=?", (op,))
                s.event(
                    task,
                    "ingress.dispatch",
                    {
                        "operation": op,
                        "revision": revision,
                        "target": site.hostname,
                        "route_id": site.route()["@id"],
                        "authorized_by": task,
                        "etag": observed.etag,
                        "previous": "host route absent",
                    },
                    conn,
                )
            try:
                status = await asyncio.to_thread(self.ingress.install, site, observed)
            except (OSError, subprocess.SubprocessError):
                return "observing"
            if status == 412:
                self.record(
                    task,
                    op,
                    "prepared",
                    {"observation": "Concurrent configuration change. Inspect again."},
                )
            elif 400 <= status < 500:
                self.record(task, op, "rejected", {"http_status": status})
                return "waiting"
            return "observing"
        if (
            dns_status == "verified"
            and observed.status == "configured"
            and action == "verify_service"
        ):
            try:
                result = await asyncio.to_thread(self.ingress.verify, site)
            except (OSError, httpx.HTTPError):
                s.event(
                    task,
                    "ingress.probe",
                    {"target": site.hostname, "verified": False, "reason": "HTTPS not ready"},
                )
                return "observing"
            s.event(task, "ingress.probe", result)
            if result["verified"]:
                self.record(task, op, "verified", result)
                return "verified"
            return "observing"
        s.event(
            task,
            "question",
            {
                "text": "Publishing skill proposed an action inconsistent with current observations",
                "proposal": decision,
            },
        )
        return "waiting"
