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

export function recordAnalysisHistory(result: AnalysisResult): void {
  const history = readAnalysisHistory(result.root_path);
  history.push({ timestamp: new Date().toISOString(), result });
  localStorage.setItem(historyKey(result.root_path), JSON.stringify(history.slice(-20)));
}
