# 482 — 外部 Agent 调用层（External Agent Invocation）

> **Status**: Planning · **Priority**: P1 · **Owner**: TBD · **Created**: 2026-09-02
> **参考源**：`E:/cloned-projects/grok-bot-0.18-reconstructed`（下称 grok-bot）`source/shared/inference-router.ts` + `source/host/extensions/inference/{provider-session,codex-direct-responses}.ts`
> **定位**：与 [473](./473-grok-bot-framework-overview.md) 系列互补。**473 系列管「duya 自己的 bot 之间怎么互相唤醒与编排」，本 plan 管「duya 怎么把活派给本机已安装的外部 agent」**。473 移植的是 grok-bot 的编排层，本 plan 移植的是它借用外部 agent 执行能力的那一层。

---

## 1. 背景：duya 在这块是空白

调研结论（2026-09-02 完成，见 §7 证据）：

| 能力 | grok-bot | duya 现状 |
|---|---|---|
| 推理路由到外部 agent | 4 provider：`cursor` / `claude-code` / `codex` / `openrouter` | 无 |
| 复用外部 CLI 登录态 | 读 `~/.codex/auth.json`（ChatGPT OAuth）+ `~/.codex/config.toml`，直连 `chatgpt.com/backend-api/codex/responses` | 无 |
| 把外部 CLI 当子代理引擎 | `resolveClaudeCodeCliPath()` + `@anthropic-ai/claude-agent-sdk` `query()`，`maxTurns: 8` | 无 |
| 把宿主工具注入外部 agent | 起 HTTP MCP server（`grok_bot_plugins`）喂给 Claude Code | **无 MCP server 能力**（`packages/agent/src/mcp/` 只有 client：loader/collect-worker/mcpService） |
| 防身份混淆 | 注入 `"You are running inside Grok Bot, not inside Codex CLI or Claude Code."` | 无 |
| 分 provider 记用量 | `sand-inference-router-usage`（requests/tokens/cache/lastUsedAt） | 无 |

**duya 已有的"外部"能力都不是这一件事**：
- [95-external-agent-import](./95-external-agent-import.md)：**导入** Claude/Codex 的工作区配置与会话（Phase 1/1.5 ✅）—— 数据迁移，不是调用。
- [424](./424-config-driven-custom-agents.md) / [custom-agent-creation](../superpowers/plans/2026-08-14-custom-agent-creation.md)：用 config.toml 定义 **duya 自己的** agent（读侧+创建层 ✅）—— 内部人格，不是外部引擎。
- [310](./310-multi-model-reasoning-architecture.md) / [451](./451-multi-protocol-and-wrapper-layer.md)：`packages/ai` 自建 wire-protocol + wrapper 层，用**用户自己的 API key** —— 相当于 grok-bot 的 openrouter 路线，不是"借壳"。

**一句话缺口**：duya 能自己当 agent、能导入别人的配置、能用自家 key 接各家模型，但**不能"借用"本机已登录的 Claude Code / Codex 等外部 agent 来干活**。

---

## 2. 设计目标与非目标

**目标**
1. 让 duya 能把一个子任务委派给本机已安装的外部 agent（首发：Claude Code、Codex），拿回结构化结果。
2. 委派是**显式、可审计、可撤销**的：配置声明 + 首次确认 + 独立 transcript + 用量记录。
3. 与既有子代理体感一致：结果回传、进度可见、可中断。

**非目标**
- 不做"duya 被外部 agent 调用"的入向能力（那是 gateway / MCP server 话题，另立 plan）。
- 不与外部 agent 做长期记忆双向同步（只回传结果与用量）。
- 不改 `packages/ai` 协议层（451 负责）。**边界原则：能用 451 原生协议接的模型（OpenRouter / Bedrock / Gemini 等）一律不走本 plan**，本 plan 只处理"必须借用外部身份"的场景。
- 不改 SubagentTool 现有内部路径（新增 backend，不替换）。

---

## 3. 架构：三层 + 两种后端

```
配置层  ~/.duya/config.toml  [external_agents.<id>]
        type / command / auth / cwd / tools / maxTurns / timeout
                        ↓
运行时层 packages/agent/src/external-agent/
        ├─ types.ts            ExternalAgentBackend / ExternalAgentRun / 结果契约
        ├─ registry.ts         id → backend 解析 + doctor 检测
        ├─ credential-relay/   codex：读外部凭据 → 直连其私有端点（无子进程）
        ├─ cli-sdk/            claude-code / ACP：spawn 外部 CLI，SDK 或 JSON-RPC 驱动
        ├─ tool-bridge/        stdio MCP server：把 duya 工具暴露给外部 agent（默认关闭）
        └─ runner.ts           统一生命周期：spawn → 进度 → 中断 → transcript → usage
                        ↓
接入层  SubagentTool 新增 external backend → 结果进 476 WakeQueue / task-notification
        + 新增 `delegate_to_external` 工具（在 481 建档）
        + UI：委派卡片、外部 transcript 折叠、用量徽标
```

