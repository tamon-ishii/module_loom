import cytoscape, { Core, EventObject } from "cytoscape";
// @ts-ignore
import dagre from "cytoscape-dagre";
import { escapeHtml } from "./utils";
import { cycleGuidance, cyclePath, cycleSuggestion } from "./cycle-insights";
import {
  compareAnalysisResults,
  compareAnalysisIssues,
  readAnalysisHistory,
  recordAnalysisHistory,
} from "./analysis-history";
import type {
  AnalysisResult,
  CircularCycle,
  FileCentricGraphData,
  FileTreeNode,
  ModuleInfo,
} from "./types";

cytoscape.use(dagre);

// State
let cy: Core | null = null;
let currentResult: AnalysisResult | null = null;
let selectedModule: ModuleInfo | null = null;
let gitChangedModuleIds = new Set<string>();
let lastBreakingChanges: string[] = [];
let clusterMemberOf = new Map<string, string>();
let lastCollapseActive = false;
interface FixToolInfo { id: string; label: string; kinds: string[] }
let fixTools: FixToolInfo[] = [{ id: "ruff", label: "Ruff (TC001)", kinds: ["type_only"] }];
let activeFixToolName = "Ruff";

// DOM Elements
const pathInput = document.getElementById("project-path-input") as HTMLInputElement;
const btnAnalyze = document.getElementById("btn-analyze") as HTMLButtonElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const chkWatch = document.getElementById("chk-watch") as HTMLInputElement;
const chkOnlyCycles = document.getElementById("chk-only-cycles") as HTMLInputElement;
const chkOnlyBloat = document.getElementById("chk-only-bloat") as HTMLInputElement;
const chkGroupPackages = document.getElementById("chk-group-packages") as HTMLInputElement;
const chkFocusMode = document.getElementById("chk-focus-mode") as HTMLInputElement;
const chkExternals = document.getElementById("chk-externals") as HTMLInputElement;
const graphRadius = document.getElementById("graph-radius") as HTMLSelectElement;
const clusterLimit = document.getElementById("cluster-limit") as HTMLSelectElement;
const chkDirectOnly = document.getElementById("chk-direct-only") as HTMLInputElement;
const layoutSelect = document.getElementById("layout-select") as HTMLSelectElement;
const btnFlowDirection = document.getElementById("btn-flow-direction") as HTMLButtonElement;
let flowDirection: "LR" | "TB" = localStorage.getItem("flow_direction") === "TB" ? "TB" : "LR";
function updateFlowDirectionButton() {
  btnFlowDirection.textContent = flowDirection === "LR" ? "↔ 横表示" : "↕ 縦表示";
  btnFlowDirection.title = flowDirection === "LR" ? "依存図の流れを縦方向に切り替え" : "依存図の流れを横方向に切り替え";
}
const btnFit = document.getElementById("btn-fit") as HTMLButtonElement;
const btnShowOverview = document.getElementById("btn-show-overview") as HTMLButtonElement | null;
let currentViewMode: "overview" | "file" = "file";
const editorSelect = document.getElementById("editor-select") as HTMLSelectElement;
const inspectorContent = document.getElementById("inspector-content") as HTMLDivElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;
const metricsSummary = document.getElementById("metrics-summary") as HTMLDivElement;
const ruffFixModal = document.getElementById("ruff-fix-modal") as HTMLDivElement;
const ruffFixFile = document.getElementById("ruff-fix-file") as HTMLElement;
const ruffFixDiff = document.getElementById("ruff-fix-diff") as HTMLElement;
const btnApplyRuffFix = document.getElementById("btn-apply-ruff-fix") as HTMLButtonElement;
const fixToolSelect = document.getElementById("fix-tool-select") as HTMLSelectElement;
const chainFrom = document.getElementById("chain-from") as HTMLInputElement;
const chainTo = document.getElementById("chain-to") as HTMLInputElement;

// Dependency Modal Elements & State
let modalCy: Core | null = null;
let currentModalModule: ModuleInfo | null = null;
const dependencyModal = document.getElementById("dependency-modal") as HTMLDivElement;
const modalModuleTitle = document.getElementById("modal-module-title") as HTMLElement;
const modalHeaderBadges = document.getElementById("modal-header-badges") as HTMLDivElement;
const modalLayoutSelect = document.getElementById("modal-layout-select") as HTMLSelectElement;
const btnModalFit = document.getElementById("btn-modal-fit") as HTMLButtonElement;
const btnModalZoomIn = document.getElementById("btn-modal-zoom-in") as HTMLButtonElement;
const btnModalZoomOut = document.getElementById("btn-modal-zoom-out") as HTMLButtonElement;
const btnCloseModal = document.getElementById("btn-close-modal") as HTMLButtonElement;
const btnModalCloseFooter = document.getElementById("btn-modal-close-footer") as HTMLButtonElement;
const btnModalJumpEditor = document.getElementById("btn-modal-jump-editor") as HTMLButtonElement;
const modalCyclesInfo = document.getElementById("modal-cycles-info") as HTMLDivElement;
const modalCyContainer = document.getElementById("modal-cy-container") as HTMLDivElement;

// Symbol call graph modal
let callGraphCy: Core | null = null;
const callGraphModal = document.getElementById("callgraph-modal") as HTMLDivElement | null;
const callGraphContainer = document.getElementById("callgraph-cy-container") as HTMLDivElement | null;
const callGraphTitle = document.getElementById("callgraph-title") as HTMLElement | null;

// Tree DOM Elements
const treePanel = document.getElementById("tree-panel") as HTMLElement;
const treeContent = document.getElementById("tree-content") as HTMLDivElement;
const btnToggleTree = document.getElementById("btn-toggle-tree") as HTMLButtonElement;
const btnCloseTree = document.getElementById("btn-close-tree") as HTMLButtonElement;
const btnTreeCollapseAll = document.getElementById("btn-tree-collapse-all") as HTMLButtonElement;
const btnTreeExpandAll = document.getElementById("btn-tree-expand-all") as HTMLButtonElement;
const treeSearchInput = document.getElementById("tree-search-input") as HTMLInputElement;

