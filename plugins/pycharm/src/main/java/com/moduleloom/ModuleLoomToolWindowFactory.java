package com.moduleloom;

import com.intellij.openapi.application.ApplicationManager;
import com.intellij.openapi.util.Disposer;
import com.intellij.openapi.actionSystem.CommonDataKeys;
import com.intellij.ide.DataManager;
import com.intellij.openapi.fileEditor.FileEditorManager;
import com.intellij.openapi.fileEditor.FileEditorManagerEvent;
import com.intellij.openapi.fileEditor.FileEditorManagerListener;
import com.intellij.openapi.fileEditor.OpenFileDescriptor;
import com.intellij.openapi.project.DumbAware;
import com.intellij.openapi.project.Project;
import com.intellij.openapi.vfs.LocalFileSystem;
import com.intellij.openapi.vfs.VirtualFile;
import com.intellij.openapi.vfs.VirtualFileManager;
import com.intellij.openapi.vfs.newvfs.BulkFileListener;
import com.intellij.openapi.vfs.newvfs.events.VFileEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileCreateEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileDeleteEvent;
import com.intellij.openapi.vfs.newvfs.events.VFileMoveEvent;
import com.intellij.openapi.wm.ToolWindow;
import com.intellij.openapi.wm.ToolWindowFactory;
import com.intellij.openapi.wm.ToolWindowManager;
import com.intellij.ui.content.Content;
import com.intellij.ui.content.ContentFactory;
import com.intellij.ui.jcef.JBCefApp;
import com.intellij.ui.jcef.JBCefBrowser;
import com.intellij.ui.jcef.JBCefBrowserBase;
import com.intellij.ui.jcef.JBCefJSQuery;
import com.intellij.util.messages.MessageBusConnection;
import org.cef.browser.CefBrowser;
import org.cef.browser.CefFrame;
import org.cef.handler.CefLoadHandlerAdapter;
import org.jetbrains.annotations.NotNull;
import org.jetbrains.annotations.Nullable;

import javax.swing.*;
import java.awt.*;
import java.awt.event.AWTEventListener;
import java.awt.event.MouseEvent;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Map;
import java.util.List;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

public class ModuleLoomToolWindowFactory implements ToolWindowFactory, DumbAware {

    public static class ToolWindowHolder {
        public JBCefBrowser browser;
        public JComboBox<String> targetCombo;
        public volatile boolean syncOnDoubleClick = true;
        public volatile String currentAnalyzePath;
        public volatile String pendingFilePath;
        public volatile boolean autoRefresh = true;
        public Timer refreshTimer;
        public boolean analysisRunning;
        public boolean analysisPending;
        public String pendingAnalyzePath;
        public String pendingAnalyzeTarget;
        public boolean pendingFullAnalysis;
        public final Set<String> pendingChangedFiles = new HashSet<>();
        public volatile String lastResultJson;
        public volatile String lastResultRoot;
    }

    private static final Map<Project, ToolWindowHolder> activeHolders = new ConcurrentHashMap<>();

    // A fileOpened event can occur during the second mouse press, before MOUSE_CLICKED.
    private static volatile long lastUserDoubleClickTime = 0;
    private static volatile String lastHandledFilePath = null;
    private static volatile long lastHandledTime = 0;

    // Tracking: timestamp when ModuleLoom triggered opening a file in editor (to avoid feedback loop)
    private static volatile long lastModuleLoomTriggeredOpenTime = 0;

    static {
        try {
            Toolkit.getDefaultToolkit().addAWTEventListener(new AWTEventListener() {
                @Override
                public void eventDispatched(AWTEvent event) {
                    if (event instanceof MouseEvent) {
                        MouseEvent me = (MouseEvent) event;
                        if (me.getID() == MouseEvent.MOUSE_PRESSED && me.getClickCount() == 2 && SwingUtilities.isLeftMouseButton(me)) {
                            lastUserDoubleClickTime = System.currentTimeMillis();
                        }
                        if (me.getID() == MouseEvent.MOUSE_CLICKED && me.getClickCount() == 2 && SwingUtilities.isLeftMouseButton(me)
                                && me.getComponent() != null
                                && (me.getComponent() instanceof JTree
                                || SwingUtilities.getAncestorOfClass(JTree.class, me.getComponent()) != null)) {
                            // Opening an already selected tree item may emit no editor event.
                            // Resolve the clicked file directly in that case.
                            var context = DataManager.getInstance().getDataContext(me.getComponent());
                            Project project = CommonDataKeys.PROJECT.getData(context);
                            VirtualFile file = CommonDataKeys.VIRTUAL_FILE.getData(context);
                            if (project != null && file != null) {
                                handleUserFileActivation(project, file);
                            }
                        }
                    }
                }
            }, AWTEvent.MOUSE_EVENT_MASK);
        } catch (Throwable t) {
            t.printStackTrace();
        }
    }

