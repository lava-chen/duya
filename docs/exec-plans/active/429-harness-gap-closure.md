# Plan 429: Harness Gap Closure — 现代 Agent Harness 核心差距整改

> **Status**: Planning（证据核验完成，分项方案已定，待按建议顺序开工）
> **Priority**: P0（首项）/ P1（其余）
> **Created**: 2026-08-17
> **Related**: [426-hook-loop-bus](../completed/426-hook-loop-bus.md)（hook 运行时底座，已完成）、[87-hook-system-full-enhancement](./87-hook-system-full-enhancement.md)（PreToolUse 其余事件）、[97-tool-path-permission-refactor](./97-tool-path-permission-refactor.md)（沙箱路径约束）、[310-multi-model-reasoning-architecture](./310-multi-model-reasoning-architecture.md)（模型路由）、[37-subagent-nested-session](./37-subagent-nested-session.md)（子代理 UI）、[308-turn-review-history](./308-turn-review-history.md)（per-turn delta，仅展示）、[243-session-search-overhaul](./243-session-search-overhaul.md)（FTS5）

---

## Problem（背景与触发原因）

对照 Claude Code / Codex CLI / Cursor / Amp / Grok 这一代 harness，duya 底层不落后甚至局部领先（多进程隔离 + Resource Governor、append-only 消息时间线 + 压缩 checkpoint、按需工具发现 + deferred tools、后台子代理 + 异步通知、Mode 状态机、memory curation、prompt caching、技能系统、config.toml 自定义 agent）。真正的差距集中在**确定性、反馈闭环、信任面、可见性**四个维度。

本文是一份**差距整改总纲**：先记录证据核验结论（含两处待补证据点与一处关键修订），再给出分项实施方案（每项独立可并行排程、可独立验收）。

> ⚠️ **重要修订**：预案稿曾断言 `packages/agent/src/hooks/` 只有 `types.ts` 单文件、无运行时。该判断**已被 plan 426（2026-08-17 完成）推翻** —— hook-loop 总线运行时已落地并接入主循环。因此"验证闭环"与"hooks 运行时"合并为同一件事，实现成本大幅下降。

---

## 证据核验结论（已核实，2026-08-17）

### 证据点 A：编辑后自动验证注入 —— 可行性已就位，产品化闭环缺失

- **工具层自动验证：不存在。** `packages/agent/src/tool/EditTool/EditTool.ts`、`WriteTool.ts`、`ApplyPatchTool.ts` 均无 post-apply 打 lint/typecheck 的代码。
- **显式验证工具：已有，但为"激发式"非"自动"。** `packages/agent/src/tool/SubagentTool/built-in/verificationAgent.ts` 存在，是模型可选调用的独立验证子代理，非编辑后自动触发。
- **可注入点基础设施：已就位。** plan 426 的 `config-loop.ts` 提供 PostToolUse 配置钩子：匹配 `Edit|Write|ApplyPatch` 工具名后执行 `type:"command"`，命令 stdout 经 `executor.ts` 转为 `additionalContext`，并通过运行时注入通道塞入下一轮模型上下文。
- **结论**：缺的是三处收口 —— 项目级声明式开启 + 验证失败不吞 + 诊断信息结构化回灌。

### 证据点 B：MCP 传输支持面

- SDK：`@modelcontextprotocol/sdk ^1.29.0`（`packages/agent/package.json`）。
- 支持传输：**仅 `stdio`（默认）与 `streamable-http`（需 `url`）**，见 `packages/agent/src/mcp/index.ts` L150-178 分支。
- 配置面：`transport` 可取值 `stdio` / `streamable-http`；`configSignature`（L361-373）将 `transport/url/headers/command/args` 纳入连接指纹，热重载按传输差异决定重连。
- **结论**：覆盖本地进程与远程 URL 两类主流场景即可，无需单列改进项，仅在建议 5（远程 App Connection）中作为既有能力复用。

### 其余建议现状（已核实）

- **Checkpoint（建议 3）**：Edit/Write/ApplyPatch 均无 pre-image 备份；`rewriteSession` 只回退对话时间线，不触及磁盘；plan 308 的 per-turn git delta 仅为展示用非恢复机制。→ 数据完整性空白成立。
- **沙箱（建议 4）**：`sandbox/bubblewrap-sandbox.ts` 仅 Linux，Windows 靠 `docker-sandbox.ts`；`BashClassifier` 按 ARCHITECTURE.md 自述仍为 stub。
- **故障转移（建议 5）**：`packages/ai/src/runtime-adapter.ts` 只有 apiFormat 防御性 fallback，无模型级转义；Research fanout / Goal skeptic / 422 compact_model 是天然便宜模型路由点。
- **子代理 UI（建议 6）**：SubagentTool 已 `run_in_background` 默认 + `get_task_output`/`kill_task` + task-notification；前端无嵌套会话树（plan 37 Planning）。

