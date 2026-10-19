# 615 — CLI TUI 统一引擎：声明式组件树 + 增量布局 + 虚拟化文档 + 双模式渲染

状态：**active**（2026-10-19 立项）
前序：611（TUI 基础切片）、614（Markdown 渲染补齐，Phase 0–5 已完成并提交，Phase 6 未做）

---

## 0. 修订说明（相对讨论稿的逐条差异）

| # | 讨论稿写法 | 代码实证 | 本版处理 |
|---|---|---|---|
| R1 | 「保留 Own Renderer，先复用行级 Diff」 | `terminal/diff.ts:1` 行级 viewport diff 已存在且带纪律注释（只重写视口内行） | 采纳；字符区间 Diff 列为 Phase 5 的**可选增量**，先基准后决定（D6） |
| R2 | 「退役 Blessed 对输入和绘制的控制」 | `TUIApp.ts:38` 直接 `import blessed`，且注释明确 blessed 只剩 `program`（输入/能力探测）这一个价值入口；`screen/factory.ts:18` 默认渲染器仍是 `'blessed'`，`DUYA_TUI_RENDERER=own` 是 opt-in | 采纳；退役顺序定为「先转默认（614 Phase 6 并入本计划 Phase 0）→ 冻结 → 删除」，见 D7 |
| R3 | 「Block Revision Cache + 高度索引 + 视口裁剪」 | `transcript-cache.ts:84` `TranscriptRenderer` 已有 per-block revision 缓存 + `heights()` + `totalLines()`（611/614 产物） | 不重建；Phase 4 只做「缓存 key 与组件树对齐 + 视口裁剪接线」，并在 Out 表声明 Height Index 已存在 |
| R4 | 「统一 StyledSpan/Cell，替代 Blessed 标签」 | `own/frame.ts:9` Cell 已是结构化格子（text/style/width/continuation）但 style 是**标签字符串**；614 刚把三链标签统一到 `{open}` 语义 | 采纳方向不变，但过渡策略改为「token→Span 直通，标签层降级为兼容外壳后退役」（D2），明确 614 的成果不浪费：tokenizer 产物就是 Span 的直接上游 |
| R5 | 「独立 Terminal Input Driver，支持 Kitty Keyboard」 | `terminal/own-key-parser.ts:37` 已解析 SGR 鼠标（`:223` parseSgrMouse）与常规 CSI u 片段，但 grep 全目录无 kitty keyboard protocol（`CSI > 1u` / `=27u`）启用/解析路径 | 采纳；Kitty 列为 Phase 2 内的**能力探测可选增强**，Windows Terminal 的支持度进风险表（R-3） |
| R6 | 性能验收（P95<30ms / 30FPS / 10k Block） | 仓库内无任何 TUI 性能基准文件 | 采纳为**待测目标**而非现状结论；Phase 0 建基准 harness 先测出基线，目标数值是否校准进 §10 待裁定 |
| R7 | 「不强制引入 React Reconciler / 不急于引入 Yoga」 | 现状无此依赖 | 直接落为 D1/D3 的裁定 |

---

## 1. 一句话目标

把 duya CLI 的 TUI 从「blessed 兜底 + Own 渲染器并行 + TUIApp 集中式组装」改造成**一套统一引擎**：声明式 retained 组件树 → 增量布局 → 虚拟化文档 → 单一 StyledSpan 渲染管线 → 双模式终端输出（原生 Scrollback + Alt-Screen），blessed 退役，`TUIApp.ts`（3270 行）瘦身为 composition root + action dispatcher。

## 2. Scope

### In

| # | 内容 | 依赖的既有资产 |
|---|---|---|
| I1 | StyledSpan/Cell 结构化核心（颜色/属性/宽度/链接 id），ANSI 只在最后一步序列化 | `markdown/inline.ts` token 树（614）、`own/frame.ts` Cell、`terminal/sgr.ts`、`terminal/ansi.ts` |
| I2 | Terminal Input Driver：OwnKeyParser 独立成驱动层（键序/鼠标/bracketed paste/IME 边界），Kitty keyboard 能力探测 | `own-key-parser.ts`、`tty.ts`、`paste-burst.ts` |
| I3 | Retained Component Tree 最小核：stable id、VStack/HStack/Overlay、focus/keymap 路由 | `keymap.ts`、`window.ts`、`overlay.ts`、`geometry.ts` |
| I4 | 增量布局 + 虚拟化文档：dirty 传播、Block Height Index 接线、视口裁剪 | `transcript-cache.ts` 的 `heights()/totalLines()`、`geometry.ts` |
| I5 | 帧调度统一：RenderScene（span 树的扁平化结果）+ dirty regions + 行级/字符级 diff + 双模式输出 | `render-scheduler.ts`、`pacer.ts`、`delta-buffer.ts`、`terminal/diff.ts`、`terminal/viewport.ts`、`InlineSurface`、`OwnScreenSurface` |
| I6 | 组件化迁移：StatusBar/Footer、Composer（InputEditor）、Transcript、ToolView、Overlay 逐个上树 | `footer.ts`、`editor.ts`、`run-session-view.ts`、`tool-render.ts`、`question-overlay.ts` |
| I7 | 性能基准 harness：输入→绘制延迟、流式帧率、10k block 滚动，Windows ConPTY / tmux / 真实 PTY 三环境 | `pacer.ts`（注入时钟的先例） |
| I8 | blessed 退役：`blessed-surface.ts`、`TUIApp` 的 blessed program 依赖、`blessed-unicode.ts` | — |

### Out（每条写理由）

| # | 不做 | 理由 |
|---|---|---|
| O1 | 引入 React / Ink 作为运行时 | 组件树很小（<20 种组件），Reconciler 的调度复杂度买不回价值；且 Ink 的 stdout 全量重绘与我们的 scrollback-commit 模型冲突 |
| O2 | 引入 Yoga / 完整 flexbox | 现有 `geometry.ts:178` 行 + `composer-layout.ts` 覆盖了 5 个固定区域；树布局需要的只是 VStack/HStack/Overlay 三种约束求解，自研 ~300 行内可控 |
| O3 | OSC 8 超链接、图片组件 | Span 核心为其**预留字段**（linkId），实现等 Phase 1 落地后另立计划；一次计划塞两个渲染革命必然烂尾 |
| O4 | 桌面端（Electron）UI 改动 | 本计划只动 `packages/cli/src/tui/**`；桌面渲染链不相交 |
| O5 | Markdown 语法扩展 | 614 已定 grammar；615 只改渲染管线的**表示层**，不改语法 |
| O6 | 移动端/SSH 延迟优化、六重渲染模式 | 超出 CLI TUI 边界 |

## 3. 现状实证（file:line，写计划当日核对）

