---
name: conductor-canvas-control
description: Detailed guide for controlling the conductor canvas (canvas philosophy, mode classification, zoning conventions, element kinds, coordinates, layout patterns, capture/verify timing)
paths: []
---
 
# Conductor Canvas Control Guide
 
This skill is auto-loaded when Conductor mode is enabled. It provides
the detailed reference the agent needs to operate the 5 canvas tools
effectively. Read Sections 0-3 before touching any tool — they decide
*what* you should build; Sections 4+ tell you *how*.
 
## 0. What This Canvas Is (Read This First)
 
By default, **one project maps to one persistent canvas** that lives
across the entire project lifetime — many separate conversations, not
one. It needs to work well as two different things at once:
 
1. **Project memory** — the durable, referenceable record of things
   worth not forgetting: a finalized architecture, a decision and why
   it was made, a diagram explaining how a subsystem works, a
   benchmark result. Once something is on the canvas, it should still
   make sense to someone (including a future instance of yourself)
   who opens it cold, weeks later, with zero conversation context.
2. **Project kanban** — the living, actively-edited surface: a
   todo/backlog, an in-progress board, a status tracker that gets
   ticked and moved as the project actually progresses.
These two purposes want different tools and different treatment. Most
of the failure modes this skill guards against — turning a diagram
request into a pile of sticky-note busywork, or letting a board decay
into unreadable clutter — come from not telling these two apart.
 
**A canvas is judged over its lifetime, not in a single turn.** Success
is not "I created N elements this turn." Success is: if the user, or
you in a future session, opens this canvas cold, does it read as an
organized, legible project board? Judge every action against that bar,
not against a checklist of operations completed. When you report back
to the user, describe *what the canvas now shows and how it's
organized* — never a count of operations or elapsed time.
 
## 1. Decide the Mode Before You Touch a Tool
 
Before creating anything, classify what you're about to produce.
 
**Workspace mode** — the content will be touched again: checked off,
dragged, reordered, edited incrementally over the life of the project.
Examples: a todo list, a kanban column, a decision log that gets
appended to, a status tracker.
→ Use native elements as independent, addressable objects:
`native/sticky`, `native/connector`, `widget/task-list`, etc.
Coordinate math and grid layout (Section 5) apply here, because
positions need to stay stable and predictable for future incremental
edits.
 
**Deliverable mode** — the content is a finished piece meant to be
read as a whole: an architecture diagram, a flowchart, a comparison
table, an explanatory infographic, a write-up of a finding. Nobody is
going to reach in and drag one box three pixels to the left; the value
is the composed whole.
→ Create **one** `widget/dynamic` element with hand-authored SVG/HTML.
Do NOT decompose it into a pile of sticky notes and connectors. Text
wrapping, spacing, connector routing, and typographic hierarchy are
things HTML/CSS/SVG already solve — let them, instead of guessing
coordinates and font sizes element by element.
 
