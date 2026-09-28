use regex::Regex;
use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::fs;
use std::path::Path;

use super::config::{project_path, read_config};
use super::task::{
    collect_target_markdown_files, get_code_block_ranges, is_inside_ranges, parse_page_tags,
    PageTag,
};
use super::uimap::extract_ui_map;
use crate::analyze_directory;

#[derive(Deserialize)]
struct FactClaim {
    claim: String,
    #[serde(default)]
    file: Option<String>,
    #[serde(default)]
    contains: Option<String>,
    #[serde(default)]
    ui: Option<String>,
    #[serde(default)]
    symbol: Option<String>,
}

#[derive(Serialize)]
struct FactResult {
    page: String,
    claim: String,
    passed: bool,
    issues: Vec<String>,
}

#[derive(Serialize)]
struct FactReport {
    checked: usize,
    passed: usize,
    failed: usize,
    unreviewed_text_tasks: Vec<String>,
    results: Vec<FactResult>,
}

fn known_evidence(root: &Path) -> (HashSet<String>, HashSet<String>) {
    let ui_map = extract_ui_map(root);
    let selectors = ui_map
        .views
        .iter()
        .flat_map(|view| view.elements.iter().map(|element| element.selector.clone()))
        .collect();
    let mut symbols = HashSet::new();
    if let Ok(analysis) = analyze_directory(root) {
        for module in analysis.modules {
            symbols.insert(module.id.clone());
            for class in module.classes {
                symbols.insert(class.name.clone());
                symbols.insert(format!("{}.{}", module.id, class.name));
            }
            for function in module.functions {
                symbols.insert(function.name.clone());
                symbols.insert(format!("{}.{}", module.id, function.name));
            }
        }
    }
    (selectors, symbols)
}

fn check_claim(
    root: &Path,
    fact: &FactClaim,
    selectors: &HashSet<String>,
    symbols: &HashSet<String>,
) -> Vec<String> {
    let mut issues = Vec::new();
    if fact.file.is_none() && fact.ui.is_none() && fact.symbol.is_none() {
        issues.push("No evidence reference".to_string());
    }
    if let Some(file) = &fact.file {
        match project_path(root, file) {
            Ok(absolute) if absolute.is_file() => {
                if let Some(needle) = &fact.contains {
                    let source = fs::read_to_string(&absolute).unwrap_or_default();
                    if needle.is_empty() || !source.contains(needle) {
                        issues.push(format!("Text is missing from {file}: {needle}"));
                    }
                }
            }
            _ => issues.push(format!("Source file is missing: {file}")),
        }
    } else if fact.contains.is_some() {
        issues.push("contains requires file".to_string());
    }
    if let Some(ui) = &fact.ui {
        if !selectors.contains(ui) {
            issues.push(format!("UI element is missing: {ui}"));
        }
    }
    if let Some(symbol) = &fact.symbol {
        if !symbols.contains(symbol) {
            issues.push(format!("Python symbol is missing: {symbol}"));
        }
    }
    issues
}

pub fn verify_generated_body(root: &Path, body: &str) -> Result<(), String> {
    let (selectors, symbols) = known_evidence(root);
    let pattern = Regex::new(r"(?s)<!--\s*ai:fact\s+(.*?)\s*-->").unwrap();
    let fences = get_code_block_ranges(body);
    for found in pattern.captures_iter(body) {
        let full = found.get(0).unwrap();
        if is_inside_ranges(&(full.start()..full.end()), &fences) {
            continue;
        }
        let fact: FactClaim = serde_json::from_str(&found[1])
            .map_err(|error| format!("Invalid generated ai:fact: {error}"))?;
        if fact.claim.trim().is_empty() {
            return Err("Empty generated ai:fact claim".into());
        }
        let issues = check_claim(root, &fact, &selectors, &symbols);
        if !issues.is_empty() {
            return Err(format!(
                "Generated claim '{}' has unsupported evidence: {}",
                fact.claim,
                issues.join("; ")
            ));
        }
    }
    Ok(())
}

