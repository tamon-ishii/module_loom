
"""Start the ModuleLoom desktop app from PyCharm's Run button."""

from __future__ import annotations

import argparse
import os
from pathlib import Path
import shutil
import signal
import subprocess
import sys


PROJECT_ROOT = Path(__file__).resolve().parent


def stage_local_jscpd() -> None:
    name = "jscpd.exe" if os.name == "nt" else "jscpd"
    executable = shutil.which(name)
    candidates = [
        PROJECT_ROOT / ".venv" / ("Scripts" if os.name == "nt" else "bin") / name,
        Path(executable) if executable is not None else None,
    ]
    for source in candidates:
        if source is None or not source.is_file():
            continue
        version = subprocess.run([str(source), "--version"], capture_output=True, text=True)
        if version.returncode != 0 or not version.stdout.strip().startswith("jscpd 5."):
            continue
        destination = PROJECT_ROOT / "src-tauri" / "binaries" / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        if source.resolve() != destination.resolve():
            shutil.copy2(source, destination)
        if os.name != "nt":
            destination.chmod(0o755)
        return


def main() -> int:
    parser = argparse.ArgumentParser(description="ModuleLoom デスクトップ版を起動します")
    parser.add_argument(
        "project_path",
        nargs="?",
        default="sample_project",
        help="最初に解析する Python プロジェクト（既定: sample_project）",
    )
    args = parser.parse_args()
    project_path = Path(args.project_path).expanduser()
    if not project_path.is_absolute():
        project_path = PROJECT_ROOT / project_path
    project_path = project_path.resolve()
    if not project_path.is_dir():
        print(f"解析対象のディレクトリが見つかりません: {project_path}", file=sys.stderr)
        return 2

    npm = shutil.which("npm")
    if npm is None:
        print("npm が見つかりません。Node.js をインストールしてください。", file=sys.stderr)
        return 1
    if not (PROJECT_ROOT / "node_modules").is_dir():
        print("依存パッケージがありません。プロジェクトで npm ci を一度実行してください。", file=sys.stderr)
        return 1

    stage_local_jscpd()
    print(f"ModuleLoom デスクトップ版を起動します: {project_path}", flush=True)
    environment = os.environ.copy()
    environment["MODULELOOM_INITIAL_PROJECT_PATH"] = str(project_path)
    process = subprocess.Popen(
        [npm, "run", "app"],
        cwd=PROJECT_ROOT,
        env=environment,
        start_new_session=os.name != "nt",
    )

    def stop_child(signum: int, _frame: object) -> None:
        if process.poll() is not None:
            return
        if os.name == "nt":
            process.terminate()
        else:
            os.killpg(process.pid, signal.SIGTERM)

    signal.signal(signal.SIGTERM, stop_child)
    signal.signal(signal.SIGINT, stop_child)
    try:
        return process.wait()
    finally:
        if process.poll() is None:
            stop_child(signal.SIGTERM, None)
            process.wait()


if __name__ == "__main__":
    sys.exit(main())
