import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from swarm import catalog, shared_catalog
from swarm.engine import Engine
from swarm.store import Store


class SharedCatalogTest(unittest.TestCase):
    def test_switching_checkout_blocks_old_work_and_queues_a_fresh_sync(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = Store(tmp)
            shared_catalog.configure(store)
            running = store.claim("worker-01")
            publish = store.enqueue(shared_catalog.PROJECT, "Publish pending edits", "publish")
            personal = store.enqueue("inbox", "Continue")
            same_repo = "https://github.com/karstenjakobsen/packages-888.git"
            shared_catalog.configure(store, remote=same_repo)
            self.assertEqual(store.job(publish["id"])["state"], "queued")
            shared_catalog.configure(store, Path(tmp) / "another-checkout")
            store.recover()
            for job in (running, publish):
                self.assertEqual(store.job(job["id"])["state"], "blocked")
                self.assertIn("catalog checkout changed", store.job(job["id"])["result"])
            queued = store.query(
                "SELECT kind FROM jobs WHERE project=? AND state='queued'",
                (shared_catalog.PROJECT,),
            )
            self.assertEqual(queued, [{"kind": "import"}])
            self.assertEqual(store.job(personal["id"])["state"], "queued")

    def test_adopt_clone_publish_pull_and_preserve_conflicts(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            remote = root / "remote.git"
            checkout = root / "existing-packages"
            address = shared_catalog.DEFAULT_REMOTE

            def git(*args):
                return subprocess.check_output(["git", *args], text=True).strip()

            git("init", "-q", "--bare", "-b", "main", remote)
            git("init", "-q", "-b", "main", checkout)
            (checkout / "skills").mkdir()
            (checkout / "skills/.gitkeep").touch()
            git("-C", checkout, "add", "skills")
            git(
                "-C",
                checkout,
                "-c",
                "user.name=test",
                "-c",
                "user.email=test@local",
                "commit",
                "-qm",
                "Initialize catalog",
            )
            git("-C", checkout, "push", "-q", remote, "HEAD:main")
            git("-C", checkout, "remote", "add", "origin", address)
            first, second = Store(root / "first"), Store(root / "second")
            shared_catalog.configure(first, checkout, address)
            shared_catalog.configure(second)
            spawn = asyncio.create_subprocess_exec

            async def test_transport(*args, **kwargs):
                kwargs["env"].update(
                    GIT_ALLOW_PROTOCOL="file",
                    GIT_CONFIG_COUNT="1",
                    GIT_CONFIG_KEY_0=f"url.{remote.as_uri()}.insteadOf",
                    GIT_CONFIG_VALUE_0=address,
                )
                return await spawn(*args, **kwargs)

            def operate(store, kind):
                job = {"kind": kind, "project": shared_catalog.PROJECT, "target": ""}
                return asyncio.run(Engine(store, 1, "codex")._run(job))

            with patch("swarm.catalog.asyncio.create_subprocess_exec", test_transport):
                operate(first, "import")
                operate(second, "import")
                self.assertEqual(first.workspace(shared_catalog.PROJECT), checkout)
                self.assertEqual(second.workspace(shared_catalog.PROJECT), second.root / "catalog")
                asset = checkout / "skills/daily/SKILL.md"
                asset.parent.mkdir()
                asset.write_text("first version")
                (checkout / "private-note").write_text("local only")
                git("-C", checkout, "add", "private-note")
                with self.assertRaisesRegex(ValueError, "staged changes outside"):
                    operate(first, "publish")
                git("-C", checkout, "restore", "--staged", "private-note")
                operate(first, "publish")
                self.assertEqual(
                    git("-C", checkout, "rev-parse", "origin/main"),
                    git("-C", checkout, "rev-parse", "HEAD"),
                )
                operate(second, "import")
                other = second.catalog_dir / "skills/daily/SKILL.md"
                self.assertEqual(other.read_text(), "first version")
                self.assertFalse((second.catalog_dir / "private-note").exists())
                self.assertEqual(shared_catalog.info(second)["assets"][0]["name"], "daily")
                other.write_text("peer improvement")
                operate(second, "publish")
                asset.write_text("pending local edit")
                with self.assertRaisesRegex(ValueError, "preserve local edits"):
                    operate(first, "import")
                self.assertEqual(asset.read_text(), "pending local edit")
                self.assertEqual(
                    git("--git-dir", remote, "show", "main:skills/daily/SKILL.md"),
                    "peer improvement",
                )
                published = git("--git-dir", remote, "rev-parse", "main")
                (second.catalog_dir / "private-note").write_text("peer local only")
                git("-C", second.catalog_dir, "add", "private-note")
                git(
                    "-C",
                    second.catalog_dir,
                    "-c",
                    "user.name=test",
                    "-c",
                    "user.email=test@local",
                    "commit",
                    "-qm",
                    "local notes",
                )
                with self.assertRaisesRegex(ValueError, "committed changes outside"):
                    operate(second, "publish")
                self.assertEqual(git("--git-dir", remote, "rev-parse", "main"), published)
            later = Store(first.root)
            shared_catalog.configure(later)
            self.assertEqual(later.catalog_dir, checkout)

    def test_ssh_addresses_are_specific_to_git(self):
        url = "git@github.com:karstenjakobsen/packages-888.git"
        self.assertEqual(catalog.repository_url(url), url)
        self.assertEqual(
            shared_catalog.identity(url),
            shared_catalog.identity("https://github.com/karstenjakobsen/packages-888.git"),
        )
        for unsafe in (
            "ext::command",
            "git@-host:org/repo",
            "git@host:org/../private",
            "git@host:org/repo;command",
        ):
            with self.assertRaises(ValueError):
                catalog.repository_url(unsafe)
        with self.assertRaises(ValueError):
            catalog.https_url(url, local=True)
