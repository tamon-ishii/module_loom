#!/usr/bin/env python3
"""Scan and render ModuleLoom manual templates; the agent supplies the answers."""

from __future__ import annotations

import argparse
import base64
from datetime import datetime, timezone
import hashlib
import importlib.util
import json
import queue
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile
import threading

DEFAULT_BRIEF = "# マニュアル作成の指示\n\n## 対象読者\n\n## 目的\n\n## 含める操作\n\n## 追加の指示\n"


TASK = re.compile(
    r"<!-- ai:task id=(?P<id>[a-z][a-z0-9-]*) kind=(?P<kind>text|screenshot|diagram)\n"
    r"(?P<prompt>.*?)\n-->",
    re.DOTALL,
)
GENERATED = re.compile(
    r"<!-- ai:generated id=(?P<id>[a-z][a-z0-9-]*) kind=(?P<kind>text|screenshot|diagram)"
    r"(?: created-at=(?P<created>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))?"
    r"(?: source-sha256=(?P<hash>[a-f0-9]{64}))?"
    r"(?: approved-at=(?P<approved>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))? -->\n"
    r"(?P<body>.*?)\n<!-- /ai:generated -->",
    re.DOTALL,
)
ANSWER = re.compile(
    r"\A<!-- ai:answer id=(?P<id>[a-z][a-z0-9-]*) "
    r"source-sha256=(?P<hash>[a-f0-9]{64}) "
    r"created-at=(?P<created>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)"
    r"(?: approved-at=(?P<approved>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z))? -->\n"
    r"(?P<body>.*)\Z",
    re.DOTALL,
)


def utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def source_hash(kind: str, prompt: str) -> str:
    return hashlib.sha256(f"{kind}\n{prompt}".encode("utf-8")).hexdigest()


def tasks(templates: Path) -> list[dict[str, object]]:
    if not templates.is_dir():
        raise ValueError(f"Template directory is missing: {templates}")
    found: list[dict[str, object]] = []
    ids: set[str] = set()
    for page in sorted(templates.rglob("*.md")):
        content = page.read_text(encoding="utf-8")
        # 1. 未生成の指示タグ (ai:task)
        for match in TASK.finditer(content):
            task_id = match.group("id")
            if task_id in ids:
                raise ValueError(f"Duplicate task ID: {task_id}")
            ids.add(task_id)
            prompt = match.group("prompt").strip()
            if not prompt:
                raise ValueError(f"Empty instruction: {task_id}")
            kind = match.group("kind")
            found.append({
                "id": task_id,
                "kind": kind,
                "page": page.relative_to(templates).as_posix(),
                "prompt": prompt,
                "source_sha256": source_hash(kind, prompt),
                "status": "missing",
            })
        # 2. AI生成済みのタグ (ai:generated)
        for match in GENERATED.finditer(content):
            task_id = match.group("id")
            if task_id in ids:
                raise ValueError(f"Duplicate task ID: {task_id}")
            ids.add(task_id)
            kind = match.group("kind")
            approved = match.group("approved")
            found.append({
                "id": task_id,
                "kind": kind,
                "page": page.relative_to(templates).as_posix(),
                "prompt": f"AI生成コンテンツ ({kind})",
                "source_sha256": match.group("hash") or "",
                "status": "approved" if approved else "current",
            })
    return found


def read_answer(path: Path, task: dict[str, object]) -> tuple[str, str, str | None]:
    match = ANSWER.fullmatch(path.read_text(encoding="utf-8"))
    if match is None or match.group("id") != task["id"]:
        raise ValueError(f"Invalid answer header: {path}")
    if match.group("hash") != task["source_sha256"]:
        raise ValueError(f"Stale answer for {task['id']}; record it again after reviewing the instruction")
    body = match.group("body").strip()
    if not body:
        raise ValueError(f"Empty answer: {path}")
    return match.group("created"), body, match.group("approved")


def scan_entries(templates: Path, generated: Path) -> list[dict[str, object]]:
    if not templates.is_dir():
        return []
    entries = tasks(templates)
    for task in entries:
        # 既に docs 内で ai:generated になっている場合はそのステータスを優先
        if task.get("status") in ("approved", "current"):
            continue
        answer = generated / "answers" / f"{task['id']}.md"
        if not answer.exists():
            task["status"] = "missing"
        else:
            try:
                _, _, approved = read_answer(answer, task)
                task["status"] = "approved" if approved else "current"
            except ValueError:
                task["status"] = "stale"
    return entries


def scan(templates: Path, generated: Path) -> None:
    print(json.dumps(scan_entries(templates, generated), ensure_ascii=False, indent=2))


def config_path(root: Path) -> Path:
    return root / "manual" / "config.json"