// Helper to invoke Tauri command with mock fallback for web preview
async function invokeCommand<T>(cmd: string, args: any = {}): Promise<T> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
  }
  // Mock fallback
  if (cmd === "analyze_project") {
    return getMockAnalysisResult(args.path || ".") as T;
  }
  if (cmd === "open_in_editor") {
    console.log(`[Editor Jump] ${args.editor}: ${args.filePath}:${args.line}`);
    alert(`[外部エディタ起動]: ${args.editor}\nファイル: ${args.filePath}:${args.line || 1}`);
    return {} as T;
  }
  if (cmd === "watch_project" || cmd === "stop_watching") {
    return {} as T;
  }
  if (cmd === "git_changed_files") {
    return [] as T;
  }
  if (cmd === "git_diff_files") {
    return [] as T;
  }
  if (cmd === "detect_editors") {
    return [] as T;
  }
  if (cmd === "preview_cycle_fix" || cmd === "apply_cycle_fix") {
    throw new Error("外部ツールによる修正はデスクトップ版で利用できます");
  }
  if (cmd === "generate_mkdocs") {
    throw new Error("MkDocs 出力はデスクトップ版で利用できます");
  }
  if (cmd === "list_fix_tools") {
    return fixTools as T;
  }
  if (cmd === "git_changed_files") {
    return [] as T;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

function initGraph() {
  const container = document.getElementById("cy-container");
  if (!container) return;

  cy = cytoscape({
    container,
    boxSelectionEnabled: false,
    autounselectify: false,
    style: [
      // Standard module node (Box / Card shape instead of circle)
      {
        selector: "node:childless",
        style: {
          shape: "round-rectangle",
          "background-color": "#181825",
          "border-color": "#89b4fa",
          "border-width": 2,
          label: "data(label)",
          color: "#cdd6f4",
          "font-size": "13px",
          "font-weight": 600,
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "150px",
          width: "data(width)",
          height: "data(height)",
          padding: "6px",
        },
      },
      // Package compound parent node (Directory box)
      {
        selector: "node.external-node:childless",
        style: {
          "background-color": "#202b30",
          "border-color": "#94e2d5",
          "border-style": "dashed",
          color: "#94e2d5",
        },
      },
      {
        selector: "node.cluster-node:childless",
        style: { "background-color": "#32324a", "border-color": "#cba6f7", color: "#cba6f7", "border-width": 3 },
      },
      {
        selector: "edge.cluster-edge",
        style: { "line-color": "#cba6f7", "target-arrow-color": "#cba6f7", width: 3 },
      },
      {
        selector: "edge.external-edge",
        style: { "line-style": "dashed", "line-color": "#6fa99f", "target-arrow-color": "#6fa99f" },
      },
      {
        selector: ":parent",
        style: {
          shape: "round-rectangle",
          "background-color": "#313244",
          "background-opacity": 0.15,
          "border-color": "#585b70",
          "border-width": 1.5,
          "border-style": "dashed",
          label: "data(label)",
          color: "#a6adc8",
          "font-size": "13px",
          "font-weight": "bold",
          "text-valign": "top",
          "text-halign": "center",
          "text-margin-y": 8,
          padding: "16px",
        },
      },
      {
        selector: "node.file-mode-package",
        style: {
          "background-opacity": 0,
          "border-width": 0,
          label: "",
          padding: "0px",
        },
      },
      // In Circular Dependency
      {
        selector: "node.in-cycle:childless",
        style: {
          "border-color": "#ff4d4d",
          "border-width": 4,
          "background-color": "#38141e",
          color: "#ff8099",
          "font-weight": "bold",
          "z-index": 500,
        },
      },
      // Oversized Bloat Module
      {
        selector: "node.oversized:childless",
        style: {
          "border-color": "#fab387",
          "border-width": 3,
          "background-color": "#2e2520",
          color: "#fab387",
        },
      },
      // Focal node (origin module in file-centric diagram)
      {
        selector: "node.focal-node:childless",
        style: {
          "border-color": "#f9e2af",
          "border-width": 4.5,
          "background-color": "#2c281e",
          color: "#f9e2af",
          "font-size": "14px",
          "font-weight": "bold",
          "z-index": 1200,
        },
      },
      // Root node (entry points leading to cycle)
      {
        selector: "node.root-node:childless",
        style: {
          "border-color": "#a6e3a1",
          "border-width": 3.5,
          "background-color": "#1e2e24",
          color: "#a6e3a1",
          "font-size": "13px",
          "font-weight": "bold",
          "z-index": 1100,
        },
      },
      {
        selector: "node.git-changed:childless",
        style: {
          "border-color": "#94e2d5",
          "border-width": 4,
          "background-color": "#173b3a",
        },
      },
      {
        selector: "node.git-changed:childless",
        style: {
          "border-color": "#94e2d5",
          "border-width": 4,
          "background-color": "#173b3a",
        },
      },
      // Selected node
      {
        selector: "node:selected",
        style: {
          "border-color": "#f9e2af",
          "border-width": 4,
          "background-color": "#363a4f",
          color: "#f9e2af",
          "font-weight": "bold",
          "z-index": 900,
        },
      },
      // Selected circular node keeps prominent red
      {
        selector: "node.in-cycle:selected",
        style: {
          "border-color": "#ff2222",
          "border-width": 5,
          "background-color": "#521626",
          color: "#ffffff",
          "font-weight": "bold",
          "z-index": 950,
        },
      },
      // Inbound highlighted node (upstream modules importing selected module)
      {
        selector: "node.highlighted-in-node:childless",
        style: {
          "border-color": "#a6e3a1",
          "border-width": 3.5,
          "background-color": "#1e2e24",
          color: "#a6e3a1",
          "font-weight": "bold",
          "z-index": 800,
        },
      },
      // Outbound highlighted node (downstream modules imported by selected module)
      {
        selector: "node.highlighted-out-node:childless",
        style: {
          "border-color": "#89b4fa",
          "border-width": 3.5,
          "background-color": "#182438",
          color: "#89b4fa",
          "font-weight": "bold",
          "z-index": 800,
        },
      },
      // Circular nodes keep strong red border & background even when highlighted
      {
        selector: "node.in-cycle.highlighted-in-node:childless, node.in-cycle.highlighted-out-node:childless",
        style: {
          "border-color": "#ff3333",
          "border-width": 4.5,
          "background-color": "#4a1525",
          color: "#ffffff",
          "font-weight": "bold",
          "z-index": 960,
        },
      },
      // Normal edge - clearly visible with distinct arrows
      {
        selector: "edge",
        style: {
          width: "mapData(count, 1, 5, 2.0, 3.5)",
          "line-color": "#6c7086",
          "target-arrow-color": "#89b4fa",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "control-point-step-size": 40,
          opacity: 0.85,
          "arrow-scale": 1.35,
        },
      },
      // Edge hover
      {
        selector: "edge.edge-hover",
        style: {
          width: 4.5,
          opacity: 1.0,
          "line-color": "#f9e2af",
          "target-arrow-color": "#f9e2af",
          "arrow-scale": 1.5,
          "z-index": 1000,
        },
      },
      // Highlighted edge (directly connected to selected node)
      {
        selector: "edge.highlighted",
        style: {
          width: 4.0,
          "line-color": "#89b4fa",
          "target-arrow-color": "#89b4fa",
          opacity: 1.0,
          "arrow-scale": 1.4,
          "z-index": 700,
        },
      },
      // Inbound highlighted edge (upstream - 利用元からの流入矢印)
      {
        selector: "edge.highlighted-in",
        style: {
          width: 4.0,
          "line-color": "#a6e3a1",
          "target-arrow-color": "#a6e3a1",
          opacity: 1.0,
          "arrow-scale": 1.45,
          "z-index": 700,
        },
      },
      // Outbound highlighted edge (downstream - 利用先への流出矢印)
      {
        selector: "edge.highlighted-out",
        style: {
          width: 4.0,
          "line-color": "#89b4fa",
          "target-arrow-color": "#89b4fa",
          opacity: 1.0,
          "arrow-scale": 1.45,
          "z-index": 700,
        },
      },
      // Circular edge - prominent red dashed curve with cycleLabel
      {
        selector: "edge.cycle-edge",
        style: {
          width: 4.5,
          "line-color": "#ff4d4d",
          "target-arrow-color": "#ff4d4d",
          "target-arrow-shape": "triangle",
          "line-style": "dashed",
          "line-dash-pattern": [6, 4],
          "curve-style": "bezier",
          "control-point-step-size": 55,
          "arrow-scale": 1.7,
          opacity: 1.0,
          label: "data(cycleLabel)",
          "font-size": "12px",
          "font-weight": "bold",
          color: "#ff8599",
          "text-background-opacity": 0.95,
          "text-background-color": "#1e1e2e",
          "text-background-padding": "3px",
          "text-background-shape": "roundrectangle",
          "text-border-color": "#ff4d4d",
          "text-border-width": 1,
          "text-border-opacity": 0.8,
          "z-index": 1000,
        },
      },
      // Never let normal highlighted-in/out override circular danger edges
      {
        selector: "edge.cycle-edge.highlighted-in, edge.cycle-edge.highlighted-out",
        style: {
          width: 5.5,
          "line-color": "#ff2222",
          "target-arrow-color": "#ff2222",
          "target-arrow-shape": "triangle",
          "line-style": "dashed",
          "line-dash-pattern": [6, 4],
          "curve-style": "bezier",
          "control-point-step-size": 60,
          "arrow-scale": 2.0,
          opacity: 1.0,
          label: "data(cycleLabel)",
          "font-size": "13px",
          "font-weight": "bold",
          color: "#ffffff",
          "text-background-opacity": 1.0,
          "text-background-color": "#4a121d",
          "text-background-padding": "4px",
          "text-background-shape": "roundrectangle",
          "text-border-color": "#ff3333",
          "text-border-width": 1.5,
          "z-index": 1200,
        },
      },
      // Cycle pulse / highlight animation styles
      {
        selector: "edge.cycle-pulse",
        style: {
          width: 5.5,
          "line-color": "#ff3333",
          "target-arrow-color": "#ff3333",
          opacity: 1.0,
          "line-style": "dashed",
          "line-dash-pattern": [8, 4],
          "arrow-scale": 1.8,
          "z-index": 9999,
        },
      },
      {
        selector: "node.cycle-pulse",
        style: {
          "border-color": "#ff2222",
          "border-width": 6,
          "background-color": "#ff3333",
          color: "#ffffff",
          "z-index": 9999,
        },
      },
      // Faded elements when focus mode is active
      {
        selector: ".faded",
        style: {
          opacity: 0.25,
          "text-opacity": 0.3,
        },
      },
      {
        selector: "edge.faded",
        style: {
          opacity: 0.12,
        },
      },
      // Hidden
      {
        selector: ".hidden",
        style: {
          display: "none",
        },
      },
    ],
    elements: [],
  });

  // A tap selects the module; a double tap opens its dependency diagram.
  cy.on("tap", "node", (evt: EventObject) => {
    const node = evt.target;
    if (node.isParent()) return;

    const mod = currentResult?.modules.find((m) => m.id === node.id());
    if (!mod) {
      if (node.hasClass("cluster-node")) {
        statusBar.innerText = `集約パッケージ: ${node.data("label")}。ダブルクリックで展開します`;
        return;
      }
      if (node.hasClass("external-node")) {
        statusBar.innerText = `外部 / 未解決 import: ${node.data("label")}`;
        updateNodeFocus(node);
      }
      return;
    }
    if (currentViewMode === "overview") selectedModule = mod;
    if (currentViewMode === "overview" && graphRadius.value !== "all") applyFilters();
    renderInspector(mod);
    highlightTreeNode(mod.id);
    updateNodeFocus(node);
  });

  cy.on("dblclick dbltap", "node", (evt: EventObject) => {
    const node = evt.target;
    if (node.isParent()) return;

    const moduleId = node.id();
    if (node.hasClass("cluster-node")) {
      clusterLimit.value = "0";
      if (currentResult) updateGraph(currentResult);
      return;
    }
    jumpToFileCentricDiagram(moduleId);
  });

  cy.on("dragfree", "node:childless", () => saveGraphPositions());

  // Edge selection handler: click edge to show details
  cy.on("tap", "edge", (evt: EventObject) => {
    const edge = evt.target;
    const sId = edge.source().id();
    const tId = edge.target().id();
    const line = edge.data("line");
    const count = edge.data("count") || 1;
    const isCirc = edge.hasClass("cycle-edge");
    statusBar.innerText = `依存関係: [${sId}] ➔ [${tId}] (L:${line || "?"} で ${count}回インポート)${isCirc ? " 【循環インポート】" : ""}`;
  });

  // Edge hover styles
  cy.on("mouseover", "edge", (evt: EventObject) => {
    evt.target.addClass("edge-hover");
  });
  cy.on("mouseout", "edge", (evt: EventObject) => {
    evt.target.removeClass("edge-hover");
  });

  // Tap background - maintain active file-centric diagram as default view
  cy.on("tap", (evt: EventObject) => {
    if (evt.target === cy) {
      // Keep current dependency diagram active; overview switch is explicit via button
    }
  });
}

function calculateFileCentricGraph(
  selectedMod: ModuleInfo,
  result: AnalysisResult
): FileCentricGraphData {
  const selectedModId = selectedMod.id;

  // 1. Build adjacency maps for top-level and all imports
  const topOutMap = new Map<string, string[]>();
  const topInMap = new Map<string, string[]>();
  const allOutMap = new Map<string, string[]>();
  const allInMap = new Map<string, string[]>();

  result.modules.forEach((m) => {
    topOutMap.set(m.id, []);
    topInMap.set(m.id, []);
    allOutMap.set(m.id, []);
    allInMap.set(m.id, []);
  });

  result.edges.forEach((e) => {
    allOutMap.get(e.source)?.push(e.target);
    allInMap.get(e.target)?.push(e.source);
    if (e.is_top_level !== false) {
      topOutMap.get(e.source)?.push(e.target);
      topInMap.get(e.target)?.push(e.source);
    }
  });

  // 2. Identify relevant crashing cycles (top-level cycles)
  const crashingCycles = result.cycles || [];
  const relevantCycles: CircularCycle[] = [];
  const cycleModules = new Set<string>();

  for (const cycle of crashingCycles) {
    const cycleNodes = new Set(cycle.modules);

    // If selectedModId is part of the cycle
    if (cycleNodes.has(selectedModId)) {
      relevantCycles.push(cycle);
      cycle.modules.forEach((m) => cycleModules.add(m));
      continue;
    }

    // Check reachability from selectedModId to cycle via top-level imports (upstream of cycle)
    let reachesCycle = false;
    const visitedFwd = new Set<string>([selectedModId]);
    const queueFwd = [selectedModId];
    while (queueFwd.length > 0) {
      const curr = queueFwd.shift()!;
      if (cycleNodes.has(curr)) {
        reachesCycle = true;
        break;
      }
      for (const next of topOutMap.get(curr) || []) {
        if (!visitedFwd.has(next)) {
          visitedFwd.add(next);
          queueFwd.push(next);
        }
      }
    }
    if (reachesCycle) {
      relevantCycles.push(cycle);
      cycle.modules.forEach((m) => cycleModules.add(m));
      continue;
    }

    // Check reachability from cycle to selectedModId via top-level imports (downstream of cycle)
    let reachedFromCycle = false;
    for (const cNode of cycle.modules) {
      const visitedBwd = new Set<string>([cNode]);
      const queueBwd = [cNode];
      while (queueBwd.length > 0) {
        const curr = queueBwd.shift()!;
        if (curr === selectedModId) {
          reachedFromCycle = true;
          break;
        }
        for (const next of topOutMap.get(curr) || []) {
          if (!visitedBwd.has(next)) {
            visitedBwd.add(next);
            queueBwd.push(next);
          }
        }
      }
      if (reachedFromCycle) break;
    }
    if (reachedFromCycle) {
      relevantCycles.push(cycle);
      cycle.modules.forEach((m) => cycleModules.add(m));
    }
  }

  // 3. Allowed nodes and edge keys
  const allowedNodeIds = new Set<string>();
  const allowedEdgeKeys = new Set<string>(); // "source->target"

  // Base: 1-hop direct neighborhood of selectedModId
  allowedNodeIds.add(selectedModId);
  (allOutMap.get(selectedModId) || []).forEach((tgt) => {
    allowedNodeIds.add(tgt);
    allowedEdgeKeys.add(`${selectedModId}->${tgt}`);
  });
  (allInMap.get(selectedModId) || []).forEach((src) => {
    allowedNodeIds.add(src);
    allowedEdgeKeys.add(`${src}->${selectedModId}`);
  });

  const rootsList: string[] = [];
  const rootPaths: string[][] = [];

  // 4. If crashing cycles are relevant, trace paths from roots to the cycle & selected module
  if (relevantCycles.length > 0) {
    for (const cycle of relevantCycles) {
      const cycleNodes = new Set(cycle.modules);
      cycle.modules.forEach((m) => allowedNodeIds.add(m));

      // Add all edges within cycle
      result.edges.forEach((e) => {
        if (cycleNodes.has(e.source) && cycleNodes.has(e.target)) {
          allowedEdgeKeys.add(`${e.source}->${e.target}`);
        }
      });

      // Reverse BFS from cycle modules to find all ancestors in top-level graph
      const ancestors = new Set<string>();
      const queue = [...cycle.modules];
      const visitedRev = new Set<string>(cycle.modules);

      while (queue.length > 0) {
        const curr = queue.shift()!;
        for (const parent of topInMap.get(curr) || []) {
          if (!visitedRev.has(parent)) {
            visitedRev.add(parent);
            ancestors.add(parent);
            queue.push(parent);
          }
        }
      }

      // Root modules: nodes among ancestors with in-degree 0 in top-level imports
      const cycleRoots: string[] = [];
      for (const anc of visitedRev) {
        const inNodes = topInMap.get(anc) || [];
        if (inNodes.length === 0) {
          cycleRoots.push(anc);
        }
      }
      if (cycleRoots.length === 0 && ancestors.size > 0) {
        cycleRoots.push([...ancestors][0]);
      }
      rootsList.push(...cycleRoots);

      // Collect forward paths from each root to cycle nodes
      for (const root of cycleRoots) {
        allowedNodeIds.add(root);
        const fwdQueue: { node: string; path: string[] }[] = [{ node: root, path: [root] }];
        const fwdVisited = new Set<string>([root]);

        while (fwdQueue.length > 0) {
          const { node: curr, path } = fwdQueue.shift()!;
          if (cycleNodes.has(curr)) {
            rootPaths.push(path);
          }
          for (const next of topOutMap.get(curr) || []) {
            if (visitedRev.has(next)) {
              allowedNodeIds.add(next);
              allowedEdgeKeys.add(`${curr}->${next}`);
              if (!fwdVisited.has(next)) {
                fwdVisited.add(next);
                fwdQueue.push({ node: next, path: [...path, next] });
              }
            }
          }
        }
      }

      // Also ensure path between selectedModId and cycle is included
      if (!cycleNodes.has(selectedModId)) {
        const traceQueue = [selectedModId];
        const traceVisited = new Set<string>([selectedModId]);
        while (traceQueue.length > 0) {
          const curr = traceQueue.shift()!;
          for (const next of topOutMap.get(curr) || []) {
            if (visitedRev.has(next)) {
              allowedNodeIds.add(next);
              allowedEdgeKeys.add(`${curr}->${next}`);
              if (!traceVisited.has(next)) {
                traceVisited.add(next);
                traceQueue.push(next);
              }
            }
          }
        }
      }
    }
  }

  return {
    allowedNodeIds,
    allowedEdgeKeys,
    hasCrashingCycle: relevantCycles.length > 0,
    roots: [...new Set(rootsList)],
    cycleModules,
    rootPaths,
  };
}

function switchToOverview() {
  if (!cy || !currentResult) return;
  currentViewMode = "overview";
  selectedModule = null;
  clearHighlights();

  if (chkDirectOnly) {
    chkDirectOnly.checked = false;
  }

  if (treeContent) {
    treeContent.querySelectorAll(".tree-item-row.selected").forEach((el) => {
      el.classList.remove("selected");
    });
  }

  cy.elements().removeClass("hidden faded highlighted-in highlighted-out highlighted-in-node highlighted-out-node focal-node root-node");
  applyFilters();
  runLayout();
  restoreGraphPositions();
  updateOverviewButton();

  inspectorContent.innerHTML = `
    <div style="text-align:center; padding: 24px 12px; color: var(--text-muted);">
      <div style="font-size: 1.6rem; margin-bottom: 8px;">🌐 全体図</div>
      <p style="font-size: 0.85rem; line-height: 1.6;">
        ソースツリーまたはグラフ上のモジュールをクリックすると詳細を表示し、<br>
        <b style="color: var(--accent);">ダブルクリックで依存図</b>に切り替わります。
      </p>
    </div>
  `;
  statusBar.innerText = "全体図を表示中 (ダブルクリックで依存図へジャンプ)";
}

function graphPositionStorageKey(): string | null {
  return currentResult ? `moduleloom-positions:${currentResult.root_path}` : null;
}

function saveGraphPositions() {
  if (!cy || !currentResult) return;
  const positions: Record<string, { x: number; y: number }> = {};
  cy.nodes(":childless").forEach((node) => {
    const position = node.position();
    positions[node.id()] = { x: position.x, y: position.y };
  });
  const key = graphPositionStorageKey();
  if (key) localStorage.setItem(key, JSON.stringify(positions));
}

function restoreGraphPositions() {
  if (!cy) return;
  const key = graphPositionStorageKey();
  if (!key) return;
  try {
    const positions = JSON.parse(localStorage.getItem(key) || "{}") as Record<string, { x: number; y: number }>;
    cy.nodes(":childless").forEach((node) => {
      const position = positions[node.id()];
      if (position && Number.isFinite(position.x) && Number.isFinite(position.y)) node.position(position);
    });
    cy.fit(cy.elements().not(".hidden"), 40);
  } catch {
    localStorage.removeItem(key);
  }
}

function updateOverviewButton() {
  if (!btnShowOverview) return;
  if (currentViewMode === "overview") {
    btnShowOverview.className = "btn-primary";
    btnShowOverview.innerHTML = "📊 依存図に戻る";
    btnShowOverview.title = "指定モジュールの依存図（デフォルト）に戻る";
  } else {
    btnShowOverview.className = "btn-secondary";
    btnShowOverview.innerHTML = "🌐 全体図を見る";
    btnShowOverview.title = "プロジェクト全モジュールの全体図を表示";
  }
}

function toggleOverviewOrFileView() {
  if (currentViewMode === "overview") {
    if (selectedModule) {
      jumpToFileCentricDiagram(selectedModule.id);
    } else if (currentResult && currentResult.modules.length > 0) {
      const keyMod =
        (currentResult.cycles.length > 0 && currentResult.modules.find((m) => m.id === currentResult!.cycles[0].modules[0])) ||
        currentResult.modules.find((m) => m.id === "main" || m.id.endsWith(".main") || m.id === "app.api") ||
        currentResult.modules[0];
      jumpToFileCentricDiagram(keyMod.id);
    }
  } else {
    switchToOverview();
  }
}

function goBack() {
  if (dependencyModal && !dependencyModal.classList.contains("hidden")) {
    closeDependencyDialog();
    return;
  }
  if (currentViewMode === "file") {
    switchToOverview();
    return;
  }
  statusBar.innerText = "これ以上戻る表示はありません";
}

function updateNodeFocus(selectedNode: cytoscape.NodeSingular) {
  if (!cy) return;
  // A module selected from the tree may be outside the current file diagram.
  if (selectedNode.hasClass("hidden")) return;

  cy.elements().removeClass("highlighted highlighted-in highlighted-out highlighted-in-node highlighted-out-node faded");

  const focusMode = chkFocusMode.checked;
  const inEdges = selectedNode.incomers("edge");
  const outEdges = selectedNode.outgoers("edge");
  const inNodes = inEdges.sources();
  const outNodes = outEdges.targets();

  inEdges.addClass("highlighted-in");
  outEdges.addClass("highlighted-out");
  inNodes.addClass("highlighted-in-node");
  outNodes.addClass("highlighted-out-node");

  if (focusMode && currentViewMode !== "file") {
    const activeElements = selectedNode
      .union(inEdges)
      .union(outEdges)
      .union(inNodes)
      .union(outNodes);

    cy.elements().difference(activeElements).addClass("faded");
    // Don't fade parent nodes of active nodes
    activeElements.parents().removeClass("faded");
  }
}

function clearHighlights() {
  if (!cy) return;
  cy.elements().removeClass("highlighted highlighted-in highlighted-out highlighted-in-node highlighted-out-node faded focal-node root-node");
}

function findAndHighlightChain() {
  if (!currentResult || !cy) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const source = chainFrom.value.trim();
  const target = chainTo.value.trim();
  const known = new Set(currentResult.modules.map((module) => module.id));
  if (!known.has(source) || !known.has(target)) {
    statusBar.innerText = "出発と到着のモジュール名を一覧から選んでください";
    return;
  }
  const queue = [source];
  const previous = new Map<string, string | null>([[source, null]]);
  while (queue.length > 0 && !previous.has(target)) {
    const current = queue.shift()!;
    for (const edge of currentResult.edges) {
      if (edge.source === current && !previous.has(edge.target)) {
        previous.set(edge.target, current);
        queue.push(edge.target);
      }
    }
  }
  if (!previous.has(target)) {
    statusBar.innerText = `依存経路がありません: ${source} → ${target}`;
    return;
  }
  const path: string[] = [];
  for (let cursor: string | null = target; cursor !== null; cursor = previous.get(cursor) ?? null) path.unshift(cursor);
  switchToOverview();
  searchInput.value = "";
  chkOnlyCycles.checked = false;
  chkOnlyBloat.checked = false;
  applyFilters();
  clearHighlights();
  let active = cy.collection();
  path.forEach((id, index) => {
    active = active.merge(cy!.$id(id));
    if (index + 1 < path.length) {
      const edge = cy!.edges().filter((item) => item.source().id() === id && item.target().id() === path[index + 1]);
      active = active.merge(edge);
      edge.addClass("highlighted");
    }
  });
  cy.elements().difference(active).addClass("faded");
  active.parents().removeClass("faded");
  cy.fit(active, 60);
  statusBar.innerText = `最短 import 経路 (${path.length - 1} ホップ): ${path.join(" → ")}`;
}

function showDependencyIssues() {
  if (!currentResult) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const issues = currentResult.dependency_issues || [];
  inspectorContent.innerHTML = `<div class="module-detail"><h3>依存宣言の問題 (${issues.length})</h3>
    ${issues.length === 0 ? '<p>問題はありません</p>' : `<ul class="dep-list">${issues.map((issue) =>
      `<li class="dep-item"><div><strong>${escapeHtml(issue.rule)} ${escapeHtml(issue.package)}</strong>: ${escapeHtml(issue.message)}</div>
      ${issue.module ? `<small>参照元: ${escapeHtml(issue.module)}</small>` : ""}</li>`).join("")}</ul>`}</div>`;
  statusBar.innerText = `依存宣言の問題: ${issues.length} 件`;
}

function jumpToFileCentricDiagram(moduleId: string) {
  if (!currentResult) return;
  const mod = currentResult.modules.find((m) => m.id === moduleId);
  if (!mod) return;

  currentViewMode = "file";
  selectedModule = mod;
  renderInspector(mod);
  highlightTreeNode(moduleId);
  updateOverviewButton();

  if (chkDirectOnly) {
    chkDirectOnly.checked = true;
  }
  applyFilters();

  if (cy) {
    const node = cy.$id(moduleId);
    if (node.length > 0) {
      updateNodeFocus(node);
    }
  }

  const fileData = calculateFileCentricGraph(mod, currentResult);
  if (fileData.hasCrashingCycle) {
    const rootNames = fileData.roots.map((r) => r.split(".").pop()).join(", ") || "エントリポイント";
    const cyclePartners = [...fileData.cycleModules].map((m) => m.split(".").pop()).join(" ⟷ ");
    statusBar.innerText = `⚠️ トップレベルの循環インポート: ルーツ [${rootNames}] から循環 [${cyclePartners}] までの経路を描画中`;
  } else {
    statusBar.innerText = `ファイル起点ダイアグラム: [${mod.name}] (全体図ボタンで全体図に戻る)`;
  }
}

function selectModuleById(moduleId: string, _focusGraph = true) {
  jumpToFileCentricDiagram(moduleId);
}

function highlightTreeNode(moduleId: string, scroll = false) {
  if (!treeContent) return;
  treeContent.querySelectorAll(".tree-item-row.selected").forEach((el) => {
    el.classList.remove("selected");
  });

  const row = treeContent.querySelector(`.tree-item-row[data-module-id="${moduleId}"]`) as HTMLElement;
  if (row) {
    row.classList.add("selected");
    // Expand ancestor directories if collapsed
    let parent = row.closest(".tree-children");
    while (parent) {
      parent.classList.remove("collapsed");
      const parentNode = parent.parentElement;
      const arrow = parentNode?.querySelector(":scope > .tree-item-row .tree-arrow");
      arrow?.classList.add("expanded");
      parent = parentNode?.parentElement?.closest(".tree-children") || null;
    }
    if (scroll) {
      row.scrollIntoView({ block: "nearest", behavior: "auto" });
    }
  }
}

function updateGraph(result: AnalysisResult) {
  if (!cy) return;
  const previousSelectedId = selectedModule?.id;
  const wasOverview = currentViewMode === "overview";
  const freshAnalysis = result !== currentResult;
  if (freshAnalysis) {
    const history = readAnalysisHistory(result.root_path);
    const previous = history.length > 0 ? history[history.length - 1].result : undefined;
    lastBreakingChanges = compareAnalysisResults(previous, result);
  }
  currentResult = result;
  (document.getElementById("module-names") as HTMLDataListElement).innerHTML = result.modules
    .map((module) => `<option value="${escapeHtml(module.id)}"></option>`).join("");

  const cycleNodeIds = new Set<string>();
  result.cycles.forEach((c) => c.modules.forEach((m) => cycleNodeIds.add(m)));

  const elements: cytoscape.ElementDefinition[] = [];
  const groupPackages = chkGroupPackages.checked;
  const packageParents = new Set<string>();
  clusterMemberOf = new Map();
  const clusterSize = Number(clusterLimit.value);
  if (clusterSize > 0) {
    const byPackage = new Map<string, string[]>();
    for (const module of result.modules) {
      const parts = module.id.split(".");
      if (parts.length < 2) continue;
      const pkg = parts.slice(0, -1).join(".");
      byPackage.set(pkg, [...(byPackage.get(pkg) || []), module.id]);
    }
    for (const [pkg, members] of byPackage) {
      if (members.length <= clusterSize) continue;
      const clusterId = `cluster:${pkg}`;
      members.forEach((member) => clusterMemberOf.set(member, clusterId));
      elements.push({ group: "nodes", data: { id: clusterId, label: `▣ ${pkg} (${members.length})`, width: 150, height: 50 }, classes: "cluster-node" });
    }
  }

  // 1. Create nodes and package parents
  result.modules.forEach((mod) => {
    const isCycle = cycleNodeIds.has(mod.id);
    const label = isCycle ? `🚨 ${mod.name}\n[循環参照]` : mod.name;
    // Box dimensions for card-style layout
    const width = isCycle
      ? Math.max(130, Math.min(185, mod.name.length * 9 + 40))
      : Math.max(120, Math.min(170, mod.name.length * 9 + 30));
    const height = isCycle ? 48 : 42;

    const classes: string[] = [];
    if (isCycle) classes.push("in-cycle");
    if (mod.is_oversized) classes.push("oversized");
    if (gitChangedModuleIds.has(mod.id)) classes.push("git-changed");

    let parentId: string | undefined = undefined;
    if (groupPackages) {
      const parts = mod.id.split(".");
      if (parts.length > 1) {
        const pkgPath = parts.slice(0, -1).join(".");
        parentId = `pkg:${pkgPath}`;
        if (!packageParents.has(parentId)) {
          packageParents.add(parentId);
          elements.push({
            group: "nodes",
            data: {
              id: parentId,
              label: parts.slice(0, -1).pop() || pkgPath,
            },
          });
        }
      }
    }

    elements.push({
      group: "nodes",
      data: {
        id: mod.id,
        label: label,
        loc: mod.loc,
        coupling: (mod.afferent_coupling || 0) + (mod.efferent_coupling || 0),
        width,
        height,
        parent: parentId,
      },
      classes: classes.join(" "),
    });
  });

  if (chkExternals.checked) {
    const internalRoots = new Set(result.modules.map((module) => module.id.split(".")[0]));
    const externalRoots = new Set<string>();
    const externalEdges = new Set<string>();
    for (const mod of result.modules) {
      for (const imp of mod.imports) {
        if (imp.level !== 0) continue;
        const root = imp.module.split(".")[0];
        if (!root || internalRoots.has(root)) continue;
        const id = `external:${root}`;
        if (!externalRoots.has(root)) {
          externalRoots.add(root);
          elements.push({ group: "nodes", data: { id, label: `🌐 ${root}`, width: 125, height: 42 }, classes: "external-node" });
        }
        const edgeId = `external-edge:${mod.id}:${root}`;
        if (!externalEdges.has(edgeId)) {
          externalEdges.add(edgeId);
          elements.push({ group: "edges", data: { id: edgeId, source: mod.id, target: id, line: imp.line, count: 1 }, classes: "external-edge" });
        }
      }
    }
  }

  // 2. Create edges
  result.edges.forEach((edge, idx) => {
    const classes: string[] = [];
    if (edge.is_circular) classes.push("cycle-edge");

    elements.push({
      group: "edges",
      data: {
        id: `e-${idx}`,
        source: edge.source,
        target: edge.target,
        line: edge.line,
        count: edge.import_count || 1,
        cycleLabel: edge.is_circular ? `🚨 循環 (L:${edge.line})` : "",
      },
      classes: classes.join(" "),
    });
  });

  if (clusterMemberOf.size > 0) {
    const aggregated = new Set<string>();
    const ordinaryEdges = elements.filter((item) => item.group === "edges" && item.data);
    for (const item of ordinaryEdges) {
      const source = String(item.data!.source);
      const target = String(item.data!.target);
      const aggregateSource = clusterMemberOf.get(source) || source;
      const aggregateTarget = clusterMemberOf.get(target) || target;
      if (aggregateSource === source && aggregateTarget === target) continue;
      if (aggregateSource === aggregateTarget) continue;
      const key = `${aggregateSource}->${aggregateTarget}`;
      if (aggregated.has(key)) continue;
      aggregated.add(key);
      elements.push({ group: "edges", data: { id: `cluster-edge:${key}`, source: aggregateSource, target: aggregateTarget, count: 1 }, classes: "cluster-edge" });
    }
  }

  cy.elements().remove();
  cy.add(elements);

  renderTree(result);
  updateSummary(result);
  if (freshAnalysis) recordAnalysisHistory(result);

  if (wasOverview) {
    switchToOverview();
    return;
  }
  if (previousSelectedId && result.modules.some((module) => module.id === previousSelectedId)) {
    jumpToFileCentricDiagram(previousSelectedId);
    return;
  }

  // Auto-display dependency diagram for key module as default view
  if (result.modules.length > 0) {
    let keyMod: ModuleInfo | undefined;
    // Prioritize crashing cycle if present so root-to-cycle path is visible immediately
    if (result.cycles.length > 0) {
      const firstCycleModId = result.cycles[0].modules[0];
      keyMod = result.modules.find((m) => m.id === firstCycleModId);
    }
    if (!keyMod) {
      keyMod =
        result.modules.find((m) => m.id === "main" || m.id.endsWith(".main") || m.id === "app.api" || m.id.endsWith(".api")) ||
        result.modules[0];
    }
    jumpToFileCentricDiagram(keyMod.id);
  } else {
    switchToOverview();
  }
}

function runLayout() {
  if (!cy) return;
  const layoutName = layoutSelect.value;

  let options: any = {
    name: layoutName,
    fit: true,
    padding: 40,
    animate: false,
  };

  if (layoutName === "dagre") {
    options = {
      name: "dagre",
      rankDir: flowDirection,
      nodeSep: 60,
      rankSep: 100,
      edgeSep: 30,
      fit: true,
      padding: 40,
      animate: false,
    };
  } else if (layoutName === "cose") {
    options = {
      name: "cose",
      idealEdgeLength: 120,
      nodeOverlap: 20,
      refresh: 20,
      fit: true,
      padding: 40,
      randomize: false,
      componentSpacing: 100,
      nodeRepulsion: () => 400000,
      edgeElasticity: () => 100,
      gravity: 80,
      animate: false,
    };
  } else if (layoutName === "concentric") {
    options = {
      name: "concentric",
      concentric: (node: any) => node.degree(),
      levelWidth: () => 2,
      minNodeSpacing: 60,
      fit: true,
      padding: 40,
      animate: false,
    };
  }

  const visible = cy.elements().not(".hidden");
  visible.layout(options).run();
  cy.fit(visible, 40);
}

function applyFilters() {
  if (!cy || !currentResult) return;
  const searchTerm = searchInput.value.trim().toLowerCase();
  const onlyCycles = chkOnlyCycles.checked;
  const onlyBloat = chkOnlyBloat.checked;
  const isFileMode = currentViewMode === "file" && selectedModule !== null;
  const collapseActive = !isFileMode && clusterMemberOf.size > 0 && !onlyCycles && !onlyBloat && !searchTerm;
  const radius = graphRadius.value === "all" ? Infinity : Number(graphRadius.value);
  const distance = new Map<string, number>();
  if (!isFileMode && selectedModule && Number.isFinite(radius)) {
    const start = collapseActive ? clusterMemberOf.get(selectedModule.id) || selectedModule.id : selectedModule.id;
    const queue = [start];
    distance.set(start, 0);
    while (queue.length > 0) {
      const current = queue.shift()!;
      const depth = distance.get(current)!;
      if (depth >= radius) continue;
      cy.edges().forEach((edge) => {
        if (collapseActive && !edge.hasClass("cluster-edge")
          && (clusterMemberOf.has(edge.source().id()) || clusterMemberOf.has(edge.target().id()))) return;
        if (!collapseActive && edge.hasClass("cluster-edge")) return;
        const next = edge.source().id() === current ? edge.target().id()
          : edge.target().id() === current ? edge.source().id() : null;
        if (next && !distance.has(next)) { distance.set(next, depth + 1); queue.push(next); }
      });
    }
  }

  const cycleNodeIds = new Set<string>();
  currentResult.cycles.forEach((c) => c.modules.forEach((m) => cycleNodeIds.add(m)));

  let fileData: FileCentricGraphData | null = null;
  if (isFileMode && selectedModule) {
    fileData = calculateFileCentricGraph(selectedModule, currentResult);
  }

  // 1. Filter and style nodes
  cy.nodes(":childless").forEach((node) => {
    const id = node.id();
    const idLower = id.toLowerCase();
    const mod = currentResult?.modules.find((m) => m.id === id);
    const modName = mod ? mod.name : node.hasClass("external-node") ? `🌐 ${id.slice("external:".length)}`
      : node.hasClass("cluster-node") ? String(node.data("label")) : id.split(".").pop() || id;
    const nameLower = modName.toLowerCase();

    let match = true;
    if (fileData && !fileData.allowedNodeIds.has(id)) {
      match = false;
    }
    if (isFileMode && node.hasClass("external-node")) match = false;
    if (isFileMode && node.hasClass("cluster-node")) match = false;
    if (collapseActive && clusterMemberOf.has(id)) match = false;
    if (!collapseActive && node.hasClass("cluster-node")) match = false;
    if (!isFileMode && distance.size > 0 && !distance.has(id)) match = false;
    if (!isFileMode && searchTerm && !idLower.includes(searchTerm) && !nameLower.includes(searchTerm)) {
      match = false;
    }
    if (!isFileMode && onlyCycles && !cycleNodeIds.has(id)) {
      match = false;
    }
    if (!isFileMode && onlyBloat && (!mod || !mod.is_oversized)) {
      match = false;
    }

    if (match) {
      node.removeClass("hidden");

      // Update node styles and badges
      node.removeClass("focal-node root-node");
      if (isFileMode && selectedModule) {
        if (id === selectedModule.id) {
          node.addClass("focal-node");
          node.data("label", `🎯 ${modName}\n[起点モジュール]`);
        } else if (fileData?.roots.includes(id)) {
          node.addClass("root-node");
          node.data("label", `🌱 ${modName}\n[ルーツ]`);
        } else if (fileData?.cycleModules.has(id)) {
          node.data("label", `🚨 ${modName}\n[循環]`);
        } else {
          node.data("label", modName);
        }
      } else {
        const isCycle = cycleNodeIds.has(id);
        node.data("label", isCycle ? `🚨 ${modName}\n[循環参照]` : modName);
      }
    } else {
      node.addClass("hidden");
    }
  });

  // 2. Filter edges
  cy.edges().forEach((edge) => {
    const sId = edge.source().id();
    const tId = edge.target().id();
    const sourceNode = cy?.$id(sId);
    const targetNode = cy?.$id(tId);

    if ((!collapseActive && edge.hasClass("cluster-edge"))
      || (sourceNode?.hasClass("hidden") || targetNode?.hasClass("hidden"))) {
      edge.addClass("hidden");
    } else {
      if (fileData) {
        const edgeKey = `${sId}->${tId}`;
        if (!fileData.allowedEdgeKeys.has(edgeKey)) {
          edge.addClass("hidden");
          return;
        }
      }
      edge.removeClass("hidden");
    }
  });

  // 3. Compound parent nodes
  cy.nodes(":parent").forEach((pNode) => {
    const visibleChildren = pNode.children().not(".hidden");
    pNode.toggleClass("file-mode-package", isFileMode);
    if (visibleChildren.length === 0) {
      pNode.addClass("hidden");
    } else {
      pNode.removeClass("hidden");
    }
  });

  if (lastCollapseActive !== collapseActive) {
    lastCollapseActive = collapseActive;
    if (!isFileMode) runLayout();
  }

  // 4. Layout visible modules in the chosen flow direction.
  if (isFileMode && selectedModule) {
    const visibleNodes = cy.nodes(":childless").not(".hidden");
    const visibleEdges = cy.edges().not(".hidden");
    const visibleEles = visibleNodes.union(visibleEdges);
    if (visibleNodes.length > 0) {
      visibleEles
        .layout({
          name: "dagre",
          rankDir: flowDirection,
          nodeSep: 50,
          rankSep: 130,
          edgeSep: 35,
          padding: 50,
          animate: false,
        } as any)
        .run();

      // Fit into one single screen viewport without over-zooming
      cy.fit(visibleEles, 50);
      if (cy.zoom() > 1.2) {
        cy.zoom(1.2);
        cy.center(visibleEles);
      }
    }
  }
}

function renderCyclePath(cycle: CircularCycle, currentId: string): string {
  const path = currentResult ? cyclePath(cycle, currentResult.edges) : [];
  if (!path.length || !currentResult) return cycle.modules.map(escapeHtml).join("・");
  return path.map((id, index) => {
    const pill = `<span class="cycle-pill ${id === currentId ? "current" : ""}" data-select-mod="${escapeHtml(id)}" title="${escapeHtml(id)}">${escapeHtml(id.split(".").pop() || id)}</span>`;
    if (index === path.length - 1) return pill;
    const edge = currentResult!.edges.find((item) => item.source === id && item.target === path[index + 1] && item.is_top_level !== false);
    const source = currentResult!.modules.find((item) => item.id === id);
    const arrow = edge && source
      ? `<span class="cycle-arrow dep-item-line" data-jump-file="${escapeHtml(source.absolute_path)}" data-jump-line="${edge.line}" title="${escapeHtml(id)} → ${escapeHtml(path[index + 1])} の import 行を開く">➔ L:${edge.line}</span>`
      : '<span class="cycle-arrow">➔</span>';
    return pill + arrow;
  }).join("");
}

function renderCycleSuggestion(cycle: CircularCycle): string {
  if (!currentResult) return "";
  const item = cycleSuggestion(cycle, currentResult.edges);
  const source = item && currentResult.modules.find((module) => module.id === item.source);
  if (!item || !source) return "";
  const selectedTool = fixTools.find((tool) => tool.id === fixToolSelect.value);
  const fixButton = cycle.suggestion && selectedTool?.kinds.includes(item.kind)
    ? `<button class="btn-secondary btn-sm btn-preview-ruff-fix" data-cycle-source="${escapeHtml(item.source)}" data-cycle-line="${item.line}" style="margin-left:6px">${escapeHtml(selectedTool.label)} の差分</button>`
    : "";
  return `<div style="width:100%; font-size:0.72rem; color:var(--text-muted); margin-top:4px;">
    改善候補: <span class="dep-item-line" data-jump-file="${escapeHtml(source.absolute_path)}" data-jump-line="${item.line}" title="import 行を開く">${escapeHtml(item.source)} → ${escapeHtml(item.target)} (L:${item.line})</span>。${escapeHtml(cycleGuidance(item.kind))}${fixButton} 変更後は自動更新または再解析で確認できます。
  </div>`;
}

async function refreshFixTools(path: string): Promise<string | null> {
  try {
    const available = await invokeCommand<FixToolInfo[]>("list_fix_tools", { path });
    fixTools = available;
    const remembered = localStorage.getItem(`moduleloom-fix-tool:${path}`) || fixToolSelect.value;
    fixToolSelect.innerHTML = available.map((tool) =>
      `<option value="${escapeHtml(tool.id)}">${escapeHtml(tool.label)}</option>`).join("");
    fixToolSelect.value = available.some((tool) => tool.id === remembered) ? remembered : available[0]?.id || "";
    return null;
  } catch (error: any) {
    fixTools = [{ id: "ruff", label: "Ruff (TC001)", kinds: ["type_only"] }];
    fixToolSelect.innerHTML = '<option value="ruff">Ruff (TC001)</option>';
    return error.toString();
  }
}

function renderInspector(mod: ModuleInfo) {
  if (!currentResult) return;
  const outsideCurrentDiagram = currentViewMode === "file" && !!cy?.$id(mod.id).hasClass("hidden");
  const isCycle = currentResult.cycles.some((c) => c.modules.includes(mod.id));
  const editor = editorSelect.value;

  // 1. Inbound edges (modules that import this module)
  const inboundEdges = currentResult.edges.filter((e) => e.target === mod.id);
  // 2. Outbound edges (modules that this module imports)
  const outboundEdges = currentResult.edges.filter((e) => e.source === mod.id);
  const outboundIds = new Set(outboundEdges.map((e) => e.target));

  // 3. Circular cycles: direct cycles vs downstream cycles from dependencies
  const directCycles = currentResult.cycles.filter((c) => c.modules.includes(mod.id));
  const depCycles = currentResult.cycles.filter(
    (c) => !c.modules.includes(mod.id) && c.modules.some((m) => outboundIds.has(m))
  );

  let cycleAlertHtml = "";
  if (isCycle) {
    const cycleMods = currentResult.cycles
      .filter((c) => c.modules.includes(mod.id))
      .flatMap((c) => c.modules)
      .filter((m) => m !== mod.id);
    const cyclePartners = [...new Set(cycleMods)].map((m) => m.split(".").pop()).join(", ");
    cycleAlertHtml = `
      <div style="background:#3d141e; border:1.5px solid #ff4d4d; border-radius:6px; padding:8px 10px; margin-bottom:12px; font-size:0.75rem; color:#ff8099; line-height:1.45;">
        <div style="font-weight:bold; color:#ff4d4d; font-size:0.82rem; display:flex; align-items:center; gap:5px; margin-bottom:4px;">
          <span>⚠️ トップレベルの循環インポート</span>
        </div>
        <div>このモジュールと <b style="color:#ffffff;">[${escapeHtml(cyclePartners)}]</b> の間に循環があります。初期化時の参照順によっては ImportError などの原因になります。</div>
      </div>
    `;
  }

  inspectorContent.innerHTML = `
    <div class="module-detail">
      ${outsideCurrentDiagram ? '<p style="color: var(--text-muted); font-size: 0.82rem; margin-bottom: 10px;">現在の依存図には含まれません。図を切り替えるには、下のボタンまたはツリーのダブルクリックを使ってください。</p>' : ""}
      <div style="display: flex; gap: 8px; margin-bottom: 10px;">
        <button id="btn-show-this-dep" class="btn-primary" style="flex: 1.2; padding: 7px 10px; font-size: 0.82rem;" title="メイン画面にこのファイルの依存図を表示">
          🎯 このモジュールの依存図を表示
        </button>
        <button id="btn-open-dep-dialog" class="btn-secondary" style="flex: 1; padding: 7px 10px; font-size: 0.82rem;" title="指定モジュールを中心とする依存関係ダイアログ図をポップアップ表示">
          📊 ポップアップ図
        </button>
      </div>

      <!-- 依存関係ダイアグラム ミニフローカード -->
      <div class="dep-flow-card" id="flow-card-open" title="クリックで大きな依存ダイアログ図を表示">
        <div class="dep-flow-node inbound-node-box" title="このモジュールを利用している数">
          <div class="flow-label">📥 利用元</div>
          <div class="flow-val">${inboundEdges.length} 件</div>
        </div>
        <div class="flow-arrow">➔</div>
        <div class="dep-flow-node focal-node-box" title="指定モジュール">
          <div class="flow-label">🎯 指定</div>
          <div class="flow-val">${mod.name}</div>
        </div>
        <div class="flow-arrow">➔</div>
        <div class="dep-flow-node outbound-node-box" title="このモジュールが利用している数">
          <div class="flow-label">📤 利用先</div>
          <div class="flow-val">${outboundEdges.length} 件</div>
        </div>
      </div>

      ${cycleAlertHtml}

      <h2 style="font-size: 1.1rem; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
        <span>${mod.name}</span>
        ${isCycle ? '<span class="tag tag-cycle">循環</span>' : ""}
        ${mod.is_oversized ? '<span class="tag tag-bloat">肥大化</span>' : ""}
      </h2>
      <p style="color: var(--text-muted); font-size: 0.78rem; word-break: break-all; margin-bottom: 12px; font-family: monospace;">
        ${mod.relative_path}
      </p>

      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px; margin-bottom: 12px;">
        <div style="background: #181825; padding: 8px; border-radius: 4px;">
          <div style="color: var(--text-muted); font-size: 0.72rem;">行数 (LOC)</div>
          <div style="font-size: 1.05rem; font-weight: bold;">${mod.loc}</div>
        </div>
        <div style="background: #181825; padding: 8px; border-radius: 4px;">
          <div style="color: var(--text-muted); font-size: 0.72rem;">クラス / 関数</div>
          <div style="font-size: 1.05rem; font-weight: bold;">${mod.class_count} / ${mod.function_count}</div>
        </div>
        <div style="background: #181825; padding: 8px; border-radius: 4px;">
          <div style="color: var(--text-muted); font-size: 0.72rem;">利用元 / 依存先</div>
          <div style="font-size: 1.05rem; font-weight: bold;">${mod.afferent_coupling || 0} / ${mod.efferent_coupling || 0}</div>
        </div>
        <div style="background: #181825; padding: 8px; border-radius: 4px;">
          <div style="color: var(--text-muted); font-size: 0.72rem;">循環的複雑度</div>
          <div style="font-size: 1.05rem; font-weight: bold;">${mod.cyclomatic_complexity || 1}</div>
        </div>
      </div>

      <button id="btn-jump-code" class="btn-jump" style="margin-top: 0; margin-bottom: 14px;">
        ${editor === "pycharm" ? "PyCharm で開く" : "VS Code で開く"}
      </button>

      <!-- インポート / 依存モジュール (利用先) -->
      <div class="inspector-section">
        <div class="inspector-section-title">
          <span>📤 インポート (利用先)</span>
          <span class="inspector-section-count">${outboundEdges.length} 件</span>
        </div>
        <ul class="dep-list">
          ${
            outboundEdges.length === 0
              ? '<li style="color: var(--text-muted); padding: 4px;">インポートはありません (最下層ユーティリティ等)</li>'
              : outboundEdges
                  .map((edge) => {
                    const tgtMod = currentResult!.modules.find((m) => m.id === edge.target);
                    const name = tgtMod ? tgtMod.name : edge.target.split(".").pop() || edge.target;
                    const path = tgtMod ? tgtMod.relative_path : "";
                    const inDirectCycle = edge.is_circular;
                    const inDownstreamCycle =
                      !inDirectCycle && currentResult!.cycles.some((c) => c.modules.includes(edge.target));
                    const isDeferred = edge.is_top_level === false;
                    return `
                      <li class="dep-item">
                        <div class="dep-item-left" title="${edge.target} (${path}${isDeferred ? ' - 遅延インポート' : ''})">
                          <span class="dep-item-name" data-select-mod="${edge.target}">${name}</span>
                          ${inDirectCycle ? '<span class="tag tag-cycle" style="font-size:0.65rem; padding:1px 3px;">🔄 循環</span>' : ""}
                          ${isDeferred && !inDirectCycle ? '<span style="color:#a6adc8; font-size:0.65rem; background:#181825; border:1px solid #45475a; padding:1px 4px; border-radius:3px;" title="関数・メソッド内の遅延インポート（モジュール初期化時にはロードされないため循環エラーを回避）">⚡ 遅延インポート</span>' : ""}
                          ${inDownstreamCycle ? '<span class="tag tag-bloat" style="font-size:0.65rem; padding:1px 3px;" title="この依存先の下流で循環インポートが発生">⚠️ 先で循環</span>' : ""}
                        </div>
                        <div class="dep-item-actions">
                          <span class="dep-item-line" data-jump-file="${mod.absolute_path}" data-jump-line="${edge.line}" title="import文の行を開く">L:${edge.line}</span>
                        </div>
                      </li>
                    `;
                  })
                  .join("")
          }
        </ul>
      </div>

      <div class="inspector-section">
        <div class="inspector-section-title">
          <span>🌐 外部 / 未解決 import</span>
          <span class="inspector-section-count">${mod.unresolved_imports?.length || 0} 件</span>
        </div>
        ${(mod.unresolved_imports?.length || 0) === 0
          ? '<p style="color: var(--success-color); font-size: 0.78rem; padding: 4px;">ありません</p>'
          : `<ul class="dep-list">${mod.unresolved_imports!.map((name) => `<li class="dep-item"><span class="dep-item-name">${escapeHtml(name)}</span></li>`).join("")}</ul>`}
      </div>

      <!-- 被インポート / 被依存モジュール (利用元) -->
      <div class="inspector-section">
        <div class="inspector-section-title">
          <span>📥 被インポート (利用元)</span>
          <span class="inspector-section-count">${inboundEdges.length} 件</span>
        </div>
        <ul class="dep-list">
          ${
            inboundEdges.length === 0
              ? '<li style="color: var(--text-muted); padding: 4px;">被インポートはありません (エントリポイント等)</li>'
              : inboundEdges
                  .map((edge) => {
                    const srcMod = currentResult!.modules.find((m) => m.id === edge.source);
                    const name = srcMod ? srcMod.name : edge.source.split(".").pop() || edge.source;
                    const path = srcMod ? srcMod.relative_path : "";
                    const inCycle = edge.is_circular;
                    const isDeferred = edge.is_top_level === false;
                    return `
                      <li class="dep-item">
                        <div class="dep-item-left" title="${edge.source} (${path}${isDeferred ? ' - 遅延インポート' : ''})">
                          <span class="dep-item-inbound-name" data-select-mod="${edge.source}">${name}</span>
                          ${inCycle ? '<span class="tag tag-cycle" style="font-size:0.65rem; padding:1px 3px;">🔄 循環</span>' : ""}
                          ${isDeferred && !inCycle ? '<span style="color:#a6adc8; font-size:0.65rem; background:#181825; border:1px solid #45475a; padding:1px 4px; border-radius:3px;" title="利用元の関数内での遅延インポート">⚡ 遅延インポート</span>' : ""}
                        </div>
                        <div class="dep-item-actions">
                          ${
                            srcMod
                              ? `<span class="dep-item-line" data-jump-file="${srcMod.absolute_path}" data-jump-line="${edge.line}" title="利用元の該当行を開く">L:${edge.line}</span>`
                              : `<span class="dep-item-line">L:${edge.line}</span>`
                          }
                        </div>
                      </li>
                    `;
                  })
                  .join("")
          }
        </ul>
      </div>

      <div class="inspector-section" style="margin-bottom: 12px;">
        <div class="inspector-section-title">docstring</div>
        <div style="white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.78rem; line-height: 1.5; padding: 8px; background: #181825; border-radius: 4px;">${mod.docstring ? escapeHtml(mod.docstring) : '<span style="color: var(--text-muted);">docstring なし</span>'}</div>
      </div>

      <div class="inspector-section" style="margin-bottom: 12px;">
        <div class="inspector-section-title">クラス一覧 (${mod.classes?.length || 0})</div>
        ${(mod.classes?.length || 0) > 0
          ? mod.classes!.map((cls) => `<div class="module-class-item" data-class-line="${cls.line}" style="cursor: pointer; padding: 5px 8px; border-bottom: 1px solid var(--border-color);">${escapeHtml(cls.name)} <span style="color: var(--text-muted);">L:${cls.line}</span></div>`).join("")
          : '<div style="color: var(--text-muted); font-size: 0.78rem; padding: 5px 8px;">クラスなし</div>'}
      </div>

      <div class="inspector-section" style="margin-bottom: 12px;">
        <div class="inspector-section-title">関数一覧 (${mod.functions?.length || 0})</div>
        ${(mod.functions?.length || 0) > 0
          ? mod.functions!.map((fn) => `<div class="module-function-item" data-function-line="${fn.line}" style="cursor: pointer; padding: 5px 8px; border-bottom: 1px solid var(--border-color);">${escapeHtml(fn.name)} <span style="color: var(--text-muted);">L:${fn.line}</span></div>`).join("")
          : '<div style="color: var(--text-muted); font-size: 0.78rem; padding: 5px 8px;">関数なし</div>'}
      </div>

      <div class="inspector-section" style="margin-bottom: 12px;">
        <div class="inspector-section-title">シンボル呼び出し (${mod.symbol_calls?.length || 0})</div>
        ${(mod.symbol_calls?.length || 0) === 0
          ? '<div style="color: var(--text-muted); font-size: 0.78rem; padding: 5px 8px;">呼び出しなし</div>'
          : mod.symbol_calls!.map((call) => `<div class="module-function-item" data-symbol-line="${call.line}" style="cursor: pointer; padding: 5px 8px; border-bottom: 1px solid var(--border-color);">${escapeHtml(call.caller)} ➜ ${escapeHtml(call.callee)} <span style="color: var(--text-muted);">L:${call.line}</span></div>`).join("")}
        <button id="btn-open-callgraph" class="btn-secondary btn-sm" style="margin-top:8px">コールグラフを表示</button>
      </div>

      <div class="inspector-section">
        <div class="inspector-section-title">
          <span>🏛 アーキテクチャルール違反</span>
          <span class="inspector-section-count">${(currentResult.architecture_violations || []).filter((v) => v.source === mod.id).length} 件</span>
        </div>
        ${(() => {
          const violations = (currentResult!.architecture_violations || []).filter((v) => v.source === mod.id);
          return violations.length === 0
            ? '<p style="color: var(--success-color); font-size: 0.78rem; padding: 4px;">違反はありません</p>'
            : `<ul class="dep-list">${violations.map((v) => `<li class="dep-item" data-architecture-line="${v.line}" title="クリックして違反箇所を開く" style="cursor:pointer"><div><span class="dep-item-name">${escapeHtml(v.message)}</span><span class="dep-item-line">L:${v.line}</span></div><small style="color:var(--text-muted)">提案: ${escapeHtml(v.suggestion || "依存方向を見直してください")}</small></li>`).join("")}</ul>`;
        })()}
      </div>

      <div class="inspector-section">
        <div class="inspector-section-title">
          <span>📦 依存宣言の問題</span>
          <span class="inspector-section-count">${(currentResult.dependency_issues || []).filter((v) => v.module === mod.id).length} 件</span>
        </div>
        <ul class="dep-list">${(currentResult.dependency_issues || []).filter((v) => v.module === mod.id)
          .map((v) => `<li class="dep-item"><span class="dep-item-name">${escapeHtml(v.rule)} ${escapeHtml(v.package)}: ${escapeHtml(v.message)}</span></li>`).join("") || '<li class="dep-item">問題はありません</li>'}</ul>
      </div>

      <div class="inspector-section">
        <div class="inspector-section-title">
          <span>🧹 未使用シンボル候補</span>
          <span class="inspector-section-count">${mod.unused_symbol_candidates?.length || 0} 件</span>
        </div>
        ${(mod.unused_symbol_candidates?.length || 0) === 0
          ? '<p style="color: var(--success-color); font-size: 0.78rem; padding: 4px;">候補はありません</p>'
          : `<ul class="dep-list">${mod.unused_symbol_candidates!.map((name) => `<li class="dep-item"><span class="dep-item-name">${escapeHtml(name)}</span></li>`).join("")}</ul>`}
      </div>

      <!-- 循環インポートのグラフィカル可視化カード -->
      ${
        directCycles.length > 0 || depCycles.length > 0
          ? `
        <div class="cycle-card">
          <div class="cycle-card-header">
            <div class="cycle-card-title">
              <span>🔄 循環インポート検出</span>
            </div>
          </div>
          <div class="cycle-flow-container">
            ${directCycles
              .map(
                (c, cIdx) => `
              <div class="cycle-flow-row">
                <div style="font-size: 0.72rem; color: var(--danger-color); font-weight: bold; width: 100%; margin-bottom: 2px;">
                  [直接循環 #${cIdx + 1}・代表経路]
                </div>
                ${renderCyclePath(c, mod.id)}
                ${renderCycleSuggestion(c)}
                <div style="margin-left: auto;">
                  <button class="btn-cycle-focus" data-cycle-idx="${cIdx}" data-cycle-type="direct">強調表示</button>
                </div>
              </div>`
              )
              .join("")}

            ${depCycles
              .map(
                (c, cIdx) => `
              <div class="cycle-flow-row" style="border-left-color: var(--warning-color);">
                <div style="font-size: 0.72rem; color: var(--warning-color); font-weight: bold; width: 100%; margin-bottom: 2px;">
                  [依存先の下流で循環 #${cIdx + 1}・代表経路]
                </div>
                ${renderCyclePath(c, mod.id)}
                ${renderCycleSuggestion(c)}
                <div style="margin-left: auto;">
                  <button class="btn-cycle-focus" data-cycle-idx="${cIdx}" data-cycle-type="dep">強調表示</button>
                </div>
              </div>`
              )
              .join("")}
          </div>
        </div>
      `
          : ""
      }

      <!-- 診断 / 型チェック -->
      <div class="inspector-section" style="margin-top: 14px;">
        <div class="inspector-section-title">
          <span>診断 / 型チェック</span>
          <span class="inspector-section-count">${mod.diagnostics.length} 件</span>
        </div>
        <div style="font-size: 0.82rem; max-height: 120px; overflow-y: auto;">
          ${
            mod.diagnostics.length === 0
              ? '<p style="color: var(--success-color); font-size: 0.78rem; padding: 4px;">問題は見つかりませんでした</p>'
              : mod.diagnostics
                  .map(
                    (d) => `
                    <div data-diagnostic-line="${d.line || 1}" title="クリックして該当行を開く" style="background: #181825; padding: 6px 8px; border-radius: 4px; margin-bottom: 6px; border-left: 3px solid ${
                      d.severity === "error" ? "var(--danger-color)" : "var(--warning-color)"
                    }; cursor: pointer;">
                      <div style="font-weight: 500;">${d.message}</div>
                      <div style="color: var(--text-muted); font-size: 0.72rem;">
                        ${d.rule ? `[${d.rule}] ` : ""}${d.line ? `行: ${d.line}` : ""}
                      </div>
                    </div>`
                  )
                  .join("")
          }
        </div>
      </div>
    </div>
  `;

  // Event handlers for inspector
  inspectorContent.querySelectorAll<HTMLElement>("[data-class-line]").forEach((el) => {
    el.addEventListener("click", () => jumpToEditor(mod.absolute_path, Number(el.dataset.classLine) || 1));
  });
  inspectorContent.querySelectorAll<HTMLElement>("[data-function-line]").forEach((el) => {
    el.addEventListener("click", () => jumpToEditor(mod.absolute_path, Number(el.dataset.functionLine) || 1));
  });
  inspectorContent.querySelectorAll<HTMLElement>("[data-symbol-line]").forEach((el) => {
    el.addEventListener("click", () => jumpToEditor(mod.absolute_path, Number(el.dataset.symbolLine) || 1));
  });
  inspectorContent.querySelectorAll<HTMLElement>("[data-architecture-line]").forEach((el) => {
    el.addEventListener("click", () => jumpToEditor(mod.absolute_path, Number(el.dataset.architectureLine) || 1));
  });
  document.getElementById("btn-open-callgraph")?.addEventListener("click", () => openCallGraph(mod));
  inspectorContent.querySelectorAll<HTMLElement>("[data-diagnostic-line]").forEach((el) => {
    el.addEventListener("click", () => jumpToEditor(mod.absolute_path, Number(el.dataset.diagnosticLine) || 1));
  });
  document.getElementById("btn-open-dep-dialog")?.addEventListener("click", () => {
    openDependencyDialog(mod);
  });
  document.getElementById("btn-show-this-dep")?.addEventListener("click", () => {
    jumpToFileCentricDiagram(mod.id);
  });
  document.getElementById("flow-card-open")?.addEventListener("click", () => {
    openDependencyDialog(mod);
  });

  document.getElementById("btn-jump-code")?.addEventListener("click", () => {
    jumpToEditor(mod.absolute_path, 1);
  });

  // Select module by clicking item in inspector -> jump to its dependency diagram
  inspectorContent.querySelectorAll("[data-select-mod]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const mId = el.getAttribute("data-select-mod");
      if (mId) jumpToFileCentricDiagram(mId);
    });
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const mId = el.getAttribute("data-select-mod");
      if (mId) jumpToFileCentricDiagram(mId);
    });
  });

  // Jump to specific file and line
  inspectorContent.querySelectorAll("[data-jump-file]").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const file = el.getAttribute("data-jump-file") || mod.absolute_path;
      const line = Number(el.getAttribute("data-jump-line")) || 1;
      jumpToEditor(file, line);
    });
  });

  // Cycle highlight buttons
  inspectorContent.querySelectorAll(".btn-cycle-focus").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const cType = btn.getAttribute("data-cycle-type");
      const cIdx = Number(btn.getAttribute("data-cycle-idx"));
      const cycleList = cType === "direct" ? directCycles : depCycles;
      if (cycleList[cIdx]) {
        highlightCycleInGraph(cycleList[cIdx].modules);
      }
    });
  });
  inspectorContent.querySelectorAll(".btn-preview-ruff-fix").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const source = btn.getAttribute("data-cycle-source");
      const line = Number(btn.getAttribute("data-cycle-line"));
      if (source && line > 0) void previewRuffCycleFix(source, line);
    });
  });
}

