# 636 TUI 工具行的折叠与运行期输出

状态：done（已集成 master） · 负责人：codex/tui-tool-fold-disclosure 会话 · 更新：2026-11-04
分支：`codex/tui-tool-fold-disclosure`（已合并并远端删除） · worktree：`.claude/worktrees/tui-tool-fold` · base：`a9c3897a4186d33365b3476c5b34a2dc94145594`（= 当时的 origin/master）· owner：本会话

## 目标与边界

用户可观察到的变化（对照 codex TUI 的 `ExecCell`）：

1. 折叠的工具行不再显示空白：至少画出真实输出的一行（失败时画退出码）。
2. `[+ N lines]` 计数是**被隐藏**的行数，与展开后实际看到的行数来自同一次计算；标记内点名展开键。
3. 运行中的 shell 调用有实时尾部输出：字节从 Host 的 shell 任务一路到达 TUI 的工具行。

本次不处理：工具分组折叠策略、`/settings` 默认值改动、Desktop 的滚动锚定、codex 的 head+tail 环形缓冲（duya 已有 `selectShellOutput`，语义等价）。

独占路径：`packages/cli/src/tui/`、`packages/agent-protocol/src/events/`、`packages/agent-protocol/src/legacy/`、`packages/agent-runtime/src/{events,project,legacy-sse-contract.ts}`、`packages/host/src/{managed-shell,worker-*}`、`packages/ui/src/lib/stream-session-manager.ts`、`docs/exec-plans/`。

关联：[Codex TUI 对照与实现](../references/codex-tui-alignment-survey.md)（其 §4 gap #3「per-block expand 渲染器支持但生产不传参」已过期：`TUIApp.ts:1830-1832` 确实下传 `expandedBlockIds/collapsedBlockIds/selectedBlockId`，Ctrl+O/Ctrl+T 已绑定）。

## 验收

- 定向：`node node_modules/vitest/vitest.mjs run packages/cli/src/tui`（基线：1 failed file / 112 passed，唯一存量红为 `slash/__tests__/presets.test.ts` 的文件模式断言）。
- 协议链：`21-payload-field-manifest` / `coalesce-guards` / `22-capability-bucket-coverage` / legacy SSE 全量性 drift 测试全绿。
- 门禁：`npm run typecheck:all`、`npm run architecture:check`（只允许既有 baseline）。
- 真实路径：`npm run bundle:worker` + `npm run build:cli-bundle` 后 `npm run dev:tui`，跑 `npm test` 这类持续输出命令，运行中即看到尾部行；不能只看 mock 测试。

## 进度

- [x] P1 折叠标记：计数改为被隐藏行数 + 标记内写 `Ctrl+T`
- [x] P2 折叠体至少一行（失败优先退出码）
- [x] P3 协议事件 `tool.output_delta`（payload / registry / required / fixtures / coalesce）
- [x] P4 Host 字节源：`startManagedShell` 惰性尾部轮询 → 按 taskId 发布
- [x] P5 运行侧接线：`composeLegacyRunSources.queueTool` 按 callId 订阅并 `emitter.emit`
- [x] P6 投影：legacy projector → codec → worker-frames → `host-event-stream` → `blocks.ts`
- [x] P7 渲染：live shell 体受 `liveRows` 约束；Desktop reducer 补 `tool_output` 落点
- [x] P8 bundle 重建已完成并验证产物含新链路；`duya tui` 真机目视由用户判定「按现有证据合」，不发起真实 provider 请求（见「接续」）

## 发现与决策

**duya 的两条「半条路径」。** `StreamingToolExecutor.setCallbacks`（`:602`）与 `ToolExecutionPipeline.setCallbacks`（`:90/:246`）在生产里**零调用方**；其 `ToolStreamBuffer`（`:551`）→`handleBufferFlush`（`:1176`）→`onProgress` 整条是死代码，且 `workerTools` 默认 `[]`（`:531`）。因此不走这条。`toDrainItem`（`run-engine-ports.ts:1075-1119`）对非 `deferredContext/agent_progress/tool_result` 一律返回 `null`，所以 `StreamingToolExecutor.ts:254` 打的 `metadata.type:'tool_progress'` 今天被静默丢弃——新事件若挂到 drain 上，等于复活一条长期沉默的火线并要新增 drain 臂，比直接 emit 更有侵入性。**决策：不碰 drain，用 per-run `spine.emitter`。**