- **双渲染器并存，默认还是 blessed**：`screen/factory.ts:16-18` `selectScreenRenderer` 返回 `process.env['DUYA_TUI_RENDERER'] === 'own' ? 'own' : 'blessed'`。
- **blessed 在 TUIApp 的残余**：`TUIApp.ts:34-39`——VALUE import 只为 `blessed.program`（输入字节流 + 终端能力探测）；`:28` 注释记录 blessed 不做 bracketed paste（`?2004`），由 TUIApp 自启。
- **OwnScreenSurface 已实现全 10 个 ScreenSurface 成员**：`screen/own/surface.ts:26`；Cell 结构在 `own/frame.ts:9-14`（`{text, style, width, continuation}`，style 为标签字符串）。
- **行级 viewport diff 已存在**：`terminal/diff.ts:1-30`——「只重写视口内行、永不碰 scrollback」是成文纪律；行 wrap 禁用（DECAWM）原因同文件。
- **Scrollback commit 机制已存在**：`terminal/viewport.ts:1-20`——DECSTBM `1..screenRows-chromeRows`，区域顶为 row 1，滚动即把完成行推进原生 scrollback；`InlineSurface`（`terminal/surface.ts:129`）持有该模型，测试钉住「commits the conversation into the terminal scrollback」。
- **块级缓存三件套已存在**：`transcript-cache.ts:84` `TranscriptRenderer.blocks()/heights()/totalLines()`，per-block key 含 kind/plan/expanded/toolResultLines/**width**（614 Phase 3 加入）/theme/content-hash。
- **调度器与节流已存在**：`render-scheduler.ts:59` `RenderScheduler`（trailing-edge，键盘走 `requestImmediate()`，时钟注入可测）；`pacer.ts`、`delta-buffer.ts` 同族。
- **输入解析已半独立**：`terminal/own-key-parser.ts:37`（478 行）——SGR 鼠标 `:223/:294`、OwnMouseEvent `:12-22`；无 Kitty keyboard protocol。
- **集中式组装的规模**：`TUIApp.ts` 3270 行（tui/ 目录 12,490 行的 26%），混合了 renderOptions、面板 dock、overlay 调度、completion、focus、blessed program 管理。
- **五区域固定布局**：`screen/types.ts:38` `SurfaceRegion = 'transcript'|'input'|'status'|'overlay'|'completion'`；`own/geometry.ts` `screenRegions()` 按此求解。
- **Markdown token 树就绪**：`markdown/inline.ts`（614 Phase 2）`tokenizeInline → InlineToken`，`renderInlineTokens` 经 `rawTagPair` 发标签——这是 Span 直通改造的唯一切换点。

## 4. 设计决策

**D1 — 组件模型：手写 retained tree，不引 React。**
组件 = `{ id, mount(ctx), update(props), measure(width)→height, paint(scene) }` 的纯 TS 接口，树由 composition root 持有。理由：组件种类少且形态固定（§3），React 的 value diff/reconciler 调度对本问题没有增量价值，却带来异步渲染边界——与「输入→绘制 P95」目标直接对立。备选 Ink：否（O1）。

**D2 — 内部表示：StyledSpan/Cell 结构化，标签字符串降级为过渡外壳。**
Span = `{ text, fg?, bg?, attrs (bold/italic/strike/underline), width, linkId? }`；`Cell = { span index, column offset }` 或直接扁平 Span 流。序列化唯一入口 `terminal/ansi.ts`。
过渡策略（这是 614 成果不被浪费的关键）：`markdown/inline.ts` 的 `InlineToken` 是 Span 的天然上游——Phase 1 加 `tokensToSpans()`，`renderInlineTokens` 保留为「Span → 标签串」的兼容视图，供 blessed-surface 与既有测试继续消费；三条链收敛后标签层退役。
**裁定否决的备选**：直接跳过 Span 让 Own renderer 吃 Markdown AST——粒度太粗，无法做字符级 diff 和 hit-testing。

**D3 — 布局：自研约束布局（VStack/HStack/Overlay + flex grow/shrink），不引 Yoga。**
`geometry.ts` 的 `layoutRegion` 是现有求解器，扩展为树形递归即可；`composer-layout.ts` 的输入框多行约束是第一个非平凡客户。Yoga 否（O2）。

**D4 — 不可变历史与活动区分离（沿用而非新造）。**
现状已经如此：InlineSurface 的 DECSTBM commit（`viewport.ts`）+ TranscriptRenderer 的 per-block revision 缓存。本决策是把这条纪律**提升为引擎不变式**：组件树中历史 Block 节点 `frozen=true`，不参与 paint 除非视口裁剪把它们拉回来（全屏模式）。Main Screen 下历史不可交互（折叠/搜索留给 Fullscreen）——与 Claude Code 的职责划分一致。

**D5 — 双模式输出统一为一个 RenderScene 消费者接口。**
`RenderScene = { lines: Span[][], cursor?, dirty?: regions }`。两个实现：
- `ScrollbackOutput`（现 InlineSurface）：已完成行 commit 进 scrollback，live 区行级 diff（现成，`diff.ts`）；
- `AltScreenOutput`（现 OwnScreenSurface）：全帧 cell buffer + 行 diff，虚拟滚动。
帧调度统一走 RenderScheduler（trailing-edge + requestImmediate 语义保留）。

**D6 — 字符区间 Diff 是可选增强，先测再定。**
行级 diff 已消除大部分重绘；字符区间 diff 的收益要在 Phase 0 基准里量化（长行重绘占比）才有资格排期。**Go/No-Go**：若 P95 达标（<30ms）则降级为 backlog。

> **裁定（2026-10-19，Phase 5）：No-Go —— 降级为 backlog。**
> 原触发表述是「P95 达标则降级」，但基线 P95 = 32.0ms，**没达标**，所以这条规则没有触发；裁定因此改为依据实测，而不是依据那个数字。
> 实测（24 行 × 80 列的一帧，流式中）：一帧只重写 **2 行**，这 2 行里只有 **11/160 个字节**不同（行内变更占比 **6.9%**）—— 单看这个数，字符区间 diff 能把写出的字节从 206 降到 ~60。
> 但 `renderViewportFrame` 本身耗时 **0.0067ms/帧**，而整帧（输入→最后一个字节）是 **30.8ms**。也就是说写入路径占不到帧成本的 **0.03%**，省下的 ~140 字节是噪声；那 30ms 花在组帧（tokens → spans → cells）上。
> 结论：字符区间 diff 优化的是最便宜的那一步，却要处理宽字符、跨 span 的 SGR、以及「行尾擦除」这条现在保证不留残影的契约。**不做**。重新评估的条件写实：只有当实测显示写入路径成为帧成本主体（例如极慢终端、或组帧降到 1ms 以下），才值得回头看。

**D7 — blessed 退役三步走。**
① 转默认：`factory.ts:18` 默认翻转为 `'own'`，env 反向为 `DUYA_TUI_RENDERER=blessed` 回滚开关（= 614 Phase 6 的 6.1/6.3，并入本计划 Phase 0，连带 italic/strike 五处同改 6.2）；② 冻结：blessed-surface 不再接收新特性，parity harness 持续跑；③ 删除：I8 全部迁完后删 `blessed-surface.ts`、`blessed-unicode.ts`、`TUIApp` 的 blessed import 与依赖声明。

**D8 — 性能验收写进架构（数值为待测目标）。**
P95 输入→绘制 < 30ms；流式 ≥ 30 FPS（trailing-edge 间隔 ≤ 33ms，`pacer.ts` 现有机制直接复用）；10,000 历史 Block 滚动无掉帧；非可视 Block 不参与 Markdown 重渲染（`transcript-cache` key 命中即可证）。Phase 0 先测基线，若基线已达标则对应优化项降级。

**D9 — 组件树不持久化、不可跨帧持有用户数据。**
组件是渲染函数的 retained 壳，状态仍在 TUIApp/model 层（`blocks.ts`、editor 的 undo 栈）。避免出现第二份真相——这是 536/534 系列教训在 TUI 的复用。

## 5. 契约

### 5.1 Span 与 Scene（Phase 1 已落地）

**实际形态（与讨论稿的三处偏差已注明理由）**

```ts
// tui/core/color.ts —— 颜色词汇的唯一来源
export type SpanColor =
  | { readonly kind: 'named'; readonly name: string }    // SGR 30–37 / 90–97，终端自有的 16 色
  | { readonly kind: 'indexed'; readonly index: number }; // xterm-256 调色板项，38;5;n

// tui/core/span.ts
export type SpanAttribute = 'bold' | 'italic' | 'strike' | 'underline';
export interface SpanStyle {
  readonly fg?: SpanColor;
  readonly bg?: SpanColor;
  /** 规范序（bold→italic→strike→underline）、去重后的数组。用 attrs() 构造。 */
  readonly attrs?: readonly SpanAttribute[];
  readonly linkId?: string;   // OSC 8 预留，序列化时为 no-op
}
export interface StyledSpan extends SpanStyle { readonly text: string }
export interface RenderScene {
  readonly rows: readonly (readonly StyledSpan[])[];
  readonly cursor?: { readonly row: number; readonly column: number };
  readonly caret?: { readonly row: number; readonly column: number };
}
export function tokensToSpans(tokens, roles: InlineSpanRoles, inherited?: SpanStyle): readonly StyledSpan[]
export function mergeSpanStyles(outer, inner): SpanStyle   // 属性并集，颜色内层覆盖
export function spanText(spans): string
```

**偏差①：`fg?: number` → `SpanColor` 联合体。** 讨论稿的注释假定「命名色在 ThemeToken→palette 时已解析」，实际没有：`DARK_THEME_TAGS` 存的是 `gray-fg` 这样的**标签体**，而给定标签体再还原成数字会丢掉「命名」与「256 索引」的区别。二者不可互换：SGR 36（终端自有的 cyan，用户可重定义）不等于调色板第 6 项。压平会让 `{cyan-fg}` 与 `{6-fg}` 变成同一颜色，也会让 blessed 链无法从 Span 还原它要解析的标签。

**偏差②：`attrs: Set` → 规范序数组。** 序列化必须确定：同一 span 每次都得产出同样的字节，否则缓存 key 与 parity 断言失去意义。Set 的迭代序是插入序，而插入序恰恰是压平丢弃的那个事实。数组 + `attrs()` 归一化让 `[…attrs]` 本身成为字节序。

**偏差③：Scene 暂未产出。** `RenderScene` 类型已定，但 Phase 1 的消费者仍是「行字符串」（region API 吃 tagged lines）。真正开始产出 Scene 是 Phase 5（`RenderScene` 成为两个 Output 的唯一输入），届时 `cursor`/`caret` 才有明确的写入方。

**两个序列化器 + 一个信封**

```ts
// markdown/inline.ts —— 标签兼容视图（过渡层，Phase 5 只留 blessed 一条腿）
export function spansToTags(spans, view: SpanTagView, envelope?: SpanStyle): string
// terminal/ansi.ts —— 直发 SGR
export function spansToAnsi(spans: readonly StyledSpan[]): string
```

- **最小转换**：只发本条与上一条**不同**的标签，所以 `**a `b` c**` 是 `{bold}a {gray-fg}b{/gray-fg} c{/bold}`，而不是每段都关掉再重开 `{bold}`。长度随「样式变化次数」而不是「文本量」增长。
- **信封（envelope）**：块级样式作为外层框，Span 相对它发增量。这是 `# 结果` 能保持 `{cyan-fg}{bold}…{/bold}{/cyan-fg}`（颜色在外、粗体在内）而 `code` 又能替换自己那段的颜色的原因 —— 事后包字符串做不到，因为那样「谁在外层」就由字符串拼接顺序决定了。
- **渲染器差异只在视图里**：`tokensToSpans` 对强调一律产出 `italic` 属性，**与目标渲染器无关**；blessed 没有 italic 这件事在 `spansToTags` 里折叠成 accent 颜色。把折叠提前会让共享表示变成 blessed 的形状，第三个渲染器一来就崩（V8）。