async function previewRuffCycleFix(source: string, line: number) {
  if (!currentResult) return;
  const toolId = fixToolSelect.value;
  statusBar.innerText = "外部ツールの修正差分を確認中...";
  try {
    const preview = await invokeCommand<{ file: string; diff: string; tool: string }>("preview_cycle_fix", {
      path: currentResult.root_path, source, line, toolId,
    });
    if (!preview.diff.trim()) {
      statusBar.innerText = `${preview.tool} は修正差分を提示しませんでした`;
      return;
    }
    activeFixToolName = preview.tool;
    (document.getElementById("ruff-fix-title") as HTMLElement).textContent = `${preview.tool} の修正差分`;
    ruffFixFile.textContent = preview.file;
    ruffFixDiff.textContent = preview.diff;
    btnApplyRuffFix.disabled = false;
    ruffFixModal.classList.remove("hidden");
    statusBar.innerText = `${preview.tool} の差分を表示しています`;
  } catch (error: any) {
    statusBar.innerText = `外部ツールの差分確認に失敗: ${error.toString()}`;
  }
}

function closeRuffFixModal() {
  ruffFixModal.classList.add("hidden");
}

async function applyRuffCycleFix() {
  btnApplyRuffFix.disabled = true;
  const before = currentResult?.cycles.length ?? 0;
  try {
    const file = await invokeCommand<string>("apply_cycle_fix");
    closeRuffFixModal();
    const analyzed = await runAnalysis();
    const after = currentResult?.cycles.length ?? 0;
    statusBar.innerText = analyzed
      ? `${activeFixToolName} の修正を適用しました: ${file}（循環 ${before} → ${after} 件）`
      : `${activeFixToolName} の修正を適用しました: ${file}。再解析を実行してください`;
  } catch (error: any) {
    closeRuffFixModal();
    statusBar.innerText = `外部ツールの修正に失敗: ${error.toString()}。差分を再表示してください`;
  } finally {
    btnApplyRuffFix.disabled = false;
  }
}

