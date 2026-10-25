# Duya Desktop 性能爬坡

状态：active · 负责人：mavis（goal `tg_1cyt7y0er7mvkwyms8`）· 更新：2026-10-24
分支：`codex/perf-plan-round4`（本分支）/ 集成检出 `.claude/worktrees/perf-integration` · base：`3ddbbfaf`（master）

## 目标与边界

优化 Duya Desktop 的启动、交互、流式显示、会话切换、多窗口体验，让改善可量化、可复现、可防退化。

方法学参考 Anthropic 的性能冲刺（<https://claude.dev/blog/how-we-made-claude-ai-faster/>）：先测量再优化；一条线只钉一个 journey；每个 PR 只证明一个收益；收益不足就撤。

范围外：删功能、改视觉、改权限模型、让 Desktop 与 Web 分化。

## 路径所有权（已冻结）

| Agent | 独占路径 | 目标 |
| --- | --- | --- |
| A | `scripts/perf/**`、`e2e/perf/**` | 真实 Electron 基准、Profile 采集、CI 回归 |
| B | `packages/ui/src/components/chat/**`、`packages/ui/src/hooks/useStreaming*.ts` | 只更新增长中的消息块 |
| C | `packages/ui/src/stores/conversation-store.ts`、`stores/sidebar-sections-store.ts`、`components/layout/app-sidebar.tsx`、`components/layout/sidebar/**` | 订阅范围与无关区域渲染 |
| D | `apps/desktop/src/main/core/**`、`apps/desktop/src/main/index.ts`、`apps/desktop/src/preload/**`、`components/layout/panels/TerminalPanel.tsx`、`panels/registry.ts`、`panels/layout-model.ts` | 合成状态、帧耗时、WebGL 回退 |
| E | `packages/ui/src/App.tsx`、`packages/ui/src/index.ts`、`packages/ui/package.json`、`packages/ui/tsconfig.json`、`vite.config.ts`、`apps/web/vite.config.ts` | 懒加载、依赖闭包、首屏资源 |

例外：`e2e/perf/agents/agent-{a,b,c,d,e}/**` 按 Agent 切分，各自独占，互不冲突。给 B/C/D/E 放自己的测量脚本与 fixture 生成器——留在检出里不提交，等于这份改前/改后数据不可复现。Agent A 不进这个目录。

共享文件（根 `package.json`、`e2e/playwright.config.ts`、`packages/ui/src/styles/**`、其余 store 与 hooks）只由集成者改；agent 需要时把 diff 写进 PR 正文交集成者应用。

## 指标契约（各 Agent 通用）

名字、单位、采集方法固定；B/C/D/E 在 A 的 harness 落地前也按这套出基线，保证可横向比较。

| 指标 | 单位 | 采集方法 |
| --- | --- | --- |
| `startup.firstPaint_ms` | ms | Electron 进程起 → renderer 首次 contentful paint |
| `startup.typeable_ms` | ms | Electron 进程起 → 输入框可输入（enabled 且能接收按键） |
| `interact.p50_ms` / `interact.p95_ms` | ms | 击键 → 该帧绘制完成 |
| `frame.p95_ms` | ms | `requestAnimationFrame` 相邻帧间隔 p95 |
| `longtask.count` / `longtask.total_ms` | 个 / ms | PerformanceObserver `longtask` |
| `stream.block_ms_total` | ms | 一条回复流式期间主线程被占用的总时长 |
| `stream.worstFreeze_ms` | ms | 流式期间最长单个 Long Task |
| `commit.count` | 次 | React 提交次数；生产构建拿不到 React Profiler 时用 MutationObserver 变更批次做诚实替代，报告里标明用的是哪种 |
| `dom.nodes` | 个 | `document.getElementsByTagName('*').length` |
| `dom.mutations` | 次 | MutationObserver `childList` 变更次数 |
| `mem.peakMB` / `mem.growthMB` | MB | CDP `Runtime.getHeapUsage` 或 `Performance.getMetrics` |
| `cpu.renderer_pct` | % | CDP `Performance.getMetrics` 或 OS 进程占用 |
| `gpu.compositing` | — | `app.getGPUFeatureStatus()`（D 域） |

每次报告必须附环境：CPU 型号、内存、Node 版本、OS、构建类型（production）、会话 fixture 标识、采样次数。

## 固定 fixture（跨 Agent 可比）

所有 Agent 用同一套标识与规模，报告里写 fixture 标识。Agent A 负责生成，其余 Agent 可在自己的检出里生成等价 fixture。

| fixture | 内容 |
| --- | --- |
| `perf/session-100` | 100 条历史消息的会话 |
| `perf/session-1000` | 1,000 条历史消息的会话 |
| `perf/session-10000` | 10,000 条历史消息的会话 |
| `perf/stream-long-reply` | 一条长回复逐 token 流式输出（纯文本） |
| `perf/stream-long-reply-fenced` | 同一条长回复，但正文里混了代码围栏（第二轮新增） |
| `perf/stream-tool-storm` | 大量工具事件持续流入 |
| `perf/typing-30s` | 输入框连续打字 30 秒 |

## 测量互斥

5 个 Agent 在同一台机器上并行测量。别的 Agent 在构建或测量时，数字量到的是争抢而非被测代码。

测量脚本：`E:\Projects\duya\.claude\perf-bench-lock.mjs`（gitignore 区，不进仓库）。

```powershell
node E:\Projects\duya\.claude\perf-bench-lock.mjs acquire <agent>
# ...跑测量...
node E:\Projects\duya\.claude\perf-bench-lock.mjs release
```

`acquire` 成功退出码 0；被占用退出码 2 并打印占用者，此时先做不需要计时的准备工作，不要硬跑。超过 30 分钟的锁视为失效可被接管。报告里写明每个数字是否在持锁状态下取得。

## 验收

- `e2e/perf/**` 一条命令出报告：p50/p95 交互延迟、帧时间、主线程 Long Task、React Commit、DOM 节点数、CPU/GPU、内存峰值与增长曲线。
- 每个优化 PR 含改前/改后同机同会话数据、底层证据（Profiler / CPU / 布局）、用户可感知判定。
- 真实 Electron + 生产构建；冷/热启动各多次采样，看趋势，不设未经校准的硬阈值。
- 只有已证明与真实用户延迟相关且稳定的代理指标进 CI。
- 不得靠删功能、删测试、改阈值、关动画换绿。

## 进度

- [x] 冻结路径所有权，建 6 个检出（5 agent + 1 集成）
- [x] 写计划并提 PR #382 → 已合并 `766db972`
- [x] 建测量互斥锁（`E:\Projects\duya\.claude\perf-bench-lock.mjs`）
- [x] A 交付 Harness v1（PR #386，CI 全绿）
- [x] B 交付流式渲染优化（PR #385，主线程占用 −49.4%）
- [x] D 交付 GPU 观测（PR #391，结论：无 GPU 侧可证明收益）
- [x] C 交付 React 状态优化 / 侧栏重渲染（PR #400）
- [x] E 交付 UI 包架构优化（PR #401，懒加载与首屏资源）
- [x] 集成者按 CI + 证据定合并顺序，合并后**串行**重跑 Profile（权威基线见下）
- [x] 产出按实测收益排序的下一轮机会清单（10 条）
- [x] 第一轮全部合并（#392，merge commit `18a144e8`）
- [x] 第二轮：#0 首屏 SDK 移出 entry chunk（Agent F，PR #418）
- [x] 第二轮：#1 万条消息行虚拟化（Agent G，PR #421）
- [x] 第二轮：合并后串行重跑，更新权威基线
- [x] 第三轮：布局缺陷修复（PR #422，恢复 `.app-workspace-row` 布局规则）
- [x] 第四轮：harness 三个 P0（锁自杀 #429 / CI 路由 #430 / 信号预算 #431）
- [x] 第四轮：同轮 before/after 权威重跑（before `73c22414` → after `8becf37c`，10k 三个有效样本）
- [x] 第四轮：刷新快场景权威基线（startup / stream / typing / panels / gpu）
- [x] 第五轮：数据路径 O(n²) 根因定位 + 修法（PR #444，Host 新增整读）
- [x] 第五轮：同轮 before/after 权威对照（10k 打开 35.2 s → **1.4 s**，切换 47.7 s → **1.7 s**）
- [x] 第五轮：投影次数门禁（机器无关，确定性）
- [x] 第六轮：Web 侧同一条 O(n²) 路径（PR #458，83 507 ms → 1 006 ms，CI 五项全绿）
- [x] 第七轮：终端离开首屏（PR #473，首屏 −14.00 %，已合并）
- [x] 第八轮：启动冷路径诊断（四个假设全部证伪）+ 相位分解进 harness

派工状态：A/B/C/D/E 五个 Agent 均已认领独占路径并交付第一轮。第二轮的 F（首屏依赖闭包）与 G（虚拟化）由集成者直接派工；第四轮由集成者收口（harness 与 CSS 属共享范围）。

## 第二轮

第一轮的权威基线指向两个最大的剩余瓶颈，第二轮就攻这两条。仍然一个 PR 只钉一个问题，各 Agent 独占路径，集成者定合并顺序。

第二轮的集成者侧工作也遵守同一条规矩：**一个 PR 只做一件事**。原本打包在一起的 5 件事被拆成 5 个 PR（#406 锁、#407 fixture 消歧、#408 首屏预算闸门、#409 围栏 fixture、#410 计划），不合的那个 PR（#404）被关掉，并在它下面留下拆分去向。

| Agent | 独占路径 | 检出 / 分支 | 目标 |
| --- | --- | --- | --- |
| F · 首屏依赖闭包 | `packages/ai/src/**`、`packages/ai/package.json`、`packages/ui/src/components/chat/{ChatView,MessageInput,SlashCommandPopover}.tsx`、`packages/ui/src/hooks/useContextUsage.ts`、`packages/ui/src/lib/providers/**`、`packages/ui/src/stores/context-usage-store.ts` | `.claude/worktrees/perf-bundle` / `codex/perf-bundle` | 把 `openai`（141 模块）与 `@anthropic-ai/sdk`（69 模块）移出首屏 entry chunk |
| G · 消息列表虚拟化 | `packages/ui/src/components/chat/MessageList.tsx` + 该目录下新增文件 | `.claude/worktrees/perf-virtual` / `codex/perf-virtual` | 万条消息会话打开从 32–37 秒降下来 |

base：`origin/master` = `18a144e8`（开工时）。两个检出都已用 `scripts/junction-worktree.mjs` 配好 56 个依赖链接。

**F 的判据**：首屏 entry chunk 里 `openai` / `@anthropic-ai/sdk` 的模块数必须**归零**，而不是「字节数变小了」。根因有三个候选，都必须实测排除：桶文件同时导出纯函数与 SDK 客户端（`packages/ai/src/index.ts:7` 与 `:50`）、`packages/ai/package.json` 缺 `"sideEffects": false` 导致 Rollup 不能摇掉未用的再导出链、首屏急切引用点（`ChatView.tsx:27`、`MessageInput.tsx:52-57`、`useContextUsage.ts:18-19`、`lib/providers/**`）。

**G 的判据**：按 fixture 分开报，不合并。10000 条的 `dom.nodes` 115354 → 目标量级下降，`longtask.total_ms` 14958 同步下降，且 `ChatMessageNavigator` 跳转到未挂载的消息、`hasMore` 向前加载、流式尾部、focus mode 都不回归。

**共同的测量纪律**：先 `node E:\Projects\duya\.claude\perf-bench-lock.mjs status`，被占就等；**持锁跨越整个「构建 + 测量」窗口**；单次持锁控制在 **25 分钟**内（脚本按年龄判失效，跨过 30 分钟别人会直接抢走）；所有 harness 调用统一带 `--lock-script "E:\Projects\duya\.claude\perf-bench-lock.mjs"`。

**并发会话的冲突**：另一个会话的两个 PR（#411、#413）也在改 `packages/ai/src/index.ts`。F 的改动被要求保持机械（只把 SDK 客户端的导出搬到新子路径，不动无关行），以便两边能共存；F 的 PR 开出来之前需要先把 master 合进去。

## 第二轮集成者侧已合并的 PR

| PR | 内容 | 状态 |
| --- | --- | --- |
| #406 | 测量锁的两种实现会互相拆台 → 修复 + 负对照 | **已合并** |
| #407 | `perf/stream-long-reply` 一个 id 指向两份内容 → 本地 harness 换命名空间 + 守卫测试 | **已合并** |
| #408 | 首个机器无关的性能闸门：首屏 JS 字节预算进 CI | **已合并**（`0e765ccf`，CI build job 实测通过） |
| #409 | 共享 harness 新增带围栏的契约 fixture（机会清单 #2 的前置） | **已合并** |
| #410 | 第二轮章程、两条新发现、验证记录 | **已合并** |
| #412 | PR #391 留下的真实回归：GPU 通道用常量注册，IPC 契约闸门看不见 | **已合并** |
| #418 | 首屏依赖闭包：SDK 客户端搬进 `@duya/ai/clients`，模块数归零 + 预算棘轮 | **已合并**（`aed0d13c`，CI 五项全绿） |
| #421 | 万条消息虚拟化（Agent G） | **已合并**（`7e5f3d5e`，CI 五项全绿） |
| #422 | 布局缺陷：恢复 `.app-workspace-row` + 3 条 `.panel-zone-expanded` 规则 + 布局契约测试 | **已合并**（`c76ef6e5`，CI 五项全绿） |
| #429 | harness 锁自杀：活 holder 记到 `holderPid`，`pid` 留给脚本 | **已合并**（`dead6e4d`） |
| #430 | CI 路由：纯 CSS 改动映射到拥有它的包的测试 | **已合并**（`bd20f6aa`） |
| #431 | harness 信号预算：随 fixture 规模派生（60s / 240s） | **已合并**（`b31cd192`） |

## 第三轮：第二轮的实测结果，和一个改写了优先级的新发现

