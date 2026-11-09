# TUI 模型切换真正生效（model hot-swap 落地）

状态：active · 负责人：本次会话 · 更新：2026-10-30
分支：worktree-tui-model-hotswap · worktree：E:/Projects/duya/.claude/worktrees/tui-model-hotswap · base：6dee3e68 · owner：本次会话

## 目标与边界

用户在 `duya tui` 里用 `/model` 换模型后，**下一轮真实请求必须打到新模型**，且账本（run 记录 / usage 归因）与实际调用一致。

本次修三个缺陷（不是三条备选路线，是三个各自独立的真缺陷）：

1. **切换不落到实际请求**：Host 侧 `packages/host` 路径（CLI/TUI 自起 Host）只把模型写进 run 的 manifest，**worker 侧的 LLM client 仍绑在旧模型上**。`packages/ai` 的 `AIClient.streamChat` 契约里**没有 model 成员**（`packages/ai/src/types.ts:493-523`），模型在 `createAIClient` 工厂期就被烧进 client（`packages/ai/src/api/anthropic-messages.ts:1810-1811`）。
2. **CLI 启动参数压制 `/model`**：`packages/cli/src/chat.ts` 每轮都把 `options.model`（`duya tui --model` 启动值）发给 Host，Host 侧 `run-execution.ts:488` 优先用请求里的 model，于是 `/model` 选的新模型被启动参数覆盖。
3. **Desktop 附着路径缺凭据**：TUI 附着 Desktop 时，`desktop-run-execution-api.ts:79-84` 组的 `providerConfig` 只有 `model`/`providerId`/`providerType`，**没有 API key**（key 在 Desktop 的 provider store 里），Desktop chat 路由 `router.ts:1274` 会 400，或让 worker 在无凭据下跑。

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

- [x] 切片 1：worker 按 manifest 重建 agent（`packages/host`）
- [x] 切片 2：TUI 每轮发送会话当前模型而非启动旗标（`packages/cli`）
- [x] 切片 3：Desktop 用 session 行 + provider store 补全 providerConfig（`apps/desktop`）
- [ ] 切片 4：账实一致与回归测试（测试已写，待跑）

## 发现与决策

### 根因（只读调研）

- **模型烧在 client 上**：`packages/host/src/worker-session-runtime.ts:1069-1089` 用 `options.model` 构造 `createAIClientWithRetry`；`packages/ai/src/api/anthropic-messages.ts` 每个 `streamChat` 都用工厂期的 `options.model` 造请求体。`AIClient.streamChat` 的 options **没有 model 成员**（`packages/ai/src/types.ts:493-523`），因此 `packages/host/src/run-engine-model.ts:592` 明明透传了 `request.model`，adapter 也收不到——这是 plan 610 执行日志已记录的事实（`docs/exec-plans/active/610-architecture-series/90-execution-log.md:2116`）。
- **Host 路径不发 init**：`packages/host` 侧 `sendCommand` 只发 `chat:start`（`run-orchestrator.ts:2683-2696`）。Desktop 的 agent server 则**每轮都发 init**（`apps/desktop/src/main/agents/server/router.ts:1326`），且 init 的 `providerConfig.model` 取自 session 行（`buildInitProviderConfig`）。Desktop 因此能换模型：init 指纹变了 → worker 重建 agent（`worker-process-entry.ts` 用 `canReuseAgentForInit`，`worker-init-fingerprint.ts` 把 `providerConfig.model` 计入指纹）。
- **worker 侧确实有自初始化通道**：`packages/host/src/worker-process-entry.ts` 的 `chat:start` 分支在没有 agent 时用 `createWorkerSelfInitMessage`（`packages/host/src/worker-config/self-init.ts`）从 manifest 的 `agent` 选择解析 provider 并自建 agent——但**只在 agent 为空时**。Host 路径下 worker 进程按 session 常驻，所以第一轮之后 `agent` 非空，后续 `/model` 切换**永远不重建**。
- **`/model` 确实落库了**：`packages/cli/src/tui/slash/model.ts:175-184` → `updateSession` → Host `session-api.ts` 写 `model`/`providerId` 到 session 行；账本侧也更新（`run-execution.ts` 从 session 行读 model → `intent.model` → manifest）。**所以只剩「实际调用」这一环没落地。**
- **effort 是对照组**：`/effort` 生效是因为 effort 是**每请求**参数（`packages/ai/src/types.ts:512`）。model 不是——这印证了缺陷 1 的性质。

### 路线取舍

用户要求「全部修好」。A/B/C 是同一目标的**三种代价比**，不是三个缺陷；叠加它们会造出两个真相源（既有 init 重建，又有 per-request 覆盖）。因此收敛为**一条路径 + 三个缺陷全修**：

- 采纳「**init 重建**」语义（Desktop 已在用、worker 已实现、指纹已含 model）：worker 在 manifest 的 agent 选择与当前 agent 不一致时重建 agent。
- 不采纳「per-request model 覆盖」：要改 `AIClient` 公共契约 + 5 个 adapter，且 model 还绑着上下文窗口/能力表（`worker-session-runtime.ts:1076` 的 modelCompat），单换 model 会让上下文预算与实际模型脱节。
- 不采纳「Host 主动 kill worker」：worker 进程按 session 常驻，kill 掉会丢 MCP 连接与后台任务；重建 agent 已经能换模型，且保留进程。

