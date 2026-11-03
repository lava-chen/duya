# TUI 模型切换真正生效（model hot-swap 落地）

状态：active · 负责人：本次会话 · 更新：2026-10-30
分支：codex/tui-model-hotswap · worktree：E:/Projects/duya/.claude/worktrees/tui-model-hotswap · base：6dee3e68 · owner：本次会话

## 目标与边界

用户在 `duya tui` 里用 `/model` 换模型后，**下一轮真实请求必须打到新模型**，且账本（run 记录 / usage 归因）与实际调用一致。

本次修三个缺陷（不是三条备选路线，是三个各自独立的真缺陷）：

1. **切换不落到实际请求**：Host 侧 `packages/host` 路径（CLI/TUI 自起 Host，或 TUI 附着 Desktop 时经 `desktop-run-execution-api`）只把模型写进 run 的 manifest，**worker 侧的 LLM client 仍绑在旧模型上**。`packages/ai` 的 `AIClient.streamChat` 契约里**没有 model 成员**（`packages/ai/src/types.ts:493-523`），模型在 `createAIClient` 工厂期就被烧进 client（`packages/ai/src/api/anthropic-messages.ts:1810-1811`）。
2. **CLI 启动参数压制 `/model`**：`packages/cli/src/chat.ts:1665` 每轮都把 `options.model`（`duya tui --model` 启动值）发给 Host，Host 侧 `run-execution.ts:488` 优先用请求里的 model，于是 `/model` 选的新模型被启动参数覆盖。Desktop 路径不传 model（走 session 行），所以只有 TUI/CLI 受影响。
3. **Desktop 附着路径缺 providerConfig**：TUI 附着 Desktop 时，`desktop-run-execution-api.ts:79-84` 只在 `input.model/providerId` 存在时才组 `providerConfig`；TUI 不带这两项（`chat.ts:1665-1667` 只在启动参数存在时才带），Desktop chat 路由 `router.ts:1274` 因此直接 400 `No provider or model configured`。

**本次不做**：不改 `packages/ai` 的 `AIClient` 契约（加 model 成员要动 5 个 adapter + 缓存/上下文窗口归属，属另一件事）；不动 `packages/agent` 退役层；不引入「同一 provider 内换模型不重建 client」的零延迟路径。

关联：610 架构线（manifest 是唯一真相源）；`2026-10-22-single-host-multiclient`（TUI 附着 Desktop 的执行委托）。

## 验收

1. `duya tui` 自起 Host：`/model` 选模型 B → 下一轮真实 provider 请求的 model 是 B（用受控 provider 端点断言 wire 上的 model 字段）。
2. `duya tui --model A` 启动：`/model` 选 B → 下一轮真实请求是 B，不是 A。
3. TUI 附着 Desktop：TUI 发起一轮能被接受（不再 400），且 `/model` 后下一轮用新模型。
4. 账实一致：run 记录的 model 与该轮实际调用的 model 相同（`turn.started` / usage 归因）。
5. Desktop 路径不回归：Desktop UI 切模型后仍按 session 行 + provider 行解析（`router.ts:2532`）。
6. 门禁：`npm run typecheck:all`、`npm run architecture:check`、相关 vitest；改动 `packages/host/src` 后 `npm run bundle:worker` 且 `npm run bundle:verify` 绿。

## 进度

- [ ] 切片 1：Host 侧把 run 的 model 真正送进 worker 的 client（`packages/host`）
- [ ] 切片 2：CLI/TUI 不再用启动参数压制 `/model`（`packages/cli`）
- [ ] 切片 3：Desktop 附着路径的 providerConfig 组装（`apps/desktop`）
- [ ] 切片 4：账实一致与回归测试

## 发现与决策

### 根因（只读调研，未改动代码）

- **模型烧在 client 上**：`packages/host/src/worker-session-runtime.ts:1060-1089` 用 `options.model` 构造 `createAIClientWithRetry`；`packages/ai/src/api/anthropic-messages.ts:1808-1811` 每个 `streamChat` 都用工厂期的 `options.model` 造请求体。`AIClient.streamChat` 的 options **没有 model 成员**（`packages/ai/src/types.ts:493-523`），因此 `packages/host/src/run-engine-model.ts:592` 明明透传了 `request.model`，adapter 也收不到——这是 plan 610 执行日志已记录的事实（`docs/exec-plans/active/610-architecture-series/90-execution-log.md:2116`）。
- **Host 路径不发 init**：`packages/host` 侧 `sendCommand` 只发 `chat:start`（`run-execution.ts:317`）。Desktop 的 agent server 则**每轮都发 init**（`apps/desktop/src/main/agents/server/router.ts:1327`），且 init 的 `providerConfig.model` 取自 session 行（`buildInitProviderConfig`，`router.ts:2532`）。Desktop 因此能换模型：init 指纹变了 → worker 重建 agent（`worker-process-entry.ts:2944-2956` 用 `canReuseAgentForInit`，`worker-init-fingerprint.ts:163-190` 把 `providerConfig.model` 计入指纹）。
- **worker 侧确实有自初始化通道**：`packages/host/src/worker-process-entry.ts:2906-2925`，worker 收到 `chat:start` 而没有 agent 时，用 `createWorkerSelfInitMessage`（`packages/host/src/worker-config/self-init.ts:47-82`）从 manifest 的 `agent` 选择解析 provider 并自建 agent——但**只在 agent 为空时**。Host 路径下 worker 进程按 session 常驻（`worker-manager.ts` 复用），所以第一轮之后 `agent` 非空，后续 `/model` 切换**永远不重建**。

  `self-init.ts:52` 用 `request.manifest?.agent`（model + providerId）→ `resolveProvider(selection?.model, configRoot, selection?.providerId)`。这正是 Host 路径该走的语义：**manifest 是真相源，worker 按 manifest 自初始化**。

