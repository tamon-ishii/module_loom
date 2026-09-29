use regex::Regex;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;

use super::agent::agent_json;
use super::builder::build;
use super::config::{project_path, read_config, DEFAULT_BRIEF};
use super::task::{
    collect_markdown_files, find_task, read_answer, save_answer, update_task_in_docs, utc_now,
};

pub fn draft(root: &Path) -> Result<(), String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output = project_path(root, &config.output)?;

    if templates.is_dir() {
        let existing = collect_markdown_files(&templates);
        if !existing.is_empty() {
            let backup_dir = root
                .join("manual")
                .join(".backup")
                .join(utc_now().replace(':', "-"));
            fs::create_dir_all(&backup_dir).map_err(|e| e.to_string())?;
            for old_file in existing {
                let rel = old_file.strip_prefix(&templates).unwrap_or(&old_file);
                let dest = backup_dir.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(&old_file, &dest);
            }
        }
    }

    let brief_path = root.join("manual").join("brief.md");
    if !brief_path.is_file() {
        if let Some(parent) = brief_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        fs::write(&brief_path, DEFAULT_BRIEF).map_err(|e| e.to_string())?;
    }
    let brief = fs::read_to_string(&brief_path).map_err(|e| e.to_string())?;

    let app_context = super::context::build_application_context(root);

    let draft_prompt = format!(
        "Read the application context, AST module structure, UI Map, and manual brief below. \
        Create a comprehensive Japanese MkDocs manual outline as JSON pages for this specific application. \
        Use Markdown files, with index.md required. \
        Insert unique <!-- ai:task id=... kind=text|screenshot|diagram\\n...\\n--> tags for work requiring AI, real screenshots, or Mermaid diagrams.\n\
        IMPORTANT RULES FOR TASKS & LAYOUT:\n\
        - You MUST include at least one kind=screenshot ai:task in index.md. Do not omit it or replace it with a static image link. Put it immediately after the short introduction and before navigation.\n\
        - The screenshot task prompt must describe a real screen of the TARGET application and the controls that should be visible. It appears in ModuleLoom's 「更新対象アセット」 list, where the instruction can be copied for an agent with access to the target application and the resulting PNG can be registered.\n\
        - kind=screenshot tasks must describe only real screens of the target application. ModuleLoom can capture a selected window on Linux/X11, macOS, and Windows; Wayland uses the system screenshot chooser. A desktop scenario can launch and operate the target application on supported desktops. Do not request a screenshot of ModuleLoom or assume a DOM selector from ModuleLoom refers to the target application.\n\
        - kind=diagram tasks must ONLY request generating the pure Mermaid dependency graph via ModuleLoom CLI for key modules.\n\
        - If an explanation, annotation, walkthrough, or caption of a screenshot or diagram is needed, create a separate dedicated kind=text task directly before or after it.\n\
        - Design chapters directly matching the application's actual modules, UI features, and workflows.\n\
        - For each page, add an <!-- ai:audience user -->, <!-- ai:audience developer -->, or <!-- ai:audience maintainer --> directive when it serves one reader group; omit the directive for shared pages.\n\
        - Add <!-- ai:depends task=TASK_ID file=PROJECT_RELATIVE_PATH --> for known source-to-task links. Do not guess file paths.\n\
        - For workflows suitable for repeatable Web or desktop UI testing, describe the steps in the task prompt. A scenario file can later be linked with <!-- ai:scenario file=manual/scenarios/NAME.json -->.\n\
        Do not invent non-existent UI labels. Return at most 8 pages.\n\n\
        {}\n\n\
        Brief:\n{brief}",
        app_context.prompt_summary
    );

    let schema = json!({
        "type": "object",
        "properties": {
            "pages": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "path": {"type": "string"},
                        "content": {"type": "string"}
                    },
                    "required": ["path", "content"],
                    "additionalProperties": false
                }
            }
        },
        "required": ["pages"],
        "additionalProperties": false
    });

    let result = agent_json(root, &draft_prompt, &schema, &config.agent, &config.model)?;
    let pages = result
        .get("pages")
        .and_then(|p| p.as_array())
        .ok_or_else(|| format!("{} returned an invalid page list", config.agent))?;

    if pages.is_empty() || pages.len() > 8 {
        return Err(format!("{} returned an invalid page list", config.agent));
    }

    let mut validated = Vec::new();
    let mut has_index = false;

    for p in pages {
        let path_str = p.get("path").and_then(|v| v.as_str()).unwrap_or("");
        let content = p.get("content").and_then(|v| v.as_str()).unwrap_or("");
        let rel = Path::new(path_str);
        if rel.is_absolute()
            || path_str.contains("..")
            || rel.extension().map_or(true, |ext| ext != "md")
            || path_str.is_empty()
        {
            return Err(format!("Invalid draft page path: {path_str}"));
        }
        if path_str == "index.md" {
            has_index = true;
        }
        validated.push((path_str.to_string(), content.to_string()));
    }

    if !has_index {
        return Err(format!("{} draft must include index.md", config.agent));
    }

    fs::create_dir_all(&templates).map_err(|e| e.to_string())?;

    let tmp = tempdir().map_err(|e| e.to_string())?;
    let mut hasher = Sha256::new();
    hasher.update(brief.as_bytes());
    let digest = format!("{:x}", hasher.finalize());
    let now = utc_now();

    for (rel_path, content) in &validated {
        let dest = tmp.path().join(rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let wrapped = format!(
            "<!-- ai:draft created-at={now} agent={} brief-sha256={digest} -->\n{}\n<!-- /ai:draft -->\n",
            config.agent,
            content.trim_end()
        );
        fs::write(&dest, wrapped).map_err(|e| e.to_string())?;
    }

    // 書式チェック
    let generated_tasks = super::task::tasks(tmp.path())?;
    if !generated_tasks
        .iter()
        .any(|task| task.page == "index.md" && task.kind == "screenshot")
    {
        return Err(format!(
            "{} manual draft must include an index.md screenshot ai:task for the 更新対象アセット list",
            config.agent
        ));
    }

    for (rel_path, _) in &validated {
        let src = tmp.path().join(rel_path);
        let dest = templates.join(rel_path);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::copy(&src, &dest).map_err(|e| e.to_string())?;
    }

    // 自動で下書きサイトをビルド
    let _ = build(&templates, &generated, &output, true, Some(root));

    // UI Map と Manual Dependency Graph を自動構築・保存
    let _ = super::uimap::save_ui_map(root, &app_context.ui_map);
    let _ = super::deps::build_manual_dependency_graph(root, &templates);

    Ok(())
}

