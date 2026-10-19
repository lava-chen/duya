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

**D7 — blessed 退役三步走。**
① 转默认：`factory.ts:18` 默认翻转为 `'own'`，env 反向为 `DUYA_TUI_RENDERER=blessed` 回滚开关（= 614 Phase 6 的 6.1/6.3，并入本计划 Phase 0，连带 italic/strike 五处同改 6.2）；② 冻结：blessed-surface 不再接收新特性，parity harness 持续跑；③ 删除：I8 全部迁完后删 `blessed-surface.ts`、`blessed-unicode.ts`、`TUIApp` 的 blessed import 与依赖声明。

**D8 — 性能验收写进架构（数值为待测目标）。**
P95 输入→绘制 < 30ms；流式 ≥ 30 FPS（trailing-edge 间隔 ≤ 33ms，`pacer.ts` 现有机制直接复用）；10,000 历史 Block 滚动无掉帧；非可视 Block 不参与 Markdown 重渲染（`transcript-cache` key 命中即可证）。Phase 0 先测基线，若基线已达标则对应优化项降级。

**D9 — 组件树不持久化、不可跨帧持有用户数据。**
组件是渲染函数的 retained 壳，状态仍在 TUIApp/model 层（`blocks.ts`、editor 的 undo 栈）。避免出现第二份真相——这是 536/534 系列教训在 TUI 的复用。

## 5. 契约

### 5.1 Span 与 Scene（Phase 1 落地，直接可抄）

```ts
// tui/core/span.ts
export interface StyledSpan {
  readonly text: string;          // 已定宽：宽度信息由 width.ts 在 token 阶段保证
  readonly fg?: number;           // 256 色索引；命名色在 ThemeToken→palette 时已解析
  readonly bg?: number;
  readonly attrs: ReadonlySet<'bold' | 'italic' | 'strike' | 'underline'>;
  readonly linkId?: string;       // OSC 8 预留（O3 只留字段）
}
export interface RenderScene {
  readonly rows: readonly (readonly StyledSpan[])[];
  readonly cursor?: { row: number; column: number };
  readonly caret?: { row: number; column: number };  // transcript 选区
}
```

### 5.2 组件接口（Phase 3 落地）

```ts
// tui/core/component.ts
export interface ComponentProps { /* 每组件自定义 */ }
export interface UIComponent<P = ComponentProps> {
  readonly id: string;            // stable id：缓存 key / hit-test / focus 路由共用
  props: P;
  measure(width: number): number; // 行数（D10 行数不变式的树版）
  paint(scene: SceneBuilder, viewport: Viewport): void;
  children?: readonly UIComponent[];
}
```

### 5.3 输入驱动（Phase 2 落地）

```ts
// tui/terminal/input-driver.ts（包 OwnKeyParser）
export interface TerminalInputDriver {
  start(input: NodeJS.ReadableStream, onEvent: (e: InputEvent) => void): void;
  stop(): void;
  capabilities(): { kitty: boolean; mouse: boolean; bracketedPaste: boolean };
}
export type InputEvent =
  | { kind: 'key'; key: NormalizedKey }        // name + ctrl/alt/shift + codepoint
  | { kind: 'mouse'; event: OwnMouseEvent; hit: { row: number; column: number } }
  | { kind: 'paste'; text: string };
```

### 5.4 缓存 key 对齐（Phase 4）

`transcript-cache.ts` 的 per-block key 追加组件 revision：`componentRev`（组件 update 改变高度时自增）。防止组件化后缓存命中旧高度。

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

