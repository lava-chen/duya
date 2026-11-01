---
title: "@duya/agent-protocol"
description: DUYA 工作区内 Session、Run、事件与 Host API 的传输中立契约。
---

本文描述 DUYA 主仓库当前 `packages/agent-protocol` 的代码契约：它定义跨 Host、Runtime 和调用端传递的数据形状与边界，不负责执行这些操作。

> **契约范围**：该 Package 在 `package.json` 中标记为 `private`。这里的“公开导出”指主仓库中由 `exports` 明确声明、供 workspace package 使用的入口，不代表对外发布的 npm API 或独立的长期兼容承诺。本文按主仓库当前源码整理。

## 职责与非职责

`@duya/agent-protocol` 负责定义和校验跨进程契约，包括：

- Session、Run、权限、能力和错误等 API DTO 与接口类型。
- `RunEvent` 事件联合、事件元数据注册表和事件信封。
- Run Manifest 结构与稳定指纹计算。
- 运行事件序号约束及纯协议状态机 `RunLedger`。
- Bot、Plugin、MCP、Channel、Workflow 等由 Host 与客户端共享的契约。

它不创建 Session、不运行 Agent、不连接模型、不持久化数据库，也不启动 HTTP/SSE 或 Worker。具体实现分别由 `@duya/host`、`@duya/agent-runtime`、`@duya/data` 和调用端提供。

## 依赖与边界

| 属性 | 当前契约 |
| --- | --- |
| 运行时依赖 | 无；`dependencies` 为空 |
| IO | 不执行文件、网络、数据库或进程 IO |
| 架构位置 | `protocol` 基础层；不依赖 Host、Runtime 或 UI |
| 包入口 | 根入口和 `package.json` 声明的子路径入口 |
| 本地约束 | import-graph 漂移测试保护零运行时依赖和层级方向 |

包边界的依据是 `packages/agent-protocol/package.json`、`src/index.ts` 和主仓库的架构边界规则。`src/index.ts` 是根入口；`/testing` 与 `/legacy` 是显式子路径，但不会被根入口重新导出。生产代码不应通过 `/testing` 引入协议实现。

## 主要导出面

Package 有较多领域子路径；下表列出编写 Session 与 Run 集成时最常接触的入口。完整清单以 [`package.json`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/package.json) 的 `exports` 字段为准。

| 导入入口 | 主要契约 | 源码位置 |
| --- | --- | --- |
| `@duya/agent-protocol` | 跨领域公共类型、事件、Manifest、Run API、错误和纯协议工具 | [`src/index.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/index.ts) |
| `@duya/agent-protocol/session-api` | Session 记录、创建/更新输入、分页、Timeline 与 `HostSessionApiV1` | [`src/session-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/session-api.ts) |
| `@duya/agent-protocol/session-fork` | Session 历史分叉输入与结果 | [`src/session-fork.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/session-fork.ts) |
| `@duya/agent-protocol/rollout-events` | 持久化 rollout 事件和读取游标相关类型 | [`src/rollout-events.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/rollout-events.ts) |
| `@duya/agent-protocol/worker-protocol` | Host 与 Worker 之间传递的命令 DTO | [`src/worker-protocol.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/worker-protocol.ts) |
| `@duya/agent-protocol/plugin-inventory` | Plugin 能力清单相关 DTO | [`src/plugin-inventory.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/plugin-inventory.ts) |
| `@duya/agent-protocol/plugin-setup` | Plugin 配置与安装流程相关契约 | [`src/plugin-setup.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/plugin-setup.ts) |
| `@duya/agent-protocol/bot-api` | Bot 管理 API 的输入、记录与结果类型 | [`src/bot-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/bot-api.ts) |

子路径由 `package.json` 的 `exports` 映射到构建产物；直接从未声明的 `src/**` 深层路径导入不属于包接口。

## Session API

`HostSessionApiV1` 是异步服务边界类型，不是 HTTP 客户端。它定义 Host 实现需要提供的 Session 操作，调用端通过对应的 Host adapter/客户端调用这些能力。

核心形状如下（具体参数和返回联合以 `src/session-api.ts` 声明为准）：

```ts
interface HostSessionApiV1 {
  create(input: HostSessionCreateInput): Promise<HostSessionRecord>;
  get(
    sessionId: SessionId,
    options?: { readonly includeAllSessions?: boolean },
  ): Promise<HostSessionRecord | null>;
  list(query?: HostSessionListQuery): Promise<HostSessionPage>;
  update(
    sessionId: SessionId,
    expectedUpdatedAt: Millis | undefined,
    patch: HostSessionPatch,
  ): Promise<HostSessionUpdateResult>;
  delete(sessionId: SessionId, expectedUpdatedAt?: Millis): Promise<HostSessionDeleteResult>;
  readMessages(sessionId: SessionId, query?: HostMessageReadQuery): Promise<HostMessagePage>;
  appendTimeline(sessionId: SessionId, input: HostTimelineAppendInput): Promise<HostTimelineWriteReceipt>;
}
```

接口还覆盖搜索、归档/恢复、分叉、Timeline 读取与写入、rollout 索引重建等操作。`HostSessionRecord` 携带 Session 标识、Workspace 绑定、标题、模型/provider、权限模式和父子关系等元数据；消息历史通过独立的 Timeline/rollout 类型读写。

