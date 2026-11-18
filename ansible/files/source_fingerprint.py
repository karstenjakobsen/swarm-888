"""Hash build inputs without including local secrets, installed files, or Git data."""

import hashlib
import sys
from pathlib import Path

root = Path(sys.argv[1])
digest = hashlib.sha256()
inputs = [
    ".nvmrc",
    "package.json",
    "package-lock.json",
    "tsconfig.json",
    "vite.config.ts",
    "index.html",
    "src",
    "scripts",
    "migrations",
    "skills",
    "web",
    "generated",
]
for name in inputs:
    entry = root / name
    paths = sorted(entry.rglob("*")) if entry.is_dir() else [entry]
    for path in paths:
        if path.is_file() and not path.is_symlink():
            digest.update(str(path.relative_to(root)).encode())
            digest.update(b"\0")
            digest.update(path.read_bytes())
            digest.update(b"\0")
print(digest.hexdigest())