**一致性保证**：`spansToAnsi(spans)` 与 `renderMarkup(spansToTags(spans, ownView))` 在同一 corpus（含 500 条随机输入）上**逐字节相等**，这是 `span.test.ts` 的核心断言 —— 两个独立实现互相印证，而不是自己证明自己。


### 5.2 组件接口（Phase 3 已落地）

**实际形态（讨论稿的 `SceneBuilder` 收敛成 `SceneCanvas`，理由见下）**

```ts
// tui/core/component.ts
export interface Viewport { readonly row: number; readonly column: number; readonly width: number; readonly height: number }
export interface UIComponent<P = unknown> {
  readonly id: string;        // stable id：缓存 key / hit-test / focus 路由共用
  props: P;                   // update() 原地替换
  revision: number;           // update() 自增 —— §5.4 的 componentRev 提前落地
  measure(width: number): number;              // 行数（D10 行数不变式的树版）
  paint(scene: SceneCanvas, viewport: Viewport): void;
  readonly children?: readonly UIComponent[];
}
export class SceneCanvas {
  writeTagged(row, column, line): void;    // 吃标签串（legacy 渲染器的输出）
  writeSpans(row, column, spans): void;
  fill(row, column, count, glyph, style?): void;
  textAt(row): string;                     // 断言与将来的 hit-test
  toScene(): RenderScene;                  // cells → spans（相邻同色合并）
}
export function renderTree(root, width, height): RenderScene
export function update(component, props): void   // 换 props + revision++，无 diff

// tui/core/containers.ts
export interface StackSlot { component: UIComponent; size: 'flex' | number; inset?: number; weight?: number }
export class VStack implements UIComponent<readonly StackSlot[]>
export class HStack implements UIComponent<readonly StackSlot[]>
export class Overlay implements UIComponent<OverlayProps>   // base + overlay 两层
export type OverlayAnchor = { kind: 'center' } | { kind: 'offset'; row; column } | { kind: 'bottom'; bottom: number }
```

**偏差①：`SceneBuilder` → `SceneCanvas`（cells 而非 span 直写）。** Span 是好的**存储**格式（连续样式段，序列化器直接吃），是坏的**编辑**格式：overlay 要覆盖一条已有 span 的中间，HStack 要在一条 span 中间起笔。所以画布存 cell，`toScene()` 时压回 span 并合并相邻同色段。

**偏差②：新增 `revision`。** §5.4 原本把它留给 Phase 4；`update()` 既然已经存在，让它自增是零成本，缓存 key 到时候直接读。

**新增必需品 `core/tags.ts::tagsToSpans`。** 所有 legacy 渲染器（`buildFooterLines`、`QuestionAskState.render`、整个 `transcript-view.ts`）产出的是标签串，上画布必须先变成 span。它与 `spansToTags` 互为逆视图，并有往返测试（`spansToTags(tagsToSpans(line)) === line`）—— 这是能「逐个渲染器迁移上树」而其余路径照旧工作的前提。

