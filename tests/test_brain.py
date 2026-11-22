import tempfile
import unittest
from pathlib import Path

from swarm import codex, records
from swarm.store import SHARED_CATALOG_PROJECT, Store


class BrainTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.store = Store(directory.name)

    def test_upgrade_preserves_legacy_notes_and_only_retires_private_copies(self):
        store = self.store
        body = "Verified fact\r\nSecond line\n"
        note = store.workspace("inbox") / "MEMORY.md"
        note.write_bytes(body.encode())
        linked = store.create_project("Linked", "https://example.org/r.git")
        repo_note = store.workspace(linked["id"]) / "MEMORY.md"
        repo_note.write_text("From repository")
        private = store.create_project("Other")
        (store.workspace(private["id"]) / "MEMORY.md").symlink_to(repo_note)
        store.configure_catalog(
            Path(store.root) / "checkout", "https://example.org/c.git", "main", False
        )
        store.workspace(SHARED_CATALOG_PROJECT).mkdir()
        (store.workspace(SHARED_CATALOG_PROJECT) / "MEMORY.md").write_text("Catalog file")
        store.update("PRAGMA user_version=0", ())
        Store(store.root)
        Store(store.root)
        rows = store.query("SELECT project,body FROM memory")
        self.assertEqual(
            {r["project"]: r["body"] for r in rows},
            {"inbox": body, linked["id"]: "From repository"},
        )
        self.assertEqual(len(rows), 2)
        self.assertFalse(note.exists())
        self.assertTrue(repo_note.is_file())

    def test_recall_scope_and_replayed_completion(self):
        store = self.store
        peer = store.peer_project(store.invite("Remote"))
        other_peer = store.peer_project(store.invite("Other remote"))
        store.configure_catalog(store.root / "checkout", "", "main", False)
        store.finish(store.claim("worker"), "completed", "catalog synced")
        for project in ["inbox", peer, other_peer, SHARED_CATALOG_PROJECT]:
            store.enqueue(project, "remember")
            job = store.claim("worker")
            store.finish(job, "blocked", "blocked", project)
            store.finish(job, "completed", "duplicate", "duplicate")
        for project in [peer, other_peer, SHARED_CATALOG_PROJECT]:
            self.assertEqual([r["note"] for r in store.recall(project)], [project])
        self.assertEqual(
            {r["note"] for r in store.recall("inbox")}, {"inbox", SHARED_CATALOG_PROJECT}
        )
        self.assertEqual(len(records.page(store, "memory")["rows"]), 4)
        self.assertEqual(codex.outcome('{"outcome":"completed","summary":"old turn"}').memory, "")

    def test_record_pages_and_private_columns(self):
        store = self.store
        for n in range(records.PAGE_SIZE + 1):
            store.enqueue("inbox", str(n))
        newest = records.page(store, "jobs")
        store.enqueue("inbox", "arrived while browsing")
        older = records.page(store, "jobs", newest["next"])
        self.assertEqual(len(newest["rows"]), records.PAGE_SIZE)
        self.assertEqual([r["prompt"] for r in older["rows"]], ["0"])
        self.assertIsNone(older["next"])
        store.invite("peer")
        self.assertEqual(set(records.page(store, "invites")["rows"][0]), {"record", "project"})
        with self.assertRaises(KeyError):
            records.page(store, "sqlite_schema")
        with self.assertRaises(ValueError):
            records.page(store, "jobs", -1)
