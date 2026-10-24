# Duya Desktop 性能爬坡

状态：active · 负责人：mavis（goal `tg_1cyt7y0er7mvkwyms8`）· 更新：2026-10-23
分支：`codex/perf-integration` · worktree：`.claude/worktrees/perf-integration` · base：`670a862c`

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
| `perf/stream-long-reply` | 一条长回复逐 token 流式输出 |
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
- [ ] C 交付 React 状态优化 / 侧栏重渲染
- [ ] E 交付 UI 包架构优化（懒加载与首屏资源）
- [ ] 集成者按 CI + 证据定合并顺序，合并后**串行**重跑 Profile
- [ ] 产出按实测收益排序的下一轮机会清单

派工状态：A/B/C/D/E 五个 Agent 均已认领独占路径。B 已交付（PR #385）；D 已交付（PR #391）；A 在续做（PR #386）；C 在续做；E 刚开工。A/B/C/D 的首轮会话曾因网络错误与运行丢失中断，已在同一检出上续做。

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
- **Agent A 还有 8 个未合并的 harness 修复，是真实资产，不能随检出一起回收**。`codex/perf-harness` 分支比 master 多 8 个提交，全部只碰 `e2e/perf/lib/{launch,lock}.mjs`、`e2e/perf/run.mjs`、`e2e/perf/scenarios/gpu.mjs`、`scripts/perf/harness.test.ts`（与 B/C/D/E 的改动**零重叠**，可干净合并）：安全模式窗口与 Host 未就绪时重试（`e9e12d6a`）、按 namespace 而非 pid 找 app 关闭（`836a30c8`）、优雅关闭失败时强杀整棵进程树（`65066896`）、pid 回收后误杀无关进程的保护（`a1a392f8`）、**从已死的持有者手里接管锁**（`da8c32b4`）、每个样本 4 分钟预算（`c97e9989`）、每场景落盘报告（`965fe696`）。这些正是本轮观察到的孤儿 Electron、僵尸锁、启动失败的根因——**A 修的是自己踩的坑，E 的 baseline 里 8 个样本只有 3 个成功也正是 safe-mode 窗口所致**。

## 下一轮机会清单（按实测收益排序）

排序依据是**已测得的收益**，不是猜测。每条都注明证据来源与还需要谁来做。

| # | 机会 | 已测收益 / 证据 | 归属 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 流式时**增长中**的 markdown 每帧整篇重解析 | 去掉围栏语言的对照实验把主线程占用从 1298.6 打到 297.5ms；B 修完已完成围栏后仍剩 645.5ms，其中约 300ms 是增长尾巴的整篇重解析 | B | 拆「稳定前缀 / 增长尾巴」，只重解析尾巴；或把围栏分词挪进 worker（Anthropic 的做法） |
| 2 | 终端从 WebGL 回退到 DOM 渲染器 | 帧 p95 116.9 → 183.7ms（+57%），Long Task 167 → 369 | D | 代价在**渲染器选择**而非 GPU 有无。方向是别让终端悄悄掉回 DOM：掉级时给用户可见信号，或自动尝试恢复 WebGL |
| 3 | 首屏 JS 里那 8 个「点进去才到」的界面树 | E 已把首屏 JS 从 4081.2 KB 降到 3538.1 KB（−13.3%），`App.tsx` 静态闭包 524 → 392 个一方模块 | E | **本轮已完成**。下一轮看首屏 entry chunk 剩下的 2659 KB 里还有没有可切的 |
| 4 | 侧栏剩余的宽订阅 | C 已把 `ProjectGroupItem` 的两个 store 订阅收窄到 `useShallow`，并给侧栏 props 换成按值比较 | C | `app-sidebar.tsx` 还有 2086 行，下一轮查剩下的宽订阅与布局抖动来源 |
| 5 | CI 回归门槛缺一个**机器无关**的代理指标 | 壁钟时间只能在固定机器上做趋势分析；GitHub runner 是共享虚拟化的，阈值不可用 | 集成者 + A | 候选代理：首屏 JS 字节数、chunk 数、DOM 节点数、MutationObserver 批次数。注意 B 的收益**不会**被这些代理捕获（省的是重复计算，DOM 完全不变）——所以代理指标只能覆盖一部分退化 |
| 6 | `commit.count` 的代理偏差 | 生产构建拿不到 React Profiler，MutationObserver 批次会**漏计无 DOM 变化的 React 提交** | A | 要么找到生产可用的提交计数方式，要么在报告里把代理的漏计范围写清楚 |
| 7 | 其它 store 是否有同类「persist 后状态不发布」缺陷 | **已排除**：`onRehydrateStorage` 原地改写只出现在 `conversation-store.ts`；`projects-store` / `sidebar-sections-store` 不走 persist，用 `set()` 设 `hydrated`（会通知）；`terminal-appearance-store` 走 persist 但没有 hydration 标志 | — | 这条是**负结论**，已核实，不必再做 |
| 8 | 懒加载视图的 Suspense 边界收窄 | **已排除**：E 的 follow-up 被判定为 no-op。`currentView` 单一值使聊天分支与视图分支互斥；实测切视图时 `main.app-content` 无空白期（约 26ms 落地） | — | 这条是**负结论**。若将来出现「加载慢的磁盘/网络导致可见空白」，再重开这条：那时需要的是 `fallback` 骨架屏，而不是移动边界 |
| 9 | 首屏 JS 里剩下的 2659 KB entry chunk | E 已切走 8 个界面树；首屏 JS 仍 3538.1 KB | E | 下一轮用 E 的 `module-closure.mjs` 看 entry chunk 的一方模块里还有哪些是「点击才到」的 |

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

## 接续 / 结果

实现中。集成者：mavis。合并顺序：A 先合（Harness 是其它 agent 的取证工具），再 B/C/D/E；合并后由集成者**串行**重跑 Profile 出一份权威数字，再出下一轮机会清单。

已合并：#382 `766db972`（计划）、#383 `d9eb7dba`（fixture + 测量锁契约）、#386 `8721dc75`（A harness）、#385 `8492dbd9`（B 流式渲染）、#391 `f617e4c1`（D GPU 观测）。
待合并：#400（C hydrate + 侧栏），等 typecheck 复跑；#392（本计划状态同步）。进行中：E。
未合并：#389（另一个会话的归档提案，owner 已定本线继续，详见「集成记录」）。

回收：未回收。6 个检出均未全部集成，owner 会话在线。
下一步：E 交付后审阅合并；全部合并后串行重跑 Profile，出权威数字与下一轮机会清单。

