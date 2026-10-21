# 422 — 压缩全面对齐 grok

> **状态**：✅ 完成（2026-09-03，P3.4/G2 收口归档）

> **目标**：DUYA 压缩策略收敛为**单一 grok 式设计**。当前 DUYA 有 4 套策略冗余（`micro`/`session_memory`/`snip`/`reactive`），且基础是 pi 式（summary + retainedTail）。用户评估后判定 **grok 的压缩设计更优**，故本方案**全面对齐 grok**：单一策略 + grok 式重建会话 + grok 式健壮性网络。
>
> **范围**：只收敛"LLM 上下文压缩策略"（`packages/agent/src/compact/`）。不含投影层压缩（`projectionCompress.ts`，plan 412）。保留已完成的 MessageLog 文件幂等修复（前序产出）。

---

## 0. 当前工作区状态（写方案时已改动）

- ✅ 删除 `strategies/MicroCompactStrategy.ts`、`SnipCompactStrategy.ts`、`ReactiveCompactStrategy.ts`
- ✅ `strategies/index.ts`、`compact/index.ts` 仅导出 `SessionMemoryCompactStrategy`
- ✅ `PostCompactReinjector.ts` 内联 `FileStateEntry` + `extractFileState`
- ✅ `CompactionManager.ts` 移除 micro/snip/reactive 的 import 与配置字段（`selectStrategy`、`reactiveCompact` 等待清理）
- ✅ 已删除死代码双路径：`agent/types.ts` + `agent/agent-loop.ts`（无运行时调用方；压缩触发全部收敛到 `DuyaAgent.streamChat` 单一实现）

---

## 1. grok 压缩完整实现（研究结论，精炼自 `E:\cloned-projects\grok-build`）

### 1.1 触发与两遍时间线

- **阈值**：`auto_compact_threshold_percent = 85`（`xai-grok-agent/src/compaction.rs:12,39`）。
- **prefire 提前量**：`prefire_lead_percent = 10` → 后台 pass1 在 **75%** 启动（`compaction.rs:38-44,216-225`）。
- **每轮挂点**（`turn.rs:2092-2115`）：先判 prefire（75% 后台起 pass1），再判 auto-compact（85% 同步压缩）。
- **错误触发**：采样失败且模型 `context_window < 当前估算` 时走 `CompactAndResubmit`（`sampler_turn.rs:846-873`）。

### 1.2 两遍 prefire（`two_pass.rs` + `compaction.rs`）

- `split_conversation_for_two_pass(conversation, 0.95)`：按 token 权重切，prefix 占 **95%**，tail 占 **5%**（`two_pass.rs:12,30-50`）。
- `snap_split_idx_to_tool_boundaries`：切点绝不拆开 assistant `tool_calls` 与其 ToolResult（`two_pass.rs:53-123`）。
- **pass1（后台，不阻塞）**：`run_prefire_pass1` 总结整个 prefix → 产出 `NOTE₁`，缓存到 `PrefireState`（`compaction.rs:243-336`）。
- **pass2（阻塞，用户等）**：`build_two_pass_pass2_history(prefix, tail, note1, prompt)` = `[System, <summary_content>NOTE₁</summary_content>, tail, 特殊两遍指令]` → 产出最终 `NOTE₂`（`two_pass.rs:242-269`）。tail 只 5%，所以 pass2 的 prefill 延迟最小。
- **前缀指纹失效**：`fingerprint_prefix` 哈希 prefix 每项 `(len, tag, text)`；pass2 时若 `fingerprint_prefix(&live[..prefix_len]) != cache.fingerprint`（edit/rewind/branch），缓存作废回退单遍（`compaction.rs:48-65,385-396`）。

### 1.3 重建会话（`compaction_utils.rs:839-882`）

固定顺序：

