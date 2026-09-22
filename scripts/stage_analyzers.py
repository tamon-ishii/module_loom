#!/usr/bin/env python3
"""Stage CI-built analyzers for both IDE plugins and standalone downloads."""

import argparse
import shutil
from pathlib import Path
from zipfile import ZIP_DEFLATED, ZipFile, ZipInfo


TARGETS = {
    "windows-x64": "analyze.exe",
    "linux-x64": "analyze",
    "macos-x64": "analyze",
    "macos-arm64": "analyze",
}


def stage(artifact_root: Path, project_root: Path) -> None:
    destinations = (
        project_root / "plugins/pycharm/src/main/resources/bin",
        project_root / "plugins/vscode/bin",
    )
    release_dir = project_root / "target/cli-release"
    release_dir.mkdir(parents=True, exist_ok=True)

    for platform, filename in TARGETS.items():
        source = artifact_root / f"analyzer-{platform}" / filename
        if not source.is_file():
            raise FileNotFoundError(f"Missing analyzer artifact: {source}")
        binary = source.read_bytes()
        if not binary:
            raise ValueError(f"Empty analyzer artifact: {source}")

        for destination in destinations:
            target = destination / platform / filename
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, target)

        archive_path = release_dir / f"ModuleLoom-CLI-{platform}.zip"
        info = ZipInfo(filename)
        info.create_system = 3
        info.external_attr = (0o755 << 16) if platform != "windows-x64" else (0o644 << 16)
        info.compress_type = ZIP_DEFLATED
        with ZipFile(archive_path, "w") as archive:
            archive.writestr(info, binary)
        print(f"Staged {platform}: {archive_path}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("artifact_root", type=Path)
    args = parser.parse_args()
    stage(args.artifact_root, Path(__file__).resolve().parent.parent)