### 3.1 两种后端（对应 grok-bot 的两条路）

| 后端 | 机制 | 适用 | 复杂度 | 首发 |
|---|---|---|---|---|
| **credential-relay** | 读外部 agent 的凭据文件（如 `~/.codex/auth.json`，校验 0600 + 非符号链接，支持 refresh）与其 config 里的模型/effort，由 duya **自己发 HTTP 请求**到该服务的私有端点，工具回调由 duya 执行 | Codex（ChatGPT 登录态） | 低（纯 HTTP，无子进程，易单测） | Phase 2 |
| **cli-sdk** | 定位本机 CLI 可执行文件，用官方 SDK 或 ACP/JSON-RPC **spawn 子进程**，推理循环归外部 agent | Claude Code、Codex app-server、未来 ACP 兼容 CLI | 高（进程生命周期、超时、中断、版本漂移） | Phase 3 |

两者统一在 `runner.ts` 之后向上暴露同一结果契约，上层不感知差异。

### 3.2 配置形态（草稿，Phase 1 定稿）

```toml
[external_agents.codex]
type = "credential-relay"          # credential-relay | cli-sdk
service = "codex"                  # 决定凭据/端点解析策略
model = ""                         # 空 = 读外部 config 的默认值
enabled = true                     # 默认 false，需显式开启（见 §5 安全）
inject_tools = false               # 是否把 duya 工具经 MCP 注入（默认关闭）
max_turns = 8
timeout_ms = 600000
cwd = ""                           # 默认当前会话 workspace

[external_agents.claude]
type = "cli-sdk"
service = "claude-code"
enabled = true
inject_tools = false
max_turns = 8
```

`duya external-agent list/doctor` 子命令负责检测本机可用性与登录状态（对齐 [431-memory-setup](./431-memory-setup-cli-and-skill.md) 的自配置体感）。

---

## 4. 实施阶段

### Phase 0：可行性核验（P0，必须先做）

> grok-bot 是**逆向重建**版本，其中的私有端点与 SDK 版本未必与本机真实 CLI 一致。**先验证再写实现**，否则整条路线可能建在流沙上。

- [ ] **P0.1** 核验 credential-relay：本机 `~/.codex/auth.json` 结构、`~/.codex/config.toml` 字段、`chatgpt.com/backend-api/codex/responses` 端点当前是否可用与响应形状。
- [ ] **P0.2** 核验 cli-sdk：`@anthropic-ai/claude-agent-sdk` 当前版本 API（`query()` 签名、`pathToClaudeCodeExecutable`、`mcpServers` 注入方式）与 grok-bot 0.18 用法的差异；确认 Claude Code CLI 本机可执行文件路径探测策略。
- [ ] **P0.3** 核验 ACP / codex app-server JSON-RPC 是否可作为更稳的第二入口（参考 `docs/references/codex-deep-dive/10-app-server-and-mcp.md`）。
- [ ] **P0.4** 输出决策：credential-relay 是否保留（**ToS 风险见 §5**），cli-sdk 首发锁定哪个 CLI。
- [ ] **P0.5** 若任一路线不可用 → 收缩为"仅 cli-sdk + 显式 API key"或暂缓，结论写入 §7 决策日志。

### Phase 1：配置层 + 检测（P1）

- [ ] `electron/config/schema.ts` 增 `ExternalAgentConfig` + `DuyaConfig.external_agents`（默认 `{}`，`enabled` 默认 `false`）；`store.ts` FLAT_TO_PATH 增映射。
- [ ] `packages/agent/src/external-agent/registry.ts`：`resolveExternalAgent(id)` + `doctor()`（CLI 存在性 / 登录态 / 版本 / 端点连通性）。
- [ ] CLI：`duya external-agent list|doctor`（复用 `packages/agent/src/cli/` 现有 descriptor 注册模式）。
- [ ] 单测：schema 解析、路径展开、doctor 各分支（未安装/未登录/已就绪）。

### Phase 2：credential-relay 后端（P1，若 P0.4 保留）

- [ ] `credential-relay/codex-credentials.ts`：读 `~/.codex/auth.json`，校验 regular file + 0600 + 非符号链接，token 过期自动 refresh；**凭据只驻留内存，不写 duya `secrets.json`、不落日志、不进入 LLM 上下文**。
- [ ] `credential-relay/codex-config.ts`：从 `~/.codex/config.toml` 解析 model / reasoning effort（复用 `readUserMcpToml` 的读盘先例）。
- [ ] `credential-relay/codex-direct.ts`：SSE 流式调用 + 工具回调 + 步数上限 + 错误分类（对齐 `packages/ai/src/utils/errors.ts` 风格）。
- [ ] 单测：权限校验失败态、refresh 路径、SSE 中断/畸形事件、步数上限截断。

