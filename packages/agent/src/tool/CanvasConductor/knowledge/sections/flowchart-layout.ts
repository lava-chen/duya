/**
 * canvas_get_knowledge section: flowchart-layout
 * Flowchart node placement templates (linear, branching, vertical, bus).
 */
export const CONTENT = `## Flowchart Layout Templates

All coordinates are in grid units (1 unit = 80px). Default canvas: 40 x 30. Default shape node size: 3w x 3h.

### Template 1: Linear Horizontal Flow

Best for: short sequential processes (3-5 steps).

\`\`\`
y=1   [Start]──→[Step 1]──→[Step 2]──→[End]
      x=1       x=5        x=9        x=13
\`\`\`

- All nodes at y=1, height 3.
- x positions: 1, 5, 9, 13 (4 unit stride, 1 unit gap).
- Connectors go left-to-right, endMarker='arrow'.
- Connector y = 2.5 (vertical midpoint of node).
- Connector x = right edge of source = source.x + 3.
  e.g. connector 1 at (4, 2.5), connector 2 at (8, 2.5).

### Template 2: Branching Flow (Decision)

Best for: if/else logic, yes/no decisions.

\`\`\`
                       [Yes branch]   x=9, y=2
                      /
[Prev step]──→[Decision?]
              x=1,y=5   x=5,y=5
                      \\\\
                       [No branch]    x=9, y=8
\`\`\`

- Decision node at (5, 5), typically purple.
- Yes branch at (9, 2) — top-right.
- No branch at (9, 8) — bottom-right.
- Yes-branch connector: green (#10B981).
- No-branch connector: red (#EF4444).
- Label the branch by putting "Yes" / "No" in the next shape node's
  text, or as a separate small shape node near the connector.

### Template 3: Vertical Sequential Flow

Best for: long sequential processes (5+ steps), top-down pipelines.

\`\`\`
x=1   [Step 1]   y=1
        │
     [Step 2]   y=5
        │
     [Step 3]   y=9
        │
     [Step 4]   y=13
\`\`\`

- All nodes at x=1, width 3.
- y positions: 1, 5, 9, 13 (4 unit stride, 1 unit gap).
- Connector x = 2.5 (horizontal midpoint of node).
- Connector y = top edge of target = target.y.
  e.g. connector 1 at (2.5, 5).
- Good when horizontal space is tight but vertical is plentiful.

### Template 4: Architecture Fan-out / Shared Bus

Best for: frameworks, module trees, service layers, ownership maps,
and any one-to-many or many-to-one relationship.

\`\`\`
                 [Parent]
                    |
          +---------+---------+
          |         |         |
       [Child A] [Child B] [Child C]
\`\`\`

- Center the parent over the child group.
- Put every child on the same y coordinate and use even horizontal
  spacing. For horizontal flow, rotate the pattern: same x coordinate
  with a vertical trunk.
- Connect the parent directly to each child with
  \`routingMode: 'elbow'\`. Matching bottom-to-top anchor sides make
  the routes overlap into one shared trunk with short drops.
- Repeat the pattern per semantic level instead of drawing long
  diagonal links across multiple levels.
- For a dense architecture, create several small organized buses by
  module or layer rather than one global bus crossing the whole canvas.

### Color Coding for Flowcharts

| Node role          | Color  |
|--------------------|--------|
| Start              | gray   |
| End (success)      | green  |
| End (error)        | pink   |
| Process step       | yellow |
| Decision           | purple |
| Reference / input  | blue   |

### Workflow

1. Plan node positions on paper / in your head before calling tools.
2. Create nodes one at a time with \`canvas_create_element\`. Keep their
   returned IDs, then create connectors after both endpoints exist.
3. Set every connector to \`routingMode: 'elbow'\`; align sibling rows
   or columns before relying on a shared trunk/bus.
4. Optional: call canvas_capture to verify layout.
5. If a node is misaligned, use canvas_move_element (not delete +
   recreate).
`;