def read_config(root: Path) -> dict[str, object]:
    path = config_path(root)
    default_mkdocs = {
        "site_name": "ModuleLoom マニュアル",
        "theme": "material",
        "language": "ja",
        "use_directory_urls": False,
    }
    if not path.is_file():
        return {
            "docs": "docs",
            "output": "manual",
            "format": "mkdocs",
            "agent": "codex",
            "model": "",
            "mkdocs": default_mkdocs,
        }
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        data = {}
    if not isinstance(data, dict):
        data = {}
    doc_format = str(data.get("format", "mkdocs"))
    agent = str(data.get("agent", "codex"))
    if agent not in ("codex", "claude", "grok", "agy"):
        agent = "codex"
    mkdocs_cfg = data.get("mkdocs")
    if not isinstance(mkdocs_cfg, dict):
        mkdocs_cfg = default_mkdocs
    else:
        mkdocs_cfg = {
            "site_name": str(mkdocs_cfg.get("site_name", default_mkdocs["site_name"])),
            "theme": str(mkdocs_cfg.get("theme", default_mkdocs["theme"])),
            "language": str(mkdocs_cfg.get("language", default_mkdocs["language"])),
            "use_directory_urls": bool(mkdocs_cfg.get("use_directory_urls", default_mkdocs["use_directory_urls"])),
        }
    return {
        "docs": str(data.get("docs", "docs")),
        "output": str(data.get("output", "manual")),
        "format": doc_format,
        "agent": agent,
        "model": str(data.get("model", "")),
        "mkdocs": mkdocs_cfg,
    }


def project_path(root: Path, value: str) -> Path:
    path = (root / value).resolve()
    if not path.is_relative_to(root.resolve()):
        raise ValueError(f"Manual path must stay inside the project: {value}")
    return path


def render_page_markdown(templates: Path, generated: Path, page_rel: Path, draft: bool = True) -> str:
    page_path = templates / page_rel
    if not page_path.is_file():
        raise ValueError(f"Preview page is missing: {page_rel}")
    content = page_path.read_text(encoding="utf-8")
    entries = tasks(templates)
    answers: dict[str, tuple[str, str, str | None]] = {}
    for task in entries:
        answer_path = generated / "answers" / f"{task['id']}.md"
        if not answer_path.is_file():
            continue
        try:
            answers[task["id"]] = read_answer(answer_path, task)
        except ValueError:
            pass

    built_at = utc_now()

    def replace(match: re.Match[str]) -> str:
        task_id = match.group("id")
        if task_id not in answers:
            return f"> **作成待ち:** `{task_id}` ({match.group('kind')})"
        created, body, approved = answers[task_id]
        digest = source_hash(match.group("kind"), match.group("prompt").strip())
        return (
            f"<!-- ai:generated id={task_id} kind={match.group('kind')} "
            f"created-at={created} source-sha256={digest}"
            f"{f' approved-at={approved}' if approved else ''} -->\n"
            f"{body}\n<!-- /ai:generated -->"
        )

    return TASK.sub(replace, content).replace("{{BUILD_TIMESTAMP}}", built_at)


def inline_html_assets(output: Path, html_text: str) -> str:
    def replace_css(match: re.Match[str]) -> str:
        css_href = match.group("href")
        clean = css_href.split("?")[0].split("#")[0]
        clean_rel = re.sub(r"^(\.\/|\.\.\/)+", "", clean)
        css_path = (output / clean_rel).resolve()
        if not css_path.is_file():
            name = Path(clean).name
            candidates = list(output.rglob(name))
            if candidates:
                css_path = candidates[0]
        if css_path.is_file():
            try:
                css_content = css_path.read_text(encoding="utf-8")
                return f"<style>/* inlined {css_href} */\n{css_content}\n</style>"
            except Exception:
                pass
        return match.group(0)

    css_pattern = re.compile(r'<link\s+[^>]*rel=["\']stylesheet["\'][^>]*href=["\'](?P<href>[^"\']+)["\'][^>]*>', re.IGNORECASE)
    html_text = css_pattern.sub(replace_css, html_text)

    def replace_img(match: re.Match[str]) -> str:
        src = match.group("src")
        clean = src.split("?")[0].split("#")[0]
        clean_rel = re.sub(r"^(\.\/|\.\.\/)+", "", clean)
        img_path = (output / clean_rel).resolve()
        if not img_path.is_file():
            name = Path(clean).name
            candidates = list(output.rglob(name))
            if candidates:
                img_path = candidates[0]
        if img_path.is_file():
            mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".svg": "image/svg+xml"}.get(img_path.suffix.lower())
            if mime and img_path.stat().st_size < 10_000_000:
                try:
                    b64 = base64.b64encode(img_path.read_bytes()).decode("ascii")
                    return match.group(0).replace(src, f"data:{mime};base64,{b64}")
                except Exception:
                    pass
        return match.group(0)

    img_pattern = re.compile(r'<img\s+[^>]*src=["\'](?P<src>[^"\']+)["\'][^>]*>', re.IGNORECASE)
    html_text = img_pattern.sub(replace_img, html_text)

    nav_script = (
        "<script>\n"
        "document.addEventListener('click', function(e) {\n"
        "  var a = e.target.closest('a');\n"
        "  if (!a) return;\n"
        "  var href = a.getAttribute('href');\n"
        "  if (!href) return;\n"
        "  if (href.startsWith('#')) return;\n"
        "  e.preventDefault();\n"
        "  if (/^(https?:)?\\/\\//i.test(href) || href.startsWith('mailto:')) {\n"
        "    window.open(a.href, '_blank');\n"
        "  } else {\n"
        "    window.parent.postMessage({ type: 'moduleloom_manual_navigate', href: href }, '*');\n"
        "  }\n"
        "});\n"
        "</script>\n"
    )
    if "</body>" in html_text:
        html_text = html_text.replace("</body>", f"{nav_script}</body>")
    else:
        html_text += nav_script

    return html_text


