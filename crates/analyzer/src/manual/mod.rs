pub mod agent;
pub mod author;
pub mod builder;
pub mod config;
pub mod context;
pub mod deps;
pub mod preview;
pub mod task;
pub mod template;
pub mod uimap;

use std::fs;
use std::path::{Path, PathBuf};

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
        "init-template",
        "generate-task",
        "generate-text-all",
        "generate-diagram-all",
        "generate-api",
        "approve",
        "record",
        "record-screenshot",
        "record-diagram",
        "build",
        "ui-map",
        "deps",
        "impact",
        "context",
        "markits-render",
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
    let mut ref_opt: Option<&str> = None;
    let mut json_opt: Option<&str> = None;
    let mut input_opt: Option<&str> = None;
    let mut targets_opt: Option<&str> = None;
    let mut template_opt: Option<&str> = None;
    let mut clear_flag = false;

    for (key, value) in options {
        match *key {
            "--docs" => docs_opt = Some(*value),
            "--output" => output_opt = Some(*value),
            "--targets" => targets_opt = Some(*value),
            "--template" => template_opt = Some(*value),
            "--clear" => clear_flag = true,
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
            "--git-ref" | "--ref" => ref_opt = Some(*value),
            "--json" => json_opt = Some(*value),
            "--input" => input_opt = Some(*value),
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
            let targets_vec = targets_opt.map(|t| {
                t.split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
            });
            save_settings(
                root,
                docs,
                output,
                brief,
                agent,
                model,
                doc_format,
                mkdocs_raw,
                targets_vec.as_deref(),
            )?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "draft" => {
            author::draft(root)?;
            let state_val = get_state(root)?;
            serde_json::to_string(&state_val).map_err(|e| e.to_string())
        }
        "init-template" => {
            let tmpl_type = template_opt.unwrap_or("manual");
            template::init_template(root, tmpl_type, clear_flag)?;
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
        "generate-text-all" => {
            let cli = cli_opt.unwrap_or("target/debug/analyze");
            let task_list = task::tasks(&templates_path)?;
            let mut updated = 0;
            for t in task_list {
                if t.kind == "text" {
                    if author::generate_task(root, &t.id, cli, "").is_ok() {
                        updated += 1;
                    }
                }
            }
            let res = serde_json::json!({
                "updated": updated
            });
            Ok(res.to_string())
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
        "ui-map" => {
            let map = uimap::extract_ui_map(root);
            let _ = uimap::save_ui_map(root, &map);
            serde_json::to_string_pretty(&map).map_err(|e| e.to_string())
        }
        "deps" => {
            let graph = deps::build_manual_dependency_graph(root, &templates_path);
            serde_json::to_string_pretty(&graph).map_err(|e| e.to_string())
        }
        "impact" => {
            let report = deps::analyze_git_impact(root, ref_opt)?;
            serde_json::to_string_pretty(&report).map_err(|e| e.to_string())
        }
        "context" => {
            let ctx = context::build_application_context(root);
            serde_json::to_string_pretty(&ctx).map_err(|e| e.to_string())
        }
        "markits-render" => {
            let json_content = if let Some(j) = json_opt {
                j.to_string()
            } else if let Some(inp) = input_opt {
                let p = if Path::new(inp).is_absolute() {
                    PathBuf::from(inp)
                } else {
                    root.join(inp)
                };
                fs::read_to_string(&p).map_err(|e| format!("Failed to read {}: {e}", p.display()))?
            } else {
                return Err("markits-render requires --json or --input".to_string());
            };
            markits::render_from_json(&json_content).map_err(|e| e.to_string())
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
            Some(&["docs".to_string(), "README.md".to_string()]),
        )
        .unwrap();

        let setting_file = root.join("manual_setting.json");
        assert!(setting_file.is_file());

        let cfg = read_config(root);
        assert_eq!(cfg.docs, "docs");
        assert_eq!(cfg.output, "manual");
        assert_eq!(cfg.agent, "codex");
        assert_eq!(cfg.model, "gpt-4o");
        assert_eq!(cfg.mkdocs.site_name, "Test Site");
        assert_eq!(cfg.targets, vec!["docs", "README.md"]);
    }

    #[test]
    fn test_manual_targets_readme() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let readme = root.join("README.md");
        fs::write(
            &readme,
            "# My Project\n\n<!-- ai:task id=readme-intro kind=text\nREADME用の概要文\n-->\n",
        )
        .unwrap();

        let doc_page = docs.join("index.md");
        fs::write(
            &doc_page,
            "# Manual Top\n\n<!-- ai:task id=doc-intro kind=text\nドキュメントの紹介\n-->\n",
        )
        .unwrap();

        save_settings(
            root,
            "docs",
            "manual",
            "",
            "codex",
            "",
            "mkdocs",
            "",
            Some(&["docs".to_string(), "README.md".to_string()]),
        )
        .unwrap();

        let state = get_state(root).unwrap();
        let pages = state["pages"].as_array().unwrap();
        assert!(pages.iter().any(|p| p.as_str() == Some("README.md")));
        assert!(pages.iter().any(|p| p.as_str() == Some("index.md")));

        let tasks = state["tasks"].as_array().unwrap();
        assert_eq!(tasks.len(), 2);
        assert!(tasks.iter().any(|t| t["id"] == "readme-intro"));
        assert!(tasks.iter().any(|t| t["id"] == "doc-intro"));

        // update_task_in_docs for README.md
        let readme_task = task::find_task(&docs, "readme-intro").unwrap();
        assert_eq!(readme_task.page, "README.md");
        update_task_in_docs(&docs, &readme_task, "これは素晴らしいプロジェクトです。", None).unwrap();

        let updated_readme = fs::read_to_string(&readme).unwrap();
        assert!(updated_readme.contains("<!-- ai:generated id=readme-intro"));
        assert!(updated_readme.contains("これは素晴らしいプロジェクトです。"));
    }

    #[test]
    fn test_init_template_manual() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        template::init_template(root, "manual", false).unwrap();

        let setting = root.join("manual_setting.json");
        assert!(setting.is_file());

        let docs = root.join("docs");
        assert!(docs.join("index.md").is_file());
        assert!(docs.join("quickstart.md").is_file());
        assert!(docs.join("features.md").is_file());
        assert!(docs.join("settings.md").is_file());

        let state = get_state(root).unwrap();
        let tasks = state["tasks"].as_array().unwrap();
        assert!(tasks.iter().any(|t| t["kind"] == "screenshot"));
        assert!(tasks.iter().any(|t| t["kind"] == "text"));
    }

    #[test]
    fn test_init_template_api_and_clear() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        // 1回目: manual テンプレート
        template::init_template(root, "manual", false).unwrap();
        assert!(root.join("docs").join("quickstart.md").is_file());

        // 2回目: clear=false では上書き拒否（確認必要）
        let err = template::init_template(root, "api", false).unwrap_err();
        assert_eq!(err, "EXISTING_DOCS_CONFIRM_REQUIRED");

        // 3回目: clear=true で再生成
        template::init_template(root, "api", true).unwrap();
        let docs = root.join("docs");
        assert!(docs.join("index.md").is_file());
        assert!(docs.join("architecture.md").is_file());
        assert!(docs.join("api.md").is_file());
        // quickstart.md はクリアされていること
        assert!(!docs.join("quickstart.md").is_file());

        let state = get_state(root).unwrap();
        let tasks = state["tasks"].as_array().unwrap();
        assert!(tasks.iter().any(|t| t["kind"] == "diagram"));

        // バックアップが存在すること
        let backup_dir = root.join("manual").join(".backup");
        assert!(backup_dir.is_dir());
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

    #[test]
    fn test_uimap_extraction() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let html_content = r#"
            <div id="main-view">
                <button id="btn-start" title="Start analysis">開始</button>
                <input id="query-input" placeholder="Search..." />
            </div>
        "#;
        fs::write(root.join("index.html"), html_content).unwrap();

        let src_dir = root.join("src");
        fs::create_dir_all(&src_dir).unwrap();
        let ts_content = r#"
            const panel = document.getElementById("results-panel");
        "#;
        fs::write(src_dir.join("main.ts"), ts_content).unwrap();

        let map = uimap::extract_ui_map(root);
        assert!(!map.views.is_empty());
        let all_elements: Vec<_> = map.views.iter().flat_map(|v| &v.elements).collect();
        assert!(all_elements.iter().any(|e| e.id == "btn-start"));
        assert!(all_elements.iter().any(|e| e.id == "query-input"));
        assert!(all_elements.iter().any(|e| e.id == "results-panel"));
    }

    #[test]
    fn test_context_building() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();

        fs::write(
            root.join("pyproject.toml"),
            "[project]\nname = \"sample_app\"\ndescription = \"Test app\"\n",
        )
        .unwrap();
        fs::write(
            root.join("README.md"),
            "# Sample App\nThis is a sample project for testing.\n",
        )
        .unwrap();

        let pkg = root.join("sample_app");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(pkg.join("__init__.py"), "").unwrap();
        fs::write(
            pkg.join("service.py"),
            "class AppService:\n    def run(self):\n        pass\n",
        )
        .unwrap();

        let ctx = context::build_application_context(root);
        assert_eq!(ctx.name, "sample_app");
        assert!(ctx.readme_summary.contains("Sample App"));
        assert!(ctx.key_modules.iter().any(|m| m.contains("service")));
        assert!(ctx.prompt_summary.contains("sample_app"));
    }

    #[test]
    fn test_dependency_graph_building() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let pkg = root.join("myapp");
        fs::create_dir_all(&pkg).unwrap();
        fs::write(
            pkg.join("engine.py"),
            "class Engine:\n    def start(self):\n        pass\n",
        )
        .unwrap();

        fs::write(
            root.join("index.html"),
            r#"<button id="btn-engine">Start Engine</button>"#,
        )
        .unwrap();

        let page = docs.join("guide.md");
        fs::write(
            &page,
            "# User Guide\n\nRefer to `myapp.engine` and click #btn-engine.\n\n<!-- ai:task id=shot-engine kind=screenshot\n#btn-engine の操作画面\n-->\n",
        )
        .unwrap();

        let graph = deps::build_manual_dependency_graph(root, &docs);
        assert!(graph.pages.contains_key("guide.md"));

        let page_dep = graph.pages.get("guide.md").unwrap();
        assert_eq!(page_dep.title, "User Guide");
        assert!(page_dep.symbols.contains(&"myapp.engine".to_string()));
        assert!(page_dep.ui_elements.iter().any(|u| u.contains("btn-engine")));
        assert!(page_dep.tasks.contains(&"shot-engine".to_string()));

        assert!(graph.symbol_to_pages.contains_key("myapp.engine"));
        assert!(graph.task_dependencies.contains_key("shot-engine"));
    }

    #[test]
    fn test_markits_render() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let scene_json = r#"{
            "canvas": { "width": 800, "height": 600 },
            "annotations": [
                {
                    "type": "callout",
                    "target": [100.0, 100.0, 200.0, 50.0],
                    "text": "保存ボタン",
                    "style": "primary"
                }
            ]
        }"#;

        let res = run(root, "markits-render", &[("--json", scene_json)]).unwrap();
        assert!(res.contains("<svg"));
        assert!(res.contains("保存ボタン"));
    }

    #[test]
    fn test_optional_id_auto_assignment() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        let gen = root.join("manual").join("ai");
        fs::create_dir_all(&docs).unwrap();
        fs::create_dir_all(&gen).unwrap();

        let page1 = docs.join("guide.md");
        fs::write(
            &page1,
            "# ガイド\n\n<!-- ai:task kind=screenshot\nメイン画面を撮影\n-->\n\n<!-- ai:task kind=diagram id=explicit-diag\n依存図\n-->\n",
        )
        .unwrap();

        let t = task::tasks(&docs).unwrap();
        assert_eq!(t.len(), 2);

        // 1つ目はid省略のため自動付与されている
        let auto_task = t.iter().find(|task| task.kind == "screenshot").unwrap();
        assert!(auto_task.id.starts_with("screenshot-guide-"));
        let valid_id_re = regex::Regex::new(r"^[a-z][a-z0-9-]*$").unwrap();
        assert!(valid_id_re.is_match(&auto_task.id));

        // 2つ目は明示指定ID
        let explicit_task = t.iter().find(|task| task.kind == "diagram").unwrap();
        assert_eq!(explicit_task.id, "explicit-diag");

        // 自動付与されたタスクに対して更新を実行
        let answer_body = "![guide-screenshot](assets/guide.png)";
        task::save_answer(&gen, auto_task, answer_body).unwrap();
        task::update_task_in_docs(&docs, auto_task, answer_body, None).unwrap();

        let updated_content = fs::read_to_string(&page1).unwrap();
        assert!(updated_content.contains(&format!("<!-- ai:generated id={}", auto_task.id)));
        assert!(updated_content.contains("![guide-screenshot](assets/guide.png)"));
        assert!(!updated_content.contains("<!-- ai:task kind=screenshot"));

        // 再スキャンしてもステータスが維持される
        let scanned = task::scan_entries(&docs, &gen);
        let found = scanned.iter().find(|s| s.id == auto_task.id).unwrap();
        assert_eq!(found.status, "current");
    }

    #[test]
    fn test_code_block_examples_ignored() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        let docs = root.join("docs");
        fs::create_dir_all(&docs).unwrap();

        let page = docs.join("preview.md");
        let content = r#"# ドキュメント記法

以下はマニュアル内で AI タスクを書く書き方の例です：

```markdown
<!-- ai:task id=<一意のID> kind=<screenshot|diagram|text>
<指示文 / プロンプト>
-->
```

本物のタスクはここだけです：

<!-- ai:task id=real-task kind=text
本物の指示文です
-->
"#;
        fs::write(&page, content).unwrap();

        let t = task::tasks(&docs).unwrap();
        assert_eq!(t.len(), 1);
        assert_eq!(t[0].id, "real-task");
    }
}

