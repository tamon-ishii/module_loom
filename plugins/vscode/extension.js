const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');

let panel;
let currentFolder;
let fileWatchers = [];
let refreshTimer;
let analysisRunning = false;
let analysisPending = false;
let manualAnalysisPending = false;
let lastResult;
const pendingChangedFiles = new Set();

function watchFolder(folder) {
  fileWatchers.forEach(watcher => watcher.dispose());
  fileWatchers = ['**'].map(pattern => {
    const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, pattern));
    const refresh = (uri, eventKind) => {
      if (!panel) return;
      const relative = path.relative(folder.uri.fsPath, uri.fsPath);
      if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return;
      const parts = relative.split(path.sep);
      if (parts.some(part => part.startsWith('.') || ['__pycache__', 'venv', 'node_modules', 'target'].includes(part))) return;
      let folderCreated = false;
      if (eventKind === 'create') {
        try { folderCreated = fs.statSync(uri.fsPath).isDirectory(); } catch (_) {}
      }
      const structural = eventKind === 'delete' || folderCreated;
      if (!relative.endsWith('.py') && relative !== 'moduleloom.toml' && !structural) return;
      pendingChangedFiles.add(uri.fsPath);
      clearTimeout(refreshTimer);
      refreshTimer = setTimeout(() => {
        const changed = [...pendingChangedFiles];
        pendingChangedFiles.clear();
        runAnalysis(currentFolder, panel.webview, changed);
      }, 500);
    };
    watcher.onDidChange(uri => refresh(uri, 'change'));
    watcher.onDidCreate(uri => refresh(uri, 'create'));
    watcher.onDidDelete(uri => refresh(uri, 'delete'));
    return watcher;
  });
}

function getWorkspaceFolder(uri) {
  if (uri && uri.scheme === 'file') {
    return vscode.workspace.getWorkspaceFolder(uri);
  }
  const active = vscode.window.activeTextEditor?.document.uri;
  return (active && vscode.workspace.getWorkspaceFolder(active)) || vscode.workspace.workspaceFolders?.[0];
}

function analyzerExecutable(folder) {
  const configured = vscode.workspace.getConfiguration('moduleloom', folder.uri).get('analyzerPath').trim();
  if (configured) return configured;
  const arch = process.arch === 'arm64' ? 'arm64' : 'x64';
  const platform = process.platform === 'win32' ? 'windows' : process.platform === 'darwin' ? 'macos' : 'linux';
  const executable = process.platform === 'win32' ? 'analyze.exe' : 'analyze';
  const bundled = path.join(__dirname, 'bin', `${platform}-${arch}`, executable);
  if (fs.existsSync(bundled)) {
    const hash = crypto.createHash('sha256').update(fs.readFileSync(bundled)).digest('hex').slice(0, 16);
    const directory = path.join(os.homedir(), '.cache', 'moduleloom', 'bin', `${platform}-${arch}`, hash);
    const installed = path.join(directory, executable);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(installed)) fs.copyFileSync(bundled, installed);
    if (process.platform !== 'win32') fs.chmodSync(installed, 0o755);
    return installed;
  }
  const local = path.join(folder.uri.fsPath, 'target', 'release', process.platform === 'win32' ? 'analyze.exe' : 'analyze');
  return fs.existsSync(local) ? local : 'analyze';
}

function runAnalysis(folder, webview, changedFiles = null) {
  if (analysisRunning) {
    analysisPending = true;
    if (changedFiles === null) manualAnalysisPending = true;
    else changedFiles.forEach(file => pendingChangedFiles.add(file));
    return;
  }
  const incremental = changedFiles?.length && lastResult?.root_path === folder.uri.fsPath;
  analysisRunning = true;
  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    analysisRunning = false;
    if (analysisPending && panel) {
      analysisPending = false;
      const nextChanges = manualAnalysisPending ? null : [...pendingChangedFiles];
      manualAnalysisPending = false;
      pendingChangedFiles.clear();
      runAnalysis(currentFolder, panel.webview, nextChanges);
    }
  };
  let child;
  try {
    child = spawn(analyzerExecutable(folder), ['--json', ...(incremental ? ['--incremental'] : []), folder.uri.fsPath], { cwd: folder.uri.fsPath });
  } catch (error) {
    webview.postMessage({ type: 'error', message: `解析を開始できません: ${error.message}` });
    finish();
    return;
  }
  child.stdin.on('error', () => {});
  child.stdin.end(incremental ? JSON.stringify({ previous: lastResult, changed_files: changedFiles }) : undefined);
  const chunks = [];
  let errors = '';
  child.stdout.on('data', data => chunks.push(data));
  child.stderr.on('data', data => { errors += data.toString(); });
  child.on('error', error => {
    webview.postMessage({ type: 'error', message: `解析を開始できません: ${error.message}` });
    finish();
  });
  child.on('close', code => {
    if (finished) return;
    if (code !== 0) {
      if (incremental && panel && panel.webview === webview) {
        analysisPending = true;
        manualAnalysisPending = true;
        finish();
        return;
      }
      webview.postMessage({ type: 'error', message: `解析に失敗しました (${code}): ${errors.trim()}` });
      finish();
      return;
    }
    try {
      if (panel && panel.webview === webview && folder.uri.fsPath === currentFolder.uri.fsPath) {
        const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
        lastResult = result;
        webview.postMessage({ type: 'result', result });
      }
    } catch (error) {
      webview.postMessage({ type: 'error', message: `解析結果を読み込めません: ${error.message}` });
    }
    finish();
  });
}

