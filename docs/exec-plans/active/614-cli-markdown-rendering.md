# 614 — CLI Markdown 渲染补齐与 own 渲染器转默认

> **Status**: Phase 0 未跑（own↔blessed 视觉等价尚未证明） · **Priority**: P1 · **Owner**: agent
> **立项**: 2026-10-18 · **实证日期**: 2026-10-18（本文件每条「现状」都带探针实测数据，`\;` 探针文件跑完已删）
> **分界**: 只覆盖 `packages/cli/src/tui` 的**渲染层**（`transcript-view.ts` / `theme.ts` /
> `width.ts` / `screen/**` / `terminal/sgr.ts`）。不动协议、不动 Host、不动 Desktop。
> **前置**: [611](611-tui-ux-overhaul.md) Wave 1–4 已落地（主题 token 化 + GFM 表格 + 流式提交）。

---

## 0. 一句话目标

让 thinking 区块和 assistant 最终回答在 duya CLI 里得到与 pi 同级的 Markdown 呈现——加粗、**斜体**、代码块、删除线、图片语义、文件/网络链接、分级标题、真列表符号、按宽度渲染的分隔线——并把表格的列对齐修正确。第二条线不在特性清单里，但它必须排在前面：**顺带修掉一个既挡不住模型文本注入、又在每个 `{` 前多打印一个反斜杠的存量转义 bug**。

---

## 1. 与既有计划的分界（先查过再落笔，避免重复真相）

| 条目 | 611 的处理 | 614 的处置 |
|---|---|---|
| GFM 管道表格 | §7 W2.5.1 已实现（`renderTable`） | **修它的两个 bug**，不重写 |
| latex Unicode 渲染 | Wave 2 舍弃项「被否」（611:157） | **不做**，理由继承 611，见 §2 Out |
| markdown stable-prefix 流式缓存 | Wave 2「暂缓」（611:157） | **不做**，但新 tokenizer 必须保持 per-block memoize 的缓存契约（§5.4） |
| 主题 token 化 | Wave 1 已落地（`theme.ts`） | 在其上**加 token**，不改机制 |
| `/compact` | 无关 | 见 613 |
| own 渲染器 | 611 未涉及（作为 opt-in 存在） | 614 把它**转为默认**，理由见 D3 |

---

## 2. Scope

### In

| # | 项 | 落点 |
|---|---|---|
| I1 | 转义语义统一：`\{` → `{open}` | `transcript-view.ts` + `screen/own/markup.ts` + `terminal/sgr.ts` |
| I2 | 手写 inline tokenizer 替换现有单条大正则 | 新建 `tui/markdown/inline.ts` |
| I3 | 表格列边错位修复（两个独立 bug） | `transcript-view.ts:263-324` |
| I4 | 分级标题 / 列表符号 / 按宽分隔线 | `transcript-view.ts:421-457` |
| I5 | thinking 走同一条 Markdown 渲染 | `transcript-view.ts:942-991` |
| I6 | 文件/网络链接识别与呈现 | 新建 `tui/markdown/links.ts` |
| I7 | 图片 `![alt](src)` 不再退化成 `!alt (src)` | I2 的一部分 |
| I8 | 真斜体 / 删除线 / 下划线 | `theme.ts` + 三条渲染链各自的属性表 |
| I9 | own 渲染器转默认（带 env 回滚开关） | `screen/factory.ts:16-19` |

### Out（每条写理由）

| # | 项 | 理由 |
|---|---|---|
| O1 | OSC 8 真超链 | **技术上不可行**：blessed 的 cell walker（`blessed/lib/widgets/element.js:1999-2014`）只认 `/^\x1b\[[\d;]*m/`，OSC 的 `\x1b]...\x1b\\` 不匹配 ⇒ `\x1b` 被当**可见字符**写出，整行错位。pi 能做是因为它自己吐 ANSI 自己算宽度。要做得连 cell walker 一起重写，属换 renderer 之外的第二件事。 |
| O2 | LaTeX 渲染 | 继承 611:157 的裁定。但**必须顺带保证 `$...$` 里的花括号不再被打碎**（I1 自动解决）。 |
| O3 | 代码块语法高亮 | 需要 token 到 256 色映射表，性价比低；且会破坏 block 内行结构的 byte 稳定性。 |
| O4 | 表格单元格换行（wrap） | **违反行数不变式**（§5.4）。超宽继续截断。 |
| O5 | 终端内联图片（kitty/sixel） | 属 O1 的同类问题 + 终端能力协商，独立立项。 |
| O6 | 引入 `marked` | 见 D1 裁定。 |

