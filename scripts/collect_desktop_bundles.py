#!/usr/bin/env python3
"""Collect native Tauri installers under stable GitHub Release filenames."""

import argparse
import shutil
from pathlib import Path


EXTENSIONS = {".exe", ".AppImage", ".deb", ".dmg"}


def collect(project_root: Path, platform: str) -> list[Path]:
    output_dir = project_root / "target/release-assets"
    output_dir.mkdir(parents=True, exist_ok=True)
    outputs = []
    for source in (project_root / "target").rglob("*"):
        if not source.is_file() or source.suffix not in EXTENSIONS:
            continue
        if "bundle" not in source.parts or "release" not in source.parts:
            continue
        destination = output_dir / f"ModuleLoom-Desktop-{platform}-{source.name}"
        shutil.copy2(source, destination)
        outputs.append(destination)
    if not outputs:
        raise FileNotFoundError(f"No desktop bundles found for {platform}")
    return outputs


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("platform")
    args = parser.parse_args()
    for file in collect(Path(__file__).resolve().parent.parent, args.platform):
        print(file)
