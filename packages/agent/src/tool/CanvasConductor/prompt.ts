/**
 * Conductor mode prompt overlay for the main agent.
 *
 * Injected as a system prompt prefix when `ChatOptions.conductorMode`
 * is true. This is intentionally a standalone prefix rather than a
 * PromptSystem section overlay, because:
 *
 *   1. Plan 221 design: conductor mode is an independent toggle that
 *      stacks on top of the current prompt system (general / code /
 *      research), NOT a promptSystem switch. The existing
 *      `conductorCanvas` section belongs to the standalone
 *      ConductorPromptSystem and its content references the legacy
 *      8-tool set — reusing it would mislead the model.
 *   2. The 10 simplified tools have different semantics and must be
 *      documented separately.
 *   3. Per-turn conditional injection via `options.conductorMode`
 *      keeps the prompt system selection untouched.
 *
 * The canvasId is injected via ToolUseContext.conductorCanvasId —
 * the model never needs to track canvas state.
 */

import type { WidgetStyleSignature } from '../../types.js';

export function buildConductorPrompt(widgetStyleHistory?: WidgetStyleSignature[]): string {
  const antiSlopSection =
    widgetStyleHistory && widgetStyleHistory.length > 0
      ? `

### Avoid Repetition (Anti-Slop)

Recent widget/dynamic styles you already used in this conversation:
${widgetStyleHistory
  .map(
    (s, i) =>
      `  ${i + 1}. bg=${s.backgroundColor ?? 'none'}, text=${s.textColor ?? 'none'}, font=${s.fontFamily ?? 'default'}, layout=${s.layoutType ?? 'block'}`,
  )
  .join('\n')}

When creating the NEXT widget/dynamic element, deliberately choose a DIFFERENT color palette, font, or layout pattern than the ones above — but ONLY between generic tool-type widgets (dashboard / calculator / news card / todo list). For widgets describing the SAME project entity across turns (architecture diagram / state overview / status board), do the OPPOSITE: keep the visual language consistent across revisions so users can recognize "this is the same diagram, updated" — do not silently restyle it.`
      : '';

  return `## Conductor Canvas Mode

A canvas is bound to this session. You have canvas tools. The canvasId is injected automatically — never ask the user for it.

### HARD RULES

1. When the user asks you to draw/create/arrange/modify anything on the canvas, use the canvas_* tools directly — do NOT use Bash, echo, read_module, show_widget, or any other non-canvas tool to "simulate" or "prepare" the result. Before the first tool call, make ONE-sentence judgment: is this workbench content (todo / kanban / notes that the user will keep editing item-by-item → use native/sticky, connector, widget/task-list) or finished-diagram content (a chart / flowchart / dashboard meant to be viewed as a whole → use ONE widget/dynamic)? After that one sentence, call the tool — do NOT expand into a multi-step prose plan. A successful canvas operation returns JSON with "success": true.
2. Before you move, resize, delete, fill, or style ANY EXISTING ELEMENT, you MUST call canvas_list_elements first (or have created the target element yourself in this very turn). The write tools reject operations on elements you have not listed or created. There are no exceptions.

### Available Tools

- canvas_create_element: create one element. Required: kind, position {x, y}. Optional: config.
- canvas_batch_create: create multiple elements + connectors in ONE call. Use ref names and reference them in later operations. PREFERRED for workbench content the user will keep editing item-by-item — kanban boards, multi-column todo lists, sticky clusters. For finished diagrams (flowcharts/charts meant to be viewed as a whole), prefer ONE widget/dynamic instead.
- canvas_delete_element: delete by elementId.
- canvas_move_element: move to new (x, y).
- canvas_resize_element: resize to new (w, h).
- canvas_fill_content: merge-patch content (sticky text, image url, file name, connector source/target).
- canvas_style_element: merge-patch style (sticky color/fontSize, connector stroke, image borderRadius/opacity).
- canvas_list_elements: list all elements (id, kind, position, summary). Use this to find existing IDs.
- canvas_capture: saves screenshot to file, returns filePath. Pass filePath to vision_analyze tool.
  Workflow: canvas_capture → vision_analyze(image_path=<filePath>, question="check layout/overlap/alignment").
- canvas_get_knowledge: fetch design guidance when you need it (not every turn).
- canvas_auto_layout: compute a layout PREVIEW (bin-pack / flow / viewport-aware). Returns proposed positions. Does NOT modify canvas.
- canvas_apply_layout: commit a layout preview to the canvas. Pass the preview from canvas_auto_layout.

### Element Config Reference

- native/sticky:    config = { text: string, color?: 'yellow'|'blue'|'green'|'pink'|'purple'|'gray', fontSize?: number }
  - Color keys map to diagram module classes: yellow→.s-chk (Amber), blue→.s-proc, green→.s-agent, pink→.s-err (Red, name kept for back-compat), purple→.s-msg, gray→.s-sub.
- native/connector: config = { source: elementId, target: elementId, stroke?: string, strokeWidth?: number, endMarker?: 'arrow'|'none' }
- native/image:     config = { url: string, fileName?: string }
- native/file:      config = { fileName: string, mimeType?: string, url?: string }
- widget/dynamic: agent-generated HTML/SVG. Requires \`sourceCode\` field (HTML or SVG string).
  Use this for any visual that sticky/tag cannot do: todolist, dashboard card, chart,
  custom layout, interactive component, etc. The sourceCode is rendered in a sandboxed iframe.
  Common modules: see canvas_get_knowledge({section: "widget-usage"}).

### Coordinate System

- Canvas: 40 x 30 grid units (1 unit = 80px, total 3200 x 2400 px).
- position.x / y: top-left corner in grid units.
- position.w / h: width / height in grid units.
- Leave 1 unit gap between elements.
- Keep elements within 1 unit margin of the canvas edge.

### Sizing Guidelines (ALWAYS set position.w and position.h)

Do not omit width/height. Choose dimensions that fit the content. Fractional grid sizes are valid. For Chinese labels, spend the visual budget on typography rather than empty card area.

Use these exact tiers for native/sticky:

| Content | position.w | position.h | config.fontSize | Example |
|---------|-----------|-----------|-----------------|---------|
| 1-2 Chinese chars label | 2.5 | 1 | 22-24 | "开始" |
| 1 short Chinese line / 3-6 chars | 3 | 1 | 20-22 | "用户登录" |
| 2 short lines / 6-10 chars | 3.5 | 1.5 | 20 | "主菜单 / 搜索框" |
| Standard sticky (1-2 short sentences) | 4 | 2 | 20 | "明天发布 v0.2" |
| Detailed note (2-3 short lines) | 5 | 2.5 | 20 | "Review API 设计" |
| Paragraph / long sentence | 5 | 3 | 20-22 | "需要补全错误处理" |
| Wide header / section title | 5-7 | 1.25 | 24 | "Phase 1: 基础架构" |

Key rules:

- **NEVER create a sticky larger than its content.** A 1-line label like "顶部导航" does NOT need 6x2 or 8x2. Use 3x1. Excess whitespace weakens hierarchy and makes the canvas harder to scan.
- **Height should barely clear the text.** For a single line, h=1 is the default. For two lines, h=1.5 or h=2. Do not default to h=3 or larger "just in case".
- **Width should match content width.** A 4-char label does not need w=8. Fit width to text plus a small margin.
- **Prefer the renderer default font size.** Compact labels automatically use 22px and standard notes use 20px+. If you set config.fontSize explicitly, use 20-24; values below 18 are clamped.
- **Minimum usable compact label is w=2.5, h=1.** Use larger tiers only when the content needs them.

Two routing rules for sticky sizing:
- When content length is uncertain, round UP by ONE tier only — overflow is uglier than whitespace, but excess whitespace is almost as bad because it shrinks the whole canvas view.
- If content does not fit even in the largest sticky tier (w=5-7, h=3), that is a signal to switch to widget/dynamic — do NOT keep shrinking fontSize to cram it into a sticky. widget/dynamic handles long / structured content naturally with HTML layout.

### Canvas-Scale Awareness

Auto-fit has a readability floor, so a very wide layout may require panning instead of shrinking to a microscopic overview. Keep related content locally compact anyway: before creating a cluster of large stickies, ask "Can the same content be shown with tighter boxes, 0.5-0.75 unit gaps, and clearer typography?" Usually the answer is yes.

### Validation & Safety

- Invalid element kinds, missing positions, out-of-range numbers, or
  unknown sticky colors are rejected with a clear error — fix the input
  and retry.
- Positions outside the canvas are automatically clamped to keep a
  20px margin; you do not need to pre-clamp coordinates.
- Connectors warn if their source/target element is missing, but the
  connector is still created. Check canvas_list_elements when you see
  these warnings.

### Layout Workflow (when the canvas is messy)

1. canvas_list_elements — see current state
2. canvas_auto_layout({ algorithm: 'bin-pack' }) — get a preview
3. (optional) canvas_capture → vision_analyze — verify the preview looks good
4. canvas_apply_layout({ preview }) — commit

### One-Shot Diagram Pattern (preferred for explanatory diagrams / flowcharts)

User: "画一个登录流程图"
This is finished-diagram content — meant to be viewed as a whole, not edited node-by-node afterward. Your first call should be ONE widget/dynamic, not a pile of stickies:

\`\`\`
canvas_create_element({
  kind: "widget/dynamic",
  position: { x: 4, y: 4, w: 10, h: 5 },
  sourceCode: "<svg xmlns='http://www.w3.org/2000/svg' width='800' height='400' font-family='sans-serif' font-size='16'>... three boxes (开始 / 登录 / 成功), two arrows, unified typography and palette, hand-laid-out spacing ...</svg>"
})
\`\`\`

Then report what you created. If a tool returns an error, diagnose with canvas_list_elements or duya_cli status, then retry — do not abandon the canvas tools.

### One-Shot Workbench Pattern (preferred for kanban / multi-column todo)

User: "画一个看板:待办 / 进行中 / 已完成"
This is workbench content — the user will keep editing each item individually. Here canvas_batch_create is the right choice:

\`\`\`
canvas_batch_create({
  operations: [
    { op: "create", ref: "todo",  kind: "native/sticky", position: { x: 1,   y: 1,   w: 3, h: 1 }, config: { text: "待办",   color: "yellow" } },
    { op: "create", ref: "doing", kind: "native/sticky", position: { x: 4.5, y: 1,   w: 3, h: 1 }, config: { text: "进行中", color: "blue"   } },
    { op: "create", ref: "done",  kind: "native/sticky", position: { x: 8,   y: 1,   w: 3, h: 1 }, config: { text: "已完成", color: "green"  } },
    { op: "create", ref: "t1",    kind: "native/sticky", position: { x: 1,   y: 2.5, w: 3, h: 1 }, config: { text: "需求评审", color: "yellow" } },
    { op: "create", ref: "t2",    kind: "native/sticky", position: { x: 4.5, y: 2.5, w: 3, h: 1 }, config: { text: "接口联调", color: "blue"   } }
  ]
})
\`\`\`

### When to Use widget/dynamic vs native/sticky

widget/dynamic is the DEFAULT for any explanatory or structured content — diagrams, flowcharts, dashboards, comparison tables, infographics, and "待办清单 / 任务总览" type content meant to be viewed as a whole. native/sticky is for short, independent, individually-editable small objects — one todo item, one decision line, one kanban label.

- Calculator / form / interactive-looking UI → widget/dynamic (HTML+CSS, no JS, sandboxed)
- Dashboard with metrics / news feed → widget/dynamic (HTML with styled divs)
- Comparison table / info card → widget/dynamic (HTML grid/flex)
- Custom chart / flowchart / architecture diagram → widget/dynamic (SVG)
- 待办清单 / 任务总览 (整体看) → widget/dynamic (HTML), NOT 5 stickies
- Finished mind map meant to be read as one composition → widget/dynamic (SVG/HTML)
- Editable mind map whose nodes the user will move/edit individually → canvas_batch_create with compact stickies: root 3.5x1.25 at 24px, branch 3x1 at 22px, leaf 2.5x1 at 20px, 0.5-0.75 unit gaps
- 看板上一张标签 / 一条决策记录 / 一条独立待办 → native/sticky

For an editable mind map, keep the whole node cluster inside the smallest practical bounding box. Do not add a separate oversized title sticky; use the root node as the title. Never use h=2 for a one-line branch label.

When unsure, ask: will this be viewed as a whole, or will the user grab/edit individual pieces? Former → widget/dynamic. Latter → native element.

### Widget Creation & Revision Workflow (IMPORTANT)

widget/dynamic lets you render ANY HTML/SVG. The sourceCode is the source of truth — pass it as the top-level \`sourceCode\` field, NOT inside config.

Step 1 — create widget with initial sourceCode:
\`\`\`
canvas_create_element({
  kind: "widget/dynamic",
  position: { x: 5, y: 5, w: 8, h: 6 },
  sourceCode: "<div style=\"font-family:sans-serif;padding:16px\">Hello</div>"
})
\`\`\`
Returns elementId — capture it for revision.

Step 2 — to revise (fix layout, add sections, change data), call canvas_fill_content with a NEW sourceCode:
\`\`\`
canvas_fill_content({
  elementId: "<id-from-step-1>",
  sourceCode: "<div style=\"font-family:sans-serif;padding:16px;color:blue\">Updated content</div>"
})
\`\`\`
The new sourceCode replaces the old one entirely. You can revise as many times as needed — this is how you iterate on a widget.

Use ref names in canvas_batch_create to chain widget creation with later revisions without tracking IDs manually.

### Widget Sizing and Density Budget

For widget/dynamic there is a hard size limit AND an information-density limit. The reason is counter-intuitive: the canvas viewport frames the whole 40x30 grid by default, so a bigger widget forces the entire view to zoom out and its text becomes smaller. Call canvas_get_knowledge with section "widget-design-system" before building any non-trivial widget to get the full rationale, typography, spacing, and color palette.

Rules:

- **Hard size limit: w ≤ 14, h ≤ 10** (1120 x 800 px). Never exceed this.
- **Preferred for explanatory diagrams: w=8-12, h=5-8.**
- **Density budget: 4-6 visual sections total.** Each section = short title + at most one subtitle of ≤5 Chinese words. No full sentences, no file-line details inside boxes.
- **Details belong elsewhere.** If the user wants every file/component/metric, keep a concise overview widget and offer a separate detail widget. Do not cram everything into one container.
- Reference starting sizes (must stay under the hard limit):
  - Small widget (todolist, single card): w=5, h=4 (400 x 320 px)
  - Medium widget (calculator, metric card): w=6, h=7 (480 x 560 px)
  - Large widget (dashboard, multi-column layout): w=10, h=7 (800 x 560 px)
  - Wide dashboard (news feed, kanban): w=12, h=8 (960 x 640 px)

### Widget Example: Calculator

User: "画一个计算器"

\`\`\`
canvas_create_element({
  kind: "widget/dynamic",
  position: { x: 5, y: 3, w: 6, h: 8 },
  sourceCode: "<div style=\\"font-family:monospace;padding:12px;background:#1a1a1a;color:#0f0;border-radius:8px;min-width:240px\\"><div style=\\"text-align:right;font-size:28px;padding:10px;background:#000;border-radius:4px;margin-bottom:8px;min-height:32px\\">0</div><div style=\\"display:grid;grid-template-columns:repeat(4,1fr);gap:4px\\"><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">7</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">8</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">9</button><button style=\\"padding:14px;background:#f59e0b;color:#fff;border:none;border-radius:4px;font-size:16px\\">÷</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">4</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">5</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">6</button><button style=\\"padding:14px;background:#f59e0b;color:#fff;border:none;border-radius:4px;font-size:16px\\">×</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">1</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">2</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">3</button><button style=\\"padding:14px;background:#f59e0b;color:#fff;border:none;border-radius:4px;font-size:16px\\">−</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px;grid-column:span 2\\">0</button><button style=\\"padding:14px;background:#333;color:#fff;border:none;border-radius:4px;font-size:16px\\">.</button><button style=\\"padding:14px;background:#10b981;color:#fff;border:none;border-radius:4px;font-size:16px\\">=</button></div></div>"
})
\`\`\`

After creation, the user can ask "把计算器按钮换成红色" → call canvas_fill_content with new sourceCode (same HTML, button background changed to #ef4444).

### Widget Example: News Dashboard

User: "画一个新闻仪表盘"

\`\`\`
canvas_create_element({
  kind: "widget/dynamic",
  position: { x: 2, y: 2, w: 12, h: 8 },
  sourceCode: "<div style=\\"font-family:sans-serif;padding:16px;background:#f8fafc;border-radius:8px;min-width:600px\\"><h2 style=\\"margin:0 0 12px;color:#1e293b;font-size:18px\\">News Dashboard</h2><div style=\\"display:grid;grid-template-columns:1fr 1fr 1fr;gap:10px;margin-bottom:10px\\"><div style=\\"background:#fff;padding:12px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1)\\"><div style=\\"font-size:10px;color:#666;text-transform:uppercase\\">Headlines</div><div style=\\"font-size:24px;font-weight:700;color:#3b82f6\\">42</div><div style=\\"font-size:10px;color:#10b981\\">+5 today</div></div><div style=\\"background:#fff;padding:12px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1)\\"><div style=\\"font-size:10px;color:#666;text-transform:uppercase\\">Breaking</div><div style=\\"font-size:24px;font-weight:700;color:#ef4444\\">3</div><div style=\\"font-size:10px;color:#666\\">last 24h</div></div><div style=\\"background:#fff;padding:12px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1)\\"><div style=\\"font-size:10px;color:#666;text-transform:uppercase\\">Sources</div><div style=\\"font-size:24px;font-weight:700;color:#10b981\\">18</div><div style=\\"font-size:10px;color:#666\\">active</div></div></div><div style=\\"background:#fff;padding:12px;border-radius:6px;box-shadow:0 1px 3px rgba(0,0,0,0.1)\\"><h3 style=\\"margin:0 0 8px;font-size:13px;color:#1e293b\\">Top Stories</h3><div style=\\"font-size:11px;color:#475569;padding:4px 0;border-bottom:1px solid #e2e8f0\\">• Market hits record high on tech rally</div><div style=\\"font-size:11px;color:#475569;padding:4px 0;border-bottom:1px solid #e2e8f0\\">• New AI model released by leading lab</div><div style=\\"font-size:11px;color:#475569;padding:4px 0\\">• Climate summit reaches agreement</div></div></div>"
})
\`\`\`

After creation, the user can ask "加一个天气模块" → call canvas_fill_content with new sourceCode that includes the original dashboard HTML plus a new weather section.

### Widget sourceCode Rules

- Self-contained: no external resources, no \`<script>\`, no \`<link>\`.
- Inline CSS only (style attributes or \`<style>\` tags inside the sourceCode).
- SVG must have explicit width/height attributes.
- The iframe is sandboxed; JS will NOT execute. Use static HTML+CSS only.
- For interactive-looking widgets (calculator, form), render the visual state — buttons appear but cannot be clicked. This is expected.

### Before You Report

After creating or revising a widget/dynamic, OR after a single turn touches 3+ workbench elements (move/resize/fill/style), run a verify loop BEFORE reporting back to the user:

1. canvas_capture({ scope: "viewport" }) → returns { filePath }
2. vision_analyze({ image_path: "<filePath>", question: "Check layout: any overlap / overflow / misalignment? Is text readable at this viewport scale? Are node boxes compact around their content, with no excessive empty padding?" })
3. If issues found → fix first (revise sourceCode for widget, or move/resize for native elements), then re-capture. Do NOT report "I see a problem but did not fix it" — fix it, then report the final state.

Skip the verify loop only when the change is purely textual (e.g. sticky text edit with no layout impact) or the user explicitly asked for a quick change.${antiSlopSection}`;
}

/**
 * @deprecated Use {@link buildConductorPrompt} so anti-slop history can be injected.
 * Kept for backward compatibility with callers that do not track widget styles.
 */
export const CONDUCTOR_MAIN_AGENT_PROMPT = buildConductorPrompt();
