# Interactive Module — Calculators / Mini-Apps / Explainers

Design specification for interactive widgets: calculators, converters, sliders, steppers, mini-apps with user controls. Load this module before calling `show_widget` for any widget with user interaction.

---

## Design Philosophy

- **Flat**: No gradients, no shadows, no blur effects.
- **Transparent background**: Never set `background` on body or outermost container.
- **Minimum font size 11px**: Controls and labels must be readable.
- **Font weight 400 and 500 only**: Never use 600 or 700.
- **Sentence case only**: No Title Case, no ALL CAPS.
- **Text explanations go in the chat**: Widget contains only the interactive element.
- **No `position: fixed`**: Causes iframe height collapse.
- **No CSS animations**: Host adds a reveal animation automatically.
- **No `localStorage` / `sessionStorage`**: Sandboxed iframe blocks these APIs entirely — they throw, they do not silently fail.
- **No `display: none` during streaming**: Hidden content streams invisibly. Use JS-driven toggling only after streaming completes.
- **Round every displayed number**: `0.1 + 0.2 = 0.30000000000000004`. Any number shown to the user must pass through `Math.round()`, `.toFixed(n)`, or `Intl.NumberFormat`. Set `step="1"` (or appropriate step) on range sliders.
- **No React / JSX**: Widget code is raw HTML. No transpiler available.

---

## CSS Variables (宿主已注入，直接使用)

| Variable | Usage |
|----------|-------|
| `var(--color-background-primary)` | Container background, card bg |
| `var(--color-background-secondary)` | Input fields, result areas, tag bg |
| `var(--color-text-primary)` | Primary labels, result values |
| `var(--color-text-secondary)` | Secondary labels, descriptions |
| `var(--color-text-tertiary)` | Placeholder, hints |
| `var(--color-border-tertiary)` | Input borders, section dividers |
| `var(--accent)` | Primary button bg, active state |
| `var(--accent-soft)` | Button hover, selected state |
| `var(--success)` / `var(--success-soft)` | Success result |
| `var(--warning)` / `var(--warning-soft)` | Warning state |
| `var(--error)` / `var(--error-soft)` | Error state, invalid input |
| `var(--font-sans)` | All UI text |
| `var(--font-mono)` | Numeric outputs, code |
| `var(--border-radius-md)` | Inputs, buttons (8px) |
| `var(--border-radius-lg)` | Cards, containers (12px) |

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
- Default: `0.5px solid var(--color-border-tertiary)`
- Focus ring: `box-shadow: 0 0 0 2px var(--accent-soft)` (no outline)

### Border Radius
- Inputs and buttons: `var(--border-radius-md)` (8px)
- Cards and containers: `var(--border-radius-lg)` (12px)
- Inline chips / tags: `4px`

### Inputs
```css
padding: 6px 10px;
font-size: 13px;
font-family: var(--font-sans);
border: 0.5px solid var(--color-border-tertiary);
border-radius: var(--border-radius-md);
background: var(--color-background-secondary);
color: var(--color-text-primary);
```

### Buttons
```css
/* Default */
display: inline-flex;
align-items: center;
gap: 6px;
padding: 6px 14px;
font-size: 13px;
font-weight: 500;
font-family: var(--font-sans);
border: 0.5px solid var(--color-border-tertiary);
border-radius: var(--border-radius-md);
background: var(--color-background-primary);
color: var(--color-text-primary);
cursor: pointer;

/* Primary variant */
background: var(--accent);
color: #fff;
border-color: var(--accent);
```

```html
<!-- Button template -->
<button class="btn" onclick="compute()">Calculate</button>
<button class="btn btn-primary" onclick="compute()">Run</button>
```

### Range Sliders
```html
<input type="range" min="0" max="100" value="50" step="1" id="slider">
```
Always read value as `parseInt(el.value, 10)` or `parseFloat(el.value)` — never display raw `.value` string.

---

## sendPrompt(text) — Global Function

宿主注入的全局函数，调用后相当于用户在对话框发送了一条消息。

```html
<!-- 触发跟进问题 -->
<button onclick="sendPrompt('Explain why this result is negative')">Why negative?</button>

<!-- 请求相关内容 -->
<button onclick="sendPrompt('Show me the architecture diagram')">Show diagram</button>

<!-- 声明式写法 -->
<button data-send-message="Explain this calculation">Explain</button>
```

**什么时候用 sendPrompt**：
- 请求 Claude 解释、扩展、或生成相关内容
- 跳转到另一个话题或请求新的 widget

**什么时候不用 sendPrompt（直接用 JS）**：
- 计算、换算、排序、过滤 — 这些在 JS 里做，0 延迟
- 表单验证、输入格式化
- 切换显示状态

> 错误模式：用户点击"Calculate"→ `sendPrompt('calculate: ' + inputs)` → 等待 Claude 响应
> 正确模式：用户点击"Calculate"→ JS 直接算 → 立刻更新 DOM

---

## CDN (仅允许以下域名，其他被 CSP 拦截)

```
cdnjs.cloudflare.com   cdn.jsdelivr.net   unpkg.com   esm.sh
```

---

## Streaming Constraints

输出顺序必须严格遵守：`<style>` → 内容 HTML → `<script>`

DOM 必须在脚本执行前存在，所有 `addEventListener` 和初始化逻辑放在最后的 `<script>` 里。

---

## Format Template

```html
<style>
/* 样式放最前 */
.container { ... }
.btn { ... }
</style>

<div class="container p-3">
  <!-- 控件 -->
  <div class="flex gap-2 items-center">
    <label class="text-sm" style="color: var(--color-text-secondary);">Years</label>
    <input type="range" min="1" max="40" value="20" step="1" id="years">
    <span class="font-mono text-sm" id="years-out">20</span>
  </div>

  <!-- 结果区域 -->
  <div style="
    background: var(--color-background-secondary);
    border-radius: var(--border-radius-md);
    padding: 12px 16px;
    margin-top: 12px;
  ">
    <span style="font-size: 11px; color: var(--color-text-tertiary);">Result</span>
    <div class="font-mono text-2xl" id="result" style="color: var(--color-text-primary);">—</div>
  </div>
</div>

<script>
/* JS 放最后 */
const slider = document.getElementById('years');
const out = document.getElementById('years-out');
const result = document.getElementById('result');

function compute() {
  const n = parseInt(slider.value, 10);
  out.textContent = n;
  // 计算逻辑，记得 round
  result.textContent = Math.round(1000 * Math.pow(1.07, n)).toLocaleString();
}

slider.addEventListener('input', compute);
compute(); // 初始化
</script>
```

---

## Anti-Patterns

```
✗ position: fixed
✗ localStorage / sessionStorage
✗ display: none 在流式期间
✗ 展示未 round 的浮点数
✗ sendPrompt 做计算
✗ font-weight: 600 / 700
✗ 渐变、阴影、blur
✗ 外部 API 调用（非 CDN 域名）
```