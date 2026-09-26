# Capability: PyCharm Integration

## Purpose
Enables running and interacting with the ModuleLoom module dependency graph directly inside PyCharm's Tool Window, with instant code navigation to editor tabs.

## Requirements

### Requirement: PyCharm Tool Window Registration
The plugin SHALL register a Tool Window with ID `ModuleLoom` on the right sidebar of the IDE.

#### Scenario: Register tool window
- **WHEN** PyCharm launches with the ModuleLoom plugin installed
- **THEN** it registers a tool window on the right sidebar displaying analysis and zoom controls.

### Requirement: JCEF Embedded Visualization
The Tool Window SHALL embed a Chromium Embedded Framework (JCEF) browser (`JBCefBrowser`).

#### Scenario: Load visualization
- **WHEN** the user opens the ModuleLoom tool window
- **THEN** it loads the interactive module visualization supporting zoom, pan, and package groupings.

### Requirement: Bi-directional Communication & Editor Navigation
The web frontend SHALL communicate with the IDE to navigate source code.

#### Scenario: Jump to editor position
- **WHEN** an `open_file` message with file path and line number is emitted
- **THEN** PyCharm locates the file, opens it in an editor tab, and moves the caret to the requested line.

### Requirement: Project Analysis Execution
The plugin SHALL execute the analyzer engine and render results.

#### Scenario: Analyze active project
- **WHEN** the user triggers project analysis
- **THEN** the plugin resolves the project base directory, executes the native analyzer binary, and updates the graph visualization.