pub fn generate_task(root: &Path, task_id: &str, cli: &str, feedback: &str) -> Result<(), String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let task = find_task(&templates, task_id)?;

    if task.kind == "screenshot" {
        return Err("Screenshot tasks require a real captured image; use the manual skill in an interactive agent".to_string());
    }

    if task.kind == "diagram" {
        record_diagram(&templates, &generated, task_id, cli, root)?;
        return Ok(());
    }

    if task.status == "approved" && feedback.trim().is_empty() {
        return Err(format!(
            "Approved task is locked: {task_id}. Edit the markdown file directly or provide feedback to revise it"
        ));
    }

    let mut prompt = format!(
        "Read the project and answer this manual task in concise, professional Japanese Markdown. \
        Verify UI names from source. Return only the pure documentation content. \
        For concrete UI or source claims, add a compact HTML comment immediately after the claim in the form <!-- ai:fact {{\"claim\":\"...\",\"ui\":\"#actual-id\"}} --> or <!-- ai:fact {{\"claim\":\"...\",\"file\":\"relative/path\",\"contains\":\"actual source text\"}} -->. Use only evidence you verified; omit the comment when there is no evidence. \
        Do not include meta notes, disclaimers, notes about AI generation, or source attributions.\n\
        Task ID: {task_id}\nInstruction: {}",
        task.prompt
    );

    let answer_path = generated.join("answers").join(format!("{task_id}.md"));
    if answer_path.is_file() {
        if let Ok((_, prev_body, _)) = read_answer(&answer_path, &task) {
            if !prev_body.trim().is_empty() {
                prompt.push_str(&format!(
                    "\n\nPrevious draft for reference:\n```markdown\n{}\n```",
                    prev_body.trim()
                ));
            }
        }
    }

    if !feedback.trim().is_empty() {
        prompt.push_str(&format!(
            "\n\nUser revision instruction / feedback:\n{}\nPlease address this feedback directly in your response.",
            feedback.trim()
        ));
    }

    let schema = json!({
        "type": "object",
        "properties": {
            "markdown": {"type": "string"}
        },
        "required": ["markdown"],
        "additionalProperties": false
    });

    let result = agent_json(root, &prompt, &schema, &config.agent, &config.model)?;
    let body = result
        .get("markdown")
        .and_then(|m| m.as_str())
        .map(|s| s.trim())
        .ok_or_else(|| "AI agent returned an empty answer".to_string())?;

    if body.is_empty() {
        return Err("AI agent returned an empty answer".to_string());
    }

    super::fact::verify_generated_body(root, body)?;
    update_task_in_docs(&templates, &task, body, None)?;
    save_answer(&generated, &task, body)?;
    Ok(())
}