### F · 首屏依赖闭包（PR #418）

判据是**模块数归零**，不是字节数变小：

| 指标 | before | after | |
| --- | --- | --- | --- |
| `openai` 在首屏闭包里的模块数 | **141** | **0 (absent)** | 判据达成 |
| `@anthropic-ai/sdk` 在首屏闭包里的模块数 | **69** | **0 (absent)** | 判据达成 |
| `firstScreen.bytes` | 3626123 | **3378253** | −247870 B（−6.83 %） |
| `entryChunkBytes` | 2726133 | **2478263** | −9.09 % |
| `totalJs.bytes` | 17937649 | 17689779 | −1.38 % |
| `startup.typeable_ms` p50 | 1796 ms | 1744 ms | **不可分辨**（两轮跨度 491 / 586 ms） |

三个字节差值**完全相同** → SDK 代码是从 entry chunk **整体挪进一个已有的懒 chunk**，不是被 tree-shake 掉。这是诚实的形态：首屏不再下载和求值它，包体总量基本没变。集成者独立复核了产物层面：`packages/ai/dist/index.js` 里对 SDK 只剩**动态 import**（`import('./api/anthropic-messages.js')`），`providers/adapters` 完全不在，`dist/clients.js` 存在——**不依赖 F 脚本自己的断言**。

**不宣称启动时间收益**：Δ p50 −52 ms，落在两轮各自的跨度内；该指标由 Electron 进程启动主导。收益在模块数与字节数上。

**为什么是拆桶文件而不是 `sideEffects: false`**：后者实测也能归零（entry chunk 还小 583 B），但它是「本包没有导入期副作用」的**全包承诺**，会改变 Electron main / worker / CLI 三个 bundle 的 tree-shaking，每加一个模块都要重新论证。结构性拆分拿到同样的结果，不带这个承诺。

**顺带棘轮了 CI 闸门**：#408 的预算是单边的（增长才红），不棘轮的话这次修复等于顺手把闸门放松了 6.83 %。基线改为 3378253（上限 3547166 B），负对照（临时改 3000000）精确变红：`FAIL: the first screen grew to 3378253 bytes (3299 KB, +12.61%), over the budget of 3150000 bytes`。

**一个被写进 PR 的测量陷阱**：`tsc -b` 用输入/输出的 mtime 判断「项目是否最新」，所以**还原一个源文件会让它拿到比产物更旧的 mtime、构建被静默跳过、dist 保持旧的**。F 的第一轮 after 因此量到的是基线，已作废重做；现在脚本会删 `tsconfig.tsbuildinfo`、顶 mtime，并且**断言产物**（`dist/clients.js` 存在、`dist/index.js` 无静态 SDK 边）之后才测量。

### 新发现：万条会话的 30–45 秒**不是渲染瓶颈**

这条改写了整个机会清单的优先级，而且**它不依赖任何跨轮对比**——它是**基线自身的事实**：

| `perf/session-10000`（第一轮权威基线 `ed3882de`） | 值 |
| --- | --- |
| `session.open_ms` | 32154 / 36881 / 37054 |
| `session.open.longtask.total_ms` | **670 / 748 / 857** |
| `session.switch_ms` | 37685 / 40668 / 42008 |
| `session.switch.longtask.total_ms` | **6944 / 7376 / 7504** |

**open 的主线程长任务只有 0.7 秒，却花了 32–37 秒。**所以「打开一条万条会话要 30 多秒」这件事，**渲染只占 0.7 秒**；剩下 30 多秒在等数据（主进程读库 / IPC 传输 / renderer 拿到 store 更新）。第一轮把这条机会记成「渲染太重」，**方向是错的**。

G 的虚拟化实测把它照得更清楚（同一轮、持锁、`lock.held = true`、`skippedScenarios: []`）。**这张表是 G 那一轮的数字，第四轮在修好布局 + 预算后重测过，权威数字见「第四轮」章节**：

| `perf/session-10000` | 改前（基线） | 改后（G） |
| --- | --- | --- |
| `session.switch.longtask.total_ms` | 6944 / 7376 / 7504 | **514 / 612 / 728**（−92 %） |
| `longtask.total_ms` | 14958 | 618（−96 %） |
| `dom.nodes` | 115354 | 22563（−80 %） |
| `mem.peakMB` | 430.32 | 93.04（−78 %） |
| `scroll.frame.p95_ms` | 1017.6 | 16.8（−98 %） |
| `session.open_ms` 墙钟 | 32154 / 36881 / 37054 | 28882 / 29141 / 30153 |
| `session.switch_ms` 墙钟 | 37685 / 40668 / 42008 | 43046 / 44840 / 46866 |

渲染成本塌了 12–25 倍，**墙钟几乎没动**——这正是「墙钟被数据路径主导」的证据。虚拟化解决的是**真实且用户可感知**的问题（切换时界面不再冻结 7.4 秒、内存 430 → 93 MB、滚动帧 p95 1017 → 16.8 ms），但它**没有**缩短那 30–45 秒。

**下一轮的第一号机会因此改变**：不是继续抠渲染，而是先把 open/switch 的墙钟**拆成「数据到达」与「渲染」两段**（t_click → t_data → t_dom），定位那 30 秒落在主进程/DB/IPC 的哪一段。G 的探针正在做这个拆分。

### G · 万条消息虚拟化（PR #421，已合并 `7e5f3d5e`）

代码 + 24 个用例已就位（`messageVirtualizer.ts` 331 行 + 19 个单测、`messageListWindowing.test.tsx` 5 个集成用例）。集成者复核了实现：偏移与 spacer **同源**（`planRowItems` 从同一套 offset 算高度）、测量有 1 px 抖动阈值、内容尺寸列表单独算可见切片（`clientHeight` 在这个 app shell 里是**整篇**的高度，不是视口）、跳转目标用 `pendingJumpRef` 保持挂载直到视口真的到达、锚点校正用 generation 计数避免普通重渲染移动视口。四个回归点（跳转 / 向前加载 / 流式尾部 / focus mode）都有对应测试。

## 第四轮：先修布局，再修 harness

第三轮把「万条会话 30 秒」的瓶颈从渲染改判成数据路径，并留下了两个必须先补上的窟窿：**布局是坏的**，**harness 自己会死**。第四轮先补窟窿，再重新出数。

### 布局缺陷（PR #422，已合并 `c76ef6e5`）

`bcf0d946` 删 `conductor.css` 时连带删掉了仍在使用的 4 条规则：`.app-workspace-row` 一条 + `.panel-zone.panel-zone-expanded` 三条。它们被放回 `packages/ui/src/styles/workspace.css`（`.panel-zone` 规则所在地），并配了 4 个布局契约用例（读 CSS 源码断言选择器与属性）。

实证（真实 Electron + 生产构建 + 产品 IPC 播种 1000 条会话）：

| | 改前 | 改后 |
| --- | --- | --- |
| `.app-workspace-row` 高度 | **115585 px**（`display:block`、`containerType:normal`） | 818 px（`display:flex`、`container-type:inline-size`） |
| `.message-list-scroll` client / scroll | 115187 / 115187 → **可滚动距离 0** | 694 / 113260 → max 112566 |
| 末条消息 | bottom=115103，**在视口外 114k px** | `visibleInViewport: true` |
| `dom.nodes` | 11842 | 3437 |

**改前用户滚不到这条会话的结尾。** 负对照：把 `workspace.css` 还原成改前状态 → 4 条契约测试全红并点名缺失属性；还原后 4/4 绿。

**这一条改写了后面所有数字的含义**：`scrollTranscript()` 在坏布局下 `max = scrollHeight - clientHeight` **恒为 0**，所以第一/二轮基线里的 `scroll.frame.*` 是**空操作**测出来的，`dom.nodes` 也是在坏布局下测的。**旧基线的滚动与 DOM 数字作废**，以第四轮的基线为准。连带影响：4 条 `@container` 查询（`composer-panels.css` 719px、`preview-drawer.css` 879px、`code-review.css` 720/864/1280px）依赖这个 container 上下文。

### harness 的三个 P0（#429 / #430 / #431，均已合并）

| PR | 问题 | 修法 |
| --- | --- | --- |
| #429 | **harness 静默自杀**：`--lock-script` 模式下 `claimOwnerPid()` 把 harness 自己的 pid 写进共享脚本 owner 文件的 `pid`，而脚本 `release` 会 `process.kill(owner.pid)` → 第一个场景结束后 exit 1、无报错、无报告，并泄漏一个哨兵进程 | 活 holder 记到新字段 `holderPid`，`pid` 原样留给脚本（脚本唯一允许杀的字段）；仓库内实现写 `pid: null`；存活判断读 `holderPid ?? pid`；锁目录从「传入的那个脚本」推导 |
| #430 | **纯 CSS 改动进不了单测范围**：`test-scope.mjs` 只认 ts/tsx，`test` job 必红「Changed unit scope has no test or source targets」 | 样式文件映射到拥有它的包的测试（清单来自 `git ls-files`）；无归属则退回全部；未知路径仍走 fail-closed 的 `full` |
| #431 | **信号预算不够**：`session-switch` 等「末条消息出现在 DOM」只有 120 秒，而 10k fixture 的数据路径 p100 超过 120 秒 → 3 个样本里 2 个记成 error | 预算随 fixture 规模派生（≤1000 条 60 秒，>1000 条 240 秒 = GPU 场景给单样本的预算），并把预算写进报告的 fixture notes 与每个样本 |

#429 的负对照用的是**假脚本**：它记录「自己会杀的 pid」而不是真杀，断言那个 pid 是脚本自己的 `424242` 而不是 `process.pid`。

### 同轮 before/after 权威重跑

before = `73c22414`（master 在 #422 之前），after = `8becf37c`（master + #422 + #421）。同一台机器、同一天、两个跑次都持锁（`lock.held = true`、`skippedScenarios: []`）。**after 侧 10k 三个样本全部有效**（预算修好后）。

`perf/session-10000`：

| 指标 | before | after | 变化 |
| --- | --- | --- | --- |
| `dom.nodes` | 115354 | **569** | **−99.5 %** |
| `dom.mutations` | 11976 | 2929 / 1445 / 1445 | −88 % |
| `longtask.total_ms` | 93431 / 112297 / 46276 | **569 / 554 / 283** | **−99.5 %** |
| `longtask.count` | 110 / 126 / 56 | **3 / 3 / 3** | −97 % |
| `session.switch.longtask.total_ms` | 26676 / 21163 / 7189 | **569 / 554 / 283** | −99 % |
| `mem.peakMB` | 827.99 / 817.80 / 857.45 | **70.76 / 79.84 / 68.34** | **−91 %** |
| `cpu.renderer_pct` | 41.07 / 44.02 / 29.15 | **3.09 / 5.81 / 3.61** | −90 % |
| `frame.max_ms` | 1918.3 / 1001.1 / 1985 | 1016.7 / 216.7 / 100.1 | −90 % |
| `session.open_ms` | 82073 / 76572 / 73520 | 75292 / 80128 / 74844 | −2 %（数据路径主导） |
| `session.switch_ms` | 102274 / 99835 / 76496 | 114611 / 136352 / 111673 | **+15 %（未解释，见下）** |
| `commit.count` | 3 | 42 / 42 / 43 | +39（**是滚动时虚拟化器的挂载**，不是打开/切换变重） |

`commit.count` 的 +39 需要说清楚：打开阶段的提交数 before/after **完全一样**（9 / 9），切换阶段也一样（2 / 2）。多出来的批次全部产生在**滚动**阶段——虚拟化器在滚动时挂载/卸载行。before 树之所以只有 3 次提交，是因为它的布局坏了、**根本滚不动**，滚动测量是空操作。

`scroll.frame.p95_ms`：after 侧 2/3 样本 16.8 ms，1/3 样本 1001 ms。**这一条不是渲染回归**：该样本的主线程几乎空闲（`longtask.total_ms` 569 ms、`cpu.renderer_pct` 3.09 %），而帧间隔 p50 也是 1000.8 ms——**每一帧**都隔了 1 秒，这是 rAF 被节流的特征，不是被长任务饿死。before 侧的 1000.8 ms 是另一回事：那里主线程被 46–112 秒的长任务占满，帧是真的被饿死的。

### 还没解释清楚的：切换墙钟 +15 %

after 侧的切换多花了约 12–15 秒，而这 12–15 秒里主线程几乎没事干（长任务 0.28–0.57 秒，CPU 3–6 %）——**全是等待**。同轮的 open 没变（−2 %），切换阶段的提交数也没变。

三条事实：

1. 这个 +10 ~ 14 秒在 G 的 A/B/A 轮里也出现过，两轮独立观测到同一量级，所以**不是偶发**。
2. 探针（G 的 `probe-rows.mjs`，240 秒预算）给出数据路径的分解：open 的 `t_click → t_data = 73048 ms`、`data → dom = 0 ms`；switch 的 `getThreadIPC` 一段就是 **103691 ms**，CPU profile **97.4 % idle**。
3. 因此这 12–15 秒落在**主进程侧**（读库 / 投影 / IPC），不在渲染。

**下一步要回答的问题**：切换时主进程做了多少次 `db:message:getBySession`、每次投影多少条记录。已知根因是「每页全量重投影」O(n²)；如果虚拟化让 store 发布了更多次更新、每次都触发一次全量重投影，那墙钟就会随**发布次数**而不是**数据量**增长。**这是下一轮第一号机会。**

## 第五轮：数据路径（PR #444）

上面那个问题有答案了。第四轮留下的「万条会话分钟级」和「切换墙钟 +15 %」是**同一个根因**：Host 每翻一页，就把整条历史重新投影一遍。

### 根因（实测，不是推断）

`packages/host/src/session-api.ts` 的分页读，每次调用都执行 `messageLog.listBySession()` 取**整条**历史，逐行 `JSON.parse`、逐行投影，最后才切出当前页。Desktop 侧 `apps/desktop/src/main/ipc/db-handlers.ts` 用 `limit: 200` 一直翻到末尾 → 1 万条消息 = **50 次全量投影**。