def state(root: Path) -> None:
    config = read_config(root)
    templates = project_path(root, str(config["docs"]))
    generated = root / "manual" / "ai"
    output = project_path(root, str(config["output"]))
    brief = root / "manual" / "brief.md"
    pages = [page.relative_to(templates).as_posix() for page in sorted(templates.rglob("*.md"))] if templates.is_dir() else []
    preview = ""
    if templates.is_dir() and (templates / "index.md").is_file():
        try:
            preview = render_page_markdown(templates, generated, Path("index.md"))
        except Exception:
            preview = (templates / "index.md").read_text(encoding="utf-8")

    preview_html_content = ""
    index_html = output / "index.html"
    if not index_html.is_file() and templates.is_dir() and any(templates.rglob("*.md")):
        try:
            build(templates, generated, output, draft=True, root=root)
        except Exception:
            pass
    if index_html.is_file():
        try:
            preview_html_content = inline_html_assets(output, index_html.read_text(encoding="utf-8"))
        except Exception:
            pass

    print(json.dumps({
        "config": config,
        "agents": [{"id": agent, "label": label, "available": shutil.which(command) is not None} for agent, label, command in (("codex", "Codex", "codex"), ("claude", "Claude Code", "claude"), ("grok", "Grok Build", "grok"), ("agy", "Agy", "agy"))],
        "brief": brief.read_text(encoding="utf-8") if brief.is_file() else DEFAULT_BRIEF,
        "tasks": scan_entries(templates, generated),
        "pages": pages,
        "preview": preview,
        "preview_html": preview_html_content,
        "has_html": bool(preview_html_content),
    }, ensure_ascii=False))


def preview_page(root: Path, page: str) -> None:
    config = read_config(root)
    templates = project_path(root, str(config["docs"]))
    generated = root / "manual" / "ai"
    target = project_path(templates, page)
    if target.suffix != ".md" or not target.is_file():
        raise ValueError(f"Preview page is missing: {page}")
    print(render_page_markdown(templates, generated, Path(page)))


def preview_html(root: Path, page: str) -> None:
    config = read_config(root)
    templates = project_path(root, str(config["docs"]))
    generated = root / "manual" / "ai"
    output = project_path(root, str(config["output"]))
    page_rel = Path(page)
    if page_rel.suffix == ".md":
        page_rel = page_rel.with_suffix(".html")
    target = output / page_rel
    if not target.is_file():
        dir_target = output / page_rel.parent / page_rel.stem / "index.html"
        if dir_target.is_file():
            target = dir_target
    if not target.is_file():
        try:
            build(templates, generated, output, draft=True, root=root)
        except Exception:
            pass
        if not target.is_file():
            dir_target = output / page_rel.parent / page_rel.stem / "index.html"
            if dir_target.is_file():
                target = dir_target
    if not target.is_file():
        raise ValueError(f"HTML page is missing: {page}. Please build the manual first.")
    print(inline_html_assets(output, target.read_text(encoding="utf-8")))


def preview_asset(root: Path, page: str, asset: str) -> None:
    config = read_config(root)
    templates = project_path(root, config["docs"])
    generated = root / "manual" / "ai"
    page_path = project_path(templates, page)
    candidate_paths = [
        (page_path.parent / asset).resolve(),
        (templates / "assets" / Path(asset).name).resolve(),
        (templates / asset).resolve(),
        (generated / "assets" / Path(asset).name).resolve(),
    ]
    image = None
    for candidate in candidate_paths:
        if candidate.is_file():
            image = candidate
            break
    if image is None:
        raise ValueError("Preview image is missing")
    mime = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp"}.get(image.suffix.lower())
    if mime is None or image.stat().st_size > 10_000_000:
        raise ValueError("Unsupported preview image")
    print(f"data:{mime};base64,{base64.b64encode(image.read_bytes()).decode('ascii')}")


