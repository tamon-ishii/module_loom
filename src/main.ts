import "./style.css";
import cytoscape, { Core, EventObject } from "cytoscape";
// @ts-ignore
import dagre from "cytoscape-dagre";
import html2canvas from "html2canvas";
import { escapeHtml } from "./utils";
import { currentUiLocale, initUiLocale, setUiLocale, translateUiText, type UiLocale } from "./i18n";
import { cycleGuidance, cyclePath, cycleSuggestion } from "./cycle-insights";
import {
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
let clusterMemberOf = new Map<string, string>();
let lastCollapseActive = false;
interface FixToolInfo { id: string; label: string; kinds: string[] }
let fixTools: FixToolInfo[] = [{ id: "ruff", label: "Ruff (TC001)", kinds: ["type_only"] }];
let activeFixToolName = "Ruff";

// DOM Elements
const pathInput = document.getElementById("project-path-input") as HTMLInputElement;
const uiLanguage = document.getElementById("ui-language") as HTMLSelectElement;
const btnAnalyze = document.getElementById("btn-analyze") as HTMLButtonElement;
const btnQuality = document.getElementById("btn-quality") as HTMLButtonElement;
const btnInstallSkill = document.getElementById("btn-install-skill") as HTMLButtonElement;
const skillInstallStatus = document.getElementById("skill-install-status") as HTMLElement;
const tabModules = document.getElementById("tab-modules") as HTMLButtonElement;
const tabDiagnostics = document.getElementById("tab-diagnostics") as HTMLButtonElement;
const tabManual = document.getElementById("tab-manual") as HTMLButtonElement;
const manualView = document.getElementById("manual-view") as HTMLElement;
const moduleView = document.getElementById("module-view") as HTMLElement;
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
const btnFlowDirection = document.getElementById("btn-flow-direction") as HTMLButtonElement | null;
const btnFloatFlowDirection = document.getElementById("btn-float-flow-direction") as HTMLButtonElement | null;
let flowDirection: "LR" | "TB" = localStorage.getItem("flow_direction") === "TB" ? "TB" : "LR";
function updateFlowDirectionButton() {
  if (btnFlowDirection) {
    btnFlowDirection.textContent = flowDirection === "LR" ? "↔ 横表示" : "↕ 縦表示";
    btnFlowDirection.title = flowDirection === "LR" ? "依存図の流れを縦方向に切り替え" : "依存図の流れを横方向に切り替え";
  }
  if (btnFloatFlowDirection) {
    btnFloatFlowDirection.textContent = flowDirection === "LR" ? "↔" : "↕";
    btnFloatFlowDirection.title = flowDirection === "LR" ? "フロー方向: 横 (LR) - クリックで縦に切り替え" : "フロー方向: 縦 (TB) - クリックで横に切り替え";
  }
}
const btnFit = document.getElementById("btn-fit") as HTMLButtonElement | null;
const btnShowOverview = document.getElementById("btn-show-overview") as HTMLButtonElement | null;
let currentViewMode: "overview" | "file" = "file";
const editorSelect = document.getElementById("editor-select") as HTMLSelectElement | null;
const hostEditor = (window as any).__MODULELOOM_EDITOR__;
if (hostEditor === "vscode") tabManual.hidden = true;
if (hostEditor === "pycharm" || hostEditor === "vscode") {
  document.querySelector(".editor-select-area")?.remove();
  pathInput.hidden = true;
  btnAnalyze.hidden = true;
}
function preferredEditor(): "pycharm" | "vscode" {
  const hostEditor = (window as any).__MODULELOOM_EDITOR__;
  if (hostEditor === "pycharm" || hostEditor === "vscode") return hostEditor;
  return editorSelect?.value === "vscode" ? "vscode" : "pycharm";
}
const inspectorContent = document.getElementById("inspector-content") as HTMLDivElement;
const statusBar = document.getElementById("status-bar") as HTMLDivElement;
const complexityDashboard = document.getElementById("complexity-dashboard") as HTMLElement;
const complexityDashboardTitle = document.getElementById("complexity-dashboard-title") as HTMLElement;
const complexityDashboardScore = document.getElementById("complexity-dashboard-score") as HTMLElement;
const complexityDashboardContent = document.getElementById("complexity-dashboard-content") as HTMLElement;
let activeWorkspaceTab: "modules" | "diagnostics" | "manual" = "modules";
let graphNeedsFit = false;
function selectWorkspaceTab(tab: "modules" | "diagnostics" | "manual") {
  if (activeWorkspaceTab === tab) return;
  activeWorkspaceTab = tab;
  const modules = tab === "modules";
  moduleView.hidden = !modules;
  complexityDashboard.hidden = tab !== "diagnostics";
  manualView.hidden = tab !== "manual";
  tabModules.classList.toggle("active", modules);
  tabDiagnostics.classList.toggle("active", tab === "diagnostics");
  tabManual.classList.toggle("active", tab === "manual");
  tabModules.setAttribute("aria-selected", String(modules));
  tabDiagnostics.setAttribute("aria-selected", String(tab === "diagnostics"));
  tabManual.setAttribute("aria-selected", String(tab === "manual"));
  tabModules.tabIndex = modules ? 0 : -1;
  tabDiagnostics.tabIndex = tab === "diagnostics" ? 0 : -1;
  tabManual.tabIndex = tab === "manual" ? 0 : -1;
  document.body.dataset.workspaceTab = tab;
  if (tab === "diagnostics") renderIssuesList();
  if (tab === "manual") void refreshManual();
  if (modules) requestAnimationFrame(() => {
    cy?.resize();
    if (graphNeedsFit && cy) {
      const visible = cy.elements().not(".hidden");
      if (visible.length) cy.fit(visible, 30);
      graphNeedsFit = false;
    }
  });
}
for (const [button, tab] of [[tabModules, "modules"], [tabDiagnostics, "diagnostics"], [tabManual, "manual"]] as const) {
  button.addEventListener("click", () => selectWorkspaceTab(tab));
  button.addEventListener("keydown", (event) => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const order = [tabModules, tabDiagnostics, tabManual].filter((item) => !item.hidden);
    const next = order[(order.indexOf(button) + (event.key === "ArrowRight" ? 1 : order.length - 1)) % order.length];
    next.focus();
    selectWorkspaceTab(next === tabModules ? "modules" : next === tabDiagnostics ? "diagnostics" : "manual");
  });
}
const btnResolveCycles = document.getElementById("btn-resolve-cycles") as HTMLButtonElement | null;
const ruffFixModal = document.getElementById("ruff-fix-modal") as HTMLDivElement;
const ruffFixFile = document.getElementById("ruff-fix-file") as HTMLElement;
const ruffFixDiff = document.getElementById("ruff-fix-diff") as HTMLElement;
const btnApplyRuffFix = document.getElementById("btn-apply-ruff-fix") as HTMLButtonElement;
const fixToolSelect = document.getElementById("fix-tool-select") as HTMLSelectElement;
const fixToolControl = document.getElementById("fix-tool-control") as HTMLLabelElement;
const chainFrom = document.getElementById("chain-from") as HTMLSelectElement;
const chainTo = document.getElementById("chain-to") as HTMLSelectElement;

const toolbarMenus = document.querySelectorAll<HTMLDetailsElement>(".toolbar-menu");
toolbarMenus.forEach((menu) => {
  menu.addEventListener("toggle", () => {
    if (menu.open) toolbarMenus.forEach((other) => { if (other !== menu) other.open = false; });
  });
  menu.querySelectorAll("button").forEach((button) => {
    button.addEventListener("click", () => { menu.open = false; });
  });
});
document.addEventListener("pointerdown", (event) => {
  toolbarMenus.forEach((menu) => {
    if (!menu.contains(event.target as Node)) menu.open = false;
  });
});

// Cycle resolve guide modal elements
const cycleGuideModal = document.getElementById("cycle-guide-modal") as HTMLDivElement | null;
const cycleGuidePath = document.getElementById("cycle-guide-path") as HTMLElement | null;
const cycleGuideTargetDesc = document.getElementById("cycle-guide-target-desc") as HTMLElement | null;
const cycleGuideToolReason = document.getElementById("cycle-guide-tool-reason") as HTMLElement | null;
const cycleGuideCodeExample = document.getElementById("cycle-guide-code-example") as HTMLElement | null;
const btnCycleGuideJump = document.getElementById("btn-cycle-guide-jump") as HTMLButtonElement | null;
const cycleGuideJumpLabel = document.getElementById("cycle-guide-jump-label") as HTMLElement | null;
const btnCloseCycleGuide = document.getElementById("btn-close-cycle-guide") as HTMLButtonElement | null;
const btnCloseCycleGuideFooter = document.getElementById("btn-close-cycle-guide-footer") as HTMLButtonElement | null;


// Symbol call graph modal
let callGraphCy: Core | null = null;
const callGraphModal = document.getElementById("callgraph-modal") as HTMLDivElement | null;
const callGraphContainer = document.getElementById("callgraph-cy-container") as HTMLDivElement | null;
const callGraphTitle = document.getElementById("callgraph-title") as HTMLElement | null;

// Tree & Inspector DOM Elements
const treePanel = document.getElementById("tree-panel") as HTMLElement;
const treeResizer = document.getElementById("tree-resizer") as HTMLElement;
const treeContent = document.getElementById("tree-content") as HTMLDivElement;
const btnToggleTree = document.getElementById("btn-toggle-tree") as HTMLButtonElement;
const treeSearchInput = document.getElementById("tree-search-input") as HTMLInputElement;
const inspectorPanel = document.getElementById("inspector-panel") as HTMLElement;
const inspectorResizer = document.getElementById("inspector-resizer") as HTMLElement;
const btnToggleInspector = document.getElementById("btn-toggle-inspector") as HTMLButtonElement | null;

// Issues Section Elements (Embedded in Complexity Dashboard)
const issuesSearchFilter = document.getElementById("issues-search-filter") as HTMLInputElement | null;
const issuesListContainer = document.getElementById("issues-list-container") as HTMLDivElement | null;
const issuesSummaryText = document.getElementById("issues-summary-text") as HTMLElement | null;

// Git History Modal Elements
const gitHistoryModal = document.getElementById("git-history-modal") as HTMLDivElement | null;
const gitHistoryBase = document.getElementById("git-history-base") as HTMLInputElement | null;
const gitHistoryHead = document.getElementById("git-history-head") as HTMLInputElement | null;
const gitCommitRange = document.getElementById("git-commit-range") as HTMLDivElement | null;
const analysisHistoryModal = document.getElementById("analysis-history-modal") as HTMLDivElement | null;
const analysisHistoryBase = document.getElementById("analysis-history-base") as HTMLSelectElement | null;
const analysisHistoryHead = document.getElementById("analysis-history-head") as HTMLSelectElement | null;
const analysisHistorySummary = document.getElementById("analysis-history-summary") as HTMLDivElement | null;
const analysisHistoryComparison = document.getElementById("analysis-history-comparison") as HTMLDivElement | null;

