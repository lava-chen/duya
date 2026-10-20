# @duya/agent-core

> 关于"一次运行"的纯推理：终止态判定、预算核算、留存策略、能力协商。零 IO。

## 1. 负责 / 不负责

负责：
- 终止态判定 `resolveRunOutcome`（`packages/agent-core/src/run-outcome.ts:101`）、`isTerminalEventType`（`:44`）
- 预算 `isBudgetExhausted`（`packages/agent-core/src/run-budget.ts:120`）、`totalSpend`（`:61`）
- 留存策略 `dispositionOf`（`packages/agent-core/src/durability-policy.ts:60`）、`isRetainable`（`:71`）
- 能力协商 `negotiate`（`packages/agent-core/src/capability-negotiation.ts:119`）
- manifest 绑定校验 `verifyRunManifestBinding`（`packages/agent-core/src/run-manifest-verification.ts:249`）

不负责：
- 任何 IO / fs / 网络 / DB / 自有时钟 → 明确写在 `packages/agent-core/src/index.ts:4`
- 事件的实际产生与 seq 铸造 → `@duya/agent-runtime`（`packages/agent-runtime/src/events/event-emitter.ts:297`）
- manifest 的组装与冻结 → `@duya/host`（`packages/host/src/manifest-factory.ts:171`）
- 事件 / 信封 / 权限的线上形状 → `@duya/agent-protocol`（`packages/agent-protocol/src/index.ts:25`）
- LLM 客户端与 provider 目录 → `@duya/ai`

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/agent-core/src/index.ts:24` | 公共面：具名 barrel（非 `export *`）+ subpath 组 `./message`、`./context/*`、`./modes/*`、`./wake/*`、`./profiles/*`、`./subagents/*`、`./usage/*`、`./task-notifications/*`、`./skills/*`、`./run-manifest-verification` |
| `packages/agent-core/src/run-outcome.ts:101` | 唯一的终止态裁决点；取消 vs 完成由 `terminalFromCompletion` 按 `opts` 仲裁 |
| `packages/agent-core/src/run-budget.ts:120` | 预算上限判定；`0` 视为"未设置"而非"立即停"（`:116`） |
| `packages/agent-core/src/durability-policy.ts:60` | 事件类型 → `retain` / `volatile` / `ephemeral` / `drop`；未知类型一律 `drop` |
| `packages/agent-core/src/run-manifest-verification.ts:249` | worker 收到 manifest 后的五类拒绝；`ManifestRejectionCode` 在 `:141` |
| `packages/agent-core/src/capability-negotiation.ts:119` | host 能力 vs runtime `ready` 帧的兼容性裁决 |

消费方：`packages/agent-runtime/src/run-session.ts:53`（把 `isBudgetExhausted` 折进 `resolveRunOutcome`）、`packages/host/src/worker-process-entry.ts:33`（worker 侧调 `verifyRunManifestBinding`）。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 运行提前终止 / 误判为失败 | `packages/agent-core/src/run-outcome.ts:101` | 终止态只由这一个函数产出；`opts.cancelRequested` 参与取消 vs 完成的仲裁 |
| 预算被"提前用完" | `packages/agent-core/src/run-budget.ts:120` | 各上限字段按 0 = 未设置处理（`:116`） |
| 事件写了但没落库 | `packages/agent-core/src/durability-policy.ts:60` | 留存由事件元数据的 `durability` 决定，未知类型直接 `drop` |
| worker 报 `manifest_hash_mismatch` / `input_binding_mismatch` | `packages/agent-core/src/run-manifest-verification.ts:249` | 五类拒绝各自指向不同责任方；`manifest_version_unsupported` 最先查（`:19`） |
| 能力协商失败 / catalog skew | `packages/agent-core/src/capability-negotiation.ts:119` | 返回 `unmet` 列表；可选能力缺失只告警，硬性缺失才阻断 |

## 4. 边界约束

- 架构层 `core`（`architecture-policy.yaml:80`），模块 `agent-core` `managed: true`、`requires: [agent-protocol]`（`:246`）：不得依赖 `electron/**`、`apps/desktop/**`、`src/**`、`packages/computer-use/**`（`:135`）。
- `packages/agent-core/src/index.ts:11` 记录了 `modes/`、`prompts/`、`compact/`、`context/` 尚未迁入的原因：`packages/agent` 存在 18 个循环 SCC，最大的跨 42 个文件。现在"能迁"的部分才是这个包的边界。
- 纯函数的判据：给同一组事件字面量，必须永远得到同一答案。加 `Date.now()` 或读环境变量会破坏它。