### Phase 3：cli-sdk 后端（P1）

- [ ] `cli-sdk/process-supervisor.ts`：spawn + timeout + 优雅中断（SIGTERM → 等待 → SIGKILL）+ 僵尸进程回收 + Windows 进程树处理（复用 [15-bash-worker](./15-bash-worker-implementation.md) 与 BashTool 的既有经验）。
- [ ] `cli-sdk/claude-code.ts`：官方 SDK 驱动，`maxTurns` / `permissionMode` / cwd 约束。
- [ ] `cli-sdk/acp.ts`（可选，视 P0.3）：ACP / app-server JSON-RPC 客户端，作为与具体 CLI 解耦的第二入口。
- [ ] 单测：超时中断、异常退出、输出截断、并发上限。

### Phase 4：工具桥（P2，默认关闭）

> grok-bot 靠它把宿主能力喂给 Claude Code。duya 当前**没有 MCP server 能力**，这是本 plan 最大的新增件，因此与主体解耦、默认关闭。

- [ ] `tool-bridge/stdio-server.ts`：最小 MCP server（评估引入 `@modelcontextprotocol/sdk/server` vs 手写 JSON-RPC，以依赖成本为准）。
- [ ] 暴露白名单工具（默认 Read/Grep/Glob 只读），**写工具默认不暴露**，暴露即走 [419](./419-permission-decision-bus.md) 权限总线。
- [ ] `inject_tools = true` 时才启用，且首次启用需 UI 二次确认。
- [ ] 单测：协议握手、工具调用往返、越权拒绝。

### Phase 5：接入与 UI（P1，依赖 Phase 2 或 3）

- [ ] `SubagentTool` 增 external backend：结果写回父会话，transcript 独立落盘（沿用 `session_spawn_edges` 血缘表，见 [332](./completed/332-storage-alignment-improvements.md)）。
- [ ] 新增 `delegate_to_external` 工具（schema/权限/测试在 [481](./481-bot-toolset-unified-foundation.md) 建档）；权限默认 **ask**（每一次委派都需确认，目标不在 config 白名单则 deny）。
- [ ] 结果回传接 [476](./476-agent-wake-bus.md) WakeQueue（476 未落地前先复用 [212](./completed/212-subagent-task-notification.md) task-notification）。
- [ ] UI：委派行（外部 agent 名 + 状态 + 用时）、外部 transcript 折叠、用量徽标；UI 改动按仓库约定用 Playwright MCP 验证。
- [ ] 用量记录：`external_agent_usage`（requests / input / output / cache / lastUsedAt / agentId），对齐 grok-bot 分 provider 记账。

### Phase 6：文档与收口（P2）

- [ ] `ARCHITECTURE.md` 增补「External Agent Layer」章节（三层图 + 两种后端 + 安全边界 + 与 `packages/ai` 的边界原则）。
- [ ] 本文件 §7 决策日志补全；README 状态更新。

---

## 5. 安全策略（本 plan 的最高风险面）

委派意味着**把本机文件系统与一个第三方二进制/远端服务打通**，因此默认收紧：

| 项 | 策略 |
|---|---|
| 默认态 | `enabled = false`；未显式配置的外部 agent 一律不可用 |
| 凭据 | **只读引用，不复制**：不写入 duya `secrets.json`，不落日志，不进 LLM 上下文；读取时校验 0600 + regular file + 非符号链接 |
| 权限 | 每次委派走 [419](./419-permission-decision-bus.md) 总线，默认 `ask`；目标不在白名单 → `deny` |
| 工作目录 | 外部进程 cwd 限制在会话 workspace 内，复用 `allowedRoots`（见 [401](./completed/401-memory-curation-tool-foundation.md)） |
| 工具暴露 | 默认**不注入**任何 duya 工具；注入时默认只读，写工具需显式确认 |
| 回传内容 | 外部 agent 输出视为**不可信输入**，过 `ContextScanner` 做 prompt-injection 扫描 |
| 可撤销 | 委派可中断（`delegate_to_external` 与 UI 双通道），进程树强制回收 |
| **ToS 风险** | credential-relay 复用第三方订阅登录态可能违反其服务条款。**默认关闭，需在 UI 明示风险并由用户显式勾选开启**；P0.4 决策若判定风险不可接受，直接砍掉 Phase 2，只保留 cli-sdk + 自有 key |

---

## 6. 验收标准