// Helper to invoke Tauri command with mock fallback for web preview
async function invokeCommand<T>(cmd: string, args: any = {}): Promise<T> {
  if (typeof window !== "undefined" && (window as any).__TAURI_INTERNALS__) {
    const { invoke } = await import("@tauri-apps/api/core");
    return invoke(cmd, args);
  }
  if (typeof window !== "undefined" && typeof (window as any).__MODULELOOM_INVOKE__ === "function") {
    return (window as any).__MODULELOOM_INVOKE__(cmd, args) as Promise<T>;
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
  if (cmd === "manual_action") {
    throw new Error("マニュアル機能はデスクトップ版または PyCharm 版で利用できます");
  }
  if (cmd === "install_agent_skill") {
    throw new Error("スキルのインストールにはアプリ版が必要です");
  }
  if (cmd === "list_fix_tools") {
    return fixTools as T;
  }
  if (cmd === "git_changed_files") {
    return [] as T;
  }
  throw new Error(`Unknown command: ${cmd}`);
}

interface ManualTask { id: string; kind: "text" | "diagram" | "screenshot"; page: string; prompt: string; status: "missing" | "current" | "approved" | "stale" }
interface ManualState {
  config: {
    docs: string;
    output: string;
    format?: string;
    agent: string;
    model: string;
    mkdocs?: {
      site_name: string;
      theme: string;
      language: string;
      use_directory_urls: boolean;
    };
  };
  brief: string;
  agents: { id: string; label: string; available: boolean }[];
  tasks: ManualTask[];
  pages: string[];
  preview: string;
  preview_html?: string;
  has_html?: boolean;
}
const manualAgent = document.getElementById("manual-agent") as HTMLSelectElement | null;
const manualFormat = document.getElementById("manual-format") as HTMLSelectElement | null;
const manualRootInput = document.getElementById("manual-root") as HTMLInputElement;
const manualModel = document.getElementById("manual-model") as HTMLInputElement | null;
const manualModelOptions = document.getElementById("manual-model-options") as HTMLDataListElement | null;
const manualDocs = document.getElementById("manual-docs") as HTMLInputElement;
const manualOutput = document.getElementById("manual-output") as HTMLInputElement;
const manualBrief = document.getElementById("manual-brief") as HTMLTextAreaElement | null;
const manualMkdocsSiteName = document.getElementById("manual-mkdocs-sitename") as HTMLInputElement | null;
const manualMkdocsTheme = document.getElementById("manual-mkdocs-theme") as HTMLSelectElement | null;
const manualMkdocsLanguage = document.getElementById("manual-mkdocs-language") as HTMLSelectElement | null;
const manualMkdocsDirUrls = document.getElementById("manual-mkdocs-dir-urls") as HTMLInputElement | null;
const manualTasks = document.getElementById("manual-tasks") as HTMLElement;
const btnManualCaptureAll = document.getElementById("btn-manual-capture-all") as HTMLButtonElement | null;
const btnManualDiagramAll = document.getElementById("btn-manual-diagram-all") as HTMLButtonElement | null;
const btnManualGenerateApi = document.getElementById("btn-manual-generate-api") as HTMLButtonElement | null;
const btnManualApiRun = document.getElementById("btn-manual-api-run") as HTMLButtonElement | null;
const manualApiLang = document.getElementById("manual-api-lang") as HTMLSelectElement | null;
const manualStatus = document.getElementById("manual-status") as HTMLElement;
const manualPage = document.getElementById("manual-page") as HTMLSelectElement;
const manualPreview = document.getElementById("manual-preview") as HTMLElement;
const manualPreviewIframe = document.getElementById("manual-preview-iframe") as HTMLIFrameElement;
const btnPreviewModeHtml = document.getElementById("btn-preview-mode-html") as HTMLButtonElement;
const btnPreviewModeMd = document.getElementById("btn-preview-mode-md") as HTMLButtonElement;
const btnManualBack = document.getElementById("btn-manual-back") as HTMLButtonElement | null;
const btnManualForward = document.getElementById("btn-manual-forward") as HTMLButtonElement | null;
const btnManualOpenSettings = document.getElementById("btn-manual-open-settings") as HTMLButtonElement | null;
const manualSettingsModal = document.getElementById("manual-settings-modal") as HTMLDivElement | null;
const btnCloseManualSettings = document.getElementById("btn-close-manual-settings") as HTMLButtonElement | null;
const btnCancelManualSettings = document.getElementById("btn-cancel-manual-settings") as HTMLButtonElement | null;
const manualSettingsSaveStatus = document.getElementById("manual-settings-save-status") as HTMLElement | null;

function openManualSettingsModal(): void {
  if (manualSettingsSaveStatus) manualSettingsSaveStatus.textContent = "";
  manualSettingsModal?.classList.remove("hidden");
}

function closeManualSettingsModal(): void {
  manualSettingsModal?.classList.add("hidden");
}

const manualScreenshotCache: Record<string, string> = {};

let manualPageHistory: string[] = ["index.md"];
let manualHistoryIndex = 0;

function updateManualNavButtons(): void {
  if (btnManualBack) btnManualBack.disabled = manualHistoryIndex <= 0;
  if (btnManualForward) btnManualForward.disabled = manualHistoryIndex >= manualPageHistory.length - 1;
}

function pushManualPageHistory(page: string): void {
  if (!page) return;
  if (manualPageHistory[manualHistoryIndex] === page) return;
  manualPageHistory = manualPageHistory.slice(0, manualHistoryIndex + 1);
  manualPageHistory.push(page);
  manualHistoryIndex = manualPageHistory.length - 1;
  updateManualNavButtons();
}
const manualProgressModal = document.getElementById("manual-progress-modal") as HTMLDivElement;
const manualProgressTitle = document.getElementById("manual-progress-title") as HTMLElement;
const manualProgressSpinner = document.getElementById("manual-progress-spinner") as HTMLElement;
const manualProgressBadge = document.getElementById("manual-progress-badge") as HTMLElement;
const manualProgressPhase = document.getElementById("manual-progress-phase") as HTMLElement;
const manualProgressTimer = document.getElementById("manual-progress-timer") as HTMLElement;
const manualProgressBarFill = document.getElementById("manual-progress-bar-fill") as HTMLElement;
const manualProgressLog = document.getElementById("manual-progress-log") as HTMLElement;
const manualProgressFooterText = document.getElementById("manual-progress-footer-text") as HTMLElement;
const btnCloseManualProgress = document.getElementById("btn-close-manual-progress") as HTMLButtonElement;
const btnCloseManualProgressFooter = document.getElementById("btn-close-manual-progress-footer") as HTMLButtonElement;
const progressAgentName = document.getElementById("progress-agent-name") as HTMLElement;
const stepManualVerify = document.getElementById("step-manual-verify") as HTMLElement;
const stepManualAi = document.getElementById("step-manual-ai") as HTMLElement;
const stepManualStaged = document.getElementById("step-manual-staged") as HTMLElement;
const stepManualBuild = document.getElementById("step-manual-build") as HTMLElement;

let manualBusy = false;
let manualProject = "";
let manualPreviewMode: "html" | "md" = "html";
let manualProgressInterval: number | null = null;
let manualProgressStartTime = 0;

function setStepState(element: HTMLElement | null, state: "done" | "active" | "pending" | "error", iconText?: string) {
  if (!element) return;
  element.classList.remove("step-done", "step-active", "step-pending", "step-error");
  element.classList.add(`step-${state}`);
  const icon = element.querySelector(".step-indicator");
  if (icon) {
    icon.textContent = iconText || (state === "done" ? "✓" : state === "active" ? "●" : state === "error" ? "✕" : "○");
  }
}

function openManualProgress(action: "draft" | "generate-task", taskOrAgentInfo: string, feedback?: string) {
  if (!manualProgressModal) return;
  manualProgressModal.classList.remove("hidden");
  if (btnCloseManualProgress) btnCloseManualProgress.disabled = true;
  if (btnCloseManualProgressFooter) btnCloseManualProgressFooter.disabled = true;
  if (manualProgressSpinner) manualProgressSpinner.style.display = "inline-block";
  if (manualProgressBadge) {
    manualProgressBadge.className = "progress-badge badge-running";
    manualProgressBadge.textContent = "実行中";
  }

  manualProgressStartTime = Date.now();
  if (manualProgressInterval) clearInterval(manualProgressInterval);
  if (manualProgressTimer) manualProgressTimer.textContent = "00:00";

  if (action === "draft") {
    if (manualProgressTitle) manualProgressTitle.textContent = "AI アセットを生成中";
    if (progressAgentName) progressAgentName.textContent = taskOrAgentInfo || "AI";
    setStepState(stepManualVerify, "done");
    setStepState(stepManualAi, "active");
    setStepState(stepManualStaged, "pending");
    setStepState(stepManualBuild, "pending");
    if (manualProgressPhase) manualProgressPhase.textContent = "AI エージェントで構成案を生成中...";
    if (manualProgressBarFill) manualProgressBarFill.style.width = "20%";
    if (manualProgressLog) {
      manualProgressLog.textContent = `[00:00] プロジェクト構造と brief を検証しました\n[00:00] ${taskOrAgentInfo} エージェントを起動して章立てと ai:task を生成しています...`;
    }
  } else {
    const isRevision = Boolean(feedback);
    if (manualProgressTitle) manualProgressTitle.textContent = isRevision ? `AI タスクを修正中 (${taskOrAgentInfo})` : `AI タスクを作成中 (${taskOrAgentInfo})`;
    setStepState(stepManualVerify, "done");
    setStepState(stepManualAi, "active");
    setStepState(stepManualStaged, "pending");
    setStepState(stepManualBuild, "pending");
    if (manualProgressPhase) manualProgressPhase.textContent = isRevision ? "修正指示を反映して再生成中..." : "指示内容に基づいてコンテンツを生成中...";
    if (manualProgressBarFill) manualProgressBarFill.style.width = "25%";
    if (manualProgressLog) {
      const fbMsg = feedback ? `\n[00:00] ユーザーの修正指示: "${feedback}"` : "";
      manualProgressLog.textContent = `[00:00] タスク [${taskOrAgentInfo}] の指示を検証しました${fbMsg}\n[00:00] AI エージェントを起動しています...`;
    }
  }

  manualProgressInterval = window.setInterval(() => {
    const elapsedSec = Math.floor((Date.now() - manualProgressStartTime) / 1000);
    const m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
    const s = String(elapsedSec % 60).padStart(2, "0");
    if (manualProgressTimer) manualProgressTimer.textContent = `${m}:${s}`;

    if (action === "draft") {
      if (elapsedSec >= 3 && elapsedSec < 10) {
        if (manualProgressBarFill) manualProgressBarFill.style.width = "35%";
        if (manualProgressPhase) manualProgressPhase.textContent = "プロジェクト構造とコード規約を解析中...";
      } else if (elapsedSec >= 10 && elapsedSec < 20) {
        if (manualProgressBarFill) manualProgressBarFill.style.width = "55%";
        if (manualProgressPhase) manualProgressPhase.textContent = "各ページの Markdown と ai:task を設計中...";
      } else if (elapsedSec >= 20 && elapsedSec < 40) {
        if (manualProgressBarFill) manualProgressBarFill.style.width = "75%";
        if (manualProgressPhase) manualProgressPhase.textContent = "AI エージェントの生成結果をパース準備中...";
      } else if (elapsedSec >= 40) {
        if (manualProgressBarFill) manualProgressBarFill.style.width = "85%";
        if (manualProgressPhase) manualProgressPhase.textContent = "生成結果の最終検証中...";
      }
    } else {
      if (elapsedSec >= 3 && elapsedSec < 15) {
        if (manualProgressBarFill) manualProgressBarFill.style.width = "50%";
        if (manualProgressPhase) manualProgressPhase.textContent = "AI が文章・ダイアグラムを出力中...";
      } else if (elapsedSec >= 15) {
        if (manualProgressBarFill) manualProgressBarFill.style.width = "75%";
        if (manualProgressPhase) manualProgressPhase.textContent = "生成内容の構文チェック中...";
      }
    }
  }, 500);
}

function completeManualProgress(successMessage: string, logDetails?: string) {
  if (manualProgressInterval) { clearInterval(manualProgressInterval); manualProgressInterval = null; }
  if (manualProgressSpinner) manualProgressSpinner.style.display = "none";
  if (manualProgressBadge) {
    manualProgressBadge.className = "progress-badge badge-success";
    manualProgressBadge.textContent = "完了";
  }
  if (manualProgressPhase) manualProgressPhase.textContent = "完了しました";
  if (manualProgressBarFill) manualProgressBarFill.style.width = "100%";

  setStepState(stepManualVerify, "done");
  setStepState(stepManualAi, "done");
  setStepState(stepManualStaged, "done");
  setStepState(stepManualBuild, "done");

  const elapsedSec = Math.floor((Date.now() - manualProgressStartTime) / 1000);
  const m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const s = String(elapsedSec % 60).padStart(2, "0");
  if (manualProgressTimer) manualProgressTimer.textContent = `${m}:${s}`;

  if (manualProgressLog) {
    const currentLog = manualProgressLog.textContent || "";
    manualProgressLog.textContent = `${currentLog}\n[${m}:${s}] ${successMessage}${logDetails ? `\n${logDetails}` : ""}`;
    manualProgressLog.scrollTop = manualProgressLog.scrollHeight;
  }

  if (manualProgressFooterText) manualProgressFooterText.textContent = "作成が正常に完了しました";
  if (btnCloseManualProgress) btnCloseManualProgress.disabled = false;
  if (btnCloseManualProgressFooter) {
    btnCloseManualProgressFooter.disabled = false;
    btnCloseManualProgressFooter.focus();
  }
}

function failManualProgress(errorMessage: string) {
  if (manualProgressInterval) { clearInterval(manualProgressInterval); manualProgressInterval = null; }
  if (manualProgressSpinner) manualProgressSpinner.style.display = "none";
  if (manualProgressBadge) {
    manualProgressBadge.className = "progress-badge badge-error";
    manualProgressBadge.textContent = "エラー";
  }
  if (manualProgressPhase) manualProgressPhase.textContent = "処理に失敗しました";

  setStepState(stepManualAi, "error");

  const elapsedSec = Math.floor((Date.now() - manualProgressStartTime) / 1000);
  const m = String(Math.floor(elapsedSec / 60)).padStart(2, "0");
  const s = String(elapsedSec % 60).padStart(2, "0");
  if (manualProgressTimer) manualProgressTimer.textContent = `${m}:${s}`;

  if (manualProgressLog) {
    const currentLog = manualProgressLog.textContent || "";
    manualProgressLog.textContent = `${currentLog}\n[${m}:${s}] エラー: ${errorMessage}`;
    manualProgressLog.scrollTop = manualProgressLog.scrollHeight;
  }

  if (manualProgressFooterText) manualProgressFooterText.textContent = "エラーが発生しました。設定やAPIキー等を確認してください";
  if (btnCloseManualProgress) btnCloseManualProgress.disabled = false;
  if (btnCloseManualProgressFooter) {
    btnCloseManualProgressFooter.disabled = false;
    btnCloseManualProgressFooter.focus();
  }
}

function closeManualProgress() {
  if (manualProgressInterval) { clearInterval(manualProgressInterval); manualProgressInterval = null; }
  manualProgressModal?.classList.add("hidden");
}

btnCloseManualProgress?.addEventListener("click", closeManualProgress);
btnCloseManualProgressFooter?.addEventListener("click", closeManualProgress);

function manualRoot(): string {
  return manualRootInput.value.trim() || (window as any).__MODULELOOM_WORKSPACE_PATH__ || currentResult?.root_path || pathInput.value.trim() || (window as any).__MODULELOOM_PROJECT_PATH__ || "";
}

async function callManual(action: string, extras: Record<string, unknown> = {}): Promise<string> {
  const path = manualRoot();
  if (!path) throw new Error("先に解析対象のプロジェクトを選択してください");
  return invokeCommand<string>("manual_action", { path, action, ...extras });
}

function inlineManualMarkdown(value: string): string {
  return escapeHtml(value).replace(/`([^`]+)`/g, "<code>$1</code>").replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
}

let manualDiagramGraphs: Core[] = [];
function renderManualMarkdown(source: string): void {
  manualDiagramGraphs.forEach((graph) => graph.destroy());
  manualDiagramGraphs = [];
  const lines = source.replace(/<!-- ai:(?:generated|draft)[^>]*-->/g, "").replace(/<!-- \/ai:(?:generated|draft) -->/g, "").split("\n");
  let fenced = false;
  let code: string[] = [];
  let codeLanguage = "";
  const diagrams: string[] = [];
  const html: string[] = [];
  for (const line of lines) {
    if (line.startsWith("```")) {
      if (fenced) {
        if (codeLanguage === "mermaid") {
          const index = diagrams.push(code.join("\n")) - 1;
          html.push(`<div class="manual-diagram" data-diagram-index="${index}"></div>`);
        } else html.push(`<pre><code>${escapeHtml(code.join("\n"))}</code></pre>`);
        code = [];
      } else codeLanguage = line.slice(3).trim();
      fenced = !fenced;
      continue;
    }
    if (fenced) { code.push(line); continue; }
    if (!line.trim()) continue;
    const heading = /^(#{1,4})\s+(.+)$/.exec(line);
    if (heading) { const level = heading[1].length; html.push(`<h${level}>${inlineManualMarkdown(heading[2])}</h${level}>`); continue; }
    const image = /^!\[([^\]]*)\]\(([^)]+)\)/.exec(line);
    if (image) { html.push(`<figure><img class="manual-preview-image" data-asset="${escapeHtml(image[2])}" alt="${escapeHtml(image[1])}" /><figcaption>${escapeHtml(image[1])}</figcaption></figure>`); continue; }
    if (line.startsWith("> ")) { html.push(`<blockquote>${inlineManualMarkdown(line.slice(2))}</blockquote>`); continue; }
    if (/^[-*] /.test(line)) { html.push(`<p>• ${inlineManualMarkdown(line.slice(2))}</p>`); continue; }
    html.push(`<p>${inlineManualMarkdown(line)}</p>`);
  }
  manualPreview.innerHTML = html.join("") || "<p>プレビューするページがありません。</p>";
  manualPreview.querySelectorAll<HTMLElement>(".manual-diagram").forEach((container) => {
    const source = diagrams[Number(container.dataset.diagramIndex)] || "";
    const nodes = [...source.matchAll(/^\s*(\w+)\["([^"]+)"\]/gm)].map((match) => ({ data: { id: match[1], label: match[2] } }));
    const edges = [...source.matchAll(/^\s*(\w+)\s*-->\s*(\w+)/gm)].map((match, index) => ({ data: { id: `edge-${index}`, source: match[1], target: match[2] } }));
    if (!nodes.length) { container.textContent = source; return; }
    const graph = cytoscape({ container, elements: [...nodes, ...edges], layout: { name: "dagre", rankDir: "LR" } as any,
      style: [
        { selector: "node", style: { label: "data(label)", "background-color": "#89b4fa", color: "#cdd6f4", "text-valign": "bottom", "text-margin-y": 6, "font-size": 12 } },
        { selector: "edge", style: { width: 2, "line-color": "#a6adc8", "target-arrow-color": "#a6adc8", "target-arrow-shape": "triangle", "curve-style": "bezier" } },
      ], userZoomingEnabled: false, userPanningEnabled: false });
    manualDiagramGraphs.push(graph);
  });
  const currentPage = manualPage.value || "index.md";
  manualPreview.querySelectorAll<HTMLImageElement>(".manual-preview-image").forEach((element) => {
    const asset = element.dataset.asset;
    if (!asset) return;
    void callManual("preview-asset", { page: currentPage, asset }).then((value) => {
      if (element.isConnected && value.startsWith("data:image/")) element.src = value;
    }).catch(() => { if (element.isConnected) element.alt = `${element.alt}（画像を読み込めません）`; });
  });
}

