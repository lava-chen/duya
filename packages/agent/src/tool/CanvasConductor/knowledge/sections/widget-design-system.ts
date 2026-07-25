/**
 * canvas_get_knowledge section: widget-design-system
 * Density, typography, spacing, and color rules for widget/dynamic.
 */
export const CONTENT = `## Widget/dynamic Design System

Use these rules for every agent-generated widget/dynamic element. The goal is legibility at the default canvas zoom, not packing the maximum amount of information into one container.

### Canvas Scaling (read this first)

The canvas viewport defaults to framing the entire 40 x 30 grid on screen. This creates a counter-intuitive effect: **the larger a single widget is, the more the whole canvas zooms out to fit it, and the smaller its text appears.** A 36 x 20 widget looks "big" in grid units but renders as a tiny card because everything is scaled down. A smaller widget lets the canvas stay zoomed in, so the same text actually looks larger.

### Size Budget

- **Hard upper limit: w ≤ 14, h ≤ 10** (1120 x 800 px). Never exceed this.
- **Preferred range for explanatory diagrams: w=8-12, h=5-8.** Start here and only approach the hard limit when the content truly needs it.
- For dashboards with many metrics, prefer w=10-12, h=6-8.
- For single cards or small tools, prefer w=5-7, h=4-6.

### Information Density Budget

A widget is read as one composed image, not a scrollable document.

- **Aim for 4-6 visual sections total.** If the diagram needs more, it is too dense.
- **Each section = short title + at most one subtitle of ≤5 Chinese words.** Do not write full sentences or detailed file-line descriptions inside boxes.
- **Prefer hierarchy over enumeration.** "文件层" with subtitle "页面骨架 / 样式 / 脚本 / 资源" is better than four full-width file rows.
- **Details belong elsewhere.** If the user needs the full list (every file, every component, every metric), keep a concise overview widget in the reference zone and offer to create a separate detailed widget on demand. Do not turn the overview into a wall of text.

### Typography

- Base font-family: sans-serif.
- Section title: 16-18px, font-weight 600.
- Subtitle / secondary text: 12-14px, color #64748b or #475569.
- Body text inside boxes: 13-14px.
- Never go below 11px for primary content.

### Spacing

- Outer padding: 12-16px.
- Gap between sections: 10-12px.
- Internal gap inside a section: 6-8px.
- Border-radius: 6-8px for cards, 4px for small tags.

### Color Palette

Reuse the same semantic palette as native stickies so the canvas reads as one visual system:

| Semantic | Fill | Stroke / Text |
|----------|------|---------------|
| Neutral / default | #fef9c3 (yellow) | #854f0b |
| Info / process | #e6f1fb (blue) | #185fa5 |
| Success / done | #e1f5ee (green) | #0f6e56 |
| Error / warning | #fcebeb (pink/red) | #a32d2d |
| Message / cross-system | #eeedfe (purple) | #534ab7 |
| Sub / terminal | #f1efe8 (gray) | #5f5e5a |

### Splitting Strategy

When content exceeds the density budget:

1. Keep a high-level overview widget (4-6 sections) in the reference zone.
2. Offer to create one or more detail widgets for the parts the user wants to drill into.
3. Never try to make one widget serve both "global overview" and "deep detail" at the same time.
`;