- [ ] `duya external-agent doctor` 能正确识别本机 Claude Code / Codex 的安装与登录状态。
- [ ] 至少一条后端端到端跑通：duya 主会话委派一个只读任务给外部 agent，拿回结构化结果并渲染为委派行。
- [ ] 委派可被中断，进程树无残留（Windows 上验证）。
- [ ] 未配置 / 未开启的外部 agent 调用被拒，且拒绝原因对用户可读。
- [ ] 用量可查（按 agentId 分账）。
- [ ] `npm run typecheck:all` + 相关单测全绿；UI 改动经 Playwright MCP 验证。

---

## 7. 证据与决策日志

### 调研证据（2026-09-02，源码级）

| 结论 | 证据位置 |
|---|---|
| provider 仅 4 个，无 pi | `source/shared/inference-router.ts:1` `["cursor","claude-code","codex","openrouter"]` |
| codex = 借壳登录，不 spawn CLI | `source/host/extensions/inference/provider-session.ts:167-200`（`~/.codex/auth.json` → `chatgpt.com/backend-api/codex/responses`）；凭据权限校验见 `codexCredentials()` |
| codex 工具由宿主执行 + 步数上限 | `codex-direct-responses.ts`（`executeTool` 回调、`${maxSteps}-step tool limit`） |
| claude = SDK spawn + MCP 注入 | `provider-session.ts:203-227`（`resolveClaudeCodeCliPath()`、`queryClaude(...)`、`mcpServers: { grok_bot_plugins: { type:"http" } }`、`maxTurns`） |
| 防身份混淆 | `provider-session.ts:26` `"You are running inside Grok Bot, not inside Codex CLI or Claude Code."` |
| 分 provider 记账 | `source/shared/inference-router.ts:4-25` `SandInferenceRouterUsage` |

> 注：用户提到的「pi」并非 grok-bot 的 provider，而是 duya 的 harness 研究样本（`docs/references/harness-comparison/`，样本集：openclaw / pi / codex / hermes-agent / claude-code-haha）。若将来 ACP 生态成熟，pi 类 CLI 可走 Phase 3 的 `acp.ts` 接入。

### 设计决策

- **D1**：新增独立目录 `packages/agent/src/external-agent/`，不塞进 `SubagentTool`。理由：外部进程/远端凭据的生命周期与权限模型与内部子代理完全不同（要 supervisor、要凭据校验、要 ToS 门），混在一起会让 SubagentTool 承担两种互不相关的失败模式。
- **D2**：先 credential-relay（Phase 2）后 cli-sdk（Phase 3）。理由：前者是纯 HTTP，无子进程、无平台差异、易单测，能最早验证"结果契约"是否站得住；后者的进程管理与中断是独立难题。
- **D3**：工具桥（Phase 4）默认关闭且与主体解耦。理由：duya 当前无 MCP server 能力，这是全 plan 最大新增件；把它做成可选项后，主体价值（委派拿结果）不依赖它。
- **D4**：`packages/ai`（451）与 482 的边界 = **能用自有 key 走的模型不走 482**。理由：避免两套机制抢同一批 provider，造成"这个模型到底走哪条路"的长期混乱。
- **D5**：Phase 0 可行性核验前置。理由：信息源是逆向重建版本，私有端点与 SDK 都可能已漂移；先花小成本证伪，胜过基于过期假设写 Phase 2/3。

### 待定（P0.4 决策点）

- credential-relay 是否保留（ToS 权衡，见 §5）。
- cli-sdk 首发锁定 Claude Code 还是 codex app-server（视 P0.2/P0.3 稳定性）。

---

## 8. 与既有 plan 的关系

| Plan | 关系 |
|---|---|
| [473](./473-grok-bot-framework-overview.md) 系列（474–481） | **互补**：473 管内部 bot 编排，482 管外部 agent 委派；两者共用 476 WakeQueue 与 481 工具建档入口 |
| [451](./451-multi-protocol-and-wrapper-layer.md) | 边界划分见 D4；482 不碰 `packages/ai` |
| [95](./95-external-agent-import.md) | 导入 vs 调用，互不重叠 |
| [424](./424-config-driven-custom-agents.md) / custom-agent-creation | 内部人格定义；482 的外部 agent 不等于自定义 agent profile |
| [66](./66-async-nonblocking-subagent.md) / [37](./37-subagent-nested-session.md) | 委派结果的异步展示与嵌套会话 UI 可复用 |
| [212](./completed/212-subagent-task-notification.md) | 476 未落地前的结果回传通道 |
| [419](./419-permission-decision-bus.md) | 委派与工具暴露的权限唯一入口 |
| [429](./429-harness-gap-closure.md) | 若有重叠的 harness 缺口项，以 429 的证据核验为准 |
