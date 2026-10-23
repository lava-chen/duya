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
| #386 | A | 真实 Electron 性能 Harness（`e2e/perf/**`、`scripts/perf/**`） | CI 全绿，待续做收尾后合 |
| #385 | B | 流式渲染：`CodeBlock` memo 化，停止重高亮已完成代码围栏 | CI 全绿 |
| #391 | D | GPU 观测：合成状态 + WebGL Context Lost 观测通道 | CI 全绿 |
| — | C | React 状态更新 / 侧栏重渲染 | 进行中 |
| — | E | UI 包架构：懒加载与首屏资源 | 进行中 |

合并顺序（A 先合 → B/C/D/E），合并后由集成者**串行**重跑 Profile 出一份权威数字。

PR #389（另一个会话，`codex/plan-perf-handoff`）提出把本计划归档、声称「Desktop UI 性能与 TUI 性能不再由 mavis 负责」。**不合并**：它的前提（只查 `master`）与实际不符——#385/#386/#391 已存在且带实测数据；owner 已确认本线继续由 mavis 推进。已在该 PR 下留事实更正评论。

## 发现与决策

- 本 harness 没有 managed worktree 工具，按 `docs/development/worktree.md` 第 1 节手工建 linked worktree；6 个检出均已用 `scripts/junction-worktree.mjs` 配好依赖覆盖层。
- 基准不能复用 3000 端口：`dev-detector` 只探 3000–3005，命中的是别的 worktree 的 vite，量到的不是被测代码。走 preview 模式或显式端口。
- 目标文件规模：`App.tsx` 1192、`ChatView.tsx` 1366、`conversation-store.ts` 1694、`MessageList.tsx` 1209、`MessageInput.tsx` 2356 行。规模不是证据，先 Profile 再动手。
- **B 的结论**：流式时增长中的消息块每帧重解析整篇 markdown，连**早已写完的代码围栏**也被每帧重新分词 + 重新高亮。判定性实验——同文本把围栏去掉语言（不 tokenize）后主线程占用 1298.6 → 297.5ms，说明**语法高亮占约 78%**。改 `CodeBlock` 为 `React.memo` 后主线程占用 1276.3 → 645.5ms（−49.4%）、帧 p95 33.3 → 16.7ms，`dom.nodes` / `dom.mutations` 全 0% 变化，视觉逐字节一致。**增长中的那段 markdown 仍每帧整篇重解析（约 300ms 量级），是下一轮的候选。**
- **D 的结论**：GPU 侧**没有**可证明的收益。软件合成（`--disable-gpu`）对终端帧耗时无可证明影响（83.5 vs 99.9ms，落在轮间噪声内）；唯一可证明的差异是**渲染器选择**——终端从 WebGL 回退到 DOM 后帧 p95 116.9 → 183.7ms（+57%）、Long Task 167 → 369。因此本 PR 只交付观测能力，不做 GPU 开关实验。
- **A 查出的疑似产品缺陷**：全新 profile 且无持久化状态时，`isHydrated` 一直是 false，启动遮罩不消失、composer 保持禁用。根因线索是 zustand v5 下 `onRehydrateStorage` 直接 mutate state 不通知订阅者。落在 `conversation-store.ts`（C 的范围），已转给 C 复核。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `670a862c` clean | Windows / Node | `git worktree add` × 6 | 0 | `git worktree list` 6 项 perf-* |
| `670a862c` clean | Windows / Node | `node scripts/junction-worktree.mjs . --primary` | 0 | 每检出 56 个链接，`node_modules/.bin` 可用 |

## 接续 / 结果

实现中。集成者：mavis。合并顺序：A 先合（Harness 是其它 agent 的取证工具），再 B/C/D/E；合并后由集成者**串行**重跑 Profile 出一份权威数字，再出下一轮机会清单。

已合并：#382 `766db972`（计划）、#383 `d9eb7dba`（fixture + 测量锁契约）。
待合并：#386（A）、#385（B）、#391（D）。进行中：C、E。
未合并：#389（另一个会话的归档提案，owner 已定本线继续，详见「集成记录」）。

回收：未回收。6 个检出均未集成，owner 会话在线。
下一步：A 续做收尾后合并 #386；B/D 依次合并；C/E 交付后审阅合并；全部合并后串行重跑 Profile。