**`tool_output` 是仓库自己声明过、从未有生产者的契约。** `apps/desktop/src/main/types/agent-message-types.ts:38`、`packages/ui/src/types/stream.ts:22`、`agent-sse-client.ts:374/:474`、`useStreamingToolOutput.ts`、`stream-session-manager.ts:3966`（`notifyToolOutputListeners`）、`StreamingMessage.tsx:393` → `ToolActionsGroup.tsx:193/248` 全链路已存在；`state.streamingToolOutput` 只被重置为 `''`（`:1745/:3357`），从未被赋值。`git log -S "streamingToolOutput +="` 为空——生产者从未存在。**决策：采纳既有形状 `{toolUseId, stream:'stdout'|'stderr', data}`，不新造 `chat:tool_output_delta`。**

**taskId 就是 callId。** `run-engine.ts:1673` → `tools.dispatch` → `run-engine-ports.ts:875 queueTool` → `worker-run-composition.ts:134 pipelines.queue({id: call.callId})` → `ToolExecutionPipeline.ts:354 toolUseId: tool.id` → `BashTool.ts:398 const taskId = context?.toolUseId ?? randomUUID()`。所以运行侧订阅不需要额外映射表。例外：`dispatcherFromRegistry.ts:115-118` 的 deferred 路径会把 toolUseId 变成 `<id>:deferred:<toolId>`，含 `:`——正是 `coalesce.ts:181 assertNoSeparator` 拒绝的字符；bash 是 eager 工具，不走这条，但 merge key 的这一约束要在测试里钉住。

**生产字节源不存在。** `managed-shell.ts:137` 用 `stdio: ['ignore', fd.fd, fd.fd]`，stdout 直接进日志文件，Host 运行期看不到一个字节。`BashWorker.ts:499-513 sendProgress` 只报 `bytes: stat.size`，且 `:311` 的前台计时器在软让渡后换成 size watchdog（`:315`）。**决策：在 `startManagedShell` 内做惰性尾部轮询**，复用 `task-registry.ts:69 readOutputTail`，只在有人订阅时开计时器；不改 `stdio`（会牵动 `:101-147` 的 watchdog 与 kill-tree）。

**durability 选 `ephemeral`。** `backpressure.ts:237 isRetainable` 按 `durability !== 'ephemeral'` 决定保留，`tool.arguments_delta` 已是同类先例（`registry.ts:210`）；选 `volatile` 会让每块输出都想落 ledger。代价是必须同时进 `coalesce.ts:102-106` 的过滤与 `:197-218` 的臂，否则火线不被合并；`coalesce-guards.test.ts:49-54` 断言可合并集合恰为三个 delta 家族，需按契约变更**改正向断言**而不是放宽。`worker-transport.ts:138-142 isDisposableEvent` 只认 `chat:*_delta`，`chat:tool_output` 不在其中会填满 2000 帧/4 MiB 队列并 `failTransport()`，必须显式加名。

**参考仓库语义取舍。** 采纳 codex：折叠量与绘制行数出自同一次截断（`activity_disclosure` 返回 `hidden_details`）；省略号里写被省略的行数并在标记内点名 `Ctrl+T`；运行期预览取尾部优先。否掉 codex 的 3 行预览：duya inline 模式下 `liveRows` 不变量要求仍在变化的块整块落在活动窗口内（`#liveStart` 之上已提交进终端 scrollback 永不可撤回），1 行是可在两条不变量间证明的取值。

**落地时才出现的两处契约修正。**

1. `stream` 从必填改为可选（`agent-message-types.ts:38`、`agent-sse-client.ts` 两处回调、`@duya/ai` 的 `SSEEvent`）。既有声明写着 `stream: 'stdout' | 'stderr'`，但 `managed-shell.ts` 用 `stdio: ['ignore', fd.fd, fd.fd]`——两个描述符指向同一个文件，生产者无法回答「这一段是哪条流」。保留必填就要在帧里编一个没人知道的答案，所以改成可选并说明消费方不得假设两路可分。
2. `toModelFrame`（`run-engine-model.ts:122`）对 `SSEEvent` 用 `assertNever` 收口，新增成员直接编译失败。决策是把 `tool_output` 显式列进「returns null」那一组而不是给它一个帧：这条流的读者是渲染器，喂进模型上下文等于让模型读一份轮询采样出来的残缺日志，再被紧随其后的 `tool_result` 当面推翻。