async function captureBackgroundScreenshot(taskId: string, annotationHint?: string): Promise<string> {
  const isGraphTask = taskId.includes("graph") || taskId.includes("overview") || taskId.includes("module");
  if (isGraphTask && cy && cy.nodes().length > 0 && !annotationHint) {
    try {
      cy.resize();
      const visible = cy.elements().not(".hidden");
      if (visible.length) cy.fit(visible, 30);
      const dataUrl = cy.png({
        full: false,
        bg: "#1e1e2e",
        scale: 1.5,
      });
      if (dataUrl && dataUrl.startsWith("data:image/png")) {
        manualScreenshotCache[taskId] = dataUrl;
        return dataUrl;
      }
    } catch {
      // フォールバック
    }
  }

  let targetEl: HTMLElement | null = null;
  if (taskId.includes("diagnostic")) {
    targetEl = document.getElementById("complexity-dashboard");
  } else if (taskId.includes("setting") || taskId.includes("tool-window")) {
    targetEl = document.getElementById("module-view");
  } else if (taskId.includes("manual")) {
    targetEl = document.getElementById("manual-view");
  } else {
    targetEl = document.getElementById("module-view") || document.body;
  }

  if (!targetEl) targetEl = document.body;

  // アノテーション（赤枠・赤丸囲み、矢印、説明文ラベル）の処理
  let highlightEl: HTMLDivElement | null = null;
  let annotationLabelEl: HTMLDivElement | null = null;
  let prevPosition = "";
  if (annotationHint) {
    const hint = annotationHint.trim();
    let selector = "";
    const idMatch = hint.match(/#([a-zA-Z0-9_-]+)/);
    const classMatch = hint.match(/\.([a-zA-Z0-9_-]+)/);
    if (idMatch) selector = idMatch[0];
    else if (classMatch) selector = classMatch[0];

    let foundEl: HTMLElement | null = null;
    if (selector) {
      try {
        foundEl = document.querySelector<HTMLElement>(selector);
      } catch {}
    }

    if (!foundEl) {
      const candidates = Array.from(document.querySelectorAll<HTMLElement>("button, .tab, label, select, input, h2, h3, a"));
      const keywords = ["全スクショ", "ダイアグラム", "API", "ビルド", "保存", "解析", "診断", "マニュアル", "修正", "承認", "設定"];
      for (const kw of keywords) {
        if (hint.includes(kw)) {
          foundEl = candidates.find((c) => c.textContent?.includes(kw)) || null;
          if (foundEl) break;
        }
      }
    }

    if (foundEl && targetEl.contains(foundEl)) {
      const targetRect = targetEl.getBoundingClientRect();
      const elRect = foundEl.getBoundingClientRect();
      const isCircle = hint.includes("丸") || hint.includes("円") || hint.includes("circle");

      highlightEl = document.createElement("div");
      highlightEl.className = "manual-screenshot-highlight";
      highlightEl.style.position = "absolute";
      highlightEl.style.left = `${elRect.left - targetRect.left + targetEl.scrollLeft - 6}px`;
      highlightEl.style.top = `${elRect.top - targetRect.top + targetEl.scrollTop - 6}px`;
      highlightEl.style.width = `${elRect.width + 12}px`;
      highlightEl.style.height = `${elRect.height + 12}px`;
      highlightEl.style.border = "4px solid #ff3344";
      highlightEl.style.borderRadius = isCircle ? "50%" : "8px";
      highlightEl.style.boxShadow = "0 0 0 2px rgba(255, 255, 255, 0.9), 0 0 16px rgba(255, 50, 50, 0.85)";
      highlightEl.style.pointerEvents = "none";
      highlightEl.style.zIndex = "999999";
      highlightEl.style.boxSizing = "border-box";

      prevPosition = targetEl.style.position;
      if (!prevPosition || prevPosition === "static") {
        targetEl.style.position = "relative";
      }
      targetEl.appendChild(highlightEl);

      // 矢印と説明文ラベル（吹き出し）の合成
      const hasArrow = hint.includes("矢印") || hint.includes("arrow");
      let labelText = "";
      const quoteMatch = hint.match(/[「『"']([^「『"']+)["'」』]/);
      if (quoteMatch) {
        labelText = quoteMatch[1];
      } else {
        const descMatch = hint.match(/(?:説明|ラベル|注記|テキスト)[:：]\s*([^\s,、。]+)/);
        if (descMatch) labelText = descMatch[1];
      }

      if (hasArrow || labelText) {
        annotationLabelEl = document.createElement("div");
        annotationLabelEl.className = "manual-screenshot-annotation-label";
        annotationLabelEl.style.position = "absolute";
        annotationLabelEl.style.pointerEvents = "none";
        annotationLabelEl.style.zIndex = "999999";
        annotationLabelEl.style.display = "flex";
        annotationLabelEl.style.alignItems = "center";
        annotationLabelEl.style.gap = "6px";
        annotationLabelEl.style.fontFamily = "sans-serif";
        annotationLabelEl.style.fontWeight = "bold";

        const topSpace = elRect.top - targetRect.top;
        const placeBelow = topSpace < 40;
        const labelTop = placeBelow
          ? elRect.top - targetRect.top + targetEl.scrollTop + elRect.height + 14
          : elRect.top - targetRect.top + targetEl.scrollTop - 36;
        const labelLeft = Math.max(10, elRect.left - targetRect.left + targetEl.scrollLeft);

        annotationLabelEl.style.top = `${labelTop}px`;
        annotationLabelEl.style.left = `${labelLeft}px`;

        let html = "";
        if (hasArrow) {
          const arrowSymbol = placeBelow ? "⬆" : "⬇";
          html += `<span style="color: #ff3344; font-size: 1.3rem; filter: drop-shadow(0 0 4px rgba(255,50,50,0.8)); line-height: 1;">${arrowSymbol}</span>`;
        }
        if (labelText) {
          html += `<span style="background: rgba(20, 20, 30, 0.94); color: #ffffff; border: 1.5px solid #ff3344; border-radius: 4px; padding: 3px 8px; font-size: 0.8rem; box-shadow: 0 2px 8px rgba(0,0,0,0.5); white-space: nowrap;">${escapeHtml(labelText)}</span>`;
        }
        annotationLabelEl.innerHTML = html;
        targetEl.appendChild(annotationLabelEl);
      }
    }
  }

  try {
    const canvas = await html2canvas(targetEl, {
      backgroundColor: "#1e1e2e",
      scale: 1.5,
      logging: false,
      useCORS: true,
    });
    const dataUrl = canvas.toDataURL("image/png");
    manualScreenshotCache[taskId] = dataUrl;
    return dataUrl;
  } finally {
    if (highlightEl) {
      highlightEl.remove();
      if (targetEl && (!prevPosition || prevPosition === "static")) {
        targetEl.style.position = prevPosition;
      }
    }
    if (annotationLabelEl) {
      annotationLabelEl.remove();
    }
  }
}

async function captureAllScreenshots(): Promise<void> {
  const project = manualRoot();
  if (!project) {
    manualStatus.textContent = "先に解析対象のプロジェクトを選択してください";
    return;
  }
  const state = JSON.parse(await callManual("state")) as ManualState;
  const screenshotTasks = state.tasks.filter((t: ManualTask) => t.kind === "screenshot");
  if (!screenshotTasks.length) {
    manualStatus.textContent = "スクリーンショットのタスクはありません";
    return;
  }

  if (btnManualCaptureAll) btnManualCaptureAll.disabled = true;
  const prevTab = activeWorkspaceTab;
  manualStatus.textContent = `全 ${screenshotTasks.length} 件のスクリーンショットを一括自動撮影中…`;

  try {
    for (let i = 0; i < screenshotTasks.length; i++) {
      const task = screenshotTasks[i];
      manualStatus.textContent = `自動撮影中 (${i + 1}/${screenshotTasks.length}): ${task.id}…`;

      let targetTab: "modules" | "diagnostics" | "manual" = "modules";
      if (task.id.includes("diagnostic")) {
        targetTab = "diagnostics";
      } else if (task.id.includes("manual")) {
        targetTab = "manual";
      }
      selectWorkspaceTab(targetTab);

      // DOM描画の安定待機
      await new Promise((resolve) => setTimeout(resolve, 300));

      const dataUrl = await captureBackgroundScreenshot(task.id, task.prompt);
      await invokeCommand("manual_capture_screenshot", {
        path: manualRoot(),
        id: task.id,
        data: dataUrl,
      });
    }

    manualStatus.textContent = "全スクショの自動撮影完了。最新サイトをビルド中…";
    await callManual("build", { draft: true });
    manualStatus.textContent = `全 ${screenshotTasks.length} 件のスクリーンショットを自動更新し、プレビューを最新化しました！`;
    await refreshManual();
  } catch (error) {
    manualStatus.textContent = `一括自動撮影エラー: ${String(error)}`;
  } finally {
    selectWorkspaceTab(prevTab);
    if (btnManualCaptureAll) btnManualCaptureAll.disabled = false;
  }
}

function renderManualTasks(tasks: ManualTask[]): void {
  const summaryEl = document.getElementById("manual-assets-summary");
  if (!tasks.length) {
    manualTasks.innerHTML = "<p>同期対象のアセット指示タグ（<code>ai:task</code>）はまだありません。</p>";
    if (summaryEl) summaryEl.textContent = "0 件のアセット";
    return;
  }

  const sTasks = tasks.filter((t) => t.kind === "screenshot");
  const dTasks = tasks.filter((t) => t.kind === "diagram");
  const tTasks = tasks.filter((t) => t.kind === "text");
  if (summaryEl) {
    summaryEl.textContent = `📸 スクショ ${sTasks.length}件 · 📊 ダイアグラム ${dTasks.length}件${tTasks.length ? ` · 📝 テキスト ${tTasks.length}件` : ""}`;
  }

  manualTasks.innerHTML = tasks.map((task) => {
    const isScreenshot = task.kind === "screenshot";
    const isDiagram = task.kind === "diagram";
    const typeLabel = isScreenshot ? "📸 スクショ" : isDiagram ? "📊 ダイアグラム" : "📝 テキスト";
    const typeBadgeClass = isScreenshot ? "manual-task-badge-screenshot" : isDiagram ? "manual-task-badge-diagram" : "manual-task-badge-text";

    const hasCachedImage = Boolean(manualScreenshotCache[task.id]);
    const isReady = task.status === "approved" || task.status === "current" || hasCachedImage;
    const statusBadge = isReady
      ? `<span class="manual-task-badge manual-task-badge-status-ready">✅ 準備完了</span>`
      : `<span class="manual-task-badge manual-task-badge-status-missing">📷 未撮影</span>`;

    let thumbHtml = "";
    if (isScreenshot) {
      if (manualScreenshotCache[task.id]) {
        thumbHtml = `
          <div class="manual-task-thumb-container">
            <img src="${manualScreenshotCache[task.id]}" class="manual-task-thumb" alt="${escapeHtml(task.id)}" title="クリックで拡大プレビュー" />
          </div>`;
      } else {
        thumbHtml = `
          <div class="manual-task-thumb-container" id="manual-thumb-wrap-${escapeHtml(task.id)}">
            <div class="manual-task-placeholder-thumb">
              📷 画像読込中…（未撮影の場合は「📸 画面を自動撮影」）
            </div>
          </div>`;
      }
    }

    let actions = "";
    if (isScreenshot) {
      actions = `
        <button type="button" data-manual-capture="${escapeHtml(task.id)}" class="btn-secondary" title="現在のUI画面を自動撮影します">📸 画面を自動撮影</button>
        <button type="button" data-manual-feedback-toggle="${escapeHtml(task.id)}" class="btn-secondary" title="赤枠・赤丸囲みや対象要素の指定など修正指示を出します">💬 修正指示</button>
        <button type="button" data-manual-image-toggle="${escapeHtml(task.id)}" class="btn-secondary">📁 画像ファイルを指定</button>
      `;
    } else if (isDiagram) {
      actions = `
        <button type="button" data-manual-generate="${escapeHtml(task.id)}" class="btn-secondary" title="最新のコード解析結果からMermaid依存図を生成します">📊 最新図を生成</button>
        <button type="button" data-manual-feedback-toggle="${escapeHtml(task.id)}" class="btn-secondary" title="ダイアグラムの調整指示を出します">💬 修正指示</button>
      `;
    } else {
      actions = `
        <button type="button" data-manual-generate="${escapeHtml(task.id)}" class="btn-secondary">AIで作成</button>
        <button type="button" data-manual-feedback-toggle="${escapeHtml(task.id)}" class="btn-secondary" title="文章の修正指示を出します">💬 修正指示</button>
      `;
    }

    return `<div class="manual-task" id="manual-task-card-${escapeHtml(task.id)}">
      <div class="manual-task-header">
        <div class="manual-task-meta">
          <span class="manual-task-badge ${typeBadgeClass}">${typeLabel}</span>
          <strong>${escapeHtml(task.id)}</strong>
          <small>${escapeHtml(task.page)}</small>
        </div>
        ${statusBadge}
      </div>
      <p>${escapeHtml(task.prompt)}</p>
      ${thumbHtml}
      <div class="manual-actions">${actions}</div>
      <div id="manual-feedback-box-${escapeHtml(task.id)}" class="manual-feedback-container" hidden>
        <div class="manual-feedback-row">
          <input type="text" id="manual-feedback-input-${escapeHtml(task.id)}" class="manual-feedback-input" placeholder="${isScreenshot ? '修正指示（例: #btn-manual-capture を赤枠で囲んで / 診断画面を撮影）' : '修正指示（例: 箇条書きで手順を追加して）'}" />
          <button type="button" data-manual-feedback-submit="${escapeHtml(task.id)}" class="btn-primary">指示実行</button>
        </div>
      </div>
      <div id="manual-image-box-${escapeHtml(task.id)}" class="manual-feedback-container" hidden>
        <div class="manual-feedback-row">
          <input type="text" id="manual-image-input-${escapeHtml(task.id)}" class="manual-feedback-input" placeholder="画像パス（例: docs/assets/screen.png）" />
          <button type="button" data-manual-image-submit="${escapeHtml(task.id)}" class="btn-primary">登録実行</button>
        </div>
      </div>
    </div>`;
  }).join("");

  tasks.forEach((task) => {
    if (task.kind === "screenshot" && !manualScreenshotCache[task.id]) {
      void (async () => {
        try {
          const res = await callManual("preview-asset", { asset: `assets/${task.id}.png` });
          if (res && res.startsWith("data:image/")) {
            manualScreenshotCache[task.id] = res;
            const wrap = document.getElementById(`manual-thumb-wrap-${task.id}`);
            if (wrap) {
              wrap.innerHTML = `<img src="${res}" class="manual-task-thumb" alt="${escapeHtml(task.id)}" title="クリックで拡大プレビュー" />`;
            }
          } else {
            const wrap = document.getElementById(`manual-thumb-wrap-${task.id}`);
            if (wrap) {
              wrap.innerHTML = `<div class="manual-task-placeholder-thumb">📷 未撮影（「📸 画面を自動撮影」を押すと現在のUIを撮影します）</div>`;
            }
          }
        } catch {
          const wrap = document.getElementById(`manual-thumb-wrap-${task.id}`);
          if (wrap) {
            wrap.innerHTML = `<div class="manual-task-placeholder-thumb">📷 未撮影（「📸 画面を自動撮影」を押すと現在のUIを撮影します）</div>`;
          }
        }
      })();
    }
  });
}

async function renderManualPreview(state: ManualState): Promise<void> {
  const currentPage = manualPage.value || "index.md";
  if (manualPreviewMode === "html") {
    try {
      let htmlContent = "";
      if (currentPage === "index.md" && state.preview_html) {
        htmlContent = state.preview_html;
      } else {
        htmlContent = await callManual("preview-html", { page: currentPage });
      }
      if (htmlContent) {
        manualPreviewIframe.hidden = false;
        manualPreview.hidden = true;
        manualPreviewIframe.srcdoc = htmlContent;
        return;
      }
    } catch {
      // HTML未生成時はMarkdown表示にフォールバック
    }
  }

  // Markdown 表示
  manualPreviewIframe.hidden = true;
  manualPreview.hidden = false;
  if (currentPage === "index.md") renderManualMarkdown(state.preview);
  else {
    try {
      renderManualMarkdown(await callManual("preview-page", { page: currentPage }));
    } catch (e) {
      manualPreview.innerHTML = `<p>${escapeHtml(String(e))}</p>`;
    }
  }
}

async function refreshManual(): Promise<void> {
  if (manualBusy) return;
  try {
    if (!manualRootInput.value.trim()) manualRootInput.value = (window as any).__MODULELOOM_WORKSPACE_PATH__ || currentResult?.root_path || pathInput.value.trim() || "";
    const project = manualRoot();
    if (!project) { manualStatus.textContent = "先に解析対象のプロジェクトを選択してください"; return; }
    const state = JSON.parse(await callManual("state")) as ManualState;
    if (manualProject !== project) {
      manualDocs.value = state.config.docs || "docs";
      manualOutput.value = state.config.output || "manual";
      if (manualBrief) manualBrief.value = state.brief || "";
      const savedAgent = state.config.agent || localStorage.getItem("moduleloom_manual_agent") || "codex";
      if (manualAgent) manualAgent.value = savedAgent;
      const savedModel = state.config.model || localStorage.getItem("moduleloom_manual_model") || "";
      if (manualModel) manualModel.value = savedModel;
      const savedFormat = state.config.format || localStorage.getItem("moduleloom_manual_format") || "mkdocs";
      if (manualFormat) manualFormat.value = savedFormat;
      if (state.config.mkdocs) {
        if (manualMkdocsSiteName) manualMkdocsSiteName.value = state.config.mkdocs.site_name || "";
        if (manualMkdocsTheme) manualMkdocsTheme.value = state.config.mkdocs.theme || "material";
        if (manualMkdocsLanguage) manualMkdocsLanguage.value = state.config.mkdocs.language || "ja";
        if (manualMkdocsDirUrls) manualMkdocsDirUrls.checked = Boolean(state.config.mkdocs.use_directory_urls);
      }
      manualProject = project;
    }
    if (manualAgent) {
      for (const option of Array.from(manualAgent.options)) {
        const agent = state.agents.find((item) => item.id === option.value);
        option.disabled = !agent?.available;
        option.textContent = `${agent?.label || option.value}${agent?.available ? "" : "（未検出）"}`;
      }
    }
    const currentPage = manualPage.value;
    manualPage.innerHTML = (state.pages.length ? state.pages : ["index.md"]).map((page) => `<option value="${escapeHtml(page)}">${escapeHtml(page)}</option>`).join("");
    manualPage.value = state.pages.includes(currentPage) ? currentPage : "index.md";
    renderManualTasks(state.tasks);
    await renderManualPreview(state);
    updateManualNavButtons();
  } catch (error) {
    manualStatus.textContent = String(error);
  }
}

async function runManual(action: string, extras: Record<string, unknown> = {}): Promise<void> {
  if (manualBusy) return;
  manualBusy = true;
  const isAiTask = action === "draft" || action === "generate-task";
  manualStatus.textContent = isAiTask ? "AIを実行中…" : "処理中…";
  manualView.setAttribute("aria-busy", "true");

  if (isAiTask) {
    const info = action === "draft" ? (manualAgent?.value || "Codex") : String(extras.id || "");
    const feedback = typeof extras.feedback === "string" ? extras.feedback : undefined;
    openManualProgress(action, info, feedback);
  }

  try {
    const mkdocsSettings = {
      site_name: manualMkdocsSiteName?.value.trim() || "ModuleLoom マニュアル",
      theme: manualMkdocsTheme?.value || "material",
      language: manualMkdocsLanguage?.value || "ja",
      use_directory_urls: Boolean(manualMkdocsDirUrls?.checked),
    };
    const settings = {
      docs: manualDocs.value.trim() || "docs",
      output: manualOutput.value.trim() || "manual",
      format: manualFormat?.value || "mkdocs",
      brief: manualBrief?.value || "",
      agent: manualAgent?.value || "codex",
      model: manualModel?.value.trim() || "",
      mkdocs_settings: JSON.stringify(mkdocsSettings),
    };
    localStorage.setItem("moduleloom_manual_agent", settings.agent);
    localStorage.setItem("moduleloom_manual_model", settings.model);
    localStorage.setItem("moduleloom_manual_format", settings.format);
    let result = "";
    if (action === "save") result = await callManual("save", settings);
    else {
      if (action !== "approve") await callManual("save", settings);
      result = await callManual(action, extras);
    }
    if (action === "generate-task" || action === "approve") await callManual("build", { draft: true });
    manualStatus.textContent = action === "save" ? "AI設定とドキュメント設定を保存しました" : action === "approve" ? "承認しました" : action === "build" ? result : "完了しました";

    if (isAiTask) {
      if (action === "draft") {
        completeManualProgress("アセットの生成と下書き HTML ビルドが完了しました", "原稿ファイルを更新し、プレビューを最新化しました。");
      } else {
        const msg = extras.feedback ? "アセットの修正と下書き HTML ビルドが完了しました" : "アセットの生成と下書き HTML ビルドが完了しました";
        completeManualProgress(msg, "プレビューを更新しました。");
      }
    }
  } catch (error) {
    manualStatus.textContent = `失敗: ${String(error)}`;
    if (isAiTask) {
      failManualProgress(String(error));
    }
  } finally {
    manualBusy = false;
    manualView.removeAttribute("aria-busy");
    await refreshManual();
  }
}

btnPreviewModeHtml?.addEventListener("click", () => {
  manualPreviewMode = "html";
  btnPreviewModeHtml.classList.add("active");
  btnPreviewModeMd.classList.remove("active");
  void refreshManual();
});
btnPreviewModeMd?.addEventListener("click", () => {
  manualPreviewMode = "md";
  btnPreviewModeMd.classList.add("active");
  btnPreviewModeHtml.classList.remove("active");
  void refreshManual();
});

document.getElementById("manual-refresh")?.addEventListener("click", () => { void refreshManual(); });
btnManualOpenSettings?.addEventListener("click", openManualSettingsModal);
btnCloseManualSettings?.addEventListener("click", closeManualSettingsModal);
btnCancelManualSettings?.addEventListener("click", closeManualSettingsModal);
manualSettingsModal?.addEventListener("click", (e) => {
  if (e.target === manualSettingsModal) closeManualSettingsModal();
});
manualRootInput.addEventListener("change", () => { void refreshManual(); });
document.getElementById("manual-save")?.addEventListener("click", async () => {
  if (manualSettingsSaveStatus) manualSettingsSaveStatus.textContent = "保存中…";
  try {
    await runManual("save");
    if (manualSettingsSaveStatus) manualSettingsSaveStatus.textContent = "✓ 設定を保存しました";
    setTimeout(() => {
      closeManualSettingsModal();
    }, 400);
  } catch (err) {
    if (manualSettingsSaveStatus) manualSettingsSaveStatus.textContent = `保存失敗: ${String(err)}`;
  }
});
document.getElementById("manual-list-models")?.addEventListener("click", async () => {
  if (!manualAgent) return;
  manualStatus.textContent = "モデル候補を取得中…";
  try {
    const result = JSON.parse(await callManual("models", { agent: manualAgent.value })) as { models: { id: string; label: string }[]; message: string };
    if (manualModelOptions) {
      manualModelOptions.innerHTML = result.models.map((model) => `<option value="${escapeHtml(model.id)}" label="${escapeHtml(model.label)}"></option>`).join("");
    }
    manualStatus.textContent = result.message || `${result.models.length} 件のモデル候補を取得しました。モデルID欄で選べます。`;
  } catch (error) { manualStatus.textContent = `モデル候補を取得できません: ${String(error)}`; }
});
manualAgent?.addEventListener("change", () => {
  if (manualModelOptions) manualModelOptions.innerHTML = "";
  if (manualAgent) localStorage.setItem("moduleloom_manual_agent", manualAgent.value);
  if (manualRoot()) void runManual("save");
});
manualModel?.addEventListener("change", () => {
  if (manualModel) localStorage.setItem("moduleloom_manual_model", manualModel.value.trim());
  if (manualRoot()) void runManual("save");
});
manualFormat?.addEventListener("change", () => {
  if (manualFormat) localStorage.setItem("moduleloom_manual_format", manualFormat.value);
  if (manualRoot()) void runManual("save");
});
document.getElementById("manual-draft")?.addEventListener("click", () => { void runManual("draft"); });
document.getElementById("manual-build-draft")?.addEventListener("click", () => { void runManual("build", { draft: true }); });
document.getElementById("manual-build")?.addEventListener("click", () => { void runManual("build"); });
manualPage.addEventListener("change", () => {
  pushManualPageHistory(manualPage.value);
  void refreshManual();
});

btnManualBack?.addEventListener("click", () => {
  if (manualHistoryIndex > 0) {
    manualHistoryIndex--;
    const target = manualPageHistory[manualHistoryIndex];
    if (target) {
      manualPage.value = target;
      void refreshManual();
      updateManualNavButtons();
    }
  }
});

btnManualForward?.addEventListener("click", () => {
  if (manualHistoryIndex < manualPageHistory.length - 1) {
    manualHistoryIndex++;
    const target = manualPageHistory[manualHistoryIndex];
    if (target) {
      manualPage.value = target;
      void refreshManual();
      updateManualNavButtons();
    }
  }
});

window.addEventListener("message", (event: MessageEvent) => {
  if (event.data?.type === "moduleloom_manual_navigate") {
    let href = String(event.data.href || "").split("#")[0].split("?")[0];
    if (!href) return;
    if (href.endsWith(".html")) {
      href = href.slice(0, -5) + ".md";
    } else if (href.endsWith("/")) {
      href = href.replace(/\/+$/, "") + "/index.md";
    } else if (!href.endsWith(".md")) {
      href = href + ".md";
    }
    href = href.replace(/^(\.\/|\.\.\/)+/, "");
    if (href === ".md" || !href) href = "index.md";

    const options = Array.from(manualPage.options).map((o) => o.value);
    const target = options.find((opt) => opt === href || opt.endsWith("/" + href) || href.endsWith("/" + opt)) || (options.includes(href) ? href : "");
    if (target) {
      pushManualPageHistory(target);
      manualPage.value = target;
      void refreshManual();
    }
  }
});
manualTasks.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;

  // サムネイル画像クリックでの拡大表示
  const thumb = target.closest<HTMLImageElement>(".manual-task-thumb");
  if (thumb && thumb.src) {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.top = "0";
    overlay.style.left = "0";
    overlay.style.width = "100vw";
    overlay.style.height = "100vh";
    overlay.style.background = "rgba(0, 0, 0, 0.85)";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.zIndex = "9999999";
    overlay.style.cursor = "zoom-out";
    const img = document.createElement("img");
    img.src = thumb.src;
    img.style.maxWidth = "92vw";
    img.style.maxHeight = "92vh";
    img.style.borderRadius = "6px";
    img.style.boxShadow = "0 8px 32px rgba(0, 0, 0, 0.6)";
    overlay.appendChild(img);
    overlay.addEventListener("click", () => overlay.remove());
    document.body.appendChild(overlay);
    return;
  }

  const button = target.closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.dataset.manualGenerate) void runManual("generate-task", { id: button.dataset.manualGenerate });
  if (button.dataset.manualFeedbackToggle) {
    const id = button.dataset.manualFeedbackToggle;
    const box = document.getElementById(`manual-feedback-box-${id}`);
    if (box) {
      box.hidden = !box.hidden;
      if (!box.hidden) {
        const input = document.getElementById(`manual-feedback-input-${id}`) as HTMLInputElement | null;
        input?.focus();
      }
    }
  }
  if (button.dataset.manualFeedbackSubmit) {
    const id = button.dataset.manualFeedbackSubmit;
    const input = document.getElementById(`manual-feedback-input-${id}`) as HTMLInputElement | null;
    const feedback = input?.value.trim() || "";
    if (!feedback) {
      input?.focus();
      return;
    }

    const isScreenshotTask = document.querySelector<HTMLElement>(`#manual-task-card-${id} .manual-task-badge-screenshot`) !== null;
    if (isScreenshotTask) {
      void (async () => {
        manualStatus.textContent = `リテイク指示を反映して再撮影中: ${id}…`;
        const prevTab = activeWorkspaceTab;
        try {
          let targetTab: "modules" | "diagnostics" | "manual" = "modules";
          if (id.includes("diagnostic")) targetTab = "diagnostics";
          else if (id.includes("manual")) targetTab = "manual";
          selectWorkspaceTab(targetTab);
          await new Promise((resolve) => setTimeout(resolve, 300));

          const dataUrl = await captureBackgroundScreenshot(id, feedback);
          await invokeCommand("manual_capture_screenshot", { path: manualRoot(), id, data: dataUrl });
          await callManual("build", { draft: true });
          manualStatus.textContent = "リテイク撮影・保存が完了しました（アノテーション反映）";
          await refreshManual();
        } catch (error) {
          manualStatus.textContent = `リテイク撮影に失敗しました: ${String(error)}`;
        } finally {
          selectWorkspaceTab(prevTab);
        }
      })();
    } else {
      void runManual("generate-task", { id, feedback });
    }
  }
  if (button.dataset.manualImageToggle) {
    const id = button.dataset.manualImageToggle;
    const box = document.getElementById(`manual-image-box-${id}`);
    if (box) {
      box.hidden = !box.hidden;
      if (!box.hidden) {
        const input = document.getElementById(`manual-image-input-${id}`) as HTMLInputElement | null;
        input?.focus();
      }
    }
  }
  if (button.dataset.manualImageSubmit) {
    const id = button.dataset.manualImageSubmit;
    const input = document.getElementById(`manual-image-input-${id}`) as HTMLInputElement | null;
    const imagePath = input?.value.trim() || "";
    if (!imagePath) {
      input?.focus();
      return;
    }
    void (async () => {
      try {
        manualStatus.textContent = "画像を登録中…";
        await callManual("record-screenshot", { id, image: imagePath });
        await callManual("build", { draft: true });
        manualStatus.textContent = "画像を登録しました";
        await refreshManual();
      } catch (err) {
        manualStatus.textContent = `画像の登録に失敗しました: ${String(err)}`;
      }
    })();
  }
  if (button.dataset.manualApprove) void runManual("approve", { id: button.dataset.manualApprove });
  if (button.dataset.manualCapture) void (async () => {
    const id = button.dataset.manualCapture;
    if (!id) return;
    manualStatus.textContent = `画面を自動撮影中: ${id}…`;
    const prevTab = activeWorkspaceTab;
    try {
      let targetTab: "modules" | "diagnostics" | "manual" = "modules";
      if (id.includes("diagnostic")) targetTab = "diagnostics";
      else if (id.includes("manual")) targetTab = "manual";
      selectWorkspaceTab(targetTab);
      await new Promise((resolve) => setTimeout(resolve, 300));

      const dataUrl = await captureBackgroundScreenshot(id);
      await invokeCommand("manual_capture_screenshot", { path: manualRoot(), id, data: dataUrl });
      await callManual("build", { draft: true });
      manualStatus.textContent = "自動撮影・保存が完了しました";
      await refreshManual();
    } catch (error) {
      manualStatus.textContent = `撮影に失敗しました: ${String(error)}`;
    } finally {
      selectWorkspaceTab(prevTab);
    }
  })();
});

