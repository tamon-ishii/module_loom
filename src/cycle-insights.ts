// @ts-ignore The shared browser script assigns its API to globalThis.
import "../shared/cycle-insights.js";
import type { AnalysisResult, CircularCycle } from "./types";

interface Suggestion {
  source: string;
  target: string;
  line: number;
  kind: "type_only" | "runtime" | "unknown";
}

const api = (globalThis as any).ModuleLoomCycles as {
  path: (cycle: CircularCycle, edges: AnalysisResult["edges"]) => string[];
  suggestion: (cycle: CircularCycle, edges: AnalysisResult["edges"]) => Suggestion | null;
  guidance: (kind: Suggestion["kind"]) => string;
};

export const cyclePath = api.path;
export const cycleSuggestion = api.suggestion;
export const cycleGuidance = api.guidance;
