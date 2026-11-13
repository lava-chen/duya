# 多 Agent 协作工具能力实测

对 `task` 子代理派发面与跨会话协作面的实测结论。审计在真实运行的 Duya 桌面上派发真实子代理、读真实源码与运行日志得出，不是文档推断。

- 审计日期：2026-10-31
- 源码基线：`a33bbb0542f5effeb8484a64f8ca2cf217272e87`（master）
- 复核基线：`4f0738bae34777cce45308291f3207f90e6705a1`（PR #561 合并后）。审计涉及的 4 个包目录在两个基线间**逐字节一致**（`git diff --stat` 为空），结论在复核基线上同样成立
- 环境：Windows 11 Pro 10.0.26200 · Node v24.16.0 · npm 11.13.0 · Duya 桌面 dev 构建
- 原始探针逐字记录：见[附录](#8-附录探针逐字记录)。审计运行的子代理 transcript 与运行日志留在本机，未纳入 Git

## 结论

12 项能力实测，**9 项可用，3 项失效**。三项失效都不是「功能未做」，而是**已实现但未生效**：参数被正确解析、正确传达到 Host、正确写入运行日志，但最终不影响子代理实际能调用什么。

| 能力 | 判定 | 关键证据 |
| --- | --- | --- |
| 并行后台子代理 | 可用 | 3 个同批派生，时间窗重叠（39 / 33 / 30 次工具调用），总耗时≈max 而非 sum |
| 前台阻塞模式 | 可用 | `run_in_background:false` → 3733 ms 内联返回 |
| `kill_task` | 可用 | 返回 `{"outcome":"killed"}`，完成通知为 `status=failed` |
| `auto_wake:false` | 可用 | 无 `<task-notification>`，`get_task_output` 仍取到完整结果 |
| `max_turns` | 可用 | `max_turns:1` → 只跑一轮工具调用即被截断，未产出最终答案 |
| `effort` / `model` 覆盖 | 可用 | `effort:"off"`、`model:"MiniMax-M3"` 均被接受，无校验错误 |
| 子代理注册为子会话 | 可用 | `session list` 能列出 `probe-*` 子会话 |
| 会话级 worktree 隔离 | 可用 | `session spawn use_worktree` → 独立检出 + 独立分支，标记文件只落在 worktree，`+1/-0` 差异，回收干净 |
| `SessionSearch` / `session list` | 可用 | 检索与列举正常 |
| **`tools.allow` / `tools.deny` 覆盖** | **失效** | 4 组探针：deny 后 `read`/`grep` 仍正常执行；allow `["read"]` 后 `glob` 仍可执行 |
| **`resume_from`** | **失效** | 回执里的 `subagent_id` → `not a known session id`；另两个 id → `has no prior messages to continue` |
| **`MessageSession` 跨会话** | **失效** | 3 次尝试全部 `interagent local timeout`（45 / 90 / 150 s） |

另有两项可用但带硬约束，详见[第 5 节](#5-可用但有约束的能力)。

---

## 1. 范围与方法

审计对象是 `task` 子代理派发面的 12 项能力：并行派生、终止、通知抑制、参数覆盖、工具收窄、会话续接、工作区隔离，以及跨会话检索与投递。

方法：向真实运行的 Duya 桌面端派发真实子代理，每个探针带自述的判定要求（返回「成功/被拒」与逐字错误消息），并把运行日志作为独立证据源交叉核对。运行日志位于 `~/.duya/logs/agent/agent-<sessionId>.log`，含 `[SubAgent] run starting`（带 `toolCount` / `toolNames` / `toolOverlayDropped`）与 `[SubAgent] Agent tool invoked`（带 `toolOverlay`）两行。

不覆盖：workflow 引擎的 DAG 调度（见[多 Agent 编排计划](../exec-plans/active/2026-10-23-multi-agent-orchestrator.md)）、UI 侧多 agent 视图、跨宿主协议。

## 2. `tools.allow` / `tools.deny` 覆盖失效

### 现象

| 探针 | 覆盖参数 | 期望 | 实测 |
| --- | --- | --- | --- |
| deny-大写 | `deny:["Read","Grep","Glob","Bash"]` | 4 个工具不可调用 | `read` 成功返回 90 行；`grep` 成功返回 1 处匹配；子代理自述可见全部 21 个工具 |
| deny-小写 | `deny:["read","grep","glob","bash"]` | 同上 | `read` **ALLOWED**；`grep` **ALLOWED**；可见全部 20 个工具 |
| allow-大写 | `allow:["Read"]` | 只剩 `read` | `read` 成功；`bash` 因权限模式被拒（非覆盖所致）；可见全部 20 个工具 |
| allow-小写 | `allow:["read"]` | 只剩 `read` | `read` 成功；`glob` **ALLOWED**；可见全部 20 个工具 |

「只允许 `read` 仍能调 `glob`」直接排除「覆盖未接线」的可能——一个只能做白名单收窄的机制不可能多放行工具。

### 根因

链路有 4 段，**前 3 段都通了，断在第 4 段**：

1. **参数面**：`[SubagentTool.ts:107-122](../../packages/capabilities/src/SubagentTool/SubagentTool.ts) 声明 `tools.allow` / `tools.deny`，描述为「Keep only these tools (intersected with the agent definition's list)」。
2. **归一化**：[`normalizeToolOverlay`](../../packages/capabilities/src/SubagentTool/subagentResult.ts)（`subagentResult.ts:125`）用 `z.strictObject` 解析。
3. **传达与记录**：[`service.ts:284`](../../packages/host/src/worker-subagents/service.ts) 归一化后透传；`service.ts:318` 把 `toolOverlay` 写进运行日志。日志中 4 组探针的覆盖参数**各出现一次且原样保留**，证明参数确实到达 Host。
4. **应用**：[`applyToolOverlay`](../../packages/host/src/worker-subagents/run-agent.ts)（`run-agent.ts:238-256`）过滤 `resolvedTools`；`run-agent.ts:395-398` 用结果构造 `toolNames` 并据此得到 `toolsToUse`。

断点在第 4 段的两个独立成因：

**(a) `allow` 落空时 fail-open。** `run-agent.ts:249` 按名字精确匹配 `allowSet`。运行时工具名是小写（`read` / `bash` / `glob` / `grep`），而 `allow:["Read"]` 匹配不到任何工具 → 过滤结果为空 → `run-agent.ts:396` 的 `toolNames.size > 0 ? filter : allTools` 回退到**放行全部工具**。日志印证：`toolOverlayDropped:["Read"]` 出现 1 次，正是大写 allow 那次。

**(b) 收窄没有传到子代理的执行面。** `allow:["read"]` 那次日志记录 `toolCount:1`，即 `toolsToUse` 确实被收窄成 1 个工具；但子代理仍看到约 20 个工具并成功调用了 `glob`。原因是 `run-agent.ts:589-590` 把两个对象并排交给 driver：

```ts
tools: toolsToUse,      // 已收窄
toolRegistry: registry, // 完整注册表，未收窄
```

`toolRegistry` 用的是 `run-agent.ts:393` 的 `createToolRegistry()` 全量注册表，`enabledTools`（`run-agent.ts:436`）只影响系统提示词里列哪些工具。**收窄后的名单没有下沉到实际执行注册表**。

### 责任划分

`packages/host/tests/worker-subagents/subagentParams.test.ts:192` 与 `:202` 用 `{ allow: ['Read', 'Grep'], deny: ['Bash'] }`（大写）断言参数归一化结果。该用例只覆盖第 2 段，**不覆盖第 4 段的实际过滤**，因此无法发现上述两个问题。

### 修复建议

- `run-agent.ts:396` 的回退方向应改为 fail-closed：`allow` 全部落空时报错而非放行全部工具。
- `run-agent.ts:590` 的 `toolRegistry` 应由 `toolsToUse` 派生（按需重建注册表或按名单代理执行），使收窄对执行面生效。
- 名字匹配应大小写不敏感，或在 schema 层统一规范化；现有大写用例应同时验证**执行面**效果，而不只验证参数透传。

## 3. `resume_from` 不可用

三组 id 全部失败：

| 传入 id | 来源 | 报错 |
| --- | --- | --- |
| `1639cde8-…` | 后台 `task` 回执里的 `subagent_id` | `not a known session id` |
| `4a00d649-…` | 前台 `task` 回执里的 `subagent_id` | `has no prior messages to continue` |
| `05f565d2-…` | `session list` 列出的会话 id | `has no prior messages to continue` |

两处报错分属 [`resumeAgent.ts:103`](../../packages/agent/src/tool/SubagentTool/resumeAgent.ts) 与 `:149`：前者是 `sessionDb.get(resumeFrom)`（`:89`）查不到行，后者是行存在但 `messageDb.loadMessages(resumeFrom)`（`:127`）取不到消息。

即两处独立问题：

- **两套 id 空间**：`task` 回执发的是 subagent id，`sessionDb.get()` 认的是另一套 id。报错文案却引导用户「Use the subagent_id returned by a previous task call」（`resumeAgent.ts:103`）——这条引导指向的 id 恰好是查不到的那个。
- **子代理消息不落 `messageDb`**：即使换成 `session list` 能查到的 id，仍因历史为空而拒绝。

## 4. `MessageSession` 跨会话投递超时

向既有会话（`TUI 添加 Provider 及更新 Model List 命令` 等）单发同步问答，3 次尝试分别在 45 / 90 / 150 s 超时，报错均为 `interagent local timeout (code: timeout)`。

`session list` / `SessionSearch` 等只读检索正常，故失效范围限于**向既有会话投递并等待回复**这条路径，不涉及会话枚举。

`duya_cli` 在同环境下报 `DUYA is not running. Open the DUYA app and retry.`（退出码 2），与「跨会话投递需要桌面 app 在线」的方向一致，但未构成直接因果证据。

## 5. 可用但有约束的能力

| 能力 | 约束 | 证据 |
| --- | --- | --- |
| `task` 的 `isolation:"worktree"` | 要求工作树干净，仓库存在未跟踪文件时直接拒绝：`requires a clean working tree` | 与 `session spawn use_worktree` 在同一脏树上成功形成对比——两条路径的干净度判定不一致 |
| `session spawn`（带 worktree） | 耗时 236 s；`session get` 耗时 213 s | 远超 `session list` 的响应时间 |
| 子代理默认权限模式 | `permission_mode:"default"` 下 `bash` 被拒（`no interactive user to ask`）。无交互子代理需显式用 `bypassPermissions` 或 `auto` | 多次探针一致复现 |
| 子代理默认工作目录 | `task` 子代理默认落在共享主检出 `E:\Projects\duya`，而非独立检出 | 与根 `AGENTS.md`「每个 agent 必须使用独立 worktree」冲突；`isolation:"worktree"` 是唯一隔离开关，却被脏树挡住 |

## 6. 复现步骤

前置：Duya 桌面端运行中，仓库有任一未提交改动（用于复现 `isolation` 拒绝）。

1. **覆盖失效**：派发子代理并传 `tools: { allow: ["read"] }`，令其尝试 `read` 与 `glob` 两个工具，要求逐个报告「成功/被拒」与逐字错误。两者均成功 → 覆盖未收窄。
2. **覆盖 fail-open**：同上但传 `tools: { allow: ["Read"] }`（大写）。子代理可见全部工具 → 回退到放行全部。
3. **日志核对**：查 `~/.duya/logs/agent/agent-<sessionId>.log`，`[SubAgent] run starting` 行的 `toolCount` 与 `[SubAgent] Agent tool invoked` 行的 `toolOverlay` 对照——`toolCount` 已收窄而子代理仍可见全量，即收窄未下沉到执行面。
4. **`resume_from` 失效**：取任一 `task` 回执里的 `subagent_id`，以 `resume_from` 续接 → `not a known session id`。
5. **跨会话投递**：对既有会话 id 调 `MessageSession` → 超时。

## 7. 归属与交接

本文只维护**实测结论与证据**。三项失效的**缺陷登记**归属[工具暴露与 Harness 调用链收敛计划](../exec-plans/active/2026-10-31-tool-surface-and-harness-convergence.md)的 F 系列缺陷表（现为 F01–F26），建议由该计划 owner 采纳为新编号后再统一跟踪，避免同一事实双写。

本文未修改该计划文件：该计划当前由另一会话持有（负责人与分支 `codex/tool-surface-audit`、managed worktree `D:/codex/worktrees/tool-surface-audit/duya` 均在其名下），且其 W1–W10 实施尚未开始，采纳与否由该 owner 裁定。

修复尚未实施，本文不构成任何修复已交付的声明。

## 8. 附录：探针逐字记录

支撑结论的关键逐字片段。子代理 transcript（`~/.duya/subagent-transcripts/<task-id>.jsonl`）与运行日志（`~/.duya/logs/agent/agent-<sessionId>.log`）留在本机，未纳入 Git。

### 派发表

| # | 探针 | 方式 | 结果 |
| --- | --- | --- | --- |
| 1–3 | probe-agent-core / probe-agent-runtime / probe-host-tools | 后台并行 | 39 / 33 / 30 次工具调用；323 / 75 / 93 s |
| 4 | probe-deny-read | 后台 · deny 大写 | `read` 成功返回 90 行；`grep` 成功 1 处匹配；可见 21 个工具 |
| 5 | probe-allow-read-only | 后台 · allow 大写 | `read` 成功；`bash` 被权限模式拒；可见 20 个工具 |
| 6 | probe-kill-target | 后台 · 长跑 300 s | `kill_task` → `{"outcome":"killed"}` |
| 7 | probe-autowake-off | 后台 · `auto_wake:false` | 完成但无 `<task-notification>` |
| 8 | probe-foreground | 前台 `run_in_background:false` | 3733 ms 内联返回 |
| 9 | probe-worktree-iso | `isolation:"worktree"` | 拒绝：`requires a clean working tree` |
| 10 | probe-deny-lower | 后台 · deny 小写 | `read` ALLOWED；`grep` ALLOWED；可见 20 个工具 |
| 11 | probe-allow-lower | 后台 · allow 小写 | `read` ALLOWED；`glob` ALLOWED；可见 20 个工具 |
| 12 | probe-max-turns | `max_turns:1` | 1 轮工具调用后截断，未产出最终答案 |

并行性：1–3 同批派生，2 号自述窗口 `1793434365602→1793434392772`，3 号 `1793434369327→1793434415490`，两窗口重叠 23.4 s。三者独立用时 323 / 75 / 93 s，串行需 ≥ 491 s，实际批次在 323 s 量级结束。

### 子代理可见工具列表（deny 大写探针）

`read` / `bash` / `edit` / `write` / `apply_patch` / `glob` / `grep` / `todo` / `skill` / `askuserquestion` / `task` / `get_task_output` / `kill_task` / `plan` / `enter_worktree` / `exit_worktree` / `sync_worktree` / `tool_catalog` / `tool_invoke` / `vision_analyze`

> 2026-11-13：私有控制工具 `progress_update` 已整链移除，故不在此列表。`plan` 亦已按 2026-11-04 的移除计划下线，本行保留当时的探针记录原样。

### `bash` 被拒的逐字报错

与覆盖无关，来自权限模式：

> Refused to run bash. The agent requested a tool call without a configured permission mode to auto-approve it, and the current dontAsk/bypassPermissions mode does not allow it.

### 运行日志中的覆盖参数

`~/.duya/logs/agent/*.log` 中本次 4 组覆盖参数各出现一次且原样保留：

```
"toolOverlay":{"allow":["read"]}
"toolOverlay":{"allow":["Read"]}
"toolOverlay":{"deny":["read","grep","glob","bash"]}
"toolOverlay":{"deny":["Read","Grep","Glob","Bash"]}
```

被丢弃的名字（大写 allow 那次）：

```
"toolOverlayDropped":["Read"],"isolatedWorkingDirectory":"E:\\Projects\\duya"
```

`toolCount` 直方图中 `1` 仅出现 1 次，对应 `allow:["read"]` 那次——`toolsToUse` 确实被收窄成 1 个工具，但该子代理仍可见约 20 个工具并成功调用 `glob`。

### `resume_from` 三次尝试

| 传入 id | 来源 | 报错 |
| --- | --- | --- |
| `1639cde8-f504-4811-bccc-257ee490d50b` | 后台 `task` 回执 subagent_id | `resume_from "…" is not a known session id. Use the subagent_id returned by a previous task call, or omit resume_from to start a new sub-agent.` |
| `4a00d649-3453-425e-b71f-f499bf48501e` | 前台 `task` 回执 subagent_id | `resume_from "…" has no prior messages to continue.` |
| `05f565d2-6ddb-414f-9a35-b126e3112703` | `session list` 会话 id | `resume_from "…" has no prior messages to continue.` |

### 跨会话投递

`MessageSession` 目标 `40b6e923-9dc8-4b1a-87cd-cd19e4d3fda1`，三次 timeout 分别 90 / 150 / 45 s，报错一致：`interagent local timeout (code: timeout)`。

### worktree 隔离对照

`session spawn` + `use_worktree:true`（base `master` = `a33bbb05`，分支 `probe/session-worktree-iso`）：

- 子代理写入 `probe-session-marker.txt` 只落在 worktree，主检出 `E:\Projects\duya` 无此文件
- `session get` 报 `+1/-0 across 1 file`
- 回收后 `git worktree list` 不再含该条目，`probe/*` 分支已删，主检出 `git status` 与开工时逐字一致
- 对照：`task` 的 `isolation:"worktree"` 在同一脏树上被拒 `requires a clean working tree`

## 9. 相关文档

- [工具面审计](tool-surface-audit.md)：工具暴露与 provider 投影的源码基线与 Codex 对照
- [工具面能力台账](tool-surface-ledger.md)：W0 请求级 census 得到的逐工具能力台账
- [多 Agent Orchestrator](../exec-plans/active/2026-10-23-multi-agent-orchestrator.md)：workflow 引擎侧的编排能力评估与补测计划