btnManualCaptureAll?.addEventListener("click", () => void captureAllScreenshots());

btnManualDiagramAll?.addEventListener("click", async () => {
  if (manualBusy) return;
  manualBusy = true;
  manualStatus.textContent = "全ダイアグラムを最新コードから一括更新中…";
  manualView.setAttribute("aria-busy", "true");
  try {
    const res = JSON.parse(await callManual("generate-diagram-all")) as { updated: number };
    await callManual("build", { draft: true });
    manualStatus.textContent = `${res.updated} 件のダイアグラム（Mermaid）を一括更新しました`;
  } catch (e) {
    manualStatus.textContent = `ダイアグラム更新失敗: ${String(e)}`;
  } finally {
    manualBusy = false;
    manualView.removeAttribute("aria-busy");
    await refreshManual();
  }
});

async function runGenerateApi(): Promise<void> {
  if (manualBusy) return;
  manualBusy = true;
  manualStatus.textContent = "DocstringからAPIドキュメントを生成中…";
  manualView.setAttribute("aria-busy", "true");
  try {
    const lang = manualApiLang?.value || "auto";
    const res = JSON.parse(await callManual("generate-api", { lang })) as { count: number; api_page: string };
    await callManual("build", { draft: true });
    manualStatus.textContent = `${res.count} 件のモジュールから最新 API ドキュメント（docs/modules/, docs/api.md）を自動生成しました！`;
  } catch (e) {
    manualStatus.textContent = `APIドキュメント生成失敗: ${String(e)}`;
  } finally {
    manualBusy = false;
    manualView.removeAttribute("aria-busy");
    await refreshManual();
  }
}
btnManualGenerateApi?.addEventListener("click", () => void runGenerateApi());
btnManualApiRun?.addEventListener("click", () => void runGenerateApi());

manualTasks.addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    const fbInput = (event.target as HTMLElement).closest<HTMLInputElement>(".manual-feedback-input");
    if (fbInput) {
      if (fbInput.id.startsWith("manual-feedback-input-")) {
        const id = fbInput.id.replace("manual-feedback-input-", "");
        document.querySelector<HTMLButtonElement>(`button[data-manual-feedback-submit="${id}"]`)?.click();
      } else if (fbInput.id.startsWith("manual-image-input-")) {
        const id = fbInput.id.replace("manual-image-input-", "");
        document.querySelector<HTMLButtonElement>(`button[data-manual-image-submit="${id}"]`)?.click();
      }
    }
  }
});

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

function switchToOverview(showWorkspace = true) {
  if (showWorkspace) selectWorkspaceTab("modules");
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
    separateOverlappingNodes(cy.nodes(":childless").not(".hidden"));
    cy.fit(cy.elements().not(".hidden"), 40);
  } catch {
    localStorage.removeItem(key);
  }
}