**发现：`statusRows` 与 status 区域的 height 是两个独立的数。** `geometry.ts` 用 `statusRows` 算别的区域的 `bottom`，而 status 自己的高度默认 `?? 1`；两者只在都为 1 时一致。若 `statusRows: 2`，`input` 与 `status` 之间会出现一行空隙。树的版本没有这个问题（status 的高度就是 `measure()`），Phase 5 接管区域 API 时这个参数应当消失。


### 5.3 输入驱动（Phase 2 已落地）

```ts
// tui/terminal/input-driver.ts
export interface TerminalInputDriver {
  start(input: NodeJS.ReadableStream, onEvent: (e: InputEvent) => void): void;
  stop(): void;
  capabilities(): { kitty: boolean; mouse: boolean; bracketedPaste: boolean };
}
export interface NormalizedKey {
  ch?: string; name?: string;
  ctrl: boolean; meta: boolean; shift: boolean;
  sequence: string; code?: string;
  full: string;              // blessed 的 key.full，绑定表唯一读取的字段
}
export type InputEvent =
  | { kind: 'key'; key: NormalizedKey }
  | { kind: 'paste'; text: string }
  | { kind: 'mouse'; event: InputMouseEvent };  // event.hit 预留给 Phase 3/4
```

派生自实际落地。三处要点：

- **`full` 是唯一绑定键**。`keyHandlers: Map<string, Handler[]>`，名字就是 `C-c` / `M-y` / `S-tab` / `return` / `f1`，与 `toBlessedKeys` 产出同一词汇 —— 所以用户按键覆盖不需要第二个翻译器。
- **一次按键只发一个事件**（不复制 blessed 的 Enter 别名，见 Phase 2 执行记录）。
- **`hit` 已进契约但无写入方**：单元格归属要等 SceneBuilder（Phase 3/4）才有答案，先把字段放好，加命中测试时只改驱动里构造事件的那一处。


### 5.4 缓存 key 对齐（Phase 4 已落地）

`transcript-cache.ts` 的 per-block key 追加一个 `componentRev` 槽位，值取自 `RenderOptions.componentRevisions?.get(block.id) ?? 0`。

为什么必须是「选项里的 map」而不是「组件自报」：`RenderOptions` 是渲染函数唯一的输入，而 block 目前还不是组件。放在选项里，Phase 6 把 block 变成组件时只需在调用处填这个 map，缓存层不用再改一次；也避免了给 `Block` 数据接口加字段。

槽位现在恒为 0（因为还没有组件），但**不是空的**：`virtual-doc.test.ts` 有测试证明改 revision 会 miss、改回来会命中 —— 否则这行代码只是装饰。

## 6. UI 规格

树形结构（composition root 装配，替代 TUIApp 的手工拼装）：

```
App (id: root)
├─ MainScreen | AltScreen        ← 双模式切换（DUYA_TUI_INLINE=0 / /settings）
│  ├─ TranscriptPane             ← 虚拟化文档：可见 Block 的组件实例 + frozen 历史
│  │  └─ BlockView*(assistant/user/tool/thinking/notice/error)
│  │     └─ MarkdownView → Span 流（I1 管线）
│  ├─ WorkingTail / RunTrail     ← 既有 run-session-view.ts 上树
│  └─ StatusBar                  ← footer.ts 两行 footer 上树
├─ Composer                      ← InputEditor + completion（槽位规则不变，见记忆「二级页不居中」）
└─ Overlay(focus=modal)          ← question-overlay / permission（alt-screen 居中豁免不变）
```

交互细节全部沿用既有约定：dock 顺序、二级页占输入框槽位、`duya:open-*-panel` 桌面通道不受影响；本计划不改任何交互语义，只改实现层。

## 7. Phases

- [x] **Phase 0 — 基准基线 + own 转默认（吸收 614 Phase 6）**
  - [x] 0.1 `tui/__tests__/perf/` 基准 harness：伪造 PTY 输入流 + 高分辨率时钟，测输入→首字节绘制、流式帧间隔分布、10k block `totalLines()+paint` 耗时；Windows ConPTY 为第一环境
    - **执行记录（2026-10-19）**：`perf/harness.ts`（`tapOutput` 帧探针 / `makeHarness` / `measureInputLatency` / `measureStreamFrames` / `buildDocument`）+ `perf/baseline.test.ts`（4 条）。刻意为**不变量测试而非阈值测试** —— 阈值会把慢机器变成假红，数字靠 `DUYA_PERF_BASELINE=1` 输出、写进 §8.1、跨 Phase 比较。
    - 实测踩到的三个坑，都已固化进 harness 注释：① `SYNC_BEGIN` 在 `paint()` 开头就写了，以它为准测的是「调度器决定画」不是「用户看到」，故 dispatch/painted 两栏分列；② 像素落在 `SYNC_END` **之后**（blessed 走 `nextTick`、own 走微任务），字节数必须跨到下一帧的 `SYNC_BEGIN`；③ 空会话帧只有 ~200 字节，延迟数测的是 `write()` 空转，故先 prefill 40 块 × 6 行再采样。
  - [x] 0.2 614 Phase 6 全量执行：own 转默认（`factory.ts:18` 翻转 + `screen-surface.test.ts` 断言更新）+ italic/strike 五处同改（614 D9 清单）+ `renderOptionsKey`/`/settings` help 文本
    - **执行记录（2026-10-19，worktree `plan-615-tui`）**：`selectScreenRenderer` 默认翻转，`DUYA_TUI_RENDERER=blessed` 为回滚开关。italic/strike 落地形态与 614 D9 清单的偏差：blessed 0.1.81 的 `program._attr` **没有** italic 分支（`{italic}` 会按未知 tag 原样输出），所以不是「五处都加标签」，而是——`own/markup.ts`（ATTRIBUTES `italic:'3'`/`strike:'9'` + Style 三布尔 + effective/sgrParameters，属性序 bold→italic→strike→fg）、`terminal/sgr.ts`（on=3/9，off=配对复位 23/29）两链直发；`transcript-view.ts` 加 `RenderOptions.renderer` + `Styles.renderer/italic/strike`，**markdown 映射点按 renderer 分支**：own 发真标签，blessed（含 renderer 未注入的历史调用方）保持 614 的折叠字节不变（emphasis→accent、strike→muted、thinking 折叠），`inline.ts`/`thinkingRows` 落分支。`transcript-cache` key 加 renderer 槽位；`TUIApp.renderOptions()` 注入 `this.renderer`。help 文本未加（blessed 回滚路径 italic 显示为字面 tag 的问题记录在案，随 D7 冻结/删除一并消失）。门禁：tsc -b 绿 + 相关 10 个测试文件 131/131 绿；packages/cli 全量见下一条执行记录。
  - [x] 0.3 基线数字写回本计划 §8（V8/V9/V10 的「现状→目标」两栏）
    - 已完成：V3/V4/V5 的「现状」栏填实数并新增 §8.1（含测法、三点读数说明）。V8/V9/V10 保持原样 —— 它们不是基线指标（V8 是 Phase 5 的对拍结果、V9 靠测试迁移、V10 靠真机截图），Phase 0 能给它们的只有 V9 的「现状=通过」，已在原先填好。
  - **翻转暴露的 parity 缺口（2026-10-19，Phase 0 剩余工作）**：own 转默认后 packages/cli 全量 20 红中，5 条是 OwnScreenSurface 的真实缺口（其余为已知存量红 worker-path×3 / registry×1 / chat-tui bundle 环境红×2，及 host-event-projection 未入 worktree 的差集）：
    1. `tui-foundation` 2/3 行输入：own 的 `measure('input')` 不做低行数 composer 钳制（返回 5/6，期望 ≤rows-1）；blessed 在 2 行时丢边框。
    2. `tui-app-integration` ×2：own 全屏帧缺 slash echo 文本（`/effort`）与 help 面板内容（`~/.duya/config.toml`）——echo/overlay 内容未进 own 的帧缓冲。
    3. `tui-completion-popup` re-filter：own 帧残留 stale `/doctor` 行——diff 重绘未覆盖应清除的行。
    已修：OwnKeyParser 对 space 发 `ch=undefined` 导致编辑器吞空格（own 转默认后必现，blessed 语义是 `ch=' '`）——两处分支补 `ch=' '`，级联修好 7 条断言。
  - 门禁：`env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all` + `packages/cli` 全量 + parity harness + 基准脚本产出 JSON

