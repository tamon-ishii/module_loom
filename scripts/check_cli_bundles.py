#!/usr/bin/env python3
"""Validate standalone CLI archives and smoke-test the current platform."""

import argparse
import json
import os
import platform
import subprocess
import sys
import tempfile
from pathlib import Path
from zipfile import ZipFile

from stage_analyzers import JSCPD_LICENSE, TARGETS


def current_platform() -> str | None:
    system = platform.system().lower()
    machine = platform.machine().lower()
    if system == "windows" and machine in {"amd64", "x86_64"}:
        return "windows-x64"
    if system == "linux" and machine in {"amd64", "x86_64"}:
        return "linux-x64"
    if system == "darwin":
        return "macos-arm64" if machine in {"arm64", "aarch64"} else "macos-x64"
    return None


def smoke(analyzer: Path, jscpd: Path) -> None:
    version = subprocess.run([str(jscpd), "--version"],
                             capture_output=True, text=True, check=True).stdout.strip()
    if not version.startswith("jscpd 5."):
        raise RuntimeError(f"Unexpected bundled jscpd version: {version}")
    with tempfile.TemporaryDirectory() as directory:
        project = Path(directory)
        body = "    result = []\n    for row in rows:\n        amount = float(row.get('amount', 0))\n        if amount <= 0:\n            continue\n        result.append(round(amount * 1.1, 2))\n    return result\n"
        (project / "a.py").write_text(f"def first(rows):\n{body}", encoding="utf-8")
        (project / "b.py").write_text(f"def second(rows):\n{body}", encoding="utf-8")
        environment = os.environ.copy()
        environment["PATH"] = ""
        environment.pop("MODULELOOM_JSCPD_PATH", None)
        output = subprocess.run([str(analyzer.resolve()), "--diagnostics", str(project)],
                                capture_output=True, text=True, check=True, env=environment)
        report = json.loads(output.stdout)
        if report["schema_version"] != 1 or report["complexity"]["duplication_source"] != "jscpd":
            raise RuntimeError(f"Bundled diagnostics did not use jscpd: {analyzer}")
        if not report["duplicate_candidates"]:
            raise RuntimeError(f"Bundled diagnostics missed duplicate example: {analyzer}")


def check(release_dir: Path) -> None:
    native = current_platform()
    for target in TARGETS:
        archive_path = release_dir / f"ModuleLoom-CLI-{target}.zip"
        cli_name = "moduleloom-analyze.exe" if target == "windows-x64" else "moduleloom-analyze"
        jscpd_name = "jscpd.exe" if target == "windows-x64" else "jscpd"
        license_name = "licenses/jscpd/LICENSE"
        with ZipFile(archive_path) as archive:
            expected = {cli_name, jscpd_name, license_name}
            if set(archive.namelist()) != expected:
                raise RuntimeError(f"Unexpected files in {archive_path}: {archive.namelist()}")
            if archive.read(license_name) != JSCPD_LICENSE.read_bytes():
                raise RuntimeError(f"jscpd license mismatch in {archive_path}")
            for name in (cli_name, jscpd_name):
                if not archive.read(name):
                    raise RuntimeError(f"Empty {name} in {archive_path}")
                if target != "windows-x64" and not (archive.getinfo(name).external_attr >> 16) & 0o111:
                    raise RuntimeError(f"{name} lacks executable permissions in {archive_path}")
            if target != native:
                continue
            with tempfile.TemporaryDirectory() as directory:
                unpacked = Path(directory)
                archive.extractall(unpacked)
                for name in (cli_name, jscpd_name):
                    (unpacked / name).chmod(0o755)
                smoke(unpacked / cli_name, unpacked / jscpd_name)
    print(f"Validated CLI archives in {release_dir}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("release_dir", nargs="?", type=Path, default=Path("target/cli-release"))
    parser.add_argument("--binary", type=Path, help="Smoke-test an analyzer with sibling jscpd")
    args = parser.parse_args()
    if args.binary:
        smoke(args.binary, args.binary.with_name("jscpd.exe" if sys.platform == "win32" else "jscpd"))
    else:
        check(args.release_dir)
