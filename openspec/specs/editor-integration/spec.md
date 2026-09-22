# editor-integration Specification

## Purpose
Enables one-click navigation from graph nodes and diagnostic items directly to the corresponding file and line number in external editors such as PyCharm and VS Code.

## Requirements

### Requirement: Jump to File and Line in External Editor
The system SHALL trigger external editor navigation when a user requests code jump on a module node or diagnostic entry.

#### Scenario: Jump to file in PyCharm
- **WHEN** the configured preferred editor is PyCharm and the user clicks "Open in PyCharm" or double-clicks a module/line
- **THEN** the system launches or focuses PyCharm at the target file and line number via JetBrains URL scheme or CLI tool.

#### Scenario: Jump to file in VS Code
- **WHEN** the configured preferred editor is VS Code and the user clicks "Open in Editor"
- **THEN** the system invokes VS Code via `vscode://file/{path}:{line}` URL scheme or `code --goto` command.

### Requirement: Editor Preference Configuration
The system SHALL allow users to select their default external editor and configure custom launch commands if necessary.

#### Scenario: Auto-detect and choose installed editors
- **WHEN** the user opens application settings
- **THEN** the system displays detected editors (PyCharm, VS Code) and allows selecting the primary editor for code navigation.