- [x] **Phase 1 — StyledSpan 核心（I1，D2）**
  - [x] 1.1 `tui/core/span.ts`：Span/Scene 类型 + `tokensToSpans()`（吃 `InlineToken`，含 heading/list 组合逻辑自 `renderAssistantMarkdown` 迁入）
    - **执行记录**：`core/color.ts`（颜色词汇唯一来源，替换 `terminal/sgr.ts` 与 `screen/own/markup.ts` 各自的表）+ `core/span.ts`（类型、`attrs()`/`mergeSpanStyles()`/`withSpanStyle()`/`spanText()`/`sameStyle()`、`tokensToSpans()`）。**heading 的组合逻辑迁为 envelope**（`renderInlineTokens(tokens, styles, envelope)`），不再手工拼 `rawTagPair` 对；list/quote/hr 的 marker 仍是单色 `styles.accent(...)` 直接产出，未改 —— 它们本来就没有嵌套，迁移只增加风险。
  - [x] 1.2 `ansi.ts` 增加 Span→ANSI 序列化器（SGR 合并、OSC 8 字段序列化为 no-op）
    - **执行记录**：`spansToAnsi()`，按「终端当前实际所处的样式」diff 发射而不是每 span 一套序列，属性序 bold→italic→strike→underline→fg→bg。`linkId` 明确为 no-op（OSC 8 不改变画出什么，且标签词汇里没有对应拼写）。bg 可表达但标签视图表达不了，已注明。
  - [x] 1.3 `renderInlineTokens` 改为 Span→标签串的兼容视图；blessed-surface 走兼容视图，OwnSurface 直吃 Span
    - **执行记录**：`renderInlineTokens = spansToTags(tokensToSpans(...))`，签名向后兼容（多出可选 envelope 参数）。`Styles` 增加 `tags: ThemeTags`，让「某个语义 token 是什么颜色」是查表而不是拿哨兵探函数。**OwnSurface 尚未直吃 Span** —— 它的 region API 仍以 tagged lines 为契约，这一步归 Phase 5（与 Scene 产出同步）；Phase 1 只保证 Span 已经是唯一的样式决策点。
  - [x] 1.4 三链一致性测试：同一 token 树经 Span 与经标签两条路径 glyph 等价（复用 614 parity harness）
    - **执行记录**：`__tests__/span.test.ts` 24 条 —— token→span 全类型映射、颜色词汇（命名/索引不互转、拼写往返、越界拒绝）、嵌套压平（内层色覆盖、属性并集）、文本保真（宽度预算依赖它）、标签最小转换与配平、`spansToAnsi` 与 `renderMarkup∘spansToTags` 在 corpus + 500 条确定性随机输入上**逐字节相等**。`render-parity.test.ts` 增加一帧 inline-Markdown corpus（每渲染器用自己该收到的标签拼写生成），断言 blessed 与 own 画出相同字形、且都不出现字面 tag。
  - 门禁：`tsc -b` 绿；`packages/cli` 1026/1034，8 红与 Phase 0 前完全一致（worker-path×3 / tui-pty×2 / registry×1 / host-stop-continue×2）。
  - **顺带修掉的真 bug**：`perf/baseline.test.ts` 的 `RENDER_OPTIONS.theme` 曾传 `stylesOf(...)`（token→**函数**）而不是 `ThemeTags`（token→**标签体**），于是 V5 的文档是在「标签体是字符串化的函数」这种畸形渲染下量的。测试文件被 `tsc -b` 排除，类型没挡住 —— 这条排除策略的代价，已写进该常量的注释。行数（2199 / 21999）修正后不变，故 §8.1 的 V5 结论仍成立，但耗时按修正后重测：13.1ms / 79.7ms。
  - **仍未做的**：`transcript-view.ts` 里 `rawTagPair` 还有 3 处（tool header、thinking 预览的 bold-on-muted）—— 它们是块级手工组合，等 Phase 5/6 组件化时一并消失。此处不迁，是因为 bold-on-muted 的**外层是 bold**、heading 的**外层是颜色**，两者用同一个规范序无法同时字节一致；信封机制能表达，但需要为每个组合点单独决定「谁是信封」，在没有消费者之前先做只是把复杂度提前。

