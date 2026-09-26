#!/usr/bin/env python3
"""Copy the native analyzer CLI into the desktop bundle resources."""

import os
from pathlib import Path
import shutil
import sys

ROOT = Path(__file__).resolve().parent.parent
target = sys.argv[1] if len(sys.argv) > 1 else ""
profile = "debug" if "--debug" in sys.argv else "release"
name = "analyze.exe" if os.name == "nt" else "analyze"
source = ROOT / "target" / target / profile / name
destination = ROOT / "src-tauri" / "binaries" / name
if not source.is_file():
    raise SystemExit(f"Analyzer CLI is missing: {source}")
destination.parent.mkdir(parents=True, exist_ok=True)
shutil.copy2(source, destination)
print(destination)
