# Proposal: Smart Annotations, Settings Popup, AI Tag Lifecycle Rules, and Release v1.1.0

## Problem Statement
1. **Manual Image Post-Processing**: When capturing screenshots for user manuals, authors frequently needed to crop, draw red circles/boxes, add arrows, or insert callout descriptions using external image editors (Photoshop, Paint), leading to out-of-sync documentation and high maintenance friction.
2. **Scattered Output & AI Configuration**: Path configurations (HTML output directory vs. Markdown source directory) were ambiguously placed or omitted in the UI, making it difficult to distinguish between the generated static site destination and source draft files.
3. **Ambiguous AI Tag Usage**: Documentation drafts lacked clear syntactic formatting rules, identifier constraints, single-responsibility boundaries (mixing disclaimers into screenshot blocks), and lifecycle state definitions.
4. **Platform Discrepancies**: Description metadata across PyCharm's `plugin.xml` and VS Code's `package.json` lagged behind new features, preventing users on JetBrains Marketplace and VS Code Marketplace from discovering the 3-asset documentation engine.

## Proposed Solution
1. **Smart Screenshot Annotation Engine**: Extend background capture logic to detect natural language directives and selectors (`#id`, `.class`, keywords, circles, arrows, quoted callout text), automatically overlaying red highlight borders, directional arrows (`⬇` / `⬆`), and speech-bubble text labels directly on captured visual assets.
2. **Centralized Settings Popup**: Introduce a dedicated settings modal managing HTML output target (default: `manual`), Markdown source directory (default: `docs`), target project path, and AI CLI/model parameters in one unified dialog.
3. **Strict AI Tag Rules & Documentation**: Codify strict naming (`^[a-z][a-z0-9-]*$`), newline requirements, single-responsibility separation, and SHA-256 state tracking in both the README and documentation guide.
4. **Full Platform Parity & v1.1.0 Release**: Synchronize rich descriptions and change-notes into `plugin.xml` and `package.json`, update README feature highlights and screenshots, and release v1.1.0 across desktop, PyCharm, and VS Code.
