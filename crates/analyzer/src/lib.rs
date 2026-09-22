//! Python module analyzer core
//! High-speed Python AST parsing, dependency extraction, circular import detection, and metrics calculation.

pub mod model;
pub mod parser;
pub mod graph;
pub mod metrics;
pub mod diagnostics;

use model::AnalysisResult;
use std::path::Path;

pub fn analyze_directory(root: &Path) -> Result<AnalysisResult, String> {
    let modules = parser::scan_directory(root)?;
    let (edges, cycles) = graph::build_graph(&modules);
    let total_loc: usize = modules.iter().map(|m| m.loc).sum();

    Ok(AnalysisResult {
        root_path: root.to_path_buf(),
        modules,
        edges,
        cycles,
        total_loc,
    })
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

        fs::write(&mod_a, "from app.b import func_b\ndef func_a():\n    pass\n").unwrap();
        fs::write(&mod_b, "from app.a import func_a\ndef func_b():\n    pass\n").unwrap();

        let res = analyze_directory(dir.path()).expect("Analysis should succeed");
        assert_eq!(res.modules.len(), 2);
        assert_eq!(res.cycles.len(), 1, "Should detect circular import between a and b");
        assert!(res.edges.iter().all(|e| e.is_circular));
    }
}