function highlightCycleInGraph(cycleModules: string[]) {
  if (!cy) return;

  cy.elements().removeClass("cycle-pulse highlighted highlighted-in highlighted-out faded");

  const cycleModSet = new Set(cycleModules);
  const cycleNodes = cy.nodes().filter((n) => cycleModSet.has(n.id()));
  const cycleEdges = cy.edges().filter((e) => cycleModSet.has(e.source().id()) && cycleModSet.has(e.target().id()));

  cycleNodes.addClass("cycle-pulse");
  cycleEdges.addClass("cycle-pulse");

  // Fade non-cycle elements
  cy.elements().difference(cycleNodes.union(cycleEdges)).addClass("faded");
  cycleNodes.parents().removeClass("faded");

  cy.animate({
    fit: {
      eles: cycleNodes.union(cycleEdges),
      padding: 80,
    },
    duration: 400,
  });

  // Also pulse in modal if open
  if (modalCy) {
    modalCy.elements().removeClass("cycle-pulse");
    const mNodes = modalCy.nodes().filter((n) => cycleModSet.has(n.id()));
    const mEdges = modalCy.edges().filter((e) => cycleModSet.has(e.source().id()) && cycleModSet.has(e.target().id()));
    mNodes.addClass("cycle-pulse");
    mEdges.addClass("cycle-pulse");
  }

  statusBar.innerText = `循環インポートループをグラフィカル表示: ${cycleModules.map(m => m.split(".").pop()).join(" ➔ ")}`;
}

