/**
 * canvas_get_knowledge section: sticky-style
 * Shape node (formerly "sticky") color, font, and size guide.
 * `native/sticky` is legacy — use `native/shape` for new nodes.
 */
export const CONTENT = `## Shape (Sticky Note) Style Guide

> **Note on terminology**: \`native/sticky\` is a legacy element kind and
> must NOT be created. Everything below applies to the modern
> \`native/shape\` element, which uses the same color palette and
> font-size rules. Section names in this file still say "sticky" for
> historical reasons — read it as "shape node".

### Available Colors (config.color)

Color keys map to the **Diagram module** semantic palette (same hex values
as the \`.s-*\` classes used in SVG diagrams). See
\`packages/conductor/src/renderer/components/native/sticky-colors.ts\`
for the canonical source.

| Color   | Fill / Stroke (CSS rgb)        | Diagram class | When to use                                                    |
|---------|--------------------------------|---------------|----------------------------------------------------------------|
| yellow  | rgb(250,238,218) / rgb(133,79,11) | \`.s-chk\`     | Default notes, neutral process steps, generic content (Amber).|
| blue    | rgb(230,241,251) / rgb(24,95,165) | \`.s-proc\`    | Info / process / reference / "this is data".                  |
| green   | rgb(225,245,238) / rgb(15,110,86) | \`.s-agent\`   | Success, done state, "yes" branch endpoint, completion.       |
| pink    | rgb(252,235,235) / rgb(163,45,45) | \`.s-err\`     | Errors, warnings, "no" branch endpoint, failure. **Name kept for back-compat; renders light red.** |
| purple  | rgb(238,237,254) / rgb(83,74,183) | \`.s-msg\`     | Messages / IPC / cross-system links.                          |
| gray    | rgb(241,239,232) / rgb(95,94,90)  | \`.s-sub\`     | Start / end / terminal / neutral boundary nodes.              |

Notes:
- There is no literal pink anymore — use **pink** for error / warning semantics.
- Default border is 1px solid in the theme's stroke color. Set \`borderStyle\` only when you need a custom border.
- Use \`bgColor\` (CSS color string) to override the theme fill for one-off palettes.

### Font Size (config.fontSize)

Sticky text now defaults to a larger size based on element height, so you usually do NOT need to set fontSize. Only set it when you want explicit control.

- 20  — default body text for a standard note.
- 22  — compact labels and first-level mind-map branches.
- 24  — root node, section title, single-word emphasis.
- 18  — smallest supported secondary text; legacy smaller values are clamped.

Do NOT go below 18 for Chinese body text. Prefer 20-24 for anything that must remain readable in an overview. Do NOT exceed 26.

### Text Content

- Keep each shape node under 80 characters for readability.
- Prefer 1-3 word labels for flowchart / mindmap nodes.
- For longer content (a full paragraph, a multi-section brief), use \`native/document\` instead — it carries editable Markdown and persists to the project file.
- Multi-line: use \`\\n\` in the text field. Keep to 3 lines max.

### Default Shape Size

- Compact label: 2.5x1 grid units (200x80px). Related labels use 0.5-0.75 unit gaps.
- Standard note: 4x2 grid units (320x160px).
- For titles, use 3.5x1.25 and 24px; do not create a wide empty banner.

### Size-to-Content Matching (Important)

Do not make a shape larger than its content. Oversized boxes force the canvas to zoom out, making everything tiny.

| Content | Recommended grid size (w x h) | fontSize | Notes |
|---------|-------------------------------|----------|-------|
| 1-2 Chinese chars label | 2.5 x 1 | 22-24 | e.g. "开始"; auto-centered |
| 1 short Chinese line / 3-6 chars | 3 x 1 | 20-22 | e.g. "用户登录"; auto-centered |
| 2 short lines / 6-10 chars | 3.5 x 1.5 | 20 | Use slash or newline |
| Standard note (1-2 sentences) | 4 x 2 | 20 | Most common note |
| Detailed note (2-3 lines) | 5 x 2.5 | 20 | |
| Paragraph / long sentence | 5 x 3 | 20-22 | Use \`native/document\` instead for editable prose |
| Section title / mind-map root | 3.5 x 1.25 | 24 | Use the root as the title |

Rules:

- Width should match content width. A 4-char label does not need w=8.
- Height should barely clear the text. Single line → h=1. Two lines → h=1.5 or 2. Do not default to h=3+ "just in case".
- Prefer larger fontSize over a larger box. Compact labels default to 22px; do not request fontSize below 18.
- If text does not fit in w=5-7, h=3, use \`native/document\` instead of shrinking type.
- Leave 0.5-0.75 grid units between related nodes; use 1 unit only between semantic groups.
`;