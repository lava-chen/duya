# 481 — Bot 工具集统一建档（系列新增工具一次性建立）

> **Status**: Phase 1 + T1 完成 2026-09-03（分支 feat/481-bot-toolset-foundation，PR #38 → recover480）· **Priority**: P0 · **Owner**: TBD
> **总纲**: [473-grok-bot-framework-overview](./473-grok-bot-framework-overview.md)
> **定位**: 473–480 各 plan 中**新增的 agent 工具**在此统一收口：同一批设计 schema、权限默认值、注册方式与测试基建，**一次性建立**，避免每个子 plan 各写一套工具基建。
> **参考源码**：grok-bot `runner/tools/sand-state-tool.ts`（update_state）、`send-message-tool.ts`；duya 既有约定 `packages/agent/src/tool/<Name>/`（index + prompt.ts + `__tests__/`）、`tool/builtin.ts`、`tool/registry.ts`、plan 419（权限决策总线）、plan 224（AgentProfile 工具集）

---

## 1. 工具清单（一次性建齐）

| # | 工具名 | 归属 plan | 用途 | 关键参数（schema 骨架） | 权限默认（419 总线） | Profile 门控 |
|---|---|---|---|---|---|---|
| T1 | `update_state` | 479 | 记忆/项目读写唯一入口（对齐 grok） | `target: 'memory'\|'project'`, `scope: 'agent'\|'user'\|'project'`, `action: 'write'\|'forget'\|'create'\|'join'\|'leave'`, `project?`, `fact?` | own=allow；user/project 写=ask；project join/leave=ask | bot profile 启用；普通 profile 可选 |
| T2 | `SendToAgent` | 477 | bot→bot 异步 DM | `toAgentId`, `text` (≤8000), `priority?`, `images?` | roster 内=allow；未知目标=结构化错误；防轰炸单 run ≤N 条 | 仅 bot profile |
| T3 | `PostToRoom` | 478 | 群房间发言（唯一发言通道） | `roomId`, `text`，沉默即 `text="(pass)"` | 群成员 run 内=allow | 仅 bot profile（群 run 中注入） |
| T4 | `tool_schema` | 480 | 读动态工具 schema | `namespace?`, `tool?` | 读=allow | 全体（含普通会话） |
| T5 | `tool_invoke` | 480 | 调用目录中的动态工具 | `namespace`, `tool`, `arguments` | **按解析后的真实工具规则执行** | 全体（目录为空时自动隐藏） |
| T6（可选） | `background_tasks` | 476 | 查询自己的异步任务/roster 投影 | 无参或 `{verbose?}` | allow | bot profile |

> 工具命名对齐 duya 现有风格（camelCase 文件、工具名小写下划线）;`tool_schema`/`tool_invoke` 名字在 480 落地时若与 pi/codex 惯例冲突可再议，481 只锁**数量与职责**，不锁字面名。

## 2. 统一约定（每个工具都必须遵守）

### 2.1 目录与注册
- `packages/agent/src/tool/<ToolName>/`：`index.ts`（schema+execute）+ `prompt.ts`（工具说明文本，含 token 预算意识）+ `__tests__/<ToolName>.test.ts`。
- 注册：`builtin.ts` 导出 + `registry.ts` 登记；**默认不进** general/code/research 基座工具集——由 AgentProfile（bot toolset）显式启用；T4/T5 例外（全体可用，目录空时 T5 自动隐藏）。
- 工具说明文本的中文/英文遵循现有工具（英文为主），长度对齐现有工具基线。

### 2.2 权限与安全
- 一律走 419 权限决策总线，不接受工具内自行放行。
- T5 必须先 resolve 真实工具再查权限（防"meta 工具旁路"）。
- T1/T2/T3 均带输入 clamp（fact ≤500 chars、text ≤8000 chars，对齐 grok 常量）。
- 全部工具返回结构化错误（discriminated union），不抛裸异常。

