import type { AnalysisResult, AnalysisSnapshot } from "./types";

function historyKey(root: string): string {
  return `moduleloom-history:${root}`;
}

export function readAnalysisHistory(root: string): AnalysisSnapshot[] {
  try {
    const value = JSON.parse(localStorage.getItem(historyKey(root)) || "[]");
    return Array.isArray(value) ? value as AnalysisSnapshot[] : [];
  } catch {
    return [];
  }
}

export function compareAnalysisResults(previous: AnalysisResult | undefined, current: AnalysisResult): string[] {
  if (!previous) return [];
  const changes: string[] = [];
  const currentModules = new Map(current.modules.map((module) => [module.id, module]));
  for (const oldModule of previous.modules) {
    const nextModule = currentModules.get(oldModule.id);
    if (!nextModule) {
      changes.push(`モジュール削除: ${oldModule.id}`);
      continue;
    }
    const nextSymbols = new Set((nextModule.symbols || []).map((symbol) => symbol.name));
    for (const symbol of oldModule.symbols || []) {
      if (!nextSymbols.has(symbol.name)) changes.push(`シンボル削除: ${oldModule.id}.${symbol.name}`);
    }
  }
  const currentEdges = new Set(current.edges.map((edge) => `${edge.source}->${edge.target}`));
  for (const edge of previous.edges) {
    if (!currentEdges.has(`${edge.source}->${edge.target}`)) changes.push(`依存削除: ${edge.source} -> ${edge.target}`);
  }
  return changes;
}

export interface IssueComparison {
  introduced: string[];
  resolved: string[];
  continuing: string[];
}

export interface AnalysisIssueComparison {
  cycles: IssueComparison;
  architecture: IssueComparison;
  dependencies: IssueComparison;
}

function compareIssueSets(previous: Map<string, string>, current: Map<string, string>): IssueComparison {
  return {
    introduced: [...current].filter(([key]) => !previous.has(key)).map(([, label]) => label).sort(),
    resolved: [...previous].filter(([key]) => !current.has(key)).map(([, label]) => label).sort(),
    continuing: [...current].filter(([key]) => previous.has(key)).map(([, label]) => label).sort(),
  };
}

/** Compare stable issue identities; line numbers and representative cycle paths may change between runs. */
export function compareAnalysisIssues(previous: AnalysisResult, current: AnalysisResult): AnalysisIssueComparison {
  const cycleSet = (result: AnalysisResult) => new Map((result.cycles || []).map((cycle) => {
    const modules = [...new Set(cycle.modules)].sort();
    const key = modules.join("\u0000");
    return [key, modules.join(" ↔ ")] as const;
  }));
  const architectureSet = (result: AnalysisResult) => new Map((result.architecture_violations || []).map((issue) => {
    const key = [issue.rule, issue.name, issue.source, issue.target].join("\u0000");
    return [key, `${issue.rule}: ${issue.source} → ${issue.target} (${issue.message})`] as const;
  }));
  const dependencySet = (result: AnalysisResult) => new Map((result.dependency_issues || []).map((issue) => {
    const module = issue.module || "";
    const key = [issue.rule, issue.package.toLowerCase(), module].join("\u0000");
    return [key, `${issue.rule}: ${issue.package}${module ? ` (${module})` : ""} — ${issue.message}`] as const;
  }));

  return {
    cycles: compareIssueSets(cycleSet(previous), cycleSet(current)),
    architecture: compareIssueSets(architectureSet(previous), architectureSet(current)),
    dependencies: compareIssueSets(dependencySet(previous), dependencySet(current)),
  };
}

export function recordAnalysisHistory(result: AnalysisResult): void {
  const history = readAnalysisHistory(result.root_path);
  history.push({ timestamp: new Date().toISOString(), result });
  localStorage.setItem(historyKey(result.root_path), JSON.stringify(history.slice(-20)));
}
