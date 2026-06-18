/**
 * Canvas element vizSpec reference strings.
 * Minimal set: sticky, connector, mindmap, and 4 widget kinds.
 */

export const VIZ_SPEC_PROMPT = `
## Canvas Element Types & vizSpec Protocol

The conductor canvas supports a minimal element set:

- **native/sticky** — Sticky note
- **native/connector** — Connection line between elements
- **native/mindmap** — Mind map
- **widget/task-list** — Structured task list widget
- **widget/note-pad** — Plain-text note pad widget
- **widget/pomodoro** — Pomodoro timer widget
- **widget/news-board** — News feed widget

### native/sticky — Sticky Notes

Use for: free-form annotations, reminders, brainstorm fragments.

vizSpec format:
\`\`\`json
{
  "text": "Discuss pricing model",
  "color": "yellow"
}
\`\`\`
Color options: yellow, blue, green, pink, purple, gray.

### native/connector — Connection Lines

Use for: linking related elements, showing relationships.

vizSpec format:
\`\`\`json
{
  "sourceId": "element-uuid-1",
  "targetId": "element-uuid-2",
  "label": "depends on"
}
\`\`\`

### native/mindmap — Mind Maps

Use for: brainstorming, topic decomposition, hierarchical thinking.

vizSpec format:
\`\`\`json
{
  "topic": "Q3 Launch Plan",
  "branches": [
    { "id": "b1", "text": "Marketing", "color": "blue" },
    { "id": "b2", "text": "Engineering", "color": "green" }
  ]
}
\`\`\`

### widget/* — Structured Widgets

Pass an empty vizSpec.payload — widgets render their own UI based on type.

vizSpec format:
\`\`\`json
{ "kind": "widget/note-pad", "payload": {} }
\`\`\``;

export const VIZ_SPEC_WORKED_EXAMPLES = `
## Worked Examples

### Example 1: Project Mind Map
User: "Help me plan the Q3 launch with a mind map"
Response: I'll create a mind map with the launch topics and branches.

Tool call: canvas_create_element
{
  "canvasId": "canvas-1",
  "kind": "native/mindmap",
  "position": { "x": 0, "y": 0, "w": 8, "h": 6 },
  "vizSpec": {
    "topic": "Q3 Launch",
    "branches": [
      { "id": "b1", "text": "Marketing", "color": "blue" },
      { "id": "b2", "text": "Engineering", "color": "green" }
    ]
  }
}

### Example 2: Task List with Connections
User: "Add a task list and connect it to a sticky note"
Response: I'll add a task list widget and a sticky note, then connect them.

Tool call: canvas_create_element (widget/task-list)
Tool call: canvas_create_element (native/sticky)
Tool call: canvas_create_element (native/connector, sourceId=task-list-id, targetId=sticky-id)

### Example 3: Reorganize Canvas Layout
User: "Organize this messy canvas into a clean layout"
Response: I'll reorganize the elements into a clean grid layout.

Tool call: canvas_get_snapshot (to see current state)
Tool call: canvas_arrange_elements (to reposition all elements)`;
