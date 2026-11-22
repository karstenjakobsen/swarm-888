import argparse
import json
import subprocess
import tempfile
from pathlib import Path

from .controller import create_app


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true")
    args = parser.parse_args()
    web = Path(__file__).resolve().parents[1] / "web"
    target = web / "lib/operator/api.d.ts"
    with tempfile.TemporaryDirectory() as tmp:
        schema = Path(tmp) / "openapi.json"
        output = Path(tmp) / "api.d.ts"
        schema.write_text(json.dumps(create_app().openapi()))
        subprocess.run(
            ["corepack", "pnpm", "exec", "openapi-typescript", str(schema), "-o", str(output)],
            check=True,
            cwd=web,
        )
        if args.check:
            if not target.exists() or target.read_bytes() != output.read_bytes():
                raise SystemExit("API types are out of date. Run make api-types.")
        else:
            target.write_bytes(output.read_bytes())


if __name__ == "__main__":
    main()