真实 `createHostSessionApi` + 真实 `MessageLog` 的基准（1 万条消息、3.6 MB rollout）：

| | |
| --- | --- |
| 分页读 50 页（Desktop 现状） | **16672 ms** |
| 同一条历史的一次投影 | **314 ms** |
| 倍数 | **53×** |

### 修法：Host 新增「整读」

- `packages/agent-protocol/src/session-api.ts`：`HostSessionApiV1.readAllMessages` + `HostMessageReadAllQuery`
- `packages/host/src/session-api.ts`：投影抽成共享的 `projectMessageItems()`，两种读共用；`readAllMessages` 只投影一次
- `packages/host/src/http-client.ts` / `http-server.ts`：既有 `/messages` 路由加 `?all=1`；分页语义不变；`all` 带上 `limit`/`cursor`（或值不是 `1`）一律 400
- `apps/desktop/src/main/ipc/db-handlers.ts`：桥接一次整读，不再翻页

### 同轮 before/after 权威对照

同一棵测量树、同一台机器、同一天，两个跑次都持锁，9 样本零失败。`perf/session-10000`：

| 指标 | before | after | 变化 |
| --- | --- | --- | --- |
| `session.open_ms` | 35249 / 37160 / 29503 | **1153 / 1364 / 1560** | **−96.1 %**（26×） |
| `session.switch_ms` | 50755 / 47698 / 46900 | **1543 / 2148 / 1672** | **−96.5 %**（28×） |
| `scrollHeight` | 1327480 px | 1327480 px | 0（同一份历史） |
| `dom.nodes` | 569 | 569 | 0（同一套虚拟化） |
| `commit.count` | 42 | 42 | 0 |
| `longtask.total_ms` | 302 / 281 / 298 | 419 / 527 / 615 | +77 %（见下） |
| `cpu.renderer_pct` | 4.65 / 4.54 / 4.18 | 35.97 / 33.39 / 37.22 | +692 %（见下） |
| `mem.peakMB` | 83.77 / 90.26 / 81.49 | 117.32 / 108.84 / 129.54 | +40 %（见下） |

`perf/session-1000`：open 626 → 336 ms（−46 %）、switch 684 → 359 ms（−48 %）。
`perf/session-100`（对照，本来就只有一页）：open 203 → 237 ms——一页之内没有可优化的地方，这个差异落在 0.2 s 量级的运行间噪声内。

**三处上升是同一件事**：渲染量没变（`scrollHeight`、`dom.nodes`、`commit.count` 三个都一模一样），变的是**投递方式**。before 把 10 000 条拆成 50 批、摊在 35 秒里；after 一次送到，渲染挤在 1.4 秒里完成——于是主线程长任务从 0.3 s 涨到 0.5 s，渲染器 CPU 从 4.5 % 涨到 36 %（分母从 35 秒变成 1.4 秒）。内存峰值 +33 MB 是整条历史一次性到达的代价。**这三个数字是本轮换来的代价，不是回归**，但它们指向下一轮的靶子。

「切换墙钟 +15 %」这个悬案到此**消解**：它和打开的分钟级是同一段等待，切换读得更多，所以等得更久。

### 门禁：投影次数（机器无关）

`packages/host/tests/session-message-projection-count.test.ts` 数的是**投影次数**，不是毫秒：

- 整读 → 投影**恰好 1 次**
- 分页读 → 投影**每页 1 次**（3 页就是 3 次）

这是 Claude 式棘轮在本仓的第一次落地：重新引入「每页全量投影」的那个提交会**直接红**，而不是等到某台机器上有人觉得慢才发现。它和 `apps/desktop/src/main/ipc/__tests__/db-handlers.test.ts` 里「桥接只调 Host 一次、绝不翻页」一起，把这条路径钉死。

## 第六轮：Web 侧同一条 O(n²) 路径（PR #458）

第五轮修的是 Desktop 桥接。**Web 走的是另一条路**：Desktop 不配置 UI services（走 `window.electronAPI`），Web 配了，于是同一个 Host 接口在 Web 侧还有一条分页读。

### 根因：同一个根因的第二条路径

| 调用点 | 改前 | 页大小 |
| --- | --- | --- |
| `packages/ui/src/lib/ipc-client.ts` 的 `readAllHostMessages` | 游标循环读 Host `/messages` | `limit: 100` |
| `apps/web/src/client/workspace.ts` 的 `#readFullHistory` | 游标循环读 BFF `/messages` | BFF 上限 100（`parseLimit(..., 50, 100)`） |

BFF 每页上限 100，比 Desktop 的 200 更狠 → 同样 1 万条消息，**Web 要翻 100 页，Desktop 翻 50 页**，每次都让 Host 重投影整条历史。

### 实测（真实 Host + 真实 BFF，1 万条消息，同一台机器同一个 rig，持共享锁）

| 路径 | 请求数 | 耗时 | 返回行数 |
| --- | --- | --- | --- |
| 分页循环 `?limit=100` | 100 | **83 507 ms** | 10 000 |
| 一次整读 `?all=1` | 1 | **1 006 ms** | 10 000 |

**83×**。两边的行数一致，结果没变。

### 修法：把整读接到 Web 这条链路上

- `packages/client-core/src/transport/host-api.ts`：`HostApiBridge` 增加 `readAllMessages` → `GET /v1/sessions/:id/messages?all=1`
- `packages/ui/src/services/ui-services.ts` + `ui-services-factory.ts`：`UiServices.sessions` 透出该操作（窄接口，Desktop 侧不需要）
- `packages/ui/src/lib/ipc-client.ts`：`readAllHostMessages` 从游标循环改成一次整读
- `apps/web/src/server/web-bff.ts`：`GET /api/sessions/:id/messages?all=1` → Host 整读。`all=1` 与 `cursor`/`limit` 同现一律 400 `invalid_message_query`，`all` 值不等于 `1` 也 400
- `apps/web/src/client/api.ts` + `ui-services-adapter.ts` + `workspace.ts`：Web 两条读路径都改整读

### 门禁：请求次数（机器无关）

四条门禁数的都是**请求次数**，不是毫秒：

- `packages/ui/src/lib/ipc-client.test.ts`：整读恰好 1 次、分页 0 次
- `apps/web/tests/client/api.test.ts`：整读恰好 1 个请求
- `apps/web/tests/client/workspace.test.ts`：整条历史 1 次请求、带 `all=1`、不带 cursor
- `apps/web/tests/server/web-bff.test.ts`：整读返回全部行且无 cursor、分页契约不变、`all=1&limit=2` / `all=1&cursor=abc` / `all=maybe` 均 400

### 产物：本轮没动 `packages/host/src/**`，产物照样要重建

`packages/host/bundle/worker-entry.js` 内联了 `@duya/client-core`（`worker-metafile.json` 里 client-core 占 8 个输入），所以改了 `packages/client-core/src/transport/host-api.ts` 就改了产物输入集 → 同一个 PR 里必须重建并提交 `packages/host/bundle/**`，否则 `bundle:verify` 判 STALE。**判定依据是 `bundle:verify` 的输入集，不是「我改没改 host/src」。**

## 第七轮：启动（PR #473）

前六轮里唯一 **0 % 改善**的用户 journey 是启动：第五轮之后 `startup.typeable_ms` 一直停在 1 741 ms。Claude 那篇里收益最大的也正是启动（claude.ai 首屏 5.6×、桌面冷启 1.9×），所以第七轮做启动。

### 先测：把 1 741 ms 拆开

工具是研究脚本 `docs-local/research/perf-startup/probe.mjs`（不入库）：真实 Electron + 生产构建 + `file://` 预览，进程起点取自 OS 进程表；主进程内部用临时打点读出 `whenReady`、每个 `await`、`createWindow()` 的时刻。

**第一版的结论是错的**：读代码时看起来瓶颈是主进程开窗前那串 `await`（ripgrep 导出 → 子代理迁移 → CLI 自动安装 → Host API → DB → 陈旧 run 对账 → 频道迁移），但那 10 个 `await` 加起来只有约 200 ms。测量把结论推翻了：

| 阶段 | 均值 | 占比 |
| --- | --- | --- |
| Electron/Node 启动 → `app.whenReady()` | 230 ms | 16 % |
| 主进程初始化链 → `createWindow()` | 250 ms | 17 % |
| `createWindow()` → 渲染器开始导航 | ~20 ms | 1 % |
| **渲染器文档加载（首屏 JS）→ DOMContentLoaded** | **~900 ms** | **63 %** |
| DCL → 首屏绘制 | ~100 ms | 7 % |

（探针本身也踩了一个坑：`app.windows()` 报出 `file:` URL 的时刻比渲染器自己的 `performance.timeOrigin` 晚约 700 ms——那是 Playwright 的 CDP 挂接延迟，不是产品延迟。量 Electron 启动必须用渲染器自己的时钟。）

### 找到了什么

`packages/ui/src/components/layout/panels/registry.ts` **静态**引入了 `TerminalPanel`，后者静态引入 `@xterm/xterm` + 4 个 addon（fit / web-links / unicode11 / webgl）。终端是「点进去才到」的面板，整包却躺在首屏入口 chunk 里。仓库里早就有正确写法：`CodeReviewPanel` 与 `SessionMessagesPanel` 都是 `React.lazy`。

### 改了什么

`registry.ts` 三行：终端改成 `lazy(() => import("./TerminalPanel").then(...))`，与那两个面板同一写法。`PanelZone` 本来就用 `<Suspense>` 包裹面板组件，落地不需要额外改动。

### 字节（确定，机器无关）

| | before | after |
| --- | --- | --- |
| 首屏载荷 | 3 470 634 B | **2 985 017 B**（−485 617 B，**−14.00 %**） |
| 入口 chunk | 2 570 644 B | **2 085 027 B**（−18.89 %） |
| chunk 数 | 7 | 7 |

### 墙钟：这一轮最重要的结论是「字节涨得不等于时间赚得多」

共享 harness 的 `startup` 场景（3 样本）**看不到**这个量级的收益：firstPaint 1291 / 1258 / 1339 → 1314 / 1395 / 1435，typeable 1422 / 1428 / 1568 → 1399 / 1805 / 1679。

改用分解探针单独量「渲染器文档加载」这一段（导航开始 → 首屏绘制），A-B-A 三段共 21 样本：

| 段 | n | 中位 | 均值 | 区间 |
| --- | --- | --- | --- | --- |
| before | 7 | 844 | 856 | 736–1180 |
| after（段 1） | 7 | 788 | 781 | 736–796 |
| after（段 2） | 7 | 824 | 857 | 808–976 |

合并 after（14 样本）中位 **810**、均值 **820**，对比 before 的 844 / 856：**约 −35 ms，落在噪声内**。

**这就是本轮最值钱的一条**：首屏少了 14 %（−486 KB），换来的只有约 35 ms——**约 0.07 ms/KB**。按这个兑换率，剩下的 2.99 MB 首屏**最多**还能换到约 200 ms。**继续砍字节的边际收益很低，下一轮该打的是冷启动本身。**

旁证：同一份代码的 `startup.reload.firstPaint_ms` 只有 **48–96 ms**，而冷启动的首屏是 1 258–1 435 ms。**差的那一秒多不是「字节多」，是冷路径**（`file://` 没有 V8 code cache + 冷文件缓存 + 首次绘制）。

### 门禁

- `packages/ui/src/components/layout/panels/registry.test.tsx`（新增）：导入 registry **不得**求值 xterm；终端 descriptor 必须带 `react.lazy` 标记。**负对照**：把静态引入改回去 → 2 个用例全红。
- `e2e/perf/baselines/first-screen-payload.json`：首屏预算棘轮从 3 378 253 B 收到 **2 985 017 B**。改回去是 3 470 634 B，超新上限 336 366 B → CI 直接红。

### 真机验证

仓库自己的 `panels` 场景本来就会打开终端并滚动它（`.titlebar-panel-launcher[data-page-id="terminal"]`）。改后跑它：2 个样本都是 `files:opened, terminal:opened, browser:opened`——懒边界没有把面板卡在 Suspense 兜底上。

### 发现与决策（新增）

- **Claude 的「预编译 V8 code cache」在 Duya 的主进程上不成立**：主进程 bundle 4.0 MB 的 V8 解析只要 **48 ms**，省不下什么。**真正的落点在渲染器**：同一份 JS 冷启动要 ~900 ms、reload 只要 48–96 ms。**但这还是假设，不是结论**——下一步必须先证明「冷启动多出来的那一秒是 code cache 缺失」。
- **字节门禁能抓住的，墙钟门禁抓不住**。这轮首屏少了 14 %，harness 的 `startup` 指标看不出来。**How to apply**：能用字节/次数表达的收益，就用字节/次数做门禁；墙钟只当趋势，而且要先量出「字节 → 时间」的兑换率再决定值不值得继续砍。
- **读代码得出的瓶颈不成立，测量给出的才成立**。第七轮的第一版结论（主进程 `await` 链）被自己的探针推翻——那 10 个 `await` 一共只有 200 ms。**How to apply**：拿到「慢」的抱怨，先量一遍各阶段的分布，再决定动哪一段。
- **Electron 启动的测量要用渲染器自己的时钟**。Playwright 的 `app.windows()` 报出 `file:` URL 的时刻比 `performance.timeOrigin` 晚约 700 ms（CDP 挂接延迟），照着它算会得出「窗口创建后有 900 ms 黑洞」的假结论。
- **面板的懒加载边界要用「真的打开它」来验**。本轮的终端探针一开始误报失败，原因是终端启动器只在**有活跃会话**时渲染（`currentView === "chat" && activeThreadId`），而探针的 profile 没有会话——**是探针错了，不是产品坏了**。最后用仓库自己的 `panels` 场景（它本来就会开终端）验证，结论才可靠。

