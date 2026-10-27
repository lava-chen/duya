# @duya/bot

> 长期个人 Bot 的领域层：这个角色是谁、哪些输入应推进它、身份如何被一致地读写。零 IO。

## 1. 负责 / 不负责

负责：
- 身份形状 `BotIdentityEntry` 及子结构（`packages/bot/src/domain/identity.ts`）、profile 的纯类型（`packages/bot/src/domain/profile.ts`）
- 身份规则：upsert 合并 `buildUpsertedAgent`、身份补丁 `applyIdentityPatch`、canonical 视图（profile 优先 → config 兜底 → id 最后），见 `packages/bot/src/domain/rules.ts`
- bot id 规则与校验（`packages/bot/src/domain/bot-id.ts`）
- 身份意图账本的状态机 `BotIdentityJournalState`（`packages/bot/src/journal/journal.ts`）：intent / applied / receipt 簿记、requestId 去重、corrupt 行计数
- 应用用例 `createBotService`（`packages/bot/src/application/service.ts`）：create / update / get / list / repair；revision 冲突语义与 requestId 幂等
- 端口定义 `BotIdentityStorePort` / `BotProfilePort` / `BotIdentityJournalPort`（`packages/bot/src/ports/ports.ts`）

不负责：
- 任何 IO：`fs` / SQLite / 网络 / 定时器 / 随机源 → 全部由 Host 适配器注入（`packages/host/src/bot/`）
- 文件格式与落盘位置 → `@duya/host`（TOML store `packages/host/src/bot/toml-config-store.ts`、JSONL journal `packages/host/src/bot/file-journal.ts`、profile `packages/host/src/bot/fs-profile-store.ts`）
- 线上 DTO 的定义 → `@duya/agent-protocol`（`packages/agent-protocol/src/bot-api.ts`）
- 唤醒、调度、Run 受理、投递 → 后续切片；本包不拥有任何调度器
- 模型 / 工具轮次 → `@duya/agent-runtime`；推理 → `@duya/agent-core`

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/bot/src/index.ts` | 公共面：具名导出（domain / journal / ports / application 四组） |
| `packages/bot/src/domain/identity.ts` | `[agents.<id>]` 身份条目形状，含 `revision`（facade 创建=1、每次 facade 更新 +1、0 = 前 facade 时代条目） |
| `packages/bot/src/domain/rules.ts` | 身份合并与 canonical 视图规则；不改 provider / model / tools / prompt |
| `packages/bot/src/domain/bot-id.ts` | bot id 字符集与校验（kebab-case，最长 63） |
| `packages/bot/src/journal/journal.ts` | 身份意图状态机 + 内存实现；文件格式在 Host 侧 |
| `packages/bot/src/ports/ports.ts` | 存储与 profile 端口；端口只暴露原子业务操作，不给裸 SQL |
| `packages/bot/src/application/service.ts` | 应用服务；`repair()` 负责把未完成意图补齐 |

## 3. 约束

- **零 `node:*` 导入**：随机源（`randomSuffix`）与时间由端口注入；`grep -rn "from 'node:" packages/bot/src` 必须为空。
- **只依赖 `@duya/agent-protocol`**：不得 import host / runtime / data / memory / Electron。方向由 `scripts/architecture/bot-boundary-gate.mjs` 的 R1 规则强制（该包出现后规则自动从 pending 翻为 measured）。
- **纯移动优先**：把规则搬进本包时，断言语义不得改变；行为修改另开切片。
- **revision 是唯一并发权威**：facade 是唯一 bump 者；legacy writer 不动它。冲突以 `bot_revision_conflict` 拒绝，`details` 带 `storedRevision` / `expectedRevision`。
- **一个意图覆盖两处身份写入**：config entry 与 runtime profile 一起改，canonical 视图不得出现分裂状态。

## 4. 测试

- `packages/bot/tests/`：纯用例（内存端口、状态机、身份规则）。
- Host 文件后端用例在 `packages/host/tests/bot/`（TOML / JSONL / repair-at-open）。
- 行为不变对照：S1 的 22 例语义必须原样全绿（见计划 `docs/exec-plans/active/2026-10-25-personal-bot-framework.md` 的 S1/S2 执行记录）。