function separateOverlappingNodes(nodes: cytoscape.NodeCollection) {
  const horizontalFlow = flowDirection === "LR";
  const ordered = nodes.toArray().sort((a, b) => {
    const first = horizontalFlow ? a.position("y") - b.position("y") : a.position("x") - b.position("x");
    return first || a.id().localeCompare(b.id());
  });
  const placed: cytoscape.NodeSingular[] = [];
  const gap = 16;
  for (const node of ordered) {
    // Keep the flow rank fixed and move only across the flow direction.
    for (let attempt = 0; attempt < placed.length; attempt++) {
      const box = node.boundingBox({ includeLabels: true, includeOverlays: false });
      let shift = 0;
      for (const other of placed) {
        const previous = other.boundingBox({ includeLabels: true, includeOverlays: false });
        const crossOverlap = horizontalFlow
          ? box.x1 < previous.x2 + gap && box.x2 + gap > previous.x1
          : box.y1 < previous.y2 + gap && box.y2 + gap > previous.y1;
        if (!crossOverlap) continue;
        const separation = horizontalFlow ? previous.y2 + gap - box.y1 : previous.x2 + gap - box.x1;
        if (separation > 0 && (horizontalFlow ? box.y1 < previous.y2 + gap : box.x1 < previous.x2 + gap)) {
          shift = Math.max(shift, separation);
        }
      }
      if (shift === 0) break;
      node.position(horizontalFlow ? { x: node.position("x"), y: node.position("y") + shift }
        : { x: node.position("x") + shift, y: node.position("y") });
    }
    placed.push(node);
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
  selectWorkspaceTab("modules");
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

function jumpToFileCentricDiagram(moduleId: string, showWorkspace = true) {
  if (!currentResult) return;
  const mod = currentResult.modules.find((m) => m.id === moduleId);
  if (!mod) return;

  if (showWorkspace) selectWorkspaceTab("modules");

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

(window as any).openModuleByFilePath = (filePath: string) => {
  const target = filePath.replace(/\\/g, "/");
  const mod = currentResult?.modules.find((item) => item.absolute_path.replace(/\\/g, "/") === target);
  if (mod) selectModuleById(mod.id, true);
};

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
  if (activeWorkspaceTab === "diagnostics") graphNeedsFit = true;
  if (!cy) return;
  const previousSelectedId = selectedModule?.id;
  const wasOverview = currentViewMode === "overview";
  const freshAnalysis = result !== currentResult;
  currentResult = result;
  const previousChainFrom = chainFrom.value;
  const previousChainTo = chainTo.value;
  const moduleIds = result.modules.map((module) => module.id).sort((a, b) => a.localeCompare(b));
  for (const [select, placeholder, previous] of [
    [chainFrom, "出発モジュール", previousChainFrom],
    [chainTo, "到着モジュール", previousChainTo],
  ] as const) {
    select.replaceChildren(new Option(placeholder, ""), ...moduleIds.map((id) => new Option(id, id)));
    if (moduleIds.includes(previous)) select.value = previous;
  }

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
        label: isCycle ? `🚨 ${mod.name}\n${translateUiText("[循環参照]")}` : mod.name,
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
        cycleLabel: edge.is_circular ? translateUiText(`🚨 循環 (L:${edge.line})`) : "",
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
  if (freshAnalysis && !recordAnalysisHistory(result)) {
    console.warn("解析履歴をブラウザ内に保存できませんでした");
  }

  if (wasOverview) {
    switchToOverview(false);
    return;
  }
  if (previousSelectedId && result.modules.some((module) => module.id === previousSelectedId)) {
    jumpToFileCentricDiagram(previousSelectedId, false);
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
    jumpToFileCentricDiagram(keyMod.id, false);
  } else {
    switchToOverview(false);
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
      nodeDimensionsIncludeLabels: true,
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
  separateOverlappingNodes(cy.nodes(":childless").not(".hidden"));
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
          node.data("label", `🎯 ${modName}\n${translateUiText("[起点モジュール]")}`);
        } else if (fileData?.roots.includes(id)) {
          node.addClass("root-node");
          node.data("label", `🌱 ${modName}\n${translateUiText("[ルーツ]")}`);
        } else if (fileData?.cycleModules.has(id)) {
          node.data("label", `🚨 ${modName}\n${translateUiText("[循環]")}`);
        } else {
          node.data("label", modName);
        }
      } else {
        const isCycle = cycleNodeIds.has(id);
        node.data("label", isCycle ? `🚨 ${modName}\n${translateUiText("[循環参照]")}` : modName);
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
          nodeDimensionsIncludeLabels: true,
          padding: 50,
          animate: false,
        } as any)
        .run();

      separateOverlappingNodes(visibleNodes);

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

interface CycleCandidateInfo {
  source: string;
  target: string;
  line: number;
  kind: "type_only" | "runtime" | "unknown";
  canFix: boolean;
}

function getCycleCandidate(cycle: CircularCycle): CycleCandidateInfo | null {
  if (!currentResult) return null;
  const item = cycleSuggestion(cycle, currentResult.edges);
  if (!item) return null;
  const selectedTool = fixTools.find((tool) => tool.id === fixToolSelect.value) || fixTools[0];
  const canFix = !!(cycle.suggestion && selectedTool?.kinds.includes(item.kind));
  return {
    source: item.source,
    target: item.target,
    line: item.line,
    kind: item.kind,
    canFix,
  };
}

function renderCycleResolveButton(cycle: CircularCycle, extraClasses: string = ""): string {
  const candidate = getCycleCandidate(cycle);
  const selectedTool = fixTools.find((tool) => tool.id === fixToolSelect.value) || fixTools[0];
  const toolLabel = selectedTool?.label || "Ruff";
  const pathStr = cycle.path && cycle.path.length
    ? cycle.path.map((p) => p.split(".").pop() || p).join(" ➔ ")
    : (cycle.modules || []).map((p) => p.split(".").pop() || p).join(" ➔ ");

  const source = candidate?.source || (cycle.modules && cycle.modules[0]) || "";
  const target = candidate?.target || (cycle.modules && cycle.modules[1]) || "";
  const line = candidate?.line || 1;
  const kind = candidate?.kind || "unknown";

  const isHeader = extraClasses.includes("btn-cycle-resolve-header");
  const resolveBtn = `<button class="btn-cycle-resolve auto-fix-mode ${extraClasses}"
    data-cycle-source="${escapeHtml(source)}"
    data-cycle-target="${escapeHtml(target)}"
    data-cycle-line="${line}"
    data-cycle-kind="${escapeHtml(kind)}"
    data-can-fix="true"
    data-cycle-path="${escapeHtml(pathStr)}"
    title="${escapeHtml(toolLabel)} を使用して循環インポートの自動解消を試みます（差分プレビュー）">🛠️ ${escapeHtml(toolLabel)} で循環解消</button>`;

  if (isHeader) {
    return resolveBtn;
  }

  const guideBtn = `<button class="btn-cycle-guide-trigger guide-mode ${extraClasses}"
    data-cycle-source="${escapeHtml(source)}"
    data-cycle-target="${escapeHtml(target)}"
    data-cycle-line="${line}"
    data-cycle-kind="${escapeHtml(kind)}"
    data-cycle-path="${escapeHtml(pathStr)}"
    title="循環インポートの解消手順と対処法を表示">📖 解消ガイド</button>`;

  return `${resolveBtn} ${guideBtn}`;
}

function renderCycleSuggestion(cycle: CircularCycle): string {
  if (!currentResult) return "";
  const item = cycleSuggestion(cycle, currentResult.edges);
  const source = item && currentResult.modules.find((module) => module.id === item.source);
  if (!item || !source) return "";
  return `<div style="width:100%; font-size:0.72rem; color:var(--text-muted); margin-top:4px;">
    改善候補: <span class="dep-item-line" data-jump-file="${escapeHtml(source.absolute_path)}" data-jump-line="${item.line}" title="import 行を開く">${escapeHtml(item.source)} → ${escapeHtml(item.target)} (L:${item.line})</span>。${escapeHtml(cycleGuidance(item.kind))} 変更後は自動更新または再解析で確認できます。
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
    fixToolControl.hidden = available.length <= 1;
    return null;
  } catch (error: any) {
    fixTools = [{ id: "ruff", label: "Ruff (TC001)", kinds: ["type_only"] }];
    fixToolSelect.innerHTML = '<option value="ruff">Ruff (TC001)</option>';
    fixToolControl.hidden = true;
    return error.toString();
  }
}

function renderInspector(mod: ModuleInfo) {
  if (!currentResult) return;
  toggleInspectorPanel(true);
  const outsideCurrentDiagram = currentViewMode === "file" && !!cy?.$id(mod.id).hasClass("hidden");
  const isCycle = currentResult.cycles.some((c) => c.modules.includes(mod.id));
  const editor = preferredEditor();

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

  inspectorContent.innerHTML = `
    <div class="module-detail">
      ${outsideCurrentDiagram ? '<p style="color: var(--text-muted); font-size: 0.82rem; margin-bottom: 10px;">現在の依存図には含まれません。図を切り替えるには、ツリーまたはノードのダブルクリックを使ってください。</p>' : ""}
      <h2 style="font-size: 1.1rem; margin-bottom: 4px; display: flex; align-items: center; justify-content: space-between;">
        <span class="module-title-link" id="link-jump-code" title="${editor === "pycharm" ? "PyCharm" : "VS Code"} で開く (行: 1)">${escapeHtml(mod.name)}</span>
        <span>
          ${isCycle ? '<span class="tag tag-cycle">循環</span>' : ""}
          ${mod.is_oversized ? '<span class="tag tag-bloat">肥大化</span>' : ""}
        </span>
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
                      <li class="dep-item" data-jump-file="${mod.absolute_path}" data-jump-line="${edge.line}" data-diagram-mod="${edge.target}" title="${edge.target} (${path}${isDeferred ? ' - 遅延インポート' : ''}) - クリックで import 文 (行: ${edge.line}) を開く">
                        <div class="dep-item-left">
                          <span class="dep-item-name">${name}</span>
                          ${inDirectCycle ? '<span class="tag tag-cycle" style="font-size:0.65rem; padding:1px 3px;">🔄 循環</span>' : ""}
                          ${isDeferred && !inDirectCycle ? '<span style="color:#a6adc8; font-size:0.65rem; background:#181825; border:1px solid #45475a; padding:1px 4px; border-radius:3px;" title="関数・メソッド内の遅延インポート（モジュール初期化時にはロードされないため循環エラーを回避）">⚡ 遅延インポート</span>' : ""}
                          ${inDownstreamCycle ? '<span class="tag tag-bloat" style="font-size:0.65rem; padding:1px 3px;" title="この依存先の下流で循環インポートが発生">⚠️ 先で循環</span>' : ""}
                        </div>
                        <div class="dep-item-actions">
                          <span class="dep-item-line" title="import文の行を開く">L:${edge.line}</span>
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
          : `<ul class="dep-list">${mod.unresolved_imports!.map((name) => {
              const matched = (mod.imports || []).find((imp) => imp.module === name || imp.module.startsWith(name + ".") || (imp.imported_names || []).includes(name));
              const line = matched?.line;
              return `
                <li class="dep-item"${line ? ` data-jump-file="${mod.absolute_path}" data-jump-line="${line}" title="クリックで import 行 (L:${line}) を開く"` : ""}>
                  <div class="dep-item-left">
                    <span class="dep-item-name">${escapeHtml(name)}</span>
                  </div>
                  ${line ? `<div class="dep-item-actions"><span class="dep-item-line" title="import文の行を開く">L:${line}</span></div>` : ""}
                </li>
              `;
            }).join("")}</ul>`}
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
                    const targetFile = srcMod ? srcMod.absolute_path : "";
                    return `
                      <li class="dep-item"${targetFile ? ` data-jump-file="${targetFile}" data-jump-line="${edge.line}"` : ""} data-diagram-mod="${edge.source}" title="${edge.source} (${path}${isDeferred ? ' - 遅延インポート' : ''})${targetFile ? ` - クリックで利用元の import 文 (行: ${edge.line}) を開く` : ""}">
                        <div class="dep-item-left">
                          <span class="dep-item-inbound-name">${name}</span>
                          ${inCycle ? '<span class="tag tag-cycle" style="font-size:0.65rem; padding:1px 3px;">🔄 循環</span>' : ""}
                          ${isDeferred && !inCycle ? '<span style="color:#a6adc8; font-size:0.65rem; background:#181825; border:1px solid #45475a; padding:1px 4px; border-radius:3px;" title="利用元の関数内での遅延インポート">⚡ 遅延インポート</span>' : ""}
                        </div>
                        <div class="dep-item-actions">
                          <span class="dep-item-line" title="利用元の該当行を開く">L:${edge.line}</span>
                        </div>
                      </li>
                    `;
                  })
                  .join("")
          }
        </ul>
      </div>

      <!-- 循環インポートのグラフィカル可視化カード (被インポートリストの下) -->
      ${
        directCycles.length > 0 || depCycles.length > 0
          ? `
        <div class="cycle-card">
          <div class="cycle-card-header">
            <div class="cycle-card-title">
              <span>🔄 循環インポート検出</span>
            </div>
            ${(() => {
              const allCycles = [...directCycles, ...depCycles];
              const bestCycle = allCycles.find((c) => {
                const cand = getCycleCandidate(c);
                return cand && cand.canFix;
              }) || allCycles[0];
              return bestCycle ? renderCycleResolveButton(bestCycle, "btn-cycle-resolve-header") : "";
            })()}
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
                <div class="cycle-row-actions">
                  <button class="btn-cycle-focus" data-cycle-idx="${cIdx}" data-cycle-type="direct">強調表示</button>
                  ${renderCycleResolveButton(c)}
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
                <div class="cycle-row-actions">
                  <button class="btn-cycle-focus" data-cycle-idx="${cIdx}" data-cycle-type="dep">強調表示</button>
                  ${renderCycleResolveButton(c)}
                </div>
              </div>`
              )
              .join("")}
          </div>
        </div>
      `
          : ""
      }

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
  document.getElementById("btn-open-callgraph")?.addEventListener("click", () => openCallGraph(mod));
  document.getElementById("link-jump-code")?.addEventListener("click", (e) => {
    e.preventDefault();
    jumpToEditor(mod.absolute_path, 1);
  });

  // Double-click on import item to switch to its dependency diagram
  inspectorContent.querySelectorAll<HTMLElement>("[data-diagram-mod]").forEach((el) => {
    el.addEventListener("dblclick", (e) => {
      e.stopPropagation();
      const mId = el.getAttribute("data-diagram-mod");
      if (mId) jumpToFileCentricDiagram(mId);
    });
  });

  // Select module by clicking item in inspector -> jump to its dependency diagram (e.g. cycle pills)
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
  inspectorContent.querySelectorAll<HTMLElement>(".btn-cycle-resolve").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const source = btn.getAttribute("data-cycle-source") || "";
      const target = btn.getAttribute("data-cycle-target") || "";
      const line = Number(btn.getAttribute("data-cycle-line")) || 0;
      const canFix = btn.getAttribute("data-can-fix") === "true";
      const itemKind = btn.getAttribute("data-cycle-kind") || "unknown";
      const pathStr = btn.getAttribute("data-cycle-path") || "";
      handleCycleResolveClick(source, target, line, canFix, itemKind, pathStr);
    });
  });
  inspectorContent.querySelectorAll<HTMLElement>(".btn-cycle-guide-trigger").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const source = btn.getAttribute("data-cycle-source") || "";
      const target = btn.getAttribute("data-cycle-target") || "";
      const line = Number(btn.getAttribute("data-cycle-line")) || 0;
      const itemKind = btn.getAttribute("data-cycle-kind") || "unknown";
      const pathStr = btn.getAttribute("data-cycle-path") || "";
      openCycleGuideModal(source, target, line, itemKind, pathStr);
    });
  });
  inspectorContent.querySelectorAll(".btn-preview-ruff-fix").forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.stopPropagation();
      const source = btn.getAttribute("data-cycle-source");
      const target = btn.getAttribute("data-cycle-target") || "";
      const line = Number(btn.getAttribute("data-cycle-line"));
      if (source && line > 0) void previewRuffCycleFix(source, target, line, "type_only", "");
    });
  });
}

function openCycleGuideModal(source: string, target: string, line: number, itemKind: string, pathStr: string) {
  if (!cycleGuideModal) return;
  const selectedTool = fixTools.find((t) => t.id === fixToolSelect.value) || fixTools[0];
  const toolLabel = selectedTool?.label || "外部ツール (Ruff)";

  if (cycleGuidePath) {
    cycleGuidePath.textContent = pathStr || (selectedModule ? selectedModule.id : "循環ループ");
  }

  const mod = currentResult?.modules.find((m) => m.id === source);
  const filePath = mod ? mod.absolute_path : "";

  if (cycleGuideTargetDesc) {
    if (source && target && line > 0) {
      cycleGuideTargetDesc.innerHTML = `対象: <code style="color:var(--accent-color);">${escapeHtml(source)}</code> (L:${line}) から <code style="color:var(--accent-color);">${escapeHtml(target)}</code> への import`;
    } else if (source && line > 0) {
      cycleGuideTargetDesc.innerHTML = `対象: <code style="color:var(--accent-color);">${escapeHtml(source)}</code> (L:${line}) の import 行`;
    } else {
      cycleGuideTargetDesc.textContent = "対象: 循環ループ内の import 行";
    }
  }

  if (cycleGuideToolReason) {
    if (itemKind === "runtime") {
      cycleGuideToolReason.innerHTML = `⚠️ <strong>${escapeHtml(toolLabel)} では自動解消できません</strong>: この import は関数の呼び出し等、実行時（Runtime）にも直接参照されています。${escapeHtml(toolLabel)} は型注釈（<code>TYPE_CHECKING</code>）のみの分離を行うため、実行時参照を書き換えると <code>NameError</code> 等の実行時障害を引き起こします。以下の安全な手動解消アプローチを実施してください。`;
    } else if (itemKind === "type_only") {
      cycleGuideToolReason.innerHTML = `ℹ️ <strong>型注釈参照</strong>: ${escapeHtml(toolLabel)} の自動修正で <code>TYPE_CHECKING</code> ブロックへ退避できる可能性があります。ツール未検出または差分未提示の場合は、以下の手順で手動解消してください。`;
    } else {
      cycleGuideToolReason.innerHTML = `⚠️ <strong>${escapeHtml(toolLabel)} による自動修正は利用できません</strong>: 参照の用途が特定できないか、ツールの自動書き換えに対応していません。以下の推奨手順で手動解消してください。`;
    }
  }

  if (cycleGuideCodeExample) {
    const shortTarget = target ? target.split(".").pop() || target : "module_b";
    const funcExample = target
      ? `from ${target} import some_func\n    return some_func()`
      : `from app.${shortTarget} import some_func\n    return some_func()`;
    cycleGuideCodeExample.textContent = `# 関数・メソッド内で遅延インポートする例:\ndef some_operation():\n    ${funcExample}`;
  }

  if (btnCycleGuideJump) {
    if (filePath && line > 0) {
      btnCycleGuideJump.style.display = "flex";
      if (cycleGuideJumpLabel) {
        cycleGuideJumpLabel.textContent = `エディタで開く (${source.split(".").pop() || "ファイル"} L:${line})`;
      }
      btnCycleGuideJump.onclick = () => {
        closeCycleGuideModal();
        jumpToEditor(filePath, line);
      };
    } else if (selectedModule) {
      const targetMod = selectedModule;
      btnCycleGuideJump.style.display = "flex";
      if (cycleGuideJumpLabel) {
        cycleGuideJumpLabel.textContent = `エディタで開く (${targetMod.name})`;
      }
      btnCycleGuideJump.onclick = () => {
        closeCycleGuideModal();
        jumpToEditor(targetMod.absolute_path, 1);
      };
    } else {
      btnCycleGuideJump.style.display = "none";
    }
  }

  cycleGuideModal.classList.remove("hidden");
}

