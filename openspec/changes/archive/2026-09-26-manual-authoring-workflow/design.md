# Design: AI-Assisted Manual Authoring

## Architecture

- Markdown templates under a configurable docs path contain `ai:task` comments for text, screenshot, or diagram work.
- A Python helper scans tasks, invokes a locally installed AI CLI, records answer metadata, checks approvals, builds the MkDocs source tree, and serves preview content.
- The Rust analyzer CLI exposes these helper actions. Tauri and PyCharm bridge UI actions to the bundled analyzer executable.
- The browser UI is shared by the desktop application and PyCharm plugin. PyCharm additionally captures the visible ModuleLoom tool window through its host bridge.

## Answer Lifecycle

Each answer records its creation time and SHA-256 of the task instruction. Changing the instruction makes an answer stale. Users can approve current answers; generation protects current approved answers. Draft builds show placeholders for missing or stale answers, while strict builds fail until all answers are current.

## AI CLI Integration

The application uses local Codex, Claude Code, Grok Build, or Agy commands and their existing login state. The model field is optional. Candidate discovery is implemented where supported and otherwise explains that users can enter a model ID or use the CLI default.

## Diagrams and Screenshots

Diagram tasks invoke the ModuleLoom analyzer with MkDocs output and extract its Mermaid graph. Screenshot tasks are captured by the PyCharm plugin and stored as project assets. Preview asset access is restricted to the generated documentation directory.

## Packaging

The analyzer CLI embeds the manual helper. Desktop packaging stages the CLI as a bundled resource; PyCharm packaging includes it with the web UI. The helper requires Python 3.10 or later.