If a request is genuinely mixed ("画一个项目状态总览，包括架构图和当前
todo"), decompose it by content, not by tool: the todo portion becomes
workspace-mode elements, the architecture portion becomes one
deliverable-mode `widget/dynamic`, placed side by side in their
respective zones (Section 2).
 
**When in doubt**: requests that start with "画一个 / 讲解 / 展示 /
说明" (draw / explain / show / illustrate) are asking for a finished
graphic — default to deliverable mode. Requests that start with
"记录 / 待办 / 追踪 / 看板" (record / todo / track / board) are asking
for a living structure — default to workspace mode.
 
## 2. Canvas Zoning — One Canvas, Many Kinds of Content
 
Because a single canvas persists for an entire project and holds a mix
of workspace and deliverable content, an unzoned canvas degrades into
noise within a few sessions. Maintain a light spatial convention:
 
- **Status strip** (top, full width, y ≈ 0–3 grid units): one element
  summarizing current project state at a glance — phase, last update,
  open blockers. At most one of these should exist; update it in
  place across sessions, don't create a new one each time.
- **Board zone** (left third): workspace-mode elements — todo/kanban,
  decision log, open questions. This is the part of the canvas that
  changes almost every session.
- **Reference zone** (right two-thirds): deliverable-mode elements —
  architecture diagrams, explanatory graphics, key findings. This is
  the part of the canvas that changes rarely, once something is
  "finalized."
This is a default, not a rule etched in stone. If the user has already
organized the canvas differently, read and preserve their layout
instead of imposing this one.
 
**Before adding anything to an existing canvas**: call
`canvas_list_elements`, then infer the existing zone structure from
the position clusters of what's already there. Never assume the
canvas is empty, and never assume today's session's convention applies
if a different one is already visible. Place new content into the
zone it semantically belongs to, respecting existing gaps and
alignment, rather than appending wherever there happens to be empty
space.
 
**If the canvas is new/empty**, propose the default zoning above and
lay the first elements out accordingly — briefly tell the user you're
doing this so they can redirect if they'd rather organize it another
way.
 
## 3. When to Proactively Write to the Canvas
 
Because the canvas is meant to function as project memory — not just a
drawing surface invoked on request — some things are worth writing
down without being explicitly asked to:
 
- A decision that will matter later gets finalized in conversation
  ("就这么定了", "先这样，不改了" or equivalent) → append it to the
  decision log as a short sticky.
- A todo item discussed in conversation gets completed → check it off
  or move it, rather than leaving the board stale and out of sync
  with reality.
- A deliverable (an architecture, a benchmark result, a finished
  design) reaches a state the user is satisfied with → this is a
  signal it belongs in the reference zone, not left to scroll away in
  chat history.
**Restraint matters as much as the trigger.** Don't touch the canvas
for exploratory chat, half-formed ideas, or anything the user hasn't
converged on — writing too eagerly turns the board into noise and
defeats its purpose as a clean project memory. When genuinely unsure
whether something is canvas-worthy, ask the user in one short line
rather than writing it silently.
 
## 4. Element Kinds and Config Schema
 
### 4.1 Workspace-mode elements
 
#### native/sticky — sticky note
```ts
config: {
  text: string,                                  // main body text
  color?: 'yellow' | 'blue' | 'green' | 'pink' | 'purple' | 'gray',
  fontSize?: number,                             // px; compact labels default 22, notes default 20+
}
```
Use `canvas_fill_content` to change `text`. Use `canvas_style_element`
to change `color` / `fontSize`.
 
Stickies are for short, self-contained notes — a todo item, a decision
line, a single open question. **If the text you're about to put in a
sticky needs more than ~2 short lines to say what it means, that's a
signal the content belongs in deliverable mode as a `widget/dynamic`
instead of a sticky you're about to force-fit.** Don't fight the
container by guessing a smaller `fontSize` to cram more text in —
shrink the content, or change the tool.
 
#### native/image — image element
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
 
#### native/file — file attachment card
```ts
config: {
  fileName: string,
  mimeType?: string,
  url?: string,
}
```
Use `canvas_fill_content` only — files have no visual style fields.
 
#### native/connector — arrow / line between two elements
```ts
config: {
  source: string | { nodeId: string, anchorId?: string, edgePosition?: number },
  target: string | { nodeId: string, anchorId?: string, edgePosition?: number },
  routingMode?: 'elbow' | 'curve', // defaults to elbow
  label?: string,
  color?: string,
  strokeStyle?: 'solid' | 'dashed' | 'dotted',
  startMarker?: 'none' | 'arrow' | 'open-arrow' | 'circle' | 'diamond' | 'bar',
  endMarker?: 'none' | 'arrow' | 'open-arrow' | 'circle' | 'diamond' | 'bar',
}
```
Use `canvas_fill_content` to change `source` / `target`, route geometry,
or label. Use `canvas_style_element` to change color, stroke pattern,
or markers. Connector width is fixed and must not be offered as a
style choice.
 
Connectors are for wiring independently editable workspace objects,
including editable architecture/framework diagrams. Use one
`widget/dynamic` instead only when the diagram is intentionally a single
immutable composition rather than a set of addressable nodes.
 
#### widget/task-list, widget/note-pad, widget/pomodoro, widget/news-board
Each has its own content fields; read the current config via
`canvas_list_elements` before patching. These are the default tools
for the board zone: a `widget/task-list` per project phase or column
is usually a better fit than a stack of individual to-do stickies.
 
### 4.2 Deliverable-mode element
 
#### widget/dynamic — the default for single-composition deliverables
 
Use `widget/dynamic` with `sourceCode` (HTML or SVG) as the default for:
- Architecture / framework diagrams and flowcharts that are meant to
  remain one composition rather than independently editable nodes
- Comparison tables, timelines, dashboards
- Any content whose value is a single coherent composition someone
  will look at as a whole, rather than grab individual pieces of
Common module templates: `canvas_get_knowledge({section: "widget-usage"})`.
 
Example:
```
canvas_create_element({
  kind: "widget/dynamic",
  position: { x: 5, y: 5, w: 6, h: 4 },
  sourceCode: "<div style='padding:12px;font-family:sans-serif'><h3>My Todo</h3><ul><li>Task A</li><li>Task B</li></ul></div>"
})
```
 
Reuse the same hex values from the color palette (Section 6) inside
your SVG/HTML so a decision-log sticky and an error state inside a
diagram read as the same design language, not two unrelated
color systems.
 
Because editing a `widget/dynamic` means editing one `sourceCode`
string — not re-coordinating a dozen elements — there is no excuse to
skip the verify/fix loop in Section 7 for anything you build here.

### 4.3 Widget/dynamic Sizing and Density Budget

The canvas auto-fits content but preserves a readable zoom floor. A very
wide composition may therefore require panning instead of shrinking into
an unreadable overview. Oversized widgets still waste viewport space and
weaken hierarchy, so keep their bounds tight around the content.

Apply these constraints to every `widget/dynamic`:

- **Hard upper limit: w ≤ 14, h ≤ 10** (1120 x 800 px). Never exceed it.
- **Preferred range for explanatory diagrams: w=8-12, h=5-8.** Start here
  and only approach the hard limit when the content truly needs it.
- **Density budget: 4-6 visual sections total.** If the diagram needs
  more, it is too dense — split it into an overview widget plus a detail
  widget on demand, rather than cramming everything into one container.
- **Each section = short title + at most one subtitle of ≤5 Chinese
  words.** Do not put full sentences, file-line details, or long
  descriptions inside boxes. Prefer hierarchy over enumeration.
- **If the user asks for "all the details" (every file, every component,
  every metric)**, keep a concise overview widget in the reference zone
  and offer to create a second detailed widget. Do not turn the overview
  into a wall of text.

For the full design system — including the scaling rationale, typography,
spacing, color palette, and splitting strategy — call
`canvas_get_knowledge({ section: "widget-design-system" })` before
building any non-trivial widget/dynamic element.

These rules apply only to deliverable-mode `widget/dynamic` elements;
workspace-mode native elements follow the coordinate and sizing formulas
in Section 5.

## 5. Coordinate System & Layout Patterns (Workspace Mode Only)
 
These formulas apply to **workspace-mode** elements — sticky,
connector, native widgets — where stable, addressable coordinates
matter because the user or a future session needs to keep editing
them incrementally. `widget/dynamic` content handles its own internal
layout inside its SVG/HTML (see the diagram-authoring guidance
elsewhere for viewBox and box-sizing rules) — do not try to lay out a
diagram's internal nodes using this grid system.
 
### Coordinate system
- The canvas is a fixed-size plane: **40 x 30 grid units** (1 unit =
  80px, total 3200 x 2400 px).
- `position.x` / `position.y` is the **top-left corner** of the
  element, in **grid units**.
- `position.w` / `position.h` are width / height in **grid units**.
- Default sticky size: **3 x 2** grid units (240 x 160 px) — but prefer the tighter content-matched sizes in the table below.
- Keep a **1 grid unit** margin from canvas edges.
- Leave **0.5-0.75 grid units** between related elements; use 1 unit between semantic groups.

### Elbow-first organized routing

- Default every editable connector to `routingMode: 'elbow'`, including
  architecture maps, dependency graphs, flowcharts, and mind maps.
- Curve is opt-in only when the user explicitly asks for an organic
  curved relation.
- For one-to-many top-down flow, center the parent above an evenly
  spaced child row. Connect parent bottom to each child top so the elbow
  routes overlap into one horizontal trunk with short vertical drops.
- For left-to-right flow, align children in one column and connect
  parent right to child left so routes share one vertical trunk with
  short horizontal branches.
- Fan-in is the same pattern reversed. Never connect siblings to fake
  the bus; preserve direct semantic source-to-target relations.
- Keep each family on consistent anchor sides, split dense graphs into
  levels/groups, and move nodes until connectors stop crossing or
  passing through unrelated elements.
### Sticky Sizing by Content

Oversized stickies are a common failure mode: they force the default
viewport to zoom out, shrinking all text. Match the sticky size to the
content tightly:

| Content | position.w | position.h | fontSize | Example |
|---------|-----------|-----------|----------|---------|
| 1-2 Chinese chars label | 2.5 | 1 | 22-24 | "开始" |
| 1 short Chinese line / 3-6 chars | 3 | 1 | 20-22 | "用户登录" |
| 2 short lines / 6-10 chars | 3.5 | 1.5 | 20 | "主菜单 / 搜索框" |
| Standard sticky (1-2 sentences) | 4 | 2 | 20 | "明天发布 v0.2" |
| Detailed note (2-3 lines) | 5 | 2.5 | 20 | "Review API 设计" |
| Paragraph / long sentence | 5 | 3 | 20-22 | "需要补全错误处理" |
| Section title / mind-map root | 3.5 | 1.25 | 24 | "Phase 1: 基础架构" |

Rules:

- Width should match content width; a 4-char label does not need w=8.
- Height should barely clear the text. Single line → h=1. Two lines → h=1.5 or 2.
- Prefer larger fontSize over a larger box. Compact labels auto-center at 22px; explicit values below 18px are clamped.
- If text does not fit in w=5-7, h=3, switch to widget/dynamic.
- Use 0.5-0.75 unit gaps inside a cluster and 1 unit between groups.

### Editable mind-map density

Use `canvas_batch_create` only when the user should be able to edit/move
individual nodes. Use the root as the title; never add a separate wide title
sticky. Root = 3.5x1.25 at 24px, first-level branch = 3x1 at 22px,
leaf = 2.5x1 at 20px. Keep the entire cluster inside the smallest practical
bounding box. A finished mind map meant to be read as one composition should
instead be one `widget/dynamic` SVG/HTML element.

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
## 6. Color Palette — One Visual Language Across Both Modes
 
Color keys map to the **Diagram module** semantic palette (same hex
values as the `.s-*` classes used in SVG diagrams). See
`packages/conductor/src/renderer/components/native/sticky-colors.ts`
for the canonical source. Use these same hex values inside
`widget/dynamic` SVG/HTML too — the point is one shared house style,
not one palette for native elements and an improvised one for widgets.
 
| Name    | Fill / Stroke (CSS rgb)             | Diagram class | Use case                                              |
|---------|-------------------------------------|---------------|-------------------------------------------------------|
| yellow  | rgb(250,238,218) / rgb(133,79,11)   | `.s-chk`      | Default, neutral notes (Amber)                       |
| blue    | rgb(230,241,251) / rgb(24,95,165)   | `.s-proc`     | Info, reference                                      |
| green   | rgb(225,245,238) / rgb(15,110,86)   | `.s-agent`    | Success, done                                        |
| pink    | rgb(252,235,235) / rgb(163,45,45)   | `.s-err`      | **Errors / warnings**. Name kept for back-compat; renders light red. |
| purple  | rgb(238,237,254) / rgb(83,74,183)   | `.s-msg`      | Messages / cross-system links                        |
| gray    | rgb(241,239,232) / rgb(95,94,90)    | `.s-sub`      | Start / end / terminal / neutral                     |
 
## 7. Verify: Capture, Analyze, Fix Loop
 
`canvas_capture` saves the screenshot to a file and returns the
`filePath`. To analyze it visually, ALWAYS follow with `vision_analyze`:
 
1. **Capture**: `canvas_capture({scope: "viewport"})` → returns `{filePath, width, height}`
2. **Analyze**: `vision_analyze({image_path: "<filePath from step 1>", question: "Check layout: are elements overlapping? Is alignment correct? Any text overflow? Any visual issues?"})` → returns text description
3. **Fix**: if the analysis surfaces a problem, fix it before reporting —
   adjust the `widget/dynamic` `sourceCode`, or move/resize the native
   elements involved. Editing a `widget/dynamic` is a single string
   edit; there is no cost excuse to skip this.
4. **Re-verify once** after fixing. If a residual issue remains after
   two rounds, report it honestly rather than looping indefinitely or
   silently shipping it.
**When this is required, not optional:**
- Any time you finish composing or editing a `widget/dynamic` —
  deliverable-mode content is exactly the case where the fix is cheap
  and the quality bar (someone will look at the whole thing) is high.
- After any workspace-mode layout change touching 3+ elements at once.
- When the user explicitly asks "how does it look" / "检查一下画布".
**Still avoid:**
- Capturing to read text content — use `canvas_list_elements` instead.
- Capturing after every single micro-operation (only after meaningful
  composition/layout changes).
- More than one capture per 5 conversation turns for the *same*
  unchanged content — but a finished `widget/dynamic` or a finished
  multi-element layout always earns its one verify pass.
## 8. Tool Call Order
 
1. **Sense** — `canvas_list_elements` to read current state and infer
   existing zones (Section 2). Always start here; never assume
   element state from a prior turn, and never assume the canvas is
   empty or unorganized. This is also the REQUIRED first step before
   any move/resize/delete/fill/style on existing elements — those
   tools reject stale state with STALE_STATE.
2. **Classify** — decide workspace vs deliverable mode (Section 1) and
   which zone the content belongs to (Section 2), before deciding on
   individual tool calls.
3. **Plan** — decide moves / resizes / content / style changes, or the
   `widget/dynamic` sourceCode. Group related changes so they happen
   in one turn.
4. **Act** — call the canvas tools. Move/resize are independent;
   content and style both merge-patch config, so call them in either
   order.
5. **Verify** — the capture → analyze → fix loop from Section 7.
6. **Report** — describe what the canvas now shows and how it's
   organized, in the user's language. Judge success against visual
   and organizational standards — no overlap, no overflow, zone
   consistency, todo/status accuracy — never against a count of
   operations completed or time elapsed.
## 9. Common Mistakes to Avoid
 
- Do not decompose a single explanatory diagram into many sticky
  notes and connectors — see Section 1. A `widget/dynamic` is almost
  always the better tool for a finished, explanatory graphic.
- Do not report success as "N elements created in M seconds" — that
  framing is a symptom of treating the canvas as a task list instead
  of a deliverable. Report against the visual/organizational criteria
  in Section 8.
- Do not assume the canvas is empty or a blank task surface — always
  sense existing zones first (Section 2) before adding anything.
- Do not skip the verify/fix loop for `widget/dynamic` content just
  because it feels quick — editing `sourceCode` is cheap, so there's
  no excuse not to check it once (Section 7).
- Do not silently write unconverged or exploratory content to the
  canvas as if it were settled memory (Section 3).
- Do not pass `canvasId` to the 5 tools — it is injected automatically
  from the session binding.
- Do not call `element.update` (legacy orchestrator tool) for content
  changes — it replaces config wholesale. Use `canvas_fill_content` /
  `canvas_style_element` for merge-patch semantics.
- Do not assume a sticky's color is `yellow` — always read the current
  config via `canvas_list_elements` first.
- Do not move elements off-canvas (negative coords or beyond 40x30 grid units).