// ==========================================
// 依存ダイアログ図 (Modal Dependency Diagram)
// ==========================================

function openDependencyDialog(mod: ModuleInfo) {
  if (!currentResult || !dependencyModal) return;
  currentModalModule = mod;

  modalModuleTitle.innerText = mod.name;
  modalModuleTitle.title = mod.id;

  const isCycle = currentResult.cycles.some((c) => c.modules.includes(mod.id));
  let badgesHtml = `<span class="badge" style="background:#313244;color:#cdd6f4;">LOC: ${mod.loc}</span>`;
  if (isCycle) {
    badgesHtml += '<span class="tag tag-cycle">循環インポート</span>';
  }
  if (mod.is_oversized) {
    badgesHtml += '<span class="tag tag-bloat">モジュール肥大化</span>';
  }
  modalHeaderBadges.innerHTML = badgesHtml;

  dependencyModal.classList.remove("hidden");

  // Allow browser layout pass before initializing Cytoscape
  requestAnimationFrame(() => {
    renderModalGraph(mod);
  });
}

function closeDependencyDialog() {
  if (!dependencyModal) return;
  dependencyModal.classList.add("hidden");
  if (modalCy) {
    modalCy.destroy();
    modalCy = null;
  }
  currentModalModule = null;
}

function renderModalGraph(mod: ModuleInfo) {
  if (!currentResult || !modalCyContainer) return;

  if (modalCy) {
    modalCy.destroy();
    modalCy = null;
  }

  const fileData = calculateFileCentricGraph(mod, currentResult);

  let cycleFooterHtml = "";
  if (fileData.hasCrashingCycle) {
    const rootNames = fileData.roots.map((r) => r.split(".").pop()).join(", ") || "エントリポイント";
    const cycleNames = [...fileData.cycleModules].map((id) => id.split(".").pop()).join(" ⟷ ");
    cycleFooterHtml = `
      <span style="color: var(--danger-color); font-weight: bold;">⚠️ トップレベルの循環インポート:</span>
      <span style="color: var(--text-main);">ルーツ <b style="color:var(--success-color);">[${rootNames}]</b> からのインポート経路と循環ループ <b style="color:var(--danger-color);">[${cycleNames}]</b> を描画中</span>
    `;
  } else {
    cycleFooterHtml = `<span style="color: var(--success-color);">✓ このモジュール周辺にトップレベルの循環インポートはありません</span>`;
  }
  modalCyclesInfo.innerHTML = cycleFooterHtml;

  const elements: cytoscape.ElementDefinition[] = [];

  // 1. Nodes to display in modal
  fileData.allowedNodeIds.forEach((nodeId) => {
    const m = currentResult!.modules.find((x) => x.id === nodeId);
    const labelName = m ? m.name : nodeId.split(".").pop() || nodeId;
    const isFocal = nodeId === mod.id;
    const isRoot = fileData.roots.includes(nodeId);
    const isCycle = fileData.cycleModules.has(nodeId);

    let displayLabel = labelName;
    let nodeClasses = "";
    let width = Math.max(140, labelName.length * 9.5 + 34);
    let height = 48;

    if (isFocal) {
      displayLabel = `🎯 ${labelName}\n(起点モジュール)`;
      nodeClasses = "focal-node" + (isCycle ? " in-cycle" : "");
      width = Math.max(175, labelName.length * 10.5 + 44);
      height = 58;
    } else if (isRoot) {
      displayLabel = `🌱 ${labelName}\n[ルーツ]`;
      nodeClasses = "root-node";
    } else if (isCycle) {
      displayLabel = `🚨 ${labelName}\n[循環]`;
      nodeClasses = "in-cycle";
    } else {
      const isInbound = currentResult!.edges.some((e) => e.source === nodeId && e.target === mod.id);
      if (isInbound) {
        displayLabel = `${labelName}\n[利用元]`;
        nodeClasses = "inbound-node";
      } else {
        displayLabel = `${labelName}\n[利用先]`;
        nodeClasses = "outbound-node";
      }
    }

    elements.push({
      group: "nodes",
      data: {
        id: nodeId,
        label: displayLabel,
        width,
        height,
      },
      classes: nodeClasses,
    });
  });

  // 2. Edges to display in modal
  currentResult.edges.forEach((edge, idx) => {
    const edgeKey = `${edge.source}->${edge.target}`;
    if (fileData.allowedEdgeKeys.has(edgeKey)) {
      let edgeClass = "normal-edge";
      if (edge.is_circular) {
        edgeClass = "cycle-edge";
      } else if (edge.target === mod.id) {
        edgeClass = "inbound-edge";
      } else if (edge.source === mod.id) {
        edgeClass = "outbound-edge";
      }

      elements.push({
        group: "edges",
        data: {
          id: `modal-e-${idx}`,
          source: edge.source,
          target: edge.target,
          label: edge.is_circular ? `🚨 循環 (L:${edge.line})` : `L:${edge.line}`,
        },
        classes: edgeClass,
      });
    }
  });

  modalCy = cytoscape({
    container: modalCyContainer,
    boxSelectionEnabled: false,
    elements,
    style: [
      {
        selector: "node",
        style: {
          shape: "round-rectangle",
          label: "data(label)",
          "text-wrap": "wrap",
          "text-max-width": "180px",
          color: "#cdd6f4",
          "font-size": "13px",
          "font-weight": 600,
          "text-valign": "center",
          "text-halign": "center",
          width: "data(width)",
          height: "data(height)",
          "border-width": 2,
          "border-color": "#45475a",
          "background-color": "#181825",
          padding: "6px",
        },
      },
      {
        selector: "node.focal-node",
        style: {
          shape: "round-rectangle",
          "background-color": "#2c281e",
          "border-color": "#f9e2af",
          "border-width": 4.0,
          color: "#f9e2af",
          "font-size": "14px",
          "font-weight": 700,
          "z-index": 1200,
        },
      },
      {
        selector: "node.root-node",
        style: {
          shape: "round-rectangle",
          "background-color": "#1e2e24",
          "border-color": "#a6e3a1",
          "border-width": 3.5,
          color: "#a6e3a1",
          "font-size": "13px",
          "font-weight": 700,
          "z-index": 1100,
        },
      },
      {
        selector: "node.inbound-node",
        style: {
          shape: "round-rectangle",
          "background-color": "#1e2e24",
          "border-color": "#a6e3a1",
          "border-width": 2.5,
          color: "#a6e3a1",
        },
      },
      {
        selector: "node.outbound-node",
        style: {
          shape: "round-rectangle",
          "background-color": "#182438",
          "border-color": "#89b4fa",
          "border-width": 2.5,
          color: "#89b4fa",
        },
      },
      {
        selector: "node.in-cycle",
        style: {
          "border-color": "#ff4d4d",
          "border-width": 4,
          "background-color": "#38141e",
          color: "#ff8099",
          "font-weight": 700,
          "z-index": 1000,
        },
      },
      {
        selector: "node.cycle-pulse",
        style: {
          "border-color": "#ff3333",
          "border-width": 6,
          "background-color": "#ff3333",
          color: "#ffffff",
          "z-index": 9999,
        },
      },
      {
        selector: "edge",
        style: {
          width: 3.0,
          "line-color": "#7f849c",
          "target-arrow-color": "#89b4fa",
          "target-arrow-shape": "triangle",
          "curve-style": "bezier",
          "control-point-step-size": 40,
          "arrow-scale": 1.45,
          label: "data(label)",
          "font-size": "12px",
          color: "#cdd6f4",
          "text-background-opacity": 0.85,
          "text-background-color": "#11111b",
          "text-background-padding": "2px",
          "text-background-shape": "roundrectangle",
        },
      },
      {
        selector: "edge.inbound-edge",
        style: {
          width: 3.5,
          "line-color": "#a6e3a1",
          "target-arrow-color": "#a6e3a1",
          "arrow-scale": 1.5,
        },
      },
      {
        selector: "edge.outbound-edge",
        style: {
          width: 3.5,
          "line-color": "#89b4fa",
          "target-arrow-color": "#89b4fa",
          "arrow-scale": 1.5,
        },
      },
      {
        selector: "edge.cycle-edge",
        style: {
          width: 4.5,
          "line-color": "#ff4d4d",
          "target-arrow-color": "#ff4d4d",
          "line-style": "dashed",
          "line-dash-pattern": [6, 4],
          "curve-style": "bezier",
          "control-point-step-size": 55,
          "arrow-scale": 1.7,
          label: "data(label)",
          "font-size": "12px",
          "font-weight": "bold",
          color: "#ff8599",
          "text-background-opacity": 0.95,
          "text-background-color": "#2b0d14",
          "text-background-padding": "3px",
          "text-background-shape": "roundrectangle",
          "text-border-color": "#ff4d4d",
          "text-border-width": 1,
          "z-index": 1000,
        },
      },
      {
        selector: "edge.cycle-pulse",
        style: {
          width: 5.5,
          "line-color": "#ff3333",
          "target-arrow-color": "#ff3333",
          "line-style": "dashed",
          "line-dash-pattern": [8, 4],
          "arrow-scale": 1.8,
          "z-index": 9999,
        },
      },
    ],
  });

  runModalLayout();

  // Clicking any node inside the modal updates the modal to focus that module
  modalCy.on("tap", "node", (evt) => {
    const clickedId = evt.target.id();
    if (clickedId !== mod.id) {
      const targetMod = currentResult?.modules.find((m) => m.id === clickedId);
      if (targetMod) {
        selectModuleById(targetMod.id, true);
        openDependencyDialog(targetMod);
      }
    }
  });

  modalCy.on("dblclick", "node", (evt) => {
    const clickedId = evt.target.id();
    const targetMod = currentResult?.modules.find((m) => m.id === clickedId);
    if (targetMod) {
      jumpToEditor(targetMod.absolute_path, 1);
    }
  });
}