function closeCycleGuideModal() {
  cycleGuideModal?.classList.add("hidden");
}

function handleCycleResolveClick(source: string, target: string, line: number, _canFix: boolean, itemKind: string, pathStr: string) {
  if (source) {
    void previewRuffCycleFix(source, target, line, itemKind, pathStr);
  } else {
    openCycleGuideModal(source, target, line, itemKind, pathStr);
  }
}

async function triggerCycleResolveWithRuff(targetCycle?: CircularCycle) {
  if (!currentResult || !currentResult.cycles || currentResult.cycles.length === 0) {
    statusBar.innerText = "循環インポートは検出されていません";
    return;
  }

  let cycle = targetCycle;
  if (!cycle && selectedModule) {
    cycle = currentResult.cycles.find((c) => c.modules.includes(selectedModule!.id));
  }
  if (!cycle) {
    cycle = currentResult.cycles[0];
  }

  const toolId = fixToolSelect.value || "ruff";
  const selectedTool = fixTools.find((t) => t.id === toolId) || fixTools[0];
  const toolLabel = selectedTool?.label || "Ruff";
  statusBar.innerText = `${toolLabel} で循環インポート解消差分を確認中...`;

  const pathStr = cycle.path && cycle.path.length
    ? cycle.path.map((p) => p.split(".").pop() || p).join(" ➔ ")
    : (cycle.modules || []).map((p) => p.split(".").pop() || p).join(" ➔ ");

  const candidate = getCycleCandidate(cycle);

  const candidatesToTry: Array<{ source: string; target: string; line: number; kind: string }> = [];
  if (candidate && candidate.source) {
    candidatesToTry.push({ source: candidate.source, target: candidate.target, line: candidate.line, kind: candidate.kind });
  }
  for (const mId of cycle.modules) {
    if (!candidatesToTry.some((c) => c.source === mId)) {
      const edge = currentResult.edges.find((e) => e.source === mId && cycle.modules.includes(e.target));
      candidatesToTry.push({
        source: mId,
        target: edge ? edge.target : "",
        line: edge ? edge.line : 1,
        kind: "unknown",
      });
    }
  }

  for (const item of candidatesToTry) {
    try {
      const preview = await invokeCommand<{ file: string; diff: string; tool: string }>("preview_cycle_fix", {
        path: currentResult.root_path,
        source: item.source,
        target: item.target,
        line: item.line,
        kind: item.kind,
        toolId,
      });
      if (preview.diff && preview.diff.trim()) {
        activeFixToolName = preview.tool || toolLabel;
        (document.getElementById("ruff-fix-title") as HTMLElement).textContent = `${preview.tool || toolLabel} による循環インポート解消差分`;
        ruffFixFile.textContent = preview.file;
        ruffFixDiff.textContent = preview.diff;
        btnApplyRuffFix.disabled = false;
        ruffFixModal.classList.remove("hidden");
        statusBar.innerText = `${preview.tool || toolLabel} の修正差分を表示しています。「差分を適用」で循環インポートを解消できます`;
        return;
      }
    } catch {
      // 次のモジュールを試行
    }
  }

  statusBar.innerText = `${toolLabel} による自動修正差分はありませんでした（型注釈ではなく実行時呼び出し等の可能性があります）。解消手順ガイドを表示します。`;
  const first = candidatesToTry[0] || { source: cycle.modules[0] || "", target: cycle.modules[1] || "", line: 1, kind: "unknown" };
  openCycleGuideModal(first.source, first.target, first.line, first.kind, pathStr);
}

async function previewRuffCycleFix(source: string, target: string, line: number, itemKind: string, pathStr: string) {
  if (!currentResult) return;
  const toolId = fixToolSelect.value || "ruff";
  const selectedTool = fixTools.find((t) => t.id === toolId) || fixTools[0];
  const toolLabel = selectedTool?.label || "Ruff";
  statusBar.innerText = `${toolLabel} による循環インポート解消差分を確認中...`;
  try {
    const preview = await invokeCommand<{ file: string; diff: string; tool: string }>("preview_cycle_fix", {
      path: currentResult.root_path, source, target, line, kind: itemKind, toolId,
    });
    if (!preview.diff || !preview.diff.trim()) {
      statusBar.innerText = `${preview.tool || toolLabel} による自動修正差分はありませんでした（型注釈ではなく実行時参照等の可能性があります）。解消ガイドを表示します。`;
      openCycleGuideModal(source, target, line, itemKind, pathStr);
      return;
    }
    activeFixToolName = preview.tool || toolLabel;
    (document.getElementById("ruff-fix-title") as HTMLElement).textContent = `${preview.tool || toolLabel} による循環インポート解消差分`;
    ruffFixFile.textContent = preview.file;
    ruffFixDiff.textContent = preview.diff;
    btnApplyRuffFix.disabled = false;
    ruffFixModal.classList.remove("hidden");
    statusBar.innerText = `${preview.tool || toolLabel} の修正差分を表示しています。「差分を適用」で循環インポートを解消できます`;
  } catch (error: any) {
    statusBar.innerText = `${toolLabel} 差分確認: ${error.toString()}（解消ガイドを表示します）`;
    openCycleGuideModal(source, target, line, itemKind, pathStr);
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

  statusBar.innerText = `循環インポートループをグラフィカル表示: ${cycleModules.map(m => m.split(".").pop()).join(" ➔ ")}`;
}


function renderComplexityDashboard(result: AnalysisResult) {
  const summary = result.complexity;
  if (!summary || result.modules.length === 0) {
    complexityDashboardScore.textContent = "";
    complexityDashboardContent.textContent = currentUiLocale() === "en" ? "No Python modules found" : "Python モジュールが見つかりませんでした";
    return;
  }
  const en = currentUiLocale() === "en";
  const score = Math.max(0, Math.min(100, summary.score));
  complexityDashboardTitle.textContent = en ? "Code diagnostics" : "コード診断";
  complexityDashboardScore.textContent = `${en ? "Overall complexity" : "総合複雑度"}: ${score} / 100`;
  const components: Array<[string, number]> = [
    [en ? "Imports" : "相互参照", summary.imports],
    [en ? "Size" : "コード量", summary.size],
    [en ? "Code complexity" : "分岐の複雑さ", summary.code],
    [en ? "Duplication" : "重複コード", summary.duplication],
  ];
  const metricHtml = components.map(([label, value]) => `<div class="complexity-component">
    <span>${label}</span><strong>${value}</strong><progress max="100" value="${value}" aria-label="${label}"></progress>
  </div>`).join("");
  const hotspots = summary.hotspots.slice(0, 3).map((item) => {
    const reasons = [
      item.cycle ? (en ? "cycle" : "循環") : "",
      item.mutual_import && !item.cycle ? (en ? "mutual imports" : "相互 import") : "",
      item.oversized ? (en ? "oversized" : "肥大化") : "",
      item.duplicate_lines ? `${en ? "duplicate" : "重複"} ${item.duplicate_lines} ${en ? "lines" : "行"}` : "",
      item.cyclomatic_complexity > 10 ? `${en ? "complexity" : "循環的複雑度"} ${item.cyclomatic_complexity}` : "",
      item.max_function_complexity ? `${item.max_function_name || "function"} CCN ${item.max_function_complexity}` : "",
    ].filter(Boolean).join(" · ");
    return `<button class="complexity-hotspot" data-module="${escapeHtml(item.module)}" title="${escapeHtml(reasons)}">
      <span>${escapeHtml(item.module)}</span><strong>${item.score}</strong><small>${escapeHtml(reasons || `${en ? "imports" : "依存"} ${item.imports} / ${en ? "imported by" : "被依存"} ${item.imported_by}`)}</small>
    </button>`;
  }).join("");
  const duplicateRows = summary.duplicate_blocks.map((block) => {
    const renamed = block.kind === "renamed";
    const suggestion = block.lines >= 10
      ? (en ? "Consider extracting a shared function" : "共通関数化を検討")
      : (renamed ? (en ? "Review similar code" : "類似コードを確認") : (en ? "Review copied code" : "コピペ箇所を確認"));
    const firstEnd = block.first_line + block.lines - 1;
    const secondEnd = block.second_line + block.lines - 1;
    const signatureParts = (signature?: string) => {
      const match = signature?.match(/^(\(.*\))(?: -> (.*))?$/);
      return { parameters: match?.[1] || "?", returns: match?.[2] || "?" };
    };
    const first = signatureParts(block.first_signature);
    const second = signatureParts(block.second_signature);
    const parameterComparison = first.parameters === "?" || second.parameters === "?"
      ? (en ? "unknown" : "不明")
      : first.parameters === second.parameters ? (en ? "same" : "同じ") : `${escapeHtml(first.parameters)} ↔ ${escapeHtml(second.parameters)}`;
    const returnComparison = first.returns === "?" || second.returns === "?"
      ? (en ? "not annotated" : "型注釈なし")
      : first.returns === second.returns ? (en ? "same" : "同じ") : `${escapeHtml(first.returns)} ↔ ${escapeHtml(second.returns)}`;
    const functionDetail = block.first_function && block.second_function
      ? `<small>${en ? "Functions" : "関数"}: ${escapeHtml(block.first_function)} ↔ ${escapeHtml(block.second_function)}</small><small>${en ? "Parameters" : "引数"}: ${parameterComparison} · ${en ? "Return annotation" : "戻り値の型注釈"}: ${returnComparison}</small>`
      : "";
    const reason = block.lines >= 10 && block.first_function && block.second_function
      ? (en ? "Repeated logic inside functions; compare behavior before extracting." : "関数内で処理が重複しています。動作の違いを確認して共通化を検討できます。")
      : (renamed ? (en ? "The structure matches after identifiers are ignored." : "識別子を除いた処理構造が一致しています。") : (en ? "Consecutive code lines match." : "処理行が連続して一致しています。"));
    return `<div class="complexity-duplicate-row"><strong>${suggestion}</strong><small>${renamed ? (en ? "Similar structure (identifiers ignored)" : "類似構造（識別子を無視）") : (en ? "Exact match" : "完全一致")} · ${block.lines} ${en ? "lines" : "行"}</small><small>${reason}</small>${functionDetail}<div class="complexity-duplicate-locations"><button data-module="${escapeHtml(block.first_module)}" data-line="${block.first_line}">${escapeHtml(block.first_module)}:${block.first_line}–${firstEnd}</button><span>↔</span><button data-module="${escapeHtml(block.second_module)}" data-line="${block.second_line}">${escapeHtml(block.second_module)}:${block.second_line}–${secondEnd}</button></div></div>`;
  }).join("");
  const literalRows = (summary.literal_findings || []).map((finding) =>
    `<button class="complexity-finding" data-module="${escapeHtml(finding.module)}" data-line="${finding.line}"><span>${finding.kind === "magic-number" ? (en ? "Magic number" : "マジックナンバー") : finding.kind === "repeated-number" ? (en ? "Repeated number" : "重複数値") : (en ? "Repeated string" : "重複文字列")}</span><strong>${escapeHtml(finding.module)}:${finding.line}</strong><small>${escapeHtml(finding.value)}${finding.count > 1 ? ` (${finding.count}×)` : ""}</small></button>`
  ).join("");
  const warnings = (summary.quality_warnings || []).map((warning) => `<li>${escapeHtml(warning)}</li>`).join("");
  const typeFindings = result.modules.flatMap((module) => module.diagnostics
    .filter((diagnostic) => diagnostic.rule?.startsWith("ty/"))
    .map((diagnostic) => ({ module, diagnostic })));
  const typeRows = typeFindings.slice(0, 30).map(({ module, diagnostic }) =>
    `<button class="complexity-finding" data-module="${escapeHtml(module.id)}" data-line="${diagnostic.line || 1}"><span>${escapeHtml(diagnostic.rule || "ty")}</span><strong>${escapeHtml(module.id)}:${diagnostic.line || 1}</strong><small>${escapeHtml(diagnostic.message)}</small></button>`
  ).join("");
  const typeStatus = summary.quality_warnings?.some((warning) => warning.startsWith("ty "))
    ? (en ? "ty could not run; see tool warnings" : "ty を実行できませんでした。外部ツールの警告を確認してください")
    : (en ? "No type diagnostics found" : "型診断は見つかりませんでした");
  const sourceLabel = `${en ? "Code" : "分岐"}: ${escapeHtml(summary.code_source || "ModuleLoom")} · ${en ? "Duplicates" : "重複"}: ${escapeHtml(summary.duplication_source || "ModuleLoom")} · ${en ? "Magic numbers" : "数値"}: ${escapeHtml(summary.magic_source || (summary.quality_ran ? (en ? "unavailable" : "利用不可") : (en ? "not run" : "未実行")))}`;
  complexityDashboardContent.innerHTML = `<div class="complexity-overall">
    <div class="complexity-ring" role="meter" aria-label="${en ? "Overall complexity" : "総合複雑度"}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${score}" style="--risk:${score}"><strong>${score}</strong><small>/ 100</small></div>
    <div><strong>${en ? "Overall complexity" : "総合複雑度"}</strong><small>${en ? "Higher means more review needed" : "高いほど見直しの目安"}</small>${result.analysis_errors?.length ? `<small class="complexity-incomplete">${en ? "Incomplete: " : "未解析: "}${result.analysis_errors.length} ${en ? "files" : "件"}</small>` : ""}</div>
  </div><div class="complexity-components">${metricHtml}</div><div class="complexity-priorities"><strong>${en ? "Review first" : "優先して確認"}</strong>${hotspots || `<small>${en ? "No findings" : "候補なし"}</small>`}</div>
  <section class="complexity-duplicates"><strong>${en ? "Copy and extraction candidates" : "コピペ・関数化候補"} (${summary.duplicate_blocks.length})</strong><small>${en ? "Matching code from" : "検出元"} ${escapeHtml(summary.duplication_source || "ModuleLoom")}${summary.quality_ran && summary.duplication_source === "jscpd" ? " v5" : ""}. ${en ? "Extraction is a suggestion; check behavior before changing code." : "関数化は提案です。変更前に処理の違いを確認してください。"}</small>${duplicateRows ? `<div class="complexity-duplicate-list">${duplicateRows}</div>` : `<small>${summary.quality_ran ? (en ? "No matches at the 6-line, 30-token threshold" : "6行・30トークン以上の一致は見つかりませんでした") : (en ? "Run diagnostics to check copied code with jscpd v5" : "「診断実行」で jscpd v5 による重複検出を実行できます")}</small>`}</section>
  <div class="complexity-quality"><strong>${en ? "Code diagnostics" : "コード診断"}</strong><small>${sourceLabel}</small>${summary.quality_ran ? `<div class="complexity-finding-list">${literalRows || `<small>${en ? "No magic numbers or repeated literals found" : "マジックナンバー・重複リテラルの検出なし"}</small>`}</div><strong>${en ? "Type diagnostics (ty)" : "型診断 (ty)"} (${typeFindings.length})</strong><div class="complexity-finding-list">${typeRows || `<small>${typeStatus}</small>`}</div>${typeFindings.length > 30 ? `<small>${en ? "Showing first 30 findings; see the issues list for all results" : "最初の30件を表示。全件は問題一覧で確認できます"}</small>` : ""}${warnings ? `<details><summary>${en ? "Tool warnings" : "外部ツールの警告"} (${summary.quality_warnings?.length})</summary><ul>${warnings}</ul></details>` : ""}` : `<small>${en ? "Run diagnostics to check the current code" : "「診断実行」で現在のコードを確認できます"}</small>`}</div>
  <details class="complexity-method"><summary>${en ? "Method" : "算出方法"} (${summary.duplicate_lines} ${en ? "duplicate lines" : "重複行"})</summary><p>${en ? "Heuristic score: imports 35%, size 25%, branch complexity 20%, duplication 20%. Code and duplicate metrics use Lizard and jscpd when available; otherwise ModuleLoom estimates are used. Ruff PLR2004 checks comparison literals; repeated strings (8+ characters) and numbers (except 0 and 1) occur at least three times." : "目安値: 相互参照35%、肥大化25%、分岐の複雑さ20%、重複20%。分岐と重複は Lizard・jscpd が利用可能なら採用し、なければ ModuleLoom の推定値を使います。Ruff PLR2004 は比較式の数値を検出し、重複リテラルは8文字以上の文字列か0・1以外の数値が3回以上の候補です。"}</p></details>`;
}

complexityDashboard.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-module]");
  if (!button || !currentResult) return;
  const module = currentResult.modules.find((item) => item.id === button.dataset.module);
  if (!module) return;
  const line = Number(button.dataset.line);
  if (line > 0) void jumpToEditor(module.absolute_path, line);
  else jumpToFileCentricDiagram(module.id);
});

