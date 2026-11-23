import argparse
import json
import os
import shutil
import sqlite3
import subprocess
from contextlib import closing
from pathlib import Path
from unittest.mock import patch
from urllib.parse import parse_qs, urlsplit

from fixture_typed_catalog import PUBLISHER, REPO, typed_remote
from test_catalog_migration import legacy_fixture

from operator_v1.backup import export, restore
from operator_v1.catalog import Catalog, run_git
from operator_v1.catalog_migration import CatalogMigration
from operator_v1.config import Settings
from operator_v1.skills import Skills
from operator_v1.state import State


def prepare_typed(directory: Path) -> dict:
    state = Settings(directory / "state")
    state.create_owner_key()
    remote, revision = typed_remote(directory / "fixture")
    fixture = directory / "authoring.json"
    fixture.write_text(
        json.dumps(
            {
                "query": "fixture lookup",
                "skill": "fixture-lookup",
                "input": "selector",
                "entrypoint": 'return function(args) return "old:" .. args.selector end',
                "definition": {
                    "name": "Fixture lookup",
                    "purpose": "Fixture lookup by selector",
                    "procedure": ["Read the supplied selector."],
                    "program": {
                        "source": "executable",
                        "entrypoint": "run.lua",
                        "input_schema": {
                            "type": "object",
                            "properties": {"selector": {"type": "string"}},
                            "required": ["selector"],
                        },
                    },
                    "tests": [
                        {
                            "name": "fixture",
                            "arguments": {"selector": "swarm.test=a"},
                            "expected": "old:swarm.test=a",
                        }
                    ],
                },
            }
        )
    )
    return {
        "state": str(state.directory),
        "remote": str(remote),
        "repo": REPO,
        "revision": revision,
        "fixture": str(fixture),
    }


def copy_recorded_state(source: Path, directory: Path) -> tuple[Settings, str, str, str, dict]:
    old = source / "state"
    copy = Settings(directory / "state")
    old_config = json.loads((old / "catalog.json").read_text())
    shutil.copytree(
        old,
        copy.directory,
        symlinks=True,
        ignore=shutil.ignore_patterns(
            "operator.sqlite3*",
            "*.lock",
            "*.sock",
            "worker-status.json",
        ),
    )
    with closing(
        sqlite3.connect((old / "operator.sqlite3").as_uri() + "?mode=ro", uri=True)
    ) as original:
        with closing(sqlite3.connect(copy.directory / "operator.sqlite3")) as target:
            original.backup(target)
    checkout, remote = directory / "migration-checkout", directory / "migration-remote.git"
    run_git("clone", "--bare", old_config["checkout"], str(remote))
    run_git("clone", "--branch", old_config["branch"], str(remote), str(checkout))
    old_config.update(remote=str(remote), checkout=str(checkout), deploy_key=False)
    copy.catalog_config.write_text(json.dumps(old_config))
    evidence = json.loads((source / "evidence.json").read_text())
    task = evidence["creatingTask"].rsplit("/", 1)[-1]
    revision_url = urlsplit(evidence["skillRevision"])
    skill = revision_url.path.rsplit("/", 1)[-1]
    revision = parse_qs(revision_url.query)["rev"][0]
    empty = next(call for call in evidence["creatingCalls"] if call["result"] == [])
    return copy, task, revision, skill, empty["arguments"]


def prepare_migration(directory: Path) -> dict:
    source = os.environ.get("OPERATOR_CATALOG_MIGRATION_SOURCE")
    if source:
        copy, task, pinned, skill, arguments = copy_recorded_state(Path(source), directory)
    else:
        existing, task, pinned = legacy_fixture(directory / "legacy")
        archive = directory / "legacy.tar.gz"
        export(existing, archive)
        copy = Settings(directory / "state")
        restore(copy, archive, directory / "migration-checkout")
        skill, arguments = "legacy-fixture", {}
    state = State(copy)
    migration = CatalogMigration(state)
    preview = migration.migrate(PUBLISHER, apply=False)
    legacy = Catalog.load(copy)
    with patch.object(migration, "finish", side_effect=InterruptedError("fixture interruption")):
        try:
            migration.migrate(PUBLISHER, apply=True)
        except InterruptedError:
            interrupted = legacy.git("rev-parse", "HEAD").strip()
        else:
            raise AssertionError("Migration did not reach the interruption checkpoint")
    applied = CatalogMigration(State(copy)).migrate(PUBLISHER, apply=True)
    before = (copy.directory / "operator.sqlite3").read_bytes()
    repeated = migration.migrate(PUBLISHER, apply=True)
    assert applied == repeated and applied["revision"] == interrupted
    assert (copy.directory / "operator.sqlite3").read_bytes() == before
    assert not legacy.git("status", "--porcelain")
    invocation = Skills(None, state).invoke(skill, arguments)
    independent = "retained"
    if source:
        output = subprocess.check_output(
            ["docker", "ps", "-aq", "--filter", f"label={arguments['label']}"], text=True
        )
        assert not output.strip()
        independent = []
    assert invocation["revision"] == pinned and invocation["result"] == independent
    return {
        "state": str(copy.directory),
        "task": task,
        "pinned": pinned,
        "skill": skill,
        "title": state.text(task),
        "source": source,
        "preview": preview,
        "applied": applied,
        "invocation": invocation,
        "interrupted_revision": interrupted,
        "repeat_file_changes": 0,
        "independent_result": independent,
    }


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("scenario", choices=("typed", "migration"))
    parser.add_argument("directory", type=Path)
    args = parser.parse_args()
    prepare = prepare_typed if args.scenario == "typed" else prepare_migration
    print(json.dumps(prepare(args.directory)))
