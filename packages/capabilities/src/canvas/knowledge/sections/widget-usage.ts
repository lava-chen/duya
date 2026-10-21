/**
 * canvas_get_knowledge section: widget-usage
 * HTML/SVG templates for `widget/dynamic` mini components.
 * `widget/dynamic` is a LAST-RESORT one-glance mini component — never use
 * it for a whole guide, plan, diagram, or dashboard.
 */
export const CONTENT = `## Widget Modules (for widget/dynamic sourceCode)

widget/dynamic renders agent-written HTML/SVG in a sandboxed iframe (no JS execution, CSS allowed).

> **Last-resort reminder**: widget/dynamic is a compact mini component,
> not a shortcut for a whole guide, itinerary, flowchart, mind map,
> comparison table, dashboard, travel plan, research framework, or
> homepage. If the user might revise a part later, make that part a
> native element instead. See the Conductor prompt HARD RULES for the
> full guardrails.

### Module: TodoList
HTML template (replace {{items}} with actual data):
<div style="font-family:sans-serif;padding:12px;min-width:200px">
  <h3 style="margin:0 0 8px;font-size:14px">{{title}}</h3>
  {{#items}}
  <label style="display:flex;align-items:center;gap:6px;padding:4px 0;font-size:12px">
    <input type="checkbox" {{#done}}checked{{/done}} disabled>
    <span style="{{#done}}text-decoration:line-through;opacity:0.5{{/done}}">{{text}}</span>
  </label>
  {{/items}}
</div>
Note: checkbox disabled because JS is blocked; for static display only.

### Module: MetricCard
<div style="font-family:sans-serif;padding:16px;border-radius:8px;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,0.1);min-width:160px">
  <div style="font-size:11px;color:#666;text-transform:uppercase">{{label}}</div>
  <div style="font-size:24px;font-weight:700;margin:4px 0">{{value}}</div>
  <div style="font-size:11px;color:{{deltaColor}}">{{delta}}</div>
</div>

### Module: FlowChart (SVG)
<svg width="320" height="120" xmlns="http://www.w3.org/2000/svg">
  <rect x="10" y="40" width="80" height="40" rx="6" fill="#3b82f6"/>
  <text x="50" y="64" text-anchor="middle" fill="#fff" font-size="12">Start</text>
  <rect x="120" y="40" width="80" height="40" rx="6" fill="#10b981"/>
  <text x="160" y="64" text-anchor="middle" fill="#fff" font-size="12">Process</text>
  <line x1="90" y1="60" x2="120" y2="60" stroke="#333" stroke-width="2" marker-end="url(#arrow)"/>
  <defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="4" orient="auto">
    <polygon points="0 0, 8 4, 0 8" fill="#333"/></marker></defs>
</svg>

### Module: KanbanBoard
3-column board using CSS grid:
<div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;font-family:sans-serif;min-width:400px">
  <div style="background:#f3f4f6;border-radius:6px;padding:8px">
    <h4 style="margin:0 0 6px;font-size:12px">Todo</h4>
    <div style="background:#fff;padding:6px;border-radius:4px;font-size:11px;margin-bottom:4px">Task A</div>
  </div>
  <div style="background:#f3f4f6;border-radius:6px;padding:8px">
    <h4 style="margin:0 0 6px;font-size:12px">Doing</h4>
    <div style="background:#fff;padding:6px;border-radius:4px;font-size:11px;margin-bottom:4px">Task B</div>
  </div>
  <div style="background:#f3f4f6;border-radius:6px;padding:8px">
    <h4 style="margin:0 0 6px;font-size:12px">Done</h4>
    <div style="background:#fff;padding:6px;border-radius:4px;font-size:11px;margin-bottom:4px">Task C</div>
  </div>
</div>

### Module: NoteCard
<div style="font-family:sans-serif;padding:12px;background:#fef9c3;border-left:3px solid #eab308;border-radius:4px;min-width:180px">
  <div style="font-size:11px;color:#666;margin-bottom:4px">{{timestamp}}</div>
  <div style="font-size:13px;line-height:1.4">{{content}}</div>
</div>

### Rules
- sourceCode must be self-contained (no external resources, no <script>).
- Inline CSS only (style attributes or <style> tags).
- SVG must have explicit width/height.
- Default widget size: 4 x 3 grid units (320 x 240 px). Override via position.w/h.
- For text-heavy content, use position.w=6 h=4 or larger.
`;