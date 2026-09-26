---
name: moduleloom-manual-builder
description: Build the ModuleLoom PyCharm manual from Markdown templates with ai:task instructions, real screenshots, timestamped generated blocks, and feedback by block ID. Use when creating or revising the manual, not for ordinary app builds.
---

# ModuleLoom manual builder

Templates live in `docs/`. This skill supplies the AI work; `scripts/manual.py` handles task discovery, timestamps, provenance, and rendering. ModuleLoom's マニュアル tab calls the same script through the analyzer CLI. AI generation uses the selected locally authenticated Codex, Claude Code, Grok Build, or Agy CLI; no API key is configured in ModuleLoom. `npm run build` builds the app and does not run this manual workflow.

## Initial draft

When asked to create the first draft, read the user's brief in `manual/brief.md` or the brief supplied by the app. Use its audience, goal, scope, and free-form directions to propose the page outline and write Markdown templates under `docs/`. Keep editable human text outside task tags. Put content needing verification or repeated generation inside uniquely identified `ai:task` tags. Include screenshot tasks only for real UI states that can be captured. Add a diagram task where a module relationship helps the reader; its answer must come from the ModuleLoom CLI. Do not overwrite existing templates or answers during initial draft creation; revise only the pages the user selected. Run `scan` and `build --draft` so the user can review the outline with unresolved tasks visible.

## Tags and files

Each instruction is an HTML comment in a template:

```markdown
<!-- ai:task id=pycharm-overview kind=screenshot
#btn-manual-batch-capture を赤枠で囲んだ操作画面を撮影
-->

<!-- ai:task id=pycharm-overview-guide kind=text
Explain the main layout and what key items the user should observe in the overview screenshot.
-->
```

- **Naming Rules**: `id` must start with a lowercase letter and contain only lowercase letters, digits, and hyphens (`^[a-z][a-z0-9-]*$`). Must be unique across all templates.
- **Kinds (`kind`)**: `screenshot`, `diagram`, or `text`.
- **Strict Separation (Single Responsibility Rule)**:
  - `screenshot`: Must ONLY output the pure image tag (`![id](assets/<filename>.png)`). Do not include captions, notes, or descriptions.
  - `diagram`: Must ONLY output the pure fenced code block (````mermaid ... ````). Do not include footers, captions, or disclaimers.
  - `text`: Dedicated task for any explanations, walkthroughs, annotations, or guides.
- **Annotation Hint in Screenshot Tasks**:
  - You can specify DOM selectors (`#btn-id` or `.class`) or natural language keywords (`全スクショ`, `保存`, `ダイアグラム`, `API`, `ビルド`, etc.) in the prompt.
  - If the prompt includes `丸`, `円`, or `circle`, a red circular highlight is overlaid; otherwise, a rounded red rectangular frame is drawn.

Markdown outside tags is human-authored and must be preserved. `{{BUILD_TIMESTAMP}}` is replaced with the UTC build time.

## Build workflow

1. Run `moduleloom-analyze --manual scan --root .` to list tasks, instructions, and answer status. Read the relevant template and product code before writing an answer. Do not invent UI labels or screenshots.
2. For screenshot tasks: Use GUI batch capture ("📸 全スクショ一括撮影") or run `moduleloom-analyze --manual record-screenshot --root . --id <id> --image <path>`. The answer must ONLY contain `![<id>](assets/<filename>)`.
3. For diagram tasks: Run `moduleloom-analyze --manual generate-diagram-all --root .` to extract Mermaid diagrams from the codebase AST. The answer must ONLY contain the fenced Mermaid code block.
4. For text tasks: Run `moduleloom-analyze --manual generate-task --root . --id <id> --feedback "<feedback>"` to let locally authenticated AI CLIs generate or refine the explanation.
5. Run `moduleloom-analyze --manual build --root . --draft` for draft preview with visible placeholders, or `moduleloom-analyze --manual build --root .` for a strict complete build.
6. In the output, each generated section is wrapped in `<!-- ai:generated ... -->` and `<!-- /ai:generated -->`. If the user gives feedback, identify the block by its `id`, revise it, and rebuild.
7. To protect a block from unintentional overwrites, run `moduleloom-analyze --manual approve --root . --id <id>` or approve it in the GUI.

Do not trigger AI work from an ordinary package build or silently overwrite a screenshot with a fabricated image. Report unresolved task IDs and the exact output location.
