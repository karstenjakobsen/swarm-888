import json
from hashlib import sha256
from pathlib import Path

from .catalog import AUTHORING_SKILL, SEED
from .contracts import BuiltinSkillInfo

CONNECT_CATALOG = "connect-catalog"
GUIDES = {
    AUTHORING_SKILL: ("Create a skill", SEED / "skills" / AUTHORING_SKILL / "SKILL.md"),
    CONNECT_CATALOG: ("Connect a catalog", Path(__file__).parent / "seed" / "connect-catalog.md"),
}


def builtin_guide(skill: str) -> dict:
    name, path = GUIDES[skill]
    contents = path.read_bytes()
    guide = contents.decode()
    template = None
    if skill == AUTHORING_SKILL:
        raw_template = path.with_name("template.json").read_bytes()
        template = json.loads(raw_template)
        contents += raw_template
    return {
        "skill": skill,
        "name": name,
        "guide": guide,
        "template": template,
        "revision": sha256(contents).hexdigest(),
        "path": path.relative_to(Path(__file__).parent.parent).as_posix(),
    }


def builtin_skills() -> list[BuiltinSkillInfo]:
    return [BuiltinSkillInfo.model_validate(builtin_guide(skill)) for skill in GUIDES]