**真机目视的边界。** `duya chat -p` / `duya tui` 都要走真实 provider 请求（花用户额度），本沙箱内不擅自发起。替代验证取两段真实的：`live-output-tail.test.ts` 与 `shell-output-subscription.test.ts` 的 real-shell 分支用 `startManagedShell` 真起进程（`printf … ; sleep 1 ; printf …`），断言第一片在 `settled` 之前到达运行侧 emitter——字节源与订阅顺序都不是 mock；bundle 侧用 `grep` 确认重建产物含新事件与 `shellOutputStops` 接线。

**一条不属于本任务的 CI 红。** `chat-tui-host-stop-continue.test.ts` 在 run `41669969731` 上超时，本分支没改它。三条独立证据把它钉成既有 flake：PR #608（diff 无任何 `packages/cli` 文件）同一文件同一行同一 `Error: Test timed out in 30000ms.` 复现，只是 `it.each` 参数换成 `cooperative`；两次日志里该测试自带的 15s 帧等待报错 `TUI/Host transition timed out` 出现 0 次，说明卡点在 `startLocalHost` / 硬杀 / `host.close()` 而不是事件投递；把本计划文档单独重推一次（run `41673606318`，执行集合仍是 519 个文件）就全绿。留给后续任务的描述是：全局 `testTimeout: 30000`（`vitest.config.ts:195`）与用例自报的 `30_000` 相同，而内部 `until()` 预算 15s —— 一次慢 spawn 或慢 kill 就吃光余量；且 master 的 push run 把 `test` job 整个 `skipped`，主干上没有任何基线能发现它开始失败。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `04e7faff` / 无 | win32 / Node 24.18.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/{tui-tool-render,tui-transcript-preferences,tui-app-integration}.test.ts` | 0；73/73 | 折叠行显示 `fail 4` 与 `[+ 3 output lines · Ctrl+T]`；单行结果不再出现标记 |
| `04e7faff` / 无 | win32 / Node 24.18.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui` | 1 failed file / 112 passed；1438 tests passed | 基线（主检出）2 failed files / 111 passed，1437 passed；等于或高于基线 |
| `04e7faff` / 无 | win32 / Node 24.18.0 | `npm run typecheck:cli`；`npm run architecture:check` | 0 / 0 | 「OK — no new boundary violations」（48 条既有指纹） |
| — | win32 | 主检出 `npm run typecheck:all` 的 `@duya/ui` 25 个错误 | 与本任务无关 | 主检出 dist 过期（`HostWorktreeCleanupInput` 等）；本 worktree 全新构建后干净，`plugin-management.test.ts` 需先建 `@duya/plugin-core/dist` |
| `446d6a20` + P3–P7 未提交 | win32 / Node 24.18.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui` | 1 failed file / 113 passed；1456 passed | 唯一红为 `slash/__tests__/presets.test.ts:20`（`mode & 0o077` 得 54）；主检出 `a9c3897a` 单跑同文件同一签名 → 非新增。新增 `__tests__/tui-live-shell-tail.test.ts` 18 条全绿 |
| 同上 | win32 / Node 24.18.0 | `… run packages/host` | 0；270 files passed / 1 skipped，2372 tests | 新文件：`managed-shell/output-stream.test.ts`(6)、`managed-shell/live-output-tail.test.ts`(7，含真进程)、`worker-product-runtime/shell-output-subscription.test.ts`(8，含真进程)、`sse-frame-codec-live-output.test.ts`(7)；`worker-transport-write-queue.test.ts` +1 条可丢弃帧 |
| 同上 | win32 / Node 24.18.0 | `… run packages/agent-protocol packages/agent-runtime packages/client-core` | 0；151 files，1818 tests | 火线 drift 门禁全绿：#4 穷尽 switch、#5 快照改为 39 类型（手写再生成，未删文件）、#9 SSE/legacy 桥、#13 引用锚点、`surface-conformance`、`coalesce-guards` |
| 同上 | win32 / Node 24.18.0 | `… run packages/ui`；`… run apps/desktop/…/router-run-tee.test.ts` | 0 / 0；245 files 2473 passed（2 skipped）/ 9 passed | 新文件 `lib/__tests__/stream-session-manager-tool-output.test.ts`(6)；legacy 车道（codec → `normalizeWorkerEvent` → SSE → manager）逐段用真生产者与真消费者对接 |
| 同上 | win32 / Node 24.18.0 | `npm run architecture:check` | 0 | 「OK — no new boundary violations」；3191 条全部既有 baseline，48 条失效指纹未重录（不改 baseline） |
| 同上 | win32 / Node 24.18.0 | `npm run bundle:worker`；`npm run build:cli-bundle` | 0 / 0 | `worker-entry.js` 5.49 MB：`tool.output_delta`×3、`output-stream`×1、`shellOutputStops`×2；`cli.cjs` 4.68 MB：`tool.output_delta`×5 |
| 同上 | win32 / Node 24.18.0 | `npm run typecheck:all` | 0 | 首轮在 `@duya/host` 报 `run-engine-model.ts(230,13): TS2322 … 'never'`——新增 `SSEEvent` 成员撞上 `assertNever`；显式补 `case 'tool_output'` 后复跑零 `error TS`，两条 electron gate「OK — no new type errors (164 known)」。中途另有一处本任务测试自身的 `TS2345`（`stream-session-manager-tool-output.test.ts:89` 把可空 `streamId` 传给要求 `string` 的处理器），改为显式判空并说明「拿不到 streamId 的用例等于什么都没 settle」 |
| `0442e6c7` / 无 | GitHub Actions ubuntu-latest / Node 22.x，run `41669969731`（PR #610） | workflow「Test」按 job 记账 | `architecture` 0、`test scope` 0、`typecheck` 0、`build` 0；`test` 1 | `Test Files 1 failed \| 518 passed (519)`，`Tests 1 failed \| 5622 passed`。唯一红：`packages/cli/src/__tests__/chat-tui-host-stop-continue.test.ts > TUI stop and continue through the real Host > continues the same session after a escalated stop` = `Error: Test timed out in 30000ms.` @ `:109:39`；该文件本分支未改动 |
| `c335999c`（PR #608 `codex/cache-mcp-defer`） | 同上，run `41661142586` | 取失败签名做跨分支对照 | 1 | **同一文件、同一 describe、同一 `it.each` 行 `:109:39`、同一 `Error: Test timed out in 30000ms.`**，只是参数换成 `cooperative`；两边日志中 `TUI/Host transition timed out`（该测试自带的 15s 帧等待报错）出现次数均为 **0** ⇒ 卡点不在 `until()` 而在 `startLocalHost` / worker 硬杀 / `host.close()`。而 #608 的 diff 不含任何 `packages/cli` 文件（`packages/ai/src/api/anthropic-messages.ts`、`utils/prompt-caching.ts`、`packages/host/src/worker-config/tool-exposure.ts` + 测试 + docs） |
| `0442e6c7` / 无 | win32 / Node 24.18.0 | `… run packages/cli/src/__tests__/chat-tui-host-stop-continue.test.ts` 连跑两次；并读该测试 | 非确定 | 第 1 次两条参数各 30017 / 30024 ms 超时；第 2 次 `cooperative` 4302 ms 通过、`escalated` 30009 ms 超时——失败参数在两次运行间漂移。该测试把 `TUIApp` 整体 mock 掉、worker 是内联写死的 `worker.cjs` 夹具且从不走 bash 工具 ⇒ 本分支的轮询器与新帧不在其执行路径上。`master` 的 push run（如 `41652028885`）里 `test`/`typecheck`/`build` 全部 `skipped` ⇒ 该文件没有 master CI 基线可比 |
| `86445d8b`（仅改本计划文档）/ 无 | GitHub Actions ubuntu-latest / Node 22.x，run `41673606318` | 同一分支内容重跑 workflow「Test」 | 0 | **五个 job 全绿**（`architecture` / `test scope` / `typecheck` / `test` / `build`），`test` 为 `Test Files 519 passed (519)`、`Tests 5623 passed \| 1 expected fail \| 8 skipped`——文件数与红的那次完全相同，`chat-tui-host-stop-continue.test.ts` 确实在执行集合内。同一份代码红→绿 ⇒ 判定为计时敏感的既有 flake，本分支不改该文件、也不试图在 PR 内修它 |

