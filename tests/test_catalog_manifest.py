import json
import subprocess
from pathlib import Path

import pytest
from test_skills import ROOT, bootstrap

from operator_v1.catalog import Catalog, CatalogError, run_git
from operator_v1.catalog_manifest import assign_canonical_id, discover_catalog
from operator_v1.state import State

PUBLISHER = "karstenjakobsen"


def write_manifest(checkout: Path, path: str, definition: str) -> Path:
    file = checkout / path
    file.parent.mkdir(parents=True, exist_ok=True)
    file.write_text(definition)
    return file


def commit(checkout: Path, message: str) -> str:
    run_git("add", "-A", cwd=checkout)
    run_git("commit", "-m", message, cwd=checkout)
    return run_git("rev-parse", "HEAD", cwd=checkout).stdout.strip()


@pytest.fixture
def catalog_layout(tmp_path):
    settings, env = bootstrap(tmp_path)
    catalog = Catalog.load(settings)
    skill_id = assign_canonical_id(PUBLISHER, "skill", "check-disk")
    write_manifest(
        catalog.checkout,
        "check-disk/operator.yaml",
        f"""schema_version: 1
kind: skill
canonical_id: {skill_id}
name: Check disk
entrypoint: run.lua
tests: tests.json
input_schema:
  type: object
dependencies: []
""",
    )
    write_manifest(catalog.checkout, "check-disk/run.lua", 'return function() return "old" end\n')
    write_manifest(
        catalog.checkout,
        "check-disk/tests.json",
        json.dumps([{"name": "fixture", "arguments": {}, "expected": "old"}]),
    )
    write_manifest(
        catalog.checkout,
        "digital-ocean/operator.yaml",
        """schema_version: 1
kind: connector
canonical_id: karstenjakobsen-connector-digital-ocean
name: DigitalOcean fixture
endpoint: http://127.0.0.1:8765/mcp
auth: bearer
tool: read_fixture
secret_ref: digital-ocean
""",
    )
    write_manifest(
        catalog.checkout,
        "operator.yaml",
        """schema_version: 1
kind: project
canonical_id: karstenjakobsen-project-kj-api
name: KJ API
description: Application source fixture
repo: https://example.invalid/kj-api.git
""",
    )
    write_manifest(catalog.checkout, "ignored/nested/operator.yaml", "invalid: [")
    revision = commit(catalog.checkout, "Create typed fixture catalog")
    return catalog, env, revision, skill_id


def test_shallow_discovery_reads_the_committed_snapshot(catalog_layout):
    catalog, env, revision, skill_id = catalog_layout
    snapshot = discover_catalog(catalog, revision)
    assert snapshot.repo == catalog.config.remote
    assert snapshot.branch == "main"
    assert snapshot.revision == revision
    assert [(item.manifest.kind, item.path) for item in snapshot.items] == [
        ("project", "operator.yaml"),
        ("skill", "check-disk/operator.yaml"),
        ("connector", "digital-ocean/operator.yaml"),
    ]
    assert skill_id == "karstenjakobsen-skill-check-disk"

    manifest_file = catalog.checkout / "check-disk" / "operator.yaml"
    original = manifest_file.read_bytes()
    manifest_file.write_text("invalid: [")
    cli = subprocess.run(
        [
            str(ROOT / ".venv/bin/python"),
            "-m",
            "operator_v1.catalog_cli",
            "discover",
            "--revision",
            revision,
            "--kind",
            "skill",
        ],
        cwd=ROOT,
        env=env,
        capture_output=True,
        check=True,
        text=True,
    )
    observed = json.loads(cli.stdout)
    assert observed["revision"] == revision
    assert [item["manifest"]["canonical_id"] for item in observed["items"]] == [skill_id]
    assert manifest_file.read_text() == "invalid: ["
    manifest_file.write_bytes(original)

    (catalog.checkout / "check-disk" / "run.lua").write_text('return function() return "new" end\n')
    edited = commit(catalog.checkout, "Edit only run.lua")
    assert edited != revision
    assert run_git(
        "diff", "--name-only", revision, edited, cwd=catalog.checkout
    ).stdout.splitlines() == ["check-disk/run.lua"]
    assert discover_catalog(catalog, edited, "skill").items[0].manifest.canonical_id == skill_id

    run_git("mv", "check-disk", "renamed", cwd=catalog.checkout)
    moved = commit(catalog.checkout, "Move the skill")
    item = discover_catalog(catalog, moved, "skill").items[0]
    assert item.path == "renamed/operator.yaml"
    assert item.manifest.canonical_id == skill_id
    assert discover_catalog(catalog, revision) == snapshot


def test_duplicate_id_fails_before_kind_filter_and_keeps_prior_revision(catalog_layout):
    catalog, _, revision, skill_id = catalog_layout
    saved = discover_catalog(catalog, revision)
    active = State(catalog.settings).active_skill_revision("create-skill")
    project = catalog.checkout / "operator.yaml"
    project.write_text(project.read_text().replace("karstenjakobsen-project-kj-api", skill_id))
    bad = commit(catalog.checkout, "Claim the skill ID from a project")
    with pytest.raises(CatalogError) as error:
        discover_catalog(catalog, bad, "connector")
    assert str(error.value) == (
        f"Duplicate canonical ID {skill_id} in operator.yaml and check-disk/operator.yaml"
    )
    assert catalog.git("rev-parse", "HEAD").strip() == bad
    assert discover_catalog(catalog, revision) == saved
    assert State(catalog.settings).active_skill_revision("create-skill") == active


@pytest.mark.parametrize("entrypoint", ["../run.lua", "/tmp/run.lua", "nested/run.lua"])
def test_entrypoint_must_be_a_sibling(catalog_layout, entrypoint):
    catalog, _, _, _ = catalog_layout
    manifest = catalog.checkout / "check-disk" / "operator.yaml"
    manifest.write_text(manifest.read_text().replace("run.lua", entrypoint))
    revision = commit(catalog.checkout, "Declare an unsafe entrypoint")
    with pytest.raises(CatalogError, match=r"check-disk/operator.yaml .*entrypoint"):
        discover_catalog(catalog, revision)


@pytest.mark.parametrize("path", ["check-disk/run.lua", "check-disk/operator.yaml"])
def test_discovery_rejects_symlinks(catalog_layout, path):
    catalog, _, _, _ = catalog_layout
    file = catalog.checkout / path
    file.unlink()
    file.symlink_to("../operator.yaml")
    revision = commit(catalog.checkout, "Commit a symlink")
    with pytest.raises(CatalogError, match=rf"{path} must be a regular file"):
        discover_catalog(catalog, revision)


@pytest.mark.parametrize("extra", ["name: Duplicate\n", "---\nname: Second item\n"])
def test_a_manifest_has_one_unambiguous_yaml_mapping(catalog_layout, extra):
    catalog, _, _, _ = catalog_layout
    file = catalog.checkout / "operator.yaml"
    file.write_text(file.read_text() + extra)
    revision = commit(catalog.checkout, "Commit an ambiguous manifest")
    with pytest.raises(CatalogError, match="Invalid YAML manifest at operator.yaml"):
        discover_catalog(catalog, revision)
