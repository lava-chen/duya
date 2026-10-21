# Mockup Module — HTML Cards / Dashboards / UI Components

Design specification for HTML-based visual components: data cards, dashboards, comparison grids, key-value summaries, status boards. Load this module before calling `show_widget` for any card or dashboard widget.

---

## Design Philosophy

- **Flat**: No gradients, no shadows, no blur effects.
- **Transparent background**: Never set `background` on body or outermost container.
- **Minimum font size 11px**.
- **Font weight 400 and 500 only**: Never use 600 or 700.
- **Sentence case only**: No Title Case, no ALL CAPS — including card titles, labels, tags.
- **Text explanations go in the chat**: Widget output contains only visual elements.
- **No `position: fixed`**: Causes iframe height collapse.
- **No CSS animations**: Host adds reveal animation automatically.
- **No `display: none` during streaming**: Flickers. Stack content vertically; use JS toggling only post-stream.
- **No nested scrolling**: Height auto-fits. Do not set `overflow: auto` on inner containers.
- **Round every displayed number**: Any number shown to the user must pass through `Math.round()`, `.toFixed(n)`, or `Intl.NumberFormat`.
- **Text on colored background**: Always use the dark end of the same color family, never plain black or `var(--color-text-primary)`.
- **Single-side borders get no border-radius**: If using `border-left` or `border-top` accent, set `border-radius: 0`.
- **No React / JSX**: Widget code is raw HTML. No transpiler available.

---

## CSS Variables (宿主已注入，直接使用)

| Variable | Usage |
|----------|-------|
| `var(--color-background-primary)` | Card background |
| `var(--color-background-secondary)` | Note background, tag bg, metric card bg |
| `var(--color-text-primary)` | Card titles, body text |
| `var(--color-text-secondary)` | Values, subtitles |
| `var(--color-text-tertiary)` | Labels, dim content, hints |
| `var(--color-border-tertiary)` | Card borders, dividers |
| `var(--accent)` | Primary accent stroke, highlighted value |
| `var(--accent-soft)` | Highlighted card border (2px, only exception) |
| `var(--success)` / `var(--success-soft)` | Positive, done |
| `var(--warning)` / `var(--warning-soft)` | Medium, in progress |
| `var(--error)` / `var(--error-soft)` | Negative, blocked |
| `var(--font-sans)` | All UI text |
| `var(--font-mono)` | Numeric values, code snippets |
| `var(--border-radius-md)` | Inner elements, tags, chips (8px) |
| `var(--border-radius-lg)` | Cards and containers (12px) |

---

## Utility Classes (宿主已注入，直接使用)

```
Flex:    .flex .flex-col .flex-row .flex-wrap .items-center .justify-center .justify-between
Grid:    .grid .grid-cols-2 .grid-cols-3 .grid-cols-4
Spacing: .gap-1 .gap-2 .gap-3 .gap-4 / .p-1 .p-2 .p-3 .p-4
Text:    .text-xs .text-sm .text-base .text-lg .text-xl .text-2xl
         .text-center .text-left .text-right
         .font-bold .font-semibold .font-mono
Size:    .w-full .h-full
Overflow:.overflow-auto .overflow-hidden
```

---

## Component Rules

### Borders
- Default card border: `0.5px solid var(--color-border-tertiary)`
- Highlighted/featured card: `2px solid var(--accent-soft)` — 唯一允许使用 2px 的情形
- Dividers: `0.5px solid var(--color-border-tertiary)`
- Single-side accent (`border-left`): `border-radius: 0` — 禁止在单侧 border 上加圆角

### Border Radius
- Cards and containers: `var(--border-radius-lg)` (12px)
- Inner elements, tags: `var(--border-radius-md)` (8px)
- Inline chips: `4px`

### Icons
- 使用 **Tabler outline** 字体 (`ti ti-*` class)，不要手绘 SVG path
- 大小：16px inline，24px 最大装饰
- 颜色：`var(--color-text-secondary)` 或跟随父元素颜色
- 装饰性图标加 `aria-hidden="true"`

---

## Card Layout Pattern