```
1. system_message
2. user_message_prefix（<user_info>…，不套 <user_query>）
3. AGENTS.md / 项目指令（cwd_generation==0 用 agents_md_reminder，否则 destination_project_instructions）
4. last_user_query（最近真实用户查询，套 <user_query>…</user_query>）
5. recent_messages（grok-build 默认空——[for_compaction() 丢弃整个工作尾]）
6. summary（format_compact_summary_content = 清洗 + "This session is being continued…" 前言，user_meta 载体）
7. system_reminder（运行中后台任务/子代理/编辑文件/MCP/todos/plan）
```

关键：**grok-build 丢弃 recent tail，只留总结**（`compaction_utils.rs:612-617` `for_compaction()` 置空 recent），并**重注入** AGENTS.md + last_user_query + system-reminder。

### 1.4 总结 prompt（`session_compact.rs`）

- **长 prompt（默认）** `build_compaction_prompt`（`session_compact.rs:147-194`）：9 个编号段 `1.Primary Request and Intent / 2.Key Technical Concepts / 3.Files and Code Sections(要求完整代码片段) / 4.Errors and Fixes / 5.Problem Solving / 6.All User Messages(禁把压缩指令当用户消息) / 7.Pending Tasks / 8.Current Work / 9.Optional Next Step(含最近消息 verbatim 引用)`；输出包在单个 `<summary>…</summary>`；**禁止调用工具**；跨压缩把 prior `<conversation_summary>` 视为权威带入。
- **两遍 prompt** `build_two_pass_compaction_prompt`（`session_compact.rs:200-227`）：5 段（省略 Files/AllUser/Pending/Current，由 prefix/tail 覆盖）。
- **流式生成** `generate_session_compact`（`session_compact.rs:418-822`）：把与 turn 相同的 tool 定义附加到压缩请求，**逐字节复用前缀 → 复用 KV cache**；墙钟预算超限即 Transient 失败。

### 1.5 健壮性网络（grok 独有，DUYA 对齐重点）

| 机制 | 实现 | 作用 |
|---|---|---|
| 工具输出预算 | `fit_conversation_to_budget` + `recover_truncated_tail_unit`（`compaction_utils.rs:128-195`） | 把 recent 压进预算；保最近一个 tool round-trip |
| input 阶梯降级 | `Verbatim → VerbatimFitted → Lossy`（`compaction.rs:1057-1215`） | 上下文溢出时降级而非失败 |
| tool-call 不变式 | `validate_compacted_history` / `sanitize_compacted_history`（`compaction_utils.rs:900-961`） | 每个 ToolResult 必须有前置匹配 tool_call，否则剥离孤儿 |
| 退化总结 | `is_degenerate_summary`（<500 chars）+ `format_compact_summary` 清洗（`compaction_utils.rs:636-728`） | 检测空/垃圾总结，重试 |
| 错误分类+抑制 | `CompactFailure::{Deterministic,Transient,Cancelled}` + `SuppressReason`（`session_compact.rs:41-125`、`compaction.rs:443-709`） | 4xx 除 408/429 判确定性，按 scope 抑制 auto-compact |
| 墙钟预算 | `wall_clock_budget_secs=300`（`compaction.rs:26`） | reasoning 逃逸时 max_tokens 拦不住的后备 |
| 内存冲刷 | `memory_flush_enabled` + `run_memory_flush`（`compaction.rs:536-575`） | 压缩前把重要信息写 memory |
| 独立压缩模型 | `compact_model`（`compaction.rs:16`） | 专用总结模型 |
| 落盘/恢复 | `checkpoint` + `segment`/`transcript`（`compaction_mode.rs`、`compaction_segments.rs`） | 磁盘保留原始历史，模型按需恢复 |

---

## 2. DUYA vs grok 差距矩阵