function runModalLayout() {
  if (!modalCy) return;
  const layoutVal = modalLayoutSelect.value;
  let layoutOptions: any = {
    name: "dagre",
    rankDir: "LR",
    nodeSep: 40,
    rankSep: 130,
    edgeSep: 30,
    padding: 50,
    animate: false,
  };

  if (layoutVal === "dagre-tb") {
    layoutOptions = {
      name: "dagre",
      rankDir: "TB",
      nodeSep: 40,
      rankSep: 110,
      edgeSep: 30,
      padding: 50,
      animate: false,
    };
  } else if (layoutVal === "cose") {
    layoutOptions = {
      name: "cose",
      idealEdgeLength: 130,
      padding: 50,
      animate: false,
    };
  }

  modalCy.layout(layoutOptions).run();
  modalCy.fit(undefined, 40);
  if (modalCy.zoom() > 1.2) {
    modalCy.zoom(1.2);
    modalCy.center();
  }
}

function updateSummary(result: AnalysisResult) {
  const cycleCount = result.cycles.length;
  const bloatCount = result.modules.filter((m) => m.is_oversized).length;
  const errorCount = result.analysis_errors?.length || 0;
  const architectureCount = result.architecture_violations?.length || 0;
  const packageCount = result.package_dependencies?.length || 0;
  const dependencyIssueCount = result.dependency_issues?.length || 0;
  const unusedCount = result.modules.reduce((sum, module) => sum + (module.unused_symbol_candidates?.length || 0), 0);
  metricsSummary.innerText = `モジュール数: ${result.modules.length} | 循環インポート: ${cycleCount} | 肥大化警告: ${bloatCount} | 設計違反: ${architectureCount} | 依存宣言の問題: ${dependencyIssueCount} | パッケージ: ${packageCount} | 未使用候補: ${unusedCount} | 破壊的変更候補: ${lastBreakingChanges.length} | 解析エラー: ${errorCount} | 総行数: ${result.total_loc}`;
  statusBar.innerText = errorCount > 0
    ? `解析完了（${errorCount} ファイルを解析できませんでした） (${result.root_path})`
    : `解析完了 (${result.root_path})`;
}

function openCallGraph(module: ModuleInfo) {
  if (!currentResult || !callGraphModal || !callGraphContainer) return;
  const edges = (currentResult.symbol_edges || []).filter((edge) =>
    edge.source_module === module.id || edge.target_module === module.id
  );
  if (callGraphCy) callGraphCy.destroy();
  const nodes = new Map<string, { id: string; label: string; module: string; symbol: string }>();
  const graphEdges: cytoscape.ElementDefinition[] = [];
  const addNode = (moduleId: string, symbol: string) => {
    const id = `${moduleId}::${symbol}`;
    if (!nodes.has(id)) nodes.set(id, { id, label: `${moduleId}\n${symbol}`, module: moduleId, symbol });
    return id;
  };
  for (const edge of edges) {
    const source = addNode(edge.source_module, edge.source_symbol);
    const target = addNode(edge.target_module, edge.target_symbol);
    graphEdges.push({ group: "edges", data: { id: `call-${graphEdges.length}`, source, target, line: edge.line } });
  }
  // Include local calls for the selected module so a small module still has a useful graph.
  for (const call of module.symbol_calls || []) {
    const source = addNode(module.id, call.caller);
    const target = addNode(module.id, call.callee);
    graphEdges.push({ group: "edges", data: { id: `call-${graphEdges.length}`, source, target, line: call.line } });
  }
  if (nodes.size === 0) {
    callGraphContainer.innerHTML = '<p class="placeholder-text">解析できるシンボル間の呼び出しはありません</p>';
  } else {
    callGraphContainer.innerHTML = "";
    callGraphCy = cytoscape({
      container: callGraphContainer,
      elements: [...Array.from(nodes.values()).map((node): cytoscape.ElementDefinition => ({ group: "nodes", data: node })), ...graphEdges],
      style: [
        { selector: "node", style: { "background-color": "#89b4fa", label: "data(label)", color: "#11111b", "text-valign": "center", "text-halign": "center", "font-size": 10, shape: "roundrectangle", padding: "8px", width: "label", height: 32 } },
        { selector: `node[id^="${module.id}::"]`, style: { "background-color": "#a6e3a1" } },
        { selector: "edge", style: { width: 2, "line-color": "#89b4fa", "target-arrow-color": "#89b4fa", "target-arrow-shape": "triangle", "curve-style": "bezier", label: "data(line)", "font-size": 8, color: "#a6adc8" } },
      ],
      layout: { name: "dagre", rankDir: "LR", nodeSep: 35, rankSep: 100, padding: 40, animate: false } as any,
    });
    callGraphCy.on("dblclick", "node", (event) => {
      const node = event.target.data();
      const targetModule = currentResult?.modules.find((item) => item.id === node.module);
      const symbol = targetModule?.symbols?.find((item) => item.name === node.symbol || item.name.endsWith(`.${node.symbol}`));
      if (targetModule) void jumpToEditor(targetModule.absolute_path, symbol?.line || 1);
    });
  }
  if (callGraphTitle) callGraphTitle.textContent = `コールグラフ: ${module.id}`;
  callGraphModal.classList.remove("hidden");
}

