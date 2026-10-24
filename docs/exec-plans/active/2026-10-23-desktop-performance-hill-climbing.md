# Duya Desktop 性能爬坡

状态：active · 负责人：mavis（goal `tg_1cyt7y0er7mvkwyms8`）· 更新：2026-10-24
分支：`codex/perf-lock-owner-pid`（本分支）/ 集成分支 `codex/perf-integration` · worktree：`.claude/worktrees/perf-integration` · base：`18a144e8`

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
- [ ] 第二轮：#0 首屏 SDK 移出 entry chunk（Agent F）
- [ ] 第二轮：#1 万条消息行虚拟化（Agent G）
- [ ] 第二轮：合并后串行重跑，更新权威基线

派工状态：A/B/C/D/E 五个 Agent 均已认领独占路径。B 已交付（PR #385）；D 已交付（PR #391）；A 在续做（PR #386）；C 在续做；E 刚开工。A/B/C/D 的首轮会话曾因网络错误与运行丢失中断，已在同一检出上续做。

## 第二轮（进行中）

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

## 集成记录

| PR | Agent | 内容 | 状态 |
| --- | --- | --- | --- |
| #386 | A | 真实 Electron 性能 Harness（`e2e/perf/**`、`scripts/perf/**`） | **已合并** `8721dc75` |
| #385 | B | 流式渲染：`CodeBlock` memo 化，停止重高亮已完成代码围栏 | **已合并** `8492dbd9` |
| #391 | D | GPU 观测：合成状态 + WebGL Context Lost 观测通道 | **已合并** `f617e4c1` |
| #400 | C | zustand hydrate 归一化搬进 `merge` + 侧栏订阅收窄 | **已合并** `8d69d81a` |
| #401 | E | 8 个「点进去才到」的界面树改 `React.lazy` | **已合并** `7063a47f` |

合并顺序（A → B/C/D/E），合并后由集成者**串行**重跑 Profile 出一份权威数字。

PR #389（另一个会话，`codex/plan-perf-handoff`）提出把本计划归档、声称「Desktop UI 性能与 TUI 性能不再由 mavis 负责」。**不合并**：它的前提（只查 `master`）与实际不符——#385/#386/#391 已存在且带实测数据；owner 已确认本线继续由 mavis 推进。已在该 PR 下留事实更正评论。

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
- **两种锁实现会互相拆台（第二轮发现，已修）**。仓库内实现 `e2e/perf/lib/lock.mjs` 有一条正确的规则：**持有者进程没了 = 持有者崩了 = 锁可以接管**（`da8c32b4` 加的，否则崩掉的 Agent 会把整轮卡 30 分钟）。但外部脚本 `E:\Projects\duya\.claude\perf-bench-lock.mjs` 的 `acquire` 把自己那个**一秒后就退出的 pid** 写进 `owner.json` —— 于是仓库内实现一看到「pid 已死」就立刻抢走锁，**脚本驱动的 Agent 和仓库内驱动的 Agent 会同时测量**，两边的数字量到的都是争抢。修法两侧对称：仓库内实现走脚本 acquire 成功后用 `claimOwnerPid()` 把 owner 文件改写成**自己**的活 pid；外部脚本改为记一个**哨兵进程**的 pid（`detached` 起、release 时杀、自己最多活 90 分钟）——因为脚本是一次性 CLI，自己和调用它的 shell 的 pid 都会随命令结束而死，只有哨兵能真正代表「有人正持着锁」。回归测试在 `scripts/perf/harness.test.ts`，负对照：回退修复后该用例精确变红（owner pid 是已死的 37000 而不是活进程 39260）。**实测**：修完之后 `acquire` 的那个 shell 退出 3 秒，哨兵仍活；`release` 之后哨兵消失。
- **锁的「30 分钟即失效」是按年龄判的，不是按持有者判的**。脚本只看 `acquiredAt` 的年龄，**不看 pid 活不活**。所以一次「构建 + 测量」如果跨过 30 分钟，别人会直接 `[perf-lock] stale lock, stealing it` 抢走它，两个人同时测。**How to apply**：单次持锁控制在 25 分钟内；长测量分段做，每段之间 release → acquire 交接；报告里写明每个数字是否在持锁状态下取得。
- **PR #391 的 GPU 通道注册是真实回归，不是闸门误报（已修，PR #412）**。#391 用常量 `ipcMain.handle(GPU_STATUS_CHANNEL, ...)` 注册，**运行时 handler 确实注册了**，但 IPC 契约闸门是**源码扫描**——扫的是字面量形式的 `ipcMain.handle('...')`，看不见常量，于是任何跑全量测试的 PR 都会变红。修法是改回**字面量**（与仓库其余 handler 一致）+ 加单测把常量与字面量绑定，防止再次漂移。负对照：回退修复后精确复现 CI 原报错（2 failed），还原后 3 文件 27/27 绿。**教训**：闸门是源码扫描而非运行时反射时，「代码能跑」不等于「闸门能看见」——改注册形式前先看闸门怎么找。
- **CI 的 push 触发器跳过 test job**。所以 **master 绿 ≠ 没问题**：master 上可能带着某个 PR 的红，绿灯只说明「那次 push 没跑 test」。判断某 PR 是否真跑到了那些测试，必须看**该 PR head 的 test job**，不能看 master 的绿。同理，`test scope` 那个 job 绿只代表改动文件范围的 lint/format，不代表全量测试跑过。


