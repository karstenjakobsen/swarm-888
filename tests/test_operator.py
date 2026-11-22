import asyncio
import concurrent.futures
import json
import subprocess
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.request import Request, urlopen

from swarm import catalog
from swarm.engine import Engine
from swarm.http import Dashboard
from swarm.store import Conflict, Store

FIXTURE = str(Path(__file__).with_name("fake_codex.py").resolve())


class StoreTest(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.store = Store(tmp.name)

    def test_concurrent_claims_and_idempotency(self):
        project = self.store.create_project("second")["id"]
        j = self.store.enqueue("inbox", "hello", key="request-1")
        self.assertEqual(j["id"], self.store.enqueue("inbox", "hello", key="request-1")["id"])
        with self.assertRaises(Conflict):
            self.store.enqueue("inbox", "different", key="request-1")
        self.store.enqueue("inbox", "follow up")
        self.store.enqueue(project, "parallel")
        with concurrent.futures.ThreadPoolExecutor(max_workers=10) as pool:
            claims = list(filter(None, pool.map(self.store.claim, map(str, range(10)))))
        self.assertEqual({x["project"] for x in claims}, {"inbox", project})
        self.assertEqual(len(claims), 2)
        self.store.recover()
        self.assertEqual(self.store.job(j["id"])["state"], "queued")

    def test_real_git_import_and_publish(self):
        remote = Path(self.store.root) / "local-git"
        subprocess.run(["git", "init", "-q", str(remote)], check=True)
        (remote / "projects/example").mkdir(parents=True)
        (remote / "projects/example/source.txt").write_text("previous")
        (remote / "README.md").write_text("upstream content")
        subprocess.run(["git", "-C", remote, "add", "."], check=True)
        subprocess.run(
            [
                "git",
                "-C",
                remote,
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@local",
                "commit",
                "-qm",
                "catalog",
            ],
            check=True,
        )
        project = self.store.create_project("catalog", "https://example.test/catalog")
        job = self.store.claim("worker-01")
        spawn = asyncio.create_subprocess_exec

        async def fixture_transport(*args, **kwargs):
            kwargs["env"].update(
                GIT_ALLOW_PROTOCOL="file",
                GIT_CONFIG_COUNT="1",
                GIT_CONFIG_KEY_0=f"url.{remote.as_uri()}.insteadOf",
                GIT_CONFIG_VALUE_0=project["repo"],
            )
            return await spawn(*args, **kwargs)

        with patch("swarm.catalog.asyncio.create_subprocess_exec", fixture_transport):
            asyncio.run(catalog.operate(self.store, job))
            self.store.finish(job, "completed", "imported")
            tree = self.store.workspace(project["id"])
            self.assertEqual((tree / "projects/example/source.txt").read_text(), "previous")
            (tree / "projects/example/source.txt").write_text("improved")
            asyncio.run(catalog.operate(self.store, {"project": project["id"], "kind": "publish"}))
        ref = "swarm/" + project["id"]

        def show(path):
            return subprocess.check_output(
                ["git", "-C", remote, "show", ref + ":" + path], text=True
            )

        self.assertEqual(show("README.md"), "upstream content")
        self.assertEqual(show("projects/example/source.txt"), "improved")
        with patch("swarm.catalog.asyncio.create_subprocess_exec", fixture_transport):
            imported = self.store.create_project("Peer copy", project["repo"], repo_ref=ref)
            asyncio.run(catalog.operate(self.store, {"project": imported["id"], "kind": "import"}))
            self.assertEqual(
                (self.store.workspace(imported["id"]) / "projects/example/source.txt").read_text(),
                "improved",
            )
            remote = self.store.root / "empty.git"
            subprocess.run(["git", "init", "-q", "--bare", remote], check=True)
            fresh = self.store.create_project("Fresh catalog", project["repo"])
            asyncio.run(catalog.operate(self.store, {"project": fresh["id"], "kind": "import"}))
            asyncio.run(catalog.operate(self.store, {"project": fresh["id"], "kind": "publish"}))
            published = subprocess.check_output(
                ["git", "--git-dir", remote, "rev-parse", "refs/heads/swarm/" + fresh["id"]],
                text=True,
            ).strip()
            self.assertEqual(self.store.project(fresh["id"])["revision"], published)

    def test_recovery_conversation(self):
        def start():
            engine = Engine(self.store, 2, FIXTURE)
            engine.start()
            return engine

        def until(check):
            for _ in range(100):
                if check():
                    return
                time.sleep(0.05)
            self.fail("timed out waiting for worker")

        job = self.store.enqueue("inbox", "Wait for restart")
        engine = start()
        try:
            until(lambda: self.store.job(job["id"])["turn"])
        finally:
            engine.stop()
        engine = start()
        try:
            until(lambda: self.store.job(job["id"])["state"] == "completed")
            job = self.store.job(job["id"])
            self.assertEqual(job["attempts"], 2)
            self.assertIn("earlier attempt", job["result"])
            follow = self.store.enqueue("inbox", "continue")
            until(lambda: self.store.job(follow["id"])["state"] == "completed")
            self.assertEqual(self.store.project("inbox")["thread"], "fixture-thread")
            blocked = self.store.enqueue("inbox", "missing credential")
            until(lambda: self.store.job(blocked["id"])["state"] == "blocked")
            workspace = self.store.create_project("Second workspace")
            recall = self.store.enqueue(workspace["id"], "recall previous decision")
            until(lambda: self.store.job(recall["id"])["state"] == "completed")
            self.assertEqual(self.store.query("SELECT job FROM memory"), [{"job": blocked["id"]}])
            self.store.update("UPDATE projects SET thread='expired-thread' WHERE id='inbox'", ())
            restored = self.store.enqueue("inbox", "continue from SQLite")
            until(lambda: self.store.job(restored["id"])["state"] == "completed")
            self.assertEqual(self.store.project("inbox")["thread"], "fixture-thread")
        finally:
            engine.stop()


class HTTPTest(unittest.TestCase):
    def instance(self, name):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        store = Store(tmp.name)
        engine = Engine(store, 2, FIXTURE)
        server = Dashboard(("127.0.0.1", 0), store, engine, "unit-key", name)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        engine.start()
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        self.addCleanup(engine.stop)
        return "http://127.0.0.1:" + str(server.server_port), store

    def test_auth_and_mesh(self):
        url, source = self.instance("Local")
        destination, remote = self.instance("Peer")

        def request(base, path, data=None, headers=None):
            h = {"Content-Type": "application/json", **(headers or {})}
            req = Request(
                base + path, data=None if data is None else json.dumps(data).encode(), headers=h
            )
            with urlopen(req, timeout=8) as res:
                return json.load(res), res.headers

        with self.assertRaises(HTTPError) as no_key:
            request(url, "/api/state")
        self.assertEqual(no_key.exception.code, 401)
        no_key.exception.close()
        _, headers = request(url, "/api/session", {"token": "unit-key"})
        owner = {"Cookie": headers.get("Set-Cookie").split(";")[0]}
        with self.assertRaises(HTTPError) as cross:
            request(
                url,
                "/api/projects",
                {"name": "forbidden"},
                {**owner, "Origin": "https://unknown.test"},
            )
        self.assertEqual(cross.exception.code, 403)
        cross.exception.close()
        key = remote.invite("Source operator")
        peer, _ = request(
            url, "/api/peers", {"name": "peer", "url": destination, "token": key}, owner
        )
        job, _ = request(
            url,
            "/api/runs",
            {"project": "inbox", "target": peer["id"], "prompt": "delegated"},
            owner,
        )
        for _ in range(100):
            current = source.job(job["id"])
            if current["state"] == "completed":
                break
            time.sleep(0.1)
        self.assertEqual(current["result"], "Fixture result: delegated")
        state, _ = request(url, "/api/state", headers=owner)
        self.assertNotIn(key, json.dumps(state))
        with self.assertRaises(HTTPError) as no_brain:
            request(url, "/api/brain", headers={"Authorization": "Bearer " + key})
        self.assertEqual(no_brain.exception.code, 401)
        no_brain.exception.close()
        records, _ = request(url, "/api/brain?table=peers", headers=owner)
        self.assertNotIn(key, json.dumps(records))
        self.assertEqual(records["rows"][0]["id"], peer["id"])
        records, _ = request(url, "/api/brain?table=jobs", headers=owner)
        self.assertEqual(records["rows"][0]["result"], current["result"])
        scoped = {"Authorization": "Bearer " + key}
        duplicate, _ = request(
            destination, "/mesh/v1/runs", {"prompt": "delegated", "request_id": job["id"]}, scoped
        )
        self.assertEqual(len(remote.query("SELECT id FROM jobs")), 1)
        other = remote.invite("Another peer")
        with self.assertRaises(HTTPError) as denied:
            request(
                destination,
                "/mesh/v1/runs/" + duplicate["id"],
                headers={"Authorization": "Bearer " + other},
            )
        self.assertEqual(denied.exception.code, 404)
        denied.exception.close()
