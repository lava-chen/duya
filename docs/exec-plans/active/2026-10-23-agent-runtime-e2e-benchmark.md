# Agent Runtime 真实基准：首 Token、工具调用、事件传输分段

状态：active · 负责人：mavis / `mvs_ae3b38275b13437883faa5ef6f4d518c` · 更新：2026-10-23
分支：`codex/tui-perf-benchmark` · worktree：`E:\Projects\duya\.claude\worktrees\tui-perf-benchmark` · base：`af6e7eb6` · owner：mavis

## 目标与边界

`evals/agent/performance/METRICS.md` 写明现有基准的缺口：Host 受理、worker 启动、
Worker→Host IPC、Host→客户端 SSE 交付**全部未测**；`tui.test.ts` 的 scope 也自述
不含 Host/Worker/provider 时间。本次补上这一段，并按用户要求定位三个瓶颈：

- **首 Token**：从 TUI 提交到第一个 token 被消费 / 被画出，分段到 provider 请求、
  provider 首字节、事件到达、终端绘制。
- **工具调用**：模型发出 tool_use → `tool.call_started` → 真实工具执行 →
  `tool.call_completed` → 第二次模型请求 → 终稿。
- **事件传输**：每个事件从 Host 铸封（`envelope.timestamp`）到客户端收到的延迟分布，
  以及到达间隔、事件类型构成。

边界：

- 不改生产代码。基准是新增的 eval 套件 + 计划/文档。
- 断言只针对**不变量**（事件序列、工具轮次、终稿文本、span 完整性），时间数字只**上报**，
  不设阈值——沿用 `tui.test.ts` 的既有立场。
- provider 是本机脚本化 Anthropic SSE 服务器；模型时间由 fixture 控制并单列。
- worker 是独立进程，不做跨进程时间戳相减；worker 段以合并 span 上报。
  唯一的例外是 worker **自己日志内部**的行间差（同进程时长，可比）。

关联：`evals/agent/performance/METRICS.md`（指标地图）、`INITIAL_FINDINGS.md` 优先项 1–2、
`packages/cli/tests/integration/shared-client-vertical.test.ts`（同一套真实 Host + 生产 worker 的既有竖切）。

## 验收

- `npm run eval:agent:runtime` 在本机跑通，写出 `evals/agent/reports/runtime-latest.json`。
- 报告含三个场景的分段数字、worker/Host 日志阶段缺口，且 `scope` 写明排除了什么。
- `npm run typecheck:all` 通过；`npm run architecture:check` 无新增违规。
- `npm test` 中新文件被收集（`check-test-coverage` 不报孤儿）。

## 进度

- [x] 读通链路：`chat.ts:1091-1099` 的 TUI 消费路径 = `startAgentRun` → `watchAgentRunEvents` → `HostEventStream.push` → `TUIApp.push`；Host SSE 走 live 通道（含 ephemeral delta）后接 durable 账本收尾（`http-server.ts:3090-3109`）。
- [x] 独立 worktree + junction 依赖 + `build:packages`。
- [x] `evals/agent/performance/runtime-fixture.ts`：脚本化 provider + 真实 Host/worker + TUI 消费驱动 + 日志解析。
- [x] `evals/agent/performance/runtime-e2e.test.ts`：三场景 + 报告。
- [x] 跑基线并定位瓶颈（见下）。
- [x] 更新 `README.md` / `METRICS.md` 与根 `package.json` 脚本。
- [ ] 门禁 + PR。

## 发现与决策

### 瓶颈定位（本机基线，5 样本）

| 段 | p50 | 结论 |
| --- | --- | --- |
| Host 受理（submit → accepted） | 18 ms | 不是瓶颈 |
| **accepted → provider 请求** | **637 ms** | **首 Token 的主要成本** |
| provider 首字节 → token 被 TUI 收到 | 33 ms | worker + IPC + Host 解码 + SSE |
| token 被收到 → 画到终端 | **70 ms** | TUI 的 70 ms 渲染节流，不是传输 |
| **Host 铸封 → 客户端收到（每事件）** | **0.73 ms**（p95 3.8） | **事件传输不是瓶颈** |
| 客户端收到 → 画到终端（每事件） | 62 ms | 渲染节流 |
| 工具开始 → 工具完成 | 14 ms | 工具本身很快 |
| 模型第 1 次请求 → 第 2 次请求 | 41 ms | 模型↔工具往返 |

**结论：事件传输被排除在瓶颈之外**（每事件 0.73 ms p50）。首 Token 的成本集中在
「Host 受理之后、provider 请求之前」，以及终端侧的 70 ms 节流。

### 该 637 ms 在哪（worker 与 Host 自己的日志）

- Host 日志最大缺口：**412 ms**——「Sending command to worker」到 worker 的第一条输出，
  即 **fork + 4.6 MB worker bundle 的模块初始化**。
