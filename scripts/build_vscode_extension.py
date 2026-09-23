#!/usr/bin/env python3
"""Copy the shared web application into the VS Code extension package."""
from pathlib import Path
import shutil
import subprocess

root = Path(__file__).resolve().parent.parent
subprocess.run(["npm", "run", "build"], cwd=root, check=True)
source = root / "dist"
destination = root / "plugins" / "vscode" / "media"
if destination.exists():
    shutil.rmtree(destination)
shutil.copytree(source, destination)
shutil.copy2(root / "plugins" / "vscode" / "moduleloom.svg", destination / "moduleloom.svg")
print(f"Updated shared web application in {destination}")
