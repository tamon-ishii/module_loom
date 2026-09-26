use serde::{Deserialize, Serialize};
use std::fs;
use std::path::{Path, PathBuf};

pub const DEFAULT_BRIEF: &str = "# マニュアル作成の指示\n\n## 対象読者\n\n## 目的\n\n## 含める操作\n\n## 追加の指示\n";

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MkDocsConfig {
    pub site_name: String,
    pub theme: String,
    pub language: String,
    pub use_directory_urls: bool,
}

impl Default for MkDocsConfig {
    fn default() -> Self {
        Self {
            site_name: "ModuleLoom マニュアル".to_string(),
            theme: "material".to_string(),
            language: "ja".to_string(),
            use_directory_urls: false,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ManualConfig {
    pub docs: String,
    pub output: String,
    pub format: String,
    pub agent: String,
    pub model: String,
    pub mkdocs: MkDocsConfig,
}

impl Default for ManualConfig {
    fn default() -> Self {
        Self {
            docs: "docs".to_string(),
            output: "manual".to_string(),
            format: "mkdocs".to_string(),
            agent: "codex".to_string(),
            model: "".to_string(),
            mkdocs: MkDocsConfig::default(),
        }
    }
}

pub fn config_path(root: &Path) -> PathBuf {
    root.join("manual").join("config.json")
}

pub fn read_config(root: &Path) -> ManualConfig {
    let path = config_path(root);
    if !path.is_file() {
        return ManualConfig::default();
    }
    let content = match fs::read_to_string(&path) {
        Ok(c) => c,
        Err(_) => return ManualConfig::default(),
    };
    let value: serde_json::Value = match serde_json::from_str(&content) {
        Ok(v) => v,
        Err(_) => return ManualConfig::default(),
    };

    let mut config = ManualConfig::default();
    if let Some(d) = value.get("docs").and_then(|v| v.as_str()) {
        config.docs = d.to_string();
    }
    if let Some(o) = value.get("output").and_then(|v| v.as_str()) {
        config.output = o.to_string();
    }
    if let Some(f) = value.get("format").and_then(|v| v.as_str()) {
        config.format = f.to_string();
    }
    if let Some(a) = value.get("agent").and_then(|v| v.as_str()) {
        if ["codex", "claude", "grok", "agy"].contains(&a) {
            config.agent = a.to_string();
        }
    }
    if let Some(m) = value.get("model").and_then(|v| v.as_str()) {
        config.model = m.to_string();
    }
    if let Some(mk) = value.get("mkdocs").and_then(|v| v.as_object()) {
        if let Some(sn) = mk.get("site_name").and_then(|v| v.as_str()) {
            config.mkdocs.site_name = sn.to_string();
        }
        if let Some(th) = mk.get("theme").and_then(|v| v.as_str()) {
            config.mkdocs.theme = th.to_string();
        }
        if let Some(lg) = mk.get("language").and_then(|v| v.as_str()) {
            config.mkdocs.language = lg.to_string();
        }
        if let Some(du) = mk.get("use_directory_urls").and_then(|v| v.as_bool()) {
            config.mkdocs.use_directory_urls = du;
        }
    }

    config
}

pub fn project_path(root: &Path, value: &str) -> Result<PathBuf, String> {
    let abs_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let target = root.join(value);
    let abs_target = if target.exists() {
        target.canonicalize().map_err(|e| e.to_string())?
    } else {
        // 対象がまだ存在しない場合、親ディレクトリで正規化
        if let Some(parent) = target.parent() {
            if parent.exists() {
                let abs_parent = parent.canonicalize().map_err(|e| e.to_string())?;
                if let Some(file_name) = target.file_name() {
                    abs_parent.join(file_name)
                } else {
                    abs_parent
                }
            } else {
                target
            }
        } else {
            target
        }
    };

    if !abs_target.starts_with(&abs_root) {
        return Err(format!("Manual path must stay inside the project: {value}"));
    }
    Ok(abs_target)
}

pub fn save_settings(
    root: &Path,
    docs: &str,
    output: &str,
    brief: &str,
    agent: &str,
    model: &str,
    doc_format: &str,
    mkdocs_raw: &str,
) -> Result<ManualConfig, String> {
    let docs_path = project_path(root, docs)?;
    let output_path = project_path(root, output)?;

    if docs_path == output_path || docs_path.starts_with(&output_path) || output_path.starts_with(&docs_path) {
        return Err("Template and output directories must be separate".to_string());
    }
    let final_brief = if brief.trim().is_empty() {
        let existing = root.join("manual").join("brief.md");
        if existing.is_file() {
            fs::read_to_string(&existing).unwrap_or_else(|_| DEFAULT_BRIEF.to_string())
        } else {
            DEFAULT_BRIEF.to_string()
        }
    } else {
        brief.to_string()
    };
    if !["codex", "claude", "grok", "agy"].contains(&agent) {
        return Err(format!("Unsupported AI agent: {agent}"));
    }
    if model.len() > 120 || model.contains('\n') {
        return Err("Invalid model ID".to_string());
    }

    let mut mkdocs_cfg = MkDocsConfig::default();
    if !mkdocs_raw.trim().is_empty() {
        if let Ok(parsed) = serde_json::from_str::<serde_json::Value>(mkdocs_raw) {
            if let Some(obj) = parsed.as_object() {
                if let Some(sn) = obj.get("site_name").and_then(|v| v.as_str()) {
                    mkdocs_cfg.site_name = sn.to_string();
                }
                if let Some(th) = obj.get("theme").and_then(|v| v.as_str()) {
                    mkdocs_cfg.theme = th.to_string();
                }
                if let Some(lg) = obj.get("language").and_then(|v| v.as_str()) {
                    mkdocs_cfg.language = lg.to_string();
                }
                if let Some(du) = obj.get("use_directory_urls").and_then(|v| v.as_bool()) {
                    mkdocs_cfg.use_directory_urls = du;
                }
            }
        }
    }

    let abs_root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
    let rel_docs = docs_path.strip_prefix(&abs_root).unwrap_or(&docs_path).to_string_lossy().into_owned();
    let rel_output = output_path.strip_prefix(&abs_root).unwrap_or(&output_path).to_string_lossy().into_owned();

    let config = ManualConfig {
        docs: rel_docs,
        output: rel_output,
        format: doc_format.to_string(),
        agent: agent.to_string(),
        model: model.trim().to_string(),
        mkdocs: mkdocs_cfg,
    };

    let dest = config_path(root);
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    let json_bytes = serde_json::to_string_pretty(&config).map_err(|e| e.to_string())?;
    fs::write(&dest, format!("{json_bytes}\n")).map_err(|e| e.to_string())?;

    let brief_path = root.join("manual").join("brief.md");
    if let Some(parent) = brief_path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&brief_path, format!("{}\n", final_brief.trim_end())).map_err(|e| e.to_string())?;

    Ok(config)
}
