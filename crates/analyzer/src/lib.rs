//! Python module analyzer core
//! High-speed Python AST parsing, dependency extraction, circular import detection, and metrics calculation.

pub mod architecture;
pub mod dependencies;
pub mod diagnostics;
pub mod graph;
pub mod metrics;
pub mod model;
pub mod parser;

use model::{AnalysisConfig, AnalysisResult, ForbiddenImportRule, IndependenceRule, LayerRule};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::Path;

pub fn analyze_directory(root: &Path) -> Result<AnalysisResult, String> {
    let config = load_config(root)?;
    analyze_directory_with_config(root, &config)
}

pub fn analyze_directory_with_config(
    root: &Path,
    config: &AnalysisConfig,
) -> Result<AnalysisResult, String> {
    let (modules, analysis_errors) = parser::scan_directory_with_config(root, config)?;
    let (edges, cycles) = graph::build_graph(&modules);
    let architecture_violations =
        architecture::check_architecture(&modules, &edges, &config.architecture);
    let symbol_edges = build_symbol_edges(&modules);
    let cross_file_references = build_cross_file_reference_index(&symbol_edges);
    let package_dependencies = dependencies::scan_package_dependencies(root);
    let unresolved_imports = graph::collect_unresolved_imports(&modules);
    let total_loc: usize = modules.iter().map(|m| m.loc).sum();

    let mut modules = modules;
    for module in &mut modules {
        module.efferent_coupling = edges.iter().filter(|edge| edge.source == module.id).count();
        module.afferent_coupling = edges.iter().filter(|edge| edge.target == module.id).count();
        module.unresolved_imports = unresolved_imports
            .get(&module.id)
            .cloned()
            .unwrap_or_default();
        let referenced_locally: std::collections::HashSet<String> = module
            .symbol_calls
            .iter()
            .map(|call| call.callee.clone())
            .collect();
        let referenced_cross_file = cross_file_references
            .get(&module.id)
            .cloned()
            .unwrap_or_default();
        module.unused_symbol_candidates = module
            .symbols
            .iter()
            .filter(|symbol| symbol.name != "__init__" && !symbol.name.ends_with(".__init__"))
            .filter(|symbol| {
                let short_name = symbol.name.rsplit('.').next().unwrap_or(&symbol.name);
                !referenced_locally.contains(short_name)
                    && !referenced_locally.contains(&symbol.name)
                    && !referenced_cross_file.contains(&symbol.name)
            })
            .map(|symbol| symbol.name.clone())
            .collect();
    }

    Ok(AnalysisResult {
        root_path: root.to_path_buf(),
        modules,
        edges,
        cycles,
        total_loc,
        analysis_errors,
        architecture_violations,
        symbol_edges,
        package_dependencies,
    })
}

fn build_symbol_edges(modules: &[model::ModuleInfo]) -> Vec<model::SymbolEdge> {
    let mut symbol_index: HashMap<String, Vec<(String, String)>> = HashMap::new();
    for module in modules {
        for symbol in &module.symbols {
            let candidate = (module.id.clone(), symbol.name.clone());
            symbol_index
                .entry(symbol.name.clone())
                .or_default()
                .push(candidate.clone());
            if let Some(short_name) = symbol.name.rsplit('.').next() {
                if short_name != symbol.name {
                    symbol_index
                        .entry(short_name.to_string())
                        .or_default()
                        .push(candidate);
                }
            }
        }
    }

    let mut result = Vec::new();
    for source in modules {
        for call in &source.symbol_calls {
            let candidates = symbol_index.get(&call.callee).into_iter().flatten();
            let unique_candidates: HashSet<(String, String)> = candidates.cloned().collect();
            let unique_modules: HashSet<&str> = unique_candidates
                .iter()
                .map(|(module, _)| module.as_str())
                .collect();
            if unique_modules.len() == 1 {
                let (target_module, target_symbol) = unique_candidates.into_iter().next().unwrap();
                result.push(model::SymbolEdge {
                    source_module: source.id.clone(),
                    source_symbol: call.caller.clone(),
                    target_module,
                    target_symbol,
                    line: call.line,
                });
            }
        }
    }
    result
}

fn build_cross_file_reference_index(
    symbol_edges: &[model::SymbolEdge],
) -> HashMap<String, HashSet<String>> {
    let mut references = HashMap::new();
    for edge in symbol_edges {
        references
            .entry(edge.target_module.clone())
            .or_insert_with(HashSet::new)
            .insert(edge.target_symbol.clone());
    }
    references
}

pub fn load_config(root: &Path) -> Result<AnalysisConfig, String> {
    let config_path = root.join("moduleloom.toml");
    if !config_path.exists() {
        return Ok(AnalysisConfig::default());
    }

    let content = fs::read_to_string(&config_path)
        .map_err(|e| format!("Failed to read {}: {}", config_path.display(), e))?;
    let mut config = AnalysisConfig::default();
    let mut in_thresholds = false;

    for (line_number, raw_line) in content.lines().enumerate() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            in_thresholds = &line[1..line.len() - 1] == "thresholds";
            continue;
        }
        if !in_thresholds {
            continue;
        }

        let Some((key, value)) = line.split_once('=') else {
            return Err(format!(
                "Invalid config at {}:{}",
                config_path.display(),
                line_number + 1
            ));
        };
        let parsed = value.trim().parse::<usize>().map_err(|_| {
            format!(
                "Invalid numeric value at {}:{}",
                config_path.display(),
                line_number + 1
            )
        })?;
        match key.trim() {
            "max_loc" => config.max_loc = parsed,
            "max_functions" => config.max_functions = parsed,
            "max_classes" => config.max_classes = parsed,
            _ => {}
        }
    }

    parse_architecture_config(&content, &mut config)?;
    Ok(config)
}