- [x] **Phase 2 — Terminal Input Driver（I2）**
  - [x] 2.1 `tui/terminal/input-driver.ts` 包 OwnKeyParser；TUIApp 的 blessed program 输入路径切换到 driver（blessed program 仅存能力探测）
    - **执行记录**：`createInputDriver()`（包 `OwnKeyParser` + `OwnKeyInput`，保留已被测过的 raw-mode 进出）、`normalizeKey()`、`fullKeyName()`、`detectCapabilities()`。TUIApp 的 21 处 `target.key([...])` 全换成 `bindKey()`（own 写 `keyHandlers`，blessed 仍走 `program.key`），`target.on('keypress')`/`('mouse')` 换成 `onKeypress()`/`onMouse()`，新增 `dispatchInput()`。**own 路径下 blessed 的 Program 拿到的是一个没人写的 PassThrough** —— 两个解析器同时挂在同一个 stdin 上，每个键都会触发两次。blessed 渲染路径（回滚开关）原样保留自己的解析与 `.key()` 表：回滚要连输入路径一起回滚，否则「回滚」= 用我们的解析器配 blessed 的键盘表，这个组合没人验证过。
    - **刻意不复制 blessed 的 Enter 别名**：`program.js:397-399` 让 `return` 先以 `enter` 重发一次再落到 `return`，于是**一物理 Enter 派发两次**（`CONTENDED_BINDINGS`/`CONTENDED_ALIASES` 就是为它存在的）。driver 一次按键只发一个事件、名字为 `return`（正是 app 绑定的那个），重复派发从源头消失；`CONTENDED_ALIASES` 保持原样，因为 blessed 路径仍会看到重复。
  - [x] 2.2 bracketed paste / paste-burst / IME 长按边界回归（现有 `tty.ts` 测试迁移）
    - **执行记录**：`tty.ts` 其实是 TTY 检测，真正的输入回归散在 `own-key-parser` / `tui-paste-burst` / `tui-editor-width` / `tui-single-echo` / `tui-key-routing`。**三个 UI 套件（inline-mode / model-selector / settings-panel）原本用 `program.emit('key down')` 注入语义键**，own 派发器接管后全部失效；已改为写**真实字节**（新 `__tests__/key-injection.ts` 的 `press()`，含 `\x7f` backspace、SS3 F1–F4、CSI F5+ 等实测序列）。这是覆盖面的净提升：以前断言「我挂在某名字上的 handler 跑了」，现在断言「这次击键经真实解析后到达了用户会到达的 handler」，解析器或名字计算一变就会红。
  - [x] 2.3 Kitty keyboard 能力探测（`CSI ? u`）+ 增强键序解析；环境不支持时静默回退
    - **执行记录**：`OwnKeyParser.parseKitty()` 解析 `CSI key[:shifted[:base]] ; mods[:event] ; text u`（功能键映射到 `escape`/`return`/`tab`/`backspace`，ctrl 字母补控制字节，kitty 的 meta 位 32 视为 alt，release 事件与 57344+ 功能区间丢弃）。**解析无条件，启用要开关**：`DUYA_TUI_KITTY=1` 才写 `CSI >1 u`（push，退出时 `CSI <u` pop），条件是环境自报支持（`TERM=*-kitty` / `KITTY_WINDOW_ID` / `WEZTERM_PANE` / `TERM_PROGRAM=WezTerm|ghostty`）。理由：开这个协议会重写**每一个键**的编码，唯一能证明某终端实现正确的证据是「在那台机器上打字还正常」，所以默认关、留给真机矩阵（Phase 7）去开。
  - [x] 2.4 鼠标 hit-testing：接 `SceneBuilder` 的 span 位置索引，wheel 路由到 viewport 滚动
    - **执行记录（部分完成）**：鼠标事件已规范化进 `InputEvent`（`InputMouseEvent`，SGR 坐标零基），wheel 路由沿用既有实现（窗口管理器优先、否则滚 transcript）。**hit-testing 未做**：单元格→span 的归属要等 SceneBuilder 存在（Phase 3/4），没有索引可查时做命中测试只能是猜；`hit` 字段已进契约，届时只改驱动构造事件的一处。
  - 门禁：`tsc -b --force` 绿；`packages/cli` 1049/1057（新增 `input-driver.test.ts` 23 条 + `key-injection.ts`），8 红与 Phase 1 完全一致（worker-path×3 / tui-pty×2 / registry×1 / host-stop-continue×2）；`tui` 目录 815/815 全绿。

- [x] **Phase 3 — Retained Component Tree 最小核（I3，D1/D9）**
  - [x] 3.1 `tui/core/component.ts`：UIComponent/stable id/mount-update；无 diff、无异步
    - **执行记录**：`UIComponent`（id/props/revision/measure/paint/children）、`SceneCanvas`、`renderTree()`、`paintComponent()`、`update()`、`leaf()`。刻意没有 diff、没有 dirty 传播、没有异步 —— `revision` 只是让「这个子树已过期」可观测，剪枝留给 Phase 4。
  - [x] 3.2 VStack/HStack/Overlay 三种容器（`geometry.ts` 求解器树形化）
    - **执行记录**：`core/containers.ts`。VStack/HStack 按 `'flex' | number` 分配、`inset` 双侧收缩、`weight` 加权；**余数给第一个 flex 槽**（丢掉会留下最后一行不画，给最后一个槽会把误差挪到 transcript 所在的顶部）。Overlay 只有 base+overlay 两层（区域模型就是一个浮动层压在一个堆叠底座上，通用 z-index 是另一种不需要的设计），anchor 三种：center / offset / bottom。
    - **几何等价性是测出来的**：`component.test.ts` 用树重建区域布局，对 4 种终端尺寸 × 2 种 overlay 宽度逐一比对 `layoutRegion()` 给出的 5 个区域盒子（left/top/width/height 全等）。completion 的四列 gutter 与「浮在 input 上方」分别由 `width: vp => vp.width - 8` 和 `anchor: {kind:'bottom', bottom: 4}` 表达 —— 这正是原 switch 里 `left: 4 / top: rows - height - bottom` 的算术。
  - [x] 3.3 首批组件上树：StatusBar（footer.ts）+ QuestionOverlay——选它们是因为行数不变式最硬、回归面最小
    - **执行记录**：`components/status-bar.ts`（`measure() = 2`，paint 调 `buildFooterLines`）、`components/question-panel.ts`（`measure()` 与 `paint` 共用同一个 `render()` 结果，所以「量出来的行数」与「画出来的行数」不可能不一致 —— 这正是它取代 `height: 7` 硬编码的地方）。两个组件的断言是**逐字节的**：把画布行转回 ANSI，与 legacy 渲染器的 `renderMarkup(line)` 全等。
    - **注意「上树」的边界**：它们已经能按树渲染（`renderTree` 测过），但**生产路径仍是 TUIApp 手工拼装** —— 消费者迁移按计划在 Phase 6 逐组件进行。Phase 3 交付的是「树存在且与旧布局逐像素一致」，不是「TUIApp 已经用树」。
  - 门禁：`tsc -b --force` 绿；`tui` 856/856 全绿（`component.test.ts` 18 条）；`packages/cli` 1067/1075，8 红与 Phase 2 完全一致；**`footer.ts` / `question-overlay.ts` 的既有测试零改动通过**（这是本阶段最硬的约束）。

- [x] **Phase 4 — 增量布局 + 虚拟化文档（I4，D4）**
  - [x] 4.1 树形 dirty 传播：`measure()` 结果带 revision，高度未变的子树剪枝
    - **执行记录**：`core/measure.ts::MeasureCache`。签名 = 整棵子树的 `id@revision(width)` 串接，**不是**只看节点自己 —— VStack 自己的 revision 在子节点 update 时不会变，只按自己取 key 会让它永远报旧高度（有测试钉住这条：改子节点 → 容器必须 miss）。代价是每次 measure 走一遍树（节点数个位数），换来的是 10k block 的叶子只在真变化时才算。
  - [x] 4.2 TranscriptPane 接 `TranscriptRenderer.heights()`：视口裁剪（全屏）+ scrollback commit 判定（inline）统一为一个 `visibleWindow()` 查询
    - **执行记录**：`core/visible-window.ts`（`heights` + `viewportRows` + `scrollLines` → `lineStart/lineEnd/firstBlock/lastBlock/following`）+ `components/transcript-pane.ts`（`measure()` = 文档总高，`paint()` 只写窗口内的行，`window(width, rows)` 就是那个统一查询）。`following` 由 `offset === 0` 推出而不是单独一个布尔：两处状态一定会漂移，一处不会。零高 block 在定位时跳过，否则折叠处的空块会白拉一个 block 进来画。
    - **边界**：`paintTranscript` 与 `InlineSurface.render({viewEnd})` **尚未改读这个查询** —— 那需要把区域 API 换成 Scene（Phase 5）。此阶段交付的是查询本身与它在 pane 里的用法，两条旧路径的行为不变（全量测试为证）。
  - [x] 4.3 缓存 key 加 `componentRev`（§5.4）
    - **执行记录**：见 §5.4。槽位由 `RenderOptions.componentRevisions` 提供，Phase 6 填值。
  - [x] 4.4 10k block 合成负载测试：totalLines + 可视区 paint 的复杂度断言（O(blocks visible)，非 O(blocks total)）
    - **执行记录**：`__tests__/virtual-doc.test.ts` 16 条。10k block、24 行视口：warm 帧 `renderer.stats.misses` 增量为 **0**（零 Markdown 重渲染），`pane.stats.blocksPainted ≤ 25`、`linesPainted = 24` —— 即写入量由视口决定而非文档规模；重复绘制整帧全部命中。
    - **顺带纠正一个隐含假设**：一个 block 不等于一行（200 个单行 block 排出 399 行，渲染器会加分隔行）。所以「第 N 行属于哪个 block」必须问 `heights()`，凡是按 1 block = 1 line 写的推算都是错的 —— 测试里已改成从渲染器取真实行。
  - 门禁：`tsc -b --force` 绿；`tui` 872/872；`packages/cli` 1083/1091，8 红与前完全一致；`transcript-cache` 既有测试零改动通过（新 key 槽位恒为 0，命中计数不变）。

