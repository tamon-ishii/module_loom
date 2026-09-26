use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use super::config::{project_path, read_config};
use super::task::{collect_markdown_files, task_regex, utc_now};
use super::uimap::extract_ui_map;
use crate::analyze_directory;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ManualDependencyGraph {
    pub version: String,
    pub updated_at: String,
    pub pages: HashMap<String, PageDependencies>,
    pub symbol_to_pages: HashMap<String, Vec<String>>,
    pub ui_to_pages: HashMap<String, Vec<String>>,
    pub task_dependencies: HashMap<String, TaskDependencies>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct PageDependencies {
    pub path: String,
    pub title: String,
    pub symbols: Vec<String>,
    pub ui_elements: Vec<String>,
    pub configs: Vec<String>,
    pub assets: Vec<String>,
    pub tasks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct TaskDependencies {
    pub id: String,
    pub page: String,
    pub kind: String,
    pub symbols: Vec<String>,
    pub ui_elements: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct ImpactReport {
    pub git_ref: String,
    pub changed_files: Vec<String>,
    pub affected_symbols: Vec<String>,
    pub affected_ui_elements: Vec<String>,
    pub impacted_pages: Vec<ImpactedPage>,
    pub total_impacted_pages: usize,
    pub total_impacted_tasks: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ImpactedPage {
    pub path: String,
    pub reasons: Vec<String>,
    pub impacted_tasks: Vec<String>,
    pub requires_rebuild: bool,
}

pub fn graph_path(root: &Path) -> PathBuf {
    root.join("manual").join("manual_deps.json")
}

pub fn read_dependency_graph(root: &Path) -> Option<ManualDependencyGraph> {
    let path = graph_path(root);
    if !path.is_file() {
        return None;
    }
    let content = fs::read_to_string(&path).ok()?;
    serde_json::from_str(&content).ok()
}

pub fn build_manual_dependency_graph(root: &Path, docs_path: &Path) -> ManualDependencyGraph {
    let mut pages = HashMap::new();
    let mut symbol_to_pages: HashMap<String, Vec<String>> = HashMap::new();
    let mut ui_to_pages: HashMap<String, Vec<String>> = HashMap::new();
    let mut task_dependencies = HashMap::new();

    // 1. Collect known code symbols from AST
    let mut known_modules = HashSet::new();
    let mut known_classes = HashSet::new();
    let mut known_functions = HashSet::new();

    if let Ok(res) = analyze_directory(root) {
        for m in &res.modules {
            known_modules.insert(m.id.clone());
            for c in &m.classes {
                known_classes.insert(format!("{}.{}", m.id, c.name));
                known_classes.insert(c.name.clone());
            }
            for f in &m.functions {
                known_functions.insert(format!("{}.{}", m.id, f.name));
                known_functions.insert(f.name.clone());
            }
        }
    }

    // 2. Collect known UI elements from UI Map
    let ui_map = extract_ui_map(root);
    let mut known_ui_ids = HashMap::new(); // selector -> element name
    for v in &ui_map.views {
        for el in &v.elements {
            known_ui_ids.insert(el.selector.clone(), el.name.clone());
            known_ui_ids.insert(format!("#{}", el.id), el.name.clone());
        }
    }

    let t_re = task_regex();
    let title_re = Regex::new(r#"(?m)^#\s+(.+)$"#).unwrap();
    let asset_re = Regex::new(r#"!\[[^\]]*\]\(([^)]+)\)"#).unwrap();
    let selector_re = Regex::new(r#"#([a-zA-Z0-9_-]+)"#).unwrap();

    let md_files = collect_markdown_files(docs_path);

    for file_path in md_files {
        let Ok(content) = fs::read_to_string(&file_path) else {
            continue;
        };

        let rel_path = file_path
            .strip_prefix(docs_path)
            .unwrap_or(&file_path)
            .to_string_lossy()
            .to_string();

        let title = title_re
            .captures(&content)
            .map(|c| c[1].trim().to_string())
            .unwrap_or_else(|| rel_path.clone());

        let mut page_symbols = HashSet::new();
        let mut page_ui = HashSet::new();
        let mut page_configs = HashSet::new();
        let mut page_assets = HashSet::new();
        let mut page_tasks = Vec::new();

        // Assets
        for cap in asset_re.captures_iter(&content) {
            page_assets.insert(cap[1].to_string());
        }

        // Symbols in page content
        for mod_id in &known_modules {
            if content.contains(mod_id) {
                page_symbols.insert(mod_id.clone());
            }
        }
        for cls in &known_classes {
            if cls.len() >= 4 && content.contains(cls) {
                page_symbols.insert(cls.clone());
            }
        }
        for func in &known_functions {
            if func.len() >= 4 && content.contains(func) {
                page_symbols.insert(func.clone());
            }
        }

        // UI in page content
        for (sel, name) in &known_ui_ids {
            if content.contains(sel) || (name.len() >= 3 && content.contains(name)) {
                page_ui.insert(sel.clone());
            }
        }

        // Check tasks
        for cap in t_re.captures_iter(&content) {
            let tag = cap.get(0).unwrap().as_str();
            let mut id = String::new();
            let mut kind = String::new();

            for part in tag.split_whitespace() {
                if let Some(rest) = part.strip_prefix("id=") {
                    id = rest.trim_matches('"').trim_matches('\'').to_string();
                } else if let Some(rest) = part.strip_prefix("kind=") {
                    kind = rest.trim_matches('"').trim_matches('\'').to_string();
                }
            }

            if id.is_empty() {
                continue;
            }

            page_tasks.push(id.clone());

            let mut task_symbols = Vec::new();
            let mut task_ui = Vec::new();

            for cap_sel in selector_re.captures_iter(tag) {
                let sel = format!("#{}", &cap_sel[1]);
                task_ui.push(sel.clone());
                page_ui.insert(sel);
            }

            for mod_id in &known_modules {
                if tag.contains(mod_id) {
                    task_symbols.push(mod_id.clone());
                    page_symbols.insert(mod_id.clone());
                }
            }

            task_dependencies.insert(
                id.clone(),
                TaskDependencies {
                    id,
                    page: rel_path.clone(),
                    kind,
                    symbols: task_symbols,
                    ui_elements: task_ui,
                },
            );
        }

        // Configs
        if content.contains("mkdocs") || content.contains("theme") {
            page_configs.insert("mkdocs.theme".to_string());
        }
        if content.contains("language") || content.contains("言語") {
            page_configs.insert("mkdocs.language".to_string());
        }

        // Inverted indexes
        for sym in &page_symbols {
            symbol_to_pages
                .entry(sym.clone())
                .or_default()
                .push(rel_path.clone());
        }
        for ui in &page_ui {
            ui_to_pages
                .entry(ui.clone())
                .or_default()
                .push(rel_path.clone());
        }

        pages.insert(
            rel_path.clone(),
            PageDependencies {
                path: rel_path,
                title,
                symbols: page_symbols.into_iter().collect(),
                ui_elements: page_ui.into_iter().collect(),
                configs: page_configs.into_iter().collect(),
                assets: page_assets.into_iter().collect(),
                tasks: page_tasks,
            },
        );
    }

    let graph = ManualDependencyGraph {
        version: "1.0".to_string(),
        updated_at: utc_now(),
        pages,
        symbol_to_pages,
        ui_to_pages,
        task_dependencies,
    };

    // Save graph
    let dest_dir = root.join("manual");
    let _ = fs::create_dir_all(&dest_dir);
    if let Ok(json) = serde_json::to_string_pretty(&graph) {
        let _ = fs::write(graph_path(root), json);
    }

    graph
}

pub fn analyze_git_impact(root: &Path, git_ref_opt: Option<&str>) -> Result<ImpactReport, String> {
    let cfg = read_config(root);
    let docs_path = project_path(root, &cfg.docs)?;
    let graph = match read_dependency_graph(root) {
        Some(g) => g,
        None => build_manual_dependency_graph(root, &docs_path),
    };

    let git_ref = git_ref_opt.unwrap_or("HEAD~1").to_string();

    // 1. Get changed files via git
    let mut changed_files = Vec::new();

    // Try git diff with reference
    let diff_output = Command::new("git")
        .current_dir(root)
        .args(["diff", "--name-only", &git_ref])
        .output();

    if let Ok(out) = diff_output {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                let trimmed = line.trim();
                if !trimmed.is_empty() {
                    changed_files.push(trimmed.to_string());
                }
            }
        }
    }

    // Also include working tree changes (git status --porcelain)
    let status_output = Command::new("git")
        .current_dir(root)
        .args(["status", "--porcelain"])
        .output();

    if let Ok(out) = status_output {
        if out.status.success() {
            let stdout = String::from_utf8_lossy(&out.stdout);
            for line in stdout.lines() {
                if line.len() >= 3 {
                    let file_path = line[3..].trim();
                    if !file_path.is_empty() && !changed_files.contains(&file_path.to_string()) {
                        changed_files.push(file_path.to_string());
                    }
                }
            }
        }
    }

    let mut affected_symbols = HashSet::new();
    let mut affected_ui_elements = HashSet::new();
    let mut page_impact_map: HashMap<String, (Vec<String>, HashSet<String>)> = HashMap::new();

    for file in &changed_files {
        // Python file changed
        if file.ends_with(".py") {
            let path_parts: Vec<&str> = file.trim_end_matches(".py").split('/').collect();
            let mut candidate_modules = Vec::new();
            for i in 0..path_parts.len() {
                candidate_modules.push(path_parts[i..].join("."));
            }

            for cand in candidate_modules {
                if graph.symbol_to_pages.contains_key(&cand) {
                    affected_symbols.insert(cand.clone());
                    if let Some(pages) = graph.symbol_to_pages.get(&cand) {
                        for p in pages {
                            let entry = page_impact_map
                                .entry(p.clone())
                                .or_insert_with(|| (Vec::new(), HashSet::new()));
                            entry
                                .0
                                .push(format!("コード変更: モジュール `{cand}` ({file})"));
                        }
                    }
                }
            }
        }

        // HTML / UI changed
        if file.ends_with(".html") || file.ends_with(".ts") || file.ends_with(".vue") {
            // Check which UI selectors exist in this file or might be affected
            for (ui_sel, pages) in &graph.ui_to_pages {
                let clean_id = ui_sel.trim_start_matches('#');
                if file.contains("index.html") || file.contains("manual") || file.contains(clean_id) {
                    affected_ui_elements.insert(ui_sel.clone());
                    for p in pages {
                        let entry = page_impact_map
                            .entry(p.clone())
                            .or_insert_with(|| (Vec::new(), HashSet::new()));
                        entry
                            .0
                            .push(format!("UI 変更: 要素 `{ui_sel}` が {file} で更新されました"));
                    }
                }
            }
        }
    }

    // Match affected tasks
    for (task_id, t_dep) in &graph.task_dependencies {
        let mut task_affected = false;
        for sym in &t_dep.symbols {
            if affected_symbols.contains(sym) {
                task_affected = true;
                break;
            }
        }
        if !task_affected {
            for ui in &t_dep.ui_elements {
                if affected_ui_elements.contains(ui) {
                    task_affected = true;
                    break;
                }
            }
        }

        if task_affected {
            if let Some(entry) = page_impact_map.get_mut(&t_dep.page) {
                entry.1.insert(task_id.clone());
            }
        }
    }

    let mut impacted_pages = Vec::new();
    let mut total_tasks = 0;

    for (page_path, (reasons, tasks)) in page_impact_map {
        let task_list: Vec<String> = tasks.into_iter().collect();
        total_tasks += task_list.len();
        impacted_pages.push(ImpactedPage {
            path: page_path,
            reasons,
            impacted_tasks: task_list,
            requires_rebuild: true,
        });
    }

    let total_impacted_pages = impacted_pages.len();

    Ok(ImpactReport {
        git_ref,
        changed_files,
        affected_symbols: affected_symbols.into_iter().collect(),
        affected_ui_elements: affected_ui_elements.into_iter().collect(),
        impacted_pages,
        total_impacted_pages,
        total_impacted_tasks: total_tasks,
    })
}
