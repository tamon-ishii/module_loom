import cytoscape, { Core, EventObject } from "cytoscape";
// @ts-ignore
import dagre from "cytoscape-dagre";

cytoscape.use(dagre);

interface ImportStmt {
  module: string;
  is_from: boolean;
  level: number;
  line: number;
  imported_names: string[];
  is_top_level?: boolean;
}

interface Diagnostic {
  severity: "info" | "warning" | "error";
  message: string;
  line?: number;
  rule?: string;
}

interface ModuleInfo {
  id: string;
  name: string;
  relative_path: string;
  absolute_path: string;
  docstring?: string | null;
  loc: number;
  class_count: number;
  classes?: { name: string; line: number }[];
  function_count: number;
  functions?: { name: string; line: number }[];
  imports: ImportStmt[];
  is_oversized: boolean;
  diagnostics: Diagnostic[];
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char] || char);
}

interface DependencyEdge {
  source: string;
  target: string;
  is_circular: boolean;
  line: number;
  import_count?: number;
  is_top_level?: boolean;
}

interface CircularCycle {
  modules: string[];
}

interface AnalysisResult {
  root_path: string;
  modules: ModuleInfo[];
  edges: DependencyEdge[];
  cycles: CircularCycle[];
  total_loc: number;
}

// State
let cy: Core | null = null;
let currentResult: AnalysisResult | null = null;
let selectedModule: ModuleInfo | null = null;

// DOM Elements
const pathInput = document.getElementById("project-path-input") as HTMLInputElement;
const btnAnalyze = document.getElementById("btn-analyze") as HTMLButtonElement;
const searchInput = document.getElementById("search-input") as HTMLInputElement;
const chkOnlyCycles = document.getElementById("chk-only-cycles") as HTMLInputElement;
const chkOnlyBloat = document.getElementById("chk-only-bloat") as HTMLInputElement;
const chkGroupPackages = document.getElementById("chk-group-packages") as HTMLInputElement;
const chkFocusMode = document.getElementById("chk-focus-mode") as HTMLInputElement;
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
          "font-size": "11px",
          "font-weight": 600,
          "text-valign": "center",
          "text-halign": "center",
          "text-wrap": "wrap",
          "text-max-width": "120px",
          width: "data(width)",
          height: "data(height)",
          padding: "6px",
        },
      },
      // Package compound parent node (Directory box)
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
          "font-size": "12px",
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
          "font-size": "12px",
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
          "font-size": "11.5px",
          "font-weight": "bold",
          "z-index": 1100,
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
          "font-size": "10px",
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
          "font-size": "11px",
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
    if (!mod) return;
    if (currentViewMode === "overview") selectedModule = mod;
    renderInspector(mod);
    highlightTreeNode(mod.id);
    updateNodeFocus(node);
  });

  cy.on("dblclick dbltap", "node", (evt: EventObject) => {
    const node = evt.target;
    if (node.isParent()) return;

    const moduleId = node.id();
    jumpToFileCentricDiagram(moduleId);
  });

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

interface FileCentricGraphData {
  allowedNodeIds: Set<string>;
  allowedEdgeKeys: Set<string>;
  hasCrashingCycle: boolean;
  roots: string[];
  cycleModules: Set<string>;
  rootPaths: string[][];
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
    statusBar.innerHTML = `🚨【クラッシュする循環参照】ルーツ [${rootNames}] からのインポート経路を描画中: [${cyclePartners}] で相互参照クラッシュ`;
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
  currentResult = result;

  const cycleNodeIds = new Set<string>();
  result.cycles.forEach((c) => c.modules.forEach((m) => cycleNodeIds.add(m)));

  const elements: cytoscape.ElementDefinition[] = [];
  const groupPackages = chkGroupPackages.checked;
  const packageParents = new Set<string>();

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
        width,
        height,
        parent: parentId,
      },
      classes: classes.join(" "),
    });
  });

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

  cy.elements().remove();
  cy.add(elements);

  renderTree(result);
  updateSummary(result);

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

  cy.layout(options).run();
  cy.fit(undefined, 40);
}

