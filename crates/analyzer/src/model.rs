use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ImportStmt {
    pub module: String,
    pub is_from: bool,
    pub level: usize, // 0 for absolute, >0 for relative
    pub line: usize,
    pub imported_names: Vec<String>,
    #[serde(default = "default_true")]
    pub is_top_level: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ModuleInfo {
    pub id: String,               // e.g. "moduleloom.main"
    pub name: String,             // e.g. "main"
    pub relative_path: String,    // e.g. "main.py"
    pub absolute_path: PathBuf,
    #[serde(default)]
    pub docstring: Option<String>,
    pub loc: usize,
    pub class_count: usize,
    #[serde(default)]
    pub classes: Vec<ClassInfo>,
    pub function_count: usize,
    #[serde(default)]
    pub functions: Vec<FunctionInfo>,
    pub imports: Vec<ImportStmt>,
    pub is_oversized: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClassInfo {
    pub name: String,
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_class_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionInfo {
    pub name: String,
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_class_line: Option<usize>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct Diagnostic {
    pub severity: DiagnosticSeverity,
    pub message: String,
    pub line: Option<usize>,
    pub rule: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
pub enum DiagnosticSeverity {
    Info,
    Warning,
    Error,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DependencyEdge {
    pub source: String,
    pub target: String,
    pub is_circular: bool,
    pub line: usize,
    pub import_count: usize,
    #[serde(default = "default_true")]
    pub is_top_level: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CircularCycle {
    pub modules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub root_path: PathBuf,
    pub modules: Vec<ModuleInfo>,
    pub edges: Vec<DependencyEdge>,
    pub cycles: Vec<CircularCycle>,
    pub total_loc: usize,
}
