pub mod agent;
pub mod author;
pub mod builder;
pub mod config;
pub mod preview;
pub mod task;

use std::fs;
use std::path::Path;

use config::{project_path, read_config, save_settings};
use preview::{get_state, preview_asset, preview_html, preview_page};
use task::{approve_task, save_answer, scan_entries, update_task_in_docs};

pub fn run(root: &Path, action: &str, options: &[(&str, &str)]) -> Result<String, String> {
    let allowed = [
        "state",
        "scan",
        "models",
        "preview-page",
        "preview-html",
        "preview-asset",
        "save",
        "draft",
        "generate-task",
        "generate-diagram-all",
        "generate-api",
        "approve",
        "record",
        "record-screenshot",
        "record-diagram",
        "build",
    ];
    if !allowed.contains(&action) {
        return Err(format!("Unsupported manual action: {action}"));
    }
    if !root.is_dir() {
        return Err(format!("Manual project does not exist: {}", root.display()));
    }

    let mut docs_opt: Option<&str> = None;
    let mut output_opt: Option<&str> = None;
    let mut brief_opt: Option<&str> = None;
    let mut agent_opt: Option<&str> = None;
    let mut model_opt: Option<&str> = None;
    let mut id_opt: Option<&str> = None;
    let mut page_opt: Option<&str> = None;
    let mut asset_opt: Option<&str> = None;
    let mut image_opt: Option<&str> = None;
    let mut cli_opt: Option<&str> = None;
    let mut draft_flag = false;
    let mut format_opt: Option<&str> = None;
    let mut mkdocs_settings_opt: Option<&str> = None;
    let mut feedback_opt: Option<&str> = None;
    let mut body_opt: Option<&str> = None;
    let mut project_opt: Option<&str> = None;
    let mut lang_opt: Option<&str> = None;

    for (key, value) in options {
        match *key {
            "--docs" => docs_opt = Some(*value),
            "--output" => output_opt = Some(*value),
            "--brief" => brief_opt = Some(*value),
            "--agent" => agent_opt = Some(*value),
            "--model" => model_opt = Some(*value),
            "--id" => id_opt = Some(*value),
            "--page" => page_opt = Some(*value),
            "--asset" => asset_opt = Some(*value),
            "--image" => image_opt = Some(*value),
            "--cli" => cli_opt = Some(*value),
            "--draft" => draft_flag = true,
            "--format" => format_opt = Some(*value),
            "--mkdocs-settings" => mkdocs_settings_opt = Some(*value),
            "--feedback" => feedback_opt = Some(*value),
            "--body" => body_opt = Some(*value),
            "--project" => project_opt = Some(*value),
            "--lang" => lang_opt = Some(*value),
            _ => return Err(format!("Unsupported manual option: {key}")),
        }
    }

    let cfg = read_config(root);
    let templates_path = if let Some(d) = docs_opt {
        project_path(root, d)?
    } else {
        project_path(root, &cfg.docs)?
    };
    let output_path = if let Some(o) = output_opt {
        project_path(root, o)?
    } else {
        project_path(root, &cfg.output)?
    };
    let generated_path = root.join("manual").join("ai");

    match action {
        "state" => {
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "scan" => {
            let entries = scan_entries(&templates_path, &generated_path);
            serde_json::to_string_pretty(&entries).map_err(|e| e.to_string())
        }
        "models" => {
            let target_agent = agent_opt.unwrap_or(&cfg.agent);
            let models_val = agent::get_models(root, target_agent)?;
            serde_json::to_string_pretty(&models_val).map_err(|e| e.to_string())
        }
        "preview-page" => {
            let page = page_opt.unwrap_or("index.md");
            preview_page(root, page)
        }
        "preview-html" => {
            let page = page_opt.unwrap_or("index.md");
            preview_html(root, page)
        }
        "preview-asset" => {
            let page = page_opt.unwrap_or("index.md");
            let asset = asset_opt.ok_or("preview-asset requires --asset")?;
            preview_asset(root, page, asset)
        }
        "save" => {
            let brief = brief_opt.unwrap_or("");
            let docs = docs_opt.unwrap_or(&cfg.docs);
            let output = output_opt.unwrap_or(&cfg.output);
            let agent = agent_opt.unwrap_or(&cfg.agent);
            let model = model_opt.unwrap_or(&cfg.model);
            let doc_format = format_opt.unwrap_or(&cfg.format);
            let mkdocs_raw = mkdocs_settings_opt.unwrap_or("");
            save_settings(root, docs, output, brief, agent, model, doc_format, mkdocs_raw)?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "draft" => {
            author::draft(root)?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "generate-task" => {
            let task_id = id_opt.ok_or("generate-task requires --id")?;
            let cli = cli_opt.unwrap_or("target/debug/analyze");
            let feedback = feedback_opt.unwrap_or("");
            author::generate_task(root, task_id, cli, feedback)?;
            Ok(String::new())
        }
        "generate-diagram-all" => {
            let cli = cli_opt.unwrap_or("target/debug/analyze");
            let task_list = task::tasks(&templates_path)?;
            let mut updated = 0;
            for t in task_list {
                if t.kind == "diagram" {
                    author::generate_task(root, &t.id, cli, "")?;
                    updated += 1;
                }
            }
            let res = serde_json::json!({
                "updated": updated
            });
            Ok(res.to_string())
        }
        "generate-api" => {
            let lang = lang_opt.unwrap_or("auto");
            let result = crate::analyze_directory(root)?;
            let count = crate::mkdocs::generate_api_reference(&result, &templates_path, lang)?;
            let res = serde_json::json!({
                "count": count,
                "api_page": "api.md",
                "modules_dir": "modules"
            });
            Ok(res.to_string())
        }
        "approve" => {
            let task_id = id_opt.ok_or("approve requires --id")?;
            approve_task(&templates_path, &generated_path, task_id)?;
            Ok(String::new())
        }
        "record" => {
            let task_id = id_opt.ok_or("record requires --id")?;
            let body_file = body_opt.ok_or("record requires --body")?;
            let body_path = root.join(body_file);
            let body = fs::read_to_string(&body_path)
                .map_err(|e| format!("Failed to read body file: {e}"))?;
            let task = task::find_task(&templates_path, task_id)?;
            update_task_in_docs(&templates_path, &task, &body, None)?;
            save_answer(&generated_path, &task, &body)?;
            Ok(String::new())
        }
        "record-screenshot" => {
            let task_id = id_opt.ok_or("record-screenshot requires --id")?;
            let img = image_opt.ok_or("record-screenshot requires --image")?;
            let image_path = Path::new(img);
            author::record_screenshot(root, task_id, image_path)?;
            Ok(String::new())
        }
        "record-diagram" => {
            let task_id = id_opt.ok_or("record-diagram requires --id")?;
            let cli = cli_opt.unwrap_or("target/debug/analyze");
            let proj = project_opt.unwrap_or("manual/fixtures/diagram_project");
            let project_path = root.join(proj);
            author::record_diagram(&templates_path, &generated_path, task_id, cli, &project_path)?;
            Ok(String::new())
        }
        "build" => {
            builder::build(&templates_path, &generated_path, &output_path, draft_flag, Some(root))
        }
        _ => unreachable!(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use tempfile::tempdir;

    #[test]
    fn test_config_save_and_read() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("manual")).unwrap();

        save_settings(
            root,
            "docs",
            "manual",
            "テスト指示",
            "codex",
            "gpt-4o",
            "mkdocs",
            r#"{"site_name": "Test Site"}"#,
        )
        .unwrap();

        let cfg = read_config(root);
        assert_eq!(cfg.docs, "docs");
        assert_eq!(cfg.output, "manual");
        assert_eq!(cfg.agent, "codex");
        assert_eq!(cfg.model, "gpt-4o");
        assert_eq!(cfg.mkdocs.site_name, "Test Site");
    }

    #[test]
    fn test_task_scan_and_approval() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        let gen = root.join("manual").join("ai");
        fs::create_dir_all(&docs).unwrap();

        let page1 = docs.join("index.md");
        fs::write(
            &page1,
            "# Top\n\n<!-- ai:task id=intro kind=text\nこのアプリの紹介文を書く\n-->\n",
        )
        .unwrap();

        let t = task::tasks(&docs).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "intro");
        assert_eq!(t[0].kind, "text");
        assert_eq!(t[0].status, "missing");

        // 回答を保存
        task::save_answer(&gen, &t[0], "ModuleLoomへようこそ。").unwrap();
        task::update_task_in_docs(&docs, &t[0], "ModuleLoomへようこそ。", None).unwrap();

        let scanned = task::scan_entries(&docs, &gen);
        assert_eq!(scanned[0].status, "current");

        // 承認
        approve_task(&docs, &gen, "intro").unwrap();
        let approved = task::scan_entries(&docs, &gen);
        assert_eq!(approved[0].status, "approved");
    }

    #[test]
    fn test_single_responsibility_record_screenshot() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let page1 = docs.join("index.md");
        fs::write(
            &page1,
            "# Top\n\n<!-- ai:task id=top-shot kind=screenshot\nツールウィンドウの全体画面\n-->\n",
        )
        .unwrap();

        // ダミーPNGを作成
        let img = root.join("screen.png");
        fs::write(&img, b"fake png data").unwrap();

        author::record_screenshot(root, "top-shot", &img).unwrap();

        let updated = fs::read_to_string(&page1).unwrap();
        assert!(updated.contains("![top-shot](assets/screen.png)"));
        // 不要な出典や定型文が一切含まれていないことを検証
        assert!(!updated.contains("実際の PyCharm"));
        assert!(!updated.contains("図の生成元"));
    }
}