def models(root: Path, agent: str) -> None:
    if agent == "claude":
        print(json.dumps({"models": [], "message": "Claude Code CLI はモデル一覧コマンドを提供していません。モデルIDを入力するか既定モデルを使ってください"}, ensure_ascii=False))
        return
    command = {"agy": "agy", "grok": "grok", "codex": "codex"}.get(agent)
    if command is None or shutil.which(command) is None:
        raise ValueError(f"AI CLI is unavailable: {command or agent}")
    found: list[dict[str, str]] = []
    if agent == "codex":
        process = subprocess.Popen(["codex", "app-server"], cwd=root, stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, bufsize=1)
        responses: queue.Queue[dict[str, object]] = queue.Queue()
        def read_responses() -> None:
            assert process.stdout is not None
            for line in process.stdout:
                try:
                    item = json.loads(line)
                    if item.get("id") == 2:
                        responses.put(item)
                        return
                except json.JSONDecodeError:
                    continue
        reader = threading.Thread(target=read_responses, daemon=True)
        reader.start()
        try:
            assert process.stdin is not None
            for message in (
                {"id": 1, "method": "initialize", "params": {"clientInfo": {"name": "moduleloom", "version": "1.0.6"}, "capabilities": {}}},
                {"method": "initialized", "params": {}},
                {"id": 2, "method": "model/list", "params": {"limit": 100}},
            ):
                process.stdin.write(json.dumps(message) + "\n")
                process.stdin.flush()
            response = responses.get(timeout=10)
            if "error" in response:
                raise ValueError(str(response["error"]))
            payload = response.get("result")
            if not isinstance(payload, dict):
                raise ValueError("Codex model/list returned no result")
            for item in payload.get("data", []):
                if not item.get("hidden"):
                    found.append({"id": item["model"], "label": item.get("displayName", item["model"])})
        except queue.Empty as error:
            raise ValueError("Codex model/list timed out") from error
        finally:
            process.kill()
            process.wait()
    else:
        result = subprocess.run([command, "models"], cwd=root, capture_output=True, text=True, check=False, timeout=15)
        if result.returncode != 0:
            raise ValueError((result.stderr or result.stdout).strip())
        for line in result.stdout.splitlines():
            match = re.match(r"^\s*([a-z][a-zA-Z0-9._-]*)\s+(.+)$", line)
            if match:
                found.append({"id": match.group(1), "label": match.group(2).strip()})
    print(json.dumps({"models": found, "message": ""}, ensure_ascii=False))


