# 636 TUI 工具行的折叠与运行期输出

状态：active · 负责人：codex/tui-tool-fold-disclosure 会话 · 更新：2026-11-03
分支：`codex/tui-tool-fold-disclosure` · worktree：`.claude/worktrees/tui-tool-fold` · base：`9b8da5e866e94fb6a608e2ca5b9c042dd34987bc`（= origin/master）· owner：本会话

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
- [ ] P3 协议事件 `tool.output_delta`（payload / registry / required / fixtures / coalesce）
- [ ] P4 Host 字节源：`startManagedShell` 惰性尾部轮询 → 按 taskId 发布
- [ ] P5 运行侧接线：`composeLegacyRunSources.queueTool` 按 callId 订阅并 `emitter.emit`
- [ ] P6 投影：legacy projector → codec → worker-frames → `host-event-stream` → `blocks.ts`
- [ ] P7 渲染：live shell 体受 `liveRows` 约束；Desktop reducer 补 `tool_output` 落点
- [ ] P8 bundle 重建 + 真机冒烟

## 发现与决策

**duya 的两条「半条路径」。** `StreamingToolExecutor.setCallbacks`（`:602`）与 `ToolExecutionPipeline.setCallbacks`（`:90/:246`）在生产里**零调用方**；其 `ToolStreamBuffer`（`:551`）→`handleBufferFlush`（`:1176`）→`onProgress` 整条是死代码，且 `workerTools` 默认 `[]`（`:531`）。因此不走这条。`toDrainItem`（`run-engine-ports.ts:1075-1119`）对非 `deferredContext/agent_progress/tool_result` 一律返回 `null`，所以 `StreamingToolExecutor.ts:254` 打的 `metadata.type:'tool_progress'` 今天被静默丢弃——新事件若挂到 drain 上，等于复活一条长期沉默的火线并要新增 drain 臂，比直接 emit 更有侵入性。**决策：不碰 drain，用 per-run `spine.emitter`。**

**`tool_output` 是仓库自己声明过、从未有生产者的契约。** `apps/desktop/src/main/types/agent-message-types.ts:38`、`packages/ui/src/types/stream.ts:22`、`agent-sse-client.ts:374/:474`、`useStreamingToolOutput.ts`、`stream-session-manager.ts:3966`（`notifyToolOutputListeners`）、`StreamingMessage.tsx:393` → `ToolActionsGroup.tsx:193/248` 全链路已存在；`state.streamingToolOutput` 只被重置为 `''`（`:1745/:3357`），从未被赋值。`git log -S "streamingToolOutput +="` 为空——生产者从未存在。**决策：采纳既有形状 `{toolUseId, stream:'stdout'|'stderr', data}`，不新造 `chat:tool_output_delta`。**

**taskId 就是 callId。** `run-engine.ts:1673` → `tools.dispatch` → `run-engine-ports.ts:875 queueTool` → `worker-run-composition.ts:134 pipelines.queue({id: call.callId})` → `ToolExecutionPipeline.ts:354 toolUseId: tool.id` → `BashTool.ts:398 const taskId = context?.toolUseId ?? randomUUID()`。所以运行侧订阅不需要额外映射表。例外：`dispatcherFromRegistry.ts:115-118` 的 deferred 路径会把 toolUseId 变成 `<id>:deferred:<toolId>`，含 `:`——正是 `coalesce.ts:181 assertNoSeparator` 拒绝的字符；bash 是 eager 工具，不走这条，但 merge key 的这一约束要在测试里钉住。

**生产字节源不存在。** `managed-shell.ts:137` 用 `stdio: ['ignore', fd.fd, fd.fd]`，stdout 直接进日志文件，Host 运行期看不到一个字节。`BashWorker.ts:499-513 sendProgress` 只报 `bytes: stat.size`，且 `:311` 的前台计时器在软让渡后换成 size watchdog（`:315`）。**决策：在 `startManagedShell` 内做惰性尾部轮询**，复用 `task-registry.ts:69 readOutputTail`，只在有人订阅时开计时器；不改 `stdio`（会牵动 `:101-147` 的 watchdog 与 kill-tree）。

**durability 选 `ephemeral`。** `backpressure.ts:237 isRetainable` 按 `durability !== 'ephemeral'` 决定保留，`tool.arguments_delta` 已是同类先例（`registry.ts:210`）；选 `volatile` 会让每块输出都想落 ledger。代价是必须同时进 `coalesce.ts:102-106` 的过滤与 `:197-218` 的臂，否则火线不被合并；`coalesce-guards.test.ts:49-54` 断言可合并集合恰为三个 delta 家族，需按契约变更**改正向断言**而不是放宽。`worker-transport.ts:138-142 isDisposableEvent` 只认 `chat:*_delta`，`chat:tool_output` 不在其中会填满 2000 帧/4 MiB 队列并 `failTransport()`，必须显式加名。

**参考仓库语义取舍。** 采纳 codex：折叠量与绘制行数出自同一次截断（`activity_disclosure` 返回 `hidden_details`）；省略号里写被省略的行数并在标记内点名 `Ctrl+T`；运行期预览取尾部优先。否掉 codex 的 3 行预览：duya inline 模式下 `liveRows` 不变量要求仍在变化的块整块落在活动窗口内（`#liveStart` 之上已提交进终端 scrollback 永不可撤回），1 行是可在两条不变量间证明的取值。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `04e7faff` / 无 | win32 / Node 24.18.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui/__tests__/{tui-tool-render,tui-transcript-preferences,tui-app-integration}.test.ts` | 0；73/73 | 折叠行显示 `fail 4` 与 `[+ 3 output lines · Ctrl+T]`；单行结果不再出现标记 |
| `04e7faff` / 无 | win32 / Node 24.18.0 | `node node_modules/vitest/vitest.mjs run packages/cli/src/tui` | 1 failed file / 112 passed；1438 tests passed | 基线（主检出）2 failed files / 111 passed，1437 passed；等于或高于基线 |
| `04e7faff` / 无 | win32 / Node 24.18.0 | `npm run typecheck:cli`；`npm run architecture:check` | 0 / 0 | 「OK — no new boundary violations」（48 条既有指纹） |
| — | win32 | 主检出 `npm run typecheck:all` 的 `@duya/ui` 25 个错误 | 与本任务无关 | 主检出 dist 过期（`HostWorktreeCleanupInput` 等）；本 worktree 全新构建后干净，`plugin-management.test.ts` 需先建 `@duya/plugin-core/dist` |

## 接续 / 结果

已提交：`04e7faff`（P1+P2，4 文件）。未提交：P3–P8 尚未开工。
下一步：P3 协议事件落地——判据是 `21-payload-field-manifest` 与 `coalesce-guards` 在新事件类型下全绿，且 `tool.output_delta` 有最小 fixture。

回收：未回收。P3–P8 未完成前保留分支与 worktree。
