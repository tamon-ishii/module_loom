#!/usr/bin/env python3
"""Copy the shared graph UI into the VS Code extension package."""
from pathlib import Path
import shutil

root = Path(__file__).resolve().parent.parent
source = root / "plugins" / "pycharm" / "src" / "main" / "resources" / "web"
destination = root / "plugins" / "vscode" / "media"
destination.mkdir(exist_ok=True)
for name in ("index.html", "cytoscape.min.js", "cytoscape-dagre.min.js"):
    shutil.copy2(source / name, destination / name)
    print(f"Updated {destination / name}")