### 2.3 测试基建（本 plan 一次性建好，后续工具复用）
- `tool/harness.ts`：统一工具测试夹具（mock agent context / 权限总线 / 目录 registry）。
- 每个工具必测：schema 校验、权限矩阵（allow/ask/deny）、clamp、结构化错误、幂等键（T1 dedupe、T2 clientMsgId）。

## 3. 分阶段实施

### Phase 1 — 基建
- [x] **P1.1** `tool/harness.ts` 测试夹具 + 示范测试一个既有工具（回归）。→ `packages/agent/src/tool/harness.ts`（registry 工厂 / recording executor / context pair / callTool 驱动器，对齐 StreamingToolExecutor 契约；loose toTool 形工具跳过 validateInput 阶段与 BaseTool.call 一致）+ `tests/unit/tool-harness.test.ts`（get_task_output 回归，8 例）。
- [x] **P1.2** bot toolset 声明：AgentProfile 侧 `botTools` 集合 + registry 门控读取 + 单测。→ `agent-profile/bot-toolset.ts`：`BOT_TOOLSET` 常量（send_to_agent, update_state）+ `applyBotToolset()` 接入 `toAgentProfile`；`'*'` 透传、显式 deny 仍胜（ToolFilter 后置）；7 例单测。

### Phase 2 — 按归属 plan 的依赖顺序建工具
- [x] **P2.1** T1 `update_state`（写侧对接 479 store；479 P3.2 消费）。→ `tool/UpdateStateTool/`（schema 矩阵 / clamp 500 / checkPermissions / 结构化错误 / bridge 注入，23 例）+ `memory-tier:rpc` IPC 桥（agent-process-entry 路由+响应 / router×2 / interagent-router / server 响应回投 / lifecycle 处理，共 8 触点）+ `electron/memory-state/tierWriter.ts`（canonical 文件写入 per-writer shard + `upsertTierEntry` 索引维护 + 软遗忘）+ `tier-rpc.ts`（校验 + 惰性 bootstrap，9 例）。
- [ ] **P2.2** T2 `SendToAgent`（对接 476 WakeQueue `agent.dm` source；477 消费）。→ recover480 上尚未落地，477 实现中。
- [x] **P2.3** T4/T5 `tool_schema`/`tool_invoke`（480 P2 消费；本 plan 只做注册与权限外壳，实现在 480）。→ 已随 480 在 recover480 交付（builtin 注册 always + 26 例），无字面名冲突。
- [ ] **P2.4** T3 `PostToRoom`（478 P2.1 消费；478 开工前先落壳）。
- [ ] **P2.5** T6 `background_tasks`（可选，476 P3.3 后评估）。

### 验收
- [ ] 全部工具在 demo bot 上端到端可用（473 总纲验收项的依赖面）。
- [x] 每工具测试覆盖矩阵齐全；`npm run typecheck:all` 全绿。→ agent 侧 64/64 vitest 绿；packages/agent 与 electron tsconfig 仅剩基线预存错误（threads.js / WaitTasksTool / db-bridge，非本次改动）。`tierWriter.test.ts`（9 例）在 DUYA.exe 运行期间因 better-sqlite3 electron-ABI 锁暂缓执行（与已合并的 tierIndex.test.ts 同一运行条件，应用关闭后即可跑）。

## 4. 非目标 / 风险

- 非目标：不实现工具本体业务逻辑（归属 plan 负责）；不改既有工具（Read/Bash 等）。
- 风险：工具 schema 定稿后又改（477/478/479/480 实施中发现参数缺口）→ 481 允许各 plan 提 amendment 回填本清单，schema 变更必须在 481 记录决策，避免口头漂移。

## 5. Amendment 记录

