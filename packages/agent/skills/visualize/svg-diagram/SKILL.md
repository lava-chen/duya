---
name: svg-diagram
description: Create consistent SVG diagrams for architecture, flowcharts, and visualizations using the show_widget tool. Covers pre-planning, CSS class system, spacing rules, and common patterns.
version: 1.0.0
author: DUYA Agent
license: MIT
metadata:
  tags: [SVG, Diagram, Architecture, Visualization, Widget, show_widget]
  related_skills: []
---

# SVG Diagram Guide

Create consistent SVG diagrams using the `show_widget` tool.

## When to Use

- Architecture diagrams (layered systems, microservices)
- Flowcharts (sequential processes, decision trees)
- Comparisons (side-by-side, before/after)
- Hierarchical structures (trees, hierarchies)
- Any concept where a visual is clearer than text

**Never use ASCII art or markdown tables for diagrams.**

## Pre-Planning (Required)

Before writing SVG code, plan in plain text:

1. **Semantic layers** — What are the conceptual layers?
2. **Nodes per row** → `node_width = (620 − (N−1)×16) / N`
3. **Total height** → `H = 20 + layers×(node_height + 20) + 30`

Write SVG only after completing the plan. Never improvise coordinates.

## CSS Class System

All classes are injected into the iframe. Use exactly as listed.

### Container Colors

| Class | Color | Use for |
|-------|-------|---------|
| `s-plat` | Deep Blue | OS / external platform / top-level shell |
| `s-proc` | Blue | Main process / core layer |
| `s-agent` | Green | Agent flow / success path |
| `s-msg` | Purple | IPC / messaging / communication |
| `s-err` | Red | Error / warning |
| `s-chk` | Amber | Checkpoint / decision |
| `s-sub` | Gray | Sub-component inside a container |
| `s-sub-dark` | Dark Gray | Sub-component on dark background |

### Text Colors

| Class | Use for |
|-------|---------|
| `t-dark` / `t-dim-dark` | Title / subtitle on `s-plat` |
| `t-light` / `t-dim` | Title / subtitle on `s-proc` |
| `t-green` | Title on `s-agent` |
| `t-gray` / `t-gray-dim` | Title / subtitle on `s-sub` |
| `td-on-dark` / `td-on-dark-dim` | Title / subtitle on `s-sub-dark` |

### Typography

- `tt` — 14px bold centered (titles)
- `td` — 12px normal centered (descriptions)

### Structure

- `c-bx` — Outer container (`rx=10` rounded corners)
- `n-box` — Inner node (`rx=6` rounded corners)
- `arr-line` — Arrow connector

## Spacing Rules

| Property | Value |
|----------|-------|
| viewBox | `0 0 680 H` (H calculated) |
| Outer container | x=30, width=620 |
| Node height (single-line) | 44px |
| Node height (dual-line) | 60px |
| Text y position | `rect.y + rect.height/2` with `dominant-baseline="middle"` |
| Layer gap | 20px |
| Node gap | ≥16px |
| Inner padding | 16px |

## Arrow Marker

Include in every SVG that has arrows:

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
```

`context-stroke` makes the arrowhead inherit the line color automatically.

## Common Patterns

### Two-Layer Side-by-Side

```
Layer 1: Platform (s-plat with s-sub-dark nodes)
Layer 2: Two containers side-by-side (s-proc + s-agent)
```

### Three-Layer Stack

```
Layer 1: Platform (s-plat)
Layer 2: Process (s-proc)
Layer 3: Agent (s-agent)
```

### Single-Layer with Multiple Nodes

For N nodes in one row:
```
node_width = (620 − (N−1)×16) / N
start_x = 30
gap = 16
node_x[i] = start_x + i × (node_width + gap)
```

## Never Do

- `fill="black"` or `fill="inherit"` on text
- Arrows crossing unrelated nodes
- Gradients, shadows, or blur effects
- More than 2 semantic color ramps per diagram
- CSS animations (platform adds reveal animation automatically)

## Quick Reference

```svg
<svg width="100%" viewBox="0 0 680 220" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Diagram Title</title>
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M 2 1 L 8 5 L 2 9" fill="none" stroke="context-stroke" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
<!-- Layer 1: Platform -->
<rect x="30" y="20" width="620" height="60" class="s-plat c-bx"/>
<text x="340" y="50" class="tt t-dark">Layer Name</text>
<!-- Nodes -->
<rect x="50" y="36" width="175" height="34" class="s-sub-dark n-box"/>
<text x="137" y="53" class="tt td-on-dark">Component</text>
<!-- Arrow -->
<line x1="340" y1="80" x2="340" y2="100" class="arr-line" marker-end="url(#arrow)"/>
</svg>
```