| 维度 | grok | DUYA 现状 | 差距 |
|---|---|---|---|
| 存储模型 | in-memory 替换 + 磁盘 transcript/segment | append-only timeline + CompactionEntry（plan 315）✅ | 基础更好，保留 |
| 重建顺序 | system+prefix+AGENTS.md+last_query+recent(空)+summary+reminder | `buildAgentContext` 仅 `[summary, ...retainedTail]`（pi 式） | **缺** AGENTS.md/last_query/reminder 重注入 |
| recent tail | 默认丢弃（summary-only） | 保留 retainedTail | 需改为 grok（可选保留） |
| 总结 prompt | 9 段结构化 + <summary> 包裹 + 禁工具 | session_memory 的 Goal/Progress/Decisions | **缺** 9 段 + prior-summary 权威 |
| 增量更新 | prior summary 权威带入 | session_memory 有 previousSummary | 已有，对齐措辞 |
| tool-call 不变式 | validate/sanitize | 仅 `findSafeCompactionBoundary`（向后找 user） | **缺** sanitize 孤儿剥离 |
| 退化检测 | is_degenerate_summary | 无 | **缺** |
| 错误分类+抑制 | Deterministic/Transient + suppress | 仅 circuit breaker（失败≥3） | **缺** 确定性分类/scope 抑制 |
| input 阶梯 | Verbatim→Fitted→Lossy | 无（依赖投影层） | **缺** |
| 墙钟预算 | 300s | 无 | **缺** |
| 两遍 prefire | 后台 pass1 + 指纹失效 | 无 | **缺**（性能优化） |
| 内存冲刷 | 压缩前写 memory | 无（有独立 memory 系统） | 可选 |
| 独立压缩模型 | compact_model | 无 | 可选 |
| 策略数量 | 1 | 4（已删 3） | 收敛✅ |

---

## 3. 对齐目标与设计（收敛为单一 grok 式策略）

### 3.1 保留的基础（不动）
- `MessageCompactionController` + `CompactionEntry` append-only（plan 315）。
- `MessageLog` 文件幂等（前序修复）。
- `MessageTimeline.buildAgentContext` 的 compaction overlay 机制。

### 3.2 单一策略：grok 式 `SessionMemoryCompactStrategy`（改造）
删除 micro/snip/reactive（已删），把 `SessionMemoryCompactStrategy` 改造成 grok 式：

1. **切割**：保留 `findCutPoint`（pi/grok 同源），但**对齐 grok 丢弃 recent tail**（或保留可配置）。
2. **重建**：压缩后重建为 `[system, user_prefix, AGENTS.md, last_user_query, summary, system_reminder]`（grok 顺序），而非 `[summary, ...retainedTail]`。
3. **提示词**：改用 grok 9 段总结 prompt（含 <summary> 包裹、禁工具、prior-summary 权威、禁把指令当用户消息）。
4. **触发**：`strategy` 恒为 session_memory；阈值 85% + prefire 75%（后台 pass1，可选）。
5. **CompactionEntry**：`applyCompactionResult` 把重建结果转成 entry（记录 compacted ids、firstKept、summary、tokens）。

### 3.3 新增健壮性（分阶段，见 §4）
tool-call sanitize、退化检测、错误分类+抑制、input 阶梯、墙钟预算、两遍 prefire、内存冲刷、独立压缩模型。

---

## 4. 分阶段实施

### Phase 1 — 收敛 + grok 式重建（核心，先做）
- [x] **P1.1** CompactionManager 收敛：只注册 session_memory；`selectStrategy` 恒 session_memory；删 `reactiveStrategy`/`reactiveCompact`/`onFileChange`/`onToolCall`/`registerFileChange`/`registerToolCall`/`enableReactive`。
- [x] **P1.2** reactive 调用点路由：`DuyaAgent.streamChat` 的 `compactReactive(...)` → `compactProactive()`。`agent-loop.ts` 为无运行时调用方的死代码，已整体删除。
- [x] **P1.3** 清理接口：`MessageCompactionController`（删 `compactReactive` + `CompactionManagerLike.reactiveCompact`）、`CompactionStore`、`agent/types.ts`、`agent/session/compaction.ts`。
- [x] **P1.4** 改造 `SessionMemoryCompactStrategy` 为 grok 式重建（system+prefix+AGENTS.md+last_query+summary+reminder），提供可配置 recent tail。
- [x] **P1.5** 引入 grok 9 段总结 prompt + <summary> 包裹 + 禁工具 + prior-summary 权威。
- [x] **P1.6** 更新测试：`CompactionManager.test.ts`、`message-compaction-controller.test.ts`（删 reactive 块）、`SessionMemoryCompactStrategy.test.ts`（适配新重建形状）。
- [x] **P1.7** 全仓 grep 清理 `micro`/`snip`/`reactive`/`reactiveCompact`/`compactReactive` 残留。