function updateSummary(result: AnalysisResult) {
  renderComplexityDashboard(result);
  renderIssuesList();
  const cycleCount = result.cycles.length;
  const errorCount = result.analysis_errors?.length || 0;

  if (btnResolveCycles) {
    if (cycleCount > 0) {
      btnResolveCycles.style.display = "inline-flex";
      btnResolveCycles.innerHTML = `🛠️ 循環解消 (Ruff) <span style="background:#11111b; color:#fab387; border-radius:10px; padding:1px 6px; font-size:0.72rem; margin-left:3px; font-weight:bold;">${cycleCount}</span>`;
    } else {
      btnResolveCycles.style.display = "none";
    }
  }

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
  if (!currentResult || !analysisHistoryModal || !analysisHistoryBase || !analysisHistoryHead) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const history = readAnalysisHistory(currentResult.root_path);
  const options = history.map((snapshot, index) =>
    `<option value="${index}">${escapeHtml(new Date(snapshot.timestamp).toLocaleString(currentUiLocale() === "ja" ? "ja-JP" : "en-US"))} — ${snapshot.result.modules.length} モジュール / ${snapshot.result.cycles.length} 循環</option>`).join("");
  analysisHistoryBase.innerHTML = options;
  analysisHistoryHead.innerHTML = options;
  analysisHistoryBase.value = String(Math.max(0, history.length - 2));
  analysisHistoryHead.value = String(Math.max(0, history.length - 1));
  renderAnalysisHistoryComparison();
  analysisHistoryModal.classList.remove("hidden");
}

function renderAnalysisHistoryComparison() {
  if (!currentResult || !analysisHistoryBase || !analysisHistoryHead || !analysisHistorySummary || !analysisHistoryComparison) return;
  const history = readAnalysisHistory(currentResult.root_path);
  const base = history[Number(analysisHistoryBase.value)];
  const head = history[Number(analysisHistoryHead.value)];
  if (!base || !head) {
    analysisHistorySummary.textContent = "比較できる解析履歴がありません";
    analysisHistoryComparison.textContent = "";
    return;
  }
  analysisHistorySummary.textContent = `モジュール ${base.result.modules.length} → ${head.result.modules.length}、循環 ${base.result.cycles.length} → ${head.result.cycles.length}、行数 ${base.result.total_loc} → ${head.result.total_loc}`;
  if (base === head) {
    analysisHistoryComparison.textContent = "異なる2件を選ぶと、問題の新規・解消・継続を比較できます";
    return;
  }
  const comparison = compareAnalysisIssues(base.result, head.result);
  const sections: Array<[string, keyof typeof comparison]> = [
    ["循環インポート", "cycles"],
    ["設計ルール違反", "architecture"],
    ["依存宣言の問題", "dependencies"],
  ];
  analysisHistoryComparison.innerHTML = sections.map(([title, key]) => {
    const item = comparison[key];
    const rows: Array<[string, string[]]> = [["新規", item.introduced], ["解消", item.resolved], ["継続", item.continuing]];
    return `<section style="margin-bottom: 14px;"><h3>${title}</h3>${rows.map(([label, values]) =>
      `<p style="margin: 6px 0;"><strong>${label} (${values.length})</strong></p>${values.length ? `<ul style="margin-left: 20px;">${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>` : ""}`).join("")}</section>`;
  }).join("");
}

function closeAnalysisHistory() {
  analysisHistoryModal?.classList.add("hidden");
}

async function jumpToEditor(filePath: string, line: number = 1) {
  const editor = preferredEditor();
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

async function runAnalysis(quality = false) {
  const path = pathInput.value.trim();
  if (!path) {
    statusBar.innerText = "Python プロジェクトのパスを入力してください";
    pathInput.focus();
    return false;
  }
  if (analysisRunning) {
    if (quality) qualityAnalysisPending = true;
    else manualAnalysisPending = true;
    return false;
  }
  analysisRunning = true;
  if (quality) {
    selectWorkspaceTab("diagnostics");
    btnQuality.disabled = true;
    btnQuality.textContent = currentUiLocale() === "en" ? "Diagnosing…" : "診断中…";
    btnQuality.setAttribute("aria-busy", "true");
    complexityDashboard.classList.add("quality-loading");
  }
  localStorage.setItem("project_path", path);
  statusBar.innerText = `${quality ? "コード診断中" : "解析中"}: ${path}...`;
  try {
    const result = await invokeCommand<AnalysisResult>("analyze_project", { path, quality });
    updateGraph(result);
    const toolError = await refreshFixTools(path);
    const pendingFilePath = (window as any).__MODULELOOM_PENDING_FILE__;
    if (pendingFilePath) {
      delete (window as any).__MODULELOOM_PENDING_FILE__;
      (window as any).openModuleByFilePath?.(pendingFilePath);
    }
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
    if (quality) {
      btnQuality.disabled = false;
      btnQuality.textContent = currentUiLocale() === "en" ? "Run diagnostics" : "診断実行";
      btnQuality.removeAttribute("aria-busy");
      complexityDashboard.classList.remove("quality-loading");
    }
    if (qualityAnalysisPending) {
      qualityAnalysisPending = false;
      manualAnalysisPending = false;
      void runAnalysis(true);
    } else if (manualAnalysisPending) {
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
let qualityAnalysisPending = false;
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
        : `自動更新完了 (${new Date().toLocaleTimeString(currentUiLocale() === "ja" ? "ja-JP" : "en-US")})`;
    } catch (err: any) {
      statusBar.innerText = `自動再解析エラー: ${err.toString()}`;
    } finally {
      analysisRunning = false;
      if (qualityAnalysisPending) {
        qualityAnalysisPending = false;
        manualAnalysisPending = false;
        void runAnalysis(true);
      } else if (manualAnalysisPending) {
        manualAnalysisPending = false;
        void runAnalysis();
      } else if (analysisPending && watchedPath) {
        scheduleAnalysisFromFileChange();
      }
    }
  }, 500);
}

(window as any).__MODULELOOM_FILE_CHANGED__ = (paths: string[]) => scheduleAnalysisFromFileChange(paths);
(window as any).__MODULELOOM_REANALYZE__ = () => { void runAnalysis(); };
(window as any).__MODULELOOM_RESOLVE_CYCLES__ = () => { void triggerCycleResolveWithRuff(); };

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
    if (!editorSelect) return;
    for (const option of Array.from(editorSelect.options)) {
      const available = option.value === "pycharm" ? hasPycharm : hasVscode;
      option.title = available ? "検出済み" : "コマンドが PATH に見つかりません";
    }
  } catch {
    // The editor can still be opened through URL schemes when CLI detection fails.
  }
}

// --- Git 差分 & 履歴差分 ---
async function highlightGitChanges() {
  const projectPath = (currentResult?.root_path || pathInput?.value?.trim() || "").trim();
  if (!currentResult || !projectPath) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  try {
    const files = await invokeCommand<string[]>("git_changed_files", { path: projectPath });
    highlightChangedFiles(files, "作業中の変更");
  } catch (err: any) {
    statusBar.innerText = `作業中の変更の取得エラー: ${err.toString()}`;
  }
}

