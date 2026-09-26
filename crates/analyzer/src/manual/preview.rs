use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use regex::Regex;
use serde_json::json;
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use walkdir::WalkDir;

use super::agent::get_agents;
use super::builder::build;
use super::config::{project_path, read_config, DEFAULT_BRIEF};
use super::task::{
    collect_markdown_files, read_answer, scan_entries, source_hash, task_regex, tasks, utc_now,
};

pub fn render_page_markdown(
    templates: &Path,
    generated: &Path,
    page_rel: &Path,
    _draft: bool,
) -> Result<String, String> {
    let page_path = templates.join(page_rel);
    if !page_path.is_file() {
        return Err(format!("Preview page is missing: {}", page_rel.display()));
    }
    let content = fs::read_to_string(&page_path).map_err(|e| e.to_string())?;
    let task_list = tasks(templates)?;
    let mut answers = HashMap::new();
    for task in &task_list {
        let answer_path = generated.join("answers").join(format!("{}.md", task.id));
        if answer_path.is_file() {
            if let Ok(ans) = read_answer(&answer_path, task) {
                answers.insert(task.id.clone(), ans);
            }
        }
    }

    let built_at = utc_now();
    let t_re = task_regex();

    let mut result = String::new();
    let mut last_idx = 0;

    for cap in t_re.captures_iter(&content) {
        let m = cap.get(0).unwrap();
        result.push_str(&content[last_idx..m.start()]);

        let task_id = cap.name("id").unwrap().as_str();
        let kind = cap.name("kind").unwrap().as_str();
        let prompt = cap.name("prompt").unwrap().as_str().trim();

        if let Some((created, body, approved)) = answers.get(task_id) {
            let digest = source_hash(kind, prompt);
            let approved_attr = approved
                .as_ref()
                .map(|a| format!(" approved-at={a}"))
                .unwrap_or_default();
            result.push_str(&format!(
                "<!-- ai:generated id={task_id} kind={kind} created-at={created} source-sha256={digest}{approved_attr} -->\n{body}\n<!-- /ai:generated -->"
            ));
        } else {
            result.push_str(&format!("> **作成待ち:** `{task_id}` ({kind})"));
        }
        last_idx = m.end();
    }
    result.push_str(&content[last_idx..]);

    Ok(result.replace("{{BUILD_TIMESTAMP}}", &built_at))
}

pub fn inline_html_assets(output: &Path, html_text: &str) -> String {
    let css_pattern = Regex::new(
        r#"(?i)<link\s+[^>]*rel=["']stylesheet["'][^>]*href=["'](?P<href>[^"']+)["'][^>]*>"#,
    )
    .unwrap();

    let mut step1 = String::new();
    let mut last_idx = 0;
    for cap in css_pattern.captures_iter(html_text) {
        let m = cap.get(0).unwrap();
        step1.push_str(&html_text[last_idx..m.start()]);
        let href = cap.name("href").unwrap().as_str();
        let clean = href.split('?').next().unwrap_or(href).split('#').next().unwrap_or(href);
        let clean_rel = clean.trim_start_matches(|c| c == '.' || c == '/');

        let mut css_path = output.join(clean_rel);
        if !css_path.is_file() {
            let name = Path::new(clean).file_name();
            if let Some(n) = name {
                for entry in WalkDir::new(output).into_iter().filter_map(|e| e.ok()) {
                    if entry.file_type().is_file() && entry.file_name() == n {
                        css_path = entry.path().to_path_buf();
                        break;
                    }
                }
            }
        }

        if css_path.is_file() {
            if let Ok(css_content) = fs::read_to_string(&css_path) {
                step1.push_str(&format!("<style>/* inlined {href} */\n{css_content}\n</style>"));
                last_idx = m.end();
                continue;
            }
        }
        step1.push_str(m.as_str());
        last_idx = m.end();
    }
    step1.push_str(&html_text[last_idx..]);

    let img_pattern =
        Regex::new(r#"(?i)<img\s+[^>]*src=["'](?P<src>[^"']+)["'][^>]*>"#).unwrap();

    let mut step2 = String::new();
    last_idx = 0;
    for cap in img_pattern.captures_iter(&step1) {
        let m = cap.get(0).unwrap();
        step2.push_str(&step1[last_idx..m.start()]);
        let src = cap.name("src").unwrap().as_str();
        let clean = src.split('?').next().unwrap_or(src).split('#').next().unwrap_or(src);
        let clean_rel = clean.trim_start_matches(|c| c == '.' || c == '/');

        let mut img_path = output.join(clean_rel);
        if !img_path.is_file() {
            let name = Path::new(clean).file_name();
            if let Some(n) = name {
                for entry in WalkDir::new(output).into_iter().filter_map(|e| e.ok()) {
                    if entry.file_type().is_file() && entry.file_name() == n {
                        img_path = entry.path().to_path_buf();
                        break;
                    }
                }
            }
        }

        if img_path.is_file() {
            let ext = img_path
                .extension()
                .and_then(|e| e.to_str())
                .unwrap_or("")
                .to_lowercase();
            let mime = match ext.as_str() {
                "png" => Some("image/png"),
                "jpg" | "jpeg" => Some("image/jpeg"),
                "webp" => Some("image/webp"),
                "svg" => Some("image/svg+xml"),
                _ => None,
            };
            if let Some(mime_type) = mime {
                if let Ok(metadata) = fs::metadata(&img_path) {
                    if metadata.len() < 10_000_000 {
                        if let Ok(bytes) = fs::read(&img_path) {
                            let b64 = BASE64.encode(bytes);
                            let tag = m.as_str().replace(src, &format!("data:{mime_type};base64,{b64}"));
                            step2.push_str(&tag);
                            last_idx = m.end();
                            continue;
                        }
                    }
                }
            }
        }
        step2.push_str(m.as_str());
        last_idx = m.end();
    }
    step2.push_str(&step1[last_idx..]);

    let nav_script = "<script>\n\
document.addEventListener('click', function(e) {\n\
  var a = e.target.closest('a');\n\
  if (!a) return;\n\
  var href = a.getAttribute('href');\n\
  if (!href) return;\n\
  if (href.startsWith('#')) return;\n\
  e.preventDefault();\n\
  if (/^(https?:)?\\/\\//i.test(href) || href.startsWith('mailto:')) {\n\
    window.open(a.href, '_blank');\n\
  } else {\n\
    window.parent.postMessage({ type: 'moduleloom_manual_navigate', href: href }, '*');\n\
  }\n\
});\n\
</script>\n";

    if step2.contains("</body>") {
        step2.replace("</body>", &format!("{nav_script}</body>"))
    } else {
        format!("{step2}{nav_script}")
    }
}

pub fn preview_page(root: &Path, page: &str) -> Result<String, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let target = project_path(&templates, page)?;
    if target.extension().map_or(true, |ext| ext != "md") || !target.is_file() {
        return Err(format!("Preview page is missing: {page}"));
    }
    render_page_markdown(&templates, &generated, Path::new(page), true)
}

