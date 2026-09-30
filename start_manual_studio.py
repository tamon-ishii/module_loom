#!/usr/bin/env python3
"""Launch Manual Studio from any working directory using only the standard library."""

import argparse
import os
from pathlib import Path
import shutil
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parent


def required_tool(name: str) -> str:
    executable = shutil.which(name)
    if executable is None:
        raise RuntimeError(f"初回ビルドには {name} が必要です。インストールしてください。")
    return executable


def prepare_frontend(npm: str) -> None:
    if not (PROJECT_ROOT / "node_modules").is_dir():
        subprocess.run([npm, "ci"], cwd=PROJECT_ROOT, check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description="Manual Studioをローカルで起動します。初回は自動でビルドします。")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--build", action="store_true", help="現在のソースからビルドして起動")
    mode.add_argument("--dev", action="store_true", help="変更を反映する開発モードで起動")
    args = parser.parse_args()

    try:
        if args.dev:
            npm = required_tool("npm")
            prepare_frontend(npm)
            return subprocess.run([npm, "run", "manual:app"], cwd=PROJECT_ROOT, check=False).returncode

        target = Path(os.environ.get("CARGO_TARGET_DIR", "target"))
        if not target.is_absolute():
            target = PROJECT_ROOT / target
        binary_name = "manual-studio.exe" if sys.platform == "win32" else "manual-studio"
        binary = None
        if not args.build:
            for profile in ("release", "debug"):
                candidate = target / profile / binary_name
                if candidate.is_file() and os.access(candidate, os.X_OK):
                    binary = candidate
                    break

        if binary is None:
            npm = required_tool("npm")
            cargo = required_tool("cargo")
            prepare_frontend(npm)
            subprocess.run([npm, "run", "manual:build"], cwd=PROJECT_ROOT, check=True)
            subprocess.run([cargo, "build", "--locked", "-p", "manual-studio"], cwd=PROJECT_ROOT, check=True)
            binary = target / "debug" / binary_name

        return subprocess.run([str(binary)], cwd=PROJECT_ROOT, check=False).returncode
    except (OSError, RuntimeError, subprocess.CalledProcessError) as error:
        print(f"起動できませんでした: {error}", file=sys.stderr)
        return 1
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":
    sys.exit(main())