---

## 3. 现状实证（每条都有探针数据）

探针方式：直接对样例 Markdown 打 `renderOneBlock`，剥标签后用 `visibleWidth` 逐字符扫描记录 `│`/`┼` 的实际列号。

### 3.1 thinking 完全不过 Markdown

`thinkingBody`（`:942`）→ `thinkingRows`（`:989`）的实现是 `lines.map((line) => `${indent}${styles.muted(line)}`)`。

实测：注入含 `## Considering`、`- **first**`、`| A | B |` 的思考文本，expanded 模式下**逐行原样吐出**，连管道号都不参与表格判定。pi 侧 `assistant-message.ts:111/147` 对 assistant 与 thinking **都** `new Markdown(...)`，thinking 额外传 `{ color: thinkingText, italic: true }`。

### 3.2 表格列边错位（两个独立 bug）

实测同一个表的四行，`│` 落点：

```
header       edges=[10,19]   "● Name    │ Role   │ Notes ..."
delimiter    edges=[11,20]   "  ─────────┼────────┼───── ..."
body(含代码) edges=[8,17]    "  alpha │ reader │ first row ..."
body(纯文本) edges=[10,19]   "  beta    │ writer │ second ..."
```

- **Bug A（off-by-one）**：`:319` 用 `'─'.repeat(w + 2)` 构造分隔行，而行本身是 `cell(w) + 1 空格 + '│'` ⇒ 分隔行的 `┼` 落在 `w+2`，行的 `│` 落在 `w+1`，**系统性右移 1 列**。应改成 `w + 1`。
- **Bug B（raw vs rendered 宽度）**：`:278` 用 `visibleWidth(row[c])` 在 **raw** 文本上算列宽，但填进格子的是 `renderInlineMarkdown` 的 **rendered** 结果。`` `alpha` `` raw 7 宽、渲染后 5 宽 ⇒ 该行左移 2 列。

### 3.3 `escapeTags` 是坏的：既挡不住注入，又制造可见垃圾

`transcript-view.ts:151` 把所有 `{` 换成 `\{`。但 blessed 的 `_parseTags`（`node_modules/blessed/lib/widgets/element.js:419-522`）只认 `{escape}` / `{open}` / `{close}` / 颜色标签，**完全不认 `\{`**。逐案例实测（`blessed.Elements.Box#_parseTags`，`<ESC>` 即 `\x1b`）：