## 权威基线（合并后串行重跑，master + A 的 harness 修复）

命令：`node scripts/perf/run.mjs --samples 3 --agent mavis-reprofile --lock-mode strict --lock-wait-min 25`
环境：Intel Core i5-14600KF / 31.8 GB / Node v24.16.0 / Windows 10.0.26200 x64 / Electron 44.2.0 / Chromium 152.0.7977.76 / 生产构建（`file://` 预览模式，非 dev server）
SHA：`ed3882de`（`codex/perf-integration`）/ 锁：`held: true`，`skippedScenarios: []`（**全程持锁，无一个场景被跳过或无锁测量**）/ 用时 31.2 分钟 / **6 场景 33 样本，零失败**

| 场景 | 关键指标（p50） | 说明 |
| --- | --- | --- |
| startup | `startup.typeable_ms` **1632**（CV 2.28%）、`startup.firstPaint_ms` 1468.2（3.53%）、`dom.nodes` 183（0%）、`commit.count` 4（0%）、`longtask.total_ms` 76（18.17%） | 首屏 DOM 只有 183 个节点，提交数 4 |
| session-switch | `session.open_ms` 610 / `session.switch_ms` 806（**跨 3 个 fixture 合并统计，CV 137%**——因为 10000 条把分布拉成三个簇） | 分 fixture 看：100 条 open 197–225ms；1000 条 549–670ms；**10000 条 32154–37054ms** |
| session-switch（10000 条） | `dom.nodes` **115354**、`dom.mutations` 11976、`longtask.total_ms` **14958**、`mem.peakMB` 430.32、`mem.growthMB` 394.57、`scroll.frame.p95_ms` **1017.6** | 10 万个 DOM 节点 + 每次切换近 15 秒长任务 |
| stream | `stream.block_ms_total` **0**、`longtask.count` 0、`frame.p95_ms` 16.8（0%）、`commit.count` 9（5.44%）、`dom.nodes` 376（0.27%）、`stream.frames` 1568 | **零阻塞是真的**——共享 fixture 无代码围栏（见「发现与决策」） |
| typing | `interact.p50_ms` **25.6**（CV 0.49%）、`interact.p95_ms` **32.2**（0.15%）、`frame.p95_ms` 16.8（0.28%）、`dom.nodes` 1378（0%）、`commit.count` 1 | 输入延迟最稳的一组，是最可靠的 CI 候选来源 |
| panels | 3 个面板打开 298–438ms、`frame.p95_ms` 16.8（0%）、`dom.nodes` 1533（0%）、`longtask.total_ms` 56（22.31%） | |
| gpu | `cpu.renderer_pct` **99.4**（CV 0.12%）、`longtask.count` **305**、`longtask.total_ms` **37230**、`frame.p95_ms` 183.5（4.27%） | 三种 GPU 状态（normal / unavailable / context-lost）合并；`webgl-context-lost` 三样本都观测到 `lost=1`，**注入真实生效** |

### 可进 CI 的代理指标（低噪声，机器无关）

