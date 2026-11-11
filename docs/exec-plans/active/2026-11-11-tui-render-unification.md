# CLI TUI — 渲染管线统一（pi 式双面同组件树）

状态：计划已立，未开工。owner：待认领。建议工作树：延续
`.claude/worktrees/tui-fullscreen-framework` 或另开检出；分支与 base 在开工时定
（预期 base = #624/#625 集成后的 master）。

依赖：[TUI 全屏框架先进化](2026-11-11-tui-fullscreen-framework.md) 的 S1–S3 与
[CLI Pi 工作台](2026-11-10-cli-pi-workbench.md)（#624）先完成实机验收与集成；
本计划在其上做**渲染层的结构性收敛**，不改任何已验收的交互语义。

## 目标与依据

把 inline 与 fullscreen 两条绘制路径收敛到 pi-tui 的架构形态：**一个组件树，
两个可互换的渲染面**（`TuiMainScreen` 追加进终端 scrollback / `TuiAltScreen`
备用屏视口，运行时可切并交接渲染状态）。判定「先进」的标准是 pi 已证明的
三条：两种模式共享全部组件与缓存；切换不需要重启；每帧只做一次布局。

现状的重复（全部 path:line 在 master `96b98221a` + #624/#625 上核对）：

- fullscreen 走保留组件树（`renderTree(pane/sidebar, …)`，`TUIApp.paintTranscript`
  全屏分支）+ Surface 管理的区域几何（`screen/own/geometry.ts`）；
- inline 的 chrome（working tail / task view / queue preview / composer / popup /
  footer）由 `paintInline` 手工拼捕获数组（`TUIApp.ts` `paintInline`，"Composer,
  then popup, then footer — pi's order" 注释即 pi 形态的手工版）；
- 同一布局事实存在两份表达：`visibleTranscriptRows()`/`inputChromeRows()` 的
  行预算算术 vs 组件树 `measure()`。

## 切片（每片独立可验收、独立 PR）

- **P0 布局引擎换核**：为全屏引入显式布局组件（pi `layout.ts` 的
  basis/grow/shrink/min/max 语义，duya 已有 `HStack`/`VStack` 基础），把
  transcript/input/status/overlay/completion 五区域从 `geometry.ts` 常量迁移为
  树上布局；`visibleTranscriptRows()` 等行预算算术改为读树。验收：全屏视觉
  零变化（帧级对比测试）、inline 不动。
  **已开工（2026-11-11）**：`core/layout.ts` 纯分发器落地（basis/grow/shrink/
  min/max + 精确和不变量，`layout.test.ts` 8/8 含 54 项 total 扫描），未接线——
  P0 余下部分（五区域迁移）在 #624/#625 集成后继续。
  **Step 2（2026-11-11）**：`screen/own/layout-tree.ts` `regionBoxes` 落地——
  五区域作为一棵布局树（transcript flex / composer / popup / status 自底向上
  dock），以 `layoutRegion` patch 算术为 ground truth 的黄金对拍测试
  （`layout-tree.test.ts` 6/6，可行域 sweep + 邻接 + overlay 居中公式），仍零
  接线。对拍发现并钉住一处语义分歧：不可行域（dock 高于终端）下 patch 算术
  滑入负 top，树则自底向上压缩——保留哪个属 step 3 决策。**开单顺序澄清**：
  依赖条款约束的是 MERGE 顺序（P0 不得先于 #624/#625 合入 master），不是开工
  顺序；本切片在其独立分支/PR 上交付，可独立 review。
  **Step 3 待做**：Surface 消费 `regionBoxes`（换核）+ 帧级视觉对拍 + 不可行域
  行为裁定。
  **Step 3 首片已落地（2026-11-11，本分支）**：`TUIApp.paintInput`/`paintDockPanel`
  逐帧调用 `projectBoxes(composerHeight)` 计算整帧盒，input/transcript bottom 与
  completion bottom 改为**树的投影**（`bottom = rows − composer.top` 等），
  `composerBottom()` 退役删除；overlay 仍为 patch 驱动（浮动，不属于 dock 树）。
  可行域输出与旧算术逐字节一致（对拍 pin），不可行域从「负 top 滑出屏幕」改为
  「自底向上压缩」（已 pin 的裁定，review 可推翻）。验证：全套件 92 文件 /
  1202 passed / 0 失败、architecture exit 0、typecheck:all 0 错、bundle 4.77 MB、
  **两轮 PTY 实机冒烟在换核后的 bundle 上复跑**——功能级 7/7、内容级 6/7（唯一
  FAIL 为已定性的 `!`-only 无锚点前提，非回归）。
  **Step 3 余下**：overlay 是否入树、`visibleTranscriptRows()` 等行预算算术与树
  的最终归一、inline chrome 组件化（P1）。
- **P1 inline chrome 组件化**：working tail、task view、queue preview、composer、
  footer 各自成为 `UIComponent`，`paintInline` 退化为「按序收集组件行」；
  inline 与全屏从此渲染同一组件实例。验收：inline 全部既有测试不改断言通过，
  行级输出与迁移前逐字节一致（render-parity harness 扩展到 chrome）。
- **P2 双面渲染器接口**：抽 `TuiSurface`（append-to-scrollback / alt-screen 两
  实现），组件树挂到接口上；`/settings` 切换显示模式时原地换面并交接滚动状态
  （pi 0.84 的 render-state handoff），不再要求重启。验收：切换后视口位置与
  follow 语义保持，`terminal/surface.ts` 的「committed rows 不可反悔」与 ED3
  硬拒不变。
- **P3 收尾**：删除 `paintInline`/`paint()` 双路径残余分支；`ARCHITECTURE.md`
  更新；帧预算回归（流式 pacer 行为不回退）。

## 边界与风险

- inline 的不可反悔不变量是产品立场（plan 2026-10-24），统一的是**渲染管线**
  不是滚动语义——P2 换面时 inline 面依旧只追加不擦除。
- Windows/ConPTY 的末列换行与 DECSTBM 行为每片都要真机回归。
- 每片过门禁后独立集成；P1/P2 期间 #625 的搜索/滚动条/跳转逻辑不重写，只搬家。

## 验收与证据

- 每片：`npx vitest run packages/cli/src/tui/__tests__/` 与基线按签名比较、
  `npm run -w @duya/cli typecheck`、`npm run architecture:check`、
  `npm run typecheck:all`、`node scripts/build-cli-bundle.mjs`。
- 终端实机（两模式 × 明暗主题 × 流式期间）由用户验收；证据表随切片填写。

| SHA / dirty | 命令 | 结果 |
| --- | --- | --- |
| 计划建立：`783c0b70e` 工作树 | （无代码改动） | 本文档 + 索引登记 |

## Stacked base synchronization (2026-11-11)

- Synchronized this branch with PR #625 head `890477117a64e7eee356e3f04b26c01936d43299`,
  which includes the #624 CI test fix and the committed PTY smoke harness.
- The merge from the common base `617f6c5da` auto-resolved without conflicts; the #626
  layout-tree and `TUIApp.ts` changes remain intact.
- Prior validation on the pre-sync implementation: 92 TUI files / 1202 passed, CLI typecheck,
  architecture check, and bundle build passed. Re-run CI on the synchronized head before merge.