## 第八轮：启动的冷路径（先把「那一秒」钉死）

第八轮先不打性能，而是把第七轮留下的那个假设钉死：「冷启动比 reload 多出来的那一秒多是什么」。第七轮的结论是「`file://` 渲染器没有 V8 code cache」——**第八轮证明它不成立**，并且顺带把另外三条看起来很合理的修法全部证伪。

### 测法

探针 `docs-local/research/perf-coldstart/probe3.mjs`（研究脚本，不入库）：真实 Electron + 生产构建 + `file://` 预览，用**渲染器自己的** `performance.timeOrigin` 计时（Playwright 挂接延迟会骗人，见第七轮），配 `app.getAppMetrics()` 读进程谱系。开发树：`perf-coldstart`（基于 master `12ede3a1`）。

### 冷启动的四段（实测）

| 阶段 | 冷启动 | 同进程 reload |
| --- | --- | --- |
| 导航开始 → HTML 就绪 | **700–980 ms** | **2–6 ms** |
| HTML → DCL（首屏 JS：拉取+编译+执行） | 275–370 ms | 99–177 ms |
| DCL → 首绘 | 3–133 ms | — |

**冷启动 1.4 s 里约 1.07 s 是 Chromium 自己的进程热身**（浏览器进程 ~400 ms + 渲染器冷初始化 ~670 ms），**我们能动的只有 ~470 ms**：主进程初始化链 264 ms + 首屏 JS 220 ms。

主进程初始化链的分段（插桩实测）：早段 8 ms / **DB 105 ms** / 配置+频道+插件 84 ms / `createWindow` 67 ms。

### 被证伪的四个假设

1. **「`file://` 渲染器没有 V8 code cache，所以要用 Claude 的预编译 code cache」——不成立。** profile 里的 `Code Cache/js` 只有 index（**没有脚本缓存**；只有 preload 有 78 KB 的 code cache）；同一 userData 的二次启动（热 profile）**不比冷启动快**（热中位 796 ms vs 冷中位 960 ms）。而且首屏只有 2.98 MB，按主进程 4.0 MB → 48 ms 的解析速度，code cache 最多值几十 ms。**Claude 那招在 Duya 的渲染器上没有落点。**
2. **「那 700 ms 是 network service 冷启动，预热它就能省」——不成立。** 在 `whenReady` 最开头强制拉起 network service 后，`navToRequest` 中位 816 ms vs 基线 ~710 ms。
3. **「提前创建窗口能让渲染器提前热身」——不成立。** A/B 中位 **1 642 ms（改）vs 1 610 ms（基线）**。`app.getAppMetrics()` 显示 **Chromium 直到导航才起渲染器进程**，提前建窗口换不来提前初始化。
4. **「`app.getGPUFeatureStatus()` 是同步 IPC，会把启动链卡住」——不成立。** 插桩显示基线链长 **233 ms**、延后后 388 ms（同一台机器同一段代码），那 865 ms 全在**异步**的 `app.getGPUInfo('complete')` 上，不阻塞主线程。

另外两条也试了、都**无可测收益**：把插件市场 `git clone` 与远程 MCP rehydrate 延后到窗口就绪之后——firstPaint 1 460 vs 1 424 ms（clone 主要是网络等待，不抢 CPU）。

**结论：启动这条 journey 剩下的可动量只有 ~470 ms，其中 Chromium 的冷渲染器初始化那 ~670 ms 我们改不动。** 继续在这条线上找「一键提速」是找不到的。

### 首屏入口 chunk 到底是谁

`npx vite build --sourcemap` + 逐字节归因（`docs-local/research/perf-coldstart/chunk-attribution.mjs`）：

| 模块 | 入口 chunk 里的字节 |
| --- | --- |
| `@xterm/xterm` + 4 个 addon | **~490 KB** ← 第七轮 #473 已修（已合并） |
| `katex` | **260 KB** |
| `i18n/en.ts` + `i18n/zh.ts` | **270 KB**（两种语言都在首屏） |
| `stream-session-manager` | 74 KB |
| `@dnd-kit/core` / `tailwind-merge` / `zod` / 各家模型目录 | ~180 KB |

### 本轮交付：把相位分解做成 harness 能力

第七轮的分解探针是研究脚本，不在 `scripts/perf/run.mjs` 里，所以「启动慢」只能看到两个端点。本轮把它变成 harness 的常驻指标：

- `e2e/perf/lib/startup-phases.mjs`（新增）：纯函数 `startupPhases(navigation, paints)` 把一次文档加载拆成 `navToHtml` / `htmlToDcl` / `dclToPaint`，外加读页面用的 `readStartupPhases()` 与按前缀展开指标的 `startupPhaseMetrics()`。
- `e2e/perf/scenarios/startup.mjs`：`startup.cold.phase.*`（冷启动）与 `startup.reload.phase.*`（同进程 reload 的热参考）两组指标。
- `scripts/perf/harness.test.ts`：5 个用例（分段正确 / 没有导航条目时全为 null 而不是 0 / 没绘制时绘制段为 null / 里程碑尚未发生时不报负数 / 指标命名）。**负对照**：把 `htmlToDcl` 的算法改错即红。
- `e2e/perf/README.md`：指标含义与「reload 是热参考」写进契约段。

**为什么它值一个 PR**：这轮四次尝试全部证伪，每一次的代价都是重新搭一套测量。相位分解进 harness 之后，下一个 Agent 不用再从零复现这四段。

### 发现与决策（新增）

- **「`file://` 没有 V8 code cache」是错的**：只有 preload 有 code cache，页面脚本没有；热 profile 也不比冷 profile 快。**How to apply**：以后看到「冷启动慢，先上 code cache」这个念头，先去 profile 目录里看一眼 `Code Cache/js` 有没有东西。
- **Chromium 直到导航才起渲染器进程**（`app.getAppMetrics()` 的 `Tab` 条目在导航时才出现）。**How to apply**：想靠「提前建窗口」给渲染器热身是无效的，别再试。
- **同步 ≠ 阻塞**：`app.getGPUFeatureStatus()` 是同步 API，但它不阻塞主线程；真正贵的是后面的异步 `getGPUInfo('complete')`。**How to apply**：判断一个调用是否拖累启动，看它在等什么，不要看它是不是 async。
- **可测量的边界要自己划**：本轮四次修法里有三次「机制上说得通」但墙钟无差异。**How to apply**：机制假设必须配一个 A/B，否则不进主干。
- **归因要用逐字节 sourcemap，不要用文件大小猜**：`npx vite build --sourcemap` 之后按 mapping 归因，才能知道入口 chunk 里 490 KB 是 xterm、260 KB 是 katex。

## 集成记录

| PR | Agent | 内容 | 状态 |
| --- | --- | --- | --- |
| #386 | A | 真实 Electron 性能 Harness（`e2e/perf/**`、`scripts/perf/**`） | **已合并** `8721dc75` |
| #385 | B | 流式渲染：`CodeBlock` memo 化，停止重高亮已完成代码围栏 | **已合并** `8492dbd9` |
| #391 | D | GPU 观测：合成状态 + WebGL Context Lost 观测通道 | **已合并** `f617e4c1` |
| #400 | C | zustand hydrate 归一化搬进 `merge` + 侧栏订阅收窄 | **已合并** `8d69d81a` |
| #401 | E | 8 个「点进去才到」的界面树改 `React.lazy` | **已合并** `7063a47f` |

合并顺序（A → B/C/D/E），合并后由集成者**串行**重跑 Profile 出一份权威数字。

PR #389（另一个会话，`codex/plan-perf-handoff`）提出把本计划归档、声称「Desktop UI 性能与 TUI 性能不再由 mavis 负责」。当时**不合并**：它的前提（只查 `master`）与实际不符——#385/#386/#391 已存在且带实测数据；owner 已确认本线继续由 mavis 推进。已在该 PR 下留事实更正评论。

**后续（2026-10-24）**：#389 由 owner 合并（`2ca7886f`），但它**只带 622 系列的交接说明**（`docs/exec-plans/active/622-agent-platform-convergence/HANDOFF.md` 与该目录 README），**没有归档本计划**——它自己的文件里写明「Desktop 性能爬坡计划本身未归档——它在 master 上仍是 active 计划」。本计划继续 active，负责人不变。

## 发现与决策