按本轮实测的 CV，**只有这些够稳**：typing 的 `interact.p95_ms`（0.15%）、`interact.p50_ms`（0.49%）、`frame.p95_ms`（0.28%）；stream 的 `dom.nodes`（0.27%）、`dom.mutations`（1.84%）；startup 的 `dom.nodes`/`commit.count`（0%）、`startup.typeable_ms`（2.28%）；gpu 的 `longtask.total_ms`（1.63%）、`longtask.count`（2.65%）、`cpu.renderer_pct`（0.12%）；session-switch 的 `session.open.commit.count`（5.05%）。

**仍然不能进 CI 的**：任何跨 fixture 合并的 session-switch 壁钟时间（CV 137%，因为 10000 条是另一个数量级）；`stream.block_ms_total`（恒为 0，没有区分度）。**注意 B 的收益不会被这些代理捕获**——它省的是重复计算，DOM 与提交数完全不变。

## 下一轮机会清单（按实测收益排序）

排序依据是**已测得的收益**，不是猜测。每条都注明证据来源与还需要谁来做。

| # | 机会 | 已测收益 / 证据 | 归属 | 备注 |
| --- | --- | --- | --- | --- |
| 0 | **首屏 entry chunk 里还拖着 `openai` 141 个模块 + `@anthropic-ai/sdk` 69 个模块** | E 实测发现：懒加载切走 8 个界面树后，首屏 entry chunk 仍静态含 `openai` 141 + `@anthropic-ai/sdk` 69 + `@lobehub/icons` 36 个三方模块。根因已核实：`packages/ai/src/index.ts` 这个**桶文件同时导出纯函数与 SDK 客户端**——`findModelById` / `computeContextEstimate` / `resolveContextWindow`（纯函数，首屏需要）与 `createAnthropicClient` / `createOpenAICompletionsClient`（SDK，首屏不需要）。首屏急切引用 `@duya/ai` 的点：`components/chat/ChatView.tsx:27`、`components/chat/MessageInput.tsx:57`、`hooks/useContextUsage.ts:18` | 需跨 Agent 边界（`packages/ai/**` + `packages/ui/src/lib/**` 不在 E 的独占范围） | **下一轮最有潜力的一条**：这两个 SDK 根本不是首屏需要的。修法是把桶文件拆成 `@duya/ai`（纯函数）+ `@duya/ai/clients`（SDK），首屏只引前者；或把 SDK 客户端改成动态 import |
| 1 | **10000 条消息的会话打开/切换是 30–40 秒量级的卡顿** | 合并后串行重跑实测：100 条 open 197–225ms / switch 189–257ms；1000 条 open 549–670ms / switch 771–876ms；**10000 条 open 32154–37054ms / switch 37685–40668ms**，滚动帧 p95 **1000.8–1000.9ms**（60fps 完全丢帧） | B | 根因已定位：`MessageList.tsx:1254` 的 `groupedMessages.map(...)` **为每条消息都创建 React 组件实例 + IntersectionObserver + DOM 节点**（`LazyMessageRow` 只是让**内容**惰性，`content-visibility: auto` 并没有省掉组件与 observer 的创建）。10000 条 = 10000 个 observer。方向：真正的行虚拟化（只对可视区 ± overscan 挂载行），或把 observer 换成单一容器级测量 |
| 2 | 流式时**增长中**的 markdown 每帧整篇重解析 | 去掉围栏语言的对照实验把主线程占用从 1298.6 打到 297.5ms；B 修完已完成围栏后仍剩 645.5ms，其中约 300ms 是增长尾巴的整篇重解析 | B | 拆「稳定前缀 / 增长尾巴」，只重解析尾巴；或把围栏分词挪进 worker（Anthropic 的做法）。**前置已解除（第二轮）**：共享 harness 新增契约 id `perf/stream-long-reply-fenced`（同尺寸、同节奏、同词表，正文里混了 ts/python/bash 三个围栏，围栏标记故意被切碎在 chunk 里），所以共享 harness 现在**能测出围栏高亮的开销**——原来 `stream.block_ms_total = 0` 只是因为没有围栏 |
| 3 | 终端从 WebGL 回退到 DOM 渲染器 | 帧 p95 116.9 → 183.7ms（+57%），Long Task 167 → 369 | D | 代价在**渲染器选择**而非 GPU 有无。方向是别让终端悄悄掉回 DOM：掉级时给用户可见信号，或自动尝试恢复 WebGL |
| 4 | 首屏 JS 里那 8 个「点进去才到」的界面树 | E 已把首屏 JS 从 4081.2 KB 降到 3538.1 KB（−13.3%），`App.tsx` 静态闭包 524 → 392 个一方模块 | E | **本轮已完成**。下一轮看首屏 entry chunk 剩下的 2659 KB 里还有没有可切的 |
| 5 | 侧栏剩余的宽订阅 | C 已把 `ProjectGroupItem` 的两个 store 订阅收窄到 `useShallow`，并给侧栏 props 换成按值比较 | C | `app-sidebar.tsx` 还有 2086 行，下一轮查剩下的宽订阅与布局抖动来源 |
| 6 | CI 回归门槛缺一个**机器无关**的代理指标 | 壁钟时间只能在固定机器上做趋势分析；GitHub runner 是共享虚拟化的，阈值不可用 | 集成者 + A | 候选代理：首屏 JS 字节数、chunk 数、DOM 节点数、MutationObserver 批次数。注意 B 的收益**不会**被这些代理捕获（省的是重复计算，DOM 完全不变）——所以代理指标只能覆盖一部分退化 |
| 7 | `commit.count` 的代理偏差 | 生产构建拿不到 React Profiler，MutationObserver 批次会**漏计无 DOM 变化的 React 提交** | A | 要么找到生产可用的提交计数方式，要么在报告里把代理的漏计范围写清楚 |
| 8 | 其它 store 是否有同类「persist 后状态不发布」缺陷 | **已排除**：`onRehydrateStorage` 原地改写只出现在 `conversation-store.ts`；`projects-store` / `sidebar-sections-store` 不走 persist，用 `set()` 设 `hydrated`（会通知）；`terminal-appearance-store` 走 persist 但没有 hydration 标志 | — | 这条是**负结论**，已核实，不必再做 |
| 9 | 懒加载视图的 Suspense 边界收窄 | **已排除**：E 的 follow-up 被判定为 no-op。`currentView` 单一值使聊天分支与视图分支互斥；实测切视图时 `main.app-content` 无空白期（约 26ms 落地） | — | 这条是**负结论**。若将来出现「加载慢的磁盘/网络导致可见空白」，再重开这条：那时需要的是 `fallback` 骨架屏，而不是移动边界 |
| 10 | 首屏 JS 里剩下的 2659 KB entry chunk | E 已切走 8 个界面树；首屏 JS 仍 3538.1 KB | E | 下一轮用 E 的 `module-closure.mjs` 看 entry chunk 的一方模块里还有哪些是「点击才到」的 |

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