```html
<style>
.grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(260px, 1fr)); gap: 12px; }
.card { background: var(--color-background-primary); border: 0.5px solid var(--color-border-tertiary); border-radius: var(--border-radius-lg); overflow: hidden; }
.card-head { padding: 10px 14px 8px; border-bottom: 0.5px solid var(--color-border-tertiary); display: flex; align-items: center; gap: 8px; }
.card-head i { font-size: 16px; color: var(--color-text-secondary); }
.card-title { font-size: 13px; font-weight: 500; color: var(--color-text-primary); }
.card-body { padding: 12px 14px; display: flex; flex-direction: column; gap: 8px; }
.row { display: flex; gap: 6px; align-items: flex-start; }
.label { font-size: 11px; color: var(--color-text-tertiary); min-width: 64px; padding-top: 1px; flex-shrink: 0; }
.val { font-size: 12px; color: var(--color-text-secondary); line-height: 1.5; font-family: var(--font-mono); }
.note { font-size: 11px; color: var(--color-text-tertiary); line-height: 1.5; padding: 6px 8px; background: var(--color-background-secondary); border-radius: 6px; margin-top: 2px; }
.divider { height: 0.5px; background: var(--color-border-tertiary); margin: 2px 0; }
</style>

<div class="grid">
  <div class="card">
    <div class="card-head">
      <i class="ti ti-database" aria-hidden="true"></i>
      <span class="card-title">Storage</span>
    </div>
    <div class="card-body">
      <div class="row">
        <span class="label">Total</span>
        <span class="val">128 GB</span>
      </div>
      <div class="row">
        <span class="label">Used</span>
        <span class="val">42.3 GB</span>
      </div>
      <div class="divider"></div>
      <div class="note">Last synced 3 minutes ago</div>
    </div>
  </div>
</div>
```

---

## Metric Card Pattern (数字摘要卡)

```html
<style>
.metrics { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 10px; }
.metric { background: var(--color-background-secondary); border-radius: var(--border-radius-md); padding: 14px 16px; }
.metric-label { font-size: 11px; color: var(--color-text-tertiary); margin-bottom: 4px; }
.metric-value { font-size: 24px; font-weight: 500; color: var(--color-text-primary); font-family: var(--font-mono); line-height: 1.1; }
.metric-sub { font-size: 11px; color: var(--color-text-tertiary); margin-top: 2px; }
</style>

<div class="metrics">
  <div class="metric">
    <div class="metric-label">Total requests</div>
    <div class="metric-value">12,847</div>
    <div class="metric-sub">↑ 8% vs last week</div>
  </div>
  <div class="metric">
    <div class="metric-label">Error rate</div>
    <div class="metric-value" style="color: var(--error);">0.3%</div>
    <div class="metric-sub">Below threshold</div>
  </div>
</div>
```

---

## Tag / Badge Classes (宿主已预注入)

```html
<span class="tag tag-t">Done</span>
<span class="tag tag-a">In progress</span>
<span class="tag tag-r">Blocked</span>
<span class="tag tag-p">Preview</span>
<span class="tag tag-gray">Neutral</span>
```

| Class | bg / text | 用途 |
|-------|-----------|------|
| `.tag-t` | `success-soft` / `success` | 低复杂度、已完成、正面 |
| `.tag-a` | `warning-soft` / `warning` | 中等、进行中 |
| `.tag-r` | `error-soft` / `error` | 高复杂度、阻塞 |
| `.tag-p` | `accent-soft` / `accent` | 特殊、Preview、强调 |
| `.tag-gray` | `secondary` bg / `secondary` text | 中性、默认 |

---

## Comparison Card Pattern (对比/决策场景)

```html
<!-- 推荐项用 2px accent 边框 + 角标，其他保持默认 -->
<div class="card" style="border: 2px solid var(--accent-soft); position: relative;">
  <span class="tag tag-p" style="position: absolute; top: -1px; right: 12px; border-radius: 0 0 4px 4px;">
    Recommended
  </span>
  <!-- card content -->
</div>
```

---

## Avatar / Initials Circle

```html
<div style="
  width: 40px; height: 40px;
  border-radius: 50%;
  background: var(--accent-soft);
  display: flex; align-items: center; justify-content: center;
  font-size: 14px; font-weight: 500;
  color: var(--accent);
">CX</div>
```

---

## CDN (仅允许以下域名，其他被 CSP 拦截)

```
cdnjs.cloudflare.com   cdn.jsdelivr.net   unpkg.com   esm.sh
```

---

## Streaming Constraints

输出顺序：`<style>` → 内容 HTML → `<script>`

---

## Anti-Patterns

```
✗ position: fixed
✗ display: none 在流式期间
✗ 嵌套滚动容器（overflow: auto on inner divs）
✗ 单侧 border 加 border-radius
✗ 有色背景上用 var(--color-text-primary) 或黑色文字
✗ font-weight: 600 / 700
✗ 渐变、阴影、blur
✗ 展示未 round 的浮点数
✗ 手绘 SVG 图标（用 Tabler ti-* 代替）
✗ 超过 2px 的 border（除高亮卡片外）
```