const vscode = require('vscode');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { execFile } = require('child_process');

let panel;
let currentFolder;
let fileWatchers = [];
let refreshTimer;
let analysisRunning = false;
let analysisPending = false;
let manualAnalysisPending = false;
let lastResult;
const pendingChangedFiles = new Set();
let pendingFix;

function runFile(command, args, options = {}) {
  const { allowDiff = false, ...execOptions } = options;
  return new Promise((resolve, reject) => execFile(command, args, { ...execOptions, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if (error && !(allowDiff && error.code === 1 && stdout.trim())) return reject(new Error((stderr || error.message).trim()));
    resolve({ stdout, stderr });
  }));
}

function ruffCommand(root) {
  for (const candidate of [path.join(root, '.venv', 'bin', 'ruff'), path.join(root, 'venv', 'bin', 'ruff'), path.join(root, '.venv', 'Scripts', 'ruff.exe'), path.join(root, 'venv', 'Scripts', 'ruff.exe')]) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return 'ruff';
}

function fixTools(root) {
  const tools = [{ id: 'ruff', label: 'Ruff (TC001)', kinds: ['type_only'], command: ruffCommand(root),
    previewArgs: ['check', '--select', 'TC001', '--unsafe-fixes', '--no-cache', '--diff', '{file}'],
    applyArgs: ['check', '--select', 'TC001', '--unsafe-fixes', '--no-cache', '--fix-only', '{file}'] }];
  const configPath = path.join(root, 'moduleloom.toml');
  if (!fs.existsSync(configPath)) return tools;
  const content = fs.readFileSync(configPath, 'utf8');
  const headers = [...content.matchAll(/^\[fix_tools\.([^\]]+)\]\s*$/gm)];
  for (let i = 0; i < headers.length; i++) {
    const id = headers[i][1];
    if (id === 'ruff') throw new Error('fix_tools.ruff は予約済みです');
    const start = headers[i].index + headers[i][0].length;
    const nextTable = content.slice(start).search(/^\s*\[[^\]]+\]\s*$/m);
    const end = nextTable < 0 ? content.length : start + nextTable;
    const block = content.slice(start, end);
    const string = key => block.match(new RegExp(`^\\s*${key}\\s*=\\s*"((?:[^"\\\\]|\\\\.)*)"`, 'm'))?.[1]?.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    const array = key => {
      const source = block.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[([^\\]]*)\\]`, 'm'))?.[1];
      return source == null ? null : [...source.matchAll(/"((?:[^"\\\\]|\\\\.)*)"/g)].map(item => item[1]);
    };
    const command = string('command');
    const previewArgs = array('preview_args');
    const applyArgs = array('apply_args');
    if (!command || !previewArgs || !applyArgs) throw new Error(`fix_tools.${id} に command、preview_args、apply_args が必要です`);
    const kinds = array('kinds') || ['type_only', 'runtime', 'unknown'];
    if (kinds.some(kind => !['type_only', 'runtime', 'unknown'].includes(kind))) throw new Error(`fix_tools.${id}.kinds に不明な種類があります`);
    let executable = command;
    if (!path.isAbsolute(executable) && /[\\/]/.test(executable)) executable = path.join(root, executable);
    tools.push({ id, label: string('label') || id, kinds, command: executable, previewArgs, applyArgs });
  }
  return tools;
}

function expandFixArgs(args, root, file, source, target, line) {
  return args.map(arg => arg.replaceAll('{project}', root).replaceAll('{file}', file).replaceAll('{source}', source).replaceAll('{target}', target).replaceAll('{line}', String(line)));
}

async function analyzeForCommand(folder, changedFiles, quality = false) {
  const incremental = Array.isArray(changedFiles) && changedFiles.length > 0 && lastResult?.root_path === folder.uri.fsPath;
  const args = ['--json', ...(quality ? ['--quality'] : []), ...(incremental ? ['--incremental'] : []), folder.uri.fsPath];
  const { stdout } = await new Promise((resolve, reject) => {
    const child = spawn(analyzerExecutable(folder), args, { cwd: folder.uri.fsPath });
    const chunks = []; let stderr = '';
    child.stdin.on('error', () => {});
    child.stdin.end(incremental ? JSON.stringify({ previous: lastResult, changed_files: changedFiles }) : undefined);
    child.stdout.on('data', chunk => chunks.push(chunk));
    child.stderr.on('data', chunk => { stderr += chunk.toString(); });
    child.on('error', reject);
    child.on('close', code => code === 0 ? resolve({ stdout: Buffer.concat(chunks).toString('utf8') }) : reject(new Error(stderr.trim() || `analyze exited ${code}`)));
  });
  lastResult = JSON.parse(stdout);
  return lastResult;
}

async function handlePluginCommand(folder, webview, message) {
  const args = message.args || {};
  const commandFolder = args.path && fs.existsSync(args.path) && fs.statSync(args.path).isDirectory()
    ? { ...folder, uri: vscode.Uri.file(args.path) } : folder;
  const root = path.resolve(commandFolder.uri.fsPath);
  switch (message.command) {
    case 'analyze_project': return analyzeForCommand(commandFolder, args.changedFiles, args.quality === true);
    case 'list_fix_tools': return fixTools(root).map(({ id, label, kinds }) => ({ id, label, kinds }));
    case 'preview_cycle_fix': {
      let item = lastResult?.cycles?.flatMap(cycle => cycle.suggestion ? [cycle.suggestion] : []).find(s => s.source === args.source && Number(s.line) === Number(args.line));
      if (!item && args.target && args.kind) {
        item = { source: args.source, target: args.target, line: Number(args.line), kind: args.kind };
      }
      const mod = lastResult?.modules?.find(candidate => candidate.id === args.source);
      if (!item || !mod) throw new Error('循環改善候補が見つかりません。再解析してください');
      const file = path.resolve(root, mod.relative_path || mod.absolute_path);
      if (!file.startsWith(root + path.sep) || path.extname(file) !== '.py') throw new Error('対象ファイルが解析対象外です');
      const tool = fixTools(root).find(candidate => candidate.id === args.toolId);
      if (!tool.kinds.includes(item.kind) && tool.id !== 'ruff') throw new Error(`${tool.label} はこの循環候補の種類（${item.kind}）に対応していません`);
      const original = fs.readFileSync(file);
      const previewArgs = expandFixArgs(tool.previewArgs, root, file, args.source, item.target, Number(args.line));
      let diff = '';
      try {
        const { stdout } = await runFile(tool.command, previewArgs, { cwd: root, allowDiff: true });
        diff = stdout;
      } catch (_) {
        diff = '';
      }
      if (!fs.readFileSync(file).equals(original)) throw new Error(`${tool.label} のプレビュー用コマンドがファイルを変更しました`);
      pendingFix = { root, file, original, diff, command: tool.command, previewArgs, applyArgs: expandFixArgs(tool.applyArgs, root, file, args.source, item.target, Number(args.line)), label: tool.label };
      return { file, diff, tool: tool.label };
    }
    case 'apply_cycle_fix': {
      if (!pendingFix || pendingFix.root !== path.resolve(lastResult?.root_path || root)) throw new Error('差分を再表示してから適用してください');
      const pending = pendingFix; pendingFix = undefined;
      if (!fs.readFileSync(pending.file).equals(pending.original)) throw new Error('差分表示後に対象ファイルが変更されました。再度プレビューしてください');
      const { stdout: diff } = await runFile(pending.command, pending.previewArgs, { cwd: pending.root, allowDiff: true });
      if (diff !== pending.diff) throw new Error(`${pending.label} の修正内容が変わりました。再度プレビューしてください`);
      await runFile(pending.command, pending.applyArgs, { cwd: pending.root });
      if (fs.readFileSync(pending.file).equals(pending.original)) throw new Error(`${pending.label} はファイルを変更しませんでした`);
      return pending.file;
    }
    case 'git_changed_files': {
      let stdout;
      try { ({ stdout } = await runFile('git', ['-C', root, 'status', '--short'], { cwd: root })); }
      catch (_) { return []; }
      return stdout.split(/\r?\n/).filter(Boolean).map(line => line.slice(3).trim()).filter(file => file.endsWith('.py'));
    }
    case 'git_diff_files': {
      const { stdout } = await runFile('git', ['-C', root, 'diff', '--name-only', `${args.base}..${args.head}`], { cwd: root });
      return stdout.split(/\r?\n/).filter(file => file.endsWith('.py'));
    }
    case 'generate_mkdocs': {
      const output = path.resolve(args.output);
      await runFile(analyzerExecutable(commandFolder), ['--mkdocs', output, '--lang', args.lang || 'auto', root], { cwd: root });
      return output;
    }
    case 'export_report': {
      const outDir = path.join(root, '.moduleloom');
      fs.mkdirSync(outDir, { recursive: true });
      const stamp = new Date().toISOString().replace(/[:.]/g, '-');
      const jsonPath = path.join(outDir, `moduleloom-analysis-${stamp}.json`);
      if (typeof args.json !== 'string') throw new Error('解析データがありません');
      fs.writeFileSync(jsonPath, args.json, 'utf8');
      return jsonPath;
    }
    case 'watch_project': watchFolder(commandFolder); return {};
    case 'stop_watching': clearTimeout(refreshTimer); pendingChangedFiles.clear(); fileWatchers.forEach(watcher => watcher.dispose()); fileWatchers = []; return {};
    case 'open_in_editor': await openFile(commandFolder, args.filePath, args.line); return {};
    case 'detect_editors': return ['code'];
    default: throw new Error(`Unsupported ModuleLoom command: ${message.command}`);
  }
}

function watchFolder(folder) {
  clearTimeout(refreshTimer);
  pendingChangedFiles.clear();
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
        panel.webview.postMessage({ type: 'file_changed', files: changed });
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
  const jscpdExecutable = process.platform === 'win32' ? 'jscpd.exe' : 'jscpd';
  const bundled = path.join(__dirname, 'bin', `${platform}-${arch}`, executable);
  if (fs.existsSync(bundled)) {
    const bundledJscpd = path.join(__dirname, 'bin', `${platform}-${arch}`, jscpdExecutable);
    const digest = crypto.createHash('sha256').update(fs.readFileSync(bundled));
    if (fs.existsSync(bundledJscpd)) digest.update(fs.readFileSync(bundledJscpd));
    const hash = digest.digest('hex').slice(0, 16);
    const directory = path.join(os.homedir(), '.cache', 'moduleloom', 'bin', `${platform}-${arch}`, hash);
    const installed = path.join(directory, executable);
    fs.mkdirSync(directory, { recursive: true });
    if (!fs.existsSync(installed)) fs.copyFileSync(bundled, installed);
    if (process.platform !== 'win32') fs.chmodSync(installed, 0o755);
    if (fs.existsSync(bundledJscpd)) {
      const installedJscpd = path.join(directory, jscpdExecutable);
      if (!fs.existsSync(installedJscpd)) fs.copyFileSync(bundledJscpd, installedJscpd);
      if (process.platform !== 'win32') fs.chmodSync(installedJscpd, 0o755);
    }
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

function makeHtml(context, webview, folder) {
  const media = vscode.Uri.joinPath(context.extensionUri, 'media');
  let html = fs.readFileSync(path.join(context.extensionPath, 'media', 'index.html'), 'utf8');
  html = html.replace(/(?:src|href)="(?:\.\/)?assets\/([^\"]+)"/g, (_match, name) => {
    const uri = webview.asWebviewUri(vscode.Uri.joinPath(media, 'assets', name));
    return `${_match.startsWith('src') ? 'src' : 'href'}="${uri}"`;
  });
  const bridge = `<script>
    window.__MODULELOOM_PROJECT_PATH__ = ${JSON.stringify(folder.uri.fsPath)};
    window.__MODULELOOM_EDITOR__ = 'vscode';
    const vscodeApi = acquireVsCodeApi();
    let moduleLoomRequestId = 0;
    const moduleLoomPending = new Map();
    window.__MODULELOOM_INVOKE__ = (command, args) => new Promise((resolve, reject) => {
      const requestId = ++moduleLoomRequestId;
      moduleLoomPending.set(requestId, {resolve, reject});
      vscodeApi.postMessage({type:'command', requestId, command, args});
    });
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'command_result') {
        const pending = moduleLoomPending.get(message.requestId);
        if (!pending) return;
        moduleLoomPending.delete(message.requestId);
        message.error ? pending.reject(new Error(message.error)) : pending.resolve(message.result);
      }
      if (message.type === 'file_changed') window.__MODULELOOM_FILE_CHANGED__?.(message.files);
      if (message.type === 'reanalyze') window.__MODULELOOM_REANALYZE__?.();
    });
  </script>`;
  const csp = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data:; style-src ${webview.cspSource} 'unsafe-inline'; script-src ${webview.cspSource} 'unsafe-inline';"><style>.editor-select-area{display:none !important;}</style>`;
  html = html.replace('</head>', `${csp}${bridge}</head>`);
  return html.replaceAll('PyCharm', 'VS Code');
}

function activate(context) {
  // Keep a visible Activity Bar entry even before the graph panel is opened.
  context.subscriptions.push(vscode.window.registerTreeDataProvider('moduleloom.launch', {
    getChildren: () => [],
    getTreeItem: item => item
  }));
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
      panel.webview.postMessage({ type: 'reanalyze' });
      return;
    }
    panel = vscode.window.createWebviewPanel('moduleloom.graph', 'ModuleLoom', vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'media')],
      retainContextWhenHidden: true
    });
    panel.webview.html = makeHtml(context, panel.webview, currentFolder);
    panel.webview.onDidReceiveMessage(async message => {
      if (message.type === 'analyze') runAnalysis(currentFolder, panel.webview);
      if (message.type === 'open_file') openFile(currentFolder, message.path, message.line);
      if (message.type === 'command') {
        try {
          const result = await handlePluginCommand(currentFolder, panel.webview, message);
          panel?.webview.postMessage({ type: 'command_result', requestId: message.requestId, result });
        } catch (error) {
          panel?.webview.postMessage({ type: 'command_result', requestId: message.requestId, error: error.message });
        }
      }
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