async function openFile(folder, filePath, line) {
  if (typeof filePath !== 'string') return;
  const root = path.resolve(folder.uri.fsPath);
  const target = path.resolve(filePath);
  if (target !== root && !target.startsWith(root + path.sep)) return;
  try {
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(target));
    const editor = await vscode.window.showTextDocument(document, { preview: false });
    const position = new vscode.Position(Math.max(0, Number(line || 1) - 1), 0);
    editor.selection = new vscode.Selection(position, position);
    editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
  } catch (error) {
    vscode.window.showErrorMessage(`ModuleLoom: ${error.message}`);
  }
}

function makeHtml(context, webview) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  let html = fs.readFileSync(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
  for (const name of ['cytoscape.min.js', 'cytoscape-dagre.min.js', 'cycle-insights.js']) {
    const uri = webview.asWebviewUri(vscode.Uri.joinPath(media, name));
    html = html.replace(`src="${name}"`, `src="${uri}"`);
  }
  const bridge = `<script>\n` +
    `const vscodeApi = acquireVsCodeApi();\n` +
    `window.cefQuery = ({request}) => vscodeApi.postMessage(JSON.parse(request));\n` +
    `window.addEventListener('message', event => {\n` +
    `  const message = event.data;\n` +
    `  if (message.type === 'result') window.renderModuleGraph(message.result);\n` +
    `  if (message.type === 'error') document.getElementById('status-info').textContent = message.message;\n` +
    `});\n</script>`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src 'unsafe-inline'; script-src 'unsafe-inline' ${webview.cspSource};">`;
  html = html.replace('</head>', `${csp}</head>`);
  html = html.replace('<script>\n    if (window.cytoscapeDagre)', `${bridge}\n  <script>\n    if (window.cytoscapeDagre)`);
  return html.replaceAll('PyCharm', 'VS Code');
}

function activate(context) {
  context.subscriptions.push(vscode.commands.registerCommand('moduleloom.openGraph', uri => {
    const folder = getWorkspaceFolder(uri);
    if (!folder) {
      vscode.window.showErrorMessage('ModuleLoom: ワークスペースを開いてください');
      return;
    }
    if (!currentFolder || currentFolder.uri.fsPath !== folder.uri.fsPath || !panel) {
      watchFolder(folder);
      lastResult = undefined;
      pendingChangedFiles.clear();
    }
    currentFolder = folder;
    if (panel) {
      panel.reveal();
      runAnalysis(folder, panel.webview);
      return;
    }
    panel = vscode.window.createWebviewPanel('moduleloom.graph', 'ModuleLoom', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      retainContextWhenHidden: true
    });
    panel.webview.html = makeHtml(context, panel.webview);
    panel.webview.onDidReceiveMessage(message => {
      if (message.type === 'analyze') runAnalysis(currentFolder, panel.webview);
      if (message.type === 'open_file') openFile(currentFolder, message.path, message.line);
    }, null, context.subscriptions);
    panel.onDidDispose(() => {
      panel = undefined;
      clearTimeout(refreshTimer);
      fileWatchers.forEach(watcher => watcher.dispose());
      fileWatchers = [];
      lastResult = undefined;
      pendingChangedFiles.clear();
    }, null, context.subscriptions);
  }));
}

function deactivate() {}

module.exports = { activate, deactivate };