| 源文本 | 现状 `\{` 的 blessed 输出 | 提案 `{open}` 的输出 |
|---|---|---|
| `config = {"a": 1}` | `config = \{"a": 1}` ← **多了可见 `\`** | `config = {"a": 1}` |
| `$x = \frac{-b}{2a}$` | `$x = \frac\{-b\}\{2a}$` | 原样 |
| `nested {{ }} braces` | `nested \{\{ }} braces` | 原样 |
| `a{/gray-fg}b` | `a\<ESC>[39mb` ← **模型注入的标签被执行** | `a{/gray-fg}b` |
| `a{bold}b` | `a\<ESC>[1mb` ← **模型注入的标签被执行** | `a{bold}b` |
| `{bold}x + escape(JSON) + y{/bold}` | — | `<ESC>[1mx{"a":1}y<ESC>[22m` 与自有样式正确共存 |

即：`\{` **不是转义而是装饰**——它既没能阻止 seal 注入（`\{bold}` 里 `{bold}` 照样被解析），又在每个花括号前多打一个反斜杠。**这既是渲染 bug 也是安全 bug。**

而 blessed 原生的 `{open}`（`:460-466`，`param === 'open' → out += '{'`）是**逐字符**的，语义与当前 `escapeTags` 完全对应，且天然免疫上面的对抗输入。

### 3.4 三条渲染链对同一份 markup 的语义不一致

同一个 tagged line 会落到三个不同的解析器：

| 链 | 入口 | 谁在解析 | 生效场景 | 对 `{` 的处理 |
|---|---|---|---|---|
| blessed | `screen/blessed-surface.ts` → `blessed screen` | blessed `_parseTags` | 全屏**默认** | **不认任何转义** ⇐ 踩坑的那个 |
| own | `screen/own/markup.ts:133 renderMarkup` | duya 自己 | 全屏 opt-in（`DUYA_TUI_RENDERER=own`） | `escapeMarkup`（`:213`）直接 **删掉** `{}` |
| inline | `terminal/sgr.ts:98 tagsToAnsi` | duya 自己 | inline 模式（`InlineSurface`） | `:112-117` 认 `\{` 并吃掉反斜杠 |

`TUIApp.ts:41,49` 默认走 `createScreenSurface` → blessed，所以**默认路径是踩坑的那条**。

> ⚠️ 这是本计划最容易被低估的地方：**新增任何 tag（斜体、删除线、标题分级）都要在这三处同时落地**，少一处就是「全屏下好好的、inline 下变成可见文本」。

### 3.5 blessed 的能力边界（逐条实测）

| 标记 / 写法 | 实测结果 | 结论 |
|---|---|---|
| `{bold}` `{underline}` `{blink}` `{inverse}` | `<ESC>[1m … <ESC>[22m` 等 | **可用** |
| `{italic}` `{strike}` `{dim}` | 原样作为**可见文本**落盘 | **不可用** |
| 原生 `\x1b[3m` 塞进 content | 后续 cell 被吞（整行只写出首字符） | **不可用** |
| 嵌套 `{gray-fg}a{bold}b{/bold}c{/gray-fg}` | `<ESC>[90ma<ESC>[1mb<ESC>[22mc<ESC>[39m` | **嵌套可行**，内层 close 正确恢复外层 |
| `{escape}…{/escape}` | 可行，但是**成对区间式**，模型文本含 `{/escape}` 会提前终止 | 备选，不采纳 |
| `{open}` / `{close}` | **逐字符**，无配对问题 | **采纳** |
| OSC 8 `\x1b]8;;url\x1b\\` | walker 不认 ⇒ `\x1b` 变可见 cell，整行错位 | 不可用（O1） |

⇒ `transcript-view.ts:107` 注释里那条 "no nesting" 是**自加约定、不是 blessed 限制**。放开它是「bold 里套 italic」的前提。

---

## 4. 设计决策

**D1 — 自建手写 scanner，不引 `marked`。**
真正的成本在 renderer（把 token 压回 blessed 标签 + 保行数不变式 + 三链同步），不在 parser；引入 `marked` 一行 renderer 代码都不会少，只是多适配一个快速迭代的 AST API，还会在 `bundle-verify` / `client-closure-gate` 的输入集里多一个依赖（`scripts/architecture/*.mjs`）。pi 选它是因为 pi 自己吐 ANSI、自己做组件化 `render(width)`，duya 的输出契约完全不同。
*备选*：`marked@18` —— **裁定：否**。

**D2 — 转义统一为 `{open}`，作为独立 Phase 先提交。**
理由见 §3.3：这不只是渲染修复，**还是模型文本注入的修复**。三条链同步：`transcript-view.escapeTags`、`own/markup.ts` 新增 `{open}`/`{close}` 分支（并让 `escapeMarkup` 改为产出 `{open}` 而不是删字符，避免信息丢失）、`terminal/sgr.ts:112-117` 把 `\{` 判定换成 `{open}`。
**顺序不变式**：任何宽度计算（`visibleWidth` / `truncateToWidth` / `wrapWithCursor`）必须在 escape **之前**完成——`{open}` 是 5 个字符，`width.ts` 不解析 tag（文件头明确写了），escape 后再量宽会把列宽算爆。这个坑的形状和 §3.2 的 Bug B 是同一个。

**D3 — own 渲染器转默认，但先过 Phase 0 的 Go/No-Go。**
动机：斜体在 blessed 链上没有路（§3.5）。`OwnScreenSurface`（`screen/own/surface.ts`）已实现 `ScreenSurface` 全部 10 个成员，且 `screen-surface.test.ts:94` 已把生命周期/几何用例对两条链同参数化跑——**结构上它是合格的替换**。
Go/No-Go：**同一帧语料下两条链的 glyph grid 逐格一致**（见 V2）。
兜底：不过 ⇒ 降级 D3′，`em` 在 blessed 上渲染 `{underline}`，own 上渲真斜体，两链视觉不等价（是已知妥协，要写进 `/settings` 的 help 文本）。

**D4 — 表格两 bug 分别修，不许合并刷题。**
Bug A 改 `:319` 的 `w + 2` → `w + 1`；Bug B 改成「先 render cell → 剥标签 → `visibleWidth` → 取列宽 → 按 rendered 宽度 pad」。两者症状不同、反例不同，必须各有一条回归测试。

**D5 — 块级形态：降级加样式，不加行数。**
- 标题：#:1-2 → `heading` + `bold`；#:3-6 → `heading` 单色；`#` 标记本身不再参与输出。
- 列表：`-`/`*`/`+` 统一转 `•`（`:432` 现在是 `styles.accent(listItem[2])`，直接把原 marker 涂色打印）；有序列表保留数字；两级以上缩进保留。
- 分隔线：`:455` 现在死写 8 个 `─`，改为按 `innerWidth` 渲染。**需要 `RenderOptions` 新增 `width`**（现在 `:76-99` 没有这项），并由 `TUIApp` 从 `measure('transcript').innerWidth` 注入。

**D6 — thinking 与 assistant 共用 tokenizer，但样式层不同。**
thinking 底色是 `styles.thinking`；其中出现的 `**加粗**` 要在 thinking 底色之上叠 `bold`（§3.5 证明嵌套可行）。这是「no nesting」约定放开后的第一个真实用例，要单独有测试。

**D7 — 链接走「形态识别 + 保守呈现」。**
OSC 8 不可用（O1）⇒ 呈现为 `label` + 淡化色 `(url)`，但：① URL 做显示裁剪（去 `https://`、超长截断到 40 列 + `…`）；② 裸 URL 与 `path:line` / `path#anchor` 识别后套 `link` token（当前完全不识别）；③ **不改文本行数**。

**D8 — 图片给语义不给虚构。**
`![alt](/img.png)` 当前渲染成 `!alt (/img.png)`（`[alt]` 被当链接、`!` 残留）。改为渲染 `alt` + `[image]` 角标 + 路径。不假装显示了图片。

**D9 — 新 token 必须同时进三条链的解析表。**
`theme.ts:30-41 ThemeToken`、`:52/:73` 两套 palette、`own/markup.ts:60-62 ATTRIBUTES` 与 `:64-71 Style` 接口、`terminal/sgr.ts:60-91 parseTag`、`transcript-view.ts:107-121 Styles` 接口 —— 五处清单写进 Phase 6 的 checklist，任一处漏了就是 §3.4 描述的症状。

**D10 — 保留 block 行数不变式，这是硬约束不是偏好。**
`transcript-view.ts:57-61`：只有 markers 可以改文本，block 行数永不改，因为 `renderTranscript` 靠逐块高度求和定位 selection caret。⇒ 表格不 wrap（O4）、tokenizer 不得引入换行。

---

## 5. 契约

### 5.1 转义

```ts
/** 逐字符转义：与 blessed 原生 `{open}` 对齐，且天然免疫 `{/escape}` 之类对抗输入。 */
function escapeTags(text: string): string {
  return text.replace(/\{/g, '{open}');
}
```

三条链必须都接受 `{open}` / `{close}` 并产出字面 `{` / `}`。

### 5.2 inline tokenizer grammar（新建 `tui/markdown/inline.ts`）

```
Inline   := (Escaped | CodeSpan | Strong | Strike | Emphasis | Link | Image | Text)*
Escaped  := '\' <任意标点字符>
CodeSpan := '`'+ 内容 '`'+            # 同长度 fences；优先级最高，内部不再解析
Strong   := ('**' | '__') Inner ('**' | '__')
Strike   := '~~' Inner '~~'
Emphasis := ('*' | '_') Inner ('*' | '_')      # 单字符时不跨空格边界
Link     := '[' 文本 ']' '(' 目标 ')'
Image    := '![' alt ']' '(' 目标 ')'
Text     := <其余，直到下一个候选起手例外>
```

- 输出是一棵**扁平带嵌套的 token 列表**，不是字符串拼接；
- `renderInlineTokens(tokens, styles)` 负责压回 tag 串，并保证标签成对；
- 反斜杠转义在 tokenizer 层消费（现在 `:164/:181` 是先正则后 escape，看不到 `\`）。

### 5.3 Styles / ThemeToken 增量

| 新增 | ThemeToken | dark palette | light palette | blessed 链 |
|---|---|---|---|---|
| `italic(s)` | `italic` | `3`（由 own/inline 发 SGR，不是 tag） | 同 | **降级 `{underline}`** |
| `strike(s)` | `strike` | `9` | 同 | **降级 `{underline}`** |
| `code(s)` | `code` | `243-fg` | `31-fg` | 可用（已是 fg tag） |
| `heading(s, level)` | `heading`（复用）+ `bold` | — | — | 可用 |

> `italic` / `strike` 是 SGR 属性不是颜色 ⇒ 它们在 blessed 链上**无法表达**（§3.5），只能降级；own 与 inline 两条链发真 SGR 3 / 9。降级行为要有测试钉住，不许静默变成 invisible。

### 5.4 缓存契约

`transcript-cache.ts` 按 `content + renderOptionsKey` 做 per-block memoize。新增的 `width` 要进 `renderOptionsKey`，否则 resize 后复用旧帧会导致分隔线长度不变。

---

## 6. Phases

- [x] **Phase 0 — 取证 + Go/No-Go**（不做产品改动）——**结论：Go**（6 帧语料 own↔blessed glyph grid 逐格一致）
  - [x] 0.1 补写 differential harness：把 §3.5 的 blessed 结论与 §3.3 的注入结论落成测试证据（`own-markup.test.ts` 的 "against blessed ground truth" 已有先例）。
  - [x] 0.2 写 `tui/__tests__/render-parity.harness.ts`：最小 cursor framebuffer（处理 `\x1b[r;cH` / `\x1b[<n>d` / `\r` / `\n` / SGR / 可打印字符），把两条链的字节回放成 glyph grid。
    - 实测补充：harness 第一轮假红是 blessed 的 **DEC ACS** charset shift（`\x1b(0` + `q` 画 `─`、`~` 画 `·`），own 直接写 Unicode —— 视觉相同字节不同，回放器必须解码 ACS。
  - [x] 0.3 帧语料：空帧 / 单色文本 / 带头尾 status+input / CJK / 宽emoji / border / overlay 居中。
  - [x] **Go/No-Go**：grid 逐格一致 ⇒ 继续 D3；不一致 ⇒ 降级 D3′，**本计划 I9 撤销**，斜体降级为下划线。
  - 门禁：`node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/render-parity.test.ts`

- [x] **Phase 1 — 转义统一（I1，独立可提交）**
  - [x] 1.1 `escapeTags` → `{open}`（§5.1）
  - [x] 1.2 `own/markup.ts` 支持 `{open}` / `{close}`；`escapeMarkup` 改为输出 `{open}` 而非删除字符
  - [x] 1.3 `terminal/sgr.ts:112-117` 的 `\{` 判定改为 `{open}`
  - [x] 1.4 更新受影响断言：`tui-transcript-markup.test.ts:68,78,117,155,264-270`、`tui-app-integration.test.ts:392-393`、`tui-question-overlay.test.ts:226-227`、`tui-transcript-table.test.ts:21`
  - [x] 1.5 新增注入回归：`{bold}` / `{/gray-fg}` / `{/escape}` / `{{}}` 四种源文本必须原样可见
  - 执行记录：①`{/open}` 语义对齐 —— blessed 的 open/close 判定在 slash 分支**之前**，`{/open}` 也产出 `{`（探针实测），own/sgr 两链均已按此对齐；②sgr 首版实现漏发 tag 前的普通文本（`line.slice(index, brace)`），把 `{cyan-fg}x{/cyan-fg}` 变成 `\x1b[36m\x1b[39m`，已修；③`{close}` → `}`、`{open}` → `{`（对称字面量，blessed 原生）。存量红不受影响：worker-path 3 条、registry 22v23、host-event-projection（他人 untracked）。
  - 门禁：`node node_modules/vitest/vitest.mjs run packages/cli/src/tui` + `packages/cli` 全量 + `cd packages/cli && tsc -b`

- [x] **Phase 2 — inline tokenizer（I2）**
  - [x] 2.1 `tui/markdown/inline.ts`：`tokenizeInline` + `renderInlineTokens`
  - [x] 2.2 放开 nesting：`Styles` 允许在底色之上叠属性；`:107` 的注释同步改写（否则下一个人会以为不能嵌套）
  - [x] 2.3 幂等/成对不变式测试：任意随机 token 组合，输出串里每个开 tag 必有闭合（`tui/__tests__/inline-tokens.test.ts`：2,000 次 fuzz 成对性 + 500 次行数不变式 + 注入回归；`escapeTags` 抽到 `markdown/escape.ts` 断开模块环）
  - 执行记录：①嵌套渲染不能直接调 styles 函数包「已渲染的子串」——styles 内部会 escape，`{open}` 会被二次转义成 `{open}open}`（屏上可见 "open}" 垃圾）；解法是哨兵探测（`probePair`）从 styles 提取裸 tag 对、tokenizer 自己发对，叶子文本只 escape 一次；Phase 5 thinking 叠属性复用同原语。②`escapeTags` 从 transcript-view 移到 `markdown/escape.ts`，transcript-view 原位 re-export 保持既有 import 兼容。
  - 门禁：`inline.test.ts` + 现有 `tui-transcript-markup.test.ts` 不得改断言（**行为兼容性是验收标准**）——存量断言零改动通过

- [ ] **Phase 3 — 块级形态（I4）**
  - [ ] 3.1 `RenderOptions` 新增 `width`；`TUIApp` 从 `measure('transcript').innerWidth` 注入；`renderOptionsKey` 纳入 `width`
  - [ ] 3.2 标题分级、列表 `•`、分隔线按宽
  - 门禁：`tui-transcript-markup.test.ts` + 新增 `tui-transcript-blocks.test.ts`

- [ ] **Phase 4 — 表格（I3）**
  - [ ] 4.1 Bug A：`:319` `w + 2` → `w + 1`
  - [ ] 4.2 Bug B：列宽改按 rendered 计算
  - [ ] 4.3 两条**各自**的回归测试（列号 must be identical across all rows，含带 `` `code` `` / `**bold**` 单元格的场景）
  - 门禁：`tui-transcript-table.test.ts`

- [ ] **Phase 5 — thinking（I5）**
  - [ ] 5.1 `thinkingRows` 改走 tokenizer，底色之上叠属性
  - [ ] 5.2 不变式回归：thinking 预览截断后的行数不变（`tui-transcript-thinking.test.ts` 不得改行数断言）
  - 门禁：`tui-transcript-thinking.test.ts` + `tui-app-integration.test.ts`

- [ ] **Phase 6 — own 转默认 + 斜体/删除线（I8, I9，取决于 Phase 0）**
  - [ ] 6.1 `selectScreenRenderer` 默认改为 `own`，保留 `DUYA_TUI_RENDERER=blessed` 作为回滚
  - [ ] 6.2 `ThemeToken` / 两套 palette / `own/markup.ts` 的 `ATTRIBUTES`+`Style` / `terminal/sgr.ts parseTag` / `Styles` 接口 —— 五处同改（D9）
  - [ ] 6.3 `screen-surface.test.ts:78-88` 的 renderer-selection 断言更新
  - [ ] 6.4 真机：`duya chat` 全屏 + inline 两种模式各截一次图，确认无可见 tag、无错位、italic 生效
  - 门禁：`env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all` + `packages/cli` 全量 + `parity` harness

---

## 7. Verification

| # | 断言 | 怎么验 | 存在理由 |
|---|---|---|---|
| V1 | escape 后 `{` 可见且**无**前导反斜杠 | Phase 1 单测 + blessed `_parseTags` 逐字节比对 | §3.3 |
| V2 | **两条渲染链同一帧语料 glyph grid 一致** | Phase 0 harness | **Go/No-Go，本计划的 Gate** |
| V3 | 模型文本 `{bold}` / `{/gray-fg}` 不执行为标签 | Phase 1 注入回归 | **安全修复，必验** |
| V4 | 表格四行 `│` 列号完全相同（含含代码/加粗单元格） | Phase 4 | §3.2 双 bug |
| V5 | inline tokenizer 输出 tag 成对、不成环 | Phase 2 随机组合 fuzz | 防止 blessed 状态泄漏污染整屏 |
| V6 | thinking 渲染后既得 Etsy List Markdown，且行数不变 | Phase 5 | D6 + D10 |
| V7 | 任意 Markdown 段落：渲染前后**行数一致** | Phase 2/3/5 共同断言 | D10 硬约束 |
| V8 | inline 模式与全屏模式 tag 集合一致 | Phase 6 真机 + 三链单测 | §3.4 三链陷阱 |
| V9 | resize 后分隔线长度随之变化（缓存 key 含 width） | Phase 3 | D5 + §5.4 |
| V10 | `duya chat` 真机截图：JSON/代码块/表格/斜体各一屏 | Phase 6 | 端到端 |

---

## 8. 依赖与序号

- 前序：**611**（主题 token 化 + GFM 表格），本计划在其产出上修。
- 与 **613**（CLI `/compact`）零重叠；613 的 Phase 0 未跑，不阻塞本计划。
- 本次**不新增任何 npm 依赖** ⇒ `bundle-verify` / `client-closure-gate` 的输入集不变（这是 D1 的一个附带收益）。
- 已知受影响的其他会话产物：`host-event-projection-coverage.test.ts`（untracked，未登记 `diagnostic` 事件，本来就红）——与本计划无关，别顺手改。

## 9. 风险

| # | 风险 | 处置 |
|---|---|---|
| R1 | Phase 0 parity 不过 ⇒ own 不能转默认 ⇒ 斜体无真实现 | D3′ 降级（underline），并记录清楚在哪几个 token 上不等价 |
| R2 | `{open}` 与 `escapeMarkup` 的现有调用方有隐式耦合（有些地方可能依赖「花括号被删」这个现状） | Phase 1 前先 `grep -rn escapeMarkup`（当前**只有定义、零调用点**，见 §3.4 实证） |
| R3 | 放宽 nesting 后出现 tag 失配，污染整屏 | V5 fuzz + `renderLine()` 出口加「标签栈必须为空」的开发期断言 |
| R4 | 三条链之一漏改新 token ⇒ 全屏好好的、inline 变可见文本 | V8 + D9 checklist |
| R5 | thinking 走 Markdown 后 `transcript-cache` 的 memoize key 需要变化和二期增长 | `renderOptionsKey` 已含 `showThinking`；新增维度必须同步 **`blocks()` 与 `lines()` 两处**（历史教训：只改一处会 cache index 错位） |
| R6 | Phase 6 换默认渲染器影响所有全屏真机路径 | 保留 env 回滚开关至少跨一个 release；`/settings` 与 `/hotkeys` 文本里写明回滚方法 |

## 10. 待裁定

1. **Phase 0 Go/No-Go 的成本上限**：own↔blessed parity harness 本身约 200 行测试代码。若 Go/No-Go 不通过，接受「斜体降级为下划线」这个视觉妥协吗？
2. **`escapeTags` 的语义改动要不要跨出本计划范围**：同一个 blessed 转义问题是否存在于 Desktop / `packages/agent/src/cli`（legacy shell）？本计划范围只有 `packages/cli/src/tui`，外部同类问题需不需要单独立项？
3. **图片角标文案**：phase D8 提议 `alt [image] path`。要不要干脆隐藏 markdown 源、只显示 `alt`？