---

## 建议 1：编辑验证闭环（质量杠杆最大，P0 首选）

> 底座已由 426 提供，本项为 4 个收口，非新建运行时。

### Phase 1A — 配置示例开路（0 代码）
- [ ] 在 `~/.duya/config.toml` 提供模板注释，例如：
  ```toml
  [hooks]
  PostToolUse = [{ matcher = "Edit|Write|ApplyPatch|MultiEdit", hooks = [
    { type = "command", command = "npm run typecheck:all 2>&1 || true" },
  ]}]
  ```
- [ ] 评估 `matcher` 正则与 tool 名对齐（`packages/agent/src/hooks/config-loop.ts` L134-145 的 `patternMatches`）。

### Phase 1B — 验证失败不吞（核心收口）
- [ ] `packages/agent/src/hooks/executor.ts`：当 `type:"command"` 退出码非 0 时，将 `stderr` 前 512B 合并为诊断（近期 `executeHookCommand` L91-100 目前返回 `ok:false` → 被调用方丢弃）。
- [ ] `packages/agent/src/hooks/config-loop.ts`（L83-90）：对 `result.ok === false` 告别 `continue`+`logger.warn`，改为在 `hook.type==='command'` 且退出码非 0 时把错误诊断合入 injection，而非静默丢弃。
- [ ] 新增测试：仿真命令退出非 0，断言诊断进入下一轮注入。

### Phase 1C — 粒度与语义收口
- [ ] 明确文档语义：当前 PostToolUse 为 per-turn 一次性分发（`buildHookInput` 注释，config-loop.ts L99-115），匹配规则为"本轮任 Edit/Write 触发一次验证"。
- [ ] 若需"每次 edit 立即验证"，跟随建议 2 的 per-tool 分发一并解决。

### Phase 1D — 声明式开关
- [ ] 决定是否引入独立配置节（如 `[project.verifier]`）抑或直接复用 `[hooks]`。默认方向：复用 `[hooks]`，仅当需要"默认对全部项目开启"时才下沉为内建（可泛化为 plan 413 的 mode modifier）。

**验收**：配置一个命令钩子后，编辑文件 → 验证自动跑 → 失败诊断进入下一轮模型上下文；无提示词依赖。

---

## 建议 2：补齐 hook 事件面（PreToolUse 阻断 & per-tool 粒度）

426 已交付带否决权的 PreFinalize 总线，但**未桥接 PreToolUse（阻断）与其余非循环事件**（`config-loop.ts` L31、L57-64 对它们 WARN+skip；`config.ts` L121-136 "Phase 4, scoped"）。

- [ ] 在 `packages/agent/src/hooks/loop.ts` 的 `LoopHookEffect` 上扩展一个阻断效应：`{ type: 'block_tool', toolName, reason }`（对应 `types.ts` 的 `deny` branch）。
- [ ] 在 `DuyaAgent` 工具执行前（现 `gateWriteTool` 等 per-tool 检查点所在印制点）增加一个 dispatch 点，与现有校验井水不犯河水。
- [ ] PreToolUse per-tool 分发顺带解决建议 1.3 的粒度。
- [ ] 本项为 plan 87 的运行时部分正式归属；落地后视作 plan 87 运行时完成。

---

## 建议 3：文件级 Checkpoint / Rewind（唯一未排期、最保值的数据完整性项）

> **实现进度（2026-08-24，全项完成）**：快照存储在
> `packages/agent/src/tool/file-snapshot-store.ts`（内容寻址
> `~/.duya/snapshots/<sha256>.blob`，天然去重），封装在
> `file-snapshot.ts` 的 `withFileSnapshot`。Edit/Write/ApplyPatch 已接入：
> Edit → `metadata.preImageSha`（见 `EditTool.ts` `executeEdit`），
> Write → `metadata.preImageSha`（`WriteTool.ts`），
> ApplyPatch → `metadata.fileSnapshots: {path, preImageSha}[]`（多文件语义）。
> 快照写入为 best-effort，绝不使工具失败。单测见
> `packages/agent/src/tool/__tests__/file-snapshot.test.ts`（8 用例）。
>
> 2026-08-24 补齐消费端：持久化适配器白名单透传 `preImageSha/filePath/
> fileSnapshots`（`core-db-adapters.ts`）；rewind 联动在 truncate* 处理器内、
> 时间线收缩前执行恢复，并新增独立 `db:files:restore` IPC；UI toast 提示
> "Restored N files"（ChatView 编辑重发路径）。清理策略由启动期延迟扫描
> `snapshot-gc.ts` 承担（无 rollout 引用且超 24h 的 blob 删除）。测试：
> `electron/services/__tests__/file-snapshot-restore.test.ts`（15 用例）、
> `electron/services/__tests__/snapshot-gc.test.ts`（4 用例）、
> `core-db-adapters.test.ts` 元数据白名单用例。`typecheck:all` 全绿。