- **2026-09-03 · T1 update_state 交付范围**（分支 feat/481-bot-toolset-foundation，PR #38）：
  - 权限走 419 的**执行器 checkPermissions 阶段**（StreamingToolExecutor：own=`allowed`；shared=`allowed+requiresUserConfirmation`；非法组合 `allowed=false`），非工具内自行放行——与 §2.2 一致。
  - `kind` 参数（'profile'|'log'|'note'，默认 note）为 schema 骨架的**新增项**，由 479 store 的 `TierEntryKind` 反推；`key` 参数未加，dedupeKey 直接由 fact 归一化（trim+lowercase+空白折叠，与 479 `normalizeDedupeKey` 对齐）。
  - 身份：工具从 `ToolUseContext.options.agentProfileId` 取 bot 身份（本次新增字段并从 ChatOptions 贯通）；session→bot 绑定的最终语义仍归 477 P3.1。
  - create/join/leave 成员操作：schema/权限面已锁定（target=project 专属、=ask），执行返回结构化 `NOT_IMPLEMENTED`，等待 479 Phase 3 的成员存储设计；届时只需填主侧 handler，不动 schema。
  - tierWriter shard 布局：own=`agents/<id>/memory/`，user=`agents/<id>/user/`，project=`projects/<pid>/agents/<id>/`——全部位于 479 rebuild 扫描根（memory/items|entities|global）之外，符合 479 P1.0 D4 决议；user tier 以 by-writer 子目录实现单写者约束。
  - 桥通道：单一 `memory-tier:rpc` + action 分发（仿 conductor 模式），响应经 requestId 原路返回 worker 的 pendingIpcRequests。
- **2026-09-03 · T2 SendToAgent**：recover480 上尚未落地（477 实现中）；BOT_TOOLSET 已预收其名字，477 合入后自动生效，无需 481 重复建档。
- **2026-09-03 · T4/T5**：随 480 在 recover480 交付完毕（注册 always + 26 例），本 plan P2.3 关闭。
- **2026-09-05 · T1 update_state 身份子操作（profile.set / avatar.set / avatar.clear）+ image_generate 暴露归属**（grok 对照收尾，未提交 WIP 之上）：
  - **profile.set**：target='profile' + action='set'，接受 name（clamp 64）和/或 description（clamp 300）；**title 不开放**（485 §2.4 host 管辖）。写入走 profile.json（runtime identity 源），不经 config.toml。
  - **avatar.set/clear**：duya 头像是 (shape, color) token 对（bot-avatar.ts 向量角色），**不是** grok 的图片路径 —— token 集合主侧校验（INVALID_AVATAR_SHAPE/COLOR）。clear 需专用写入 `clearBotAvatarTokens`（updateBotProfileIdentity 的空串回退语义无法表达删除）。
  - **权限**：身份子操作天然 self-scoped（schema 无 agentId 参数）→ allow；主侧 `handleBotIdentityRpc` 用 session `bot:<id>` 绑定与 payload.actorAgentId 比对（IDENTITY_MISMATCH 拒绝），服务端强制只能改自己的身份。
  - **桥通道**：新开 `bot-identity:rpc`（不复用 memory-tier:rpc —— store 语义不同），agent-process-entry 路由 + agent-server-lifecycle 处理 + `electron/config/bot-identity-rpc.ts` handler（校验 + 审计 INFO 日志），仿 memory-tier 模式。
  - **image_generate 归属**（grok 静态面对照遗留决策）：加入 BOT_TOOLSET（精确名提升），不注册 always —— grok 对所有非 subagent 回合静态暴露 GenerateImage，duya 对应物是 bot profile 提升而非全局暴露；always 会让主会话也常驻该工具。
  - 测试：update-state-identity 19 例（resolve/权限/execute/桥路由）+ bot-identity-rpc 13 例（绑定安全/写入/token 校验/clear）+ bot-toolset/discoverability 扩 5 例。agent 包 tsc 绿；electron tsc 编辑区零新增（基线预存错误与本改动无关，含 HEAD 上即存在的 db-bridge `ipcPermissionToCreate` 导入错）。