function applyFilters() {
  if (!cy || !currentResult) return;
  const searchTerm = searchInput.value.trim().toLowerCase();
  const onlyCycles = chkOnlyCycles.checked;
  const onlyBloat = chkOnlyBloat.checked;
  const isFileMode = currentViewMode === "file" && selectedModule !== null;

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
    const modName = mod ? mod.name : id.split(".").pop() || id;
    const nameLower = modName.toLowerCase();

    let match = true;
    if (fileData && !fileData.allowedNodeIds.has(id)) {
      match = false;
    }
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

    if (sourceNode?.hasClass("hidden") || targetNode?.hasClass("hidden")) {
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
          <span>🚨 循環参照エラー検出</span>
        </div>
        <div>このモジュールは <b style="color:#ffffff;">[${cyclePartners}]</b> と相互に参照しています。<br>実行時の循環参照エラー（ImportError）の根本原因です。</div>
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
                  [直接循環 #${cIdx + 1}]
                </div>
                ${c.modules
                  .map(
                    (mId) =>
                      `<span class="cycle-pill ${mId === mod.id ? "current" : ""}" data-select-mod="${mId}" title="${mId}">${mId.split(".").pop()}</span>`
                  )
                  .join('<span class="cycle-arrow">➔</span>')}
                <span class="cycle-arrow">➔</span>
                <span class="cycle-pill ${c.modules[0] === mod.id ? "current" : ""}" data-select-mod="${c.modules[0]}" title="${c.modules[0]}">${c.modules[0].split(".").pop()}</span>
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
                  [依存先の下流で循環 #${cIdx + 1}]
                </div>
                ${c.modules
                  .map(
                    (mId) =>
                      `<span class="cycle-pill" data-select-mod="${mId}" title="${mId}">${mId.split(".").pop()}</span>`
                  )
                  .join('<span class="cycle-arrow" style="color:var(--warning-color)">➔</span>')}
                <span class="cycle-arrow" style="color:var(--warning-color)">➔</span>
                <span class="cycle-pill" data-select-mod="${c.modules[0]}" title="${c.modules[0]}">${c.modules[0].split(".").pop()}</span>
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
                    <div style="background: #181825; padding: 6px 8px; border-radius: 4px; margin-bottom: 6px; border-left: 3px solid ${
                      d.severity === "error" ? "var(--danger-color)" : "var(--warning-color)"
                    }">
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
      <span style="color: var(--danger-color); font-weight: bold;">🚨 クラッシュする循環参照検出:</span>
      <span style="color: var(--text-main);">ルーツ <b style="color:var(--success-color);">[${rootNames}]</b> からのインポート経路と循環ループ <b style="color:var(--danger-color);">[${cycleNames}]</b> を描画中</span>
    `;
  } else {
    cycleFooterHtml = `<span style="color: var(--success-color);">✓ このモジュール周辺にクラッシュする循環インポートはありません</span>`;
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
    let width = Math.max(130, labelName.length * 9 + 30);
    let height = 44;

    if (isFocal) {
      displayLabel = `🎯 ${labelName}\n(起点モジュール)`;
      nodeClasses = "focal-node" + (isCycle ? " in-cycle" : "");
      width = Math.max(160, labelName.length * 10 + 40);
      height = 52;
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
          "text-max-width": "150px",
          color: "#cdd6f4",
          "font-size": "11px",
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
          "font-size": "12px",
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
          "font-size": "11.5px",
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
          "font-size": "10px",
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
          "font-size": "10px",
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
  metricsSummary.innerText = `モジュール数: ${result.modules.length} | 循環インポート: ${cycleCount} | 肥大化警告: ${bloatCount} | 総行数: ${result.total_loc}`;
  statusBar.innerText = `解析完了 (${result.root_path})`;
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
    return;
  }
  localStorage.setItem("project_path", path);
  statusBar.innerText = `解析中: ${path}...`;
  try {
    const result = await invokeCommand<AnalysisResult>("analyze_project", { path });
    updateGraph(result);
  } catch (err: any) {
    statusBar.innerText = `エラー: ${err.toString()}`;
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
interface FileTreeNode {
  name: string;
  relPath: string;
  isDir: boolean;
  module?: ModuleInfo;
  children: Map<string, FileTreeNode>;
}

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
btnShowOverview?.addEventListener("click", toggleOverviewOrFileView);
btnAnalyze.addEventListener("click", runAnalysis);
searchInput.addEventListener("input", applyFilters);
chkOnlyCycles.addEventListener("change", applyFilters);
chkOnlyBloat.addEventListener("change", applyFilters);
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
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && !dependencyModal?.classList.contains("hidden")) {
    closeDependencyDialog();
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
pathInput.value = localStorage.getItem("project_path") || "";
if (pathInput.value) runAnalysis();
else statusBar.innerText = "Python プロジェクトのパスを入力して解析を実行してください";
