# Proposal: AI-Assisted Manual Authoring

## Why

ModuleLoom already helps developers inspect modules and repair code. Users also need a guided way to create and maintain user manuals without leaving the desktop app or PyCharm. The workflow should use locally installed, authenticated AI CLIs so users can apply their existing subscriptions without configuring API keys.

## What Changes

- Add a Manual workspace to the desktop application and PyCharm plugin.
- Let users configure MkDocs template, output, and brief paths, then enter a high-level drafting brief.
- Support Codex, Claude Code, Grok Build, and Agy CLIs, optional model IDs, and model discovery when the CLI supports it.
- Add AI-generated drafts and per-task text, diagram, and screenshot answers with timestamps and instruction hashes.
- Let users review and approve answers, build draft or strict MkDocs output, and preview Markdown and images.
- Generate module diagrams through the bundled ModuleLoom analysis CLI.

## Capabilities

- `manual-authoring`: Create and review AI-assisted MkDocs manuals from tagged Markdown templates.

## Non-goals

- Calling hosted model APIs directly or storing API credentials.
- Replacing MkDocs as the initial publishing format.
- Generating module diagrams independently of the ModuleLoom CLI.
