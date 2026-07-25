/**
 * canvas_get_knowledge section: widget-todolist
 * TodoList widget design spec — status markers, typography, full template.
 */
export const CONTENT = `## TodoList Widget Design Spec

Use this spec when the user asks for a todo list, task list, checklist, or backlog. It gives the todo-list widget a consistent visual structure across sessions so users can recognize "this is a task board" at a glance.

### When to Use This vs Other Tools

- User wants a **whole-list view** (see all tasks at once, status overview) → use this widget/dynamic spec.
- User wants **individually-editable items** (drag one task, reorder, per-item color) → use native/shape nodes (one per item, distinct colors) or widget/task-list instead.
- User wants a **kanban with columns** (todo / doing / done as separate swimlanes) → use the KanbanBoard template in widget-usage, not this spec.

### Recommended Size

- Default: w=6, h=7 (480 x 560 px). Fits 6-8 items comfortably.
- Compact (3-5 items): w=5, h=5 (400 x 400 px).
- Long list (8-12 items): w=7, h=9 (560 x 720 px). Do NOT exceed w=14, h=10 hard limit.
- If the list has more than 12 items, split into a summary widget + a detail widget, or group by phase.

### Structure

Every todo-list widget has exactly four layers, top to bottom:

1. **Header** — list title + optional progress summary (e.g. "3/8 done").
2. **Progress bar** (optional, only if >3 items) — thin bar showing done/total ratio.
3. **Item list** — the tasks. Each item is one row.
4. **Footer** (optional) — last-updated timestamp or a one-line note.

Do not add extra sections (metrics, descriptions, unrelated content) inside a todo-list widget. If you need those, create a separate widget beside it.

### Item Row Anatomy

Each row contains, left to right:

- **Status marker** — a fixed-width glyph at the left edge.
- **Task text** — the main label, one short line.
- **Meta tag** (optional) — a small right-aligned tag for priority / owner / phase.

Row height: 32-36px. Row padding: 6px 8px. Gap between rows: 4px.

### Status Marker Styles

Use these exact markers — they are the visual language users recognize across the canvas:

| Status   | Marker | Color    | Text style               |
|----------|--------|----------|--------------------------|
| Todo     | ○      | #94a3b8  | normal                   |
| Doing    | ◐      | #3b82f6  | font-weight 500          |
| Done     | ●      | #10b981  | line-through, opacity 0.5|
| Blocked  | ✕      | #ef4444  | normal, color #ef4444    |

Marker width: 20px, fixed. Font-size: 14px. This keeps task text aligned even when statuses differ.

### Typography

- Header title: 15px, font-weight 600, color #1e293b.
- Progress summary: 12px, color #64748b, right-aligned in header.
- Task text: 13px, color #334155. Done items: color #94a3b8.
- Meta tag: 11px, color #64748b, background #f1f5f9, padding 2px 6px, border-radius 3px.
- Footer: 11px, color #94a3b8.

### Colors

- Widget background: #ffffff.
- Header divider: 1px solid #e2e8f0.
- Row hover (visual only, not interactive): no hover state needed.
- Progress bar track: #e2e8f0. Fill: #10b981.
- Blocked row background tint: #fef2f2 (very light red).

### Information Density

- Max 12 items in one widget. Beyond that, split.
- Task text ≤ 20 Chinese chars. If longer, truncate with ellipsis and put the full text in a separate detail widget.
- Meta tag ≤ 4 chars (e.g. "P0", "前端", "v2").
- Do NOT embed file paths, line numbers, or long descriptions in task text.

### Full Template

\`\`\`html
<div style="font-family:sans-serif;padding:14px;background:#fff;border-radius:8px;min-width:320px">
  <!-- Header -->
  <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:8px">
    <h3 style="margin:0;font-size:15px;font-weight:600;color:#1e293b">项目任务</h3>
    <span style="font-size:12px;color:#64748b">3/8 done</span>
  </div>
  <div style="height:1px;background:#e2e8f0;margin-bottom:10px"></div>
  <!-- Progress bar -->
  <div style="height:4px;background:#e2e8f0;border-radius:2px;margin-bottom:12px;overflow:hidden">
    <div style="height:100%;width:37.5%;background:#10b981;border-radius:2px"></div>
  </div>
  <!-- Items -->
  <div style="display:flex;flex-direction:column;gap:4px">
    <!-- Done item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#10b981">●</span>
      <span style="flex:1;font-size:13px;color:#94a3b8;text-decoration:line-through">需求评审</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">P0</span>
    </div>
    <!-- Doing item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#3b82f6">◐</span>
      <span style="flex:1;font-size:13px;color:#334155;font-weight:500">接口联调</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">后端</span>
    </div>
    <!-- Todo item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#94a3b8">○</span>
      <span style="flex:1;font-size:13px;color:#334155">编写单元测试</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">测试</span>
    </div>
    <!-- Blocked item -->
    <div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:4px;background:#fef2f2">
      <span style="display:inline-block;width:20px;text-align:center;font-size:14px;color:#ef4444">✕</span>
      <span style="flex:1;font-size:13px;color:#ef4444">部署到预发环境</span>
      <span style="font-size:11px;color:#64748b;background:#f1f5f9;padding:2px 6px;border-radius:3px">运维</span>
    </div>
  </div>
  <!-- Footer -->
  <div style="margin-top:10px;font-size:11px;color:#94a3b8">Updated 2026-07-07</div>
</div>
\`\`\`

### Revision Workflow

When the user asks to update task status (e.g. "把接口联调标记为完成"):

1. Call canvas_list_elements to find the widget elementId.
2. Regenerate the FULL sourceCode with the updated status marker and text style. The marker for the changed item moves from ○/◐ to ●, and the text gets line-through + opacity 0.5.
3. Call canvas_fill_content with the new sourceCode. Do not try to patch individual rows — the whole sourceCode is replaced.
4. Update the progress bar width and the "X/Y done" counter in the header to stay in sync.

### Grouped Variant

If the list has distinct phases (e.g. "Phase 1 / Phase 2"), insert a phase sub-header row before the items of each phase:

\`\`\`html
<div style="font-size:12px;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:0.5px;margin:10px 0 4px 0">Phase 1: 基础设施</div>
\`\`\`

Keep phase sub-headers sparse — max 3 groups per widget. More than 3 means the list is too complex for one widget.
`;