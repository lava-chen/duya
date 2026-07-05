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

import type { ToolUseContext } from '../../types.js';

export type WidgetStyleHistory = NonNullable<ToolUseContext['widgetStyleHistory']>;

export function buildConductorPrompt(widgetStyleHistory?: WidgetStyleHistory): string {
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

When creating the NEXT widget/dynamic element, deliberately choose a DIFFERENT color palette, font, or layout pattern than the ones above. Variety improves visual clarity.`
      : '';

  return `## Conductor Canvas Mode

A canvas is bound to this session. You have canvas tools. The canvasId is injected automatically — never ask the user for it.

### HARD RULES

1. When the user asks you to draw, create, arrange, or modify anything on the canvas, you MUST call the canvas_* tools IMMEDIATELY. Do NOT plan in prose first. Do NOT use Bash, echo, read_module, show_widget, or any other tool to "prepare" or "simulate". A successful canvas operation returns JSON with "success": true. STOP writing and call the tool.
2. Before you move, resize, delete, fill, or style ANY EXISTING ELEMENT, you MUST call canvas_list_elements first (or have created the target element yourself in this very turn). The write tools reject operations on elements you have not listed or created. There are no exceptions.

### Available Tools

- canvas_create_element: create one element. Required: kind, position {x, y}. Optional: config.
- canvas_batch_create: create multiple elements + connectors in ONE call. Use ref names and reference them in later operations. PREFERRED for flowcharts and multi-element layouts.
- canvas_delete_element: delete by elementId.
- canvas_move_element: move to new (x, y).
- canvas_resize_element: resize to new (w, h).
- canvas_fill_content: merge-patch content (sticky text, image url, file name, connector source/target).
- canvas_style_element: merge-patch style (sticky color/fontSize, connector stroke, image borderRadius/opacity).
- canvas_list_elements: list all elements (id, kind, position, summary). Use this to find existing IDs.
- canvas_capture: saves screenshot to file, returns filePath. Pass filePath to vision_analyze tool.
  Workflow: canvas_capture → vision_analyze(image_path=<filePath>, question="check layout/overlap/alignment").
- canvas_get_knowledge: fetch design guidance when you need it (not every turn).

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

Do not omit width/height. Choose dimensions that fit the content:

- Short label (1-3 words, e.g. "Start", "OK"): w=3, h=2 (240 x 160 px).
- Compact process step (1 short line): w=4, h=2 (320 x 160 px).
- Standard sticky note (1-2 sentences): w=4, h=3 (320 x 240 px).
- Detailed card / small paragraph: w=5, h=4 (400 x 320 px).
- Wide header / section title: w=6-8, h=2.
- Tall list / multi-line content: w=4-5, h=5-6.

Minimum usable size for a sticky is w=3, h=2. Avoid 1x1 or 2x2 elements — they are too small to read. When in doubt, prefer 4x3 over smaller sizes.

### Validation & Safety

- Invalid element kinds, missing positions, out-of-range numbers, or
  unknown sticky colors are rejected with a clear error — fix the input
  and retry.
- Positions outside the canvas are automatically clamped to keep a
  20px margin; you do not need to pre-clamp coordinates.
- Connectors warn if their source/target element is missing, but the
  connector is still created. Check canvas_list_elements when you see
  these warnings.

### One-Shot Flowchart Pattern (preferred)

User: "Draw a login flowchart."
Your first action must be ONE canvas_batch_create call, not prose:

\`\`\`
canvas_batch_create({
  operations: [
    { op: "create", ref: "start", kind: "native/sticky", position: { x: 1, y: 1, w: 3, h: 2 }, config: { text: "Start", color: "gray" } },
    { op: "create", ref: "login", kind: "native/sticky", position: { x: 6, y: 1, w: 4, h: 2 }, config: { text: "Login", color: "yellow" } },
    { op: "create", ref: "success", kind: "native/sticky", position: { x: 12, y: 1, w: 4, h: 2 }, config: { text: "Success", color: "green" } },
    { op: "connect", source: "start", target: "login" },
    { op: "connect", source: "login", target: "success" }
  ]
})
\`\`\`

Then report what you created. If a tool returns an error, diagnose with canvas_list_elements or duya_cli status, then retry — do not abandon the canvas tools.

### When to Use widget/dynamic

Use widget/dynamic (with sourceCode) when sticky cannot meet the need:
- Calculator, form, or interactive UI → write HTML+CSS (no JS, sandboxed)
- Dashboard with metrics / news feed → write HTML with styled divs
- Todolist / checklist → write HTML with checkbox inputs
- Custom chart → write SVG directly
- Multi-section layout → write HTML grid/flex

Prefer sticky for simple text labels. Use widget/dynamic for structured/visual content.
Example: user asks "画个待办清单" → create widget/dynamic with HTML sourceCode (not 5 stickies).

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

### Widget Sizing (choose w/h based on content)

- Small widget (todolist, single card): w=5, h=4 (400 x 320 px)
- Medium widget (calculator, metric card): w=6, h=7 (480 x 560 px)
- Large widget (dashboard, multi-column layout): w=10, h=7 (800 x 560 px)
- Wide dashboard (news feed, kanban): w=12, h=8 (960 x 640 px)

For text-heavy widgets, use w=8 or wider. For tall widgets (lists, feeds), use h=8 or taller. The widget iframe scales to fit position.w * 80px by position.h * 80px.

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
- For interactive-looking widgets (calculator, form), render the visual state — buttons appear but cannot be clicked. This is expected.${antiSlopSection}`;
}

/**
 * @deprecated Use {@link buildConductorPrompt} so anti-slop history can be injected.
 * Kept for backward compatibility with callers that do not track widget styles.
 */
export const CONDUCTOR_MAIN_AGENT_PROMPT = buildConductorPrompt();
