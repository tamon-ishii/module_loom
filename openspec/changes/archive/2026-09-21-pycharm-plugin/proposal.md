# Proposal: PyCharm Plugin Integration for PyModuleMgr

## Why
Currently, PyModuleMgr runs as a standalone desktop application via Tauri and invokes external editors (PyCharm, VS Code) through URL schemes (`jetbrains://`) or command-line commands. While functional, users working inside PyCharm must switch windows between the IDE and the Tauri app.
By providing a dedicated PyCharm plugin with an embedded Tool Window (using JetBrains Runtime's built-in JCEF), developers can inspect the Python module graph, detect circular dependencies, and jump directly into code without ever leaving PyCharm.

## What Changes
1. **Rust Analyzer CLI Enhancement**:
   - Add `--json` flag to `crates/analyzer/src/bin/analyze.rs` so that any external caller (including the PyCharm plugin) can easily obtain the complete `AnalysisResult` JSON output.
2. **PyCharm Plugin (`plugins/pycharm`)**:
   - Create an IntelliJ Platform Tool Window plugin (`PyModuleMgr`) located on the right/bottom sidebar.
   - Embed the Cytoscape-based interactive module graph view inside the Tool Window via JCEF (`JBCefBrowser`).
   - Implement bi-directional communication between the Web view and PyCharm via `JBCefJSQuery`:
     - Double-clicking a module node or clicking "Open in Editor" in the inspector sends a query to PyCharm, which uses `FileEditorManager` to immediately open the target file and navigate to the specific line.
   - Add an Action / Toolbar button ("Refresh Graph" / "Analyze Current Project") that automatically acquires the active project directory, executes the analyzer engine, and streams the graph data to the Tool Window.
3. **Packaging and Installation**:
   - Provide a zero-dependency build script using PyCharm's bundled JBR (`javac`) and standard Python packaging to generate the plugin jar (`pymodulemgr-pycharm.jar`).
   - Allow automatic installation into the user's PyCharm plugin directory (`~/.local/share/JetBrains/PyCharm2026.2/` or `PyCharm2025.3/`).

## Capabilities
- `pycharm-integration`: Tool Window embedding, JCEF web view, and editor line navigation.

## Non-goals
- Rewriting the Cytoscape visualization logic in native Swing/JavaFX (JCEF allows reusing the high-performance modern web visualization directly inside PyCharm).
- Supporting legacy IDEs without JCEF support.