pub fn preview_html(root: &Path, page: &str) -> Result<String, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output = project_path(root, &config.output)?;

    let mut page_rel = PathBuf::from(page);
    if page_rel.extension().map_or(false, |ext| ext == "md") {
        page_rel.set_extension("html");
    }

    let mut target = output.join(&page_rel);
    if !target.is_file() {
        if let Some(parent) = page_rel.parent() {
            let stem = page_rel.file_stem().unwrap_or_default();
            let dir_target = output.join(parent).join(stem).join("index.html");
            if dir_target.is_file() {
                target = dir_target;
            }
        }
    }

    if !target.is_file() {
        let _ = build(&templates, &generated, &output, true, Some(root));
        target = output.join(&page_rel);
        if !target.is_file() {
            if let Some(parent) = page_rel.parent() {
                let stem = page_rel.file_stem().unwrap_or_default();
                let dir_target = output.join(parent).join(stem).join("index.html");
                if dir_target.is_file() {
                    target = dir_target;
                }
            }
        }
    }

    if !target.is_file() {
        return Err(format!("HTML page is missing: {page}. Please build the manual first."));
    }

    let content = fs::read_to_string(&target).map_err(|e| e.to_string())?;
    Ok(inline_html_assets(&output, &content))
}

pub fn preview_asset(root: &Path, page: &str, asset: &str) -> Result<String, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let page_path = project_path(&templates, page)?;

    let asset_path = Path::new(asset);
    let asset_name = asset_path.file_name().unwrap_or_default();

    let candidate_paths = [
        page_path.parent().map(|p| p.join(asset)).unwrap_or_default(),
        templates.join("assets").join(asset_name),
        templates.join(asset),
        generated.join("assets").join(asset_name),
    ];

    let mut image = None;
    for cand in &candidate_paths {
        if cand.is_file() {
            image = Some(cand.clone());
            break;
        }
    }

    let img = image.ok_or_else(|| "Preview image is missing".to_string())?;
    let ext = img.extension().and_then(|e| e.to_str()).unwrap_or("").to_lowercase();
    let mime = match ext.as_str() {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "webp" => Some("image/webp"),
        _ => None,
    }
    .ok_or_else(|| "Unsupported preview image".to_string())?;

    let meta = fs::metadata(&img).map_err(|e| e.to_string())?;
    if meta.len() > 10_000_000 {
        return Err("Unsupported preview image".to_string());
    }

    let bytes = fs::read(&img).map_err(|e| e.to_string())?;
    let b64 = BASE64.encode(bytes);
    Ok(format!("data:{mime};base64,{b64}"))
}

pub fn get_state(root: &Path) -> Result<serde_json::Value, String> {
    let config = read_config(root);
    let templates = project_path(root, &config.docs)?;
    let generated = root.join("manual").join("ai");
    let output = project_path(root, &config.output)?;
    let brief_path = root.join("manual").join("brief.md");

    let pages: Vec<String> = if templates.is_dir() {
        collect_markdown_files(&templates)
            .into_iter()
            .map(|p| {
                p.strip_prefix(&templates)
                    .unwrap_or(&p)
                    .to_string_lossy()
                    .replace('\\', "/")
            })
            .collect()
    } else {
        Vec::new()
    };

    let preview = if templates.is_dir() && templates.join("index.md").is_file() {
        render_page_markdown(&templates, &generated, Path::new("index.md"), true)
            .unwrap_or_else(|_| fs::read_to_string(templates.join("index.md")).unwrap_or_default())
    } else {
        String::new()
    };

    let index_html = output.join("index.html");
    if !index_html.is_file() && templates.is_dir() && !pages.is_empty() {
        let _ = build(&templates, &generated, &output, true, Some(root));
    }

    let preview_html_content = if index_html.is_file() {
        fs::read_to_string(&index_html)
            .map(|c| inline_html_assets(&output, &c))
            .unwrap_or_default()
    } else {
        String::new()
    };

    let brief = if brief_path.is_file() {
        fs::read_to_string(&brief_path).unwrap_or_else(|_| DEFAULT_BRIEF.to_string())
    } else {
        DEFAULT_BRIEF.to_string()
    };

    let tasks = scan_entries(&templates, &generated);
    let has_html = !preview_html_content.is_empty();

    Ok(json!({
        "config": config,
        "agents": get_agents(),
        "brief": brief,
        "tasks": tasks,
        "pages": pages,
        "preview": preview,
        "preview_html": preview_html_content,
        "has_html": has_html,
    }))
}
