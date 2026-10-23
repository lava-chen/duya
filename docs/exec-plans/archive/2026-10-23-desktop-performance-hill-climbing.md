# Duya Desktop 性能爬坡

状态：**移交（未完成）** · 原负责人：mavis（goal `tg_1cyt7y0er7mvkwyms8`）· 更新：2026-10-23
原分支：`codex/perf-integration` · 原 worktree：`.claude/worktrees/perf-integration`（Windows）· base：`670a862c`

> **交接说明（2026-10-23，owner 指示）**
>
> Desktop UI 性能与 TUI 性能这两项任务**不再由 mavis 负责**，本计划撤出活动队列、移入归档。
> **这不是「完成」**：验收从未重新跑过，五条独占路径没有认领记录，也没有任何按路径落地的 PR。
>
> | 项 | 实际状态（2026-10-23 核对） |
> | --- | --- |
> | 计划与 PR | PR #382 → `766db972` 已合并；PR #383 → `d9eb7dba` **只含 perf fixture 与测量锁的文档**，**不含任何性能收益 PR** |
> | A 的 Harness v1 | **未落地**：`scripts/perf/**` 与 `e2e/perf/**` 在 master 上都不存在 |
> | B/C/D/E 基线 | **未产出**：五条独占路径没有认领记录，也没有任何按路径落地的 PR |
> | 测量互斥锁 | `E:\Projects\duya\.claude\perf-bench-lock.mjs`（gitignore 区，不进仓库）。计划在**另一台 Windows 机器**上推进，本机（macOS）没有那 6 个检出 |
> | 可复用资产 | 正文的「指标契约」与「固定 fixture」两节**可复用**；接手时先读这两节 |
> | TUI 侧 | 基准 harness 已在 [615](../active/615-cli-unified-tui-engine.md) Phase 0 落地（`packages/cli/src/tui/__tests__/perf/`）；真实链路基准在 `origin/codex/tui-perf-benchmark`（**未并入 master**，且不属本计划分支） |
>
> 下文保留原计划全文作为交接依据；「进度」一节的 checkbox **未重新验收**，按原样记录。

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
- [ ] A 交付 Harness v1，其它 agent 用它取证
- [ ] B/C/D/E 各自建立基线 → 定位瓶颈 → 一个 PR 一个问题
- [ ] 集成者按 CI + 证据定合并顺序，合并后重跑 Profile
- [ ] 产出按实测收益排序的下一轮机会清单

派工状态（2026-10-23 核对）：**A–E 五条路径均未认领落地产出**。原文记的是「A/B/C/D 已开工（并发上限 4），E 待空位」，该状态在移交时**已失效**——见文首交接说明。

## 发现与决策

- 本 harness 没有 managed worktree 工具，按 `docs/development/worktree.md` 第 1 节手工建 linked worktree；6 个检出均已用 `scripts/junction-worktree.mjs` 配好依赖覆盖层。
- 基准不能复用 3000 端口：`dev-detector` 只探 3000–3005，命中的是别的 worktree 的 vite，量到的不是被测代码。走 preview 模式或显式端口。
- 目标文件规模：`App.tsx` 1192、`ChatView.tsx` 1366、`conversation-store.ts` 1694、`MessageList.tsx` 1209、`MessageInput.tsx` 2356 行。规模不是证据，先 Profile 再动手。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `670a862c` clean | Windows / Node | `git worktree add` × 6 | 0 | `git worktree list` 6 项 perf-* |
| `670a862c` clean | Windows / Node | `node scripts/junction-worktree.mjs . --primary` | 0 | 每检出 56 个链接，`node_modules/.bin` 可用 |

## 接续 / 结果

**已移交（2026-10-23）**：Desktop UI 性能与 TUI 性能两项任务不再由 mavis 负责。集成者：待认领。

回收：本机（macOS）没有本计划的检出，无可回收物。原 Windows 机器上的 6 个检出**由该机器的 owner 自行核对**，本仓不代为删除、不代为强制清理。

下一步（交给接手方）：先认领「指标契约」与「固定 fixture」两节是否仍适用，再按 A → B/C/D/E 的顺序开工——**A 的 Harness v1 是其余四条路径的取证前提**，没有它，B/C/D/E 的数字无法横向比较。
