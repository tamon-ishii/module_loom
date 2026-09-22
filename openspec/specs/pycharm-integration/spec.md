# Capability: PyCharm Integration

## Purpose
Enables running and interacting with the ModuleLoom module dependency graph directly inside PyCharm's Tool Window, with instant code navigation to editor tabs.

## Requirements

### Requirement: PyCharm Tool Window Registration
The plugin SHALL register a Tool Window with ID `ModuleLoom` on the right sidebar of the IDE.
- Anchor: `right` or `bottom`
- Name: `ModuleLoom`
- It SHALL display a toolbar with:
  - "Analyze Active Project" button
  - "Zoom Fit" button
  - Status/Info label showing the number of modules and cycles

### Requirement: JCEF Embedded Visualization
The Tool Window SHALL embed a Chromium Embedded Framework (JCEF) browser (`JBCefBrowser`).
- It SHALL load the interactive module dependency visualization.
- It SHALL support zooming, panning, layout toggling, package grouping, and cycle highlighting.

### Requirement: Bi-directional Communication & Editor Navigation
- The web frontend SHALL use `JBCefJSQuery` to send events to PyCharm.
- When an `open_file` message with `{ filePath, line }` is received from the web view:
  - PyCharm SHALL locate the `VirtualFile` for the path.
  - PyCharm SHALL open the file in the editor tab and place the caret on the specified line using `FileEditorManager` and `OpenFileDescriptor`.

### Requirement: Project Analysis Execution
- When the user triggers "Analyze Active Project":
  - The plugin SHALL identify the base directory of the currently open PyCharm project.
  - The plugin SHALL execute the analyzer engine (`analyze --json <path>`).
  - The resulting JSON SHALL be passed to the web view via `executeJavaScript("window.renderModuleGraph(...)")`.
