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

## Progress (2026-09-19, end of session 3)

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
| **改造 2 — remaining** (2a-6 replace local reads with turnContext, 2b ToolExecutionPipeline, 2c CompactionCoordinator, 2d PermissionsGate/VisualAnalysis, 2e DuyaAgent facade) | — | ⏳ next session |
| 1d-rest 8 remaining dynamic sections + gateway/code/research configs + delete `general/sections/*.ts` | — | ⏳ follow-up PR |
| 3c StreamingToolExecutor wiring | — | ⏳ next session |
| 3d end-to-end coverage | — | ⏳ next session |

## Next-session starting points

- **改造 2a-6**: `packages/agent/src/agent/DuyaAgent.ts:800+` — replace
  the local field reads scattered through `streamChat` (turnId,
  sessionId, workingDirectory, communicationPlatform, language,
  permissionMode, hostToolPermission, additionalWorkingDirectories,
  _turnAlwaysAllowTools) with `turnContext.xxx` reads from the
  TurnContext assembled in 2a-5. One field per atomic commit so the
  diff stays reviewable.
- **改造 3c**: `packages/agent/src/tool/StreamingToolExecutor.ts` —
  replace the legacy batch-by-batch execution in `runBatch` with a
  `planExecution` + wave-by-wave loop. The orchestrator is pure (3b);
  wiring is the only remaining mechanical work.
- **改造 2b/2c/2d/2e**: extract `ToolExecutionPipeline` / `CompactionCoordinator` /
  PermissionsGate / VisualAnalysis from DuyaAgent.ts in that order; end
  with `DuyaAgent` reduced to a facade.
- **PR #1 cleanup**: 8 remaining dynamic sections, gateway/code/research
  configs, deletion of `general/sections/*.ts`.

## Session 3 summary

This session landed 15 atomic commits across all three plan
directions, taking the work from "no infrastructure" to "the
infrastructure is complete and the wiring anchor is in place". The
remaining work is mechanical (substituting field reads, extracting
sub-modules, wiring the orchestrator into StreamingToolExecutor)
and naturally splits across multiple follow-up sessions — none of
those follow-ups needs to re-touch the design work done here.

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