- [ ] **Phase 0 — 基准基线 + own 转默认（吸收 614 Phase 6）**
  - [ ] 0.1 `tui/__tests__/perf/` 基准 harness：伪造 PTY 输入流 + 高分辨率时钟，测输入→首字节绘制、流式帧间隔分布、10k block `totalLines()+paint` 耗时；Windows ConPTY 为第一环境
  - [x] 0.2 614 Phase 6 全量执行：own 转默认（`factory.ts:18` 翻转 + `screen-surface.test.ts` 断言更新）+ italic/strike 五处同改（614 D9 清单）+ `renderOptionsKey`/`/settings` help 文本
    - **执行记录（2026-10-19，worktree `plan-615-tui`）**：`selectScreenRenderer` 默认翻转，`DUYA_TUI_RENDERER=blessed` 为回滚开关。italic/strike 落地形态与 614 D9 清单的偏差：blessed 0.1.81 的 `program._attr` **没有** italic 分支（`{italic}` 会按未知 tag 原样输出），所以不是「五处都加标签」，而是——`own/markup.ts`（ATTRIBUTES `italic:'3'`/`strike:'9'` + Style 三布尔 + effective/sgrParameters，属性序 bold→italic→strike→fg）、`terminal/sgr.ts`（on=3/9，off=配对复位 23/29）两链直发；`transcript-view.ts` 加 `RenderOptions.renderer` + `Styles.renderer/italic/strike`，**markdown 映射点按 renderer 分支**：own 发真标签，blessed（含 renderer 未注入的历史调用方）保持 614 的折叠字节不变（emphasis→accent、strike→muted、thinking 折叠），`inline.ts`/`thinkingRows` 落分支。`transcript-cache` key 加 renderer 槽位；`TUIApp.renderOptions()` 注入 `this.renderer`。help 文本未加（blessed 回滚路径 italic 显示为字面 tag 的问题记录在案，随 D7 冻结/删除一并消失）。门禁：tsc -b 绿 + 相关 10 个测试文件 131/131 绿；packages/cli 全量见下一条执行记录。
  - [ ] 0.3 基线数字写回本计划 §8（V8/V9/V10 的「现状→目标」两栏）
  - **翻转暴露的 parity 缺口（2026-10-19，Phase 0 剩余工作）**：own 转默认后 packages/cli 全量 20 红中，5 条是 OwnScreenSurface 的真实缺口（其余为已知存量红 worker-path×3 / registry×1 / chat-tui bundle 环境红×2，及 host-event-projection 未入 worktree 的差集）：
    1. `tui-foundation` 2/3 行输入：own 的 `measure('input')` 不做低行数 composer 钳制（返回 5/6，期望 ≤rows-1）；blessed 在 2 行时丢边框。
    2. `tui-app-integration` ×2：own 全屏帧缺 slash echo 文本（`/effort`）与 help 面板内容（`~/.duya/config.toml`）——echo/overlay 内容未进 own 的帧缓冲。
    3. `tui-completion-popup` re-filter：own 帧残留 stale `/doctor` 行——diff 重绘未覆盖应清除的行。
    已修：OwnKeyParser 对 space 发 `ch=undefined` 导致编辑器吞空格（own 转默认后必现，blessed 语义是 `ch=' '`）——两处分支补 `ch=' '`，级联修好 7 条断言。
  - 门禁：`env -u CODEBUDDY_SAFE_DELETE_BULK_STATE_DIR npm run typecheck:all` + `packages/cli` 全量 + parity harness + 基准脚本产出 JSON

- [ ] **Phase 1 — StyledSpan 核心（I1，D2）**
  - [ ] 1.1 `tui/core/span.ts`：Span/Scene 类型 + `tokensToSpans()`（吃 `InlineToken`，含 heading/list 组合逻辑自 `renderAssistantMarkdown` 迁入）
  - [ ] 1.2 `ansi.ts` 增加 Span→ANSI 序列化器（SGR 合并、OSC 8 字段序列化为 no-op）
  - [ ] 1.3 `renderInlineTokens` 改为 Span→标签串的兼容视图；blessed-surface 走兼容视图，OwnSurface 直吃 Span
  - [ ] 1.4 三链一致性测试：同一 token 树经 Span 与经标签两条路径，glyph grid 等价（复用 614 parity harness）
  - 门禁：`tui/__tests__/span.test.ts`（新增）+ `render-parity.test.ts` + `packages/cli` 全量

- [ ] **Phase 2 — Terminal Input Driver（I2）**
  - [ ] 2.1 `tui/terminal/input-driver.ts` 包 OwnKeyParser；TUIApp 的 blessed program 输入路径切换到 driver（blessed program 仅存能力探测）
  - [ ] 2.2 bracketed paste / paste-burst / IME 长按边界回归（现有 `tty.ts` 测试迁移）
  - [ ] 2.3 Kitty keyboard 能力探测（`CSI ? u`）+ 增强键序解析；环境不支持时静默回退
  - [ ] 2.4 鼠标 hit-testing：接 `SceneBuilder` 的 span 位置索引，wheel 路由到 viewport 滚动
  - 门禁：`own-key-parser` 既有测试 + 新增 `input-driver.test.ts`（注入字节流，无 TTY）

