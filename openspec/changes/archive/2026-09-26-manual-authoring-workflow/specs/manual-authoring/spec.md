## ADDED Requirements

### Requirement: Configure Manual Workspace
The application SHALL let users configure the manual template directory, output directory, high-level drafting brief, AI CLI, and optional model ID.

#### Scenario: Save manual settings
- **WHEN** a user saves valid project-relative paths and a drafting brief
- **THEN** ModuleLoom persists the settings for subsequent manual workspace sessions.

#### Scenario: Select an installed AI CLI
- **WHEN** a user opens the AI CLI selector
- **THEN** ModuleLoom offers Codex, Claude Code, Grok Build, and Agy and identifies which commands are available locally.

#### Scenario: Choose a model
- **WHEN** the user requests model candidates and the selected CLI exposes model discovery
- **THEN** ModuleLoom displays the candidates returned by that CLI.
- **WHEN** model discovery is unavailable or no model is specified
- **THEN** the user can enter a model ID or use the CLI default.

### Requirement: Create a Tagged Manual Draft
The application SHALL create an initial Markdown manual draft containing unique `ai:task` tags for content that needs generation.

#### Scenario: Create the first draft
- **WHEN** the user supplies a high-level brief and requests an AI draft
- **THEN** ModuleLoom creates a reviewable draft with provenance markers and does not overwrite existing templates.

### Requirement: Generate and Review Task Answers
The application SHALL scan `ai:task` tags for text, screenshot, and diagram work and track each generated answer against its instruction.

#### Scenario: Generate an answer
- **WHEN** the user requests generation for a task
- **THEN** ModuleLoom records the answer body, creation timestamp, and instruction hash.

#### Scenario: Detect changed instructions
- **WHEN** a task instruction changes after an answer was created
- **THEN** ModuleLoom marks that answer stale and strict builds reject it.

#### Scenario: Approve an answer
- **WHEN** the user approves a current answer
- **THEN** ModuleLoom records the approval timestamp and protects the approved answer from automatic regeneration.

#### Scenario: Generate a module diagram
- **WHEN** a diagram task is generated
- **THEN** ModuleLoom obtains the Mermaid graph from its analysis CLI MkDocs output.

#### Scenario: Capture a screenshot in PyCharm
- **WHEN** a screenshot task is captured from the PyCharm plugin
- **THEN** ModuleLoom saves a PNG of its tool window as a manual asset and records a Markdown image answer.

### Requirement: Build and Preview Manuals
The application SHALL support draft and strict MkDocs builds and preview generated pages and images.

#### Scenario: Build a draft
- **WHEN** the user builds a draft with incomplete tasks
- **THEN** ModuleLoom emits visible placeholders for missing or stale answers.

#### Scenario: Build a complete manual
- **WHEN** the user requests a strict build and every task has a current answer
- **THEN** ModuleLoom emits the MkDocs source tree and build timestamp.
- **WHEN** any answer is missing or stale
- **THEN** the strict build reports the affected task and fails.

#### Scenario: Preview an image asset
- **WHEN** the preview requests a generated documentation image
- **THEN** ModuleLoom serves supported image data only from inside the generated docs directory.