- 本 harness 没有 managed worktree 工具，按 `docs/development/worktree.md` 第 1 节手工建 linked worktree；6 个检出均已用 `scripts/junction-worktree.mjs` 配好依赖覆盖层。
- 基准不能复用 3000 端口：`dev-detector` 只探 3000–3005，命中的是别的 worktree 的 vite，量到的不是被测代码。走 preview 模式或显式端口。
- 目标文件规模：`App.tsx` 1192、`ChatView.tsx` 1366、`conversation-store.ts` 1694、`MessageList.tsx` 1209、`MessageInput.tsx` 2356 行。规模不是证据，先 Profile 再动手。
- **B 的结论**：流式时增长中的消息块每帧重解析整篇 markdown，连**早已写完的代码围栏**也被每帧重新分词 + 重新高亮。判定性实验——同文本把围栏去掉语言（不 tokenize）后主线程占用 1298.6 → 297.5ms，说明**语法高亮占约 78%**。改 `CodeBlock` 为 `React.memo` 后主线程占用 1276.3 → 645.5ms（−49.4%）、帧 p95 33.3 → 16.7ms，`dom.nodes` / `dom.mutations` 全 0% 变化，视觉逐字节一致。**增长中的那段 markdown 仍每帧整篇重解析（约 300ms 量级），是下一轮的候选。**
- **D 的结论**：GPU 侧**没有**可证明的收益。软件合成（`--disable-gpu`）对终端帧耗时无可证明影响（83.5 vs 99.9ms，落在轮间噪声内）；唯一可证明的差异是**渲染器选择**——终端从 WebGL 回退到 DOM 后帧 p95 116.9 → 183.7ms（+57%）、Long Task 167 → 369。因此本 PR 只交付观测能力，不做 GPU 开关实验。
- **A 查出的疑似产品缺陷**：全新 profile 且无持久化状态时，`isHydrated` 一直是 false，启动遮罩不消失、composer 保持禁用。根因线索是 zustand v5 下 `onRehydrateStorage` 直接 mutate state 不通知订阅者。落在 `conversation-store.ts`（C 的范围），已转给 C 复核。**C 已复核并修复，PR #400。**
- **zustand v5 persist 的关键机制**（C 查清）：`set(merge(persisted, current), true)` 是**唯一**一次写入；`onRehydrateStorage` 在这次写入**之后**运行且原地改写 state，所以字段值变了但**没有任何订阅者被通知**。把归一化搬进 `merge`，`isHydrated: true` 才随这次写入发布出去。用户可见后果有三个：启动遮罩只能等 5 秒看门狗、侧栏等 `isHydrated` 才去读 SQLite 会话列表、欢迎页 composer 等 `isHydrated` 才收输入。
- **C 盘写满是本轮最大的隐形杀手**：所有 Agent 会话都死于 `ENOSPC: no space left on device`，与逻辑无关。根因是 `%LOCALAPPDATA%\Temp` 堆积 8.7 GB 陈年临时垃圾（.NET/VS 构建缓存、编辑器安装包）。**trash launcher 接受工作区外的单个文件、拒绝目录**，且回收站清空前不释放空间——必须 `rm --` 之后 `Clear-RecycleBin`。清理后 C 盘空闲 0.15 GB → 2.48 GB。
- **git push 在本机会被服务端中断**（`POST /git-receive-pack` 30 秒后被关闭，报 `the remote end hung up unexpectedly`）。用 `git -c http.postBuffer=524288000 -c http.version=HTTP/1.1 push` 可稳定推送。
- **PR #400 的 CI typecheck 失败是基础设施 flake**，不是代码问题：`npm ci` 编译 `node-pty` 时下载 Node headers 被中断（`gyp ERR! stack TypeError: terminated` / `Fetch.onAborted`），失败发生在**依赖安装阶段**，仓库代码还没开始类型检查。本地 `npm run -w @duya/ui typecheck` 通过。
- **E 的 follow-up（把 `Suspense` 边界收窄到视图本身）经实测判定为 no-op，不做 PR**。E 的理由是「这个分支同时渲染聊天区和当前视图，边界会把聊天区一起隐藏」。代码不成立：`renderView()` 里聊天分支的条件是 `currentView === 'chat'`，视图分支是 `currentView === 'skills'` 等，`currentView` 是**单一枚举值**，两者互斥。实测也支持这个结论：切到懒加载视图时 `main.app-content` **没有出现空白期**（本地 `file://` 读 chunk 约 26ms，落在两帧之内）。**教训**：这类「边界会不会连坐」的问题必须用运行中的产品回答，不能靠读 JSX——第一版 probe 采错了元素（采到 `.app-body` 的最后一个非侧栏子元素，实际是 `PanelZone` 而不是 `main.app-content`），差点得出「聊天区消失 1196ms」的假结论。
- **已丢失会话会留下持续污染机器的进程**。Agent A 的会话在 crash-recovery 里不断重启 `e2e/perf/run.mjs`，且用 `--lock-mode best-effort`（拿不到锁也照测），与集成者的权威重跑争抢 CPU 并抢占共享锁。清理方式：停掉子进程**并杀掉父 PowerShell**（否则它会再拉起），再释放已成孤儿的锁目录（持有者 pid 已不存在，但 30 分钟作废机制要等很久）。**How to apply**：发现锁被一个「持有者已死」的名字占着时，先核对 `owner.json` 的 pid 是否存活，存活再等，不存活直接释放。
- **共享 harness 的 fixture 不含代码围栏，所以它测不出 B 那类收益**。`buildStreamChunks('perf/stream-long-reply')` 产出 2000 片 / 30551 字符的纯文本，`chunksWithFence = 0`；`buildSessionMessages('perf/session-100')` 的 100 条消息里 `withFence = 0`。而 B 的 645ms 收益**恰恰来自代码围栏的语法高亮**（去掉围栏语言的对照实验：1298.6 → 297.5ms）。所以集成重跑里 stream 场景的 `stream.block_ms_total = 0` 与 `longtask.count = 0` **是真实的、不是测量失败**——没有围栏就没有高亮开销，`stream.frames` 2643–2910 是流式期间的真实渲染帧。**How to apply**：这说明「共享 fixture」和「取证 fixture」是两套东西，合并后的权威数字**不能**用来判断 B 的修复是否还有收益；B 的结论要以它自己的 before/after 为准。要让共享 harness 也能覆盖这类收益，fixture 里得放围栏——但那会改变 fixture digest，**必须新开 fixture id**（如 `perf/stream-long-reply-fenced`），不能改现有 id 的内容。
- **`perf/stream-long-reply` 这个 id 指向两份不同的内容**。共享 harness 的 `e2e/perf/lib/fixtures.mjs` 里它是 30551 字符的**纯文本**（无围栏）；B 的取证 fixture 在 `packages/ui/src/components/chat/__tests__/harness/fixture.ts`，同名 id 却是**含 3 个带语言代码围栏**的长回复。id 在本计划里是 fixture 契约的键（「固定 fixture」），同名不同内容会让任何跨 harness 的数字对比失去意义。**已消歧（第二轮）**：共享契约的 6 个 `perf/*` id **一个字都没改**（权威基线是拿它们测的，改 id 等于改 digest），而是把 UI 取证 harness 的场景 id 挪进自己的 `ui-harness/` 命名空间（`ui-harness/stream-long-reply`、`ui-harness/stream-tool-storm`），并在 `e2e/perf/agents/agent-b/README.md` 里给出旧标签 → 新标签的映射，让第一轮归档的证据仍然可读。`scripts/perf/harness.test.ts` 加了守卫：本地 harness 的标签一旦撞上契约 id，测试直接变红。**顺带查清**：那个 id 在 UI 侧只是 `SCENARIOS` 的键（`__tests__/harness/main.tsx:209`），不是内容查找键，所以消歧不需要动任何产品代码。
- **E 报告的「首屏体积 after 只有一个来源」这个缺口，由集成者串行重跑补上了**。E 承认它没能在拿到锁后独立复现 after 的数字（`startup.typeable_ms` 的 after 未测）。集成者的权威重跑用 `first-screen-payload.mjs` 在合并后的构建上实测：**首屏 JS 3541.1 KB / 7 chunk，entry chunk 2726133 B = 2662.2 KB**；PR #401 声称的是 3538.1 KB / 2659.2 KB。差 0.08% / 0.11%（3112 字节），是构建产物内容与时间戳的微差。**体积收益成立、可复现**。但**启动时间收益不成立**：E 测的基线 `startup.typeable_ms` p50=1934（n=5，cv 12.9%），波动区间 1715–2453ms 由 Electron 进程启动主导，**与首屏 JS 体积无可分辨关联**。所以 #401 的真实收益是「打开设置/工作流等页面时首帧略晚」的反面——即**用首帧延迟换首屏体积**，而不是「启动更快」。**How to apply**：报告启动时间时必须区分「进程启动主导」和「首屏资源主导」，否则会把噪声当收益。
- **Agent A 还有 8 个未合并的 harness 修复，是真实资产，不能随检出一起回收**。`codex/perf-harness` 分支比 master 多 8 个提交，全部只碰 `e2e/perf/lib/{launch,lock}.mjs`、`e2e/perf/run.mjs`、`e2e/perf/scenarios/gpu.mjs`、`scripts/perf/harness.test.ts`（与 B/C/D/E 的改动**零重叠**，可干净合并）：安全模式窗口与 Host 未就绪时重试（`e9e12d6a`）、按 namespace 而非 pid 找 app 关闭（`836a30c8`）、优雅关闭失败时强杀整棵进程树（`65066896`）、pid 回收后误杀无关进程的保护（`a1a392f8`）、**从已死的持有者手里接管锁**（`da8c32b4`）、每个样本 4 分钟预算（`c97e9989`）、每场景落盘报告（`965fe696`）。这些正是本轮观察到的孤儿 Electron、僵尸锁、启动失败的根因——**A 修的是自己踩的坑，E 的 baseline 里 8 个样本只有 3 个成功也正是 safe-mode 窗口所致**。
- **两种锁实现会互相拆台（第二轮发现，第四轮才真正修对）**。仓库内实现 `e2e/perf/lib/lock.mjs` 有一条正确的规则：**持有者进程没了 = 持有者崩了 = 锁可以接管**（`da8c32b4` 加的，否则崩掉的 Agent 会把整轮卡 30 分钟）。但外部脚本 `E:\Projects\duya\.claude\perf-bench-lock.mjs` 的 `acquire` 把自己那个**一秒后就退出的 pid** 写进 `owner.json` —— 于是仓库内实现一看到「pid 已死」就立刻抢走锁，**脚本驱动的 Agent 和仓库内驱动的 Agent 会同时测量**，两边的数字量到的都是争抢。
  - **第二轮的修法是错的**：仓库内实现走脚本 acquire 成功后用 `claimOwnerPid()` 把 owner 文件改写成**自己**的活 pid，外部脚本改为记一个**哨兵进程**的 pid（`detached` 起、release 时杀、最多活 90 分钟）。
  - **第四轮发现的语义漂移（PR #429 已修）**：脚本的 `release` 会 `process.kill(owner.pid)` —— 它**只认 `pid` 字段**。第二轮的修法把 harness 自己的 pid 写进了那个字段，于是**脚本 release 时把 harness 自己杀了**：`--lock-script` 模式下 harness 在第一个场景结束后静默退出（exit 1、无报错、无报告），并泄漏一个哨兵进程。探针 `docs-local/research/perf-workspace-row/kill-probe.mjs` 直接复现：owner pid == probe 自己的 pid，release 之后 `SURVIVED` 永不打印。
  - **现在的修法**：`pid` 是脚本**唯一允许杀**的字段，原样留给脚本；harness 的活 pid 记到新字段 `holderPid`，仓库内实现写 `pid: null`；存活判断读 `holderPid ?? pid`，所以脚本持有的锁（哨兵活着）与仓库内持有的锁（harness 活着）仍然互斥。负对照用**假脚本**（它记录「自己会杀的 pid」而不是真杀），断言那个 pid 是脚本自己的 `424242` 而不是 `process.pid`。
  - **教训**：「谁写这个字段」和「谁有权杀这个字段」是两个问题，第二轮的修法只回答了前一个。**How to apply**：给外部脚本写的文件做修改前，先读脚本本身怎么用这个字段，别只看自己这边的读写约定。
- **仓库内实现与共享脚本是同一个锁目录**：脚本的锁目录是 `path.dirname(script)/perf-bench.lock`，仓库内实现原本从**仓库里搜**脚本（可能找到另一份副本）。修法是从「传入的那个脚本」推导锁目录（`resolveEffectiveLockDir`），否则 release 操作的是一个没人持有的目录。
- **锁的「30 分钟即失效」是按年龄判的，不是按持有者判的**。脚本只看 `acquiredAt` 的年龄，**不看 pid 活不活**。所以一次「构建 + 测量」如果跨过 30 分钟，别人会直接 `[perf-lock] stale lock, stealing it` 抢走它，两个人同时测。**How to apply**：单次持锁控制在 25 分钟内；长测量分段做，每段之间 release → acquire 交接；报告里写明每个数字是否在持锁状态下取得。
- **PR #391 的 GPU 通道注册是真实回归，不是闸门误报（已修，PR #412）**。#391 用常量 `ipcMain.handle(GPU_STATUS_CHANNEL, ...)` 注册，**运行时 handler 确实注册了**，但 IPC 契约闸门是**源码扫描**——扫的是字面量形式的 `ipcMain.handle('...')`，看不见常量，于是任何跑全量测试的 PR 都会变红。修法是改回**字面量**（与仓库其余 handler 一致）+ 加单测把常量与字面量绑定，防止再次漂移。负对照：回退修复后精确复现 CI 原报错（2 failed），还原后 3 文件 27/27 绿。**教训**：闸门是源码扫描而非运行时反射时，「代码能跑」不等于「闸门能看见」——改注册形式前先看闸门怎么找。
- **CI 的 push 触发器跳过 test job**。所以 **master 绿 ≠ 没问题**：master 上可能带着某个 PR 的红，绿灯只说明「那次 push 没跑 test」。判断某 PR 是否真跑到了那些测试，必须看**该 PR head 的 test job**，不能看 master 的绿。同理，`test scope` 那个 job 绿只代表改动文件范围的 lint/format，不代表全量测试跑过。
- **「墙钟慢」不等于「渲染慢」——先用 `session.open.longtask.total_ms` 判一下是渲染还是等待**。基线里 open 的主线程长任务只有 670 / 748 / 857 ms，而 `session.open_ms` 是 32154 / 36881 / 37054 ms：**渲染只占 0.7 秒**，剩下 30 多秒在等数据。How to apply：任何「打开/切换要几十秒」的抱怨，先把 `session.*.longtask.total_ms` 和墙钟并排看——两者差一个数量级就说明瓶颈不在渲染，去查数据路径（主进程 / DB / IPC）；只有两者同量级才值得优化渲染。**这条如果搞反，会把整个优化方向带偏**：第一轮就把它记成了「渲染太重」。
- **`tsc -b` 用「输入 mtime vs 输出 mtime」判项目是否最新**。所以**还原一个源文件**（测量 before 时最常见的动作）会让它拿到比产物更旧的 mtime，整个包被**静默跳过**、`dist` 保持旧版——**构建「成功」了，但量的是上一版**。F 的第一轮 after 就这样把基线又量了一遍。How to apply：任何「还原→重建→测量」的循环，必须 (a) 删 `tsconfig.tsbuildinfo`、把源文件 mtime 顶到现在，(b) **在测量前断言产物**（新文件存在 / 旧静态边消失）。没有这一步，before/after 对照会静默地退化成 before vs before。
- **拆桶文件 vs `sideEffects: false`**：后者实测也能让 SDK 归零（entry chunk 还小 583 B），但它是「本包没有导入期副作用」的**全包承诺**，会连带改变 Electron main / worker / CLI 三个 bundle 的 tree-shaking 语义，每加一个模块都要重新论证。**结构性拆分**（把 SDK 客户端搬进独立子路径）拿到同样的结果，且不依赖打包器启发式、不可能被一次 re-export 悄悄 undo。
- **第五轮：数据路径的根因是「投影次数」，不是「读了多少行」**。`packages/host/src/session-api.ts` 的分页读每次都取**整条**历史再切页；Desktop 用 `limit: 200` 翻到末尾 → 1 万条 = 50 次全量投影。**How to apply**：拿到「慢」的抱怨先问「同一个东西被算了多少遍」，而不是「算了多少行」——本例里数据量只占一半，另一半是重复的**次数**。这个量可以做成门禁：数投影次数，纯计数、机器无关，比任何耗时阈值都稳。
- **第五轮：master 绿 ≠ 那条断言还成立**。`packages/cli` 的 `/context` 用例硬编码 `claude-sonnet-4` 当作「内置目录里 1M 上下文的模型」，而模型目录是从上游元数据**刷新**的（#442 加了自动化），那个 id 已经改名 → 断言失效。**master 照样绿**，因为 master 的 affected 范围从没覆盖 `packages/cli`；而任何动了 `packages/host/bundle/**` 的 PR 都会把 CLI 测试拉进范围（bundle 的 entry 就是 `packages/cli/src/agent-worker-entry.ts`）→ 在那里变红。**How to apply**：断言里凡是引用「会被刷新的产物」的值，都改成**从源头推导**（`allProviderModels.find(...)`），别硬编码；另有一个坑是**本地绿、CI 红**的第一嫌疑不是 flake 而是**本地构建产物陈旧**——本地 `packages/ai/dist` 还是旧版，要先 `npm -w @duya/ai run build` 才能复现。**这条修法已在 master 上**（与本线并行合入，内容一致），#444 的净改动里因此已经看不到它。
- **第五轮：同树 A/B 测量要用补丁，不要整文件拷贝**。测量树是 detached HEAD 的旧提交（`8becf37c`），比 master 旧。`Copy-Item` 整文件会把新 master 才有的 import（`packages/host/src/client-lease.js`）带进旧树 → `tsc -b` 报「找不到模块」，而且错误信息与本次改动毫无关系。正确做法：`git diff --output=<file>` 生成补丁（**不要**用 PS 的 `Out-File -Encoding utf8`／`>`，前者带 BOM、后者写 UTF-16，`git apply` 都会拒绝）→ `git apply --check` → apply → 重建 → 测量。这样 before/after 只差这一个改动，证据链才干净。
- **第六轮：同一个根因会有第二条路径，修的时候要把调用点一次列全**。第五轮只修了 Desktop 桥接（`apps/desktop/src/main/ipc/db-handlers.ts`），Web 走的是 `UiServices` → BFF → Host，另一条分页读还在原地。**How to apply**：找到 O(n²) 的读路径后，先把「谁在调这个接口」全部列出来（Desktop / Web / CLI / TUI），再决定改哪一层；只修最慢的那条，等于把同一个坑留给下一个人。另外 BFF 每页上限 100 比 Desktop 的 200 更狠 → 同样 1 万条消息，**Web 要翻 100 页，Desktop 翻 50 页**。
- **第六轮：`bundle:verify` 判的是「产物输入集」，不是「我改没改 `host/src`」**。`packages/host/bundle/worker-entry.js` 内联了 `@duya/client-core`（`worker-metafile.json` 里 client-core 占 8 个输入），所以只改 `packages/client-core/src/transport/host-api.ts` 也会让产物变旧 → 同一个 PR 里必须重建并提交 `packages/host/bundle/**`。**How to apply**：改完先跑 `node scripts/architecture/bundle-verify.mjs`，它会直接点名是哪个输入变了；别靠猜。
- **第六轮：门禁要数「次数」，不要数「毫秒」**。本轮四条门禁数的是请求次数（整读 1 次 / 分页 0 次），跨机器精确；耗时阈值在共享 CI 上必然抖动。**How to apply**：写门禁前先问一句「这个回归能不能被一个整数计数抓住」——能，就别写阈值。
- **第六轮：Web 侧的数字不能从 Desktop 的 harness 里读**。共享 harness 跑的是 Electron Desktop 路径；Web 是另一条链路（BFF 每页上限不同、进程边界不同）。本轮的权威数字来自「真实 Host + 真实 BFF」的进程内基准，**不是** `scripts/perf/run.mjs` 的场景。**How to apply**：报告里写清数字来自哪条链路，别把 Desktop 的基线套到 Web 上。
- **第六轮：整读与分页必须互斥，且要「拒绝」而不是「忽略」**。`all=1` 与 `cursor`/`limit` 同现一律 400 `invalid_message_query`，`all` 值不等于 `1` 也 400。忽略其中一个参数会让调用方以为自己拿到了完整的一段——那比报错难查得多。Host 侧 `?all=1` 已经是这个语义，BFF 沿用。