### Phase 2 — grok 健壮性（增强，随后）
- [x] **P2.1** tool-call 不变式：`sanitize_compacted_history`（剥离孤儿 ToolResult）+ `validate_compacted_history`，接入重建后。
- [x] **P2.2** 退化总结：`is_degenerate_summary`（<500 chars 重试）+ `format_compact_summary` 清洗（<analysis>/scratchpad 剥离）。
- [x] **P2.3** 错误分类+抑制：`Deterministic/Transient/Cancelled` 分类 + scope 抑制（替代粗暴 circuit breaker）。
- [x] **P2.4** input 阶梯降级：Verbatim→Fitted→Lossy（context overflow 时）。
- [x] **P2.5** 墙钟预算：压缩采样超时即 Transient。

### Phase 3 — 性能/可选（按需）
- [x] **P3.1** 两遍 prefire：后台 pass1 + 前缀指纹失效（`spawn_local` 并行）。
- [x] **P3.2** 独立压缩模型 `compact_model`。
- [x] **P3.3** 内存冲刷（接 DUYA memory 系统）。
- [x] **P3.4** segment/transcript 落盘恢复（可选，DUYA 已有 rollout 全量保留）。

  > **P3.4 决策记录（2026-09-03）**：**won't-fix**。grok 的 segment/transcript 落盘是为"压缩后内存只留 summary、原文按需从磁盘 segment 恢复"服务的；duya 存储模型不同——append-only timeline + CompactionEntry（plan 315）叠加 rollout JSONL 全量保留（plan 441 per-event journal，含压缩 rebase 事件），压缩前的原始历史始终完整落盘可回放，恢复路径 = 读 rollout。再建一套 segment/transcript 双写属冗余；未来若需"原文按需检索"，应在 rollout 读侧做，不改写侧。

### 全局
- [x] **G1** 验收：`npm run typecheck:all` + 单测（`Compact/*`、`message-compaction-controller`、`message-*`）；DB 测试需关闭应用后 `rebuild:node` 再跑。
- [x] **G2** 文档：更新 `ARCHITECTURE.md` 压缩策略为单一 grok 式；更新 exec-plans README；完成后移入 `completed/`。（2026-09-03 完成：ARCHITECTURE.md 新增 "Context Compaction" 节；README active 表移除、completed 表登记）

---

## 5. 验收标准

- [x] 仅剩单一 `session_memory` 策略，无 `micro`/`snip`/`reactive`/`compactReactive` 残留。
- [x] 压缩重建顺序对齐 grok（system→prefix→AGENTS.md→last_query→summary→reminder）。
- [x] 总结 prompt 为 grok 9 段 + <summary> 包裹 + 禁工具 + prior-summary 权威。
- [x] tool-call 不变式、退化检测、错误分类在工作。
- [x] `prompt_too_long` overflow 仍能降级（走 `compactProactive`）。
- [x] typecheck:all + 相关单测全绿；真实 rollout 验证无 36x 重复。

---

## 6. 风险与回滚

- **风险**：丢弃 recent tail 可能丢失近况。缓解：grok 默认如此 + AGENTS.md/last_query/reminder 重注入补偿；做成可配置。
- **风险**：9 段 prompt 使总结更慢/更贵。缓解：独立 `compact_model` + 墙钟预算 + 两遍 prefire。
- **风险**：删 reactive 影响 overflow 恢复。缓解：路由到 `compactProactive`。
- **回滚**：策略文件可用 `git checkout -- packages/agent/src/compact/` 恢复；422 计划文件保留决策记录。