/**
 * Conductor Refine — system prompt.
 *
 * The renderer assembles the user message (text + image) and forwards it
 * via the existing `conductor:refine:start` IPC. The LLM is expected to
 * respond with a single JSON object matching `RefineLlmResponseSchema`.
 */

export const CONDUCTOR_REFINE_SYSTEM_PROMPT = `You are a widget data refiner for the DUYA Conductor canvas.

Inputs you receive per request:
  1. A PNG screenshot of the current widget render.
  2. The widget's current data JSON object.
  3. The widget type identifier (e.g. "task-list", "data-table", "note-pad").
  4. A user refinement request written in natural language.
  5. The current iteration number and maximum iterations.

Your job: return a single JSON object (no prose, no markdown fencing) describing the new widget data. The renderer's loop controller applies it via the existing widget.update_data IPC; you do NOT need to call any tools.

Required JSON shape:
{
  "done": boolean,
  "rationale": string,    // <= 1 sentence: why this change matches the request
  "data": object,         // the FULL replacement data object (not a diff)
  "warnings": string[]    // optional, e.g. "Quarter column not in source data, filled with TBD"
}

Rules:
- Preserve keys you do not intend to change. Return the FULL data object, not a partial patch.
- Never invent fields the user did not request. If a request implies a field that does not exist in the current schema, set done=false and explain in warnings.
- If the request is ambiguous, choose the minimal interpretation that advances the request, and set done=true with a clear rationale.
- If the request is impossible for this widget type, set done=false, return the current data unchanged, and explain why in warnings.
- Match the data shape to the widget type. For task-list the data has a "tasks" array of {id, title, completed, priority?}. For note-pad the data has a "text" string. For data-table the data has "columns" and "rows".
- When the user's request is satisfied by your proposed data, set done=true. When you propose a partial change that may need another pass, set done=false.
- Keep rationale <= 1 sentence. Warnings can be longer.

Return ONLY the JSON object. Nothing else.`;

/**
 * Per-widget-type data shape hints, used by the renderer to inject type-aware
 * guidance into the user message (separate from the system prompt so that
 * type-specific examples don't pollute the system message).
 */
export const WIDGET_TYPE_HINTS: Record<string, string> = {
  "task-list":
    'task-list data shape: { tasks: Array<{ id: string, title: string, completed: boolean, priority?: "high" | "medium" | "low" }>, _newTaskText?: string }. Each task MUST have a unique id. _newTaskText is the input field state — usually leave it empty.',
  "note-pad":
    'note-pad data shape: { content: string, title: string }. title is shown in the widget header. content is the main text. Preserve both unless the user asks.',
  pomodoro:
    'pomodoro data shape: { duration: number }. duration is in minutes (e.g. 25 = 25 minutes). The widget does NOT store session history in data.',
  "data-table":
    'data-table data shape: { headers: string[], rows: Array<Array<string|number>>, caption?: string }. headers and rows.length MUST match in column count. Cells are strings or numbers.',
  "metric-card":
    'metric-card data shape: { value: string, label: string, trend?: "up" | "down" | "flat", trendValue?: string, description?: string }. value is a formatted display string.',
  "image-card":
    'image-card data shape: { src: string, alt: string, caption: string, fit: "cover" | "contain", rounded: boolean }. src is a URL or file path. fit controls object-fit. rounded toggles border-radius.',
  "news-board":
    'news-board data shape: { articles: Array<{ id: string, title: string, source?: string, url?: string, publishedAt?: string, summary?: string }>, lastUpdated: string }. articles[].id must be unique.',
  "quick-action":
    'quick-action data shape: { actions: Array<{ id: string, label: string, icon: string, color: string, completed: boolean }> }. icons are phosphor icon names (e.g. "star", "rocket", "lightning"). color is hex.',
  divider:
    'divider data shape: { label: string, thickness: number, style: "solid" | "dashed" | "dotted", color: string }. Empty color string means inherit theme.',
  "group-box":
    'group-box data shape: { label: string, collapsed: boolean, accentColor: string }. label is the section header. collapsed toggles inner content visibility.',
};

export function widgetTypeHint(type: string): string {
  return (
    WIDGET_TYPE_HINTS[type] ??
    `Generic widget data: { /* arbitrary JSON the widget renders */ }. Preserve unknown keys.`
  );
}