| `7b021a08`（master，同时含本任务 merge `836f9ea9` 与 PR #606）/ 无 | win32 / Node 24.18.0 | 合并后重验：`… run packages/cli/src/tui packages/host/tests/managed-shell packages/host/tests/worker-product-runtime/shell-output-subscription.test.ts packages/host/tests/sse-frame-codec-live-output.test.ts packages/host/tests/worker-transport-write-queue.test.ts packages/agent-protocol packages/agent-runtime/test/{coalesce-guards,surface-conformance}.test.ts packages/client-core` | 1 failed file / 157 passed (158)；2142 passed | 这个「#606 + #610」的组合此前没有任何 CI 一起评过。唯一红仍是 `slash/__tests__/presets.test.ts:20`（`mode & 0o077` 得 54），与合并前逐字同签名 ⇒ 非新增 |
| 同上 | win32 / Node 24.18.0 | `… run packages/agent-runtime`；`npm run typecheck:all`；`npm run architecture:check`；`git show <master>:packages/host/bundle/worker-entry.js` 计数 | 0 / 0 / 0 / 命中 | `agent-runtime` 117 files 1242 tests 全绿（#606 改的正是 `run-engine.ts` / `permission-gate.ts`）；typecheck 零 `error TS`；architecture「OK — no new boundary violations」（3192 条 baselined，49 条失效指纹仍未重录）；bundle 里 `tool.output_delta`×3、`shellOutputStops`×2 ⇒ #606 的 `1b53536e restore complete rebuilt worker artifacts` 没有抹掉本任务的重建产物 |

