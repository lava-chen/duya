# @duya/gateway

> 外部平台网关（Telegram / 飞书 / 微信 / Discord）→ DUYA 智能体。
> **作为 Electron 主进程 fork 出来的子进程运行。**

## 1. 负责 / 不负责

负责：
- 平台适配器注册与消息收发（`packages/gateway/src/adapters/base.ts`）
- 网关生命周期 `GatewayManager`（`packages/gateway/src/gateway-manager.ts:188`）
- 平台 → 智能体 profile 的路由匹配（`packages/gateway/src/profile-routing.ts:70`）
- 命令检测与注册表（`packages/gateway/src/commands/registry.ts`）——**执行在主进程**
- 与主进程的 IPC 客户端（`packages/gateway/src/ipc-client.ts`）

不负责：
- 命令的实际执行 → Electron 主进程（`apps/desktop/src/main/channels/`）
- 智能体运行时 → `@duya/agent-runtime` / `@duya/host`
- 聊天 UI → `@duya/ui`
- 凭据存储 → 桌面主进程的连接器 secret store

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/gateway/src/gateway-manager.ts:188` | `GatewayManager`，网关生命周期与平台启停 |
| `packages/gateway/src/adapters/base.ts` | `PlatformAdapter` 契约、`createAdapter`、`registerAdapterFactory` |
| `packages/gateway/src/profile-routing.ts:70` | `matchProfileRoute` — 平台消息该路由到哪个 profile |
| `packages/gateway/src/commands/registry.ts` | `COMMAND_REGISTRY` + `resolveCommand`；这里只做**检测**，执行在主进程 |
| `packages/gateway/src/proxy-fetch.ts` | 代理状态查询 `getProxyStatus` |
| `packages/gateway/src/ipc-client.ts` | 网关 ↔ 主进程的 IPC 通道 |

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| 平台消息进不来 | `packages/gateway/src/gateway-manager.ts:188` | 适配器连接与生命周期都在这 |
| 消息路由到了错误的 agent | `packages/gateway/src/profile-routing.ts:70` | 匹配规则与排序都在这（`sortRoutes` `:62`） |
| 平台命令没反应 | `packages/gateway/src/commands/registry.ts` | 只负责检测；执行在主进程，先确认是否被拦截 |
| 网关子进程起不来 | `packages/gateway/src/index.ts` | 子进程入口在此 |

## 4. 边界约束

- 架构层 `host`（`architecture-policy.yaml:119`），模块 `legacy-gateway` `managed: false`。
- **命令执行不在本包**：本包只做检测与注册，执行在主进程（plan 520 的拆分）。
- `managed: false` 意味着本包的架构违规不阻断门禁，只能随迁移收敛。