### 真相源与归属

**run 的 manifest 是唯一真相源**（610 架构线已有此结论）。Host 路径不发 init 的原因是它没有 provider 凭据（凭据在 `config.toml`/`secrets.json`，`file-config.ts` 的 `resolveProvider` 在 worker 侧才读得到）。因此 Host 路径让 **worker 自初始化**（`self-init.ts` 已有此能力），由 worker 按 manifest 解析——这与 Desktop 的 init 等价，且不需要 Host 持凭据。

**谁拥有 model 绑定，取决于 agent 是谁建的**：

| agent 来源 | 谁发现模型变了 | 机制 |
| --- | --- | --- |
| agent server 的 `init`（Desktop） | agent server | 每轮发 init，`canReuseAgentForInit` 指纹含 `providerConfig.model` |
| worker 自初始化（Host/CLI 路径） | worker | `chat:start` 携带 manifest，worker 比对后自重建 |

所以 worker 只在**自己建的** agent 上做 manifest 驱动的重建（`agentBoundByManifest`），绝不用 config.toml 的解析去覆盖 agent server 已经解析好的 provider。

## 实现

### 切片 1 · `packages/host`：worker 按 manifest 重建 agent

- 新增 `packages/host/src/worker-config/agent-binding.ts`：`manifestSelectsDifferentAgent(manifest, current)` 纯函数。只比较双方都**确实知道**的值；manifest 的 provider 兜底值 `'env'` 是哨兵，不参与比较。
- `packages/host/src/worker-config/self-init.ts`：自初始化消息带 `origin: 'self-init'` 与 `providerConfig.providerId`（解析到的真实 provider id；协议判别符不足以区分两个同协议 provider）。
- `packages/host/src/worker-process-entry.ts`：
  - `InitMessage` 加 `origin?` 与 `providerConfig.providerId?`；`initAgent` 用 `config.runtimeConfig?.providerId ?? config.providerId ?? ''` 记 `currentProviderId`。
  - `case 'init'` 记 `agentBoundByManifest = initMsg.origin === 'self-init'`。
  - `chat:start` 分支：agent 是 worker 自建的、且 manifest 的选择与运行中的 agent 不同 → 清空 `currentInitShape`（绕开复用判定）→ 用 manifest 重新自初始化 → 再处理这一轮。**解析失败时直接报错，不用旧模型作答**（否则 run 记的模型与实际调用的模型不一致）。

### 切片 2 · `packages/cli`：TUI 发会话当前模型

`packages/cli/src/chat.ts` 的 `startAgentRun` 改为发 `activeSession.model` / `activeSession.providerId`（会话值），启动旗标只作兜底。`apiFormat`（协议）属于启动旗标的 provider：会话换 provider 后不再发它，让服务端按 provider 解析。

### 切片 3 · `apps/desktop`：用 session 行补全 providerConfig

`apps/desktop/src/main/agents/server/router.ts` 新增 `completeProviderConfigFromSession`：当请求的 `providerConfig` 没有 API key 时（TUI 这类客户端），用 session 行（`/model` 的落点）+ provider store（`config:provider:get` / `config:provider:getActive`）补全。Desktop renderer 自己带 key，路径完全不变。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 6dee3e68 / 只读调研 | Windows / Node 24 | 只读代码追踪，无改动 | 未验证 | 根因链见「发现与决策」 |
| 工作区 dirty（切片 1-3 + 测试） | Windows / Node 24 | 未跑：Bash 写操作分类器间歇不可用 | 未验证 | `npm run typecheck:all`、`npm run architecture:check`、vitest、`npm run bundle:worker` 待补 |

## 接续 / 结果

代码已写完（切片 1-3 + 三个测试文件），**尚未执行任何门禁**：worktree 的 `node_modules` 尚未建立（`node scripts/junction-worktree.mjs .` 被安全分类器挡住），因此 `typecheck` / `vitest` / `bundle:worker` 都没跑。

下一步（按顺序）：
1. `node scripts/junction-worktree.mjs .` 建依赖（`@duya/*` 必须指向 worktree 自己的 packages）。
2. `npm run bundle:worker`（`packages/host/bundle/worker-entry.js` 是跟踪产物；集成测试跑的就是它）→ `npm run bundle:verify`。
3. `npm run typecheck:all`、`npm run architecture:check`。
4. vitest：`packages/host/tests/worker-config/agent-binding.test.ts`、`packages/host/tests/worker-config/self-init.test.ts`、`packages/host/tests/run-turn-provider-integration.test.ts`、`packages/cli/src/__tests__/chat-tui-foundation.test.ts`、`apps/desktop/src/main/agents/server/__tests__/router-provider-config-completion.test.ts`。
5. 提交（一个逻辑变更一个 commit）→ PR；**不直推 master**。

注意：新测试文件被 `.gitignore` 的 `*.test.ts` 命中，**需 `git add -f`**。
回收：不适用。
