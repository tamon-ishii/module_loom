#!/usr/bin/env python3
"""Download and stage the platform's pinned jscpd v5 binary for IDE releases."""

import argparse
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile


JSCPD_VERSION = "5.3.2"
LICENSE = Path(__file__).resolve().parent.parent / "third_party/jscpd/LICENSE"


def stage(output: Path, wheel_path: Path | None = None) -> None:
    output.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as download_dir:
        if wheel_path is None:
            subprocess.run(
                [sys.executable, "-m", "pip", "download", "--no-deps", "--only-binary=:all:",
                 f"jscpd=={JSCPD_VERSION}", "--dest", download_dir],
                check=True,
            )
        wheels = [wheel_path] if wheel_path is not None else list(Path(download_dir).glob("jscpd-*.whl"))
        if len(wheels) != 1:
            raise RuntimeError(f"Expected one jscpd wheel, got {len(wheels)}")
        with ZipFile(wheels[0]) as wheel:
            script = next((name for name in wheel.namelist()
                           if name.endswith(".data/scripts/jscpd")
                           or name.endswith(".data/scripts/jscpd.exe")), None)
            license_entry = next((name for name in wheel.namelist()
                                  if name.endswith(".dist-info/LICENSE")), None)
            if script is None or license_entry is None:
                raise RuntimeError("jscpd wheel is missing its executable or license")
            if wheel.read(license_entry) != LICENSE.read_bytes():
                raise RuntimeError("jscpd wheel license differs from third_party/jscpd/LICENSE")
            destination = output / Path(script).name
            destination.write_bytes(wheel.read(script))
            if destination.suffix != ".exe":
                destination.chmod(0o755)
            version = subprocess.run([str(destination), "--version"], check=True,
                                     capture_output=True, text=True).stdout.strip()
            if version != f"jscpd {JSCPD_VERSION}":
                raise RuntimeError(f"Unexpected jscpd version: {version}")
            (output / "jscpd-LICENSE").write_bytes(wheel.read(license_entry))
            print(f"Staged {destination.name} ({version})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path)
    parser.add_argument("--wheel", type=Path, help="Use an existing platform wheel")
    args = parser.parse_args()
    stage(args.output, args.wheel)
