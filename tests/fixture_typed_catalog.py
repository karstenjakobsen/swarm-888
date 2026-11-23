from pathlib import Path

from operator_v1.catalog import run_git

PUBLISHER = "karstenjakobsen"
REPO = "git@github.com:karstenjakobsen/packages-888.git"


def typed_remote(directory: Path) -> tuple[Path, str]:
    directory.mkdir()
    remote, source = directory / "packages.git", directory / "source"
    run_git("init", "--bare", "--initial-branch=main", str(remote))
    run_git("clone", str(remote), str(source))
    for name in ("check-disk", "digital-ocean", "kj-api"):
        (source / name).mkdir()
    (source / "check-disk/operator.yaml").write_text(
        """schema_version: 1
kind: skill
canonical_id: karstenjakobsen-skill-check-disk
name: Check disk
entrypoint: run.lua
tests: tests.json
input_schema: {type: object}
"""
    )
    (source / "check-disk/run.lua").write_text('return function() return "existing" end\n')
    (source / "check-disk/tests.json").write_text(
        '[{"name":"fixture","arguments":{},"expected":"existing"}]\n'
    )
    (source / "digital-ocean/operator.yaml").write_text(
        """schema_version: 1
kind: connector
canonical_id: karstenjakobsen-connector-digital-ocean
name: DigitalOcean fixture
endpoint: http://127.0.0.1:8765/mcp
auth: bearer
tool: read_fixture
secret_ref: digital-ocean
"""
    )
    (source / "kj-api/operator.yaml").write_text(
        """schema_version: 1
kind: project
canonical_id: karstenjakobsen-project-kj-api
name: KJ API
description: Application source fixture
repo: https://example.invalid/kj-api.git
"""
    )
    run_git("add", "-A", cwd=source)
    run_git("commit", "-m", "Prepare the typed catalog", cwd=source)
    run_git("push", "origin", "main", cwd=source)
    return remote, run_git("rev-parse", "HEAD", cwd=source).stdout.strip()
