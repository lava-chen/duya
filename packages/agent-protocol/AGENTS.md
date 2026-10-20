# @duya/agent-protocol

> 传输中立的线上契约：事件、信封、manifest、权限、错误分类。零运行时依赖，**不做任何 IO**。

## 1. 负责 / 不负责

负责：
- `RunEvent` 联合与元数据表 `EVENT_REGISTRY`（`packages/agent-protocol/src/events/registry.ts:238`）
- `RunEventEnvelope` 与 seq 契约 `SEQ_CONTRACT`（`packages/agent-protocol/src/envelope.ts:131`）
- `RunManifest`（`packages/agent-protocol/src/manifest.ts:139`）与指纹 `manifestFingerprint`（`:209`）
- seq 铸造状态机 `RunLedger`（`packages/agent-protocol/src/run-ledger.ts:93`，`emit` 在 `:165`）
- Host 边界接口：`HostRunApiV1`（`packages/agent-protocol/src/run-api.ts:100`）、`HostRunExecutionApiV1`（`:262`）、`HostSessionApiV1`（`packages/agent-protocol/src/session-api.ts:443`）

不负责：
- 任何 IO / 时钟 / 存储 → 运行时装配在 `@duya/agent-runtime`，表在 `@duya/data`
- seq 的实际铸造与事件流 → `@duya/agent-runtime`（`packages/agent-runtime/src/events/event-emitter.ts:297`）
- manifest 的冻结与持久化 → `@duya/host`（`packages/host/src/manifest-factory.ts:171`）
- 内置 provider/model 目录数据 → `@duya/ai`（`packages/ai/src/providers/catalog-data.ts:40`）；能力覆盖表在 `@duya/data`（`packages/data/src/provider-model-capability-store.ts:29`）

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/agent-protocol/src/index.ts:25` | 公共面：单一根 barrel + 40 个 subpath export；`legacy/`、`testing/` 故意不 re-export（`:11`） |
| `packages/agent-protocol/src/run-ledger.ts:93` | seq 的唯一权威。`emit` 在 `:165`；违规抛 `LifecycleViolation`，11 个 code 列在 `:43` |
| `packages/agent-protocol/src/envelope.ts:131` | `SEQ_CONTRACT`：`start=1`、`step=1`、`owner='runtime'`、`uniqueWithin='run'` |
| `packages/agent-protocol/src/events/registry.ts:238` | 每个事件的 `durability` / `category`；`dispositionOf` 据此决定能否落库 |
| `packages/agent-protocol/src/manifest.ts:209` | 指纹 = canonical JSON 的 sha256，用自研 `hash.ts`（禁 `node:crypto`） |
| `packages/agent-protocol/src/worker-protocol.ts:269` | `WorkerCommand` 联合：Host↔worker 命令 DTO |

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 事件顺序错 / seq 跳号 | `packages/agent-protocol/src/run-ledger.ts:165` | `emit` 是唯一入口，违规抛 `LifecycleViolation`（code 见 `:43`：`seq_gap`、`event_after_terminal`…） |
| 消费者说"事件不认识" | `packages/agent-protocol/src/events/registry.ts:238` | 未知事件必须忽略；`durability` 决定它是否落库 |
| manifest 指纹对不上 | `packages/agent-protocol/src/manifest.ts:209` | 字段顺序或 `undefined` 键差异都会改变摘要 |
| worker 拒绝这一轮 | `packages/agent-protocol/src/manifest.ts:139` | manifest 形状由协议定义，冻结由 `@duya/host` 做 |
| 续跑游标算错 | `packages/agent-protocol/src/replay.ts` | 游标是纯 scope 算术，不存状态 |

## 4. 边界约束

- 架构层 `protocol`（`architecture-policy.yaml:79`），模块 `agent-protocol` `managed: true`、`requires: []`（`:202`）：指向 `packages/agent-core/**`、`packages/agent-runtime/**`、`electron/**`、`src/**` 的边全被禁（`:124`）。
- `dependencies` 必须保持为空（`packages/agent-protocol/package.json:185`），漂移测试 `packages/agent-protocol/test/01-import-graph.test.ts` 会红。
- 唯一的状态机例外是 `run-ledger.ts`（`packages/agent-protocol/src/index.ts:15`）：它是协议自己的状态机，不是给 host 抄的参考实现。
