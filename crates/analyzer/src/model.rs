use serde::{Deserialize, Serialize};
use std::path::PathBuf;

fn default_true() -> bool {
    true
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AnalysisConfig {
    #[serde(default = "default_max_loc")]
    pub max_loc: usize,
    #[serde(default = "default_max_functions")]
    pub max_functions: usize,
    #[serde(default = "default_max_classes")]
    pub max_classes: usize,
    #[serde(default)]
    pub architecture: ArchitectureConfig,
}

fn default_max_loc() -> usize {
    300
}
fn default_max_functions() -> usize {
    20
}
fn default_max_classes() -> usize {
    10
}

impl Default for AnalysisConfig {
    fn default() -> Self {
        Self {
            max_loc: 300,
            max_functions: 20,
            max_classes: 10,
            architecture: ArchitectureConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Default)]
pub struct ArchitectureConfig {
    #[serde(default)]
    pub forbidden: Vec<ForbiddenImportRule>,
    #[serde(default)]
    pub independence: Vec<IndependenceRule>,
    #[serde(default)]
    pub layers: Vec<LayerRule>,
    #[serde(default)]
    pub protected: Vec<ProtectedRule>,
    #[serde(default)]
    pub acyclic_siblings: Vec<AcyclicSiblingsRule>,
    #[serde(default)]
    pub ignore_imports: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ProtectedRule {
    pub name: String,
    pub module: String,
    pub allowed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AcyclicSiblingsRule {
    pub name: String,
    pub parent: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ForbiddenImportRule {
    pub name: String,
    pub source: String,
    pub target: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct IndependenceRule {
    pub name: String,
    pub modules: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct LayerRule {
    pub name: String,
    pub layers: Vec<String>,
    #[serde(default)]
    pub closed: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArchitectureViolation {
    pub rule: String,
    pub name: String,
    pub source: String,
    pub target: String,
    pub line: usize,
    pub message: String,
    pub suggestion: String,
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
    pub id: String,            // e.g. "moduleloom.main"
    pub name: String,          // e.g. "main"
    pub relative_path: String, // e.g. "main.py"
    pub absolute_path: PathBuf,
    #[serde(default)]
    pub docstring: Option<String>,
    pub loc: usize,
    #[serde(default)]
    pub cyclomatic_complexity: usize,
    pub class_count: usize,
    #[serde(default)]
    pub classes: Vec<ClassInfo>,
    pub function_count: usize,
    #[serde(default)]
    pub functions: Vec<FunctionInfo>,
    #[serde(default)]
    pub symbols: Vec<SymbolInfo>,
    #[serde(default)]
    pub symbol_calls: Vec<SymbolCall>,
    #[serde(default)]
    pub unused_symbol_candidates: Vec<String>,
    pub imports: Vec<ImportStmt>,
    #[serde(default)]
    pub unresolved_imports: Vec<String>,
    #[serde(default)]
    pub afferent_coupling: usize,
    #[serde(default)]
    pub efferent_coupling: usize,
    pub is_oversized: bool,
    pub diagnostics: Vec<Diagnostic>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ClassInfo {
    pub name: String,
    #[serde(default)]
    pub signature: String,
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_class_line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docstring: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct FunctionInfo {
    pub name: String,
    #[serde(default)]
    pub signature: String,
    pub line: usize,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub parent_class_line: Option<usize>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub docstring: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SymbolInfo {
    pub name: String,
    pub kind: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SymbolCall {
    pub caller: String,
    pub callee: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct SymbolEdge {
    pub source_module: String,
    pub source_symbol: String,
    pub target_module: String,
    pub target_symbol: String,
    pub line: usize,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct PackageDependency {
    pub name: String,
    pub version: Option<String>,
    pub source: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct DependencyIssue {
    pub rule: String,
    pub package: String,
    pub module: Option<String>,
    pub message: String,
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
    /// One real, closed path through top-level imports. The first module is repeated at the end.
    #[serde(default)]
    pub path: Vec<String>,
    #[serde(default)]
    pub suggestion: Option<CycleSuggestion>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "snake_case")]
pub enum CycleSuggestionKind {
    TypeOnly,
    Runtime,
    Unknown,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct CycleSuggestion {
    pub source: String,
    pub target: String,
    pub line: usize,
    pub kind: CycleSuggestionKind,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AnalysisResult {
    pub root_path: PathBuf,
    pub modules: Vec<ModuleInfo>,
    pub edges: Vec<DependencyEdge>,
    pub cycles: Vec<CircularCycle>,
    pub total_loc: usize,
    #[serde(default)]
    pub analysis_errors: Vec<String>,
    #[serde(default)]
    pub architecture_violations: Vec<ArchitectureViolation>,
    #[serde(default)]
    pub symbol_edges: Vec<SymbolEdge>,
    #[serde(default)]
    pub package_dependencies: Vec<PackageDependency>,
    #[serde(default)]
    pub dependency_issues: Vec<DependencyIssue>,
}