pub fn verify(root: &Path, strict: bool) -> Result<String, String> {
    let config = read_config(root);
    let (selectors, symbols) = known_evidence(root);
    let pattern = Regex::new(r"(?s)<!--\s*ai:fact\s+(.*?)\s*-->").unwrap();
    let mut results = Vec::new();
    let mut unreviewed_text_tasks = Vec::new();
    for (page, path) in collect_target_markdown_files(root, &config) {
        let content = fs::read_to_string(&path).map_err(|error| error.to_string())?;
        let fences = get_code_block_ranges(&content);
        let mut fact_ranges = Vec::new();
        for found in pattern.captures_iter(&content) {
            let full = found.get(0).unwrap();
            if is_inside_ranges(&(full.start()..full.end()), &fences) {
                continue;
            }
            let fact: FactClaim = serde_json::from_str(&found[1])
                .map_err(|error| format!("Invalid ai:fact in {page}: {error}"))?;
            if fact.claim.trim().is_empty() {
                return Err(format!("Empty ai:fact claim in {page}"));
            }
            let issues = check_claim(root, &fact, &selectors, &symbols);
            fact_ranges.push(full.start()..full.end());
            results.push(FactResult {
                page: page.clone(),
                claim: fact.claim,
                passed: issues.is_empty(),
                issues,
            });
        }
        let mut ids = HashSet::new();
        for tag in parse_page_tags(&page, &content, &mut ids)? {
            if let PageTag::Generated { range, task, .. } = tag {
                if task.kind == "text"
                    && !fact_ranges
                        .iter()
                        .any(|fact| fact.start >= range.start && fact.end <= range.end)
                {
                    unreviewed_text_tasks.push(task.id);
                }
            }
        }
    }
    let passed = results.iter().filter(|result| result.passed).count();
    let report = FactReport {
        checked: results.len(),
        passed,
        failed: results.len() - passed,
        unreviewed_text_tasks,
        results,
    };
    let json = serde_json::to_string_pretty(&report).map_err(|error| error.to_string())?;
    if strict && report.failed > 0 {
        return Err(format!(
            "Evidence check failed for {} claim(s):\n{json}",
            report.failed
        ));
    }
    Ok(json)
}

#[cfg(test)]
mod tests {
    use super::{verify, verify_generated_body};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn explicit_evidence_passes_and_missing_source_fails_check() {
        let tmp = tempdir().unwrap();
        let root = tmp.path();
        fs::create_dir_all(root.join("docs")).unwrap();
        fs::create_dir_all(root.join("src")).unwrap();
        fs::write(root.join("src/settings.rs"), "fn save_settings() {}\n").unwrap();
        fs::write(
            root.join("index.html"),
            "<section id=\"settings\"><button id=\"save\">Save</button></section>",
        )
        .unwrap();
        fs::write(root.join("docs/index.md"), "# Guide\n<!-- ai:fact {\"claim\":\"Save exists\",\"file\":\"src/settings.rs\",\"contains\":\"save_settings\",\"ui\":\"#save\"} -->\n").unwrap();
        let good: serde_json::Value = serde_json::from_str(&verify(root, true).unwrap()).unwrap();
        assert_eq!(good["passed"], 1);
        assert!(verify_generated_body(root, "text <!-- ai:fact {\"claim\":\"Save exists\",\"file\":\"src/settings.rs\",\"contains\":\"save_settings\"} -->").is_ok());
        fs::write(root.join("src/settings.rs"), "fn other() {}\n").unwrap();
        assert!(verify(root, true)
            .unwrap_err()
            .contains("Evidence check failed"));
        assert!(verify_generated_body(root, "text <!-- ai:fact {\"claim\":\"Save exists\",\"file\":\"src/settings.rs\",\"contains\":\"save_settings\"} -->").is_err());
    }
}