## 权威基线（第四轮：master + #422 + #421）

命令：`node scripts/perf/run.mjs --scenarios <…> --samples 3 --lock-mode strict --lock-wait-min 25 --agent mavis-after`
环境：Intel Core i5-14600KF / 31.8 GB / Node v24.16.0 / Windows 10.0.26200 x64 / Electron 44.2.0 / Chromium 152.0.7977.76 / 生产构建（`file://` 预览模式，非 dev server）
SHA：`8becf37c`（master + #422 + #421；本地另带 #431 的 harness 补丁，与 master **逐字节一致**）/ 锁：`held: true`，`implementation: in-repo`，锁目录与共享脚本**同一个**（`E:\Projects\duya\.claude\perf-bench.lock`）/ **6 场景 33 样本，零失败**

| 场景 | 关键指标（p50） | 说明 |
| --- | --- | --- |
| startup | `startup.firstPaint_ms` **1399.5**（CV 3.44%）、`startup.typeable_ms` **1741**（CV 9.33%）、`dom.nodes` 183（0%）、`commit.count` 4（0%）、`longtask.total_ms` 0 | 首屏 DOM 只有 183 个节点，提交数 4 |
| stream（无围栏） | `stream.block_ms_total` **0**、`longtask.count` 0、`frame.p95_ms` 16.8（0%）、`dom.nodes` 377、`stream.frames` 2582–2772 | 共享 fixture 无代码围栏 ⇒ 没有高亮开销 |
| stream（**有围栏**） | `stream.block_ms_total` **56 / 63 / 0**、`longtask.worst_ms` 56–63、`dom.nodes` **797**（无围栏的 2.1 倍）、`dom.mutations` **238**（无围栏的 9.2 倍）、`commit.count` 17 | **#409 加的围栏 fixture 第一次在共享 harness 里露出真实开销**：主线程被占最多 63 ms |
| stream（工具风暴） | `stream.block_ms_total` 0、`dom.nodes` 375、`stream.frames` 444–465 | 工具事件持续流入不阻塞主线程 |
| typing | `interact.p50_ms` **25.75**（CV 0.33%）、`interact.p95_ms` **32.30**（CV 0.25%）、`frame.p95_ms` 16.8（0%）、`dom.nodes` **557**（第一轮 1378）、`commit.count` 1、`longtask.total_ms` 0 | 输入延迟最稳的一组，是最可靠的 CI 候选来源 |
| panels | `panels.open_ms` 449（3 个面板）、`dom.nodes` **697**（第一轮 1533）、`frame.p95_ms` 16.8（0%）、`longtask.total_ms` 112（CV 33.5%） | |
| gpu | `cpu.renderer_pct` **5.04**（第一轮 99.4）、`longtask.count` 2（第一轮 305）、`longtask.total_ms` **111**（第一轮 **37230**）、`frame.p95_ms` 16.8（CV 0.28%）、`dom.nodes` 580 | 三种 GPU 状态（normal / unavailable / context-lost）合并；`webgl-context-lost` 三个样本都观测到 `lost=1`，**注入真实生效**；`gpu.terminal.degraded` 0 |
| session-switch（100 条） | `session.open_ms` **237**、`session.switch_ms` **203**、`dom.nodes` 569、`longtask.total_ms` 0、`mem.peakMB` 23–33 | 第五轮；对照用，一页之内没有可优化的地方 |
| session-switch（1000 条） | `session.open_ms` **336**、`session.switch_ms` **359**、`dom.nodes` 569、`longtask.total_ms` 0、`mem.peakMB` 34–49 | 第五轮 |
| session-switch（**10000 条**） | `session.open_ms` **1364**、`session.switch_ms` **1672**、`dom.nodes` **569**、`longtask.total_ms` **419–615**、`mem.peakMB` **109–130**、`cpu.renderer_pct` **33–37** | 第五轮（#444 之后）；第四轮同口径是 75292 / 114611 ms |

**session-switch 三行已被第五轮改写**：#444 把整条历史的读取从「每页一次全量投影」换成「一次投影」。10 000 条的打开从 **35.2 s → 1.4 s**、切换从 **47.7 s → 1.7 s**。这三行与其余场景的基线**不同源**——#444 只动 Host 与 Desktop 桥接，不碰渲染器，所以 startup / stream / typing / panels / gpu 五行仍以第四轮为准。第五轮没有重跑那五个场景。

**共享 harness 只覆盖 Desktop 路径**。Web（`apps/web`）是另一条链路（BFF → Host，每页上限与进程边界都不同），它的数字不在本表里；Web 侧的权威数字见「第六轮」章节。

**GPU 那一行的巨大落差**：旧基线（坏布局）测到 37.2 秒长任务与 99.4 % 渲染器 CPU，布局修好后是 **111 ms / 5.04 %**。**没有做受控对照**，所以不能断定是 #422 还是 #421 的功劳；但幅度排除了虚拟化（该场景的 fixture 只有 100 条消息，DOM 少挂载 800 个节点不可能省下 37 秒），最可能是终端的 WebGL 画布落在坏掉的 flex 容器里、尺寸反复重算。

**第一/二轮基线里与 DOM、滚动有关的数字作废**：那时布局是坏的（`.message-list-scroll` 的可滚动距离为 0），`scrollTranscript()` 是空操作。`dom.nodes` 的变化（typing 1378 → 557、panels 1533 → 697）来自虚拟化器只挂载可见行。

### 可进 CI 的代理指标（低噪声，机器无关）

按本轮实测的 CV，**只有这些够稳**：`interact.p95_ms`（typing，0.25%）、`interact.p50_ms`（typing，0.33%）、`panels.dom.nodes`（0.27%）、`frame.p50_ms`（startup，0.28%）、`frame.p95_ms`（panels 0.28% / gpu 0.28%）、`dom.mutations`（panels，1.87%）、`mem.peakMB`（typing 1.63% / panels 2.76% / stream 3.33% / gpu 4.70%）、`startup.firstPaint_ms`（3.44%）、`dom.nodes` 与 `commit.count`（startup，0%）、`longtask.worst_ms`（stream 有围栏，5.88%）、`gpu.probe.available`（0%）。

**仍然不能进 CI 的**：任何跨 fixture 合并的 session-switch 壁钟时间（10000 条是另一个数量级，CV 100%+）；`stream.block_ms_total` 的 p50 恒为 0（只有围栏那组有区分度）；`startup.typeable_ms`（CV 9.33%，比第一轮差，因为机器负载变了）。**注意 B 的收益不会被这些代理捕获**——它省的是重复计算，DOM 与提交数完全不变。


## 下一轮机会清单（按实测收益排序）

排序依据是**已测得的收益**，不是猜测。每条都注明证据来源与还需要谁来做。

| # | 机会 | 已测收益 / 证据 | 状态 | 归属 |
| --- | --- | --- | --- | --- |
| **0** | **启动的冷路径** | 第八轮把冷启动拆成四段：**导航→HTML 700–980 ms（Chromium 冷渲染器初始化，reload 只要 2–6 ms）** / HTML→DCL 275–370 ms（首屏 JS）/ DCL→首绘 3–133 ms。**我们能动的只有 ~470 ms**（初始化链 264 ms + 首屏 JS 220 ms） | **已证伪三条**：「`file://` 没有 V8 code cache」（`Code Cache/js` 里没有脚本缓存，热 profile 也不更快）、「预热 network service」（中位 816 vs 710 ms）、「提前建窗口让渲染器热身」（1 642 vs 1 610 ms，Chromium 直到导航才起渲染器进程）。**剩下可动的只有那 ~470 ms** | A |
| **1** | **整条历史一次性投递的代价** | 第五轮：10 000 条从「50 批摊在 35 s」变成「一次送到、渲染挤在 1.4 s」，于是 `longtask.total_ms` 298 → 527、`cpu.renderer_pct` 4.5 → 36 %、`mem.peakMB` 84 → 117（**渲染量不变**：`dom.nodes` / `commit.count` / `scrollHeight` 三个都一样） | **待做**：分块投递 + 增量渲染，别让主线程被一次性占用 | B / A |
| 2 | 围栏代码块在流式时的主线程开销 | 第四轮第一次在共享 harness 里量到：`perf/stream-long-reply-fenced` 的 `stream.block_ms_total` **56 / 63 / 0 ms**、`dom.nodes` 797（无围栏的 2.1 倍）、`dom.mutations` 238（9.2 倍）；B 的对照实验里围栏高亮占约 78 % | **待做**：把「增长中的整篇重解析」按 chunk 切开，只重解析新增部分 | B |
| 3 | 滚动时的虚拟化器挂载开销 | `commit.count` 3 → 42–43，但打开阶段 9/9、切换阶段 2/2 **完全没变**——多出的批次全在滚动阶段。帧 p95 16.8 ms（2/3 样本），另一样本出现 1 Hz 帧节流 | **待做**：滚动时按需挂载是否还能更便宜（批量化 / 预取窗口） | G |
| 4 | 终端从 WebGL 回退到 DOM 渲染器 | 帧 p95 116.9 → 183.7 ms（+57 %），Long Task 167 → 369 | **待做**。代价在**渲染器选择**而非 GPU 有无：别让终端悄悄掉回 DOM | D |
| 5 | 首屏 entry chunk 里剩下的一方模块 | 第八轮逐字节归因（sourcemap）：xterm + addon **~490 KB**（#473 已修）、**katex 260 KB**、**i18n 中英两份 270 KB**、`stream-session-manager` 74 KB、dnd-kit/tailwind-merge/zod/模型目录 ~180 KB。第七轮给了兑换率：砍 14 % 首屏只换约 35 ms（≈0.07 ms/KB） | **待做**：katex 只在消息含公式时需要、两种语言只用一种——但**两者都要把「首屏需要的同步内容」改成异步加载**（公式/文案会闪一下），**必须配真机验证再上**，不能只改字节 | E |
| 6 | 侧栏剩余的宽订阅 | C 已把 `ProjectGroupItem` 的两个 store 订阅收窄到 `useShallow`，props 换成按值比较 | **待做**：`app-sidebar.tsx` 还有 2086 行 | C |
| 7 | `commit.count` 的代理偏差 | 生产构建拿不到 React Profiler，MutationObserver 批次会**漏计无 DOM 变化的 React 提交**；第四轮又发现它**把滚动阶段的挂载也算进去**，读数时必须分阶段看（open / switch / 滚动） | **待做**：要么找到生产可用的提交计数方式，要么把漏计范围写清楚 | A |
| 8 | CI 回归门槛缺一个**机器无关**的代理指标 | 壁钟只能在固定机器上做趋势分析，GitHub runner 共享虚拟化 | **已完成**（#408）：首屏 JS 字节预算进 CI 的 build job（单边、5 % 容差、#418 已棘轮到 3378253，**#473 再棘轮到 2 985 017**）。**#444**：投影次数门禁。**#458**：请求次数门禁。**#473**：终端不得回到首屏（`registry.test.tsx`）+ 字节棘轮 | 集成者 + A |
| 9 | 其它 store 是否有同类「persist 后状态不发布」缺陷 | `onRehydrateStorage` 原地改写只出现在 `conversation-store.ts`；`projects-store` / `sidebar-sections-store` 用 `set()` 设 `hydrated`；`terminal-appearance-store` 无 hydration 标志 | **负结论**，已核实，不必再做 | — |
| 10 | 懒加载视图的 Suspense 边界收窄 | `currentView` 单一值使聊天分支与视图分支互斥；实测切视图时 `main.app-content` 无空白期（约 26 ms 落地） | **负结论**。若将来出现「加载慢导致可见空白」，再重开——那时要的是 `fallback` 骨架屏 | — |
| 11 | 启动的分解测量应该进 harness | 第七轮的探针（`docs-local/research/perf-startup/probe.mjs`）能拆出 boot / 主进程初始化链 / 渲染器文档加载 / 首屏绘制四段，但它是研究脚本，不在 `scripts/perf/run.mjs` 里 | **已完成（第八轮）**：`e2e/perf/lib/startup-phases.mjs` + `startup.cold.phase.*` / `startup.reload.phase.*` 两组指标 + 5 个单测 | A |

