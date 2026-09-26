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
import javax.imageio.ImageIO;
import java.awt.*;
import java.awt.event.AWTEventListener;
import java.awt.event.MouseEvent;
import java.io.*;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Locale;
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
        public JTextField projectPathField;
        public JComboBox<String> targetCombo;
        public JCheckBox chkDoubleClickSync;
        public JCheckBox chkAutoRefresh;
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
        public volatile PendingFix pendingFix;
        public volatile String uiLocale = Locale.getDefault().getLanguage().equals("ja") ? "ja" : "en";
        public java.util.function.Consumer<String> applyLocale;
    }

    private static class PendingFix {
        final Path root, file;
        final byte[] original;
        final String diff, command, label;
        final List<String> previewArgs, applyArgs;
        PendingFix(Path root, Path file, byte[] original, String diff, String command, String label, List<String> previewArgs, List<String> applyArgs) {
            this.root = root; this.file = file; this.original = original; this.diff = diff; this.command = command;
            this.label = label; this.previewArgs = previewArgs; this.applyArgs = applyArgs;
        }
    }

    private static class FixToolConfig {
        final String id, label, command;
        final List<String> kinds, previewArgs, applyArgs;
        FixToolConfig(String id, String label, String command, List<String> kinds, List<String> previewArgs, List<String> applyArgs) {
            this.id = id; this.label = label; this.command = command; this.kinds = kinds;
            this.previewArgs = previewArgs; this.applyArgs = applyArgs;
        }
    }

    private static final Map<Project, ToolWindowHolder> activeHolders = new ConcurrentHashMap<>();

    public static boolean isEnglishUi(Project project) {
        ToolWindowHolder holder = activeHolders.get(project);
        return "en".equals(holder != null ? holder.uiLocale : (Locale.getDefault().getLanguage().equals("ja") ? "ja" : "en"));
    }

    private static String ui(String locale, String japanese, String english) {
        return "en".equals(locale) ? english : japanese;
    }

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

        // Keep the common actions visible and expand the analysis target only when it changes.
        JPanel toolbarPanel = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        String[] uiLocale = {Locale.getDefault().getLanguage().equals("ja") ? "ja" : "en"};
        JComboBox<String> targetCombo = new JComboBox<>();
        String projBase = project.getBasePath() != null ? project.getBasePath() : "";
        Path samplePath = Path.of(projBase, "sample_project");
        if (Files.exists(samplePath) && Files.isDirectory(samplePath)) {
            targetCombo.addItem("sample_project");
            targetCombo.addItem("project_root");
        } else {
            targetCombo.addItem(project.getName());
        }
        DefaultListCellRenderer defaultRenderer = new DefaultListCellRenderer();
        targetCombo.setRenderer((list, value, index, isSelected, cellHasFocus) -> {
            JLabel label = (JLabel) defaultRenderer.getListCellRendererComponent(list, value, index, isSelected, cellHasFocus);
            label.setText("project_root".equals(value)
                    ? ui(uiLocale[0], "プロジェクト全体", "Entire project") + " (" + project.getName() + ")"
                    : value);
            return label;
        });

        String initialPath = selectedAnalysisPath(project, targetCombo);
        JTextField projectPathField = new JTextField(initialPath != null ? initialPath : projBase, 18);
        projectPathField.setToolTipText("解析する Python プロジェクトのパス");
        JButton btnBrowseProject = new JButton("参照…");
        btnBrowseProject.setToolTipText("解析するプロジェクトのディレクトリを選択");

        JButton btnAnalyze = new JButton("解析実行");
        btnAnalyze.setToolTipText("指定したパスのモジュール依存関係を解析します");

        JCheckBox chkDoubleClickSync = new JCheckBox("ダブルクリック連動", true);
        chkDoubleClickSync.setToolTipText("PyCharm側でファイルをダブルクリックして開いた時、自動で依存図を開きます (ModuleLoomからのオープン時は反応しません)");

        JCheckBox chkAutoRefresh = new JCheckBox("自動更新", true);
        chkAutoRefresh.setToolTipText("Python ファイルや moduleloom.toml の保存・追加・削除後に再解析します");

        JButton btnTargetSettings = new JButton("対象設定 ▸");
        btnTargetSettings.setToolTipText("解析対象: " + projectPathField.getText());
        JPanel targetSettingsPanel = new JPanel();
        targetSettingsPanel.setLayout(new BoxLayout(targetSettingsPanel, BoxLayout.Y_AXIS));
        JPanel projectPathRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        JLabel projectPathLabel = new JLabel("プロジェクトパス:");
        projectPathRow.add(projectPathLabel);
        projectPathRow.add(projectPathField);
        projectPathRow.add(btnBrowseProject);
        JPanel analysisTargetRow = new JPanel(new FlowLayout(FlowLayout.LEFT, 6, 4));
        JLabel analysisTargetLabel = new JLabel("解析対象:");
        analysisTargetRow.add(analysisTargetLabel);
        analysisTargetRow.add(targetCombo);
        targetSettingsPanel.add(projectPathRow);
        targetSettingsPanel.add(analysisTargetRow);
        targetSettingsPanel.setVisible(false);
        btnTargetSettings.addActionListener(e -> {
            boolean expanded = !targetSettingsPanel.isVisible();
            targetSettingsPanel.setVisible(expanded);
            btnTargetSettings.setText(ui(uiLocale[0], "対象設定", "Target settings") + (expanded ? " ▾" : " ▸"));
            mainPanel.revalidate();
        });
        btnBrowseProject.addActionListener(e -> {
            JFileChooser chooser = new JFileChooser();
            chooser.setDialogTitle(ui(uiLocale[0], "解析するプロジェクトのディレクトリを選択", "Select project directory to analyze"));
            chooser.setFileSelectionMode(JFileChooser.DIRECTORIES_ONLY);
            String currentPath = projectPathField.getText().trim();
            File currentDirectory = currentPath.isEmpty() ? null : new File(currentPath);
            if (currentDirectory != null && currentDirectory.isDirectory()) {
                chooser.setCurrentDirectory(currentDirectory);
            } else if (!projBase.isEmpty()) {
                chooser.setCurrentDirectory(new File(projBase));
            }
            if (chooser.showOpenDialog(mainPanel) == JFileChooser.APPROVE_OPTION) {
                String selectedPath = chooser.getSelectedFile().getAbsolutePath();
                projectPathField.setText(selectedPath);
                btnTargetSettings.setToolTipText(ui(uiLocale[0], "解析対象: ", "Analysis target: ") + selectedPath);
            }
        });

        toolbarPanel.add(btnAnalyze);
        toolbarPanel.add(btnTargetSettings);
        toolbarPanel.add(chkDoubleClickSync);
        toolbarPanel.add(chkAutoRefresh);
        JPanel topPanel = new JPanel(new BorderLayout());
        topPanel.add(toolbarPanel, BorderLayout.NORTH);
        topPanel.add(targetSettingsPanel, BorderLayout.CENTER);
        mainPanel.add(topPanel, BorderLayout.NORTH);

        // Setup JCEF Browser
        JBCefBrowser browser = new JBCefBrowser();
        JBCefJSQuery jsQuery = JBCefJSQuery.create((JBCefBrowserBase) browser);

        ToolWindowHolder holder = new ToolWindowHolder();
        holder.browser = browser;
        holder.projectPathField = projectPathField;
        holder.targetCombo = targetCombo;
        holder.syncOnDoubleClick = chkDoubleClickSync.isSelected();
        holder.autoRefresh = chkAutoRefresh.isSelected();
        holder.chkDoubleClickSync = chkDoubleClickSync;
        holder.chkAutoRefresh = chkAutoRefresh;
        holder.uiLocale = uiLocale[0];
        holder.applyLocale = language -> {
            uiLocale[0] = language;
            btnAnalyze.setText(ui(language, "解析実行", "Analyze"));
            btnAnalyze.setToolTipText(ui(language, "指定したパスのモジュール依存関係を解析します", "Analyze module dependencies at the selected path"));
            btnBrowseProject.setText(ui(language, "参照…", "Browse…"));
            btnBrowseProject.setToolTipText(ui(language, "解析するプロジェクトのディレクトリを選択", "Select project directory to analyze"));
            projectPathField.setToolTipText(ui(language, "解析する Python プロジェクトのパス", "Path to the Python project to analyze"));
            projectPathLabel.setText(ui(language, "プロジェクトパス:", "Project path:"));
            analysisTargetLabel.setText(ui(language, "解析対象:", "Analysis target:"));
            btnTargetSettings.setText(ui(language, "対象設定", "Target settings") + (targetSettingsPanel.isVisible() ? " ▾" : " ▸"));
            btnTargetSettings.setToolTipText(ui(language, "解析対象: ", "Analysis target: ") + projectPathField.getText());
            chkDoubleClickSync.setText(ui(language, "ダブルクリック連動", "Sync on double-click"));
            chkDoubleClickSync.setToolTipText(ui(language,
                    "PyCharm側でファイルをダブルクリックして開いた時、自動で依存図を開きます (ModuleLoomからのオープン時は反応しません)",
                    "Open the dependency graph when you double-click a file in PyCharm"));
            chkAutoRefresh.setText(ui(language, "自動更新", "Auto refresh"));
            chkAutoRefresh.setToolTipText(ui(language,
                    "Python ファイルや moduleloom.toml の保存・追加・削除後に再解析します",
                    "Reanalyze after Python files or moduleloom.toml change"));
            targetCombo.repaint();
            mainPanel.revalidate();
        };
        holder.applyLocale.accept(uiLocale[0]);
        activeHolders.put(project, holder);

        browser.getJBCefClient().addDisplayHandler(new org.cef.handler.CefDisplayHandlerAdapter() {
            @Override
            public boolean onConsoleMessage(CefBrowser cefBrowser, org.cef.CefSettings.LogSeverity level, String message, String source, int line) {
                System.out.println("[ModuleLoom JS " + level + "] " + (source != null ? source : "") + ":" + line + " - " + message);
                return false;
            }
        }, browser.getCefBrowser());

        chkDoubleClickSync.addActionListener(e -> {
            holder.syncOnDoubleClick = chkDoubleClickSync.isSelected();
        });
        chkAutoRefresh.addActionListener(e -> {
            holder.autoRefresh = chkAutoRefresh.isSelected();
            if (!holder.autoRefresh) {
                holder.refreshTimer.stop();
            }
        });
        btnAnalyze.addActionListener(e -> {
            String path = projectPathField.getText().trim();
            btnTargetSettings.setToolTipText(ui(uiLocale[0], "解析対象: ", "Analysis target: ") + path);
            ApplicationManager.getApplication().executeOnPooledThread(() -> runAnalyze(project, holder, path.isEmpty() ? null : path, null));
        });
        projectPathField.addActionListener(e -> btnAnalyze.doClick());

        holder.refreshTimer = new Timer(500, e -> ApplicationManager.getApplication().executeOnPooledThread(() ->
                runAnalyze(project, holder, holder.currentAnalyzePath, null, drainChangedFiles(holder))));
        holder.refreshTimer.setRepeats(false);
        Disposer.register(toolWindow.getContentManager(), () -> {
            holder.refreshTimer.stop();
            activeHolders.remove(project, holder);
        });

        // Extract bundled web assets to user cache directory
        jsQuery.addHandler(query -> {
            return new JBCefJSQuery.Response(handleClientQuery(project, browser, query, targetCombo));
        });
        Path webDir = prepareWebAssets(initialPath, project.getBasePath(), jsQuery);

        targetCombo.addActionListener(e -> {
            String path = selectedAnalysisPath(project, targetCombo);
            if (path != null) {
                projectPathField.setText(path);
                btnTargetSettings.setToolTipText(ui(uiLocale[0], "解析対象: ", "Analysis target: ") + path);
            }
            ApplicationManager.getApplication().executeOnPooledThread(() -> runAnalyze(project, holder, path, null));
        });

        if (webDir != null && Files.exists(webDir.resolve("index.html"))) {
            browser.getJBCefClient().addLoadHandler(new CefLoadHandlerAdapter() {
                @Override
                public void onLoadEnd(CefBrowser cefBrowser, CefFrame frame, int httpStatusCode) {
                    if (!frame.isMain()) return;
                    String path = projectPathField.getText().trim();
                    cefBrowser.executeJavaScript("(function(){" +
                            "const p=document.getElementById('project-path-input');" +
                            "if(p&&!p.value){p.value='" + escapeJs(path) + "';}" +
                            "const trigger=function(){" +
                            "if(typeof window.__MODULELOOM_REANALYZE__==='function'){window.__MODULELOOM_REANALYZE__();}" +
                            "else{const b=document.getElementById('btn-analyze');if(b)b.click();}" +
                            "};" +
                            "if(typeof window.__MODULELOOM_REANALYZE__==='function'){trigger();}" +
                            "else{let a=0;const it=setInterval(function(){a++;if(typeof window.__MODULELOOM_REANALYZE__==='function'||a>20){clearInterval(it);trigger();}},100);}" +
                            "})();",
                            cefBrowser.getURL() != null ? cefBrowser.getURL() : "", 0);
                }
            }, browser.getCefBrowser());
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
        ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("ModuleLoom");
        if (toolWindow == null || !toolWindow.isVisible()) {
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

    private String handleClientQuery(Project project, JBCefBrowser browser, String query, JComboBox<String> targetCombo) {
        if (query == null || query.isEmpty()) return "null";

        if (query.contains("\"type\":\"command\"")) {
            ToolWindowHolder holder = activeHolders.get(project);
            String requestId = extractJsonField(query, "requestId");
            String command = extractJsonField(query, "command");
            String result;
            try {
                result = runPluginCommand(project, holder, command, query);
                return result;
            } catch (Exception error) {
                String message = error.getMessage() == null ? error.toString() : error.getMessage();
                return "{\"__moduleloom_error__\":" + jsonString(message) + "}";
            }
        }

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
            return "null";
        } else if (query.contains("\"type\":\"analyze\"") || query.contains("'type':'analyze'")) {
            ToolWindowHolder holder = activeHolders.get(project);
            if (holder != null) {
        // The web UI starts the initial analysis after its page has loaded.
            }
        }
        return "null";
    }

    private String runPluginCommand(Project project, ToolWindowHolder holder, String command, String request) throws Exception {
        if (holder == null) throw new IllegalStateException("ModuleLoom の状態を取得できません");
        if ("set_ui_locale".equals(command)) {
            String selected = extractJsonField(request, "locale");
            if (!"ja".equals(selected) && !"en".equals(selected)) throw new IllegalArgumentException("Unsupported UI locale");
            holder.uiLocale = selected;
            SwingUtilities.invokeLater(() -> {
                if (holder.applyLocale != null) holder.applyLocale.accept(selected);
            });
            return "{}";
        }
        String pathArg = extractJsonField(request, "path");
        String rootText = pathArg == null ? holder.lastResultRoot : pathArg;
        if (rootText == null) rootText = selectedAnalysisPath(project, holder.targetCombo);
        if (rootText == null) throw new IllegalStateException("解析対象を選択してください");
        Path root = Path.of(rootText).toRealPath();
        String source = extractJsonField(request, "source");
        String targetArg = extractJsonField(request, "target");
        String lineText = extractJsonField(request, "line");
        String kindArg = extractJsonField(request, "kind");
        String output = extractJsonField(request, "output");
        String lang = extractJsonField(request, "lang");
        String base = extractJsonField(request, "base");
        String head = extractJsonField(request, "head");
        String toolId = extractJsonField(request, "toolId");
        switch (command == null ? "" : command) {
            case "install_agent_skill": {
                String result = runProcess(root, List.of(findAnalyzerBinary(project), "--install-skill"), null, false);
                return jsonString(result.trim());
            }
            case "analyze_project": {
                List<String> analyzeArgs = new ArrayList<>(List.of(findAnalyzerBinary(project), "--json"));
                if ("true".equals(extractJsonField(request, "quality"))) analyzeArgs.add("--quality");
                analyzeArgs.add(root.toString());
                String raw = runProcess(root, analyzeArgs, null, false);
                int start = raw.indexOf('{');
                int end = raw.lastIndexOf('}');
                String json = (start >= 0 && end > start) ? raw.substring(start, end + 1) : raw.trim();
                holder.lastResultJson = json;
                holder.lastResultRoot = root.toString();
                holder.currentAnalyzePath = root.toString();
                return json;
            }
            case "list_fix_tools": {
                List<String> entries = new ArrayList<>();
                for (FixToolConfig tool : availableFixTools(root)) {
                    entries.add("{\"id\":" + jsonString(tool.id) + ",\"label\":" + jsonString(tool.label) + ",\"kinds\":" + jsonArray(tool.kinds) + "}");
                }
                return "[" + String.join(",", entries) + "]";
            }
            case "preview_cycle_fix": {
                if (toolId == null || source == null || lineText == null)
                    throw new IllegalArgumentException("循環改善候補が見つかりません。再解析してください");
                int line = Integer.parseInt(lineText);
                String quotedSource = Pattern.quote(source);
                String target = targetArg;
                String kind = kindArg;
                if ((target == null || target.isBlank() || kind == null || kind.isBlank()) && holder.lastResultJson != null) {
                    Pattern suggestion = Pattern.compile("\"suggestion\"\\s*:\\s*\\{[^}]*\"source\"\\s*:\\s*\"" + quotedSource + "\"[^}]*\"target\"\\s*:\\s*\"([^\"]+)\"[^}]*\"line\"\\s*:\\s*" + line + "[^}]*\"kind\"\\s*:\\s*\"([^\"]+)\"", Pattern.DOTALL);
                    Matcher suggestionMatch = suggestion.matcher(holder.lastResultJson);
                    if (suggestionMatch.find()) {
                        if (target == null || target.isBlank()) target = suggestionMatch.group(1);
                        if (kind == null || kind.isBlank()) kind = suggestionMatch.group(2);
                    }
                }
                if (target == null || target.isBlank()) target = source;
                if (kind == null || kind.isBlank()) kind = "unknown";

                final String finalKind = kind;
                FixToolConfig selectedTool = availableFixTools(root).stream().filter(tool -> tool.id.equals(toolId)).findFirst()
                        .orElseThrow(() -> new IllegalArgumentException("選択した外部ツールが見つかりません: " + toolId));
                if (!selectedTool.kinds.contains(finalKind) && !"ruff".equals(toolId)) {
                    throw new IllegalArgumentException(selectedTool.label + " はこの循環候補の種類（" + finalKind + "）に対応していません");
                }

                Path file = null;
                if (holder.lastResultJson != null) {
                    Pattern module = Pattern.compile("\"id\"\\s*:\\s*\"" + quotedSource + "\".*?\"absolute_path\"\\s*:\\s*\"([^\"]+)\"", Pattern.DOTALL);
                    Matcher moduleMatch = module.matcher(holder.lastResultJson);
                    if (moduleMatch.find()) {
                        String absolute = moduleMatch.group(1).replace("\\\\", "\\").replace("\\\"", "\"");
                        Path candidate = Path.of(absolute);
                        if (!candidate.isAbsolute()) candidate = root.resolve(candidate);
                        candidate = candidate.normalize();
                        if (Files.isRegularFile(candidate)) file = candidate;
                    }
                }
                if (file == null) {
                    Path candidate = root.resolve(source.replace('.', '/') + ".py");
                    if (Files.isRegularFile(candidate)) file = candidate;
                    else {
                        candidate = root.resolve(source.replace('.', '/') + "/__init__.py");
                        if (Files.isRegularFile(candidate)) file = candidate;
                    }
                }
                if (file == null) throw new IllegalArgumentException("対象モジュールが見つかりません: " + source);
                file = file.toRealPath();
                if (!file.startsWith(root) || !"py".equals(getExtension(file))) throw new IllegalArgumentException("対象ファイルは解析対象の Python ファイルである必要があります");
                byte[] original = Files.readAllBytes(file);
                List<String> previewArgs = expandFixArgs(selectedTool.previewArgs, root, file, source, target, line);
                List<String> applyArgs = expandFixArgs(selectedTool.applyArgs, root, file, source, target, line);
                String diff = "";
                try {
                    diff = runProcess(root, prepend(selectedTool.command, previewArgs), null, true);
                } catch (Exception ignored) {
                    diff = "";
                }
                if (!java.util.Arrays.equals(original, Files.readAllBytes(file))) throw new IllegalStateException(selectedTool.label + " のプレビュー用コマンドがファイルを変更しました");
                holder.pendingFix = new PendingFix(root, file, original, diff, selectedTool.command, selectedTool.label, previewArgs, applyArgs);
                return "{\"file\":" + jsonString(file.toString()) + ",\"diff\":" + jsonString(diff) + ",\"tool\":" + jsonString(selectedTool.label) + "}";
            }
            case "apply_cycle_fix": {
                PendingFix pending = holder.pendingFix;
                holder.pendingFix = null;
                if (pending == null || !pending.root.equals(root)) throw new IllegalStateException("差分を再表示してから適用してください");
                if (!java.util.Arrays.equals(pending.original, Files.readAllBytes(pending.file))) throw new IllegalStateException("差分表示後に対象ファイルが変更されました。再度プレビューしてください");
                String diff = runProcess(root, prepend(pending.command, pending.previewArgs), null, true);
                if (!pending.diff.equals(diff)) throw new IllegalStateException(pending.label + " の修正内容が変わりました。再度プレビューしてください");
                runProcess(root, prepend(pending.command, pending.applyArgs), null, false);
                if (java.util.Arrays.equals(pending.original, Files.readAllBytes(pending.file))) throw new IllegalStateException(pending.label + " はファイルを変更しませんでした");
                return jsonString(pending.file.toString());
            }
            case "generate_mkdocs": {
                if (output == null) throw new IllegalArgumentException("出力先を指定してください");
                String binary = findAnalyzerBinary(project);
                runProcess(root, List.of(binary, "--mkdocs", output, "--lang", lang == null ? "auto" : lang, root.toString()), null, false);
                return jsonString(output);
            }
            case "manual_action": {
                String action = extractJsonField(request, "action");
                if (action == null) throw new IllegalArgumentException("マニュアル操作を指定してください");
                List<String> args = new ArrayList<>(List.of(findAnalyzerBinary(project), "--manual", action, "--root", root.toString()));
                for (String key : List.of("docs", "output", "brief", "agent", "model", "id", "page", "asset", "format", "feedback")) {
                    String value = extractJsonField(request, key);
                    if (value != null) args.addAll(List.of("--" + key, value));
                }
                String mkdocsSettings = extractJsonField(request, "mkdocs_settings");
                if (mkdocsSettings != null) {
                    args.addAll(List.of("--mkdocs-settings", mkdocsSettings));
                }
                if ("true".equals(extractJsonField(request, "draft"))) args.add("--draft");
                if ("generate-task".equals(action)) args.addAll(List.of("--cli", findAnalyzerBinary(project)));
                return jsonString(runProcess(root, args, null, false).trim());
            }
            case "manual_capture_screenshot": {
                String taskId = extractJsonField(request, "id");
                if (taskId == null || !taskId.matches("[a-z][a-z0-9-]*")) throw new IllegalArgumentException("スクリーンショットのタグIDが不正です");
                Path assets = root.resolve("docs/assets");
                Files.createDirectories(assets);
                Path image = assets.resolve(taskId + ".png");

                String dataUrl = extractJsonField(request, "data");
                if (dataUrl != null && !dataUrl.isEmpty()) {
                    String base64 = dataUrl.contains(",") ? dataUrl.substring(dataUrl.indexOf(",") + 1) : dataUrl;
                    byte[] bytes = java.util.Base64.getDecoder().decode(base64.trim());
                    Files.write(image, bytes);
                } else {
                    ToolWindow toolWindow = ToolWindowManager.getInstance(project).getToolWindow("ModuleLoom");
                    if (toolWindow == null || !toolWindow.isVisible()) throw new IllegalStateException("ModuleLoom ツールウィンドウを表示してください");
                    Component component = toolWindow.getComponent();
                    if (!component.isShowing()) throw new IllegalStateException("撮影する画面が表示されていません");
                    Point location = component.getLocationOnScreen();
                    Rectangle bounds = new Rectangle(location.x, location.y, component.getWidth(), component.getHeight());
                    ImageIO.write(new Robot().createScreenCapture(bounds), "png", image.toFile());
                }
                runProcess(root, List.of(findAnalyzerBinary(project), "--manual", "record-screenshot", "--root", root.toString(), "--id", taskId, "--image", image.toString()), null, false);
                return jsonString(image.toString());
            }
            case "export_report": {
                String jsonData = extractJsonField(request, "json");
                if (jsonData == null) throw new IllegalArgumentException("解析データがありません");
                Path outDir = root.resolve(".moduleloom");
                Files.createDirectories(outDir);
                String stamp = new java.text.SimpleDateFormat("yyyyMMdd-HHmmss").format(new java.util.Date());
                Path jsonPath = outDir.resolve("moduleloom-analysis-" + stamp + ".json");
                Files.writeString(jsonPath, jsonData, StandardCharsets.UTF_8);
                return jsonString(jsonPath.toString());
            }
            case "git_changed_files": {
                String status = runProcess(root, List.of("git", "-C", root.toString(), "status", "--short"), null, false);
                List<String> files = new ArrayList<>();
                for (String item : status.split("\\R")) if (item.length() > 3 && item.substring(3).trim().endsWith(".py")) files.add(item.substring(3).trim());
                return jsonArray(files);
            }
            case "git_diff_files": {
                String diff = runProcess(root, List.of("git", "-C", root.toString(), "diff", "--name-only", base + ".." + head), null, false);
                List<String> files = new ArrayList<>();
                for (String item : diff.split("\\R")) if (item.endsWith(".py")) files.add(item);
                return jsonArray(files);
            }
            case "watch_project": holder.autoRefresh = true; holder.currentAnalyzePath = root.toString(); return "{}";
            case "stop_watching": holder.autoRefresh = false; holder.refreshTimer.stop(); return "{}";
            case "detect_editors": return "[\"pycharm\"]";
            case "open_in_editor": {
                String file = extractJsonField(request, "filePath");
                int line = lineText == null ? 1 : Integer.parseInt(lineText);
                if (file != null) ApplicationManager.getApplication().invokeLater(() -> {
                    VirtualFile vf = LocalFileSystem.getInstance().findFileByPath(file);
                    if (vf != null) FileEditorManager.getInstance(project).openTextEditor(new OpenFileDescriptor(project, vf, Math.max(0, line - 1), 0), true);
                });
                return "{}";
            }
            default: throw new IllegalArgumentException("Unsupported ModuleLoom command: " + command);
        }
    }

    private static List<FixToolConfig> availableFixTools(Path root) throws Exception {
        List<FixToolConfig> tools = new ArrayList<>();
        tools.add(new FixToolConfig("ruff", "Ruff (TC001)", ruffExecutable(root), List.of("type_only"),
                List.of("check", "--select", "TC001", "--unsafe-fixes", "--no-cache", "--diff", "{file}"),
                List.of("check", "--select", "TC001", "--unsafe-fixes", "--no-cache", "--fix-only", "{file}")));
        Path config = root.resolve("moduleloom.toml");
        if (!Files.isRegularFile(config)) return tools;
        String content = Files.readString(config, StandardCharsets.UTF_8);
        Matcher tables = Pattern.compile("(?m)^\\[fix_tools\\.([^\\]]+)\\]\\s*$").matcher(content);
        List<String[]> blocks = new ArrayList<>();
        while (tables.find()) blocks.add(new String[]{tables.group(1), String.valueOf(tables.start()), String.valueOf(tables.end())});
        for (String[] table : blocks) {
            String id = table[0];
            if ("ruff".equals(id)) throw new IllegalArgumentException("fix_tools.ruff は予約済みです");
            int start = Integer.parseInt(table[2]);
            Matcher nextTable = Pattern.compile("(?m)^\\s*\\[[^\\]]+\\]\\s*$").matcher(content);
            int end = content.length();
            if (nextTable.find(start)) end = nextTable.start();
            String block = content.substring(start, end);
            String label = tomlString(block, "label");
            String command = tomlString(block, "command");
            List<String> preview = tomlArray(block, "preview_args");
            List<String> apply = tomlArray(block, "apply_args");
            List<String> kinds = tomlArray(block, "kinds");
            if (command == null || preview == null || apply == null) throw new IllegalArgumentException("fix_tools." + id + " に command、preview_args、apply_args が必要です");
            if (kinds == null) kinds = List.of("type_only", "runtime", "unknown");
            if (kinds.stream().anyMatch(kind -> !List.of("type_only", "runtime", "unknown").contains(kind))) throw new IllegalArgumentException("fix_tools." + id + ".kinds に不明な種類があります");
            Path commandPath = Path.of(command);
            if (!commandPath.isAbsolute() && (command.contains("/") || command.contains("\\"))) commandPath = root.resolve(commandPath);
            tools.add(new FixToolConfig(id, label == null ? id : label, commandPath.toString(), kinds, preview, apply));
        }
        return tools;
    }
    private static String tomlString(String block, String key) {
        Matcher matcher = Pattern.compile("(?m)^\\s*" + Pattern.quote(key) + "\\s*=\\s*\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(block);
        return matcher.find() ? matcher.group(1).replace("\\\"", "\"").replace("\\\\", "\\") : null;
    }
    private static List<String> tomlArray(String block, String key) {
        Matcher assignment = Pattern.compile("(?s)(?m)^\\s*" + Pattern.quote(key) + "\\s*=\\s*\\[(.*?)\\]").matcher(block);
        if (!assignment.find()) return null;
        List<String> values = new ArrayList<>();
        Matcher items = Pattern.compile("\"((?:[^\"\\\\]|\\\\.)*)\"").matcher(assignment.group(1));
        while (items.find()) values.add(items.group(1).replace("\\\"", "\"").replace("\\\\", "\\"));
        return values;
    }
    private static List<String> expandFixArgs(List<String> args, Path root, Path file, String source, String target, int line) {
        List<String> expanded = new ArrayList<>();
        for (String arg : args) expanded.add(arg.replace("{project}", root.toString()).replace("{file}", file.toString())
                .replace("{source}", source).replace("{target}", target).replace("{line}", Integer.toString(line)));
        return expanded;
    }
    private static List<String> prepend(String executable, List<String> args) {
        List<String> command = new ArrayList<>(); command.add(executable); command.addAll(args); return command;
    }
    private static String getExtension(Path file) { String name = file.getFileName().toString(); int dot = name.lastIndexOf('.'); return dot < 0 ? "" : name.substring(dot + 1); }
    private static String ruffExecutable(Path root) {
        for (String relative : List.of(".venv/bin/ruff", "venv/bin/ruff", ".venv/Scripts/ruff.exe", "venv/Scripts/ruff.exe")) {
            Path candidate = root.resolve(relative);
            if (Files.isRegularFile(candidate)) return candidate.toString();
            if (root.getParent() != null) {
                Path parentCandidate = root.getParent().resolve(relative);
                if (Files.isRegularFile(parentCandidate)) return parentCandidate.toString();
            }
        }
        String home = System.getProperty("user.home");
        if (home != null) {
            for (String relative : List.of(".local/bin/ruff", ".cargo/bin/ruff")) {
                Path candidate = Path.of(home, relative);
                if (Files.isRegularFile(candidate)) return candidate.toString();
            }
        }
        return "ruff";
    }
    private static String runProcess(Path cwd, List<String> command, String stdin, boolean allowDiffExit) throws Exception {
        ProcessBuilder builder = new ProcessBuilder(command).directory(cwd.toFile()).redirectErrorStream(false);
        String bundledJscpd = findBundledJscpd();
        if (bundledJscpd != null) builder.environment().put("MODULELOOM_JSCPD_PATH", bundledJscpd);
        Process process = builder.start();
        if (stdin != null) process.getOutputStream().write(stdin.getBytes(StandardCharsets.UTF_8));
        process.getOutputStream().close();
        String stdout = new String(process.getInputStream().readAllBytes(), StandardCharsets.UTF_8);
        String stderr = new String(process.getErrorStream().readAllBytes(), StandardCharsets.UTF_8);
        int code = process.waitFor();
        if (code != 0 && !(allowDiffExit && code == 1 && !stdout.isBlank())) {
            String err = !stderr.isBlank() ? stderr.trim() : stdout.trim();
            throw new IllegalStateException(err.isBlank() ? String.join(" ", command) + " exited " + code : err);
        }
        return stdout;
    }
    private static String jsonString(String value) {
        return "\"" + value.replace("\\", "\\\\").replace("\"", "\\\"").replace("\n", "\\n").replace("\r", "\\r").replace("\t", "\\t") + "\"";
    }
    private static String jsonArray(List<String> values) { return "[" + values.stream().map(ModuleLoomToolWindowFactory::jsonString).collect(java.util.stream.Collectors.joining(",")) + "]"; }

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

    private static int countModules(String json) {
        if (json == null) return 0;
        Matcher matcher = Pattern.compile("\\\"modules\\\"\\s*:\\s*\\[").matcher(json);
        if (!matcher.find()) return 0;
        int count = 0;
        int objectDepth = 0;
        boolean quoted = false;
        boolean escaped = false;
        for (int i = matcher.end(); i < json.length(); i++) {
            char current = json.charAt(i);
            if (quoted) {
                if (escaped) escaped = false;
                else if (current == '\\') escaped = true;
                else if (current == '"') quoted = false;
            } else if (current == '"') {
                quoted = true;
            } else if (current == '{') {
                if (objectDepth == 0) count++;
                objectDepth++;
            } else if (current == '}') {
                objectDepth--;
            } else if (current == ']' && objectDepth == 0) {
                break;
            }
        }
        return count;
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

        if (holder.browser != null && holder.browser.getCefBrowser() != null) {
            final String finalBasePath = basePath;
            ApplicationManager.getApplication().invokeLater(() -> {
                if (holder.projectPathField != null && finalBasePath != null) {
                    holder.projectPathField.setText(finalBasePath);
                }
                if (holder.browser != null && holder.browser.getCefBrowser() != null) {
                    String pendingFile = targetFileToOpen == null ? "" : "window.__MODULELOOM_PENDING_FILE__='" + escapeJs(targetFileToOpen) + "';";
                    String syncUi = "(function(){" + pendingFile +
                            "const trigger=function(){" +
                            "const p=document.getElementById('project-path-input');" +
                            "if(p){p.value='" + escapeJs(finalBasePath) + "';}" +
                            "if(typeof window.__MODULELOOM_REANALYZE__==='function'){window.__MODULELOOM_REANALYZE__();}" +
                            "else{const b=document.getElementById('btn-analyze');if(b)b.click();}" +
                            "};" +
                            "if(typeof window.__MODULELOOM_REANALYZE__==='function'){trigger();}" +
                            "else{let a=0;const it=setInterval(function(){a++;if(typeof window.__MODULELOOM_REANALYZE__==='function'||a>20){clearInterval(it);trigger();}},100);}" +
                            "})();";
                    String url = holder.browser.getCefBrowser().getURL();
                    holder.browser.getCefBrowser().executeJavaScript(syncUi, url != null ? url : "", 0);
                }
            });
            return;
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
        String platform = currentPlatform();
        String filename = System.getProperty("os.name", "").toLowerCase().contains("win") ? "analyze.exe" : "analyze";
        if (platform != null) {
            String bundled = extractBundledExecutable(platform, filename);
            if (bundled != null) return bundled;
        }

        String projectBase = project.getBasePath();
        if (projectBase != null) {
            // Prefer the debug build while developing the plugin; it tracks the current source.
            Path debugPath = Path.of(projectBase, "target", "debug", filename);
            if (Files.isRegularFile(debugPath)) return debugPath.toString();
            Path releasePath = Path.of(projectBase, "target", "release", filename);
            if (Files.isRegularFile(releasePath)) return releasePath.toString();
        }
        return "analyze";
    }

    private static String findBundledJscpd() {
        String platform = currentPlatform();
        if (platform == null) return null;
        String filename = platform.startsWith("windows") ? "jscpd.exe" : "jscpd";
        return extractBundledExecutable(platform, filename);
    }

    private static String currentPlatform() {
        String osName = System.getProperty("os.name", "").toLowerCase();
        String architecture = System.getProperty("os.arch", "").toLowerCase();
        boolean arm64 = architecture.equals("aarch64") || architecture.equals("arm64");
        if (osName.contains("win") && !arm64) return "windows-x64";
        if (osName.contains("linux") && !arm64) return "linux-x64";
        if (osName.contains("mac")) return arm64 ? "macos-arm64" : "macos-x64";
        return null;
    }

    private static String extractBundledExecutable(String platform, String filename) {
        String resource = "/bin/" + platform + "/" + filename;
        try (InputStream input = ModuleLoomToolWindowFactory.class.getResourceAsStream(resource)) {
            if (input == null) return null;
            byte[] data = input.readAllBytes();
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(data);
            String hash = HexFormat.of().formatHex(digest, 0, 8);
            Path target = Path.of(System.getProperty("user.home"), ".cache", "moduleloom", "bin", platform, hash, filename);
            Files.createDirectories(target.getParent());
            if (!Files.exists(target)) Files.write(target, data);
            if (!platform.startsWith("windows")) target.toFile().setExecutable(true, false);
            return target.toString();
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    private Path prepareWebAssets(String initialProjectPath, String workspacePath, JBCefJSQuery jsQuery) {
        try {
            Path targetDir = Path.of(System.getProperty("user.home"), ".cache", "moduleloom", "web");
            Files.createDirectories(targetDir);

            String[] files = {"index.html", "assets/index.js", "assets/index.css"};
            for (String file : files) {
                try (InputStream is = getClass().getResourceAsStream("/web/" + file)) {
                    if (is != null) {
                        Path target = targetDir.resolve(file);
                        Files.createDirectories(target.getParent());
                        Files.copy(is, target, StandardCopyOption.REPLACE_EXISTING);
                    }
                }
            }
            Path index = targetDir.resolve("index.html");
            if (Files.isRegularFile(index)) {
                String html = Files.readString(index, StandardCharsets.UTF_8);
                // Ensure module script is converted to defer script for file:// CORS compatibility in Chromium/JCEF
                html = html.replace("<script type=\"module\" crossorigin", "<script defer");
                Path stylesheet = targetDir.resolve("assets/index.css");
                if (Files.isRegularFile(stylesheet)) {
                    String css = Files.readString(stylesheet, StandardCharsets.UTF_8);
                    html = html.replace("</head>", "<style>" + css + "</style></head>");
                }
                String bootstrap = "<style>#project-path-input,#btn-analyze,.editor-select-area,.watch-toggle-label{display:none !important;}</style>" +
                        "<script>window.__MODULELOOM_PROJECT_PATH__=" + jsonString(initialProjectPath == null ? "" : initialProjectPath) + ";" +
                        "window.__MODULELOOM_WORKSPACE_PATH__=" + jsonString(workspacePath == null ? "" : workspacePath) + ";" +
                        "window.__MODULELOOM_EDITOR__='pycharm';" +
                        "window.cefQuery=function(arg){" + jsQuery.inject("arg.request", "arg.onSuccess", "arg.onFailure") + "};" +
                        "let moduleLoomRequestId=0;window.__MODULELOOM_INVOKE__=function(command,args){return new Promise((resolve,reject)=>{const requestId=++moduleLoomRequestId;window.cefQuery({request:JSON.stringify({type:'command',requestId,command,args}),onSuccess:function(raw){try{const result=JSON.parse(raw);if(result&&result.__moduleloom_error__)reject(new Error(result.__moduleloom_error__));else resolve(result);}catch(e){reject(e);}},onFailure:function(code,msg){reject(new Error(msg));}});});};</script>";
                Files.writeString(index, html.replace("</head>", bootstrap + "</head>"), StandardCharsets.UTF_8);
            }
            return targetDir;
        } catch (Exception e) {
            e.printStackTrace();
            return null;
        }
    }

    private String extractJsonField(String json, String key) {
        Pattern pattern = Pattern.compile("\"" + Pattern.quote(key) + "\"\\s*:\\s*(?:\"((?:\\\\.|[^\"\\\\])*)\"|(-?\\d+|true|false))");
        Matcher matcher = pattern.matcher(json);
        if (matcher.find()) {
            if (matcher.group(2) != null) return matcher.group(2);
            String encoded = matcher.group(1);
            StringBuilder decoded = new StringBuilder(encoded.length());
            for (int i = 0; i < encoded.length(); i++) {
                char ch = encoded.charAt(i);
                if (ch != '\\' || ++i >= encoded.length()) {
                    decoded.append(ch);
                    continue;
                }
                switch (encoded.charAt(i)) {
                    case '"' -> decoded.append('"');
                    case '\\' -> decoded.append('\\');
                    case '/' -> decoded.append('/');
                    case 'n' -> decoded.append('\n');
                    case 'r' -> decoded.append('\r');
                    case 't' -> decoded.append('\t');
                    case 'b' -> decoded.append('\b');
                    case 'f' -> decoded.append('\f');
                    case 'u' -> {
                        if (i + 4 >= encoded.length()) throw new IllegalArgumentException("Invalid JSON Unicode escape");
                        decoded.append((char) Integer.parseInt(encoded.substring(i + 1, i + 5), 16));
                        i += 4;
                    }
                    default -> throw new IllegalArgumentException("Invalid JSON escape");
                }
            }
            return decoded.toString();
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
