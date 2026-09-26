use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;
use walkdir::WalkDir;

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct UIMap {
    pub project_name: String,
    pub views: Vec<UIView>,
    pub total_elements: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIView {
    pub id: String,
    pub name: String,
    pub description: Option<String>,
    pub elements: Vec<UIElement>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UIElement {
    pub id: String,
    pub selector: String,
    pub name: String,
    pub role: String,
    pub title: Option<String>,
    pub parent_view: String,
}

pub fn extract_ui_map(root: &Path) -> UIMap {
    // Check if custom UI map JSON already exists
    let custom_path = root.join("manual").join("ui_map.json");
    if custom_path.is_file() {
        if let Ok(content) = fs::read_to_string(&custom_path) {
            if let Ok(map) = serde_json::from_str::<UIMap>(&content) {
                return map;
            }
        }
    }

    let mut views: Vec<UIView> = Vec::new();
    let mut total_elements = 0;

    // Collect HTML files: check root index.html first, then subdirectories
    let mut html_files = Vec::new();
    let root_index = root.join("index.html");
    if root_index.is_file() {
        html_files.push(root_index);
    } else {
        // Also check parent directory if root is sample_project
        if let Some(parent) = root.parent() {
            let parent_index = parent.join("index.html");
            if parent_index.is_file() {
                html_files.push(parent_index);
            }
        }
    }

    for entry in WalkDir::new(root)
        .max_depth(3)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        if p.is_file()
            && p.extension().is_some_and(|ext| ext == "html")
            && !html_files.contains(&p.to_path_buf())
        {
            html_files.push(p.to_path_buf());
        }
    }

    let section_re = Regex::new(
        r#"(?is)<section\s+[^>]*id=["']([^"']+)["']([^>]*)>(.*?)</section>"#,
    )
    .unwrap();
    let aria_re = Regex::new(r#"aria-labelledby=["']([^"']+)["']"#).unwrap();
    let tab_re =
        Regex::new(r#"(?is)<button\s+[^>]*id=["']([^"']+)["'][^>]*role=["']tab["'][^>]*>(.*?)</button>"#)
            .unwrap();
    let btn_re = Regex::new(
        r#"(?is)<button\s+[^>]*id=["']([^"']+)["']([^>]*)>(.*?)</button>"#,
    )
    .unwrap();
    let input_re = Regex::new(
        r#"(?is)<(?:input|select)\s+[^>]*id=["']([^"']+)["']([^>]*)>"#,
    )
    .unwrap();
    let modal_re = Regex::new(
        r#"(?is)<div\s+[^>]*id=["']([^"']+)["'][^>]*class=["'][^"']*modal[^"']*["']([^>]*)>(.*?)</div>\s*</div>"#,
    )
    .unwrap();
    let modal_title_re =
        Regex::new(r#"(?is)<(?:strong|h2|h3|h4)\s+[^>]*class=["'][^"']*modal-title[^"']*["'][^>]*>(.*?)</(?:strong|h2|h3|h4)>"#).unwrap();
    let title_attr_re = Regex::new(r#"title=["']([^"']+)["']"#).unwrap();
    let tag_strip_re = Regex::new(r#"<[^>]+>"#).unwrap();

    let clean_text = |s: &str| -> String {
        let stripped = tag_strip_re.replace_all(s, " ");
        stripped.split_whitespace().collect::<Vec<_>>().join(" ")
    };

    let mut tab_names = std::collections::HashMap::new();

    for html_file in &html_files {
        let Ok(content) = fs::read_to_string(html_file) else {
            continue;
        };

        // Extract tab names
        for cap in tab_re.captures_iter(&content) {
            let id = cap[1].to_string();
            let label = clean_text(&cap[2]);
            if !label.is_empty() {
                tab_names.insert(id, label);
            }
        }

        // Extract sections / views
        for cap in section_re.captures_iter(&content) {
            let view_id = cap[1].to_string();
            let attrs = &cap[2];
            let inner = &cap[3];
            let label_id = aria_re.captures(attrs).map(|m| m[1].to_string());
            let view_name = label_id
                .as_ref()
                .and_then(|id| tab_names.get(id))
                .cloned()
                .unwrap_or_else(|| view_id.clone());

            let mut elements = Vec::new();

            for bcap in btn_re.captures_iter(inner) {
                let el_id = bcap[1].to_string();
                let attrs = &bcap[2];
                let raw_text = &bcap[3];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());
                let name = clean_text(raw_text);

                if !name.is_empty() || title.is_some() {
                    elements.push(UIElement {
                        id: el_id.clone(),
                        selector: format!("#{el_id}"),
                        name: if !name.is_empty() {
                            name
                        } else {
                            title.clone().unwrap_or_else(|| el_id.clone())
                        },
                        role: "button".to_string(),
                        title,
                        parent_view: view_id.clone(),
                    });
                }
            }

            for icap in input_re.captures_iter(inner) {
                let el_id = icap[1].to_string();
                let attrs = &icap[2];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());

                elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: title.clone().unwrap_or_else(|| el_id.clone()),
                    role: "input".to_string(),
                    title,
                    parent_view: view_id.clone(),
                });
            }

            total_elements += elements.len();
            views.push(UIView {
                id: view_id,
                name: view_name,
                description: None,
                elements,
            });
        }

        // Modals as views
        for mcap in modal_re.captures_iter(&content) {
            let modal_id = mcap[1].to_string();
            let modal_inner = &mcap[3];
            let modal_name = modal_title_re
                .captures(modal_inner)
                .map(|m| clean_text(&m[1]))
                .unwrap_or_else(|| modal_id.clone());

            let mut modal_elements = Vec::new();
            for bcap in btn_re.captures_iter(modal_inner) {
                let el_id = bcap[1].to_string();
                let attrs = &bcap[2];
                let raw_text = &bcap[3];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());
                let name = clean_text(raw_text);

                modal_elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: if !name.is_empty() {
                        name
                    } else {
                        title.clone().unwrap_or_else(|| el_id.clone())
                    },
                    role: "button".to_string(),
                    title,
                    parent_view: modal_id.clone(),
                });
            }

            for icap in input_re.captures_iter(modal_inner) {
                let el_id = icap[1].to_string();
                let attrs = &icap[2];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());

                modal_elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: title.clone().unwrap_or_else(|| el_id.clone()),
                    role: "input".to_string(),
                    title,
                    parent_view: modal_id.clone(),
                });
            }

            total_elements += modal_elements.len();
            views.push(UIView {
                id: modal_id,
                name: modal_name,
                description: Some("ダイアログ/モーダル".to_string()),
                elements: modal_elements,
            });
        }

        // If no structured views (sections/modals) were found, collect all buttons and inputs
        if views.is_empty() {
            let mut elements = Vec::new();
            for bcap in btn_re.captures_iter(&content) {
                let el_id = bcap[1].to_string();
                let attrs = &bcap[2];
                let raw_text = &bcap[3];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());
                let name = clean_text(raw_text);
                elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: if !name.is_empty() {
                        name
                    } else {
                        title.clone().unwrap_or_else(|| el_id.clone())
                    },
                    role: "button".to_string(),
                    title,
                    parent_view: "main-view".to_string(),
                });
            }

            for icap in input_re.captures_iter(&content) {
                let el_id = icap[1].to_string();
                let attrs = &icap[2];
                let title = title_attr_re
                    .captures(attrs)
                    .map(|m| clean_text(&m[1]))
                    .filter(|s| !s.is_empty());

                elements.push(UIElement {
                    id: el_id.clone(),
                    selector: format!("#{el_id}"),
                    name: title.clone().unwrap_or_else(|| el_id.clone()),
                    role: "input".to_string(),
                    title,
                    parent_view: "main-view".to_string(),
                });
            }

            if !elements.is_empty() {
                total_elements += elements.len();
                views.push(UIView {
                    id: "main-view".to_string(),
                    name: "Main View".to_string(),
                    description: Some("メイン画面".to_string()),
                    elements,
                });
            }
        }
    }

    // Also scan TS/JS files for DOM elements (getElementById, querySelector)
    let ts_elem_re = Regex::new(r#"(?:getElementById|querySelector)\(["']#?([a-zA-Z0-9_-]+)["']\)"#).unwrap();
    let mut ts_elements = Vec::new();
    let known_ids: HashSet<String> = views
        .iter()
        .flat_map(|v| v.elements.iter().map(|e| e.id.clone()))
        .collect();

    for entry in WalkDir::new(root)
        .max_depth(4)
        .into_iter()
        .filter_map(Result::ok)
    {
        let p = entry.path();
        if p.is_file() && (p.extension().is_some_and(|ext| ext == "ts" || ext == "js")) {
            if let Ok(src) = fs::read_to_string(p) {
                for cap in ts_elem_re.captures_iter(&src) {
                    let el_id = cap[1].to_string();
                    if !known_ids.contains(&el_id) && !ts_elements.iter().any(|e: &UIElement| e.id == el_id) {
                        ts_elements.push(UIElement {
                            id: el_id.clone(),
                            selector: format!("#{el_id}"),
                            name: el_id.clone(),
                            role: "component".to_string(),
                            title: None,
                            parent_view: "dynamic".to_string(),
                        });
                    }
                }
            }
        }
    }

    if !ts_elements.is_empty() {
        total_elements += ts_elements.len();
        if let Some(first_view) = views.first_mut() {
            first_view.elements.extend(ts_elements);
        } else {
            views.push(UIView {
                id: "dynamic-view".to_string(),
                name: "Dynamic View".to_string(),
                description: Some("スクリプト制御要素".to_string()),
                elements: ts_elements,
            });
        }
    }

    let project_name = root
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("app")
        .to_string();

    UIMap {
        project_name,
        views,
        total_elements,
    }
}

pub fn save_ui_map(root: &Path, ui_map: &UIMap) -> Result<(), String> {
    let dest_dir = root.join("manual");
    fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;
    let path = dest_dir.join("ui_map.json");
    let json = serde_json::to_string_pretty(ui_map).map_err(|e| e.to_string())?;
    fs::write(path, json).map_err(|e| e.to_string())
}