**已完成的条目从清单里移到历史**：首屏依赖闭包（#418，模块数 141/69 → 0）、万条消息虚拟化（#421，`dom.nodes` 115354 → **569**、`longtask.total_ms` 93431 → **283**、`mem.peakMB` 828 → **69**、switch 长任务 26676 → **569 ms**）。两者都**没有**缩短墙钟——墙钟由数据路径决定。数据路径 O(n²）本身已在 **#444** 修掉（10k 打开 35.2 s → **1.4 s**、切换 47.7 s → **1.7 s**），并附带一条**机器无关**的投影次数门禁；「切换墙钟 +15 %」这个悬案随之消解——它和打开的分钟级是同一段等待。**#458** 把 Web 侧同一条路径也修掉了（真实 Host + 真实 BFF：100 次分页 83 507 ms → 1 次整读 1 006 ms，**83×**），并带上四条请求次数门禁——**同一个根因的第二条路径**。**#473** 把终端（xterm + 4 个 addon，**485 617 B**）从首屏入口 chunk 里请了出去，首屏 3 470 634 → **2 985 017 B（−14.00 %）**，并棘轮了字节预算——但**墙钟只换来约 35 ms**，这个兑换率本身是本轮最值钱的结论。
## 验证记录

| SHA / dirty 范围 | 环境 | 命令 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `670a862c` clean | Windows / Node | `git worktree add` × 6 | 0 | `git worktree list` 6 项 perf-* |
| `670a862c` clean | Windows / Node | `node scripts/junction-worktree.mjs . --primary` | 0 | 每检出 56 个链接，`node_modules/.bin` 可用 |
| PR #386 → `8721dc75` | Windows / Node v24.16.0 | `gh pr checks 386` | 0 | architecture / build / test / test scope / typecheck 全绿 |
| PR #385 → `8492dbd9` | 同上 | `gh pr checks 385` | 0 | 五项全绿 |
| PR #391 → `f617e4c1` | 同上 | `gh pr checks 391` | 0 | 五项全绿 |
| PR #385 独立验证 | 同上 | `vi.mock` 注入回退版 `CodeBlock` + 逐帧 9 帧 DOM 比对 | 0 | 断言 #1 变红（`expected 1 but got 2`）；逐帧 DOM 全等；无产品文件改动 |
| PR #400 hydrate 负对照 | 同上 | 临时把 `merge` 还原成 `onRehydrateStorage` 原地改写 → 跑 hydration 测试 → `git checkout --` 还原 | 1（**预期**） | 9 个用例中 4 个变红：`expected [ false ] to include true`、`expected false to be true`、`expected [ '/work/demo' ] to be an instance of Set` |
| PR #400 还原后 | 同上 | 同上测试 | 0 | 9/9 绿；`git status` 干净；另两个测试文件 16 个用例绿 |
| C 盘清理 | Windows | `rm -- <16 个陈年临时文件>` + `Clear-RecycleBin -DriveLetter C -Force` | 0 | C 盘空闲 0.15 GB → 2.48 GB；回收站清空前不释放空间 |
| A 的 8 个 harness 修复 | 同上 | `npx vitest run scripts/perf/harness.test.ts`（`perf-harness` 检出 + 集成检出各一次） | 0 | 两处均 **26/26 绿** |
| A 的锁接管修复负对照 | 同上 | `git checkout da8c32b4^ -- e2e/perf/lib/lock.mjs` → 跑同一测试 → `git checkout HEAD --` 还原 | 1（**预期**） | 精确变红：`expected false to be true`，1 failed / 25 passed；还原后 26/26 绿、工作树干净 |
| PR #392 门禁 | `352bf353` + `88eb3eff` | `node scripts/architecture/architecture-check.mjs` | 0 | `OK — no new boundary violations`（2608 项全部落在既有 baseline 内） |
| PR #392 CI | 同上 | `gh pr checks 392` | 0 | architecture / build / test / test scope / typecheck **全绿** |
| 合并后权威重跑 | `ed3882de`（dirty：计划文档 + agent-e 工具） | `node scripts/perf/run.mjs --samples 3 --agent mavis-reprofile --lock-mode strict --lock-wait-min 25` | 0 | **6 场景 33 样本零失败**；`lock.held = true`、`skippedScenarios = []`；报告 `docs-local/research/perf-harness/perf-2026-10-24T02-01-06-073Z.json` |
| Suspense 边界实测 | 同上 | `docs-local/research/suspense-probe/probe.mjs`（真实 Electron，逐帧采样 `main.app-content`） | 0 | 切到懒加载视图时**空白帧 0**、视图约 26ms 落地 ⇒ E 的 follow-up 是 no-op |
| 检出回收 | — | `bash scripts/remove-worktree.sh <name> --dry-run` → 实际执行 | 0 | 4 个检出（harness/streaming/state/gpu）各摘 56 个 junction 后由 `git worktree remove` 移除；**分支保留**；C 盘 2.47 → 7.63 GB |
| 锁实现负对照 | `a1e4ce01`（集成检出） | `git stash push -- e2e/perf/lib/lock.mjs` → 跑 `scripts/perf/harness.test.ts` → `git stash pop` | 1（**预期**） | 精确变红：`expected 37000 to be 39260`（owner pid 是已死的脚本 pid，不是活进程），1 failed / 26 passed；还原后 27/27 绿 |
| fixture 命名空间负对照 | `ae641a4d`（集成检出） | `git stash push -- packages/ui/src/components/chat/__tests__/harness/main.tsx` → 跑同一测试 → `git stash pop` | 1（**预期**） | 精确变红：`expected [ 'perf/session-100', …(5) ] to not include 'perf/stream-long-reply'`，1 failed / 27 passed；还原后 28/28 绿 |
| 首屏预算门槛（本地） | `26e68f27` + 当前 master 的生产构建 | `npx vite build <worktree>` → `node scripts/perf/first-screen-budget.mjs` | 0 | 重建后的首屏 **3 626 123 B / 7 chunk**、entry **2 726 133 B**、总 JS 17 937 649 B / 339 chunk——与基线**逐字节一致**（entry 的 hash 变了，字节数没变） |
| 首屏预算门槛（负对照） | 同上 | 用更小的预算（2 000 000 B）跑同一个构建 | 1（**预期**） | `FAIL: the first screen grew to 3626123 bytes (3541 KB, +81.31%), over the budget of 2100000 bytes`；另外「没有基线」「没有构建」分别返回 1 与 2 |
| 首屏预算门槛（CI） | PR #404 `8b67dee4` | `gh pr checks 404` → `build` job | 0 | **CI 上真跑通了**：新加的 `First-screen JS budget` 步骤在 `electron:build` 之后执行并通过（这是本轮第一个机器无关的性能闸门） |
| 本地门禁 | `26e68f27`（集成检出，dirty：无） | `npm run typecheck:all` / `npm run architecture:check` | 0 / 0 | typecheck 全过（含 `eval:agent:core:check` 4/4）；架构检查 `OK — no new boundary violations` |
| PR #418 CI | `114a0ae8` | `gh pr checks 418` | 0 | architecture / build / typecheck / test / test scope **全绿**（architecture job 含 `bundle:verify`） |
| PR #418 独立复核（产物层） | `114a0ae8` | 读 `packages/ai/dist/index.js` + `worker-metafile.json` | — | 根入口对 SDK 只剩**动态 import**（`import('./api/anthropic-messages.js')`），`providers/adapters` 不在，`dist/clients.js` 存在——**不依赖 F 脚本的断言** |
| PR #418 独立复核（worker 输入集） | `114a0ae8` vs `dd890f38` | 对比两版 `worker-metafile.json` 的 inputs | — | 输入集 1949 → 1946，**只少** `providers/adapters.ts` / `api/bedrock-converse.ts` / `api/google-generative-ai.ts`；provider 注册表 `providers/*.ts` 从来不在 worker bundle 里 → 这 3 个是经桶文件顺带拖进来的死重，**无功能损失**；`api/anthropic-messages.ts` 仍在 → worker 仍能拿到 SDK |
| PR #418 预算棘轮（本地） | `114a0ae8` | `node scripts/perf/first-screen-budget.mjs --dist <worktree>\dist` | 0 | `firstScreen.bytes: 3378253 (baseline 3378253 / limit 3547166) +0%` → `OK` |
| PR #418 预算棘轮（负对照） | 同上 | 预算临时改 3000000 → 跑闸门 → 还原 | 1（**预期**） | `FAIL: the first screen grew to 3378253 bytes (3299 KB, +12.61%), over the budget of 3150000 bytes`；还原后 exit 0 |
| PR #418 bundle 新鲜度 | `065fa4aa` | `npm run bundle:verify` | 0 | `FRESH 0/918 bundle inputs changed after the bundle commit`——**提交顺序（源码 → bundle → 预算）是硬约束**：`bundle:verify` 按 git 历史判定，源码 commit 必须在 bundle commit 之前 |
| PR #422 布局负对照 | `c76ef6e5` | 把 `packages/ui/src/styles/workspace.css` 还原成改前状态 → 跑 `packages/ui/src/styles/__tests__/workspace-layout.test.ts` → 还原 | 1（**预期**） | 4 条用例全红并点名缺失属性；还原后 4/4 绿 |
| PR #422 布局实证 | `c76ef6e5`（真实 Electron + 生产构建 + 产品 IPC 播种 1000 条） | 读 `.app-workspace-row` / `.message-list-scroll` 的计算样式与尺寸 | 0 | 改前：row 高 115585 px、client=scroll=115187（**可滚动距离 0**）、末条消息在视口外 114k px；改后：row 高 818 px、client 694 / scroll 113260、末条消息 `visibleInViewport: true`、`dom.nodes` 11842 → 3437 |
| PR #422 门禁 | `c76ef6e5` | `npm run typecheck:all` / `npm run architecture:check` | 0 / 0 | `OK — no new boundary violations` |
| PR #429 锁负对照 | `9165ee74` | `vitest run scripts/perf/harness.test.ts` | 0 | 39/39 绿；假脚本记录的「会杀的 pid」是 `424242`（脚本自己的），**不是** `process.pid`；仓库内实现的 `pid === null`、`holderPid === process.pid` |
| PR #430 CI 路由 | `a4d55563` | `vitest run scripts/ci/test-scope.test.ts` | 0 | 40/40 绿（新增 3 个用例：按包映射、无测试的包退回全部、未知路径仍走 fail-closed `full`） |
| PR #431 信号预算 | `3222a7d6` | `vitest run scripts/perf/harness.test.ts` | 0 | 37/37 绿；`signalBudgetMs(100/1000/10000)` = 60000 / 60000 / 240000 |
| PR #429/#430/#431 CI | master `bd20f6aa` / `b31cd192` | `gh pr checks 429 430 431` | 0 | #429 五项全绿；#430 architecture + test + test scope 绿（typecheck/build 按 CI-only 变更跳过）；#431 五项全绿 |
| PR #421 CI | `8becf37c` | `gh pr checks 421` | 0 | architecture / build / test / test scope / typecheck **全绿** |
| 第四轮 before 权威重跑 | `73c22414`（master 在 #422 之前） | `node scripts/perf/run.mjs --scenarios session-switch --samples 3 --lock-mode strict --lock-wait-min 25 --agent mavis-before` | 0 | 9 样本零失败，`lock.held = true`、`skippedScenarios: []`；10k 三样本 open 73520–82073 ms / switch 76496–102274 ms，`dom.nodes` 115354、`longtask.total_ms` 93431、`mem.peakMB` 827.99 |
| 第四轮 after 权威重跑 | `8becf37c`（master + #422 + #421） | 同上（`--agent mavis-after`），本地另带 #431 的 harness 补丁（与 master 逐字节一致） | 0 | **9 样本零失败**（预算修好后 10k 三样本全部有效）；`dom.nodes` 569、`longtask.total_ms` 283–569、`mem.peakMB` 68–80、`cpu.renderer_pct` 3.09–5.81 |
| 第四轮快场景基线 | `8becf37c` | `node scripts/perf/run.mjs --scenarios startup,stream,typing,panels --samples 3 …` + `--scenarios gpu --samples 3` | 0 | 5 场景 18 样本零失败；startup typeable 1741 / dom 183；typing interact p50 25.75 / p95 32.30 / dom 557；panels dom 697；gpu 长任务 111 ms / CPU 5.04 % / `lost=1` 注入生效 |
| 第四轮数据路径探针 | `8becf37c` | `node docs-local/research/perf-harness/probe-rows.mjs --fixture perf/session-10000`（240 秒预算） | 0 | openMs 73077；`t_click → t_data` **73048 ms**、`data → dom` **0 ms**；switch 的 `getThreadIPC` 一段 **103691 ms**、总 109986 ms；CPU profile **97.4 % idle**；DOM `domNodes 569 / navDots 20 / rowCount 18 / scrollHeight 1334213 / clientHeight 694 / scrollTop 1333518` |
| 第四轮锁负对照（真实脚本） | `8becf37c` | `docs-local/research/perf-workspace-row/kill-probe.mjs` | 1（**预期**） | owner pid == probe 自己的 pid；release 之后 `SURVIVED` 永不打印 |
| PR #444 根因基准 | `c502ec67` 之前 | 真实 `createHostSessionApi` + 真实 `MessageLog`，1 万条消息 / 3.6 MB rollout | 0 | 分页读 50 页 **16672 ms** vs 一次投影 **314 ms**（**53×**） |
| PR #444 before 权威重跑 | 测量树 `8becf37c`（无 #444） | `node scripts/perf/run.mjs --scenarios session-switch --samples 3 --lock-mode strict --lock-wait-min 25 --agent mavis-r5-before` | 0 | **9 样本零失败**；10k open 29503–37160 ms / switch 46900–50755 ms；`dom.nodes` 569、`scrollHeight` 1327480、`commit.count` 42 |
| PR #444 after 权威重跑 | 同树 + #444 的 5 个产品文件 | 同上（`--agent mavis-r5-after`，随后 `--agent mavis-r5-after2` 用最终代码复核） | 0 | 两轮独立复核一致：10k open **1153/1364/1560** 与 1206/1382/1345；switch **1543/2148/1672** 与 1843/1686/1483 |
| PR #444 门禁 | `c502ec67` | `vitest run packages/host/tests/session-message-projection-count.test.ts packages/host/tests/session-messages-read.test.ts apps/desktop/src/main/ipc/__tests__/db-handlers.test.ts` | 0 | 55/55 绿（整读 = 1 次投影、分页 = 每页 1 次；`all=1` 携带 `limit`/`cursor` 报 400） |
| PR #444 更大范围测试 | `c502ec67` | `vitest run packages/host packages/agent-protocol apps/desktop/src/main/ipc` | 0 | **261 个测试文件 / 2801 用例全绿**，1 skipped |
| PR #444 本地门禁 | `00881770` | `npm run typecheck:all` / `npm run architecture:check` / `npm run bundle:verify` | 0 / 0 / 0 | `OK — no new boundary violations`；`FRESH 0/922 bundle inputs changed after the bundle commit` |
| PR #444 合并 master 后的产物 | `1461fdec` → `b1041f09` → `94d26831` → `7a6be1d4` → `b4468c68`（master 连续前进：#442 模型目录自动化、#443/#449 插件安装路径、#396 tok-speed） | `git merge origin/master` → 冲突只在 `packages/host/bundle/**` → `checkout --theirs` → `npm run bundle:worker` → 提交 | 0 | 每次都是 `FRESH`（929 → 932 个输入）。**上游自己也是这么合的**（master 上的提交就叫 "build(host): rebuild the worker bundle after the master merge"）。**源码 commit 必须早于 bundle commit**，`bundle:verify` 按 git 历史判定。**注意**：即使 merge 本身「干净」，产物也可能是两个 minified bundle 的手工合并结果 —— 仍要按合并后的源码重建一次 |
| PR #444 CI | `b4468c68` → `65fe8514`（owner 在本分支上合了一次 master） | `gh pr checks 444` | 0 | architecture / build / test / test scope / typecheck **五项全绿**（run `40088408963`）。第一次红的是 `test`：`packages/cli` 的 `/context` 用例硬编码了已被模型目录刷新改名的模型 id（见「发现与决策」），单独一个 commit 修掉；**同一修法已在 master 上**，所以本 PR 的净改动里已经没有它 |
| PR #444 合并 | `d26bec34`（owner 合并，2026-10-24 19:12） | 核对 master | 0 | master 的 `packages/host/src/session-api.ts` 已有 `readAllMessages`；两个门禁测试文件都在；master 的 `packages/host/bundle/worker-entry.js` 已含新逻辑（合并后重建过一次） |
| PR #458 实测 | `95fc82af`（`codex/perf-webpath`，基于 master `686f3c81`） | 真实 Host + 真实 BFF，1 万条消息，同一台机器同一个 rig，持共享锁 | 0 | 分页循环 **100 次请求 / 83 507 ms** vs 一次整读 **1 次请求 / 1 006 ms**（**83×**）；两边返回行数都是 10 000 |
| PR #458 门禁 | `95fc82af` | `vitest run packages/ui/src/lib/ipc-client.test.ts apps/web/tests/client/api.test.ts apps/web/tests/client/workspace.test.ts apps/web/tests/server/web-bff.test.ts` | 0 | **4 个文件 / 51 个用例全绿**；其中四条是「整读 = 1 次请求、分页 = 0 次」和 BFF 契约（`all=1` 携带 `limit`/`cursor`，或 `all` 值≠`1`，均 400） |
| PR #458 本地门禁 | `2d285d45` | `npm run typecheck:all` / `npm run architecture:check` / `npm run bundle:verify` | 0 / 0 / 0 | typecheck 全过（`typecheck-electron-gate: OK — no new type errors`）；架构 `OK — no new boundary violations`；产物 `FRESH 0/948 bundle inputs changed after the bundle commit` |
| PR #458 产物 | `95fc82af` → `2d285d45` | `npm run bundle:worker` → `git add packages/host/bundle` | 0 | 源码 commit 必须**早于**产物 commit（`bundle:verify` 按 git 历史判定）；产物只有 `worker-entry.js` 与 `worker-metafile.json` 变化（`packages/host/bundle/package.json` 与 `BashWorker.js` 只是行尾差异，git 归一化后不变） |
| PR #458 CI | `2d285d45` | `gh pr checks 458` | 0 | architecture / build / test / test scope / typecheck **五项全绿**（run `40096489541`） |
| 第七轮启动分解 | `perf-integration` 检出（临时主进程打点 + `docs-local/research/perf-startup/probe.mjs`） | 真实 Electron + 生产构建 + `file://` 预览，3 样本 | 0 | boot 230 ms / 主进程链 250 ms / **渲染器文档加载 ~900 ms** / 绘制 ~100 ms；主进程 bundle 的 V8 解析 48 ms |
| 第七轮字节 | `perf-startup`（master `f6120e04`） | `node scripts/perf/first-screen-budget.mjs --dist dist` | 0 | 首屏 3 470 634 → **2 985 017 B**（−485 617 B，−14.00 %）；入口 chunk 2 570 644 → 2 085 027 B；chunk 数 7 → 7 |
| 第七轮墙钟 A-B-A | 同上，同一台机器，同一天 | 分解探针量「导航开始 → 首屏绘制」，before 7 + after 7 + after 7 样本 | 0 | before 中位 844 / 均值 856；after 合并 14 样本中位 **810** / 均值 **820** ⇒ **约 −35 ms，落在噪声内** |
| 第七轮门禁 | `perf-startup` | `vitest run packages/ui/src/components/layout/panels/registry.test.tsx` | 0 / 1（**预期**） | 2/2 绿；负对照（改回静态引入）2 个用例全红 |
| 第七轮真机验证 | `perf-startup`（改后构建） | `node scripts/perf/run.mjs --scenarios panels --samples 2 …` | 0 | 2 个样本都是 `files:opened, terminal:opened, browser:opened`——懒加载的终端在真实 Electron 里正常打开 |
| 第八轮冷/热对照 | `perf-coldstart`（master `12ede3a1`，生产构建 + `file://` 预览） | `docs-local/research/perf-coldstart/probe3.mjs`（渲染器自己的 `performance.timeOrigin`） | 0 | 冷启四段：导航→HTML **700–980 ms** / HTML→DCL **275–370 ms** / DCL→首绘 3–133 ms；同进程 reload 对照 **2–6 ms** / 99–177 ms ⇒ 冷启 1.4 s 里约 **1.07 s 是 Chromium 自己的热身** |
| 第八轮假设证伪 A/B | 同上 | 四条修法各一次 A/B（代码卡在 `docs-local/research/perf-coldstart/*.patch`，**均未合入**） | 0 | 预热 network service：navToRequest 中位 816 vs 基线 ~710 ms；提前建窗口：**1 642 vs 1 610 ms**（`app.getAppMetrics` 证明 Chromium 直到导航才起渲染器进程）；延后 `getGPUFeatureStatus`：链长 233 vs 388 ms；延后启动期网络 I/O：firstPaint 1 460 vs 1 424 ms |
| 第八轮 code cache 核查 | 同上 | 读 profile 目录 `Code Cache/js` + 同 userData 二次启动对照 | 0 | **页面脚本没有 code cache**（只有 index；preload 有 78 KB）；热 profile 中位 796 ms **不慢于**冷 profile 中位 960 ms ⇒ Claude 的预编译 code cache 在 Duya 渲染器上没有落点 |
| 第八轮字节归因 | `perf-coldstart` | `npx vite build --sourcemap` + `docs-local/research/perf-coldstart/chunk-attribution.mjs` 逐字节 mapping | 0 | 入口 chunk 2 570 686 B 归因 2 514 077 B：xterm+addon **~490 KB** / katex **260 372 B** / i18n 中英 **270 496 B** / `stream-session-manager` 74 390 B / dnd-kit+tailwind-merge+zod+模型目录 ~180 KB |
| 第八轮门禁 | `perf-coldstart` | `vitest run scripts/perf/harness.test.ts` | 0 | **45/45 绿**（新增 5 个相位用例：分段正确 / 没有导航条目时全为 null 而不是 0 / 没绘制时绘制段为 null / 里程碑没发生时不报负数 / 指标命名）；负对照（改错 `htmlToDcl` 算法）即红 |
| 第八轮本地门禁 | `perf-coldstart` | `npm run typecheck:all` / `npm run architecture:check` | 0 / 0 | typecheck 全过（`typecheck-electron-gate: OK — no new type errors`）；架构 `OK — no new boundary violations` |

