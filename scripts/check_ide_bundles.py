#!/usr/bin/env python3
"""Check that IDE archives contain every analyzer and its licensed jscpd."""

import argparse
from pathlib import Path
from zipfile import ZipFile

from stage_analyzers import JSCPD_LICENSE, TARGETS


def check(archive_path: Path, prefix: str) -> None:
    with ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        license_name = f"{prefix}licenses/jscpd/LICENSE"
        if license_name not in names or archive.read(license_name) != JSCPD_LICENSE.read_bytes():
            raise RuntimeError(f"Missing or incorrect jscpd license in {archive_path}")
        for platform, analyzer_name in TARGETS.items():
            jscpd_name = "jscpd.exe" if platform == "windows-x64" else "jscpd"
            for name in (analyzer_name, jscpd_name):
                entry = f"{prefix}bin/{platform}/{name}"
                if entry not in names or not archive.read(entry):
                    raise RuntimeError(f"Missing or empty {entry} in {archive_path}")
    print(f"Validated {archive_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--jar", type=Path)
    parser.add_argument("--vsix", type=Path)
    args = parser.parse_args()
    if not args.jar and not args.vsix:
        parser.error("provide --jar, --vsix, or both")
    if args.jar:
        check(args.jar, "")
    if args.vsix:
        check(args.vsix, "extension/")
