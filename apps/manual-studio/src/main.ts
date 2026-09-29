import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import "./style.css";

type CaptureSource = { kind: "window"; title: string; inset: number } | { kind: "scenario"; input: string };
interface Task { id: string; kind: string; page: string; prompt: string; status: string }
interface UIMap { total_elements: number; views: Array<{ id: string; name: string; observed_from?: string; elements: Array<{ name: string; role: string; selector: string }> }> }
interface State {
  config: { docs: string; output: string; agent: string; model: string; mkdocs: { site_name: string; theme: string; language: string; use_directory_urls: boolean } };
  brief: string; pages: string[]; tasks: Task[]; image_assets: Record<string, string>;
  capture_sources: Record<string, CaptureSource>; ui_map: UIMap | null;
  agents: Array<{ id: string; label: string; available: boolean }>;
}
interface Document { page: string; content: string; revision: string }
interface NativeWindow { id: string; title: string; width: number; height: number }

const element = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const input = (id: string): HTMLInputElement => element(id);
const editor = element<HTMLTextAreaElement>("markdown-editor");
const native = "__TAURI_INTERNALS__" in window;
const params = new URLSearchParams(location.search);
const detached = params.get("editor") === "1";
let projectRoot = "";
let workspace: State | null = null;
let documentState: Document | null = null;
let dirty = false;
let busy = false;
let previewVersion = 0;
let previewTimer: ReturnType<typeof setTimeout>;
if (detached) document.body.classList.add("detached");

