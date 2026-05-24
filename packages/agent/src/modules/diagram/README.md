# Diagram Module — SVG Flowcharts / Architecture / Structure

Design specification for SVG-based diagrams: flowcharts, architecture diagrams, sequence diagrams, structure charts. Load this module before calling `show_widget` for any SVG diagram.

---

## Design Philosophy

- **Flat**: No gradients, no shadows, no blur.
- **Transparent background**: Never set `background` on body or outermost element.
- **Minimum font size 11px**.
- **Font weight 400 and 500 only**: Never use 600 or 700.
- **Sentence case only**: No Title Case, no ALL CAPS — including node labels.
- **Text explanations go in the chat**: Widget output contains only the SVG.
- **Pre-plan coordinates before writing SVG**: List layers, node counts, and calculated dimensions in a comment block first. Never improvise coordinates.
- **No `display: none` during streaming**: Flickers during DOM diff.

---

## CSS Variables (宿主已注入，直接使用)

| Variable | Usage |
|----------|-------|
| `var(--color-text-primary)` | Fallback text |
| `var(--color-text-secondary)` | Dim labels |
| `var(--color-border-tertiary)` | Connector lines without class |
| `var(--accent)` | Highlight stroke |
| `var(--font-sans)` | foreignObject text (如需) |

**大多数情况下直接使用下方预注入的 class，不需要手写颜色变量。**

---

## SVG Diagram Classes (宿主已预注入到 iframe，直接使用)

### Container colors (用于 `<rect>`)

| Class | 颜色语义 | 适用场景 |
|-------|---------|---------|
| `.s-plat` | Deep Blue | OS、外部平台、顶层 shell |
| `.s-proc` | Blue | 主进程、核心层 |
| `.s-agent` | Green | Agent 流程、成功路径 |
| `.s-msg` | Purple | IPC、消息、通信节点 |
| `.s-err` | Red | 错误、危险 |
| `.s-chk` | Amber | 检查点、决策节点 |
| `.s-sub` | Gray | 浅色背景内的子组件 |
| `.s-sub-dark` | Dark Gray | 深色背景内的子组件 |

### Text colors (用于 `<text>`)

| Class | 适用场景 |
|-------|---------|
| `.t-dark` | 标题文字，位于 `.s-plat` 上 |
| `.t-dim` | 副标题文字，位于 `.s-plat` 上 |
| `.t-light` | 标题文字，位于 `.s-proc` 上 |
| `.t-green` | 标题文字，位于 `.s-agent` 上 |
| `.t-gray` | 标题文字，位于 `.s-sub` 上 |
| `.t-gray-dim` | 副标题文字，位于 `.s-sub` 上 |
| `.td-on-dark` | 标题文字，位于 `.s-sub-dark` 上 |
| `.td-on-dark-dim` | 副标题文字，位于 `.s-sub-dark` 上 |

**规则**：文字 class 必须与背景 class 配对使用，禁止在有色背景上用 `fill="black"` 或 `fill="inherit"`。

### Typography

| Class | 样式 | 用途 |
|-------|------|------|
| `.tt` | 14px, font-weight 500, text-anchor middle | 节点标题 |
| `.td` | 12px, font-weight 400, text-anchor middle | 节点副标题/描述 |

### Layout

| Class | 用途 |
|-------|------|
| `.c-bx` | 外层容器矩形，`rx=10` |
| `.n-box` | 内层节点矩形，`rx=6` |
| `.arr-line` | 箭头连线 |

---

## Coordinate Calculation (必须先算，再写 SVG)

在写任何 SVG 坐标之前，先在注释里列出计划：

```
<!-- PLAN
  Layers: 3
  Layer 1: 1 node  → node_width = 620
  Layer 2: 3 nodes → node_width = (620 - 2×16) / 3 = 196
  Layer 3: 2 nodes → node_width = (620 - 1×16) / 2 = 302
  Node heights: all 44px (single-line)
  H = 20 + 3×(44+20) + 30 = 242
  viewBox: 0 0 680 242
-->
```

**公式**：

