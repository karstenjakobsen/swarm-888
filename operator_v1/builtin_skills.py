from hashlib import sha256
from pathlib import Path

from .catalog import AUTHORING_SKILL, SEED, CatalogError
from .catalog_manifest import MANIFEST_FILE, GuideSkillManifest, read_guide, read_manifest
from .contracts import BuiltinSkillInfo

CONNECT_CATALOG = "connect-catalog"
BUILTIN_SKILLS = (AUTHORING_SKILL, CONNECT_CATALOG)


def builtin_guide(skill: str) -> dict:
    if skill not in BUILTIN_SKILLS:
        raise KeyError(skill)
    directory = SEED / "skills" / skill
    prefix = directory.relative_to(Path(__file__).parent.parent).as_posix() + "/"
    path = prefix + MANIFEST_FILE
    digests = []

    def read_file(name: str) -> str:
        file = directory / name
        if file.is_symlink() or not file.is_file():
            raise CatalogError(f"{prefix}{name} must be a regular file in the framework release")
        contents = file.read_bytes()
        digests.append(sha256(contents).digest())
        return contents.decode("utf-8")

    manifest = read_manifest(read_file, prefix)
    if not isinstance(manifest, GuideSkillManifest):
        raise CatalogError(f"Expected a guide skill manifest at {path}")
    guide, template = read_guide(manifest, read_file, prefix)
    return {
        "skill": skill,
        "canonical_id": manifest.canonical_id,
        "name": manifest.name,
        "guide": guide,
        "template": template,
        "revision": sha256(b"".join(digests)).hexdigest(),
        "path": path,
    }


def builtin_skills() -> list[BuiltinSkillInfo]:
    return [BuiltinSkillInfo.model_validate(builtin_guide(skill)) for skill in BUILTIN_SKILLS]