pub fn record_screenshot(root: &Path, task_id: &str, image: &Path) -> Result<(), String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let task = find_task(&templates, task_id)?;
    if task.kind != "screenshot" {
        return Err(format!("Task is not a screenshot: {task_id}"));
    }

    let abs_image = if image.is_absolute() {
        image.to_path_buf()
    } else {
        root.join(image)
    };

    let ext = abs_image
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if ext != "png" || !abs_image.is_file() {
        return Err("Screenshot must be a PNG file".to_string());
    }

    let file_name = abs_image
        .file_name()
        .ok_or("Invalid image filename")?
        .to_string_lossy()
        .into_owned();

    let docs_assets = templates.join("assets");
    fs::create_dir_all(&docs_assets).map_err(|e| e.to_string())?;
    let dest_image = docs_assets.join(&file_name);
    if dest_image != abs_image {
        fs::copy(&abs_image, &dest_image).map_err(|e| e.to_string())?;
    }

    let legacy_assets = root.join("manual").join("ai").join("assets");
    fs::create_dir_all(&legacy_assets).map_err(|e| e.to_string())?;
    let legacy_dest = legacy_assets.join(&file_name);
    if legacy_dest != abs_image {
        let _ = fs::copy(&abs_image, &legacy_dest);
    }

    let page_parts = Path::new(&task.page).components().count();
    let depth = if page_parts > 1 { page_parts - 1 } else { 0 };
    let prefix = "../".repeat(depth);
    let asset_path = if templates.join(&task.page).is_file() {
        format!("{prefix}assets/{file_name}")
    } else {
        let output = config.output.replace('\\', "/");
        format!("{prefix}{output}/assets/{file_name}")
    };
    let alt_text = &task.id;
    let body = format!("![{alt_text}]({asset_path})");

    update_task_in_docs(&templates, &task, &body, None)?;
    save_answer(&root.join("manual").join("ai"), &task, &body)?;
    Ok(())
}

pub fn record_diagram(
    templates: &Path,
    generated: &Path,
    task_id: &str,
    cli: &str,
    project: &Path,
) -> Result<(), String> {
    let task = find_task(templates, task_id)?;
    if task.kind != "diagram" {
        return Err(format!("Task is not a diagram: {task_id}"));
    }
    if !project.is_dir() {
        return Err(format!("Diagram project is missing: {}", project.display()));
    }

    let tmp = tempdir().map_err(|e| e.to_string())?;
    let output_dir = tmp.path().join("moduleloom");

    let status = Command::new(cli)
        .args([
            "--mkdocs",
            &output_dir.to_string_lossy(),
            "--lang",
            "ja",
            &project
                .canonicalize()
                .unwrap_or_else(|_| project.to_path_buf())
                .to_string_lossy(),
        ])
        .output()
        .map_err(|e| format!("ModuleLoom CLI failed to execute: {e}"))?;

    if !status.status.success() {
        let err = String::from_utf8_lossy(&status.stderr);
        return Err(format!("ModuleLoom CLI failed: {}", err.trim()));
    }

    let page = fs::read_to_string(output_dir.join("docs").join("index.md"))
        .map_err(|e| format!("ModuleLoom CLI docs/index.md not found: {e}"))?;

    let re = Regex::new(r"(?s)```mermaid\n(?P<diagram>.*?)\n```").unwrap();
    let cap = re
        .captures(&page)
        .ok_or_else(|| "ModuleLoom CLI did not produce a Mermaid diagram".to_string())?;

    let diagram_raw = cap.name("diagram").unwrap().as_str();
    let lines: Vec<&str> = diagram_raw
        .lines()
        .filter(|line| !line.trim_start().starts_with("click "))
        .collect();
    let diagram = lines.join("\n");
    let body = format!("```mermaid\n{diagram}\n```");

    update_task_in_docs(templates, &task, &body, None)?;
    save_answer(generated, &task, &body)?;
    Ok(())
}
