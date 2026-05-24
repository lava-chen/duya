# Chart Module — Data Visualization (Chart.js / D3)

Design specification for data chart widgets. Load this module before calling `show_widget` for any chart or data visualization.

---

## Design Philosophy

- **Flat**: No gradients, no shadows, no blur. Charts must be clean and readable.
- **Transparent background**: Never set `background` on body or outermost container. Host provides the canvas.
- **Minimum font size 11px** for axis labels and legends.
- **Font weight 400 and 500 only**: Never use 600 or 700.
- **Sentence case only**: No Title Case, no ALL CAPS — including axis labels and legend text.
- **Text explanations go in the chat**: Widget output contains only the chart itself.
- **Round every displayed number**: JS float math leaks (0.1+0.2 = 0.30000000000000004). Any number reaching the screen must go through `Math.round()`, `.toFixed(n)`, or `Intl.NumberFormat`. Set `step="1"` on range sliders.
- **No `display: none` during streaming**: Hidden content streams invisibly. Stack all states vertically or use JS-driven toggling only after streaming completes.

---

## CSS Variables (宿主已注入，直接使用)

| Variable | Usage |
|----------|-------|
| `var(--color-background-primary)` | Chart container background |
| `var(--color-background-secondary)` | Tooltip background, legend area |
| `var(--color-text-primary)` | Chart title, primary labels |
| `var(--color-text-secondary)` | Axis labels, legend text |
| `var(--color-border-tertiary)` | Grid lines, tick marks |
| `var(--accent)` | Primary series, highlight |
| `var(--accent-soft)` | Hover state, selected bar |
| `var(--success)` / `var(--success-soft)` | Positive / growth series |
| `var(--warning)` / `var(--warning-soft)` | Medium / neutral series |
| `var(--error)` / `var(--error-soft)` | Negative / error series |
| `var(--font-sans)` | All chart text |
| `var(--font-mono)` | Tick labels, data labels |
| `var(--border-radius-md)` | Tooltip, legend box corners |

**禁止使用**: 任何未在上表列出的自定义变量（如 `--bg-canvas`、`--text`、`--border` 等不存在于宿主）。

---

## Utility Classes (宿主已注入，可直接使用)

```
Flex:    .flex .flex-col .flex-row .items-center .justify-center .justify-between
Grid:    .grid .grid-cols-2 .grid-cols-3 .grid-cols-4
Spacing: .gap-1 .gap-2 .gap-3 .gap-4 / .p-1 .p-2 .p-3 .p-4
Text:    .text-xs .text-sm .text-base .font-mono
Size:    .w-full .h-full
```

---

## Multi-Series Color Palette

使用顺序固定，确保在浅色和深色背景下都有足够对比度：

```
#4f8cff  (Blue)     #ff6b6b  (Red)      #ffd93d  (Yellow)
#6ee7b7  (Green)    #a78bfa  (Purple)   #fb923c  (Orange)
#67e8f9  (Cyan)     #f472b6  (Pink)     #a3e635  (Lime)
```

单系列图表优先用 `var(--accent)`，不要硬编码颜色。

---

## CDN (仅允许以下域名，其他被 CSP 拦截)

```
cdnjs.cloudflare.com   cdn.jsdelivr.net   unpkg.com   esm.sh
```

---

## Streaming Constraints

输出顺序必须严格遵守：`<style>` → 内容 HTML → `<script>`

Chart.js / D3 需要 DOM 节点存在才能初始化，`<script>` 必须在最后。

---

## Chart.js Example

```html
<style>
.chart-wrap { width: 100%; max-width: 620px; margin: 0 auto; }
canvas { width: 100% !important; }
</style>

<div class="chart-wrap">
  <canvas id="chart"></canvas>
</div>

<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<script>
const ctx = document.getElementById('chart').getContext('2d');
const style = getComputedStyle(document.documentElement);
const textColor = style.getPropertyValue('--color-text-secondary').trim();
const gridColor = style.getPropertyValue('--color-border-tertiary').trim();
const accent = style.getPropertyValue('--accent').trim();

new Chart(ctx, {
  type: 'bar',
  data: {
    labels: ['Jan', 'Feb', 'Mar', 'Apr'],
    datasets: [{
      label: 'Users',
      data: [120, 145, 180, 210],
      backgroundColor: accent,
      borderWidth: 0,
      borderRadius: 4
    }]
  },
  options: {
    responsive: true,
    plugins: {
      legend: { display: false }
    },
    scales: {
      y: {
        beginAtZero: true,
        grid: { color: gridColor },
        ticks: { font: { size: 11 }, color: textColor }
      },
      x: {
        grid: { display: false },
        ticks: { font: { size: 11 }, color: textColor }
      }
    }
  }
});
</script>
```

**关键点**：通过 `getComputedStyle` 读取 CSS 变量再传给 Chart.js，而不是直接在 options 里写 `var(--accent)`（Chart.js 不解析 CSS 变量）。

---

## D3.js Example

```html
<style>
#chart { width: 100%; height: 300px; }
</style>
<div id="chart"></div>
<script src="https://cdn.jsdelivr.net/npm/d3@7"></script>
<script>
const style = getComputedStyle(document.documentElement);
const accent = style.getPropertyValue('--accent').trim();
const textColor = style.getPropertyValue('--color-text-secondary').trim();

const data = [
  { name: 'Q1', value: 120 },
  { name: 'Q2', value: 145 },
  { name: 'Q3', value: 180 },
  { name: 'Q4', value: 210 }
];

const margin = { top: 20, right: 20, bottom: 36, left: 44 };
const container = document.getElementById('chart');
const W = container.clientWidth || 620;
const H = 300;
const w = W - margin.left - margin.right;
const h = H - margin.top - margin.bottom;

const svg = d3.select('#chart').append('svg')
  .attr('width', W).attr('height', H);
const g = svg.append('g')
  .attr('transform', `translate(${margin.left},${margin.top})`);

const x = d3.scaleBand().domain(data.map(d => d.name)).range([0, w]).padding(0.3);
const y = d3.scaleLinear().domain([0, d3.max(data, d => d.value)]).nice().range([h, 0]);

g.append('g').attr('transform', `translate(0,${h})`).call(d3.axisBottom(x))
  .selectAll('text').style('fill', textColor).style('font-size', '11px');
g.append('g').call(d3.axisLeft(y).ticks(5))
  .selectAll('text').style('fill', textColor).style('font-size', '11px');

g.selectAll('rect').data(data).join('rect')
  .attr('x', d => x(d.name))
  .attr('y', d => y(d.value))
  .attr('width', x.bandwidth())
  .attr('height', d => h - y(d.value))
  .attr('fill', accent)
  .attr('rx', 3);
</script>
```

---

## Best Practices

- 单系列图表隐藏 legend（`legend: { display: false }`）
- 柱状图始终 `beginAtZero: true`，除非有明确理由不这样做
- 坐标轴标签简短清晰
- 饼图不超过 5 个分类，超过用柱状图代替
- 保持数据内联，禁止在 widget 内发起 API 请求
- 不要用 `sendPrompt` 做计算，计算逻辑放 JS