```
viewBox width:  680 (固定)
viewBox height: H = 20 + (层数 × (节点高 + 层间距20)) + 30

同行 N 个节点的宽度：
  node_width = (620 − (N−1) × 16) / N

节点起始 x（第 i 个，从0计）：
  x = 30 + i × (node_width + 16)

文字 y 坐标（单行节点）：
  y = rect.y + 22  (= rect.y + rect.height/2，配合 dominant-baseline="middle")

文字属性必须加：
  dominant-baseline="middle"  text-anchor="middle"
```

节点高度参考：
- 单行文字（仅 `.tt`）：44px
- 双行文字（`.tt` + `.td`）：60px，标题 y = rect.y+20，副标题 y = rect.y+40

---

## Arrow Marker (每个含箭头的 SVG 必须包含)

```svg
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>
```

`context-stroke` 让箭头头自动继承线条颜色，不需要单独设置。

连线示例：
```svg
<line x1="340" y1="84" x2="340" y2="100"
      class="arr-line" marker-end="url(#arrow)"/>
```

---

## Color Usage Rules

- 每张图最多使用 2 个语义色 ramp（不算 gray）
- Gray（`.s-sub`）用于中性/结构节点
- 颜色按**节点类型**分配，不按顺序循环

---

## NEVER

- `fill="black"` 或 `fill="inherit"` 加在 `<text>` 上
- 箭头穿越不相关节点
- 渐变、阴影、blur
- 不经过计算直接猜坐标
- 超过 2 个语义色 ramp

---

## Reference Example (3-layer architecture)

```svg
<!-- PLAN
  Layer 1: 1 wide node (platform shell)，含2个子节点
  Layer 2: 2 nodes side-by-side
  Node heights: outer 60px, inner 34px
  H = 20 + (60+20) + (80+20) + 30 = 230
-->
<svg width="100%" viewBox="0 0 680 230" role="img" xmlns="http://www.w3.org/2000/svg">
<title>Three-layer architecture</title>
<desc>Platform shell containing two sub-nodes on top, two process nodes below</desc>
<defs>
  <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5"
          markerWidth="6" markerHeight="6" orient="auto-start-reverse">
    <path d="M2 1L8 5L2 9" fill="none" stroke="context-stroke"
          stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
  </marker>
</defs>

<!-- Layer 1: Platform shell -->
<rect x="30" y="20" width="620" height="60" class="s-plat c-bx"/>
<text x="340" y="38" class="tt t-dark" dominant-baseline="middle" text-anchor="middle">Platform</text>
<rect x="50" y="36" width="260" height="34" class="s-sub-dark n-box"/>
<text x="180" y="53" class="tt td-on-dark" dominant-baseline="middle" text-anchor="middle">Main process</text>
<rect x="370" y="36" width="260" height="34" class="s-sub-dark n-box"/>
<text x="500" y="53" class="tt td-on-dark" dominant-baseline="middle" text-anchor="middle">Renderer</text>

<!-- Layer 2: Two process nodes -->
<rect x="30" y="120" width="296" height="60" class="s-proc c-bx"/>
<text x="178" y="143" class="tt t-light" dominant-baseline="middle" text-anchor="middle">Agent layer</text>
<rect x="46" y="154" width="264" height="16" class="s-sub n-box"/>
<text x="178" y="162" class="td t-gray" dominant-baseline="middle" text-anchor="middle">ConductorAgent</text>

<rect x="354" y="120" width="296" height="60" class="s-agent c-bx"/>
<text x="502" y="143" class="tt t-green" dominant-baseline="middle" text-anchor="middle">Widget layer</text>
<rect x="370" y="154" width="264" height="16" class="s-sub n-box"/>
<text x="502" y="162" class="td t-gray" dominant-baseline="middle" text-anchor="middle">CanvasStore</text>

<!-- Arrows -->
<line x1="178" y1="80" x2="178" y2="120" class="arr-line" marker-end="url(#arrow)"/>
<line x1="502" y1="80" x2="502" y2="120" class="arr-line" marker-end="url(#arrow)"/>
</svg>
```

---

## Tag Classes (状态/复杂度标签，可用于节点内或图例)

```
.tag-t  → success-soft bg / success text  (低复杂度、已完成)
.tag-a  → warning-soft bg / warning text  (中等、进行中)
.tag-r  → error-soft bg / error text      (高复杂度、阻塞)
.tag-p  → accent-soft bg / accent text    (特殊、强调)
.tag-gray → secondary bg / secondary text (中性)
```