#!/usr/bin/env python3
"""Exercise a desktop manual scenario against a real accessible dialog."""

import json
import os
import struct
import subprocess
import sys
import tempfile
from pathlib import Path


def main() -> None:
    analyzer = Path(sys.argv[1]).resolve()
    with tempfile.TemporaryDirectory(prefix="moduleloom-desktop-smoke-") as directory:
        root = Path(directory)
        docs = root / "docs"
        docs.mkdir()
        (docs / "index.md").write_text(
            "<!-- ai:task id=dialog-shot kind=screenshot\nCapture the OK button\n-->\n",
            encoding="utf-8",
        )
        title = f"ModuleLoom desktop smoke {os.getpid()}"
        steps = [
            {"launch": {"program": "timeout", "args": ["30", "zenity", "--info", f"--title={title}", "--text=Accessibility smoke test"]}},
            {"window": title},
            {"expect_visible": "button[name='OK']"},
            {"screenshot": {"task": "dialog-shot", "selector": "button[name='OK']"}},
            {"press": "button[name='OK']"},
        ]
        (root / "scenario.json").write_text(
            json.dumps({"version": 1, "platform": "desktop", "steps": steps}),
            encoding="utf-8",
        )
        environment = os.environ.copy()
        environment["XDG_SESSION_TYPE"] = "x11"
        result = subprocess.run(
            [str(analyzer), "--manual", "scenario-run", "--root", str(root), "--input", "scenario.json"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            env=environment,
            timeout=70,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Desktop scenario failed:\n{result.stdout}\n{result.stderr}")
        report = json.loads(result.stdout)
        if report != {"captured": ["dialog-shot"], "steps": len(steps)}:
            raise RuntimeError(f"Unexpected scenario result: {report}")
        image = (docs / "assets" / "dialog-shot.png").read_bytes()
        if image[:8] != b"\x89PNG\r\n\x1a\n" or min(struct.unpack(">II", image[16:24])) < 1:
            raise RuntimeError("Captured dialog shot is not a nonempty PNG")
        if "![dialog-shot](assets/dialog-shot.png)" not in (docs / "index.md").read_text(encoding="utf-8"):
            raise RuntimeError("Desktop screenshot was not registered in the manual")

        original_docs = (docs / "index.md").read_bytes()
        original_image = (docs / "assets" / "dialog-shot.png").read_bytes()
        title = f"ModuleLoom desktop entry {os.getpid()}"
        steps = [
            {"launch": {"program": "timeout", "args": ["30", "zenity", "--entry", f"--title={title}", "--text=Name"]}},
            {"window": f"app:zenity::{title}"},
            {"fill": {"selector": "text_field", "value": "Ada"}},
            {"expect_value": {"selector": "text_field", "value": "Ada"}},
            {"screenshot": {"task": "dialog-shot", "selector": "text_field"}},
            {"press": "button[name='OK']"},
            # Keep the runner alive until zenity has written the entry to stdout.
            {"wait_ms": 250},
        ]
        scenario = root / "scenario.json"
        scenario.write_text(
            json.dumps({"version": 1, "platform": "desktop", "steps": steps}),
            encoding="utf-8",
        )
        result = subprocess.run(
            [str(analyzer), "--manual", "scenario-test", "--root", str(root), "--input", "scenario.json"],
            capture_output=True, text=True, encoding="utf-8", env=environment,
            timeout=70, check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(f"Desktop input scenario failed:\n{result.stdout}\n{result.stderr}")
        if json.loads(result.stdout) != {"captured": ["dialog-shot"], "steps": len(steps)}:
            raise RuntimeError(f"Application output corrupted scenario JSON: {result.stdout}")
        if (docs / "index.md").read_bytes() != original_docs or (docs / "assets" / "dialog-shot.png").read_bytes() != original_image:
            raise RuntimeError("scenario-test changed the manual or registered screenshot")

        title = f"ModuleLoom desktop failure {os.getpid()}"
        steps = [
            {"launch": {"program": "timeout", "args": ["15", "zenity", "--info", f"--title={title}", "--text=Failure isolation"]}},
            {"window": title},
            {"screenshot": {"task": "dialog-shot", "selector": "button[name='OK']"}},
            {"press": "button[name='Missing control']"},
        ]
        scenario.write_text(
            json.dumps({"version": 1, "platform": "desktop", "steps": steps}),
            encoding="utf-8",
        )
        result = subprocess.run(
            [str(analyzer), "--manual", "scenario-run", "--root", str(root), "--input", "scenario.json"],
            capture_output=True, text=True, encoding="utf-8", env=environment,
            timeout=70, check=False,
        )
        if result.returncode == 0 or "step 4 (press) failed" not in result.stderr:
            raise RuntimeError(f"Missing control did not report its failing step: {result.stderr}")
        if (docs / "index.md").read_bytes() != original_docs or (docs / "assets" / "dialog-shot.png").read_bytes() != original_image:
            raise RuntimeError("Failed scenario changed the manual or registered screenshot")
        print("Desktop accessibility scenario passed")


if __name__ == "__main__":
    main()
