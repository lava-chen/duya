# Plan 550: Prompt → Handlebars, DuyaAgent Decomposition, Dependency-Graph Orchestration

> **Status**: In Progress (started 2026-09-19)
> **Priority**: P1 (architecture evolution; complements plan 429 gap closure)
> **Owner**: Mavis + 陈炫羽
> **PR**: [#59](https://github.com/lava-chen/duya/pull/59) — covers step 1 (改造 1) plus 3a / 3b (Plan 550 step 3 partial)
> **Worktree**: `feat/550-prompt-hbs-agent-decomposition` on `E:\Projects\duya`
> **Related**:
> - `docs/references/harness-comparison/prompt-and-system-prompt.md`
> - `docs/references/harness-comparison/tool-system.md`
> - `docs/references/harness-comparison/loop-control.md` (待办)
> - `docs/exec-plans/active/429-harness-gap-closure.md` (并行 P0/P1 工程)

## Progress (2026-09-19, end of session 4 — DuyaAgent 拆解聚焦)

| Step | Commit | Status |
|---|---|---|
| 1a Handlebars renderer + asset loader | `8f9ebb7d` | ✅ done |
| 1b HbsPromptSystem + general/system-prompt.md.hbs | `3006d3fb` | ✅ done |
| 1b Switch generalConfig to hbs | `dad3200e` | ✅ done |
| 1c 5 dynamic sections migrated | `1a9d51e3` | ✅ done |
| 1d Drop dead TS imports from generalConfig | `1e86dd49` | ✅ done |
| 3a ToolDependencyDeclaration schema | `d92c1dce` | ✅ done |
| 3b DependencyGraphOrchestrator (topo-sort) | `96968f11` | ✅ done |
| 2a-1 TurnContext value type | `40cb6e92` | ✅ done |
| 2a-2 TurnAssembler + AgentRuntime interface | `a3d7f001` | ✅ done |
| 2a-3 duyaAgent implements AgentRuntime | `8ccd574b` | ✅ done |
| 2a-4 duyaAgent.assembleTurnContext public method | `ccea0948` | ✅ done |
| 2a-5 streamChat top-of-call wiring anchor | `cae957a4` | ✅ done |
| 2a-6a streamChat hook dispatcher sessionId → turnContext | `154cb5a5` | ✅ done |
| 2a-6b streamChat mode dispatch sessionId → turnContext | `0b4d6726` | ✅ done |
| 2a-6c tool executor sessionId → turnContext | `361512ca` | ✅ done |
| 2a-6d Stop/SessionEnd hook sessionId → turnContext | `35d41754` | ✅ done |
| 2a-6e loop-hook bus sessionId → turnContext | `5c8e66ad` | ✅ done |
| 2a-6f tool-loop sessionId → turnContext | `e2c83178` | ✅ done |
| 2a-6g streamChat started log sessionId → turnContext | `2b62aa78` | ✅ done |
| 2a-7a hook cwd workingDirectory → turnContext | `b96bed68` | ✅ done |
| 2a-7b wiring workingDirectory → turnContext | `341dd3c1` | ✅ done |
| 2a-7c nested-AGENTS trigger path workingDirectory → turnContext | `327f1430` | ✅ done |
| 2a-8 tool-executor language → turnContext | `b676d0c6` | ✅ done |
| 2d PermissionsGate (module + tests) | `495e5cb6` | ✅ done |
| 2d PermissionsGate wire + delete _buildPermissionContext | `ccf3e51a` | ✅ done |
| 2d VisualAnalysis — already independent (visual-analysis.ts) | — | ✅ done |
| 2c CompactionCoordinator (module + tests) | `2a20c20d` | ✅ done |
| 2c CompactionCoordinator wire + delete 146 lines | `eaba10ff` | ✅ done |
| 2b ToolExecutionPipeline facade (thin wrapper over StreamingToolExecutor) | `a6b5878b` | ✅ done |
| 2b ToolExecutionPipeline wire (duyaAgent.streamChat uses facade) | `7eae6bdf` | ✅ done |
| **改造 2 — remaining** (2b-internals: orchestrator planExecution wiring inside facade, 2e DuyaAgent streamChat loop extraction) | — | ⏳ next session |
| 1d-rest 8 remaining dynamic sections + gateway/code/research configs + delete `general/sections/*.ts` | — | ⏳ follow-up PR (out of session-4 scope) |
| 3c StreamingToolExecutor wiring | — | ⏳ next session |
| 3d end-to-end coverage | — | ⏳ next session |

**DuyaAgent.ts line count**: `4812` (start of session 4) → `4619`
(end of session 4) — `-193 lines`. Three new modules:

- `packages/agent/src/agent/PermissionsGate.ts` (232 lines, 12 tests)
- `packages/agent/src/agent/CompactionCoordinator.ts` (272 lines, 6 tests)
- `packages/agent/src/tool/ToolExecutionPipeline.ts` (123 lines, 7 tests)

All three are state-free wrappers around the session-scope deps,
exposed through duck-typed interfaces so `duyaAgent` never has to
extend anything.

## Next-session starting points (session 5)

- **改造 2b-internals (within ToolExecutionPipeline)**: the facade
  currently forwards `addTool` directly to the wrapped executor. The
  follow-up commit routes tool batches through
  `DependencyGraphOrchestrator.planExecution()` so write/write races
  serialise and read/read pairs still run in parallel. ~150-300 lines
  + 8-12 unit tests covering the wave-by-wave scheduler.
- **改造 2e DuyaAgent 收 facade**: `streamChat` body is still
  ~1700 lines (LLM stream subscription, hook dispatch, mid-loop
  compaction check, anti-dead-loop, error replay, post-loop
  PreFinalize / PostTurn dispatch, final compaction check, done event).
  Strategy for session 5: extract three sub-modules in order
  1. **TurnPreparer** (lines 1238–1530, ~290 lines): mode apply +
     loop-hook bus registration + dead-loop tracker + seq-index
     allocation + tool-list re-projection. Public surface:
     `prepareTurn(turnContext, options): PreparedTurn` where
     `PreparedTurn` carries the system prompt, tools, hook bus,
     dead-loop state, and the `dispatchHooks` / `buildHookCtx`
     closures.
  2. **TurnLoop** (lines 1530–2680, ~1150 lines): the per-turn LLM
     stream subscription, tool result back-projection, post-tool
     hooks, and tool-use bookkeeping. Pure functional: takes
     `PreparedTurn`, runs to completion, yields `SSEEvent`s.
  3. **StreamFinalizer** (lines 2680–2940, ~260 lines): post-loop
     PreFinalize / PostTurn / SessionEnd hooks, context-length retry
     re-projection, synthetic tool_results, error event surface.
  End state: `duyaAgent.streamChat` < 100 lines that just calls
  `prepareTurn → turnLoop → finalizer` and forwards the yielded
  events to the wire.
- **改造 3c StreamingToolExecutor**: same as the 2b-internals
  follow-up; the `runBatch` method currently uses `TOOL_BATCH_MAP`
  (legacy). The follow-up replaces the static scheduler with a
  `DependencyGraphOrchestrator` instance and a wave-by-wave loop.
  ~200-400 lines.
- **PR #1 cleanup**: 8 remaining dynamic sections, gateway/code/research
  configs, deletion of `general/sections/*.ts`. Independent of session 4
  work; can run in parallel.

## Session 3 summary

This session landed 15 atomic commits across all three plan
directions, taking the work from "no infrastructure" to "the
infrastructure is complete and the wiring anchor is in place". The
remaining work is mechanical (substituting field reads, extracting
sub-modules, wiring the orchestrator into StreamingToolExecutor)
and naturally splits across multiple follow-up sessions — none of
those follow-ups needs to re-touch the design work done here.

## Session 4 summary (DuyaAgent 拆解聚焦)

Session 4 re-scoped onto Plan 550 direction 2 (`DuyaAgent` 分层拆解)
per the user's "完整不丢东西 + 合理优秀" requirement, and shipped:

1. **11 atomic commits** replacing `streamChat`'s local-field reads
   with `TurnContext.xxx` (2a-6/7/8 family). `sessionId` /
   `workingDirectory` / `language` now flow through the
   turn-scope `TurnContext`; the remaining per-turn fields
   (`permissionMode` / `hostToolPermission` /
   `_turnAlwaysAllowTools` / `additionalWorkingDirectories`) are
   read inside `_buildPermissionContext`, which is now itself an
   extracted module — the per-turn reads happen at the
   boundary, where it makes sense.
2. **`PermissionsGate`** (2d): a duck-typed function + class facade
   that builds `permissionContext` + `canUseTool` from session-scope
   deps plus a `TurnContext`. `duyaAgent.streamChat` now calls
   `buildPermissions({ ... }, turnContext, registry)` instead of
   carrying its own 95-line private method. 12 unit tests pin the
   per-turn approval ledger, plan-mode exact-path gate, and
   fail-closed semantics.
3. **`CompactionCoordinator`** (2c): owns the proactive-compaction
   lifecycle (prefire kick, cooldown gate, event buffer,
   `compactProactive` execution, post-compact re-projection). The
   146-line inline block in `streamChat` is now
   `await this.compactionCoordinator.runPreTurn({...})` followed by
   forwarding the SSE events. 6 unit tests pin the cooldown
   short-circuit, post-compact baseline pinning, and failure
   surface (`compact:error`).
4. **`VisualAnalysis`** (2d): the existing `visual-analysis.ts`
   module already meets the spec — no further work needed.
5. **`ToolExecutionPipeline`** (2b): thin facade over
   `StreamingToolExecutor` so `duyaAgent.streamChat` never
   instantiates the streaming executor directly. The facade
   establishes the seam for the upcoming step 2b-internals —
   `DependencyGraphOrchestrator.planExecution()` slots between
   `addTool` and `getRemainingResults` without any caller-side
   changes. 7 unit tests pin the public surface (constructor
   signature, addTool, getRemainingResults async-iterable, setCallbacks,
   discard / dispose idempotency, getMemoryUsageMB).
6. `DuyaAgent.ts`: `4812` → `4619` lines (`-193`), with a clean
   facade-friendly boundary at the top of `streamChat` and the
   `toolExecutionPipeline` import substituting for the streaming
   executor at the wire site.

Net: three new modules, 20 new atomic commits (19 code + 1 plan
update), and `DuyaAgent.ts` is now within ~5× of the plan target
(< 800 lines) while every commit keeps behaviour identical to
baseline (verified by running the agent test surface before and
after each refactor; pre-existing plan-486 test failures unchanged
across all commits).

The user's original goal — "针对和 mcode 对比之后发现的
需要duyaagent.ts分层拆解的部分下功夫做到好的拆解工程 完整
不丢东西但是合理优秀的拆解" — is materially advanced but not
finished: `streamChat` still owns the LLM+tool loop (~1700 lines
of mixed-mode dispatch, hook dispatch, error handling). Session 5
will land 2b-internals + 2e (TurnPreparer / TurnLoop /
StreamFinalizer).

## Background

After the harness-comparison study (2026-08, `harness-comparison-docs.md`)
duya 暴露了三个**架构层短板**,让 "干活多说话少 + 并行强 + 速度快"
这个体感追不上 minimax-code(mcode):

| 短板 | 现状 | 改进方向 |
|---|---|---|
| 1. Prompt 系统臃肿 | `PromptSystem.ts` 单类 + 10 个 section + 13 个 dynamic section,总长接近 mcode 的 10 倍,且 `PromptSystem.ts:35-37` 自警告"will break prompt caching" | 改用 **Handlebars `.hbs` 模板** + YAML frontmatter,像 mcode 那样把 system prompt 收敛到 76-110 行的 .hbs 模板,条件渲染 `{{#if features.x}}`,保留 prompt caching 友好 |
| 2. Agent 主类单体化 | `DuyaAgent.ts` **4473 行**,糅合 turn 装配、工具执行、compaction、permissions、visual-analysis、scratchpad、reminders 多职责 | 拆成 **5 个职责清晰子模块**:`TurnAssembler` / `ToolExecutionPipeline` / `CompactionCoordinator` / `PermissionsGate` / `TurnContext`;`DuyaAgent` 收尾为 facade,只保留 `streamChat` 入口 |
| 3. 工具批调度粒度粗 | `tool/orchestration/types.ts` 静态映射 `TOOL_BATCH_MAP`,阶段间 `READ→WRITE→SYSTEM` 强制串行,工具实例级依赖丢失 | 重写为 **Dependency-Graph Orchestrator**:`each tool_use declares dependencies` → 框架按依赖图调度,而不是按工具名分阶段 |

## Goals

- **Goal 1**:system prompt 拼装逻辑全部搬到 `.hbs` 模板,渲染时间 < 5ms,prompt cache 命中率保持 ≥ 现状
- **Goal 2**:`DuyaAgent.ts` < 800 行(从 4473 行降 82%);每个新模块 < 600 行且职责单一
- **Goal 3**:同一 LLM turn 内多个独立 tool_use 全部按依赖图并行;`{maxConcurrency}` 从按 batch 配置改为按 `dependencies` 解析;write/write 之间的隐式串行约束**保留**(`preImageSha` 不能并行写同一文件)

## Non-Goals

- 不重写 pi-coding-agent 风格的事件队列(mcode 那套不直接搬过来,duya 的 SSE 流式 UI 与之不兼容)
- 不改 `tool/registry.ts` 的 `ExposeMode` 四层结构
- 不改 compaction 422 / 495 / 517 的逻辑,只把 `DuyaAgent.streamChat` 里的 compaction 调用搬到 `CompactionCoordinator`
- 不动 plan 429 的 P0/P1 任务(checkpoint / PreToolUse / sandbox / failover / 子代理 UI)

## Atomic Commits

每个改造拆 3-5 个原子 commit,每个 commit 前跑 `npm run typecheck:all`。

### PR #1: Prompt → Handlebars

| # | Commit | 范围 |
|---|---|---|
| 1a | `feat(prompts): add Handlebars renderer + .hbs asset loader` | 新增 `prompts/hbs/HandlebarsRenderer.ts` + `prompts/hbs/assetLoader.ts`;加 handlebars 依赖 |
| 1b | `refactor(prompts): migrate general sections to .hbs templates` | `prompts/general/sections/*.ts` → `prompts/hbs/templates/general/*.hbs`;`PromptSystem.buildSystemPrompt` 改成渲染器调用 |
| 1c | `refactor(prompts): migrate dynamic sections to .hbs + preserve cache` | 13 个 dynamic section 逐个迁移,volatile sections 通过 `{{#volatile_now}}` 块标记,确保只它们破坏 cache |
| 1d | `chore(prompts): delete legacy TS sections + PromptSystemConfig` | 删 `prompts/general/sections/*` 和 `PromptSystem` 单类实现,改由 `HbsPromptSystem` 单一类接管 |

### PR #2: DuyaAgent Decomposition

| # | Commit | 范围 |
|---|---|---|
| 2a | `refactor(agent): extract TurnAssembler (turn assembly layer)` | 从 `DuyaAgent` 抽 `TurnAssembler.ts`(~400 行):turn 初始化、history 注入、outbound normalizer、context projection |
| 2b | `refactor(agent): extract ToolExecutionPipeline (tool loop)` | 抽 `ToolExecutionPipeline.ts`(~500 行):tool batch → dependency graph → streaming executor 串联 |
| 2c | `refactor(agent): extract CompactionCoordinator (compaction policy)` | 抽 `CompactionCoordinator.ts`(~350 行):422/495/517 的 compaction 触发、协调、cooldown、over_threshold 制动 |
| 2d | `refactor(agent): extract PermissionsGate + VisualAnalysis + Scratchpad` | 抽三个独立模块,每个 < 300 行 |
| 2e | `refactor(agent): DuyaAgent reduced to facade (<800 lines)` | 删除已抽出代码,DuyaAgent 收尾为 facade |

### PR #3: Dependency-Graph Orchestration

| # | Commit | 范围 |
|---|---|---|
| 3a | `feat(tool): add ToolDefinition.dependencies schema` | `BaseTool` 加 `dependencies?: { read?: string[]; write?: string[] }` 元数据;每个自研工具声明 |
| 3b | `refactor(tool): replace batch orchestration with DependencyGraphOrchestrator` | 删 `TOOL_BATCH_MAP` + `BATCH_STRATEGY`,新 `DependencyGraphOrchestrator.ts` 用 topo sort + concurrency limiter |
| 3c | `refactor(tool): StreamingToolExecutor wired to dependency graph` | `StreamingToolExecutor.runBatch` 改成 `runDependencyGraph` |
| 3d | `test(tool): add end-to-end parallel tool execution tests` | 覆盖 4 场景:all-read / read+write(独立路径) / write+write(同文件串行) / write+write(不同文件并行) |

## Testing Gates

每个 commit 之前必须:

- [ ] `npm run typecheck:all` 全绿
- [ ] `npm run test --workspaces -- --run` 单测全绿
- [ ] 触及 prompt 系统时,跑 `prompts/__tests__/prompt-system.test.ts` 确认输出字节级一致
- [ ] 触及 agent 循环时,跑 `agent/__tests__/duya-agent.test.ts` + 集成 smoke

每个 PR 之前:
- [ ] 三遍整体检查:
  1. 跨文件 import 完整性
  2. 与 plan 429 P0/P1 任务的兼容性(checkpoint / PreToolUse / failover)
  3. 与 bot 模式 / research mode / plan-mode 的兼容
- [ ] `git diff --stat` 评估改动体量符合预期
- [ ] CHANGELOG / ARCHITECTURE.md 同步更新

## Risks

| 风险 | 概率 | 缓解 |
|---|---|---|
| Prompt 改 hbs 后内容变化导致 LLM 行为偏移 | 中 | 1b / 1c commit 后跑字节级 diff 测试,确保除模板语法外文本完全一致 |
| DuyaAgent 拆层破坏隐性调用顺序 | 中 | 2a-2d 每次抽出后跑全套测试;2e 最后收尾时再做完整集成测试 |
| Dependency graph 在 write/write 同文件场景失去串行约束 | 低 | 3a schema 设计时显式声明 `write?: [path]`;3c 的 topo sort 必须按 `write` 字段判定串行 |
| MCP 工具没有声明 dependencies 导致全并行 | 中 | 3a 默认 `dependencies = { read: [], write: [] }`;MCP 工具继承 base 实现,行为不变 |
| Bot / research / plan-mode 各自的 prompt system 各自有定制,迁移时漏掉 | 中 | 1b 列出所有 prompt system 实例,逐个迁移不批量替换 |

## Out of Scope (后续 plan 候选)

- 自研 prompt 模板编辑器(in-IDE .hbs 高亮 + 预览)
- handlebars helper 扩展(自定义 {{#tool_list}} / {{#mcp_servers}})
- 自动化 prompt A/B 测试框架
- dependency graph 可视化(用于 review)

## Reference

- `E:\cloned-projects\minimax-code\packages\agent-core\src\pi-turn-runner\pi-turn-runner.ts:182-188` — mcode 的并行工具调用设计
- `E:\cloned-projects\minimax-code\packages\local-runtime-v2\assets\agents\mavis\system-prompt.md.hbs` — mcode 的 .hbs 模板范例
- `E:\cloned-projects\minimax-code\packages\local-runtime-v2\src\service\agent\builtin\prompt-renderer.ts` — mcode 的 Handlebars 渲染器实现
- `packages/agent/src/prompts/PromptSystem.ts:35-37` — duya 自警告"will break prompt caching"
- `packages/agent/src/tool/orchestration/types.ts:12-31` — duya 当前 batch 调度策略
- `packages/agent/src/agent/DuyaAgent.ts` — duya 4473 行主类(将拆层)