# Design Document: PyCharm Plugin Integration

## Architecture Overview

The integration consists of three primary components:
1. **Rust Engine (`analyze --json`)**:
   - Compiles down to a standalone native binary `analyze`.
   - Accepts a directory path and outputs the full JSON structure (`AnalysisResult`).
2. **PyCharm Plugin (Java / IntelliJ Platform SDK)**:
   - Plugin ID: `com.pymodulemgr.pycharm`
   - Tool Window Factory: `PyModuleMgrToolWindowFactory` implements `ToolWindowFactory` and `DumbAware`.
   - UI Layout:
     - Top Action Toolbar: "Analyze Project", "Fit View", Project path display.
     - Center Component: `JBCefBrowser.getComponent()`.
   - Interaction Bridge:
     - `JBCefJSQuery`: registers JavaScript callback `window.pycharmJumpToFile(filePath, line)`.
     - Calls `ApplicationManager.getApplication().invokeLater(...)` to open files via `FileEditorManager`.
3. **Embedded Web Graph UI**:
   - An HTML/JS bundle based on Cytoscape.js and Dagre.
   - Listens for `window.renderModuleGraph(jsonPayload)`.
   - Includes node click handlers that call `window.pycharmJumpToFile(mod.absolute_path, 1)`.

## Data Flow
```
[User clicks "Analyze" in PyCharm]
  │
  ▼
PyModuleMgrToolWindowFactory (PyCharm)
  │ executes
  ▼
Rust CLI: `analyze --json <project.basePath>`
  │ returns JSON
  ▼
JBCefBrowser.getCefBrowser().executeJavaScript("window.renderModuleGraph(" + json + ")")
  │ renders Cytoscape graph
  ▼
[User double-clicks node / clicks inspector link]
  │ calls
  ▼
window.pycharmJumpToFile(path, line)
  │ JBCefJSQuery callback
  ▼
PyCharm FileEditorManager.openTextEditor(OpenFileDescriptor)
  │
  ▼
[PyCharm Editor opens target file at line]
```
