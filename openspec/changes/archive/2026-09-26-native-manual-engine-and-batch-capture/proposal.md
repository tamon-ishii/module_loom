# Proposal: Native Manual Engine, Batch Screenshot Capture, and UI Unification

## Problem Statement
1. **Python Runtime Dependency**: The manual authoring subsystem previously embedded and executed a 980-line Python script (`manual.py`), requiring Python on the host and incurring process fork overhead.
2. **Manual Screenshot Pain**: When UI layout or styles changed, developers had to manually navigate to each tab and trigger individual screenshot captures.
3. **Single Responsibility Violations**: Previous AI outputs mixed disclaimers, annotations, or attribution footers into raw screenshots or diagrams.
4. **UI Redundancy**: An "Issues" popup modal duplicated the Code Diagnostics tab, an extra "Export MkDocs" button cluttered the module graph toolbar, and tabs were ambiguously labeled "マニュアル" vs "ドキュメント生成".

## Proposed Solution
1. **Native Rust Engine**: Migrate all scanning, hashing, task orchestration, AI CLI dispatching, and HTML inlining into `crates/analyzer/src/manual/`, delegating only the final HTML site build to external commands (`mkdocs`).
2. **Batch Screenshot Runner**: Add a one-click "📸 全スクショを一括自動撮影" button that programmatically navigates between tabs, renders active views (Cytoscape and DOM), and updates all image assets and preview builds at once.
3. **Single Responsibility Rule**: Enforce pure image tags (`![id](path)`) for screenshots and pure Mermaid fences for diagrams, reserving explanatory text for separate `kind=text` tasks.
4. **UI Streamlining**: Consolidate issues into the Code Diagnostics dashboard, remove redundant export buttons, and standardize on the "ドキュメント生成" tab name.