- **`/model` 确实落库了**：`packages/cli/src/tui/slash/model.ts:175-184` → `updateSession`（`shared.ts:286`）→ Host `session-api.ts:533-556` 写 `model`/`providerId` 到 session 行。账本侧也更新了（`run-execution.ts:638` 从 session 行读 model → `intent.model` → manifest）。**所以只剩「实际调用」这一环没落地。**

- **CLI 启动参数压制**：`chat.ts:1665` 每轮带 `options.model`；`run-execution.ts:488` 优先请求值。Desktop 路径不带（`buildAgentServerChatBody` 只在 input.model 存在时才组 providerConfig），Desktop renderer 走的是 body providerConfig（`packages/ui/src/lib/agent-sse-client.ts:113-117`）。

  修正方向：TUI 每轮应带**当前 session 的 model**（`activeSession.model`），而不是启动参数。这样 `/model` 的结果和 session 行一致；Desktop 附着时也顺带把 providerConfig 带上（`buildAgentServerChatBody` 已有该逻辑，只要 `input.model` 存在）。

  但注意：`/model` 之后 `activeSession` 被更新为 `outcome.session`（`chat.ts:1876`），所以 `activeSession.model` 就是新模型。

- **Desktop 附着 400**：`desktop-run-execution-api.ts:79-84` 只在 `input.model !== undefined` 时带 `providerConfig.model`；TUI 不带 → Desktop chat 路由 `router.ts:1274` 400。修 TUI 带上 model 后这条路自然通。

- **effort 是对照组**：`/effort` 生效是因为 effort 是**每请求**参数（`packages/ai/src/types.ts:512` effort 在 streamChat options 里）。model 不是——这印证了缺陷 1 的性质。

- **worker 重建代价已知且可接受**：Desktop 每轮 init 靠指纹避免无谓重建（`worker-init-fingerprint.ts`）；模型真变了才重建（重读 transcript + MCP 握手）。我们让 Host 路径复用同一机制，而不是零延迟换 client。

### 路线取舍

用户要求「全部修好」。A/B/C 是同一目标的**三种代价比**，不是三个缺陷；叠加它们会造出两个真相源（既有 init 重建，又有 per-request 覆盖）。因此收敛为**一条路径 + 三个缺陷全修**：

- 采纳「**init 重建**」语义（Desktop 已在用、worker 已实现、指纹已含 model）：Host 路径在 manifest 的 agent 选择与当前 agent 不一致时，让 worker 重建 agent。
- 不采纳「per-request model 覆盖」：要改 `AIClient` 公共契约 + 5 个 adapter，且 model 还绑着上下文窗口/能力表（`worker-session-runtime.ts:1076` 的 modelCompat），单换 model 会让上下文预算与实际模型脱节。
- 不采纳「Host 主动 kill worker」：worker 进程按 session 常驻，kill 掉会丢 MCP 连接与后台任务；重建 agent 已经能换模型，且保留进程。

### 真相源

**run 的 manifest 是唯一真相源**（610 架构线已有此结论）。Host 路径不发 init 的原因是它没有 provider 凭据（凭据在 `config.toml`/`secrets.json`，`file-config.ts:256` `resolveProvider` 在 worker 侧才读得到）。因此 Host 路径让 **worker 自初始化**（`self-init.ts` 已有此能力），由 worker 按 manifest 解析——这与 Desktop 的 init 等价，且不需要 Host 持凭据。

具体做法：Host 侧在派发 `chat:start` 前比较 manifest 的 agent 选择与 worker 现有 agent 的选择；不一致则要求 worker 重建。worker 侧已有 `canReuseAgentForInit` 指纹机制，但 Host 路径没有 init 通道，所以需要新增一条「按 manifest 重建」的 worker 命令或让 worker 在 `chat:start` 时自校验。**具体接缝在实现时确定**，优先复用 `self-init.ts` + `worker-init-fingerprint.ts`，不新增第三套重建语义。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 6dee3e68 / 只读调研 | Windows / Node 24 | 只读代码追踪，无改动 | 未验证 | 根因链见「发现与决策」 |

## 接续 / 结果

未开始实现。worktree 待建（Bash 写操作分类器间歇不可用）。
下一步：在 `.claude/worktrees/tui-model-hotswap` 完成切片 1，验收 1-2 通过后再做切片 2-3。
回收：不适用。
