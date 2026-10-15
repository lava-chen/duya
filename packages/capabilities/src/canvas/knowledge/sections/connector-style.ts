/**
 * canvas_get_knowledge section: connector-style
 * `native/connector` visual rules: routingMode, color, markers, bus routing.
 */
export const CONTENT = `## Connector Style Guide

Connectors are \`native/connector\` elements. The visual style lives in
\`config\`: routingMode, color, strokeStyle, startMarker, endMarker,
and label. Connector width is fixed so diagrams keep one visual rhythm;
do not set or recommend a stroke width. Endpoints are bound references
inside nodes or free canvas points. Elbow routes project a bound reference
onto its nearest edge. Curves use the references as their full path endpoints
and clip only the portions inside the source and target elements.

### Routing Mode

- **Elbow is the default for every editable canvas diagram**, including
  architecture maps, dependency graphs, flowcharts, and mind maps.
- Curve is opt-in only when the user explicitly asks for an organic
  curved relation, or when a sparse one-to-one association clearly
  benefits from a curve.
- In batch connect operations, set \`routingMode: 'elbow'\` explicitly.
  Do not rely on curves to hide an unorganized layout.

### Colors (config.color, hex)

| Hex       | Meaning                                | When to use                          |
|-----------|----------------------------------------|--------------------------------------|
| #333333   | Default / neutral                      | General flow, default process arrow.|
| #3B82F6   | Blue / highlight                       | Emphasized path, primary flow.      |
| #EF4444   | Red / error                            | Error branch, failure path.         |
| #10B981   | Green / success                        | Success branch, happy path.         |

For mind-map association links, default #333333 is fine; do not
color-code unless the user asks.

### Markers (config.startMarker / config.endMarker)

- 'arrow' — default end marker for directed relationships.
- 'open-arrow' — lighter directional emphasis.
- 'circle' / 'diamond' / 'bar' — semantic endpoint variants.
- 'none' — default start marker; also use as the end marker for
  undirected associations.

### Shared Trunk / Bus Routing

Use Whimsical-style fan-out and fan-in for architecture diagrams:

- Center the parent above a child group for top-down flow, or beside
  it for left-to-right flow.
- Put sibling nodes on one aligned row or column with even spacing.
- Top-down: parent bottom → one common horizontal trunk → short
  vertical drops into each child top.
- Left-to-right: parent right → one common vertical trunk → short
  horizontal branches into each child left edge.
- Create a direct parent-to-child elbow connector for every relation.
  When nodes share anchor sides and alignment, their overlapping
  orthogonal segments visually form the clean shared trunk/bus.
- Fan-in uses the same pattern in reverse: align the sources and center
  the target on the group axis.
- Never connect siblings to each other just to simulate a bus. The
  semantic source/target relation must remain correct.
- Split dense graphs into semantic levels or groups before adding more
  routes. A readable hierarchy beats a web of crossing lines.

### Layout Rules

- Connectors should NOT cross unnecessarily. If two connectors
  must cross, reroute one by repositioning its endpoint.
- Keep every connector family on consistent anchor sides: bottom-to-top
  for vertical hierarchy, right-to-left for horizontal hierarchy.
- Keep trunks outside node bounds and use short terminal branches; no
  connector may pass through an unrelated node.
- A connector's source and target must both exist before creation.
- Create nodes one by one with \`canvas_create_element\`, then use each
  returned element ID when creating connectors.
`;