- [ ] **Phase 3 — Retained Component Tree 最小核（I3，D1/D9）**
  - [ ] 3.1 `tui/core/component.ts`：UIComponent/stable id/mount-update；无 diff、无异步
  - [ ] 3.2 VStack/HStack/Overlay 三种容器（`geometry.ts` 求解器树形化）
  - [ ] 3.3 首批组件上树：StatusBar（footer.ts）+ QuestionOverlay——选它们是因为行数不变式最硬、回归面最小
  - 门禁：`tui/core/component.test.ts` + `footer.ts`/`question-overlay.ts` 既有测试零改动通过

- [ ] **Phase 4 — 增量布局 + 虚拟化文档（I4，D4）**
  - [ ] 4.1 树形 dirty 传播：`measure()` 结果带 revision，高度未变的子树剪枝
  - [ ] 4.2 TranscriptPane 接 `TranscriptRenderer.heights()`：视口裁剪（全屏）+ scrollback commit 判定（inline）统一为一个 `visibleWindow()` 查询
  - [ ] 4.3 缓存 key 加 `componentRev`（§5.4）
  - [ ] 4.4 10k block 合成负载测试：totalLines + 可视区 paint 的复杂度断言（O(blocks visible)，非 O(blocks total)）
  - 门禁：`tui/__tests__/virtual-doc.test.ts` + `transcript-cache` 既有测试

- [ ] **Phase 5 — 帧调度统一（I5，D5/D6）**
  - [ ] 5.1 RenderScene 成为两个 Output 的唯一输入；RenderScheduler 调度不变
  - [ ] 5.2 `ScrollbackOutput`（InlineSurface 内核）与 `AltScreenOutput`（OwnScreenSurface 内核）改吃 Span 流；标签层只剩 blessed-surface 一条腿
  - [ ] 5.3 （Go/No-Go D6）字符区间 diff：仅当 Phase 0 基线显示行内重绘占比显著才实施
  - 门禁：`render-parity.test.ts`（两 Output 对拍）+ working-tail/inline-mode 既有测试

- [ ] **Phase 6 — 全量组件化 + TUIApp 瘦身（I6）**
  - [ ] 6.1 Transcript/ToolView/Composer（InputEditor 保留，外壳上树）逐个迁移，每迁一个删一段 TUIApp 手工拼装
  - [ ] 6.2 TUIApp 收敛为：action dispatcher + composition root + focus 管理；目标 < 1200 行（写死数字防漂移）
  - 门禁：TUI 全量测试零断言改动（交互语义冻结的证明）

- [ ] **Phase 7 — blessed 退役 + 终验（I8，D7③）**
  - [ ] 7.1 删 `blessed-surface.ts`、`blessed-unicode.ts`、TUIApp blessed import、package.json 依赖
  - [ ] 7.2 三环境基准复测（ConPTY / tmux / 真实 PTY），数字对照 Phase 0 基线写回 §8
  - [ ] 7.3 真机矩阵：`duya chat` 全屏 + inline × 中文 IME + 鼠标 + 10k block 会话
  - 门禁：`typecheck:all` + 全量测试 + 基准 JSON + 真机截图（替代 V10）

## 8. Verification

| # | 断言 | 验法 | 现状 | 目标 |
|---|---|---|---|---|
| V1 | 同一 token 树经 Span 与标签两条路径 glyph 等价 | Phase 1 parity 对拍 | 标签单路 | 双路等价 |
| V2 | blessed 不再出现在运行时输入/绘制路径 | Phase 2/5 后 grep import + parity | `TUIApp.ts:38` | 仅 blessed-surface |
| V3 | 键盘输入→绘制 P95 | Phase 0/7 基准 | 待测 | <30ms |
| V4 | 流式帧间隔 | 同上 | trailing-edge 机制在 | ≥30FPS 等效 |
| V5 | 10k block 滚动 paint 复杂度 | Phase 4 合成测试 | 缓存已有、裁剪无 | O(visible) |
| V6 | 非可视 Block 零 Markdown 重渲染 | transcript-cache stats（hits/misses 已有） | 部分 | 断言钉死 |
| V7 | 交互语义零变化 | Phase 6 全量测试零断言改动 | — | 零改动 |
| V8 | 双模式同一 RenderScene | Phase 5 对拍 | 两套内核 | 一套管线 |
| V9 | IME/中文/宽字符回归 | Phase 2 既有 width/编辑器测试迁移 + 真机 | 通过 | 通过 |
| V10 | 真机三环境截图对照 | Phase 7 | — | 无可见 tag、无错位、IME 正常 |

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
