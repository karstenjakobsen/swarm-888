import asyncio
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from swarm import catalog, shared_catalog
from swarm.engine import Engine
from swarm.store import Store


class SharedCatalogTest(unittest.IsolatedAsyncioTestCase):
    async def test_adopt_clone_publish_pull_and_preserve_conflicts(self):
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

            async def operate(store, kind):
                return await Engine(store, 1, "codex")._run(
                    {"kind": kind, "project": shared_catalog.PROJECT, "target": ""}
                )

            with patch("swarm.catalog.asyncio.create_subprocess_exec", test_transport):
                await operate(first, "import")
                await operate(second, "import")
                self.assertEqual(first.workspace(shared_catalog.PROJECT), checkout)
                self.assertEqual(second.workspace(shared_catalog.PROJECT), second.root / "catalog")
                asset = checkout / "skills/daily/SKILL.md"
                asset.parent.mkdir()
                asset.write_text("first version")
                (checkout / "private-note").write_text("local only")
                await operate(first, "publish")
                self.assertEqual(
                    git("-C", checkout, "rev-parse", "origin/main"),
                    git("-C", checkout, "rev-parse", "HEAD"),
                )
                await operate(second, "import")
                other = second.catalog_dir / "skills/daily/SKILL.md"
                self.assertEqual(other.read_text(), "first version")
                self.assertFalse((second.catalog_dir / "private-note").exists())
                self.assertEqual(shared_catalog.info(second)["assets"][0]["name"], "daily")
                other.write_text("peer improvement")
                await operate(second, "publish")
                asset.write_text("pending local edit")
                with self.assertRaisesRegex(ValueError, "preserve local edits"):
                    await operate(first, "import")
                self.assertEqual(asset.read_text(), "pending local edit")
                self.assertEqual(
                    git("--git-dir", remote, "show", "main:skills/daily/SKILL.md"),
                    "peer improvement",
                )
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