function escape(value: unknown): string {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]!));
}
function status(message: string, error = false): void {
  element("status").textContent = message;
  element("status").classList.toggle("error", error);
}
async function rpc(action: string, options: Record<string, unknown> = {}, root = projectRoot): Promise<string> {
  if (!root) throw new Error("先にプロジェクトのフォルダーを開いてください。");
  const request = { root, action, options };
  if (native) return invoke<string>("manual_request", { request });
  const response = await fetch("/__manual/rpc", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(request) });
  const result = await response.json() as { output?: string; error?: string };
  if (!response.ok) throw new Error(result.error || "処理に失敗しました。");
  return result.output || "";
}
function setBusy(value: boolean): void {
  busy = value;
  document.body.setAttribute("aria-busy", String(value));
  document.querySelectorAll<HTMLButtonElement>("button").forEach((button) => { button.disabled = value; });
  editor.readOnly = value;
  editor.disabled = !documentState;
}
function savedBeforeOperation(): void {
  if (dirty) throw new Error("原稿に未保存の変更があります。「保存」を押してから実行してください。");
}
async function work(operation: () => Promise<void>): Promise<void> {
  if (busy) return;
  setBusy(true);
  try { await operation(); } catch (error) { status(String(error), true); }
  finally { setBusy(false); }
}
function confirmDiscard(): boolean {
  return !dirty || window.confirm("未保存の編集を破棄して移動しますか？ 編集を残す場合はキャンセルして保存してください。");
}
function chooseTab(name: string): void {
  document.querySelectorAll<HTMLElement>(".panel").forEach((panel) => { panel.hidden = panel.id !== `panel-${name}`; });
  document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => { button.classList.toggle("active", button.dataset.tab === name); });
}
function updateSaveState(): void {
  element("save-state").textContent = documentState ? dirty ? "● 未保存の変更" : "保存済み" : "原稿を選択してください";
}
async function renderPreview(): Promise<void> {
  if (!documentState) return;
  const version = ++previewVersion;
  try {
    const html = await rpc("editor-preview", { page: documentState.page, body: editor.value });
    if (version === previewVersion) element<HTMLIFrameElement>("markdown-preview").srcdoc = html;
  } catch (error) { if (version === previewVersion) status(`プレビュー: ${String(error)}`, true); }
}
function updateCursor(): void {
  const lines = editor.value.slice(0, editor.selectionStart).split("\n");
  element("cursor-position").textContent = `${lines.length}:${lines.at(-1)!.length + 1}`;
}
async function openPage(page: string, check = true): Promise<void> {
  if (check && !confirmDiscard()) return;
  const opened = JSON.parse(await rpc("editor-read", { page })) as Document;
  ++previewVersion;
  documentState = opened;
  editor.value = opened.content;
  editor.disabled = false;
  dirty = false;
  element("editor-title").textContent = page;
  document.title = `${page} — Manual Studio`;
  updateSaveState(); updateCursor(); renderPages();
  await renderPreview();
  chooseTab("editor");
}
function renderPages(): void {
  const pages = workspace?.pages || [];
  element("page-list").innerHTML = pages.length ? pages.map((page) => `<button data-page="${escape(page)}" class="${documentState?.page === page ? "selected" : ""}">${escape(page)}</button>`).join("") : '<p class="muted">「＋」からMarkdownページを作れます。</p>';
}
async function refreshWorkspace(reloadPage = false): Promise<void> {
  workspace = JSON.parse(await rpc("state")) as State;
  renderPages(); renderTasks(); renderMap();
  element("task-count").textContent = String(workspace.tasks.length);
  const previousTask = element<HTMLSelectElement>("scenario-task").value;
  element("scenario-task").innerHTML = workspace.tasks.filter((task) => task.kind === "screenshot").map((task) => `<option value="${escape(task.id)}">${escape(task.id)} — ${escape(task.page)}</option>`).join("");
  if (workspace.tasks.some((task) => task.id === previousTask)) element<HTMLSelectElement>("scenario-task").value = previousTask;
  if (reloadPage && documentState) {
    const opened = JSON.parse(await rpc("editor-read", { page: documentState.page })) as Document;
    documentState = opened; editor.value = opened.content; dirty = false; updateSaveState(); await renderPreview();
  }
}
function renderSettings(): void {
  if (!workspace) return;
  input("docs-path").value = workspace.config.docs;
  input("output-path").value = workspace.config.output;
  input("site-name").value = workspace.config.mkdocs.site_name;
  input("ai-model").value = workspace.config.model;
  element<HTMLTextAreaElement>("manual-brief").value = workspace.brief;
  element("ai-agent").innerHTML = workspace.agents.map((agent) => `<option value="${escape(agent.id)}">${escape(agent.label)}${agent.available ? "" : "（CLI未検出）"}</option>`).join("");
  element<HTMLSelectElement>("ai-agent").value = workspace.config.agent;
}
async function openProject(root: string): Promise<void> {
  if (!confirmDiscard()) return;
  status("プロジェクトを開いています…");
  const loaded = JSON.parse(await rpc("state", {}, root)) as State;
  projectRoot = root; workspace = loaded; documentState = null; dirty = false;
  input("project-root").value = root;
  localStorage.setItem("manual-studio-project", root);
  element("project-label").textContent = root;
  await refreshWorkspace(); renderSettings();
  const preferred = params.get("page");
  const page = preferred && loaded.pages.includes(preferred) ? preferred : loaded.pages[0];
  if (page) await openPage(page, false);
  else { editor.value = ""; updateSaveState(); status("「＋」から最初のMarkdownページを作ってください。"); }
  if (page) status(`プロジェクトを開きました。${page}を編集できます。`);
}
async function saveDocument(): Promise<void> {
  if (!documentState) throw new Error("保存する原稿を選択してください。");
  const page = documentState.page;
  const content = editor.value;
  const saved = JSON.parse(await rpc("editor-save", { page, json: { content, revision: documentState.revision } })) as Document;
  documentState = saved; dirty = editor.value !== content; updateSaveState();
  await refreshWorkspace();
  status(`${page}を保存しました。`);
}
function renderTasks(): void {
  if (!workspace) return;
  const kindLabel: Record<string, string> = { screenshot: "画像", text: "AI文章", diagram: "依存図" };
  const statusLabel: Record<string, string> = { missing: "未作成", stale: "更新待ち", current: "準備完了", approved: "承認済み" };
  element("task-list").innerHTML = workspace.tasks.length ? workspace.tasks.map((task) => {
    const source = workspace!.capture_sources[task.id];
    const description = source?.kind === "window" ? `${escape(source.title)} · 外枠 ${source.inset}px` : source?.kind === "scenario" ? `操作手順: ${escape(source.input)}` : "撮影元はまだ設定されていません。";
    return `<article class="card" data-task="${escape(task.id)}"><div class="task-header"><h2>${escape(task.id)} <small>${escape(task.page)}</small></h2><span class="badge">${kindLabel[task.kind]} · ${statusLabel[task.status] || escape(task.status)}</span></div><p>${escape(task.prompt)}</p>${task.kind === "screenshot" ? `
      <p class="muted">${description}</p><img class="task-image" data-thumb="${escape(task.id)}" alt="${escape(task.id)}の登録画像" hidden />
      <div class="actions">${source ? `<button class="primary" data-recapture="${escape(task.id)}">${source.kind === "scenario" ? "保存した手順で更新" : "同じ撮影元で更新"}</button>` : ""}<button data-source-config="${escape(task.id)}">${source ? "撮影元を変更" : "撮影元を選ぶ"}</button><button data-register-image="${escape(task.id)}">既存のPNGを登録</button></div>
      <details class="capture-settings"><summary>撮影元の設定</summary><p class="muted">アプリの対象画面を開いて一覧を更新してください。タイトルで記憶するので、アプリを再起動しても使えます。同じタイトルが複数ある場合は自動で選びません。Waylandでは毎回OSの撮影ダイアログで対象を選びます。</p><div class="actions"><select data-window-select="${escape(task.id)}"><option value="">一覧を更新してください</option></select><button data-window-list="${escape(task.id)}">一覧を更新</button></div><div class="actions"><label>外枠を除く（px）<input type="number" min="0" max="64" data-inset="${escape(task.id)}" value="${source?.kind === "window" ? source.inset : 0}" /></label><button data-capture="${escape(task.id)}" class="primary">撮影元を保存して撮影</button></div><label>操作シナリオを使う場合<input data-scenario="${escape(task.id)}" placeholder="manual/scenarios/capture.json" value="${source?.kind === "scenario" ? escape(source.input) : ""}" /></label><button data-bind-scenario="${escape(task.id)}">この画像の撮影手順として保存</button></details>` : `<div class="actions"><button data-generate="${escape(task.id)}" class="primary">${task.kind === "diagram" ? "依存図を更新" : "AIで文章を更新"}</button></div>`}<button class="edit-task" data-edit-page="${escape(task.page)}">この指示を原稿で編集</button></article>`;
  }).join("") : '<div class="card"><h2>更新する画像・文章・図を追加する</h2><p>原稿の編集画面で「撮影の指示」「AI文章の指示」「依存図の指示」を追加して保存してください。この一覧に表示されます。</p></div>';
  const generationRoot = projectRoot;
  for (const task of workspace.tasks.filter((item) => item.kind === "screenshot")) {
    void rpc("preview-asset", { page: task.page, asset: workspace.image_assets[task.id] || `assets/${task.id}.png` }).then((src) => {
      if (generationRoot !== projectRoot) return;
      const img = document.querySelector<HTMLImageElement>(`[data-thumb="${CSS.escape(task.id)}"]`);
      if (img) { img.src = src; img.hidden = false; }
    }).catch(() => { /* An unregistered screenshot has no image yet. */ });
  }
}
function renderMap(): void {
  const map = workspace?.ui_map;
  element("uimap-list").innerHTML = map?.views.length ? `<p><strong>${map.views.length}画面・${map.total_elements}要素</strong>を登録しています。画面名を開いて内容を確認してください。コード変更後は一覧を作り直します。</p>` + map.views.map((view) => `<details class="card"><summary>${escape(view.name)}（${view.elements.length}要素）</summary><p class="muted">確認元: ${escape(view.observed_from || "プロジェクトの画面定義")}</p><ul>${view.elements.map((item) => `<li>${escape(item.name)} <small>${escape(item.role)}</small> <code>${escape(item.selector)}</code></li>`).join("")}</ul></details>`).join("") : '<div class="card"><h2>画面一覧はまだありません</h2><p>「コードから画面一覧を作る」を押してください。検出された内容をここで確認できます。</p></div>';
}
async function runAction(action: string, options: Record<string, unknown> = {}, resultId?: string): Promise<void> {
  savedBeforeOperation();
  status("処理中…");
  const output = await rpc(action, options);
  if (resultId) {
    let text = output;
    try { text = JSON.stringify(JSON.parse(output), null, 2); } catch { /* Accessibility inspection returns text. */ }
    element(resultId).textContent = text;
  }
  await refreshWorkspace(true);
  status(`${action === "recapture" || action === "capture-window" ? "画像を更新し、撮影元を保存しました" : "処理が完了しました"}。`);
}
function taskControl<T extends HTMLElement>(card: HTMLElement, attribute: string): T {
  return card.querySelector<T>(`[${attribute}]`)!;
}
document.querySelectorAll<HTMLElement>("[data-tab]").forEach((button) => button.addEventListener("click", () => chooseTab(button.dataset.tab!)));
element("project-form").addEventListener("submit", (event) => { event.preventDefault(); void work(() => openProject(input("project-root").value.trim())); });
element("browse-project").addEventListener("click", () => { void work(async () => {
  if (!native) { status("ブラウザーでの開発表示では、プロジェクトのパスを入力して「開く」を押してください。"); input("project-root").focus(); return; }
  const path = await invoke<string | null>("choose_project");
  if (path) await openProject(path);
}); });
element("page-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-page]");
  if (button) void work(() => openPage(button.dataset.page!));
});
element("save-page").addEventListener("click", () => { void work(saveDocument); });
element("reload-page").addEventListener("click", () => { if (documentState) void work(() => openPage(documentState!.page)); });
element("detach-editor").addEventListener("click", () => { void work(async () => {
  savedBeforeOperation();
  if (!documentState) throw new Error("原稿を選択してください。");
  if (native) await invoke("open_editor", { root: projectRoot, page: documentState.page });
  else window.open(`/?editor=1&root=${encodeURIComponent(projectRoot)}&page=${encodeURIComponent(documentState.page)}`, "_blank");
}); });
editor.addEventListener("input", () => {
  dirty = editor.value !== documentState?.content; updateSaveState(); updateCursor();
  clearTimeout(previewTimer); previewTimer = setTimeout(() => { void renderPreview(); }, 250);
});
editor.addEventListener("click", updateCursor); editor.addEventListener("keyup", updateCursor);
editor.addEventListener("keydown", (event) => {
  if (event.key === "Tab") { event.preventDefault(); editor.setRangeText("  ", editor.selectionStart, editor.selectionEnd, "end"); editor.dispatchEvent(new Event("input")); }
});
document.addEventListener("keydown", (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") { event.preventDefault(); void work(saveDocument); }
});
window.addEventListener("beforeunload", (event) => { if (dirty) { event.preventDefault(); event.returnValue = ""; } });
if (native) void getCurrentWindow().onCloseRequested((event) => { if (!confirmDiscard()) event.preventDefault(); });
document.querySelectorAll<HTMLElement>("[data-insert]").forEach((button) => button.addEventListener("click", () => {
  if (!documentState) { status("先に原稿を開いてください。", true); return; }
  const kind = button.dataset.insert!;
  const stem = documentState.page.replace(/\.md$/, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  const prefix = `task-${stem}-${kind}`;
  let suffix = 1;
  while (editor.value.includes(`id=${prefix}-${suffix}`) || workspace?.tasks.some((task) => task.id === `${prefix}-${suffix}`)) suffix++;
  const prompt = kind === "screenshot" ? "対象アプリの画面と、表示する操作要素を指定してください。" : kind === "diagram" ? "Pythonモジュール間の依存関係を図にしてください。" : "対象読者と説明する操作手順を指定してください。";
  editor.setRangeText(`\n\n<!-- ai:task id=${prefix}-${suffix} kind=${kind}\n${prompt}\n-->\n`, editor.selectionStart, editor.selectionEnd, "end");
  editor.dispatchEvent(new Event("input")); editor.focus();
}));
element("new-page").addEventListener("click", () => {
  if (!projectRoot) { status("先にプロジェクトを開いてください。", true); return; }
  element<HTMLDialogElement>("new-page-dialog").showModal(); input("new-page-path").focus();
});
element("cancel-new-page").addEventListener("click", () => element<HTMLDialogElement>("new-page-dialog").close());
element("new-page-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void work(async () => {
    if (!confirmDiscard()) return;
    const page = input("new-page-path").value.trim();
    await rpc("editor-save", { page, json: { content: `# ${input("new-page-title").value.trim()}\n\n`, revision: null } });
    element<HTMLDialogElement>("new-page-dialog").close();
    dirty = false; await refreshWorkspace(); await openPage(page, false); status(`${page}を作成しました。`);
  });
});
element("refresh-tasks").addEventListener("click", () => { void work(async () => { savedBeforeOperation(); await refreshWorkspace(true); status("画像・文章・図の一覧を更新しました。"); }); });
element("task-list").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  const card = button?.closest<HTMLElement>("[data-task]");
  if (!button || !card) return;
  const id = card.dataset.task!;
  void work(async () => {
    if (button.dataset.editPage) { await openPage(button.dataset.editPage); return; }
    if (button.dataset.sourceConfig || button.dataset.windowList) {
      card.querySelector<HTMLDetailsElement>("details")!.open = true;
      const windows = JSON.parse(await rpc("list-windows")) as NativeWindow[];
      const select = taskControl<HTMLSelectElement>(card, "data-window-select");
      select.innerHTML = '<option value="">撮影するウィンドウを選ぶ</option>' + windows.map((item) => `<option value="${escape(item.id)}">${escape(item.title)}（${item.width}×${item.height}）</option>`).join("");
      const source = workspace!.capture_sources[id];
      const matches = source?.kind === "window" ? windows.filter((item) => item.title === source.title) : [];
      if (matches.length === 1) select.value = matches[0].id;
      return;
    }
    if (button.dataset.recapture) { await runAction("recapture", { id }); return; }
    if (button.dataset.capture) {
      const windowId = taskControl<HTMLSelectElement>(card, "data-window-select").value;
      if (!windowId) throw new Error("一覧から撮影するウィンドウを選んでください。");
      await runAction("capture-window", { id, window: windowId, inset: taskControl<HTMLInputElement>(card, "data-inset").value }); return;
    }
    if (button.dataset.bindScenario) { await runAction("capture-source-save", { id, input: taskControl<HTMLInputElement>(card, "data-scenario").value.trim() }); return; }
    if (button.dataset.generate) { await runAction("generate-task", { id }); return; }
    if (button.dataset.registerImage) {
      if (!native) throw new Error("PNGのファイル選択はデスクトップアプリで利用できます。");
      const image = await invoke<string | null>("choose_image");
      if (image) await runAction("record-screenshot", { id, image });
    }
  });
});
function actionButton(id: string, action: string, options: () => Record<string, unknown> = () => ({}), result?: string): void {
  element(id).addEventListener("click", () => { void work(() => runAction(action, options(), result)); });
}
actionButton("map-refresh", "ui-map", () => ({ refresh: true }));
actionButton("explore-web", "ui-explore", () => ({ url: input("explore-url").value.trim(), max_pages: "10" }));
actionButton("import-map", "ui-map-import", () => ({ input: input("observation-path").value.trim() }));
element("accessible-list").addEventListener("click", () => { void work(async () => {
  const windows = JSON.parse(await rpc("list-accessible-windows")) as Array<{ id: string; query: string; title: string; app: string }>;
  element("accessible-window").innerHTML = windows.map((item) => `<option value="${escape(item.id)}" data-query="${escape(item.query)}">${escape(item.title)} — ${escape(item.app)}</option>`).join("") || '<option value="">ウィンドウが見つかりません</option>';
  status("デスクトップのウィンドウ一覧を取得しました。");
}); });
actionButton("inspect-window", "inspect-window", () => ({ window: element<HTMLSelectElement>("accessible-window").value }), "scenario-result");
function scenarioTemplate(platform: "web" | "desktop"): void {
  const id = element<HTMLSelectElement>("scenario-task").value;
  if (!id) { status("原稿に撮影の指示を追加して保存してください。", true); return; }
  let scenario: Record<string, unknown>;
  if (platform === "web") {
    const url = input("scenario-url").value.trim();
    if (!url) { status("WebアプリのURLを入力してください。", true); return; }
    scenario = { version: 1, platform, base_url: url, steps: [{ goto: "/" }, { screenshot: { task: id } }] };
  } else {
    const query = element<HTMLSelectElement>("accessible-window").selectedOptions[0]?.dataset.query;
    if (!query) { status("ウィンドウ一覧から対象を選んでください。", true); return; }
    scenario = { version: 1, platform, window: query, steps: [{ screenshot: { task: id } }] };
  }
  element<HTMLTextAreaElement>("scenario-json").value = JSON.stringify(scenario, null, 2);
  status("ひな形を作りました。必要な操作を追加して保存してください。");
}
element("web-template").addEventListener("click", () => scenarioTemplate("web"));
element("desktop-template").addEventListener("click", () => scenarioTemplate("desktop"));
const scenarioInput = () => ({ input: input("scenario-path").value.trim() });
element("scenario-load").addEventListener("click", () => { void work(async () => { element<HTMLTextAreaElement>("scenario-json").value = await rpc("scenario-load", scenarioInput()); status("シナリオを読み込みました。"); }); });
actionButton("scenario-save", "scenario-save", () => ({ ...scenarioInput(), json: element<HTMLTextAreaElement>("scenario-json").value }), "scenario-result");
actionButton("scenario-test", "scenario-test", scenarioInput, "scenario-result");
actionButton("scenario-run", "scenario-run", scenarioInput, "scenario-result");
actionButton("scenario-bind", "capture-source-save", () => ({ ...scenarioInput(), id: element<HTMLSelectElement>("scenario-task").value }), "scenario-result");
element("save-settings").addEventListener("click", () => { void work(async () => {
  await runAction("save", { docs: input("docs-path").value.trim(), output: input("output-path").value.trim(), agent: element<HTMLSelectElement>("ai-agent").value, model: input("ai-model").value.trim(), brief: element<HTMLTextAreaElement>("manual-brief").value, mkdocs_settings: { ...workspace!.config.mkdocs, site_name: input("site-name").value.trim() } });
  renderSettings();
}); });
element("generate-draft").addEventListener("click", () => { void work(async () => {
  savedBeforeOperation();
  if (workspace?.pages.length && !window.confirm("現在の原稿をバックアップして、AIの下書きに置き換えますか？")) return;
  await runAction("draft", {}, "publish-result");
}); });
actionButton("build-draft", "build", () => ({ draft: true }), "publish-result");
actionButton("build-final", "build", () => ({}), "publish-result");
actionButton("impact-plan", "impact-plan", () => ({ git_ref: input("git-ref").value.trim() || "HEAD" }), "publish-result");
actionButton("fact-check", "fact-check", () => ({ check: true }), "publish-result");
element("open-output").addEventListener("click", () => { void work(async () => {
  if (native) await invoke("open_output", { root: projectRoot });
  else status(`出力フォルダー: ${projectRoot}/${workspace?.config.output || "manual"}`);
}); });
setBusy(false);
const initialRoot = params.get("root") || localStorage.getItem("manual-studio-project");
if (initialRoot) void work(() => openProject(initialRoot));