    @Override
    public void createToolWindowContent(@NotNull Project project, @NotNull ToolWindow toolWindow) {
        if (!JBCefApp.isSupported()) {
            JPanel fallbackPanel = new JPanel(new BorderLayout());
            fallbackPanel.add(new JLabel("JCEF (Chromium Embedded Framework) is not supported in this IDE environment.", SwingConstants.CENTER), BorderLayout.CENTER);
            Content content = ContentFactory.getInstance().createContent(fallbackPanel, "", false);
            toolWindow.getContentManager().addContent(content);
            return;
        }

        JPanel mainPanel = new JPanel(new BorderLayout());

        // Top Toolbar
        JPanel toolbarPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        JButton btnMkdocs = new JButton("MkDocs 出力");
        JComboBox<String> targetCombo = new JComboBox<>();
        String projBase = project.getBasePath() != null ? project.getBasePath() : "";
        Path samplePath = Path.of(projBase, "sample_project");
        if (Files.exists(samplePath) && Files.isDirectory(samplePath)) {
            targetCombo.addItem("sample_project");
            targetCombo.addItem("プロジェクト全体 (" + project.getName() + ")");
        } else {
            targetCombo.addItem(project.getName());
        }

        JCheckBox chkDoubleClickSync = new JCheckBox("ダブルクリック連動", true);
        JCheckBox chkAutoRefresh = new JCheckBox("自動更新", true);
        chkAutoRefresh.setToolTipText("Python ファイルや moduleloom.toml の保存・追加・削除後に再解析します");
        chkDoubleClickSync.setToolTipText("PyCharm側でファイルをダブルクリックして開いた時、自動で依存図を開きます (ModuleLoomからのオープン時は反応しません)");

        toolbarPanel.add(new JLabel("解析対象:"));
        toolbarPanel.add(targetCombo);
        toolbarPanel.add(btnMkdocs);
        toolbarPanel.add(chkDoubleClickSync);
        toolbarPanel.add(chkAutoRefresh);
        mainPanel.add(toolbarPanel, BorderLayout.NORTH);

        // Setup JCEF Browser
        JBCefBrowser browser = new JBCefBrowser();
        JBCefJSQuery jsQuery = JBCefJSQuery.create((JBCefBrowserBase) browser);

        ToolWindowHolder holder = new ToolWindowHolder();
        holder.browser = browser;
        holder.targetCombo = targetCombo;
        holder.syncOnDoubleClick = chkDoubleClickSync.isSelected();
        activeHolders.put(project, holder);

        chkDoubleClickSync.addActionListener(e -> {
            holder.syncOnDoubleClick = chkDoubleClickSync.isSelected();
        });
        holder.refreshTimer = new Timer(500, e -> ApplicationManager.getApplication().executeOnPooledThread(() ->
                runAnalyze(project, holder, holder.currentAnalyzePath, null, drainChangedFiles(holder))));
        holder.refreshTimer.setRepeats(false);
        Disposer.register(toolWindow.getContentManager(), () -> {
            holder.refreshTimer.stop();
            activeHolders.remove(project, holder);
        });
        chkAutoRefresh.addActionListener(e -> {
            holder.autoRefresh = chkAutoRefresh.isSelected();
            if (!holder.autoRefresh) holder.refreshTimer.stop();
        });

        // Extract bundled web assets to user cache directory
        Path webDir = prepareWebAssets();

        jsQuery.addHandler(query -> {
            handleClientQuery(project, browser, query, targetCombo);
            return new JBCefJSQuery.Response("ok");
        });

        // Inject JS bridge on page load
        browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
            @Override
            public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                if (frame.isMain()) {
                    String injectScript = "window.cefQuery = function(arg) { " +
                            jsQuery.inject("arg.request") +
                            " };";
                    cefBrowser.executeJavaScript(injectScript, cefBrowser.getURL(), 0);
                    // Automatically trigger analysis on initial load
                    ApplicationManager.getApplication().executeOnPooledThread(() -> runAnalyze(project, holder, null, null));
                }
            }
        }, browser.getCefBrowser());

        btnMkdocs.addActionListener(e -> {
            String basePath = project.getBasePath();
            if (basePath == null) return;
            Path suggested = Path.of(basePath, "moduleloom-docs");
            JFileChooser chooser = new JFileChooser(basePath);
            chooser.setDialogTitle("MkDocs 出力先を選択");
            chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
            chooser.setAcceptAllFileFilterUsed(false);
            chooser.setToolTipText("空のディレクトリ、または以前 ModuleLoom が生成したディレクトリを選択してください (推奨: " + suggested + ")");
            if (chooser.showSaveDialog(mainPanel) == JFileChooser.APPROVE_OPTION) {
                Path output = chooser.getSelectedFile().toPath().toAbsolutePath().normalize();
                String lang = JOptionPane.showInputDialog(mainPanel,
                        "ドキュメントの言語 (auto / ja / en)", "auto");
                if (lang == null) return;
                lang = lang.trim();
                if (lang.isEmpty()) lang = "auto";
                String analysisPath = selectedAnalysisPath(project, targetCombo);
                String selectedLang = lang;
                ApplicationManager.getApplication().executeOnPooledThread(() ->
                        generateMkDocs(project, holder, analysisPath, output, selectedLang));
            }
        });

        targetCombo.addActionListener(e -> {
            ApplicationManager.getApplication().executeOnPooledThread(() -> runAnalyze(project, holder, null, null));
        });

        if (webDir != null && Files.exists(webDir.resolve("index.html"))) {
            browser.loadURL(webDir.resolve("index.html").toUri().toString());
        } else {
            browser.loadHTML("<html><body><h2>Failed to load web assets</h2></body></html>");
        }

        mainPanel.add(browser.getComponent(), BorderLayout.CENTER);

        // Subscribe to FileEditorManager events to handle user double-click file opening
        MessageBusConnection busConnection = project.getMessageBus().connect(toolWindow.getContentManager());
        busConnection.subscribe(FileEditorManagerListener.FILE_EDITOR_MANAGER, new FileEditorManagerListener() {
            @Override
            public void fileOpened(@NotNull FileEditorManager source, @NotNull VirtualFile file) {
                handleUserFileActivation(project, file);
            }

            @Override
            public void selectionChanged(@NotNull FileEditorManagerEvent event) {
                VirtualFile file = event.getNewFile();
                if (file != null) {
                    handleUserFileActivation(project, file);
                }
            }
        });
        busConnection.subscribe(VirtualFileManager.VFS_CHANGES, new BulkFileListener() {
            @Override
            public void after(@NotNull List<? extends VFileEvent> events) {
                if (!holder.autoRefresh || holder.currentAnalyzePath == null) return;
                String root = holder.currentAnalyzePath.replace('\\', '/');
                boolean changed = false;
                for (VFileEvent event : events) {
                    String path = event.getPath().replace('\\', '/');
                    boolean structural = event instanceof VFileDeleteEvent || event instanceof VFileMoveEvent
                            || (event instanceof VFileCreateEvent && Files.isDirectory(Path.of(path)));
                    if ((path.endsWith(".py") || path.endsWith("/moduleloom.toml") || structural)
                            && path.startsWith(root + "/")) {
                        synchronized (holder) { holder.pendingChangedFiles.add(path); }
                        changed = true;
                    }
                }
                if (changed) SwingUtilities.invokeLater(() -> {
                    if (holder.autoRefresh) holder.refreshTimer.restart();
                });
            }
        });

        Content content = ContentFactory.getInstance().createContent(mainPanel, "", false);
        toolWindow.getContentManager().addContent(content);
    }

    /**
     * Handles file activation in PyCharm editor.
     * Only triggers ModuleLoom if:
     * 1. The user explicitly double-clicked (within 600ms).
     * 2. It was NOT triggered by ModuleLoom itself (lastModuleLoomTriggeredOpenTime).
     */
    private static void handleUserFileActivation(Project project, VirtualFile file) {
        long now = System.currentTimeMillis();

        // 1. ModuleLoom からファイルを開いた時は絶対に反応させない！ (フィードバックループ防止)
        if (now - lastModuleLoomTriggeredOpenTime < 1500) {
            return;
        }

        // 2. ユーザーがマウスでダブルクリックした直後のみ反応する！
        if (now - lastUserDoubleClickTime > 600) {
            return;
        }

        // 3. 対象が Python ファイル (.py) かチェック
        if (file.isDirectory() || !"py".equalsIgnoreCase(file.getExtension())) {
            return;
        }

        ToolWindowHolder holder = activeHolders.get(project);
        if (holder == null || !holder.syncOnDoubleClick) {
            return;
        }

        String filePath = file.getPath();
        if (filePath.equals(lastHandledFilePath) && now - lastHandledTime < 600) {
            return; // Duplicate event
        }
        lastHandledFilePath = filePath;
        lastHandledTime = now;

        // Open in ModuleLoom
        openFileInToolWindow(project, file);
    }

    public static void openFileInToolWindow(@NotNull Project project, @NotNull VirtualFile file) {
        ToolWindowManager toolWindowManager = ToolWindowManager.getInstance(project);
        ToolWindow toolWindow = toolWindowManager.getToolWindow("ModuleLoom");
        if (toolWindow == null) return;

        toolWindow.show(() -> {
            ToolWindowHolder holder = activeHolders.get(project);
            if (holder == null || holder.browser == null) return;

            String filePath = file.getPath();
            if (file.isDirectory()) {
                // Directory: Analyze this directory directly
                ApplicationManager.getApplication().executeOnPooledThread(() ->
                        runAnalyze(project, holder, filePath, null)
                );
            } else {
                // Python File: Determine optimal analysis root and open file-centric diagram
                String optimalRoot = determineOptimalRoot(project, file);
                boolean needReanalyze = holder.currentAnalyzePath == null ||
                        !filePath.startsWith(holder.currentAnalyzePath);

                if (needReanalyze) {
                    holder.pendingFilePath = filePath;
                    ApplicationManager.getApplication().executeOnPooledThread(() ->
                            runAnalyze(project, holder, optimalRoot, filePath)
                    );
                } else {
                    // Already analyzed: trigger diagram jump directly
                    String js = "window.openModuleByFilePath('" + escapeJs(filePath) + "', true);";
                    ApplicationManager.getApplication().invokeLater(() -> {
                        if (holder.browser.getCefBrowser() != null) {
                            holder.browser.getCefBrowser().executeJavaScript(js, holder.browser.getCefBrowser().getURL(), 0);
                        }
                    });
                }
            }
        });
    }

    private static String determineOptimalRoot(Project project, VirtualFile file) {
        String basePath = project.getBasePath() != null ? project.getBasePath() : "";
        String filePath = file.getPath();
        Path sampleP = Path.of(basePath, "sample_project");
        if (Files.exists(sampleP) && filePath.startsWith(sampleP.toString())) {
            return sampleP.toString();
        }
        return basePath;
    }

    private void handleClientQuery(Project project, JBCefBrowser browser, String query, JComboBox<String> targetCombo) {
        if (query == null || query.isEmpty()) return;

        if (query.contains("\"type\":\"open_file\"") || query.contains("'type':'open_file'")) {
            // Mark timestamp so handleUserFileActivation will completely ignore this event!
            lastModuleLoomTriggeredOpenTime = System.currentTimeMillis();

            String path = extractJsonField(query, "path");
            String lineStr = extractJsonField(query, "line");
            int line = 1;
            try {
                if (lineStr != null) line = Integer.parseInt(lineStr);
            } catch (NumberFormatException ignored) {}

            if (path != null && !path.isEmpty()) {
                final int targetLine = Math.max(1, line);
                ApplicationManager.getApplication().invokeLater(() -> {
                    VirtualFile vf = LocalFileSystem.getInstance().findFileByPath(path);
                    if (vf != null) {
                        OpenFileDescriptor desc = new OpenFileDescriptor(project, vf, targetLine - 1, 0);
                        FileEditorManager.getInstance(project).openTextEditor(desc, true);
                    }
                });
            }
        } else if (query.contains("\"type\":\"analyze\"") || query.contains("'type':'analyze'")) {
            ToolWindowHolder holder = activeHolders.get(project);
            if (holder != null) {
                ApplicationManager.getApplication().executeOnPooledThread(() -> runAnalyze(project, holder, null, null));
            }
        }
    }

    private static String selectedAnalysisPath(Project project, JComboBox<String> targetCombo) {
        String basePath = project.getBasePath();
        if (basePath == null) return null;
        String selected = targetCombo != null ? (String) targetCombo.getSelectedItem() : null;
        if ("sample_project".equals(selected) || selected == null) {
            Path samplePath = Path.of(basePath, "sample_project");
            if (Files.isDirectory(samplePath)) return samplePath.toString();
        }
        return basePath;
    }

    private static void generateMkDocs(Project project, ToolWindowHolder holder, String analysisPath, Path output, String lang) {
        if (analysisPath == null) return;
        setStatus(holder, "MkDocs を生成中...");
        String binaryPath = findAnalyzerBinary(project);
        if (binaryPath == null) {
            setStatus(holder, "解析エンジンが見つかりません");
            return;
        }
        String message;
        int messageType;
        try {
            Process process = new ProcessBuilder(binaryPath, "--mkdocs", output.toString(), "--lang", lang, analysisPath)
                    .redirectErrorStream(true).start();
            StringBuilder outputText = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) outputText.append(line).append('\n');
            }
            int exitCode = process.waitFor();
            boolean generated = exitCode == 0
                    && Files.isRegularFile(output.resolve("mkdocs.yml"))
                    && Files.isRegularFile(output.resolve("docs/index.md"));
            if (generated) {
                message = "MkDocs マニュアルを生成しました。\n\n" + output;
                messageType = JOptionPane.INFORMATION_MESSAGE;
                setStatus(holder, "MkDocs 生成完了: " + output);
            } else {
                String detail = outputText.toString().trim();
                message = "MkDocs の生成に失敗しました (終了コード " + exitCode + ")" +
                        (exitCode == 0 ? "\n指定先に MkDocs ファイルが見つかりません。解析エンジンが古い可能性があります。" : "") +
                        (detail.isEmpty() ? "" : "\n\n" + detail);
                messageType = JOptionPane.ERROR_MESSAGE;
                setStatus(holder, "MkDocs 生成に失敗しました");
            }
        } catch (Exception ex) {
            message = "MkDocs の生成に失敗しました: " + ex.getMessage();
            messageType = JOptionPane.ERROR_MESSAGE;
            setStatus(holder, "MkDocs 生成に失敗しました");
        }
        final String dialogMessage = message;
        final int dialogType = messageType;
        ApplicationManager.getApplication().invokeLater(() ->
                JOptionPane.showMessageDialog(holder.browser.getComponent(), dialogMessage, "ModuleLoom", dialogType));
    }

    private static void setStatus(ToolWindowHolder holder, String text) {
        ApplicationManager.getApplication().invokeLater(() -> {
            if (holder.browser == null || holder.browser.getCefBrowser() == null) return;
            String js = "document.getElementById('status-info').textContent = '" + escapeJs(text) + "';";
            holder.browser.getCefBrowser().executeJavaScript(js, holder.browser.getCefBrowser().getURL(), 0);
        });
    }

    private static List<String> drainChangedFiles(ToolWindowHolder holder) {
        synchronized (holder) {
            List<String> paths = new ArrayList<>(holder.pendingChangedFiles);
            holder.pendingChangedFiles.clear();
            return paths;
        }
    }

    private static void runAnalyze(Project project, ToolWindowHolder holder, @Nullable String overridePath, @Nullable String targetFileToOpen) {
        runAnalyze(project, holder, overridePath, targetFileToOpen, null);
    }

    private static void runAnalyze(Project project, ToolWindowHolder holder, @Nullable String overridePath, @Nullable String targetFileToOpen, @Nullable List<String> changedFiles) {
        synchronized (holder) {
            if (holder.analysisRunning) {
                holder.analysisPending = true;
                if (changedFiles == null) {
                    holder.pendingFullAnalysis = true;
                    holder.pendingAnalyzePath = overridePath;
                    holder.pendingAnalyzeTarget = targetFileToOpen;
                } else {
                    holder.pendingChangedFiles.addAll(changedFiles);
                    if (!holder.pendingFullAnalysis) holder.pendingAnalyzePath = overridePath;
                }
                if (targetFileToOpen != null) holder.pendingFilePath = targetFileToOpen;
                return;
            }
            holder.analysisRunning = true;
        }
        try {
            performAnalyze(project, holder, overridePath, targetFileToOpen, changedFiles);
        } finally {
            boolean pending;
            String pendingPath;
            String pendingTarget;
            List<String> pendingChanges;
            synchronized (holder) {
                holder.analysisRunning = false;
                pending = holder.analysisPending;
                pendingPath = holder.pendingAnalyzePath;
                pendingTarget = holder.pendingAnalyzeTarget;
                pendingChanges = holder.pendingFullAnalysis ? null : new ArrayList<>(holder.pendingChangedFiles);
                holder.analysisPending = false;
                holder.pendingFullAnalysis = false;
                holder.pendingAnalyzePath = null;
                holder.pendingAnalyzeTarget = null;
                holder.pendingChangedFiles.clear();
            }
            if (pending) runAnalyze(project, holder, pendingPath, pendingTarget, pendingChanges);
        }
    }

    private static void performAnalyze(Project project, ToolWindowHolder holder, @Nullable String overridePath, @Nullable String targetFileToOpen, @Nullable List<String> changedFiles) {
        String basePath = overridePath;
        if (basePath == null) {
            basePath = project.getBasePath();
            if (basePath == null) return;

            String selected = holder.targetCombo != null ? (String) holder.targetCombo.getSelectedItem() : null;
            if ("sample_project".equals(selected)) {
                Path sampleP = Path.of(basePath, "sample_project");
                if (Files.exists(sampleP)) {
                    basePath = sampleP.toString();
                }
            } else if (selected == null) {
                Path sampleP = Path.of(basePath, "sample_project");
                if (Files.exists(sampleP)) {
                    basePath = sampleP.toString();
                }
            }
        }

        holder.currentAnalyzePath = basePath;
        if (targetFileToOpen != null) {
            holder.pendingFilePath = targetFileToOpen;
        }

        // Path to analyze CLI binary
        String binaryPath = findAnalyzerBinary(project);
        if (binaryPath == null) {
            String errorJs = "document.getElementById('status-info').textContent = 'Error: analyze binary not found';";
            holder.browser.getCefBrowser().executeJavaScript(errorJs, holder.browser.getCefBrowser().getURL(), 0);
            return;
        }

        try {
            boolean incremental = changedFiles != null && !changedFiles.isEmpty()
                    && basePath.equals(holder.lastResultRoot) && holder.lastResultJson != null;
            ProcessBuilder pb = incremental
                    ? new ProcessBuilder(binaryPath, "--json", "--incremental", basePath)
                    : new ProcessBuilder(binaryPath, "--json", basePath);
            pb.redirectErrorStream(false);
            Process process = pb.start();
            try (var writer = new OutputStreamWriter(process.getOutputStream(), StandardCharsets.UTF_8)) {
                if (incremental) {
                    writer.write("{\"previous\":" + holder.lastResultJson + ",\"changed_files\":[");
                    for (int i = 0; i < changedFiles.size(); i++) {
                        if (i > 0) writer.write(",");
                        writer.write(jsonQuote(changedFiles.get(i)));
                    }
                    writer.write("]}");
                }
            }

            StringBuilder sb = new StringBuilder();
            try (BufferedReader reader = new BufferedReader(new InputStreamReader(process.getInputStream(), StandardCharsets.UTF_8))) {
                String line;
                while ((line = reader.readLine()) != null) {
                    sb.append(line);
                }
            }

            int exitCode = process.waitFor();
            if (exitCode == 0) {
                String jsonResult = sb.toString();
                holder.lastResultJson = jsonResult;
                holder.lastResultRoot = basePath;
                ApplicationManager.getApplication().invokeLater(() -> {
                    String pendingJs = "";
                    if (holder.pendingFilePath != null) {
                        pendingJs = "window._pendingOpenFilePath = { filePath: '" + escapeJs(holder.pendingFilePath) + "', openDiagram: true }; ";
                        holder.pendingFilePath = null;
                    }
                    String jsCall = pendingJs + "window.renderModuleGraph(" + jsonResult + ");";
                    holder.browser.getCefBrowser().executeJavaScript(jsCall, holder.browser.getCefBrowser().getURL(), 0);
                });
            } else {
                if (incremental) {
                    performAnalyze(project, holder, basePath, targetFileToOpen, null);
                    return;
                }
                String errJs = "document.getElementById('status-info').textContent = 'Analysis exited with code " + exitCode + "';";
                holder.browser.getCefBrowser().executeJavaScript(errJs, holder.browser.getCefBrowser().getURL(), 0);
            }
        } catch (Exception ex) {
            ex.printStackTrace();
            String errJs = "document.getElementById('status-info').textContent = 'Analysis error: " + escapeJs(ex.getMessage()) + "';";
            holder.browser.getCefBrowser().executeJavaScript(errJs, holder.browser.getCefBrowser().getURL(), 0);
        }
    }

    private static String findAnalyzerBinary(Project project) {
        String osName = System.getProperty("os.name", "").toLowerCase();
        String architecture = System.getProperty("os.arch", "").toLowerCase();
        boolean arm64 = architecture.equals("aarch64") || architecture.equals("arm64");
        String platform = null;
        if (osName.contains("win") && !arm64) platform = "windows-x64";
        else if (osName.contains("linux") && !arm64) platform = "linux-x64";
        else if (osName.contains("mac")) platform = arm64 ? "macos-arm64" : "macos-x64";

        if (platform != null) {
            String filename = osName.contains("win") ? "analyze.exe" : "analyze";
            String resource = "/bin/" + platform + "/" + filename;
            try (InputStream input = ModuleLoomToolWindowFactory.class.getResourceAsStream(resource)) {
                if (input != null) {
                    byte[] data = input.readAllBytes();
                    byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
                    String hash = HexFormat.of().formatHex(digest, 0, 8);
                    Path target = Path.of(System.getProperty("user.home"), ".cache", "moduleloom", "bin", platform, hash, filename);
                    Files.createDirectories(target.getParent());
                    if (!Files.exists(target)) Files.write(target, data);
                    if (!osName.contains("win")) target.toFile().setExecutable(true, false);
                    return target.toString();
                }
            } catch (Exception e) {
                e.printStackTrace();
            }
        }

        String projectBase = project.getBasePath();
        if (projectBase != null) {
            // Prefer the debug build while developing the plugin; it tracks the current source.
            Path debugPath = Path.of(projectBase, "target", "debug", osName.contains("win") ? "analyze.exe" : "analyze");
            if (Files.isRegularFile(debugPath)) return debugPath.toString();
            Path releasePath = Path.of(projectBase, "target", "release", osName.contains("win") ? "analyze.exe" : "analyze");
            if (Files.isRegularFile(releasePath)) return releasePath.toString();
        }
        return "analyze";
    }

    private Path prepareWebAssets() {
        try {
            Path targetDir = Path.of(System.getProperty("user.home"), ".cache", "moduleloom", "web");
            Files.createDirectories(targetDir);

            String[] files = {"index.html", "cytoscape.min.js", "cytoscape-dagre.min.js", "cycle-insights.js"};
            for (String file : files) {
                try (InputStream is = getClass().getResourceAsStream("/web/" + file)) {
                    if (is != null) {
                        Files.copy(is, targetDir.resolve(file), StandardCopyOption.REPLACE_EXISTING);
                    }
                }
            }
            return targetDir;
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    private String extractJsonField(String json, String key) {
        Pattern pattern = Pattern.compile("\"" + key + "\":\\s*\"?([^,\"}]+)\"?");
        Matcher matcher = pattern.matcher(json);
        if (matcher.find()) {
            return matcher.group(1).trim();
        }
        return null;
    }

    private static String escapeJs(String str) {
        if (str == null) return "";
        return str.replace("\\", "\\\\").replace("'", "\\'").replace("\n", " ");
    }

    private static String jsonQuote(String value) {
        StringBuilder result = new StringBuilder("\"");
        for (char ch : value.toCharArray()) {
            if (ch == '"' || ch == '\\') result.append('\\').append(ch);
            else if (ch == '\n') result.append("\\n");
            else if (ch == '\r') result.append("\\r");
            else if (ch == '\t') result.append("\\t");
            else if (ch < 0x20) result.append(String.format("\\u%04x", (int) ch));
            else result.append(ch);
        }
        return result.append('"').toString();
    }
}
