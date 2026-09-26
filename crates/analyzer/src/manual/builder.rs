use std::collections::HashMap;
use std::fs;
use std::path::Path;
use std::process::Command;
use tempfile::tempdir;
use walkdir::WalkDir;

use super::agent::which_binary;
use super::config::read_config;
use super::task::{
    collect_markdown_files, read_answer, source_hash, task_regex, tasks, utc_now,
};

pub fn build(
    templates: &Path,
    generated: &Path,
    output_root: &Path,
    draft: bool,
    root: Option<&Path>,
) -> Result<String, String> {
    let task_list = tasks(templates)?;
    let mut answers = HashMap::new();

    for task in &task_list {
        if task.status == "approved" || task.status == "current" {
            continue;
        }
        let answer_path = generated.join("answers").join(format!("{}.md", task.id));
        if !answer_path.is_file() {
            if !draft {
                return Err(format!("Missing answer for {}: {}", task.id, answer_path.display()));
            }
            continue;
        }
        match read_answer(&answer_path, task) {
            Ok(ans) => {
                answers.insert(task.id.clone(), ans);
            }
            Err(e) => {
                if !draft {
                    return Err(e);
                }
            }
        }
    }

    let tmp = tempdir().map_err(|e| e.to_string())?;
    let temp_root = tmp.path();
    let temp_docs = temp_root.join("docs");
    fs::create_dir_all(&temp_docs).map_err(|e| e.to_string())?;

    let built_at = utc_now();
    let t_re = task_regex();

    for page in collect_markdown_files(templates) {
        let content = fs::read_to_string(&page).map_err(|e| e.to_string())?;
        let mut rendered = String::new();
        let mut last_idx = 0;

        for cap in t_re.captures_iter(&content) {
            let m = cap.get(0).unwrap();
            rendered.push_str(&content[last_idx..m.start()]);

            let task_id = cap.name("id").unwrap().as_str();
            let kind = cap.name("kind").unwrap().as_str();
            let prompt = cap.name("prompt").unwrap().as_str().trim();

            if let Some((created, body, approved)) = answers.get(task_id) {
                let digest = source_hash(kind, prompt);
                let approved_attr = approved
                    .as_ref()
                    .map(|a| format!(" approved-at={a}"))
                    .unwrap_or_default();
                rendered.push_str(&format!(
                    "<!-- ai:generated id={task_id} kind={kind} created-at={created} source-sha256={digest}{approved_attr} -->\n{body}\n<!-- /ai:generated -->"
                ));
            } else {
                rendered.push_str(&format!("> **作成待ち:** `{task_id}` ({kind})"));
            }
            last_idx = m.end();
        }
        rendered.push_str(&content[last_idx..]);
        let final_page = rendered.replace("{{BUILD_TIMESTAMP}}", &built_at);

        let rel = page.strip_prefix(templates).unwrap_or(&page);
        let dest = temp_docs.join(rel);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&dest, final_page).map_err(|e| e.to_string())?;
    }

    // markdown 以外の静的ファイルをコピー
    for entry in WalkDir::new(templates).into_iter().filter_map(|e| e.ok()) {
        if entry.file_type().is_file() {
            if entry.path().extension().map_or(true, |ext| ext != "md") {
                let rel = entry.path().strip_prefix(templates).unwrap_or(entry.path());
                let dest = temp_docs.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(entry.path(), &dest);
            }
        }
    }

    let legacy_assets = generated.join("assets");
    if legacy_assets.is_dir() {
        let dest_assets = temp_docs.join("assets");
        let _ = fs::create_dir_all(&dest_assets);
        for entry in WalkDir::new(&legacy_assets).into_iter().filter_map(|e| e.ok()) {
            if entry.file_type().is_file() {
                let rel = entry.path().strip_prefix(&legacy_assets).unwrap_or(entry.path());
                let dest = dest_assets.join(rel);
                if let Some(parent) = dest.parent() {
                    let _ = fs::create_dir_all(parent);
                }
                let _ = fs::copy(entry.path(), &dest);
            }
        }
    }

    let (site_name, theme_name, theme_lang, use_dir_urls) = if let Some(r) = root {
        let cfg = read_config(r);
        (
            cfg.mkdocs.site_name,
            cfg.mkdocs.theme,
            cfg.mkdocs.language,
            cfg.mkdocs.use_directory_urls,
        )
    } else {
        (
            "ModuleLoom マニュアル".to_string(),
            "material".to_string(),
            "ja".to_string(),
            false,
        )
    };

    let mut nav_lines = String::new();
    for page in collect_markdown_files(templates) {
        let rel = page.strip_prefix(templates).unwrap_or(&page);
        let rel_posix = rel.to_string_lossy().replace('\\', "/");
        let stem = page.file_stem().unwrap_or_default().to_string_lossy();
        nav_lines.push_str(&format!(
            "  - {}: {}\n",
            serde_json::to_string(&stem).unwrap(),
            serde_json::to_string(&rel_posix).unwrap()
        ));
    }

    let config_yaml = format!(
        "site_name: {}\n\
        theme:\n  name: {}\n  language: {}\n\
        use_directory_urls: {}\n\
        site_dir: {}\n\
        markdown_extensions:\n\
          - pymdownx.superfences:\n\
              custom_fences:\n\
                - name: mermaid\n\
                  class: mermaid\n\
                  format: !!python/name:pymdownx.superfences.fence_code_format\n\
        nav:\n{}",
        serde_json::to_string(&site_name).unwrap(),
        theme_name,
        theme_lang,
        if use_dir_urls { "true" } else { "false" },
        serde_json::to_string(&output_root.canonicalize().unwrap_or_else(|_| output_root.to_path_buf()).to_string_lossy()).unwrap(),
        nav_lines
    );

    let temp_config = temp_root.join("mkdocs.yml");
    fs::write(&temp_config, config_yaml).map_err(|e| e.to_string())?;

    fs::create_dir_all(output_root).map_err(|e| e.to_string())?;

    // 外部 mkdocs CLI の探索
    let mut mkdocs_cmd: Option<Vec<String>> = None;
    if let Some(bin) = which_binary("mkdocs") {
        mkdocs_cmd = Some(vec![bin.to_string_lossy().into_owned()]);
    } else if let Some(r) = root {
        let venv_mkdocs = r.join(".venv").join("bin").join("mkdocs");
        if venv_mkdocs.is_file() {
            mkdocs_cmd = Some(vec![venv_mkdocs.to_string_lossy().into_owned()]);
        }
    }

    if mkdocs_cmd.is_none() {
        for py in &["python3", "python"] {
            if let Some(py_bin) = which_binary(py) {
                // python -m mkdocs が使えるかチェック
                let test_out = Command::new(&py_bin)
                    .args(["-m", "mkdocs", "--version"])
                    .output();
                if let Ok(out) = test_out {
                    if out.status.success() {
                        mkdocs_cmd = Some(vec![
                            py_bin.to_string_lossy().into_owned(),
                            "-m".to_string(),
                            "mkdocs".to_string(),
                        ]);
                        break;
                    }
                }
            }
        }
    }

    if let Some(cmd_parts) = mkdocs_cmd {
        let (prog, args) = cmd_parts.split_first().unwrap();
        let mut final_args: Vec<String> = args.to_vec();
        final_args.extend([
            "build".to_string(),
            "-f".to_string(),
            temp_config.to_string_lossy().into_owned(),
            "-d".to_string(),
            output_root
                .canonicalize()
                .unwrap_or_else(|_| output_root.to_path_buf())
                .to_string_lossy()
                .into_owned(),
        ]);

        let output = Command::new(prog)
            .args(&final_args)
            .current_dir(temp_root)
            .output()
            .map_err(|e| format!("Failed to run mkdocs: {e}"))?;

        if !output.status.success() {
            let err = String::from_utf8_lossy(&output.stderr);
            let out = String::from_utf8_lossy(&output.stdout);
            let msg = if !err.trim().is_empty() { err.trim() } else { out.trim() };
            return Err(format!("MkDocs site build failed: {msg}"));
        }
        Ok(format!("{}\nSite: {}", output_root.display(), output_root.display()))
    } else {
        Ok(format!(
            "{}\nMkDocs site build skipped: install mkdocs-material to generate HTML at {}",
            output_root.display(),
            output_root.display()
        ))
    }
}
