/**
 * canvas_get_knowledge section: scene-blueprints
 * Composable scene blueprints for multi-region boards: Architecture,
 * Timeline/Roadmap, Project Outline, Knowledge Homepage.
 */
export const CONTENT = `## Composable Canvas Scene Blueprints

Use this section when the user asks for an architecture diagram, timeline,
project outline, knowledge homepage, roadmap, or another multi-region board.
These are spatial compositions made from editable native elements, not large
SVG or widget screenshots.

### Scene Planning Protocol

1. Pick exactly one primary scene blueprint before creating elements.
2. Reserve the full scene rectangle and divide it into semantic regions.
3. Create the skeleton first: title, section labels, primary nodes/cards, and
   source material. Create detail nodes second. Create connectors last.
4. Use one dominant reading direction. Do not mix top-down and left-to-right
   flow in the same region unless a clearly separated sub-region needs it.
5. After substantial creation, call canvas_capture. Fix tiny text, wasted empty
   space, uneven gaps, crossings, and ambiguous hierarchy before stopping.

### Shared Visual Grammar

- Title: native/text, 4-7 x 1-1.5, 24-30px, aligned to the scene's leading edge.
- Section label: native/text or a compact native/shape, 2.5-4 x 1, 20-22px.
- Primary node: native/shape, usually 3-4 x 1-1.5, short centered label.
- Detail card: native/shape for concise editable facts; native/document for
  paragraphs; native/table for repeated fields, dates, comparisons, or status.
- Relationship: native/connector with elbow routing. Keep one connector family
  on consistent anchor sides and let aligned segments form shared trunks.
- Navigation: native/link for canvas/session/URL destinations. A homepage is a
  navigable scene, not a decorative dashboard.
- Group related regions with native/group only when the region should move as
  one unit. Use whitespace and labels instead of drawing unnecessary boxes.

Use a small semantic palette across the whole scene: blue=process/data,
purple=cross-system or navigation, green=success/output, amber=attention or
decision, red=warning/error, gray=boundary/support. Prefer 2-3 dominant colors
plus neutrals; do not color every node differently.

### Blueprint A: Architecture Diagram

- Reading direction: left-to-right for pipelines, top-down for hierarchy.
- Arrange 3-5 semantic levels such as Entry -> Orchestration -> Services ->
  Data/External Systems. Align siblings in rows or columns with even spacing.
- Use native/shape for components, native/text for layer labels, and
  native/document beside the diagram for assumptions or decisions.
- Fan-out/fan-in uses direct semantic elbow connectors whose aligned segments
  overlap into a shared bus. Never connect siblings merely to fake a trunk.
- Keep infrastructure/support systems in a clearly separated lower or side
  region so the primary request path remains obvious.

### Blueprint B: Timeline / Roadmap

- Reading direction: left-to-right time. Use native/table for a compact time
  scale when repeated dates/periods matter; otherwise use native/text ticks.
- One horizontal lane per workstream. Use compact native/shape bars for tasks,
  short native/text labels at the lane start, and a diamond native/shape for a
  milestone. Bar width communicates duration; x position communicates start.
- Dependency connectors route below or above bars, never through labels.
- Use color for workstream/status, not for every individual task. Keep lane
  gaps equal so the user can compare timing at a glance.

### Blueprint C: Project Outline

- Reading direction: top-down hierarchy. Put the project goal/root at top,
  3-6 workstreams beneath it, and concise deliverables/tasks beneath each.
- Use native/shape for hierarchy nodes, native/document for the project brief,
  native/table for milestones/owners/status, and native/link for source specs.
- Keep each branch vertically aligned. Use shared-trunk elbow connectors and
  avoid crossing between branches. Split a branch into another canvas when it
  exceeds 7-9 visible detail nodes.

### Blueprint D: Knowledge Homepage

- Divide the viewport into: identity/header, current focus, navigation cards,
  and reference/source zones. The current-focus region should be visually
  dominant; navigation cards should be compact and repeated consistently.
- Use native/link cards for canvases, sessions, and URLs; native/document for
  a welcome/working brief; native/table for current tasks or status; and
  native/image/file only when they are meaningful source material.
- Group links by user intent (Explore, Build, Decide, Reference), not by file
  type. Keep 4-8 primary destinations visible at the default zoom.
- Link cards need informative titles and one-line descriptions. Do not create
  a homepage made only of unlabeled boxes or decorative connectors.

### Blueprint Selection

- System structure, dependencies, runtime flow -> Architecture Diagram.
- Dates, phases, delivery sequence, dependencies over time -> Timeline/Roadmap.
- Goals, workstreams, deliverables, ownership -> Project Outline.
- Entry point to canvases, sessions, sources, and current work -> Homepage.
- If the request combines two, make one the primary scene and place the second
  as a compact supporting region or linked canvas; do not overlay both grammars.
`;