## 接续 / 结果

已提交：`04e7faff`（P1+P2，4 文件）、`446d6a20`（本计划）、P3–P7 按逻辑变更拆分提交（协议 / runtime / host 字节源 / host 接线 / 投影 / TUI 渲染 / Desktop+Web 车道 / 测试）、`813fbbbb`（`build(host)` 重建 worker bundle）、`0442e6c7`（merge master）。

交付：PR [#610](https://github.com/lava-chen/duya/pull/610) · base `a9c3897a` · 最终 head `712db0fd`（五个 job 全绿，run `41675242540`）· **merge commit `836f9ea9`（2026-11-04 集成进 master，用户授权；`master` 未保护、无必需检查）**。CI 在 `0442e6c7` 上 `architecture` / `test scope` / `typecheck` / `build` 绿、`test` 红一条；仅改本文档的 `86445d8b` 重跑（run `41673606318`）**五个 job 全绿**。红的那条是 `chat-tui-host-stop-continue.test.ts` 的 `it.each` 30s 超时，**按文件 / 用例 / 错误签名判定与本分支无关**（见验证记录后四行：无 `packages/cli` 改动的 PR #608 同一签名复现、失败参数在运行间漂移、同码重跑变绿、本分支未改该文件且该测试把渲染器与 worker 都换成了夹具）。该检查不是必需检查，按仓库约定记录后由获授权的集成者评估；本分支不试图修它。

真机目视的处置：`duya chat` / `duya tui` 的目视需要一次真实 provider 请求（花用户额度），用户在关口上选择「跳过，按现有证据合」。因此这条验收**没有做过**，交付依据是两段真进程测试（字节在 `settled` 前到达运行侧 emitter）+ bundle 产物 grep + `liveRows` 约束的 18 条渲染用例。**若合并后目视看不到尾部行**，先查 `hasShellOutputListener(taskId)` 是否在 spawn 前为真（P5 的顺序不变量），再查 `liveRows` 是否 ≥ 4（小于 3 时 `liveShellBody` 按不变量返回空）。

已知边界（有意不做）：`tool.output_delta` 是 `ephemeral`，重载历史时没有可回放的帧，恢复出的行只由 `result` 渲染；让渡到后台的命令其后续输出不再有订阅者（run 已关闭其 `shellOutputStops`）；Desktop 侧只补到 `stream-session-manager` 的 tail 累积，`ToolActionsGroup` 的可见性沿用既有 `isRunning` 门。

回收：任务分支 `codex/tui-tool-fold-disclosure` 已随 #610 合并并被远端删除（`git ls-remote --heads origin codex/tui-tool-fold-disclosure` 为空，已核对）。本检出 `.claude/worktrees/tui-tool-fold` 由 owner 在本记录合并后立即执行 `bash scripts/remove-worktree.sh .claude/worktrees/tui-tool-fold --delete-branch`；该检出唯一的 dirty 项 `packages/capabilities/src/ModuleTool/inline-content.ts` 核对为 `git diff` 无内容差（只有行尾 warning），不保存。