- worker 日志最大缺口：**161 ms**——「Failed to discover plugin skill paths」到
  「Loaded 18 skills after filtering」，即**每轮技能发现扫描**。
- 其余：MCP 初始化 → handleChatStart 113 ms，多模态能力探测 33 ms，
  `projectModelMessages` 投影 30 ms。

### 顺带查出的三个缺陷（均由本基准实证）

1. **用户提示词在模型请求里出现两次。** 持久化的时间线只有 1 条 user 行、1 个文本块，
   但 provider 收到的 user 消息内容数组是
   `[{"type":"text","text":"<prompt>"},{"type":"text","text":"<prompt>"}]`。
   即：**存一次、发两次**，首轮提示词 token 与上下文组装成本翻倍。
   已定位到「持久化正确、投影重复」，**具体行号尚未定位**——投影链为
   `worker-session-runtime.ts:_projectModelMessages` → `worker-run-composition.ts:createLegacyAssembleTurn` → `toModelMessages`，
   待下一步确认是哪一步把提示词复制成了两块。
2. **每开一个新会话会多一次 provider 调用。** 提示词是 `<request>…</request>`，
   来自 `packages/host/src/worker-session/title-generator.ts:320` 的标题生成，
   与用户那一轮并发抢占同一个 provider。
3. **每轮时间线被投影两次。** worker 日志里连续两行
   `projectModelMessages: 1 agent messages → 5 model messages`；
   对应 `worker-session-runtime.ts:459` 与 `worker-run-composition.ts:265` 两次投影。
   另外 1 条 agent 消息投影成 5 条 model 消息。

### 其他决策

- **时钟规则**：provider / Host / TUI 同进程，共用单调钟；worker 独立进程，
  worker 段整体上报，不跨进程相减。唯一例外是 worker **自己日志的行间差**（同进程时长）。
  `envelope.timestamp` 是 epoch 毫秒整数，Host 侧铸封 span 带 ±1 ms 量化误差。
- **每个样本用独立 session**：否则上一轮的 tool_result 会留在历史里，
  让下一轮的首个请求被脚本误判成「工具后的追问」，测到完全不同的负载。
- **provider 脚本按「最新 user 消息是否含 tool_result」判定**，不是「历史里有没有
  tool_result」——后者从第二轮起就恒为真。
- **worker 子进程必须继承 `DUYA_DATA_ROOT`**，否则它读开发者真实的 `~/.duya` 配置、
  打真实的 provider，基准会以一个和基准无关的原因失败。
- **断言只覆盖不变量**：run 完成、工具真的跑了、事件 seq 单调、终稿文本正确、
  provider 被问过 ≥2 次。耗时不设阈值（共享 CI 机器会把阈值变成假红）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| af6e7eb6（clean） | Windows / Node 24.16.0 | `git worktree add … -b codex/tui-perf-benchmark origin/master` | 0 | 检出在 `.claude/worktrees/tui-perf-benchmark` |
| af6e7eb6（clean） | Windows | `node scripts/junction-worktree.mjs .` | 0 | 56 link(s) created |
| af6e7eb6（clean） | Windows | `npm run build:packages` | 0 | built 20 package(s) |
| af6e7eb6（clean） | Windows | `npx vitest run packages/cli/tests/integration/shared-client-vertical.test.ts` | 0 | 1 passed，7.3 s（参照用例，同一套真实 Host + worker） |
| 1b0bbef4 + 本任务改动 | Windows / Node 24.16.0 / 20 核 | `npx vitest run evals/agent/performance/runtime-e2e.test.ts`（PERF_RUNTIME_SAMPLES=5） | 0 | 2 passed；报告 `evals/agent/reports/runtime-latest.json` |
| 1b0bbef4 + 本任务改动 | Windows | `npm run typecheck:all` | 0 | 含 `typecheck:evals`：no new type errors |
| 1b0bbef4 + 本任务改动 | Windows | `npm run architecture:check` | 0 | OK — no new boundary violations |
| 1b0bbef4 + 本任务改动 | Windows | `npm run bundle:verify` | 0 | FRESH，0/921 输入变更 |
| 7d63953b（合并 origin/master 后） | Windows / Node 24.16.0 | `npx vitest run evals/agent/performance/runtime-e2e.test.ts`（5 样本） | 0 | 2 passed；结论不变：mint→client p50 0.99 ms / 1.86 ms，accepted→provider p50 506 ms，token→paint p50 76 ms，工具执行 p50 11.9 ms |

## 接续 / 结果

已实现：基准套件（fixture + 报告）+ 文档更新。未提交。
下一步：跑 `npm run typecheck:all` 与 `npm run architecture:check`，然后 commit + PR。
缺陷 1 的下一步：在 `_projectModelMessages` / `createLegacyAssembleTurn` / Anthropic 适配器
三处之间定位提示词被复制成两块的那一步，并用本基准的 `newestUserContent` 作为回归证据。
回收：未回收原因——成果未合并。