## 接续 / 结果

第一轮已完成并全部合并。集成者：mavis。合并顺序 A → B/C/D/E，合并后由集成者**串行**重跑 Profile 出权威数字，再出下一轮机会清单。

已合并：#382 `766db972`（计划）、#383 `d9eb7dba`（fixture + 测量锁契约）、#386 `8721dc75`（A harness）、#385 `8492dbd9`（B 流式渲染）、#391 `f617e4c1`（D GPU 观测）、#400 `8d69d81a`（C hydrate + 侧栏）、#401 `7063a47f`（E 懒加载）、#392 `18a144e8`（集成台账 + A 的 8 个 harness 修复 + 权威基线）。
未合并：#389（另一个会话的归档提案，owner 已定本线继续，详见「集成记录」）。

回收：`perf-harness` / `perf-streaming` / `perf-state` / `perf-gpu` / `perf-ui-arch` 五个检出的成果已合并，回收后删检出、**保留分支**（A 的原始 8 个提交引用不丢）。`perf-ui-arch` 的测量证据已复制到集成检出的 `docs-local/research/perf-agent-e/`。`perf-integration` 是集成检出，保留。

第二轮已开工：Agent F（`perf-bundle`，#0 首屏 SDK）与 Agent G（`perf-virtual`，#1 万条消息虚拟化）并行，见「第二轮」章节。

下一步：等 F / G 的 PR → 独立验证（负对照 + 门禁）→ 按证据定合并顺序 → 合并后**持锁串行**重跑 Profile，刷新权威基线与机会清单。


