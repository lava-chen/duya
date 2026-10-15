/**
 * canvas_get_knowledge section: mindmap-layout
 * Mind map templates (radial, left-to-right tree), node tiers, connector
 * rules. Emphasizes vertical leaf stacking and parent-right → child-left
 * bindingPoints for left-to-right trees.
 */
export const CONTENT = `## Mind Map Layout Templates

Mind maps use stickies for nodes and connectors with
\`endMarker: 'none'\` (association, not flow) and
\`routingMode: 'elbow'\` by default. Use curves only when the user
explicitly requests an organic radial style. Default canvas:
40 x 30 grid units. Center is (20, 15).

### Readable Node Tiers

- Root: 3.5x1.25, fontSize 24.
- First-level branch: 3x1, fontSize 22.
- Leaf: 2.5x1, fontSize 20.
- Vertical leaf gap (within one branch's leaf stack): 1.3-1.7 units (≈1.5 units). Leaves of the same parent MUST be spaced this far so connectors and labels stay readable. Do NOT drop back to 0.5-0.75 "to fit more on screen" — crowded leaves are unreadable.
- Inter-branch gap (between different first-level branch groups): 2+ units of empty y space.
- The root is the title. Do not add a separate oversized title banner or a top/bottom title shape node — the root node IS the title.
- Vertical overflow is acceptable. If a branch has many leaves, let the leaf stack run past y=30, past the default 30-unit canvas height. Do NOT compress gaps, shrink nodes, drop font size, or move branches horizontally to "fit" inside the canvas. The user can pan; cramped content is not a fixable tradeoff.
- Same-x-column rule for left-to-right tree: every leaf of a single first-level branch MUST share the SAME x coordinate (the column directly to the right of its parent). Do NOT spread leaves horizontally across multiple x columns even if it leaves whitespace — that is the wrong template and breaks the parent→child connector geometry.

### Template 1: Radial Layout

Best for: brainstorming, topic exploration, non-hierarchical ideas.

\`\`\`
                [N]
              /     \\
        [NW]──[CENTER]──[NE]
              |     |
        [SW]──[  ●  ]──[SE]
              |     |
                [S]
\`\`\`

- Center root at (18.25, 14.5), size 3.5x1.25.
- First-level branches use a compact radius of about 4 units:
  - N  : (18.5, 10.5)
  - NE : (22.5, 11.5)
  - E  : (23.5, 14.5)
  - SE : (22.5, 17.5)
  - S  : (18.5, 18.5)
  - SW : (14, 17.5)
  - W  : (13, 14.5)
  - NW : (14, 11.5)
- Second-level branches extend another 3.5-4 units outward, not to the canvas edges.
- Each second-level node connects to its first-level parent, not
  directly to center.

### Template 2: Tree Layout (Left-to-Right)

Best for: hierarchical structure, org charts, file trees,
outline-style notes, and any "topic → subtopic → detail" outline.

\`\`\`
                 [Child 1]──[Grandchild 1]
                /
[Root]──[Child 2]──[Grandchild 2]
                \\
                 [Child 3]──[Grandchild 3]
\`\`\`

- Root at (1, 4), size 3.5x1.25. Root IS the title — do not add a separate title node above or beside it.
- Children at x=5.25, y spread vertically (1.3-1.7 unit stride — same gap rule as leaves):
  - Child 1: (5.25, 2.5)
  - Child 2: (5.25, 4)
  - Child 3: (5.25, 5.5)
  (Widen the stride only for wrapped labels, not to save space.)
- Grandchildren at x=9, vertically stacked in the SAME x column:
  - Grandchild 1: (9, 2.5)
  - Grandchild 2: (9, 4)
  - Grandchild 3: (9, 5.5)
- **Critical: all grandchildren of a single child MUST share the same x column.** Do NOT spread them across x=9 / x=11 / x=14 / x=17 even if it leaves whitespace on the right — that destroys the parent→child elbow geometry and turns the tree into an unreadable grid.
- When a child has 5+ grandchildren, stack them vertically at x=9 with 1.3-1.7 unit y stride; let the stack run past y=30 if needed. Do not compress.
- Connectors bind node IDs; do not allocate extra blank rows for their paths.

### Color Coding for Mind Maps

Use a different color PER first-level branch — this creates
visual grouping. The center / root is gray or yellow.

| Branch role        | Suggested color |
|--------------------|-----------------|
| Root / center      | gray or yellow  |
| Branch A           | blue            |
| Branch B           | green           |
| Branch C           | pink            |
| Branch D           | purple          |
| Branch E+          | cycle back to yellow, then blue... |

All descendants of a branch inherit the branch's color.

### Style Rules

- Connector endMarker: 'none' (mind maps show association, not
  direction).
- Connector stroke: default #333333 for all (do not color-code
  connectors — color comes from the nodes).
- Connector routingMode: 'elbow'. Curve remains opt-in for an
  explicitly requested organic radial style.
- **Connector bindingPoints (Template 2 left-to-right tree, REQUIRED):**
  - Root → Child: source bindingPoint {u:1, v:0.5} (root right edge midpoint), target bindingPoint {u:0, v:0.5} (child left edge midpoint).
  - Child → Grandchild: source bindingPoint {u:1, v:0.5}, target bindingPoint {u:0, v:0.5}.
  - Always parent right → child left, never top/bottom. Always at vertical midpoint (v:0.5) so the elbow exits and enters cleanly.
  - Do not rely on defaults — pass bindingPoint explicitly in the connector config. Skipping this leaves the geometry to chance and creates diagonal or top-down lines that cross other branches.
- Keep labels SHORT: 2-4 words per node. Long labels clutter the
  radial pattern — split into a parent + child instead.

### Workflow

1. Create the center / root shape node first.
2. Create all first-level branches in ONE turn.
3. In the next turn, create connectors from center to each
   first-level branch.
4. Add second-level branches as needed, then their connectors.
5. Apply branch colors via canvas_style_element after creation
   (or set color in the initial canvas_create_element config).
6. For Template 2 (left-to-right tree): when creating connectors, ALWAYS pass bindingPoint: {u:1, v:0.5} on source and {u:0, v:0.5} on target. Parent right edge → child left edge, vertical midpoint.
7. Optional: canvas_capture to verify the layout. If a branch's leaves are not all on the same x column, or any leaf strays onto a different x, fix it with canvas_move_element — never leave the template broken.
`;