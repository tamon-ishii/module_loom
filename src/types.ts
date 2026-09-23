export interface ImportStmt {
  module: string;
  is_from: boolean;
  level: number;
  line: number;
  imported_names: string[];
  is_top_level?: boolean;
}

export interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  line?: number;
  rule?: string;
}

export interface ModuleInfo {
  id: string;
  name: string;
  relative_path: string;
  absolute_path: string;
  docstring?: string | null;
  loc: number;
  cyclomatic_complexity?: number;
  class_count: number;
  classes?: { name: string; line: number; docstring?: string | null }[];
  function_count: number;
  functions?: { name: string; line: number; docstring?: string | null }[];
  symbols?: { name: string; kind: string; line: number }[];
  symbol_calls?: { caller: string; callee: string; line: number }[];
  unused_symbol_candidates?: string[];
  imports: ImportStmt[];
  unresolved_imports?: string[];
  afferent_coupling?: number;
  efferent_coupling?: number;
  is_oversized: boolean;
  diagnostics: Diagnostic[];
}

export interface DependencyEdge {
  source: string;
  target: string;
  is_circular: boolean;
  line: number;
  import_count?: number;
  is_top_level?: boolean;
}

export interface CircularCycle {
  modules: string[];
  path?: string[];
  suggestion?: {
    source: string;
    target: string;
    line: number;
    kind: "type_only" | "runtime" | "unknown";
  } | null;
}

export interface SymbolEdge {
  source_module: string;
  source_symbol: string;
  target_module: string;
  target_symbol: string;
  line: number;
}

export interface ArchitectureViolation {
  rule: string;
  name: string;
  source: string;
  target: string;
  line: number;
  message: string;
  suggestion?: string;
}

export interface DependencyIssue {
  rule: string;
  package: string;
  module?: string | null;
  message: string;
}

export interface AnalysisResult {
  root_path: string;
  modules: ModuleInfo[];
  edges: DependencyEdge[];
  cycles: CircularCycle[];
  total_loc: number;
  analysis_errors?: string[];
  architecture_violations?: ArchitectureViolation[];
  package_dependencies?: { name: string; version?: string; source: string }[];
  dependency_issues?: DependencyIssue[];
  symbol_edges?: SymbolEdge[];
}

export interface AnalysisSnapshot {
  timestamp: string;
  result: AnalysisResult;
}

export interface FileCentricGraphData {
  allowedNodeIds: Set<string>;
  allowedEdgeKeys: Set<string>;
  hasCrashingCycle: boolean;
  roots: string[];
  cycleModules: Set<string>;
  rootPaths: string[][];
}

export interface FileTreeNode {
  name: string;
  relPath: string;
  isDir: boolean;
  module?: ModuleInfo;
  children: Map<string, FileTreeNode>;
}
