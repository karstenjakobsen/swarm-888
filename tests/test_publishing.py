import json

import pytest
from conftest import AuthorRuntime, NoRuntime
from test_dns import provider_server

from swarm.application import Application
from swarm.dns import DNSProvider, RemoteMCP
from swarm.publishing import Caddy, Site, inspect_config


def configure(tmp_path, monkeypatch, admin=None, https_port=443, upstream_port=9001, ca_file=None):
    doc = {
        "admin_socket": str(admin or tmp_path / "admin.sock"),
        "server": "edge",
        "https_port": https_port,
        "ca_file": str(ca_file) if ca_file else None,
        "services": {
            "orders": {
                "zone": "example.test",
                "label": "orders",
                "address": "127.0.0.1",
                "upstream_port": upstream_port,
                "marker": "orders-v1",
            }
        },
    }
    path = tmp_path / "ingress.json"
    path.write_text(json.dumps(doc))
    monkeypatch.setenv("SWARM_INGRESS_CONFIG", str(path))
    return Site.configured("orders", None)


def publication_app(app, endpoint):
    path = app.catalog.path / "connectors/digitalocean.json"
    app.catalog.define(
        "connectors",
        "digitalocean",
        {"authentication": "bearer", "secret": "digitalocean", "endpoint": endpoint},
    )
    provider = DNSProvider(RemoteMCP(app.state, path, {"digitalocean": endpoint}))
    return Application(app.state, app.catalog, AuthorRuntime(), provider)


class TestEdge(Caddy):
    __test__ = False

    def __init__(self):
        self.routes = []
        self.writes = 0
        self.healthy_backend = True
        self.correct_response = True
        self.lose_reply = False

    def observe(self, site):
        return inspect_config(
            site,
            {"apps": {"http": {"servers": {"edge": {"listen": [":443"], "routes": self.routes}}}}},
            '"config-token"',
        )

    def install(self, site, observation):
        self.writes += 1
        self.routes.insert(0, site.route())
        if self.lose_reply:
            raise OSError("connection dropped after commit")
        return 200

    def backend_ready(self, site):
        return self.healthy_backend

    def verify(self, site):
        return {"verified": self.correct_response, "http_status": 200}


@pytest.mark.parametrize("config", [[], {"services": []}])
def test_malformed_ingress_config_waits_for_owner(app, tmp_path, monkeypatch, run, config):
    path = tmp_path / "ingress.json"
    path.write_text(json.dumps(config))
    monkeypatch.setenv("SWARM_INGRESS_CONFIG", str(path))
    task = app.submit("Publish the orders service at orders.example.test with TLS")
    run(app.step())
    assert app.task_summary(task)["status"] == "waiting"
    questions = [e for e in app.state.events(task=task) if e["kind"] == "question"]
    assert "services object" in questions[-1]["data"]["text"]
    assert not app.state.rows("SELECT id FROM operations")


def test_publish_restart_on_lost_ingress_reply(app, tmp_path, monkeypatch, run, clock):
    site = configure(tmp_path, monkeypatch)
    with provider_server() as (zone, endpoint):
        app = publication_app(app, endpoint)
        edge = TestEdge()
        edge.lose_reply = True
        app.publisher.ingress = edge
        task = app.submit("Publish the orders service at orders.example.test with TLS")
        run(app.step())
        assert app.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] == "credential"
        app.credential(task, "synthetic-access-token")
        for _ in range(5):
            run(app.step())
            clock.advance()
            if edge.writes:
                break
        assert edge.writes == 1
        assert zone.records == [{"type": "A", "name": "orders", "data": "127.0.0.1"}]
        recovered = Application(app.state, app.catalog, NoRuntime(), app.dns.provider)
        recovered.publisher.ingress = edge
        recovered.recover()
        edge.correct_response = False
        run(recovered.step())
        assert app.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] == "observing"
        clock.advance()
        edge.correct_response = True
        run(recovered.step())
        row = app.state.one("SELECT status,checkpoint FROM tasks WHERE id=?", task)
        assert row["status"] == "verified"
        checkpoint = json.loads(row["checkpoint"])
        assert checkpoint["outstanding"] == [] and len(checkpoint["operations"]) == 2
        ops = app.state.rows("SELECT * FROM operations WHERE task=?", task)
        assert all(
            op["rev"] == checkpoint["publish_revision"] and op["status"] == "verified" for op in ops
        )
        assert app.tools(task).connector_result(task)["evidence"]["status"] == "healthy"
        assert {o["target"] for o in app.skill_view("publish-service")["operations"]} == {
            site.hostname,
            "https://" + site.hostname,
        }
        assert edge.routes == [site.route()] and edge.writes == 1
        assert len([v for v in zone.calls if v[0] == "create"]) == 1


@pytest.mark.parametrize("fault", ["ingress", "backend", "dns"])
def test_publication_conflicts_require_direction(app, tmp_path, monkeypatch, run, clock, fault):
    site = configure(tmp_path, monkeypatch)
    with provider_server() as (zone, endpoint):
        app = publication_app(app, endpoint)
        edge = TestEdge()
        app.publisher.ingress = edge
        if fault == "ingress":
            edge.routes = [{"match": [{"host": ["*.example.test"]}], "handle": []}]
        elif fault == "backend":
            edge.healthy_backend = False
        else:
            zone.records = [{"type": "CNAME", "name": "orders", "data": "other.example.test"}]
        app.state.secret("digitalocean", "synthetic-access-token")
        task = app.submit("/publish orders")
        run(app.step())
        assert app.state.one("SELECT status FROM tasks WHERE id=?", task)["status"] == "waiting"
        assert edge.writes == 0 and not [v for v in zone.calls if v[0] == "create"]
        assert site.hostname == "orders.example.test"


@pytest.mark.parametrize(("failure", "expected_writes"), [(412, 2), (503, 1)])
def test_publish_handles_concurrent_edits_and_ambiguous_replies(
    app, tmp_path, monkeypatch, run, clock, failure, expected_writes
):
    configure(tmp_path, monkeypatch)
    with provider_server() as (_, endpoint):
        app = publication_app(app, endpoint)
        edge = TestEdge()

        def install(site, observation):
            edge.writes += 1
            if edge.writes == 1:
                return failure
            edge.routes.append(site.route())
            return 200

        monkeypatch.setattr(edge, "install", install)
        app.publisher.ingress = edge
        app.state.secret("digitalocean", "synthetic-access-token")
        first = app.submit("/publish orders")
        for _ in range(10):
            run(app.step())
            clock.advance(6)
        assert edge.writes == expected_writes
        if failure == 412:
            assert (
                app.state.one("SELECT status FROM tasks WHERE id=?", first)["status"] == "verified"
            )
        else:
            second = app.submit("/publish orders")
            clock.advance(601)
            for _ in range(6):
                run(app.step())
                clock.advance(6)
            assert (
                app.state.one("SELECT status FROM tasks WHERE id=?", first)["status"] == "unknown"
            )
            assert (
                app.state.one("SELECT status FROM tasks WHERE id=?", second)["status"] == "waiting"
            )
            assert edge.writes == 1 and not edge.routes