- [x] **Phase 5 — 帧调度统一（I5，D5/D6）**
  - [x] 5.1 RenderScene 成为两个 Output 的唯一输入；RenderScheduler 调度不变
    - **执行记录**：新增 `SceneLine = string | readonly StyledSpan[]`（`core/span.ts`），`RegionPatch.lines` 与 `InlineFrame.scroll/chrome` 的类型都变成 `readonly SceneLine[]`。**RenderScene 的一行就是 `StyledSpan[]`**，所以一个 scene 天然能喂给两个 Output —— 不需要第二个字段，也不需要每个消费者写一遍「优先 spans，退化 tags」的分支。`RenderScheduler` 一行未改（trailing-edge + `requestImmediate` 语义原样）。
  - [x] 5.2 `ScrollbackOutput`（InlineSurface 内核）与 `AltScreenOutput`（OwnScreenSurface 内核）改吃 Span 流；标签层只剩 blessed-surface 一条腿
    - **执行记录**：转换收敛到 `terminal/line.ts` 一处（`lineToSpans` / `lineToAnsi` / `lineToTags`）。own 全屏路径新增 `drawSpanLine`（同一套折行算法，去掉 SGR 解析；cell 的样式串来自 `spanStyleParameters`，与 `spansToAnsi` 同一函数 —— 这是两条路径逐格相等的原因）。**inline 路径现在只有一个序列化器**：`lineToAnsi` 一律走 tags→spans→`spansToAnsi`，`diff.ts` 不再自己转换，「比较的就是写出的字节」从注释变成结构保证。
    - **标签层现状**：只剩 blessed-surface 一处消费（`lineToTags`）。`terminal/sgr.ts` 因此没有生产调用方了 —— 它的测试是 tag 词汇的实测记录、`working-tail.test.ts` 还拿它当参照，所以留到 Phase 7 与 tag 词汇一起删（模块头已标注）。
    - **一处既有断言因此改了字节**：`surface.test.ts` 期望滚回区里是 `\x1b[90m…\x1b[39m`（paired reset），统一到 span 序列化器后是 `\x1b[m`（整段复位）。两者屏幕一致，契约（「进滚回区的是 ANSI，绝不是 tag」）不变，改的是实现细节的字节。
  - [x] 5.3 （Go/No-Go D6）字符区间 diff：仅当 Phase 0 基线显示行内重绘占比显著才实施
    - **裁定：No-Go（降级 backlog），依据实测而非阈值**。见 §4 D6 的裁定栏：行内变更占比 6.9%（看起来值得做），但 `renderViewportFrame` 只花 0.0067ms/帧、整帧 30.8ms —— 写入路径不到帧成本的 0.03%，省下的字节是噪声。
  - 门禁：`tsc -b --force` 绿；`tui` 876/876；`packages/cli` 1095/1103，8 红与 Phase 4 完全一致；`render-parity.test.ts` 新增对拍「同一批行，own 吃 spans、blessed 吃 tags，字形逐格相等」；`working-tail` / `inline-mode` 既有测试通过（`working-tail` 零改动：它直接调 `tagsToAnsi`）。

- [~] **Phase 6 — 全量组件化 + TUIApp 瘦身（I6）**
  - [~] 6.1 Transcript/ToolView/Composer（InputEditor 保留，外壳上树）逐个迁移，每迁一个删一段 TUIApp 手工拼装
    - [x] **Transcript**：`TranscriptPane` 接管组装缓存（`lines()` 按 `revision|optionsKey` 记忆，返回**同一个数组**）+ 窗口查询（`visibleLines()`），`TUIApp.paintTranscript` 从 37 行降到 24 行且不再有 `maxStart / clamp / slice` 那套算术 → `visibleWindow()` 终于进生产路径（Phase 4 明确延后的那一项）。`cachedTranscriptLines` 字段与 `renderOptionsKey` 本地副本一并删除，后者落到 `transcript-cache.ts`（它描述的是缓存键，本来就该在缓存旁边）。
    - [x] **Activity**：`components/activity.ts::ActivityTracker` 接管 `activityPhase/activityMessage/groupActivity/waitingForPermission/activeTools/activeAgents` 六个字段与 113 行 `updateActivity`；`TUIApp` 只剩 `updateActivity` 的 8 行委派 + `waitingForPermission` 的存取器。`turn_start` 的 effort 留在 app（那是 composer 边框的属性，不是活动行的）。`frameRecord/frameString` 移入 `blocks.ts` 供两处共用（原来两份实现，一份接受数组、一份不接受）。
    - [ ] **ToolView**（`tool-render.ts` 的预览已在块渲染器内，未上树）
    - [ ] **Composer**（`paintInput` / `paintDockPanel` / `colorComposerRules` 仍手工拼装，约 105 行）
  - [ ] 6.2 TUIApp 收敛为：action dispatcher + composition root + focus 管理；目标 < 1200 行（写死数字防漂移）
    - **偏差记录（不改目标值）**：本轮实测 **3441 → 3300 行（−141，−4.1%）**，距 1200 未达成。原因不是时间，是**剩余的 2100 行没有一个是"拼装"**——按职责分块实测：`bindKeys` 及键路由 397 行（输入分发）、`paint*` 系列 496 行（chrome 组合，含 status/footer/completion/overlay/prompt）、`scheduleRender` + `replaceTranscript` + 生命周期 380 行、选项解析与 completion 桥接 300 行。抽任何一块都需要给 `TUIApp` 的 ~35 个私有成员定义一个宿主接口，而把 35 个私有成员升成 public 换取行数是**净损失**（封装是这轮改造要保的东西之一）。
    - **结论**：1200 行是"职责边界"指标，不是"抽函数"指标。达成它要求先把输入分发（398 行）与 chrome 组合（496 行）拆成两个真正的子系统（各自持有状态），那是一次独立计划的量级；本轮把两块**已经存在的**组件接进生产路径，是为那次拆分清场。
  - 门禁：TUI 全量测试零断言改动（交互语义冻结的证明）— **已达成**：`tui` 876 → 885 全绿，0 处既有断言改动；`packages/cli` 1104 条里 1096 通过，8 红与 Phase 5 完全一致（worker-path×3 / tui-pty×2 / registry×1 / host-stop-continue×2）。

- [ ] **Phase 7 — blessed 退役 + 终验（I8，D7③）**
  - [ ] 7.1 删 `blessed-surface.ts`、`blessed-unicode.ts`、TUIApp blessed import、package.json 依赖
  - [ ] 7.2 三环境基准复测（ConPTY / tmux / 真实 PTY），数字对照 Phase 0 基线写回 §8
  - [ ] 7.3 真机矩阵：`duya chat` 全屏 + inline × 中文 IME + 鼠标 + 10k block 会话
  - 门禁：`typecheck:all` + 全量测试 + 基准 JSON + 真机截图（替代 V10）

