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
- **Annotation Processing with MarkIts (`crates/markits`)**:
  - **MANDATORY**: All screenshot post-processing and annotations MUST use the `markits` module (`crates/markits`) to ensure visual harmony, unified styling, and professional polish across all manual pages.
  - **Philosophy**: *"AI decides WHAT to explain; MarkIts decides HOW to render it beautifully."* Do not attempt manual pixel coordinate hacking; specify the target UI element (`#btn-id` or bounds) and semantic intent, and let MarkIts handle deterministic 8-direction layout, canvas boundary protection, collision avoidance, and SVG rendering.
  - **Supported MarkIts Annotation Types**:
    - `callout`: Text pill with automatic arrow routing towards the target.
    - `pin`: Number/icon pinhead with pointer and connected pill label (Skitch style).
    - `badge`: Circular step marker (e.g. `step: 1`, `text: "1"`).
    - `spotlight`: Darkens the canvas with a translucent backdrop, cutting out the target area for high contrast.
    - `rounded-rect` / `rect`: Clean, rounded highlight boundary around the target element.
    - `circle` / `ellipse`: Circular highlight.
    - `arrow`: Clear directional indicator arrow.
    - `label`: Readable text with white outline for high contrast against any UI theme.
    - `bullseye`: Concentric focus rings with center dot.
  - **Semantic Styles**:
    - `primary` (blue), `danger` (red), `warning` (amber), `info` (cyan), `step` (emerald), `pink` (Skitch magenta).
  - **Rendering**:
    - Use `moduleloom-analyze --manual markits-render --json '<Scene JSON>'` (or `crates/markits` binary) to generate high-resolution SVG overlays.
  - **In `ai:task` Screenshot Prompts**:
    - Specify UI elements and semantic MarkIts instructions, e.g.:
      `<!-- ai:task id=step-analyze kind=screenshot\n#btn-analyze を markits callout: "解析を実行", style: primary, position: bottom でハイライト\n-->`
      `<!-- ai:task id=step-settings kind=screenshot\n#btn-settings を markits pin: "?", text: "設定画面", style: info でハイライト\n-->`

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