function closeCallGraph() {
  callGraphModal?.classList.add("hidden");
  callGraphCy?.destroy();
  callGraphCy = null;
}

function showAnalysisHistory() {
  if (!currentResult) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const history = readAnalysisHistory(currentResult.root_path);
  const previousSnapshot = history.length >= 2 ? history[history.length - 2] : undefined;
  const lines = history.slice().reverse().map((snapshot) => {
    const result = snapshot.result;
    return `${new Date(snapshot.timestamp).toLocaleString()} : ${result.modules.length} modules / ${result.cycles.length} cycles / ${result.total_loc} LOC`;
  });
  const comparison = previousSnapshot ? compareAnalysisIssues(previousSnapshot.result, currentResult) : null;
  const statusSection = (title: string, status: "introduced" | "resolved" | "continuing", label: string) => {
    if (!comparison) return "";
    const issues = comparison[title as "cycles" | "architecture" | "dependencies"][status];
    return `${label} (${issues.length})${issues.length ? `\n${issues.map((issue) => `  • ${issue}`).join("\n")}` : ""}`;
  };
  const sections = comparison ? [
    "循環インポート",
    ...(["introduced", "resolved", "continuing"] as const).map((status) => statusSection("cycles", status, { introduced: "新規", resolved: "解消", continuing: "継続" }[status])),
    "設計ルール違反",
    ...(["introduced", "resolved", "continuing"] as const).map((status) => statusSection("architecture", status, { introduced: "新規", resolved: "解消", continuing: "継続" }[status])),
    "依存ルール違反",
    ...(["introduced", "resolved", "continuing"] as const).map((status) => statusSection("dependencies", status, { introduced: "新規", resolved: "解消", continuing: "継続" }[status])),
  ].join("\n") : "前回の解析がないため、差分はありません。次回の解析から新規・解消・継続を表示します。";
  const comparisonHeader = previousSnapshot
    ? `前回 (${new Date(previousSnapshot.timestamp).toLocaleString()}) と今回の比較\n\n`
    : "前回との比較\n\n";
  window.alert(`解析履歴 (${history.length} 件)\n\n${comparisonHeader}${sections}\n\n履歴一覧\n${lines.join("\n")}`);
}

async function jumpToEditor(filePath: string, line: number = 1) {
  const editor = editorSelect.value;
  try {
    await invokeCommand("open_in_editor", {
      editor,
      filePath,
      line,
    });
    statusBar.innerText = `${editor} で ${filePath}:${line} を開きました`;
  } catch (err: any) {
    statusBar.innerText = `エディタ起動エラー: ${err.toString()}`;
  }
}

async function runAnalysis() {
  const path = pathInput.value.trim();
  if (!path) {
    statusBar.innerText = "Python プロジェクトのパスを入力してください";
    pathInput.focus();
    return false;
  }
  if (analysisRunning) {
    manualAnalysisPending = true;
    return false;
  }
  analysisRunning = true;
  localStorage.setItem("project_path", path);
  statusBar.innerText = `解析中: ${path}...`;
  try {
    const result = await invokeCommand<AnalysisResult>("analyze_project", { path });
    const toolError = await refreshFixTools(path);
    updateGraph(result);
    if (chkWatch.checked) {
      await startWatching(path);
    }
    if (toolError) statusBar.innerText = `修正ツールの設定エラー: ${toolError}`;
    return true;
  } catch (err: any) {
    statusBar.innerText = `エラー: ${err.toString()}`;
    return false;
  } finally {
    analysisRunning = false;
    if (manualAnalysisPending) {
      manualAnalysisPending = false;
      void runAnalysis();
    } else if (analysisPending && watchedPath) {
      scheduleAnalysisFromFileChange();
    }
  }
}

let watchTimer: number | null = null;
let analysisRunning = false;
let analysisPending = false;
let manualAnalysisPending = false;
let watchedPath = "";
const pendingChangedFiles = new Set<string>();

async function startWatching(path: string) {
  try {
    await invokeCommand("watch_project", { path });
    watchedPath = path;
    statusBar.innerText = `解析完了・自動更新中 (${path})`;
  } catch (err: any) {
    chkWatch.checked = false;
    statusBar.innerText = `監視開始エラー: ${err.toString()}`;
  }
}

async function stopWatching() {
  try {
    await invokeCommand("stop_watching");
    watchedPath = "";
    analysisPending = false;
    pendingChangedFiles.clear();
    if (watchTimer !== null) {
      window.clearTimeout(watchTimer);
      watchTimer = null;
    }
    statusBar.innerText = "自動更新を停止しました";
  } catch (err: any) {
    statusBar.innerText = `監視停止エラー: ${err.toString()}`;
  }
}

function scheduleAnalysisFromFileChange(paths: string[] = []) {
  if (!chkWatch.checked || !watchedPath) return;
  paths.forEach((path) => pendingChangedFiles.add(path));
  analysisPending = true;
  if (watchTimer !== null) window.clearTimeout(watchTimer);
  statusBar.innerText = "ファイル変更を検知しました。再解析を待機中...";
  watchTimer = window.setTimeout(async () => {
    watchTimer = null;
    if (analysisRunning) return;
    analysisRunning = true;
    analysisPending = false;
    const changedFiles = [...pendingChangedFiles];
    pendingChangedFiles.clear();
    try {
      const path = watchedPath;
      statusBar.innerText = `変更を再解析中: ${path}...`;
      const result = await invokeCommand<AnalysisResult>("analyze_project", { path, changedFiles });
      if (path !== watchedPath) return;
      const toolError = await refreshFixTools(path);
      updateGraph(result);
      statusBar.innerText = toolError
        ? `修正ツールの設定エラー: ${toolError}`
        : `自動更新完了 (${new Date().toLocaleTimeString()})`;
    } catch (err: any) {
      statusBar.innerText = `自動再解析エラー: ${err.toString()}`;
    } finally {
      analysisRunning = false;
      if (manualAnalysisPending) {
        manualAnalysisPending = false;
        void runAnalysis();
      } else if (analysisPending && watchedPath) {
        scheduleAnalysisFromFileChange();
      }
    }
  }, 500);
}

async function initFileWatcherEvents() {
  if (typeof window === "undefined" || !(window as any).__TAURI_INTERNALS__) return;
  const { listen } = await import("@tauri-apps/api/event");
  await listen<string[]>("project-changed", (event) => scheduleAnalysisFromFileChange(event.payload));
}

async function detectEditors() {
  try {
    const detected = await invokeCommand<string[]>("detect_editors");
    const hasPycharm = detected.some((name) => name.startsWith("pycharm"));
    const hasVscode = detected.includes("code");
    for (const option of Array.from(editorSelect.options)) {
      const available = option.value === "pycharm" ? hasPycharm : hasVscode;
      option.title = available ? "検出済み" : "コマンドが PATH に見つかりません";
    }
  } catch {
    // The editor can still be opened through URL schemes when CLI detection fails.
  }
}

async function highlightGitChanges() {
  if (!currentResult || !pathInput.value.trim()) return;
  try {
    const files = await invokeCommand<string[]>("git_changed_files", { path: pathInput.value.trim() });
    highlightChangedFiles(files, "Git差分");
  } catch (err: any) {
    statusBar.innerText = `Git差分の取得エラー: ${err.toString()}`;
  }
}

