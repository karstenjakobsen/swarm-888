#!/usr/bin/env python3
"""Build a relocatable Python zipapp; only application files and browser assets are included."""

import argparse
import shutil
import tempfile
import zipapp
from pathlib import Path


def build(out):
    source = Path(__file__).resolve().parents[1] / "swarm"
    out.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / "app"
        shutil.copytree(
            source, stage / "swarm", ignore=shutil.ignore_patterns("__pycache__", "*.pyc")
        )
        (stage / "__main__.py").write_text(
            "from swarm.__main__ import main\nraise SystemExit(main())\n"
        )
        zipapp.create_archive(stage, out, interpreter="/usr/bin/env python3", compressed=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--output", type=Path, default=Path("dist/swarm-operator.pyz"))
    args = parser.parse_args()
    build(args.output)