- [x] **快照库**：`FileSnapshotStore`（内容寻址，`~/.duya/snapshots/<sha256>.blob`）。
- [x] **pre-image 引用**：Edit/Write → `metadata.preImageSha`；ApplyPatch → `metadata.fileSnapshots[]`。
- [x] **rewind 联动**：`rewriteSession` 回退某 turn 时，将该 turn 之后被改文件的 `preImageSha` 逐个写回磁盘，并在 UI 明示"已恢复 N 个文件"。端点规划：主进程新增 `files:restore` IPC（输入 `{sessionId, cutMessageId}`），读被截断 tool_call 的 `metadata.preImageSha`/`fileSnapshots`，经 `FileSnapshotStore.get()` 取回原样写盘（cwd 由 `sessions.working_directory` 解析）。（2026-08-24：truncate* 处理器内联恢复 + 独立 `db:files:restore`；工具记录的是绝对路径，无需 cwd 解析）
- [x] **清理策略**：快照随其所属 turn 一起保留/压缩，与已有 rollout 压缩 checkpoint 生命周期一致。（2026-08-24：`snapshot-gc.ts` 启动延迟扫描 —— rollout 无引用且超 24h 宽限期的 blob 删除）
- [x] 测试：写文件 → 回退 → 断言磁盘文件恢复到 pre-image。（`file-snapshot-restore.test.ts` 覆盖含重复编辑同路径时最旧 pre-image 胜出）

> 利用 duya 单一写者 + append-only 架构的天然优势。

---

## 建议 4：Windows 一等公民沙箱（拆两层）

- [ ] **L1 软隔离（低成本，立即）**：把 `BashClassifier` 从 stub 做成真实规则分类器 + 路径写约束，与 plan 97 path-permission-refactor 合流；不引入新进程模型。
- [ ] **L2 硬隔离（中成本，决定 bypass 可信度）**：Windows restricted-token / Job Object（限制文件系统 + 网络 ACL）+ BashWorker 默认禁网、按需放行。
- [ ] 作为 Gateway / 无人值守场景的安全前提。

---

## 建议 5：模型故障转移与路由

- [ ] **provider fallback chain**：`packages/ai/src/runtime-adapter.ts` 的 stream 入口包一层 —— overload/5xx/网络错误抛 `RetryableError`，向配置的下一个 `(provider, model)` 重试 + 用户通知；不碰主干控制器。
- [ ] **per-role model 配置**：在现有 model 配置旁加 `fanout_model` / `skeptic_model`（422 已有 `compact_model`，天然延伸），先在 Research/Goal 落点，不必等 plan 310。

---

## 建议 6：子代理并行 UX 收口（纯 UI，成本最低）

- [ ] 复用 plan 37 现有规划输出 agent tree；前端补充嵌套会话树。
- [ ] 配合 Conductor 画布场景：子树可直接成为画布节点。

---

## 次要提及

- 会话搜索：plan 243 建议直接上 SQLite FTS5（core-db 已由 326/328 铺垫）。
- 已领先的线（memory curation / mode 状态机 / 按需工具发现）：深化而非对齐。

---

## 排期与优先级逻辑

```
建议 1（验证闭环）> 建议 3（checkpoint）> 建议 2（PreToolUse）> 建议 4 L1（沙箱）> 建议 5（failover）> 建议 6（子代理 UI）
```

建议 1 因 426 已给底座而成本骤降、用户感知最强；建议 3 从未排期、数据完整性保值最高；建议 2 与建议 4 L1 是自动化模式可信度的两块基石，可并行排程；建议 5/6 为稳定性与可见性增益，按序推进。

---

## Testing

- [ ] 建议 1：`packages/agent/src/hooks/__tests__/executor.test.ts` 增补非 0 退出诊断用例；`config-loop` 增补失败不吞用例。
- [x] 建议 3：`FileSnapshotStore` + rewind 联动单测。
- [ ] 建议 2/4：PreToolUse 阻断单测 + BashClassifier 规则单测。
- [ ] 全量：`npm run typecheck:all`（esbuild 不做类型检查，提交前必须跑）+ 相关 `vitest run`。
- [ ] DB 相关测试需先 `npm run rebuild:node`（参见 AGENTS.md footgun：`npm install` 后 Electron ABI 与 Node ABI 不匹配）。

## Non-Goals

- 不新建独立 harness 框架；全部对齐并复用 426 的 hook 总线与既有工具协议。
- 建议 5 不做完整 plan 310 多模型架构，仅做 fallback chain + per-role model 配置。
- 子代理 UI 不改变后端 SubagentTool 语义。