fn parse_architecture_config(content: &str, config: &mut AnalysisConfig) -> Result<(), String> {
    let mut section = String::new();
    let mut forbidden: HashMap<String, (Option<String>, Option<String>)> = HashMap::new();
    let mut independence: HashMap<String, Vec<String>> = HashMap::new();
    let mut layers: HashMap<String, Vec<String>> = HashMap::new();

    for raw_line in content.lines() {
        let line = raw_line.split('#').next().unwrap_or("").trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with('[') && line.ends_with(']') {
            section = line[1..line.len() - 1].to_string();
            continue;
        }
        let Some((key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = key.trim();
        let value = raw_value.trim().trim_matches('"');
        if let Some(name) = section.strip_prefix("architecture.forbidden.") {
            let entry = forbidden.entry(name.to_string()).or_insert((None, None));
            match key {
                "source" => entry.0 = Some(value.to_string()),
                "target" => entry.1 = Some(value.to_string()),
                _ => {}
            }
        } else if let Some(name) = section.strip_prefix("architecture.independence.") {
            if key == "modules" {
                independence.insert(name.to_string(), split_list(value));
            }
        } else if let Some(name) = section.strip_prefix("architecture.layers.") {
            if key == "layers" {
                layers.insert(name.to_string(), split_list(value));
            }
        }
    }

    config.architecture.forbidden = forbidden
        .into_iter()
        .filter_map(|(name, (source, target))| {
            Some(ForbiddenImportRule {
                name,
                source: source?,
                target: target?,
            })
        })
        .collect();
    config.architecture.independence = independence
        .into_iter()
        .map(|(name, modules)| IndependenceRule { name, modules })
        .collect();
    config.architecture.layers = layers
        .into_iter()
        .map(|(name, layers)| LayerRule { name, layers })
        .collect();
    Ok(())
}

fn split_list(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(str::to_string)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use rustpython_parser::{ast, Parse};
    use std::fs;
    use tempfile::tempdir;

    #[test]
    fn test_parse_sample_python() {
        let source = "import os\nfrom sys import path\n\ndef hello():\n    return 'world'\n";
        let parsed = ast::Suite::parse(source, "<embedded>");
        assert!(parsed.is_ok(), "Python parsing should succeed");
    }

    #[test]
    fn test_analyze_directory_e2e() {
        let dir = tempdir().unwrap();
        let app_dir = dir.path().join("app");
        fs::create_dir(&app_dir).unwrap();

        let mod_a = app_dir.join("a.py");
        let mod_b = app_dir.join("b.py");

        fs::write(
            &mod_a,
            "from app.b import func_b\ndef func_a():\n    pass\n",
        )
        .unwrap();
        fs::write(
            &mod_b,
            "from app.a import func_a\ndef func_b():\n    pass\n",
        )
        .unwrap();

        let res = analyze_directory(dir.path()).expect("Analysis should succeed");
        assert_eq!(res.modules.len(), 2);
        assert_eq!(
            res.cycles.len(),
            1,
            "Should detect circular import between a and b"
        );
        assert!(res.edges.iter().all(|e| e.is_circular));
    }

    #[test]
    fn test_project_config_overrides_bloat_thresholds() {
        let dir = tempdir().unwrap();
        fs::write(
            dir.path().join("moduleloom.toml"),
            "[thresholds]\nmax_loc = 2\nmax_functions = 50\nmax_classes = 50\n",
        )
        .unwrap();
        fs::write(
            dir.path().join("module.py"),
            "line_one = 1\nline_two = 2\nline_three = 3\n",
        )
        .unwrap();

        let res = analyze_directory(dir.path()).unwrap();
        assert!(res.modules[0].is_oversized);
        assert!(res.modules[0]
            .diagnostics
            .iter()
            .any(|d| d.rule.as_deref() == Some("module-bloat")));
    }

    #[test]
    fn test_architecture_rules_are_reported() {
        let dir = tempdir().unwrap();
        let api = dir.path().join("app/api");
        let db = dir.path().join("app/db");
        fs::create_dir_all(&api).unwrap();
        fs::create_dir_all(&db).unwrap();
        fs::write(
            dir.path().join("moduleloom.toml"),
            "[architecture.forbidden.api_db]\nsource = \"app.api\"\ntarget = \"app.db\"\n",
        )
        .unwrap();
        fs::write(api.join("routes.py"), "from app.db import models\n").unwrap();
        fs::write(db.join("models.py"), "value = 1\n").unwrap();

        let res = analyze_directory(dir.path()).unwrap();
        assert_eq!(res.architecture_violations.len(), 1);
        assert_eq!(
            res.architecture_violations[0].rule,
            "architecture-forbidden"
        );
    }
}