### Workspace 路径约束

普通 Session 创建输入用 `workspaceId`、`workspaceRootId` 和相对 Workspace 根目录的 `workspaceRelativePath` 表达工作位置。协议注释明确指出原始文件系统路径不应通过此 API 传递；路径解析、授权和根目录校验属于 Host 职责。Host 本地导入兼容类型是单独的 local-only 接口，不应当作远程 Session API 使用。

### 并发与删除

- `update` 接收 `expectedUpdatedAt`，用于让 Host 对并发更新做条件检查；调用方不应假设它是无条件覆盖。
- `delete` 是软删除契约：Host 保留记录以便恢复与审计。
- `archive` 会检查运行时锁；`unarchive` 只恢复目标 Session，后代仍保持归档。
- `list` 的 `cursor` 是不透明分页游标；调用方不应解析或自行生成。

## Run、Manifest 与事件

Session 描述持续工作的上下文；每次执行由独立 Run 表示。`HostRunApiV1` 定义 Run 记录和事件的 Host 边界，`HostRunExecutionApiV1` 定义启动、取消、观察实时事件和 steer 等执行控制形状。它们都是契约接口，不包含 Run 调度实现。执行接口中启动和取消是必需方法；实时事件观察与 steer 是可选能力。

事件追加和终态结算需要调用方提供 `RunAttemptFence`。Host 必须拒绝已被新 attempt 取代的旧 attempt 写入，避免过期 Worker 覆盖当前 Run 状态。实时事件观察是进程内可选流，未写入事件账本的临时事件只通过该流提供；如果 `steerAgentRun` 不存在，调用方应保留消息并在当前 Run 结束后排入下一轮。

Run 的关键数据流如下：

1. Host 接收启动意图并创建 Run。
2. Host 解析并冻结 `RunManifest`，其中包含 Workspace、cwd、权限策略、能力快照、连接器绑定和配置来源；Manifest 不携带密钥。
3. Runtime 执行 Run 并生成 `RunEventEnvelope`。
4. Host 接收事件、持久化需要持久化的记录，并结算终态。

Manifest 的创建与冻结由 Host 负责；协议只定义其形状和 `manifestFingerprint`。Run 的事件序号由 Runtime 生成，而不是由 Session 或 UI 客户端生成。

```ts
interface RunEventEnvelope<T extends RunEvent = RunEvent> {
  readonly runId: RunId;
  readonly sessionId: SessionId;
  readonly seq: number;
  readonly timestamp: EventTimestamp;
  readonly traceId: TraceId;
  readonly spanId?: SpanId;
  readonly parentRunId?: RunId;
  readonly payload: T;
}
```

`SEQ_CONTRACT` 定义每个 Run 从 `1` 开始、每次递增 `1`，由 Runtime 负责生成；事件身份是 `(runId, seq)`，不是 `(sessionId, seq)`。`EVENT_REGISTRY` 为事件给出类别和 durability 元数据，消费者应按元数据处理持久化语义；未知事件应忽略，且不可持久化。`ControlFrame` 的 `hello`、`ready`、`error` 属于无序号控制帧，不是 RunEvent。

## 协议兼容性

版本有两个互相独立的轴：`PROTOCOL_MAJOR.MINOR` 表示 wire 协议版本，`PROTOCOL_SCHEMA_REVISION` 表示 payload 结构修订。`isCompatible` 对协议主版本做硬性检查；事件和控制方法还可以通过 gate 声明最低协议版本、最低 schema revision 和所需 Host capability。`negotiate` 在 Runtime 必需的 Host capability 缺失时返回拒绝，不会假装以降级模式连接。

增加或修改跨边界的事件和方法时，应同时检查 `EVENT_META`、`CONTROL_GATE`、schema revision 和生产者/消费者实现。版本常量本身不会自动让未登记的消息获得兼容性保证。

## 类型导入示例

这个示例只展示如何依赖 Session 服务边界类型。`@duya/agent-protocol` 不提供 `api` 的实现，也不会自行连接 Host：

```ts
import type { HostSessionApiV1, SessionId } from "@duya/agent-protocol";

export function readSession(api: HostSessionApiV1, id: SessionId) {
  return api.get(id);
}
```

实际应用应使用自己所在层提供的 Host 客户端或 adapter，不要在 UI、Runtime 或外部插件里复制一套 Session 存储实现。

## 源码与契约校验入口

- 包导出面：[`package.json`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/package.json) 与 [`src/index.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/index.ts)
- Session DTO 和接口：[`src/session-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/session-api.ts)
- Run 边界：[`src/run-api.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/run-api.ts)
- 事件 envelope 与序号规则：[`src/envelope.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/envelope.ts) 和 [`src/run-ledger.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/run-ledger.ts)
- Manifest：[`src/manifest.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/manifest.ts)
- 版本与协商：[`src/version.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/version.ts) 和 [`src/compatibility.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/compatibility.ts)
- 事件类型与 durability：[`src/events/registry.ts`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/src/events/registry.ts)
- 包职责和架构限制：[`packages/agent-protocol/AGENTS.md`](https://github.com/lava-chen/duya/blob/master/packages/agent-protocol/AGENTS.md)
