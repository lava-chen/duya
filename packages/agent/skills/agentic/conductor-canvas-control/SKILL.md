---
name: conductor-canvas-control
description: Detailed guide for controlling the conductor canvas (element kinds, coordinates, layout patterns, capture timing)
paths: []
---

# Conductor Canvas Control Guide

This skill is auto-loaded when Conductor mode is enabled. It provides
the detailed reference the agent needs to operate the 5 canvas tools
effectively. The short prompt overlay (CONDUCTOR_MAIN_AGENT_PROMPT)
covers the basics; this document goes deeper.

## Element Kinds and Config Schema

### native/sticky — sticky note
```ts
config: {
  text: string,                                  // main body text
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'gray',
  fontSize?: number,                             // px, default 14
}
```
Use `canvas_fill_content` to change `text`. Use `canvas_style_element`
to change `color` / `fontSize`.

### native/image — image element
```ts
config: {
  url: string,            // data: or https: URL
  fileName?: string,
  borderRadius?: number,  // px
  opacity?: number,       // 0..1
}
```
Use `canvas_fill_content` to change `url` / `fileName`. Use
`canvas_style_element` to change `borderRadius` / `opacity`.

### native/file — file attachment card
```ts
config: {
  fileName: string,
  mimeType?: string,
  url?: string,
}
```
Use `canvas_fill_content` only — files have no visual style fields.

### native/connector — arrow / line between two elements
```ts
config: {
  source: string,         // element id at the start
  target: string,         // element id at the end
  stroke?: string,        // CSS color
  strokeWidth?: number,   // px
  endMarker?: 'arrow' | 'none',
}
```
Use `canvas_fill_content` to change `source` / `target` (rewire).
Use `canvas_style_element` to change `stroke` / `strokeWidth` /
`endMarker`.

### widget/* — embedded mini-apps
Kinds: `widget/task-list`, `widget/note-pad`, `widget/pomodoro`,
`widget/news-board`. Each has its own content fields; read the current
config via `canvas_list_elements` before patching.

### widget/dynamic: Agent-Generated HTML/SVG

When sticky/tag cannot meet the user's need, use `widget/dynamic` with `sourceCode`:
- Todolist, checklist → HTML with checkboxes
- Dashboard metric card → styled HTML div
- Flowchart with custom styling → SVG
- Kanban board, comparison table → HTML grid
- Any structured/visual content → HTML or SVG

Common module templates: `canvas_get_knowledge({section: "widget-usage"})`.

Example:
canvas_create_element({
  kind: "widget/dynamic",
  position: { x: 5, y: 5, w: 6, h: 4 },
  sourceCode: "<div style='padding:12px;font-family:sans-serif'><h3>My Todo</h3><ul><li>Task A</li><li>Task B</li></ul></div>"
})

## Coordinate System

- The canvas is a fixed-size plane: **40 x 30 grid units** (1 unit = 80px, total 3200 x 2400 px).
- `position.x` / `position.y` is the **top-left corner** of the element, in **grid units**.
- `position.w` / `position.h` are width / height in **grid units**.
- Default sticky size: **3 x 3** grid units (240 x 240 px).
- Keep a **1 grid unit** margin from canvas edges.
- Leave **1 grid unit** gap between elements.

## Layout Patterns

### Grid layout
For N elements in a grid:
- Compute columns = ceil(sqrt(N)), rows = ceil(N / columns)
- Cell width = (canvasWidth - 2*margin - (columns-1)*gap) / columns
- Cell height = (canvasHeight - 2*margin - (rows-1)*gap) / rows
- Standard gap = 24px

### Vertical list
- x = margin (left-aligned) or centered
- y = margin + i * (elementHeight + gap)
- Standard elementHeight = 80px, gap = 16px

### Alignment
To align a set of elements by edge:
- left:   set every element's x = min(xs)
- right:  set every element's x = max(xs + ws) - its w
- top:    set every element's y = min(ys)
- bottom: set every element's y = max(ys + hs) - its h

### Spacing
To distribute evenly between two endpoints (a, b) for N elements:
- step = (b - a) / (N - 1)
- position_i = a + i * step

## Color Palette (sticky notes)

Color keys map to the **Diagram module** semantic palette (same hex values
as the `.s-*` classes used in SVG diagrams). See
`packages/conductor/src/renderer/components/native/sticky-colors.ts` for
the canonical source.

| Name    | Fill / Stroke (CSS rgb)             | Diagram class | Use case                                              |
|---------|-------------------------------------|---------------|-------------------------------------------------------|
| yellow  | rgb(250,238,218) / rgb(133,79,11)   | `.s-chk`      | Default, neutral notes (Amber)                       |
| blue    | rgb(230,241,251) / rgb(24,95,165)   | `.s-proc`     | Info, reference                                      |
| green   | rgb(225,245,238) / rgb(15,110,86)   | `.s-agent`    | Success, done                                        |
| pink    | rgb(252,235,235) / rgb(163,45,45)   | `.s-err`      | **Errors / warnings**. Name kept for back-compat; renders light red. |
| purple  | rgb(238,237,254) / rgb(83,74,183)   | `.s-msg`      | Messages / cross-system links                        |
| gray    | rgb(241,239,232) / rgb(95,94,90)    | `.s-sub`      | Start / end / terminal / neutral                     |

## When to Capture

`canvas_capture` saves the screenshot to a file and returns the `filePath`. To analyze it visually, ALWAYS follow with `vision_analyze`:

1. **Capture**: `canvas_capture({scope: "viewport"})` → returns `{filePath, width, height}`
2. **Analyze**: `vision_analyze({image_path: "<filePath from step 1>", question: "Check layout: are elements overlapping? Is alignment correct? Any visual issues?"})` → returns text description

Use this two-step flow:
- After major layout changes the user will judge visually
- When verifying alignment, spacing, or overlap after arrangement
- When the user explicitly asks "how does it look" / "检查一下画布"

Do NOT capture:
- To read text content (use `canvas_list_elements` instead)
- After every single operation (only after meaningful layout changes)
- More than once per 5 conversation turns (token cost)

## Tool Call Order

1. **Sense** — `canvas_list_elements` to read current state. Always
   start here; never assume element state from a prior turn. This is
   also the REQUIRED first step before any move/resize/delete/fill/style
   on existing elements — those tools reject stale state with STALE_STATE.
2. **Plan** — decide moves / resizes / content / style changes.
   Group related changes so they happen in one turn.
3. **Act** — call the canvas tools. Move/resize are independent; content
   and style both merge-patch config, so call them in either order.
4. **Verify** — `canvas_capture` + `vision_analyze` two-step flow (ONLY if visual judgment is needed).
5. **Report** — describe what changed in natural language, in the
   user's language.

## Common Mistakes to Avoid

- Do not pass `canvasId` to the 5 tools — it is injected automatically
  from the session binding.
- Do not call `element.update` (legacy orchestrator tool) for content
  changes — it replaces config wholesale. Use `canvas_fill_content` /
  `canvas_style_element` for merge-patch semantics.
- Do not assume a sticky's color is `yellow` — always read the current
  config via `canvas_list_elements` first.
- Do not move elements off-canvas (negative coords or beyond 40x30 grid units);