function highlightChangedFiles(files: string[], label: string) {
  if (!currentResult) return;
    const normalized = new Set(files.map((file) => file.split("\\").join("/").replace(/^\.\//, "")));
    gitChangedModuleIds = new Set(
      currentResult.modules.filter((mod) => normalized.has(mod.relative_path.split("\\").join("/"))).map((mod) => mod.id)
    );
    cy?.nodes().removeClass("git-changed");
    for (const id of gitChangedModuleIds) cy?.$id(id).addClass("git-changed");
    statusBar.innerText = gitChangedModuleIds.size === 0
      ? `${label}に該当する Python ファイルはありません`
      : `${label}: ${gitChangedModuleIds.size} モジュールを強調表示しました`;
}

async function highlightGitHistory() {
  if (!currentResult || !pathInput.value.trim()) return;
  const base = window.prompt("比較元コミット", "HEAD~1");
  const head = window.prompt("比較先コミット", "HEAD");
  if (!base || !head) return;
  try {
    const files = await invokeCommand<string[]>("git_diff_files", { path: pathInput.value.trim(), base, head });
    highlightChangedFiles(files, `${base}..${head}`);
  } catch (err: any) {
    statusBar.innerText = `履歴差分の取得エラー: ${err.toString()}`;
  }
}

function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function exportReport() {
  if (!currentResult) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  downloadFile(`moduleloom-report-${stamp}.json`, JSON.stringify(currentResult, null, 2), "application/json");
  const dotNodes = currentResult.modules.map((mod) => `  "${mod.id}" [label="${mod.name.replace(/"/g, '\\"')}\\nLOC: ${mod.loc}"];`).join("\n");
  const dotEdges = currentResult.edges.map((edge) => `  "${edge.source}" -> "${edge.target}"${edge.is_circular ? " [color=red,style=dashed]" : ""};`).join("\n");
  downloadFile(`moduleloom-graph-${stamp}.dot`, `digraph ModuleLoom {\n  rankdir=LR;\n${dotNodes}\n${dotEdges}\n}\n`, "text/vnd.graphviz");
  const rows = currentResult.modules.map((mod) => `<tr><td>${escapeHtml(mod.id)}</td><td>${mod.loc}</td><td>${mod.cyclomatic_complexity || 1}</td><td>${mod.afferent_coupling || 0}</td><td>${mod.efferent_coupling || 0}</td><td>${mod.is_oversized ? "肥大化" : ""}</td><td>${(mod.unresolved_imports || []).map(escapeHtml).join(", ")}</td></tr>`).join("");
  const packages = (currentResult.package_dependencies || []).map((pkg) => `<li>${escapeHtml(pkg.name)} ${escapeHtml(pkg.version || "")} <small>(${escapeHtml(pkg.source)})</small></li>`).join("");
  const dependencyIssues = (currentResult.dependency_issues || []).map((issue) => `<li>${escapeHtml(issue.rule)} ${escapeHtml(issue.package)}: ${escapeHtml(issue.message)}</li>`).join("");
  const html = `<!doctype html><meta charset="utf-8"><title>ModuleLoom Report</title><style>body{font-family:sans-serif;margin:2rem}table{border-collapse:collapse}td,th{border:1px solid #ccc;padding:.4rem;text-align:left}</style><h1>ModuleLoom Report</h1><p>Root: ${escapeHtml(currentResult.root_path)}</p><h2>Package dependencies</h2><ul>${packages || "<li>なし</li>"}</ul><h2>依存宣言の問題</h2><ul>${dependencyIssues || "<li>なし</li>"}</ul><table><tr><th>Module</th><th>LOC</th><th>複雑度</th><th>利用元</th><th>依存先</th><th>警告</th><th>外部 / 未解決 import</th></tr>${rows}</table>`;
  downloadFile(`moduleloom-report-${stamp}.html`, html, "text/html");
  statusBar.innerText = "JSON と HTML レポートを出力しました";
}

async function exportMkDocs() {
  if (!currentResult) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const root = currentResult.root_path.replace(/[\\/]$/, "");
  const separator = root.includes("\\") ? "\\" : "/";
  const output = window.prompt("MkDocs プロジェクトの出力先", `${root}${separator}moduleloom-docs`)?.trim();
  if (!output) return;
  let lang = window.prompt("ドキュメントの言語 (auto / ja / en / fr / de / es / zh / ko / pt)", "auto")?.trim() || "auto";
  if (lang.toLowerCase() === "auto") {
    const locale = (navigator.language || "en").split(/[-_]/)[0].toLowerCase();
    lang = ["ja", "en", "fr", "de", "es", "zh", "ko", "pt"].includes(locale) ? locale : "en";
  }
  const preview = `生成先: ${output}\nモジュール数: ${currentResult.modules.length}\n言語: ${lang}\n\nMkDocs プロジェクトを生成しますか？`;
  if (!window.confirm(preview)) return;
  try {
    await invokeCommand<string>("generate_mkdocs", { path: currentResult.root_path, output, lang });
    statusBar.innerText = `MkDocs ドキュメントを生成しました: ${output}`;
  } catch (error: any) {
    statusBar.innerText = `MkDocs 出力エラー: ${error.toString()}`;
  }
}

function getMockAnalysisResult(root: string): AnalysisResult {
  return {
    root_path: root,
    total_loc: 890,
    modules: [
      {
        id: "app.client",
        name: "client",
        relative_path: "app/client.py",
        absolute_path: `${root}/app/client.py`,
        loc: 75,
        class_count: 1,
        function_count: 2,
        imports: [
          { module: "app.main", is_from: true, level: 1, line: 3, imported_names: ["start_server"] },
        ],
        is_oversized: false,
        diagnostics: [],
      },
      {
        id: "app.main",
        name: "main",
        relative_path: "app/main.py",
        absolute_path: `${root}/app/main.py`,
        loc: 85,
        class_count: 1,
        function_count: 3,
        imports: [
          { module: "app.router", is_from: true, level: 1, line: 4, imported_names: ["api_router"] },
          { module: "app.config", is_from: true, level: 1, line: 5, imported_names: ["Settings"] },
        ],
        is_oversized: false,
        diagnostics: [],
      },
      {
        id: "app.router",
        name: "router",
        relative_path: "app/router.py",
        absolute_path: `${root}/app/router.py`,
        loc: 140,
        class_count: 2,
        function_count: 5,
        imports: [
          { module: "app.service", is_from: true, level: 1, line: 3, imported_names: ["UserService"] },
          { module: "app.main", is_from: true, level: 1, line: 6, imported_names: ["app"] },
        ],
        is_oversized: false,
        diagnostics: [
          { severity: "warning", message: "型アノテーションが一部不足しています", line: 24, rule: "ty-type-check" },
        ],
      },
      {
        id: "app.service",
        name: "service",
        relative_path: "app/service.py",
        absolute_path: `${root}/app/service.py`,
        loc: 520,
        class_count: 5,
        function_count: 18,
        imports: [
          { module: "app.models", is_from: true, level: 1, line: 2, imported_names: ["User"] },
        ],
        is_oversized: true,
        diagnostics: [
          { severity: "warning", message: "モジュール行数が 500 行を超過しています (LOC: 520)", line: 1, rule: "module-bloat" },
        ],
      },
      {
        id: "app.models",
        name: "models",
        relative_path: "app/models.py",
        absolute_path: `${root}/app/models.py`,
        loc: 60,
        class_count: 2,
        function_count: 1,
        imports: [
          { module: "app.storage", is_from: true, level: 1, line: 4, imported_names: ["DBEngine"] },
        ],
        is_oversized: false,
        diagnostics: [],
      },
      {
        id: "app.storage",
        name: "storage",
        relative_path: "app/storage.py",
        absolute_path: `${root}/app/storage.py`,
        loc: 110,
        class_count: 1,
        function_count: 4,
        imports: [
          { module: "app.models", is_from: true, level: 1, line: 2, imported_names: ["ModelBase"] },
        ],
        is_oversized: false,
        diagnostics: [],
      },
    ],
    edges: [
      { source: "app.client", target: "app.main", is_circular: false, line: 3 },
      { source: "app.main", target: "app.router", is_circular: true, line: 4 },
      { source: "app.router", target: "app.main", is_circular: true, line: 6 },
      { source: "app.router", target: "app.service", is_circular: false, line: 3 },
      { source: "app.service", target: "app.models", is_circular: false, line: 2 },
      { source: "app.models", target: "app.storage", is_circular: true, line: 4 },
      { source: "app.storage", target: "app.models", is_circular: true, line: 2 },
    ],
    cycles: [
      { modules: ["app.main", "app.router"] },
      { modules: ["app.models", "app.storage"] },
    ],
  };
}

function zoomIn() {
  if (!cy) return;
  const currentZoom = cy.zoom();
  const center = { x: cy.width() / 2, y: cy.height() / 2 };
  cy.zoom({ level: currentZoom * 1.3, renderedPosition: center });
}

function zoomOut() {
  if (!cy) return;
  const currentZoom = cy.zoom();
  const center = { x: cy.width() / 2, y: cy.height() / 2 };
  cy.zoom({ level: currentZoom * 0.75, renderedPosition: center });
}

function zoomReset() {
  if (!cy) return;
  const center = { x: cy.width() / 2, y: cy.height() / 2 };
  cy.zoom({ level: 1.0, renderedPosition: center });
}

function zoomFit() {
  if (!cy) return;
  cy.fit(undefined, 30);
}

// Tree View Implementation (Python Files Only)
function buildFileTree(modules: ModuleInfo[]): FileTreeNode {
  const root: FileTreeNode = {
    name: "root",
    relPath: "",
    isDir: true,
    children: new Map(),
  };

  for (const mod of modules) {
    const parts = mod.relative_path.split(/[/\\]+/).filter(Boolean);
    let current = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentRelPath = parts.slice(0, i + 1).join("/");

      if (isLast) {
        current.children.set(part, {
          name: part,
          relPath: currentRelPath,
          isDir: false,
          module: mod,
          children: new Map(),
        });
      } else {
        if (!current.children.has(part)) {
          current.children.set(part, {
            name: part,
            relPath: currentRelPath,
            isDir: true,
            children: new Map(),
          });
        }
        current = current.children.get(part)!;
      }
    }
  }

  return root;
}

function countPythonFiles(node: FileTreeNode): number {
  if (!node.isDir) return 1;
  let count = 0;
  for (const child of node.children.values()) {
    count += countPythonFiles(child);
  }
  return count;
}

function createTreeElement(node: FileTreeNode, cycleSet: Set<string>, isRoot = false): HTMLElement {
  const container = document.createElement("div");
  if (!isRoot) {
    container.className = "tree-node";
    container.dataset.path = node.relPath;
  }

  if (!isRoot) {
    const row = document.createElement("div");
    row.className = "tree-item-row";

    if (node.isDir) {
      row.innerHTML = `
        <span class="tree-arrow expanded">▶</span>
        <span class="tree-icon">📁</span>
        <span class="tree-label" title="${node.relPath}">${node.name}</span>
        <span class="tree-meta">(${countPythonFiles(node)})</span>
      `;
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        const arrow = row.querySelector(".tree-arrow");
        const childrenContainer = container.querySelector(":scope > .tree-children");
        if (childrenContainer) {
          const isCollapsed = childrenContainer.classList.toggle("collapsed");
          arrow?.classList.toggle("expanded", !isCollapsed);
        }
      });
    } else {
      const mod = node.module!;
      row.dataset.moduleId = mod.id;
      row.dataset.relPath = node.relPath;

      const isCycle = cycleSet.has(mod.id);
      const isBloat = mod.is_oversized;

      let badgesHtml = "";
      if (isCycle) {
        badgesHtml += '<span class="tree-badge-cycle" title="循環インポート"></span>';
      }
      if (isBloat) {
        badgesHtml += '<span class="tree-badge-bloat" title="モジュール肥大化"></span>';
      }

      row.innerHTML = `
        <span class="tree-arrow" style="visibility: hidden;">▶</span>
        <span class="tree-icon">🐍</span>
        <span class="tree-label" title="${node.relPath}">${node.name}</span>
        ${badgesHtml}
        <span class="tree-meta">${mod.loc}L</span>
        <button class="btn-tree-jump" title="外部エディタで開く">📝</button>
      `;

      row.querySelector(".btn-tree-jump")?.addEventListener("click", (e) => {
        e.stopPropagation();
        jumpToEditor(mod.absolute_path, 1);
      });

      // A single click selects the file; a double click opens its dependency diagram.
      row.addEventListener("click", (e) => {
        e.stopPropagation();
        if (currentViewMode === "overview") selectedModule = mod;
        renderInspector(mod);
        highlightTreeNode(mod.id);
        const graphNode = cy?.$id(mod.id);
        if (graphNode?.length && !graphNode.hasClass("hidden")) updateNodeFocus(graphNode);
      });

      row.addEventListener("dblclick", (e) => {
        e.preventDefault();
        e.stopPropagation();
        jumpToFileCentricDiagram(mod.id);
      });
    }

    container.appendChild(row);
  }

  if (node.children.size > 0) {
    const childrenContainer = document.createElement("div");
    childrenContainer.className = "tree-children";

    // Sort: directories first (alphabetical), then files (alphabetical)
    const sortedChildren = Array.from(node.children.values()).sort((a, b) => {
      if (a.isDir !== b.isDir) {
        return a.isDir ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });

    for (const child of sortedChildren) {
      childrenContainer.appendChild(createTreeElement(child, cycleSet));
    }

    container.appendChild(childrenContainer);
  }

  return container;
}

function renderTree(result: AnalysisResult) {
  if (!treeContent) return;
  const cycleSet = new Set<string>();
  result.cycles.forEach((c) => c.modules.forEach((m) => cycleSet.add(m)));

  const root = buildFileTree(result.modules);
  treeContent.innerHTML = "";

  if (root.children.size === 0) {
    treeContent.innerHTML = '<p class="placeholder-text">Python ファイルが見つかりませんでした</p>';
    return;
  }

  const domTree = createTreeElement(root, cycleSet, true);
  treeContent.appendChild(domTree);

  if (selectedModule) {
    highlightTreeNode(selectedModule.id);
  }
}

function filterTree() {
  const query = treeSearchInput.value.trim().toLowerCase();
  if (!treeContent) return;

  const fileRows = treeContent.querySelectorAll<HTMLElement>(".tree-item-row[data-module-id]");
  if (!query) {
    treeContent.querySelectorAll<HTMLElement>(".tree-node").forEach((el) => {
      el.style.display = "";
    });
    return;
  }

  // Hide all tree-nodes initially
  treeContent.querySelectorAll<HTMLElement>(".tree-node").forEach((el) => {
    el.style.display = "none";
  });

  fileRows.forEach((row) => {
    const relPath = (row.dataset.relPath || "").toLowerCase();
    const label = (row.querySelector(".tree-label")?.textContent || "").toLowerCase();
    if (relPath.includes(query) || label.includes(query)) {
      const fileNode = row.closest<HTMLElement>(".tree-node");
      if (fileNode) fileNode.style.display = "";

      // Walk up and display/expand ancestors
      let curr = row.parentElement;
      while (curr && curr !== treeContent) {
        if (curr.classList.contains("tree-node")) {
          curr.style.display = "";
        }
        if (curr.classList.contains("tree-children")) {
          curr.classList.remove("collapsed");
          const arrow = curr.parentElement?.querySelector(":scope > .tree-item-row .tree-arrow");
          arrow?.classList.add("expanded");
        }
        curr = curr.parentElement;
      }
    }
  });
}

function collapseAllTree() {
  if (!treeContent) return;
  treeContent.querySelectorAll(".tree-children").forEach((el) => {
    el.classList.add("collapsed");
  });
  treeContent.querySelectorAll(".tree-arrow").forEach((el) => {
    el.classList.remove("expanded");
  });
}

function expandAllTree() {
  if (!treeContent) return;
  treeContent.querySelectorAll(".tree-children").forEach((el) => {
    el.classList.remove("collapsed");
  });
  treeContent.querySelectorAll(".tree-arrow").forEach((el) => {
    el.classList.add("expanded");
  });
}

function toggleTreePanel(forceState?: boolean) {
  if (!treePanel) return;
  const isCollapsed = forceState !== undefined ? !forceState : !treePanel.classList.contains("collapsed");
  treePanel.classList.toggle("collapsed", isCollapsed);
  btnToggleTree.classList.toggle("active", !isCollapsed);
  if (cy) {
    setTimeout(() => cy?.resize(), 200);
  }
}

// Event Listeners
document.getElementById("btn-git-diff")?.addEventListener("click", highlightGitChanges);
document.getElementById("btn-git-history")?.addEventListener("click", highlightGitHistory);
document.getElementById("btn-export-report")?.addEventListener("click", exportReport);
document.getElementById("btn-export-mkdocs")?.addEventListener("click", exportMkDocs);
document.getElementById("btn-history")?.addEventListener("click", showAnalysisHistory);
document.getElementById("btn-close-ruff-fix")?.addEventListener("click", closeRuffFixModal);
btnApplyRuffFix.addEventListener("click", () => { void applyRuffCycleFix(); });
fixToolSelect.addEventListener("change", () => {
  if (currentResult) localStorage.setItem(`moduleloom-fix-tool:${currentResult.root_path}`, fixToolSelect.value);
  if (selectedModule) renderInspector(selectedModule);
});
document.getElementById("btn-dependency-issues")?.addEventListener("click", showDependencyIssues);
document.getElementById("btn-find-chain")?.addEventListener("click", findAndHighlightChain);
document.getElementById("btn-back")?.addEventListener("click", goBack);
btnShowOverview?.addEventListener("click", toggleOverviewOrFileView);
btnAnalyze.addEventListener("click", runAnalysis);
searchInput.addEventListener("input", applyFilters);
chkOnlyCycles.addEventListener("change", applyFilters);
chkOnlyBloat.addEventListener("change", applyFilters);
graphRadius.addEventListener("change", applyFilters);
clusterLimit.addEventListener("change", () => { if (currentResult) updateGraph(currentResult); });
chkExternals.addEventListener("change", () => { if (currentResult) updateGraph(currentResult); });
chkGroupPackages.addEventListener("change", () => {
  if (currentResult) updateGraph(currentResult);
});
layoutSelect.addEventListener("change", runLayout);
btnFlowDirection.addEventListener("click", () => {
  flowDirection = flowDirection === "LR" ? "TB" : "LR";
  localStorage.setItem("flow_direction", flowDirection);
  updateFlowDirectionButton();
  if (currentViewMode === "file") applyFilters();
  else {
    layoutSelect.value = "dagre";
    runLayout();
  }
});
btnFit.addEventListener("click", zoomFit);

// Header Zoom Controls
document.getElementById("btn-header-zoom-in")?.addEventListener("click", zoomIn);
document.getElementById("btn-header-zoom-out")?.addEventListener("click", zoomOut);

// Floating Canvas Zoom Controls
document.getElementById("btn-float-zoom-in")?.addEventListener("click", zoomIn);
document.getElementById("btn-float-zoom-out")?.addEventListener("click", zoomOut);
document.getElementById("btn-float-zoom-reset")?.addEventListener("click", zoomReset);
document.getElementById("btn-float-zoom-fit")?.addEventListener("click", zoomFit);

chkFocusMode.addEventListener("change", () => {
  if (selectedModule && cy) {
    const node = cy.$id(selectedModule.id);
    if (node.length > 0) {
      updateNodeFocus(node);
    }
  }
});

chkDirectOnly?.addEventListener("change", () => {
  applyFilters();
});
chkWatch.addEventListener("change", () => {
  if (chkWatch.checked && pathInput.value.trim()) {
    void startWatching(pathInput.value.trim());
  } else {
    void stopWatching();
  }
});

// Dependency Modal Listeners
modalLayoutSelect?.addEventListener("change", runModalLayout);
btnModalFit?.addEventListener("click", () => modalCy?.fit(undefined, 40));
btnModalZoomIn?.addEventListener("click", () => {
  if (!modalCy) return;
  modalCy.zoom({
    level: modalCy.zoom() * 1.3,
    renderedPosition: { x: modalCy.width() / 2, y: modalCy.height() / 2 },
  });
});
btnModalZoomOut?.addEventListener("click", () => {
  if (!modalCy) return;
  modalCy.zoom({
    level: modalCy.zoom() * 0.75,
    renderedPosition: { x: modalCy.width() / 2, y: modalCy.height() / 2 },
  });
});
btnCloseModal?.addEventListener("click", closeDependencyDialog);
btnModalCloseFooter?.addEventListener("click", closeDependencyDialog);
document.getElementById("btn-close-callgraph")?.addEventListener("click", closeCallGraph);
document.getElementById("btn-close-callgraph-footer")?.addEventListener("click", closeCallGraph);
btnModalJumpEditor?.addEventListener("click", () => {
  if (currentModalModule) {
    jumpToEditor(currentModalModule.absolute_path, 1);
  }
});
dependencyModal?.addEventListener("click", (e) => {
  if (e.target === dependencyModal) {
    closeDependencyDialog();
  }
});
callGraphModal?.addEventListener("click", (e) => {
  if (e.target === callGraphModal) closeCallGraph();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dependencyModal?.classList.contains("hidden")) {
    closeDependencyDialog();
  }
  if (e.key === "Escape" && !callGraphModal?.classList.contains("hidden")) {
    closeCallGraph();
  }
});

editorSelect.addEventListener("change", () => {
  localStorage.setItem("preferred_editor", editorSelect.value);
  if (selectedModule) {
    renderInspector(selectedModule);
  }
});

// Tree Panel Controls
btnToggleTree?.addEventListener("click", () => toggleTreePanel());
btnCloseTree?.addEventListener("click", () => toggleTreePanel(false));
btnTreeCollapseAll?.addEventListener("click", collapseAllTree);
btnTreeExpandAll?.addEventListener("click", expandAllTree);
treeSearchInput?.addEventListener("input", filterTree);

document.getElementById("btn-close-inspector")?.addEventListener("click", () => {
  inspectorContent.innerHTML = '<p class="placeholder-text">グラフ上のノードまたはツリーをクリックすると詳細が表示されます</p>';
  clearHighlights();
  selectedModule = null;
  if (treeContent) {
    treeContent.querySelectorAll(".tree-item-row.selected").forEach((el) => {
      el.classList.remove("selected");
    });
  }
});

// Load preferences
const savedEditor = localStorage.getItem("preferred_editor");
if (savedEditor && (savedEditor === "pycharm" || savedEditor === "vscode")) {
  editorSelect.value = savedEditor;
}

// Initialize
updateFlowDirectionButton();
initGraph();
void initFileWatcherEvents();
void detectEditors();
pathInput.value = localStorage.getItem("project_path") || "";
if (pathInput.value) runAnalysis();
else statusBar.innerText = "Python プロジェクトのパスを入力して解析を実行してください";