## 8. Verification

| # | 断言 | 验法 | 现状 | 目标 |
|---|---|---|---|---|
| V1 | 同一 token 树经 Span 与标签两条路径 glyph 等价 | Phase 1 parity 对拍 | 双路**逐字节**等价（span.test.ts 24 条，含 500 条随机输入；render-parity 增一帧 inline corpus） | 双路等价 |
| V2 | blessed 不再出现在运行时输入/绘制路径 | Phase 2/5 后 grep import + parity | 输入路径已脱离 blessed（own 自有 `keyHandlers` + `dispatchInput`）；绘制仍经 blessed-surface 的回滚路径 | 仅 blessed-surface |
| V3 | 键盘输入→绘制 P95 | Phase 0/7 基准 | own 32.0ms / blessed 48.5ms（见 §8.1） | <30ms |
| V4 | 流式帧间隔 | 同上 | own p50 76.6ms / p95 79.4ms；blessed p50 77.2 / p95 83.9（同一 trailing-edge 机制） | ≥30FPS 等效 |
| V5 | 10k block 滚动 paint 复杂度 | Phase 4 合成测试 | `totalLines()` 线性（2000 块 91ms，10× 块数 8× 时间）；pane 一帧写 ≤ 视口行数、warm 帧 0 次 Markdown 重渲染（Phase 4） | O(visible) |
| V6 | 非可视 Block 零 Markdown 重渲染 | transcript-cache stats（hits/misses 已有） | 已断言：10k block warm 帧 miss 增量 0（Phase 4） | 断言钉死 |
| V7 | 交互语义零变化 | Phase 6 全量测试零断言改动 | — | 零改动 |
| V8 | 双模式同一 RenderScene | Phase 5 对拍 | 两套内核 | 一套管线 |
| V9 | IME/中文/宽字符回归 | Phase 2 既有 width/编辑器测试迁移 + 真机 | 通过 | 通过 |
| V10 | 真机三环境截图对照 | Phase 7 | — | 无可见 tag、无错位、IME 正常 |
| V11 | 区域布局树与 geometry switch 盒子一致 | Phase 3 矩阵（4 尺寸 × 2 overlay 宽 × 5 区域） | 已全等（Phase 3） | 全等 |

### 8.1 Phase 0 基准数字（2026-10-19，Windows ConPTY 宿主，worktree `plan-615-tui`）

测法：`DUYA_PERF_BASELINE=1 node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/perf/baseline.test.ts`。下表是**连跑三次的中位**；三次之间离散度 <2%（V3）与 <5%（V4），可作为 Phase 7 复测的对照。

| 指标 | own（新默认） | blessed（回滚路径） | 测的是什么 |
|---|---|---|---|
| V3 dispatch P50 / P95 | 0.22 / 0.47ms | 0.29 / 0.91ms | 输入事件 → `paint()` 开始写帧。证明 `requestImmediate` 绕过节流 |
| V3 painted P50 / P95 | **30.8 / 32.0ms** | **46.0 / 48.5ms** | 输入事件 → 本帧最后一个字节到达流。用户真实感知的那段时间 |
| V3 单帧字符数 P50 | 1843 | 2004 | 40 块 × 6 行 prefill 后的一次输入帧 |
| V4 帧间隔 P50 / P95 | 76.6 / 79.4ms | 77.2 / 83.9ms | 60 delta 流；两侧都在节流周期上，`withinInterval = 1.0` |
| V5 `totalLines()` 200 / 2000 块 | 11.4ms / 90.9ms | 同一实现（`transcript-cache` 无分支） | 冷缓存一次全量布局：2199 / 21999 行 |
| V5 热缓存二次测量 | 0 miss / 301 hit，0.8ms | 同上 | 文档不变时零 Markdown 重渲染（V6 的可测雏形） |

三点读数说明：

- **V3 的 30ms 是 paint 成本，不是策略成本。** dispatch 只有 0.2ms，说明节流被正确绕过；30ms 全花在组帧 + 写 ~1.8KB。own 比 blessed 快约 33%，这是本次切换的净收益，也是 `<30ms` 目标还没达成的原因 —— 差额要靠 Phase 3/4 的树形 measure 与视口裁剪，不是靠调调度器。
- **V4 两侧都是 76–79ms**，等于 `MIN_RENDER_INTERVAL_MS`（70ms）加定时器粒度。这不是达标 30FPS（33ms），而是**节流常量本身决定的**：要 30FPS 必须把常量降到 33ms 以下，那是一次独立的性能决策，Phase 0 不代做。
- **帧字节数必须跨 `SYNC_END` 统计。** 两个 renderer 都不在 `SYNC_BEGIN`…`SYNC_END` 之间写像素（blessed 缓冲到 `_buf` 等 `nextTick`，own 走微任务），所以按标记内区间统计会得到 0；harness 因此从一帧的 `SYNC_BEGIN` 统计到下一帧的 `SYNC_BEGIN`。


## 9. 依赖与风险

依赖：**614 Phase 6 并入本计划 Phase 0**（需用户确认，见待裁定①）；611 的 geometry/transcript-cache 为直接前置。

| # | 风险 | 缓解 |
|---|---|---|
| R-1 | Windows ConPTY 下输入→绘制延迟受 ConPTY 帧聚合影响，30ms 可能测不出差异 | 基准 harness 用 WriteFile 直写 PTY master 绕开 ConPTY 缓冲做对照组 |
| R-2 | 组件化过程中 TUIApp 双轨（旧手工拼装 + 新树）并存导致行为漂移 | 每 Phase 迁移完立即删除旧路径，禁止长期双轨；门禁 = 既有测试零改动 |
| R-3 | Kitty keyboard 在 Windows Terminal/ConPTY 支持不全 | 能力探测 + 静默回退（Phase 2.3），不作为任何功能的依赖 |
| R-4 | 标签层→Span 层过渡期两套表示并存，内存翻倍 | Span 是惰性序列化（paint 时才成串），标签视图只在 blessed-surface 存活期构造 |
| R-5 | 行数不变式（D10）在树布局下被 measure() 破坏 | measure 返回行数本身是不变式的树版表达；V5 测试钉死 |
| R-6 | 多会话并行改 TUIApp（3270 行热点文件） | 每 Phase 显式路径提交；Phase 6 拆分期间冻结非本计划 TUIApp 改动 |

## 10. 待裁定（≤3）

1. **614 Phase 6 的归宿**：并入本计划 Phase 0（本计划写法）还是先单独提交完再开 615？前者少一次格式化往返，后者保持 614 的独立验收。**建议并入**。
2. **性能目标数值**：P95<30ms / 30FPS / 10k block 是讨论稿拍的；Phase 0 基线出来后是否允许按基线校准（例如 P95<50ms），还是写死不放松？**建议允许校准，但只能放宽不能放弃测量本身**。
3. **blessed 删除的触发条件**：Phase 7 一并删除，还是保留一个发布周期作为 `DUYA_TUI_RENDERER=blessed` 回滚开关再删？**建议保留到 Phase 7 真机矩阵通过后于同一提交删除**。