def save_settings(root: Path, docs: str, output: str, brief: str, agent: str, model: str, doc_format: str = "mkdocs", mkdocs_raw: str = "") -> None:
    docs_path = project_path(root, docs)
    output_path = project_path(root, output)
    if docs_path == output_path or docs_path.is_relative_to(output_path) or output_path.is_relative_to(docs_path):
        raise ValueError("Template and output directories must be separate")
    if not brief.strip():
        raise ValueError("Draft instructions are empty")
    if agent not in ("codex", "claude", "grok", "agy"):
        raise ValueError(f"Unsupported AI agent: {agent}")
    if len(model) > 120 or "\n" in model:
        raise ValueError("Invalid model ID")
    mkdocs_cfg = {
        "site_name": "ModuleLoom マニュアル",
        "theme": "material",
        "language": "ja",
        "use_directory_urls": False,
    }
    if mkdocs_raw:
        try:
            parsed = json.loads(mkdocs_raw)
            if isinstance(parsed, dict):
                mkdocs_cfg.update(parsed)
        except Exception:
            pass
    config = {
        "docs": docs_path.relative_to(root.resolve()).as_posix(),
        "output": output_path.relative_to(root.resolve()).as_posix(),
        "format": doc_format,
        "agent": agent,
        "model": model.strip(),
        "mkdocs": mkdocs_cfg,
    }
    destination = config_path(root)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps(config, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    (root / "manual" / "brief.md").write_text(brief.rstrip() + "\n", encoding="utf-8")
    state(root)


def agent_json(root: Path, prompt: str, schema: dict[str, object], agent: str, model: str) -> dict[str, object]:
    with tempfile.TemporaryDirectory() as directory:
        schema_path = Path(directory) / "schema.json"
        answer_path = Path(directory) / "answer.json"
        schema_path.write_text(json.dumps(schema), encoding="utf-8")
        if agent == "codex":
            command = ["codex", "exec", "--ephemeral", "--skip-git-repo-check", "--sandbox", "read-only",
                       "--cd", str(root), "--output-schema", str(schema_path), "--output-last-message", str(answer_path), prompt]
        elif agent == "claude":
            command = ["claude", "-p", "--output-format", "json", "--json-schema", json.dumps(schema),
                       "--restricted", "--no-session-persistence", prompt]
        elif agent == "grok":
            command = ["grok", "--no-auto-update", "-p", prompt + "\nReturn a JSON object only, matching this schema: " + json.dumps(schema),
                       "--cwd", str(root), "--output-format", "json", "--tools", "read_file,grep,list_dir", "--no-subagents"]
        elif agent == "agy":
            command = ["agy", "-p", prompt, "--output-format", "json", "--json-schema", json.dumps(schema), "--sandbox"]
        else:
            raise ValueError(f"Unsupported AI agent: {agent}")
        if model:
            command[1:1] = ["--model", model]
        if shutil.which(command[0]) is None:
            raise ValueError(f"AI CLI is unavailable: {command[0]}")
        result = subprocess.run(command, cwd=root, capture_output=True, text=True, check=False, timeout=600)
        if result.returncode != 0:
            raise ValueError(f"{agent} failed: {(result.stderr or result.stdout).strip()[-2000:]}")
        if agent == "codex":
            return json.loads(answer_path.read_text(encoding="utf-8"))
        response = json.loads(result.stdout)
        if agent == "grok":
            return json.loads(response.get("text", ""))
        if agent == "agy":
            if response.get("status") != "SUCCESS":
                raise ValueError(str(response.get("error", "Agy failed")))
            structured = response.get("structured_output")
            return structured if isinstance(structured, dict) else json.loads(response.get("response", ""))
        structured = response.get("structured_output")
        if isinstance(structured, dict):
            return structured
        return json.loads(response.get("result", ""))


def draft(root: Path) -> None:
    config = read_config(root)
    templates = project_path(root, str(config["docs"]))
    if templates.is_dir() and any(templates.rglob("*.md")):
        backup_dir = root / "manual" / ".backup" / utc_now().replace(":", "-")
        backup_dir.mkdir(parents=True, exist_ok=True)
        for old_file in templates.rglob("*.md"):
            dest_backup = backup_dir / old_file.relative_to(templates)
            dest_backup.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(old_file, dest_backup)
    brief_file = root / "manual" / "brief.md"
    if not brief_file.is_file():
        brief_file.parent.mkdir(parents=True, exist_ok=True)
        brief_file.write_text(DEFAULT_BRIEF, encoding="utf-8")
    brief = brief_file.read_text(encoding="utf-8")
    draft_prompt = (
        "Read the project and this manual brief. Create an initial Japanese MkDocs manual outline as JSON pages. "
        "Use Markdown files, with index.md required. "
        "Insert unique <!-- ai:task id=... kind=text|screenshot|diagram\\n...\\n--> tags for work requiring AI or real screenshots. "
        "IMPORTANT RULES FOR TASKS & LAYOUT:\n"
        "- In the top page (index.md), place the overview/key-visual screenshot prominently near the top (immediately following the introduction paragraph), so readers see what the product looks like first. Place table of contents and page navigation links BELOW the overview.\n"
        "- kind=screenshot tasks must ONLY request capturing the raw UI image (no descriptions, explanations, or annotations in the screenshot task itself).\n"
        "- kind=diagram tasks must ONLY request generating the pure Mermaid dependency graph via ModuleLoom CLI.\n"
        "- If an explanation, annotation, walkthrough, or caption of a screenshot or diagram is needed, create a separate dedicated kind=text task directly before or after it.\n"
        "Do not invent UI labels. Return at most 8 pages. Brief:\n" + brief
    )
    result = agent_json(root, draft_prompt, schema, str(config["agent"]), str(config["model"]))
    pages = result.get("pages")
    if not isinstance(pages, list) or not pages or len(pages) > 8:
        raise ValueError(f"{config['agent']} returned an invalid page list")
    validated = []
    for page in pages:
        if not isinstance(page, dict) or not isinstance(page.get("content"), str):
            raise ValueError(f"{config['agent']} returned an invalid page")
        relative = Path(str(page.get("path", "")))
        if relative.is_absolute() or ".." in relative.parts or relative.suffix != ".md" or not relative.parts:
            raise ValueError(f"Invalid draft page path: {relative}")
        validated.append((relative, page["content"]))
    if not any(path.as_posix() == "index.md" for path, _ in validated):
        raise ValueError(f"{config['agent']} draft must include index.md")
    templates.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory() as directory:
        staged = Path(directory)
        digest = hashlib.sha256(brief.encode("utf-8")).hexdigest()
        for relative, content in validated:
            destination = staged / relative
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(
                f"<!-- ai:draft created-at={utc_now()} agent={config['agent']} brief-sha256={digest} -->\n"
                f"{content.rstrip()}\n<!-- /ai:draft -->\n", encoding="utf-8",
            )
        tasks(staged)
        for source in staged.rglob("*.md"):
            destination = templates / source.relative_to(staged)
            destination.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(source, destination)
    # たたき台作成後、自動で下書きサイトをビルドして HTML プレビューを即座に利用可能にする
    try:
        output_dir = project_path(root, str(config["output"]))
        build(templates, root / "manual" / "ai", output_dir, draft=True, root=root)
    except Exception as build_err:
        print(f"Warning: Automatic draft site build: {build_err}", file=sys.stderr)
    state(root)


def update_task_in_docs(templates: Path, task: dict[str, object], body: str, approved: str | None = None) -> None:
    page_rel = Path(str(task["page"]))
    page_path = templates / page_rel
    if not page_path.is_file():
        raise ValueError(f"Page file not found: {page_path}")
    content = page_path.read_text(encoding="utf-8")
    task_id = str(task["id"])
    kind = str(task["kind"])
    created = utc_now()
    hash_val = str(task.get("source_sha256", ""))
    approved_attr = f" approved-at={approved}" if approved else ""
    hash_attr = f" source-sha256={hash_val}" if hash_val else ""

    replacement = (
        f"<!-- ai:generated id={task_id} kind={kind} created-at={created}{hash_attr}{approved_attr} -->\n"
        f"{body.strip()}\n<!-- /ai:generated -->"
    )

    task_pattern = re.compile(
        rf"<!-- ai:task id={re.escape(task_id)} kind={kind}\n.*?\n-->",
        re.DOTALL,
    )
    if task_pattern.search(content):
        new_content = task_pattern.sub(replacement, content, count=1)
        page_path.write_text(new_content, encoding="utf-8")
        return

    gen_pattern = re.compile(
        rf"<!-- ai:generated id={re.escape(task_id)} kind={kind}.*?-->\n.*?\n<!-- /ai:generated -->",
        re.DOTALL,
    )
    if gen_pattern.search(content):
        new_content = gen_pattern.sub(replacement, content, count=1)
        page_path.write_text(new_content, encoding="utf-8")
        return

    page_path.write_text(content.rstrip() + "\n\n" + replacement + "\n", encoding="utf-8")


def generate_task(root: Path, task_id: str, cli: str, feedback: str = "") -> None:
    config = read_config(root)
    templates = project_path(root, str(config["docs"]))
    generated = root / "manual" / "ai"
    task = find_task(templates, task_id)
    if task.get("status") == "approved" and not feedback:
        raise ValueError(f"Approved task is locked: {task_id}. Edit the markdown file directly or provide feedback to revise it")
    if task["kind"] == "screenshot":
        raise ValueError("Screenshot tasks require a real captured image; use the manual skill in an interactive agent")
    if task["kind"] == "diagram":
        record_diagram(templates, generated, task_id, cli, root)
        return
    
    prompt = (
        f"Read the project and answer this manual task in concise, professional Japanese Markdown. "
        f"Verify UI names from source. Return only the pure documentation content. "
        f"Do not include meta notes, disclaimers, notes about AI generation, or source attributions.\n"
        f"Task ID: {task_id}\nInstruction: {task['prompt']}"
    )
    answer_path = generated / "answers" / f"{task_id}.md"
    if answer_path.is_file():
        try:
            _, prev_body, _ = read_answer(answer_path, task)
            if prev_body.strip():
                prompt += f"\n\nPrevious draft for reference:\n```markdown\n{prev_body.strip()}\n```"
        except Exception:
            pass
    if feedback.strip():
        prompt += f"\n\nUser revision instruction / feedback:\n{feedback.strip()}\nPlease address this feedback directly in your response."

    schema: dict[str, object] = {"type": "object", "properties": {"markdown": {"type": "string"}}, "required": ["markdown"], "additionalProperties": False}
    result = agent_json(root, prompt, schema, str(config["agent"]), str(config["model"]))
    body = str(result.get("markdown", "")).strip()
    if not body:
        raise ValueError("AI agent returned an empty answer")
    update_task_in_docs(templates, task, body)
    save_answer(generated, task, body)


def save_answer(generated: Path, task: dict[str, object], body: str) -> None:
    task_id = str(task["id"])
    body = body.strip()
    if not body:
        raise ValueError("Answer body is empty")
    destination = generated / "answers" / f"{task_id}.md"
    destination.parent.mkdir(parents=True, exist_ok=True)
    header = (
        f"<!-- ai:answer id={task_id} source-sha256={task.get('source_sha256', '')} "
        f"created-at={utc_now()} -->\n"
    )
    destination.write_text(f"{header}{body}\n", encoding="utf-8")


def approve(templates: Path, generated: Path, task_id: str) -> None:
    task = find_task(templates, task_id)
    page_rel = Path(str(task["page"]))
    page_path = templates / page_rel
    content = page_path.read_text(encoding="utf-8")
    now = utc_now()
    pattern = re.compile(
        rf"<!-- ai:generated id={re.escape(task_id)} kind={task['kind']}(?P<attrs>.*?) -->\n(?P<body>.*?)\n<!-- /ai:generated -->",
        re.DOTALL,
    )
    m = pattern.search(content)
    if m:
        attrs = m.group("attrs")
        if "approved-at=" not in attrs:
            attrs = f"{attrs} approved-at={now}"
        else:
            attrs = re.sub(r"approved-at=\S+", f"approved-at={now}", attrs)
        replacement = f"<!-- ai:generated id={task_id} kind={task['kind']}{attrs} -->\n{m.group('body')}\n<!-- /ai:generated -->"
        page_path.write_text(pattern.sub(replacement, content, count=1), encoding="utf-8")

    answer_path = generated / "answers" / f"{task_id}.md"
    if answer_path.is_file():
        try:
            created, body, _ = read_answer(answer_path, task)
            answer_path.write_text(
                f"<!-- ai:answer id={task_id} source-sha256={task.get('source_sha256', '')} created-at={created} approved-at={now} -->\n{body}\n",
                encoding="utf-8",
            )
        except Exception:
            pass


def find_task(templates: Path, task_id: str) -> dict[str, object]:
    matches = [task for task in tasks(templates) if task["id"] == task_id]
    if not matches:
        raise ValueError(f"Unknown task ID: {task_id}")
    return matches[0]


def record(templates: Path, generated: Path, task_id: str, body_path: Path) -> None:
    task = find_task(templates, task_id)
    body = body_path.read_text(encoding="utf-8")
    update_task_in_docs(templates, task, body)
    save_answer(generated, task, body)


def record_screenshot(root: Path, task_id: str, image: Path) -> None:
    config = read_config(root)
    templates = project_path(root, str(config["docs"]))
    task = find_task(templates, task_id)
    if task["kind"] != "screenshot":
        raise ValueError(f"Task is not a screenshot: {task_id}")
    image = image.resolve()
    if image.suffix.lower() != ".png" or not image.is_file():
        raise ValueError("Screenshot must be a PNG file")

    docs_assets = templates / "assets"
    docs_assets.mkdir(parents=True, exist_ok=True)
    dest_image = docs_assets / image.name
    if dest_image != image:
        shutil.copy2(image, dest_image)

    legacy_assets = root / "manual" / "ai" / "assets"
    legacy_assets.mkdir(parents=True, exist_ok=True)
    if (legacy_assets / image.name) != image:
        shutil.copy2(image, legacy_assets / image.name)

    page_depth = len(Path(str(task["page"])).parts) - 1
    asset_path = "../" * page_depth + f"assets/{image.name}"
    alt_text = str(task.get("id", "screenshot"))
    body = f"![{alt_text}]({asset_path})"
    update_task_in_docs(templates, task, body)
    save_answer(root / "manual" / "ai", task, body)


def record_diagram(templates: Path, generated: Path, task_id: str, cli: str, project: Path) -> None:
    task = find_task(templates, task_id)
    if task["kind"] != "diagram":
        raise ValueError(f"Task is not a diagram: {task_id}")
    if not project.is_dir():
        raise ValueError(f"Diagram project is missing: {project}")
    with tempfile.TemporaryDirectory() as directory:
        output = Path(directory) / "moduleloom"
        result = subprocess.run(
            [cli, "--mkdocs", str(output), "--lang", "ja", str(project.resolve())],
            capture_output=True, text=True, check=False,
        )
        if result.returncode != 0:
            raise ValueError(f"ModuleLoom CLI failed: {result.stderr.strip()}")
        page = (output / "docs/index.md").read_text(encoding="utf-8")
    match = re.search(r"```mermaid\n(?P<diagram>.*?)\n```", page, re.DOTALL)
    if match is None:
        raise ValueError("ModuleLoom CLI did not produce a Mermaid diagram")
    lines = [line for line in match.group("diagram").splitlines() if not line.lstrip().startswith("click ")]
    diagram = "\n".join(lines)
    body = f"```mermaid\n{diagram}\n```"
    update_task_in_docs(templates, task, body)
    save_answer(generated, task, body)


def build(templates: Path, generated: Path, output_root: Path, draft: bool, root: Path | None = None) -> None:
    entries = tasks(templates)
    answers: dict[str, tuple[str, str, str | None]] = {}
    for task in entries:
        if task.get("status") in ("approved", "current"):
            continue
        answer_path = generated / "answers" / f"{task['id']}.md"
        if not answer_path.is_file():
            if not draft:
                raise ValueError(f"Missing answer for {task['id']}: {answer_path}")
            continue
        try:
            answers[task["id"]] = read_answer(answer_path, task)
        except ValueError:
            if not draft:
                raise

    with tempfile.TemporaryDirectory() as temp_dir:
        temp_root = Path(temp_dir)
        temp_docs = temp_root / "docs"
        temp_docs.mkdir(parents=True, exist_ok=True)

        built_at = utc_now()
        for page in sorted(templates.rglob("*.md")):
            content = page.read_text(encoding="utf-8")

            def replace(match: re.Match[str]) -> str:
                task_id = match.group("id")
                if task_id not in answers:
                    return f"> **作成待ち:** `{task_id}` ({match.group('kind')})"
                created, body, approved = answers[task_id]
                digest = source_hash(match.group("kind"), match.group("prompt").strip())
                return (
                    f"<!-- ai:generated id={task_id} kind={match.group('kind')} "
                    f"created-at={created} source-sha256={digest}"
                    f"{f' approved-at={approved}' if approved else ''} -->\n"
                    f"{body}\n<!-- /ai:generated -->"
                )

            rendered = TASK.sub(replace, content).replace("{{BUILD_TIMESTAMP}}", built_at)
            destination = temp_docs / page.relative_to(templates)
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_text(rendered, encoding="utf-8")

        for source in templates.rglob("*"):
            if source.is_file() and source.suffix != ".md":
                destination = temp_docs / source.relative_to(templates)
                destination.parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(source, destination)

        assets = generated / "assets"
        if assets.is_dir():
            shutil.copytree(assets, temp_docs / "assets", dirs_exist_ok=True)

        mkdocs_cfg = {}
        if root is not None:
            config = read_config(root)
            mkdocs_cfg = config.get("mkdocs", {}) if isinstance(config.get("mkdocs"), dict) else {}
        site_name = str(mkdocs_cfg.get("site_name", "ModuleLoom マニュアル"))
        theme_name = str(mkdocs_cfg.get("theme", "material"))
        theme_lang = str(mkdocs_cfg.get("language", "ja"))
        use_dir_urls = bool(mkdocs_cfg.get("use_directory_urls", False))

        nav = "".join(f"  - {json.dumps(page.stem, ensure_ascii=False)}: {json.dumps(page.relative_to(templates).as_posix())}\n" for page in sorted(templates.rglob("*.md")))
        config_yaml = (
            f'site_name: {json.dumps(site_name, ensure_ascii=False)}\n'
            f'theme:\n  name: {theme_name}\n  language: {theme_lang}\n'
            f'use_directory_urls: {"true" if use_dir_urls else "false"}\n'
            f'site_dir: {json.dumps(str(output_root.resolve()), ensure_ascii=False)}\n'
            'markdown_extensions:\n'
            '  - pymdownx.superfences:\n'
            '      custom_fences:\n'
            '        - name: mermaid\n'
            '          class: mermaid\n'
            '          format: !!python/name:pymdownx.superfences.fence_code_format\n'
            'nav:\n' + nav
        )
        temp_config = temp_root / "mkdocs.yml"
        temp_config.write_text(config_yaml, encoding="utf-8")

        output_root.mkdir(parents=True, exist_ok=True)

        mkdocs_cmd = None
        venv_mkdocs = (root / ".venv/bin/mkdocs") if root else None
        if importlib.util.find_spec("mkdocs") is not None:
            mkdocs_cmd = [sys.executable, "-m", "mkdocs"]
        elif shutil.which("mkdocs") is not None:
            mkdocs_cmd = ["mkdocs"]
        elif venv_mkdocs and venv_mkdocs.is_file():
            mkdocs_cmd = [str(venv_mkdocs)]

        if mkdocs_cmd is not None:
            result = subprocess.run(
                mkdocs_cmd + ["build", "-f", str(temp_config), "-d", str(output_root.resolve())],
                capture_output=True, text=True, check=False, cwd=str(temp_root),
            )
            if result.returncode != 0:
                raise ValueError(f"MkDocs site build failed: {(result.stderr or result.stdout).strip()}")
            print(f"{output_root}\nSite: {output_root}")
        else:
            print(f"{output_root}\nMkDocs site build skipped: install mkdocs-material to generate HTML at {output_root}")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("scan", "state", "models", "preview-page", "preview-html", "preview-asset", "save", "draft", "generate-task", "approve", "record", "record-screenshot", "record-diagram", "build"))
    parser.add_argument("--root", type=Path, default=Path.cwd())
    parser.add_argument("--docs", type=Path, default=Path("docs"))
    parser.add_argument("--generated", type=Path, default=Path("manual/ai"))
    parser.add_argument("--output", type=Path, default=Path("manual"))
    parser.add_argument("--format", default="mkdocs")
    parser.add_argument("--mkdocs-settings", default="")
    parser.add_argument("--draft", action="store_true")
    parser.add_argument("--id")
    parser.add_argument("--page", default="index.md")
    parser.add_argument("--asset")
    parser.add_argument("--brief")
    parser.add_argument("--agent", choices=("codex", "claude", "grok", "agy"), default="codex")
    parser.add_argument("--model", default="")
    parser.add_argument("--body", type=Path)
    parser.add_argument("--image", type=Path)
    parser.add_argument("--cli", default="target/debug/analyze")
    parser.add_argument("--project", type=Path, default=Path("manual/fixtures/diagram_project"))
    parser.add_argument("--feedback", default="")
    args = parser.parse_args()
    templates = args.docs if args.docs.is_absolute() else args.root / args.docs
    generated = args.generated if args.generated.is_absolute() else args.root / args.generated
    output = args.output if args.output.is_absolute() else args.root / args.output
    try:
        if args.action in ("scan", "build"):
            config = read_config(args.root)
            templates = project_path(args.root, str(config["docs"]))
            output = project_path(args.root, str(config["output"]))
        if args.action == "scan":
            scan(templates, generated)
        elif args.action == "state":
            state(args.root)
        elif args.action == "models":
            models(args.root, args.agent)
        elif args.action == "preview-page":
            preview_page(args.root, args.page)
        elif args.action == "preview-html":
            preview_html(args.root, args.page)
        elif args.action == "preview-asset":
            if not args.asset:
                parser.error("preview-asset requires --asset")
            preview_asset(args.root, args.page, args.asset)
        elif args.action == "save":
            if args.brief is None:
                parser.error("save requires --brief")
            save_settings(args.root, str(args.docs), str(args.output), args.brief, args.agent, args.model, args.format, args.mkdocs_settings)
        elif args.action == "draft":
            draft(args.root)
        elif args.action == "generate-task":
            if not args.id:
                parser.error("generate-task requires --id")
            generate_task(args.root, args.id, str(args.cli), feedback=args.feedback)
        elif args.action == "approve":
            if not args.id:
                parser.error("approve requires --id")
            config = read_config(args.root)
            approve(project_path(args.root, str(config["docs"])), args.root / "manual" / "ai", args.id)
        elif args.action == "record":
            if not args.id or not args.body:
                parser.error("record requires --id and --body")
            record(templates, generated, args.id, args.body)
        elif args.action == "record-screenshot":
            if not args.id or not args.image:
                parser.error("record-screenshot requires --id and --image")
            record_screenshot(args.root, args.id, args.image)
        elif args.action == "record-diagram":
            if not args.id:
                parser.error("record-diagram requires --id")
            cli = Path(args.cli)
            if not cli.is_absolute() and cli.parent != Path("."):
                cli = args.root / cli
            project = args.project if args.project.is_absolute() else args.root / args.project
            record_diagram(templates, generated, args.id, str(cli), project)
        else:
            build(templates, generated, output, args.draft, root=args.root)
    except (OSError, ValueError, subprocess.TimeoutExpired, json.JSONDecodeError) as error:
        print(f"Manual build error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