function highlightChangedFiles(files: string[], label: string) {
  if (!currentResult) return;
  const normalized = new Set(files.map((file) => file.split("\\").join("/").replace(/^\.\//, "")));
  gitChangedModuleIds = new Set(
    currentResult.modules
      .filter((mod) => normalized.has(mod.relative_path.split("\\").join("/").replace(/^\.\//, "")))
      .map((mod) => mod.id)
  );
  cy?.nodes().removeClass("git-changed");
  for (const id of gitChangedModuleIds) cy?.$id(id).addClass("git-changed");
  statusBar.innerText = gitChangedModuleIds.size === 0
    ? `${label}: 該当する変更 Python ファイルはありません`
    : `${label}: ${gitChangedModuleIds.size} モジュールを強調表示しました`;
}

function openGitHistoryModal() {
  if (!currentResult) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  gitHistoryModal?.classList.remove("hidden");
}

function closeGitHistoryModal() {
  gitHistoryModal?.classList.add("hidden");
}

async function submitGitHistory() {
  const projectPath = (currentResult?.root_path || pathInput?.value?.trim() || "").trim();
  if (!currentResult || !projectPath) return;
  const mode = document.querySelector<HTMLInputElement>('input[name="git-change-mode"]:checked')?.value || "working";
  const base = gitHistoryBase?.value.trim() || "HEAD~1";
  const head = gitHistoryHead?.value.trim() || "HEAD";
  closeGitHistoryModal();
  if (mode === "working") {
    await highlightGitChanges();
    return;
  }
  try {
    const files = await invokeCommand<string[]>("git_diff_files", { path: projectPath, base, head });
    highlightChangedFiles(files, `${base}..${head}`);
  } catch (err: any) {
    statusBar.innerText = `履歴差分の取得エラー: ${err.toString()}`;
  }
}

// --- 解析データ出力 ---
function downloadFile(filename: string, content: string, type: string) {
  const blob = new Blob([content], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

async function exportAnalysisJson() {
  if (!currentResult) {
    statusBar.innerText = "先に解析を実行してください";
    return;
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonContent = JSON.stringify(currentResult, null, 2);
  try {
    const savedPath = await invokeCommand<string>("export_report", {
      path: currentResult.root_path,
      json: jsonContent,
    });
    if (savedPath) {
      statusBar.innerText = `解析データを保存しました: ${savedPath}`;
      return;
    }
  } catch {
    // ホストコマンド未対応時のブラウザダウンロード
  }
  downloadFile(`moduleloom-analysis-${stamp}.json`, jsonContent, "application/json");
  statusBar.innerText = "解析データを JSON で保存しました";
}



// --- 問題・エラー一覧 & モジュール検索 ---
interface IssueItem {
  id: string;
  category: "cycles" | "architecture" | "dependencies" | "unused" | "bloat" | "diagnostics";
  categoryLabel: string;
  badgeClass: string;
  moduleId: string;
  moduleName: string;
  filePath: string;
  line: number;
  message: string;
  suggestion?: string;
  rule?: string;
}

let currentIssuesFilterCategory = "all";

function collectAllIssues(): IssueItem[] {
  if (!currentResult) return [];
  const list: IssueItem[] = [];

  // 1. 循環インポート
  currentResult.cycles.forEach((cycle, cIdx) => {
    cycle.modules.forEach((modId) => {
      const mod = currentResult!.modules.find((m) => m.id === modId);
      const partners = cycle.modules.filter((m) => m !== modId).map((m) => m.split(".").pop()).join(" ⟷ ");
      list.push({
        id: `cycle-${cIdx}-${modId}`,
        category: "cycles",
        categoryLabel: "循環インポート",
        badgeClass: "badge-danger",
        moduleId: modId,
        moduleName: mod ? mod.name : modId,
        filePath: mod ? mod.absolute_path : "",
        line: 1,
        message: `循環ループ #${cIdx + 1}: [${mod ? mod.name : modId}] ⟷ [${partners}]`,
        suggestion: cycle.suggestion ? `提案: ${cycle.suggestion.source} → ${cycle.suggestion.target} の依存解消` : undefined,
      });
    });
  });

  // 2. アーキテクチャ違反
  (currentResult.architecture_violations || []).forEach((v, idx) => {
    const mod = currentResult!.modules.find((m) => m.id === v.source);
    list.push({
      id: `arch-${idx}`,
      category: "architecture",
      categoryLabel: "アーキテクチャ違反",
      badgeClass: "badge-warning",
      moduleId: v.source,
      moduleName: mod ? mod.name : v.source,
      filePath: mod ? mod.absolute_path : "",
      line: v.line || 1,
      message: `${v.rule}: ${v.message}`,
      suggestion: v.suggestion ? `提案: ${v.suggestion}` : undefined,
      rule: v.rule,
    });
  });

  // 3. 依存宣言の問題
  (currentResult.dependency_issues || []).forEach((issue, idx) => {
    const mod = issue.module ? currentResult!.modules.find((m) => m.id === issue.module) : undefined;
    list.push({
      id: `dep-${idx}`,
      category: "dependencies",
      categoryLabel: "依存宣言の問題",
      badgeClass: "badge-warning",
      moduleId: issue.module || (mod ? mod.id : ""),
      moduleName: mod ? mod.name : issue.package,
      filePath: mod ? mod.absolute_path : "",
      line: 1,
      message: `${issue.rule} ${issue.package}: ${issue.message}`,
      rule: issue.rule,
    });
  });

  // 4. 未使用シンボル候補
  currentResult.modules.forEach((mod) => {
    (mod.unused_symbol_candidates || []).forEach((sym, sIdx) => {
      list.push({
        id: `unused-${mod.id}-${sIdx}`,
        category: "unused",
        categoryLabel: "未使用シンボル",
        badgeClass: "badge-info",
        moduleId: mod.id,
        moduleName: mod.name,
        filePath: mod.absolute_path,
        line: 1,
        message: `未使用候補: ${sym}`,
      });
    });
  });

  // 5. 肥大化警告
  currentResult.modules.filter((m) => m.is_oversized).forEach((mod) => {
    list.push({
      id: `bloat-${mod.id}`,
      category: "bloat",
      categoryLabel: "モジュール肥大化",
      badgeClass: "badge-warning",
      moduleId: mod.id,
      moduleName: mod.name,
      filePath: mod.absolute_path,
      line: 1,
      message: `行数: ${mod.loc} 行 / 関数数: ${mod.function_count} / クラス数: ${mod.class_count}`,
    });
  });

  // 6. 診断エラー
  currentResult.modules.forEach((mod) => {
    (mod.diagnostics || []).forEach((d, dIdx) => {
      list.push({
        id: `diag-${mod.id}-${dIdx}`,
        category: "diagnostics",
        categoryLabel: d.severity === "error" ? "エラー" : "警告",
        badgeClass: d.severity === "error" ? "badge-danger" : "badge-warning",
        moduleId: mod.id,
        moduleName: mod.name,
        filePath: mod.absolute_path,
        line: d.line || 1,
        message: `${d.rule ? `[${d.rule}] ` : ""}${d.message}`,
        rule: d.rule,
      });
    });
  });

  return list;
}



function renderIssuesList() {
  if (!issuesListContainer || !currentResult) return;
  const allIssues = collectAllIssues();

  // カウント更新
  const countAll = document.getElementById("count-all");
  const countCycles = document.getElementById("count-cycles");
  const countArch = document.getElementById("count-arch");
  const countDeps = document.getElementById("count-deps");
  const countUnused = document.getElementById("count-unused");
  const countBloat = document.getElementById("count-bloat");
  const countDiag = document.getElementById("count-diag");

  if (countAll) countAll.innerText = String(allIssues.length);
  if (countCycles) countCycles.innerText = String(allIssues.filter((i) => i.category === "cycles").length);
  if (countArch) countArch.innerText = String(allIssues.filter((i) => i.category === "architecture").length);
  if (countDeps) countDeps.innerText = String(allIssues.filter((i) => i.category === "dependencies").length);
  if (countUnused) countUnused.innerText = String(allIssues.filter((i) => i.category === "unused").length);
  if (countBloat) countBloat.innerText = String(allIssues.filter((i) => i.category === "bloat").length);
  if (countDiag) countDiag.innerText = String(allIssues.filter((i) => i.category === "diagnostics").length);

  // タブのアクティブ更新
  document.querySelectorAll(".issues-category-tabs .btn-filter-tab").forEach((tab) => {
    tab.classList.toggle("active", tab.getAttribute("data-filter") === currentIssuesFilterCategory);
  });

  const query = (issuesSearchFilter?.value || "").toLowerCase().trim();
  const filtered = allIssues.filter((item) => {
    if (currentIssuesFilterCategory !== "all" && item.category !== currentIssuesFilterCategory) return false;
    if (query) {
      const matchMod = item.moduleName.toLowerCase().includes(query) || item.moduleId.toLowerCase().includes(query);
      const matchMsg = item.message.toLowerCase().includes(query);
      const matchSugg = (item.suggestion || "").toLowerCase().includes(query);
      const matchRule = (item.rule || "").toLowerCase().includes(query);
      const matchPath = item.filePath.toLowerCase().includes(query);
      if (!matchMod && !matchMsg && !matchSugg && !matchRule && !matchPath) return false;
    }
    return true;
  });

  if (issuesSummaryText) {
    issuesSummaryText.innerText = `該当件数: ${filtered.length} 件 / 全 ${allIssues.length} 件`;
  }

  if (filtered.length === 0) {
    issuesListContainer.innerHTML = '<p class="placeholder-text" style="margin: 30px 0;">該当する問題はありませんでした</p>';
    return;
  }

  issuesListContainer.innerHTML = filtered.map((item) => `
    <div class="issue-card" data-issue-mod="${escapeHtml(item.moduleId)}">
      <div class="issue-card-header">
        <span class="issue-card-title">
          📄 ${escapeHtml(item.moduleName)}
          ${item.line && item.filePath ? `<span class="issue-card-line-jump" data-jump-file="${escapeHtml(item.filePath)}" data-jump-line="${item.line}" title="クリックしてエディタで開く (行: ${item.line})" style="font-size: 0.72rem; color: var(--accent-color); font-weight: normal; cursor: pointer; text-decoration: underline;">(L:${item.line})</span>` : item.line ? `<span style="font-size: 0.72rem; color: var(--text-muted); font-weight: normal;">(L:${item.line})</span>` : ""}
        </span>
        <span class="issue-card-badge ${item.badgeClass}">${escapeHtml(item.categoryLabel)}</span>
      </div>
      <div class="issue-card-action" style="display: flex; justify-content: space-between; align-items: center;">
        <span>クリックで依存図を表示 ➔</span>
        ${item.category === "cycles" ? `<button class="btn-issue-cycle-resolve btn-primary" style="font-size: 0.72rem; padding: 2px 8px; border-radius: 4px;" data-issue-mod="${escapeHtml(item.moduleId)}">🛠️ Ruffで解消</button>` : ""}
      </div>
    </div>
  `).join("");

  issuesListContainer.querySelectorAll<HTMLElement>(".btn-issue-cycle-resolve").forEach((btn) => {
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      const mId = btn.getAttribute("data-issue-mod");
      const matchedCycle = currentResult?.cycles.find((c) => c.modules.includes(mId || ""));
      void triggerCycleResolveWithRuff(matchedCycle);
    });
  });

  issuesListContainer.querySelectorAll<HTMLElement>(".issue-card-line-jump").forEach((el) => {
    el.addEventListener("click", (e) => {
      e.stopPropagation();
      const file = el.getAttribute("data-jump-file");
      const line = Number(el.getAttribute("data-jump-line")) || 1;
      if (file) {
        void jumpToEditor(file, line);
      }
    });
  });

  issuesListContainer.querySelectorAll<HTMLElement>(".issue-card").forEach((card) => {
    card.addEventListener("click", () => {
      const mId = card.getAttribute("data-issue-mod");
      if (mId) {
        selectWorkspaceTab("modules");
        selectModuleById(mId);
      }
    });
  });
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
          { severity: "warning", message: "型アノテーションが一部不足しています", line: 24, rule: "missing-type-annotation" },
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
    complexity: {
      score: 34,
      imports: 67,
      size: 17,
      code: 20,
      duplication: 0,
      duplicate_lines: 0,
      duplicate_blocks: [],
      hotspots: [
        { module: "app.router", score: 41, cycle: true, mutual_import: true, oversized: false, cyclomatic_complexity: 8, duplicate_lines: 0, imports: 2, imported_by: 1 },
        { module: "app.service", score: 31, cycle: false, mutual_import: false, oversized: true, cyclomatic_complexity: 18, duplicate_lines: 0, imports: 1, imported_by: 1 },
        { module: "app.models", score: 39, cycle: true, mutual_import: true, oversized: false, cyclomatic_complexity: 5, duplicate_lines: 0, imports: 1, imported_by: 2 },
      ],
    },
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


function toggleTreePanel(forceState?: boolean) {
  if (!treePanel) return;
  const isCollapsed = forceState !== undefined ? !forceState : !treePanel.classList.contains("collapsed");
  treePanel.classList.toggle("collapsed", isCollapsed);
  treeResizer.hidden = isCollapsed;
  btnToggleTree.classList.toggle("active", !isCollapsed);
  if (cy) {
    setTimeout(() => cy?.resize(), 200);
  }
}

function toggleInspectorPanel(forceState?: boolean) {
  if (!inspectorPanel) return;
  const isCollapsed = forceState !== undefined ? !forceState : !inspectorPanel.classList.contains("collapsed");
  inspectorPanel.classList.toggle("collapsed", isCollapsed);
  inspectorResizer.hidden = isCollapsed;
  btnToggleInspector?.classList.toggle("active", !isCollapsed);
  if (cy) {
    setTimeout(() => cy?.resize(), 200);
  }
}

function initializePaneResizers() {
  const setup = (kind: "tree" | "inspector", separator: HTMLElement, panel: HTMLElement) => {
    const key = `moduleloom-${kind}-width`;
    const property = kind === "tree" ? "--tree-panel-width" : "--inspector-panel-width";
    const minimum = kind === "tree" ? 140 : 190;
    const updateWidth = (requested: number) => {
      const other = kind === "tree" ? inspectorPanel : treePanel;
      const otherWidth = other.classList.contains("collapsed") || (kind === "tree" && matchMedia("(max-width: 700px)").matches) ? 0 : other.getBoundingClientRect().width;
      const max = Math.max(minimum, moduleView.clientWidth - otherWidth - 280);
      const width = Math.round(Math.min(max, Math.max(minimum, requested)));
      moduleView.style.setProperty(property, `${width}px`);
      separator.setAttribute("aria-valuemin", String(minimum));
      separator.setAttribute("aria-valuemax", String(Math.round(max)));
      separator.setAttribute("aria-valuenow", String(width));
      requestAnimationFrame(() => cy?.resize());
      return width;
    };
    const saved = Number(localStorage.getItem(key));
    if (Number.isFinite(saved) && saved > 0) updateWidth(saved);
    separator.addEventListener("pointerdown", (event) => {
      if (event.button !== 0) return;
      event.preventDefault();
      separator.setPointerCapture(event.pointerId);
      separator.classList.add("dragging");
      document.body.classList.add("resizing-panes");
    });
    separator.addEventListener("pointermove", (event) => {
      if (!separator.hasPointerCapture(event.pointerId)) return;
      const rect = moduleView.getBoundingClientRect();
      updateWidth(kind === "tree" ? event.clientX - rect.left : rect.right - event.clientX);
    });
    const finish = (event: PointerEvent) => {
      if (!separator.hasPointerCapture(event.pointerId)) return;
      separator.releasePointerCapture(event.pointerId);
      separator.classList.remove("dragging");
      document.body.classList.remove("resizing-panes");
      localStorage.setItem(key, String(Math.round(panel.getBoundingClientRect().width)));
    };
    separator.addEventListener("pointerup", finish);
    separator.addEventListener("pointercancel", finish);
    separator.addEventListener("keydown", (event) => {
      if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
      event.preventDefault();
      const direction = event.key === "ArrowRight" ? 1 : -1;
      const next = panel.getBoundingClientRect().width + direction * (kind === "tree" ? 20 : -20);
      localStorage.setItem(key, String(updateWidth(next)));
    });
    window.addEventListener("resize", () => {
      if (moduleView.hidden) return;
      updateWidth(panel.getBoundingClientRect().width);
    });
  };
  setup("tree", treeResizer, treePanel);
  setup("inspector", inspectorResizer, inspectorPanel);
}

// Event Listeners
document.getElementById("btn-git-history")?.addEventListener("click", openGitHistoryModal);
document.querySelectorAll<HTMLInputElement>('input[name="git-change-mode"]').forEach((input) => {
  input.addEventListener("change", () => {
    if (gitCommitRange) gitCommitRange.hidden = input.value !== "commits";
  });
});
document.getElementById("btn-close-git-history")?.addEventListener("click", closeGitHistoryModal);
document.getElementById("btn-cancel-git-history")?.addEventListener("click", closeGitHistoryModal);
document.getElementById("btn-submit-git-history")?.addEventListener("click", () => { void submitGitHistory(); });
gitHistoryModal?.addEventListener("click", (e) => {
  if (e.target === gitHistoryModal) closeGitHistoryModal();
});

document.getElementById("btn-export-report")?.addEventListener("click", () => { void exportAnalysisJson(); });
btnInstallSkill.addEventListener("click", async () => {
  btnInstallSkill.disabled = true;
  skillInstallStatus.hidden = false;
  skillInstallStatus.textContent = translateUiText("コード診断スキルをインストール中...");
  try {
    skillInstallStatus.textContent = await invokeCommand<string>("install_agent_skill");
  } catch (error) {
    skillInstallStatus.textContent = `${translateUiText("スキルのインストールに失敗しました")}: ${String(error)}`;
  } finally {
    btnInstallSkill.disabled = false;
  }
});

// Issues Listeners (Embedded in Complexity Dashboard)
issuesSearchFilter?.addEventListener("input", renderIssuesList);
document.querySelectorAll<HTMLElement>(".issues-category-tabs .btn-filter-tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    currentIssuesFilterCategory = tab.getAttribute("data-filter") || "all";
    renderIssuesList();
  });
});

document.getElementById("btn-history")?.addEventListener("click", showAnalysisHistory);
analysisHistoryBase?.addEventListener("change", renderAnalysisHistoryComparison);
analysisHistoryHead?.addEventListener("change", renderAnalysisHistoryComparison);
document.getElementById("btn-close-analysis-history")?.addEventListener("click", closeAnalysisHistory);
document.getElementById("btn-close-analysis-history-footer")?.addEventListener("click", closeAnalysisHistory);
analysisHistoryModal?.addEventListener("click", (e) => {
  if (e.target === analysisHistoryModal) closeAnalysisHistory();
});
document.getElementById("btn-close-ruff-fix")?.addEventListener("click", closeRuffFixModal);
btnCloseCycleGuide?.addEventListener("click", closeCycleGuideModal);
btnCloseCycleGuideFooter?.addEventListener("click", closeCycleGuideModal);
cycleGuideModal?.addEventListener("click", (e) => {
  if (e.target === cycleGuideModal) closeCycleGuideModal();
});
btnApplyRuffFix.addEventListener("click", () => { void applyRuffCycleFix(); });
fixToolSelect.addEventListener("change", () => {
  if (currentResult) localStorage.setItem(`moduleloom-fix-tool:${currentResult.root_path}`, fixToolSelect.value);
  if (selectedModule) renderInspector(selectedModule);
});
document.getElementById("btn-find-chain")?.addEventListener("click", findAndHighlightChain);
document.getElementById("btn-back")?.addEventListener("click", goBack);
btnShowOverview?.addEventListener("click", toggleOverviewOrFileView);
btnAnalyze.addEventListener("click", () => { void runAnalysis(); });
btnQuality.addEventListener("click", () => { void runAnalysis(true); });
searchInput.addEventListener("input", applyFilters);
searchInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    const initialSearch = searchInput.value.trim();
    if (initialSearch) {
      selectWorkspaceTab("diagnostics");
      if (issuesSearchFilter) {
        issuesSearchFilter.value = initialSearch;
      }
      renderIssuesList();
    }
  }
});
chkOnlyCycles.addEventListener("change", applyFilters);
chkOnlyBloat.addEventListener("change", applyFilters);
graphRadius.addEventListener("change", applyFilters);
clusterLimit.addEventListener("change", () => { if (currentResult) updateGraph(currentResult); });
chkExternals.addEventListener("change", () => { if (currentResult) updateGraph(currentResult); });
chkGroupPackages.addEventListener("change", () => {
  if (currentResult) updateGraph(currentResult);
});
layoutSelect.addEventListener("change", runLayout);
function toggleFlowDirection() {
  flowDirection = flowDirection === "LR" ? "TB" : "LR";
  localStorage.setItem("flow_direction", flowDirection);
  updateFlowDirectionButton();
  if (currentViewMode === "file") applyFilters();
  else {
    layoutSelect.value = "dagre";
    runLayout();
  }
}
btnFlowDirection?.addEventListener("click", toggleFlowDirection);
btnFloatFlowDirection?.addEventListener("click", toggleFlowDirection);
btnFit?.addEventListener("click", zoomFit);

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

document.getElementById("btn-close-callgraph")?.addEventListener("click", closeCallGraph);
document.getElementById("btn-close-callgraph-footer")?.addEventListener("click", closeCallGraph);
callGraphModal?.addEventListener("click", (e) => {
  if (e.target === callGraphModal) closeCallGraph();
});
window.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    if (analysisHistoryModal && !analysisHistoryModal.classList.contains("hidden")) closeAnalysisHistory();
    if (gitHistoryModal && !gitHistoryModal.classList.contains("hidden")) closeGitHistoryModal();
    if (callGraphModal && !callGraphModal.classList.contains("hidden")) closeCallGraph();
    if (manualSettingsModal && !manualSettingsModal.classList.contains("hidden")) closeManualSettingsModal();
  }
});

editorSelect?.addEventListener("change", () => {
  localStorage.setItem("preferred_editor", editorSelect.value);
  if (selectedModule) renderInspector(selectedModule);
});

// Tree & Inspector Panel Controls
btnToggleTree?.addEventListener("click", () => toggleTreePanel());
btnToggleInspector?.addEventListener("click", () => toggleInspectorPanel());
treeSearchInput?.addEventListener("input", filterTree);

document.getElementById("btn-close-inspector")?.addEventListener("click", () => {
  toggleInspectorPanel(false);
});

btnResolveCycles?.addEventListener("click", () => {
  void triggerCycleResolveWithRuff();
});

// Load preferences
const savedEditor = localStorage.getItem("preferred_editor");
if (editorSelect && savedEditor && (savedEditor === "pycharm" || savedEditor === "vscode")) {
  editorSelect.value = savedEditor;
}

// Initialize
uiLanguage.value = initUiLocale();
function syncHostUiLocale(locale: UiLocale) {
  if (hostEditor === "pycharm" && typeof (window as any).__MODULELOOM_INVOKE__ === "function") {
    void invokeCommand("set_ui_locale", { locale }).catch((error) => console.warn("UI locale sync failed", error));
  }
}
uiLanguage.addEventListener("change", () => {
  const locale: UiLocale = uiLanguage.value === "en" ? "en" : "ja";
  setUiLocale(locale);
  syncHostUiLocale(locale);
  if (currentResult) updateGraph(currentResult);
});
syncHostUiLocale(uiLanguage.value === "en" ? "en" : "ja");
updateFlowDirectionButton();
initGraph();
initializePaneResizers();
void initFileWatcherEvents();
void detectEditors();
async function initializeProjectPath() {
  let launchPath = "";
  if ((window as any).__TAURI_INTERNALS__) {
    try {
      launchPath = await invokeCommand<string | null>("initial_project_path") || "";
    } catch (error) {
      console.warn("Could not read the initial project path", error);
    }
  }
  pathInput.value = (window as any).__MODULELOOM_PROJECT_PATH__ || launchPath || localStorage.getItem("project_path") || "";
  if (pathInput.value) void runAnalysis();
  else statusBar.innerText = "Python プロジェクトのパスを入力して解析を実行してください";
}
void initializeProjectPath();
