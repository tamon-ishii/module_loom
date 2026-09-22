package com.moduleloom;

import com.intellij.openapi.application.ApplicationManager;
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
import java.util.Map;
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
        JButton btnAnalyze = new JButton("⟳ 再解析");
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
        chkDoubleClickSync.setToolTipText("PyCharm側でファイルをダブルクリックして開いた時、自動で依存図を開きます (ModuleLoomからのオープン時は反応しません)");

        toolbarPanel.add(new JLabel("解析対象:"));
        toolbarPanel.add(targetCombo);
        toolbarPanel.add(btnAnalyze);
        toolbarPanel.add(chkDoubleClickSync);
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

        btnAnalyze.addActionListener(e -> {
            ApplicationManager.getApplication().executeOnPooledThread(() -> runAnalyze(project, holder, null, null));
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

    private static void runAnalyze(Project project, ToolWindowHolder holder, @Nullable String overridePath, @Nullable String targetFileToOpen) {
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
        String binaryPath = findAnalyzerBinary();
        if (binaryPath == null) {
            String errorJs = "document.getElementById('status-info').textContent = 'Error: analyze binary not found';";
            holder.browser.getCefBrowser().executeJavaScript(errorJs, holder.browser.getCefBrowser().getURL(), 0);
            return;
        }

        try {
            ProcessBuilder pb = new ProcessBuilder(binaryPath, "--json", basePath);
            pb.redirectErrorStream(false);
            Process process = pb.start();

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
                String errJs = "document.getElementById('status-info').textContent = 'Analysis exited with code " + exitCode + "';";
                holder.browser.getCefBrowser().executeJavaScript(errJs, holder.browser.getCefBrowser().getURL(), 0);
            }
        } catch (Exception ex) {
            ex.printStackTrace();
            String errJs = "document.getElementById('status-info').textContent = 'Analysis error: " + escapeJs(ex.getMessage()) + "';";
            holder.browser.getCefBrowser().executeJavaScript(errJs, holder.browser.getCefBrowser().getURL(), 0);
        }
    }

    private static String findAnalyzerBinary() {
        Path localPath = Path.of("/home/ishii/PycharmProjects/pymodulemgr/target/release/analyze");
        if (Files.exists(localPath)) {
            return localPath.toString();
        }
        return "analyze";
    }

    private Path prepareWebAssets() {
        try {
            Path targetDir = Path.of(System.getProperty("user.home"), ".cache", "moduleloom", "web");
            Files.createDirectories(targetDir);

            String[] files = {"index.html", "cytoscape.min.js", "cytoscape-dagre.min.js"};
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
}