## 接续 / 结果

第一轮已完成并全部合并。集成者：mavis。合并顺序 A → B/C/D/E，合并后由集成者**串行**重跑 Profile 出权威数字，再出下一轮机会清单。

已合并：#382 `766db972`（计划）、#383 `d9eb7dba`（fixture + 测量锁契约）、#386 `8721dc75`（A harness）、#385 `8492dbd9`（B 流式渲染）、#391 `f617e4c1`（D GPU 观测）、#400 `8d69d81a`（C hydrate + 侧栏）、#401 `7063a47f`（E 懒加载）、#392 `18a144e8`（集成台账 + A 的 8 个 harness 修复 + 权威基线）、#418 `aed0d13c`（首屏依赖闭包）、#421 `7e5f3d5e`（万条消息虚拟化）、#422 `c76ef6e5`（布局缺陷修复）、#429 `dead6e4d`（harness 锁自杀）、#430 `bd20f6aa`（CI 路由）、#431 `b31cd192`（harness 信号预算）、**#444 `d26bec34`（Host 整读，10k 打开 35.2 s → 1.4 s、切换 47.7 s → 1.7 s，含投影次数门禁）**。
未合并：**#458**（第六轮：Web 侧整读，83×）——已合入 master `697a8758` 并重建产物，等授权合并。**#473**（第七轮：终端离开首屏，首屏 −14.00 %）与 **#459**（第六/七轮文档）**已由 owner 合并**（`eb367799` / `f5561c17`）。#389 由 owner 合并，但它只带 622 系列的交接说明，**没有归档本计划**（见「集成记录」）。

回收：`perf-harness` / `perf-streaming` / `perf-state` / `perf-gpu` / `perf-ui-arch` 五个检出的成果已合并，回收后删检出、**保留分支**（A 的原始 8 个提交引用不丢）。`perf-ui-arch` 的测量证据已复制到集成检出的 `docs-local/research/perf-agent-e/`。`perf-integration` 是集成检出，保留。第四轮又删了两个已被 master 覆盖的远端分支（`codex/perf-harness`、`codex/perf-lock-owner-pid`）——逐文件核对过，它们触及的每一个路径在 master 上都存在且更新。

第二轮已开工：Agent F（`perf-bundle`，首屏 SDK）与 Agent G（`perf-virtual`，万条消息虚拟化）并行，见「第二轮」章节。

第二轮集成者侧已合并：**#406** 锁（两种实现互相拆台）、**#407** fixture 命名空间、**#408** 首屏字节预算进 CI、**#409** 带围栏契约 fixture、**#410** 第二轮章程、**#412** #391 留下的 IPC 注册回归、**#415** 第二轮集成记录、**#418** 首屏依赖闭包（模块数归零 + 预算棘轮，master `aed0d13c`）、**#421** 万条消息虚拟化、**#422** 布局缺陷修复、**#429 / #430 / #431** harness 的三个 P0。

下一步（第七轮之后，按新的机会清单）：**#0 启动的冷路径**——先做对照实验，证明「冷启动比 reload 多出来的那一秒」是不是 `file://` 没有 V8 code cache 造成的，别急着改；**#1 整条历史一次性投递的代价**——长任务 0.3 → 0.5 s、内存峰值 +33 MB，需要分块投递 / 增量渲染，别让主线程被一次性占用。

**这一轮最重要的产出不是某个 PR，而是把「万条会话 30–45 秒」的靶子从渲染换到了数据路径**：基线的 `session.open.longtask.total_ms` 只有 0.7 秒，而 open 要 32–37 秒；G 的虚拟化把 switch 的主线程成本压掉 92 %，墙钟一动不动。**下一轮该测的是数据路径（主进程 / DB / IPC），不是继续抠渲染。**

第五轮把这条线索走完了：**根因是 Host 每翻一页就重投影整条历史，50 页 = 50 次全量投影**；修法是 Host 提供一次整读，Desktop 桥接只调一次。10 000 条消息的打开从 **35.2 秒降到 1.4 秒**、切换从 **47.7 秒降到 1.7 秒**，同一份历史、同样的 `dom.nodes`、同样的 `commit.count`——变的只是数据怎么到渲染器。**并且这次不只修了它，还给它装了一道门禁**（数投影次数，纯计数、机器无关），下次谁把每页全量投影改回来，CI 直接红。

第六轮把同一条根因的**第二条路径**也走完了：Web 侧（`UiServices` → BFF → Host）同样在分页读同一个 Host 接口，而 BFF 每页上限 100，所以 1 万条要翻 **100 页**。真实 Host + 真实 BFF 实测：**100 次请求 83 507 ms → 1 次请求 1 006 ms（83×）**。修法和第五轮一样是「一次整读」，同样配了机器无关的门禁——这次数的是**请求次数**（整读 1 次、分页 0 次）。**教训**：找到 O(n²) 的读路径后，先把 Desktop / Web / CLI / TUI 的调用点一次列全；只修最慢的那条，是把同一个坑留给下一个人。

第七轮换了个方向：前面六轮都在做「减法」（少渲染、少请求），这一轮先做**测量**——把唯一 0 % 改善的启动拆成四段，结果**推翻了读代码得出的结论**（主进程那 10 个 `await` 一共只有 200 ms），也**推翻了一个想当然的修法**（Claude 的 V8 code cache 在主进程上只值 48 ms，不值得做）。真正改掉的是「点进去才到」的终端被静态引进首屏：**−485 617 B（−14.00 %）**，字节门禁棘轮到 2 985 017 B。**但墙钟只换来约 35 ms**——于是本轮最值钱的产出不是那个 PR，而是那个**兑换率（≈0.07 ms/KB）**：它说明剩下的 2.99 MB 首屏最多再值 200 ms，**下一轮该打的是冷启动本身，不是字节**。


