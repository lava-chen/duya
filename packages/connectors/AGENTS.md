# @duya/connectors

> App Connector 的**词汇表**：`.app.json` 声明 schema + connector-id 命名空间。零 IO。

## 负责 / 不负责

- **负责**：`AppDeclarationFileSchema` 等 zod schema、`parseAppDeclarationFile()`、connector-id 的构造与校验（`asAppConnectorId` / `isWellFormedConnectorId` / `isBuiltinConnectorId` / `pluginConnectorId`）。
- **不负责**：IO、OAuth 流程、凭据、插件安装、运行时 → `@duya/desktop`（`apps/desktop/src/main/services/app-connections/connector-service.ts:1`）；插件分发 → `@duya/plugin-core`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/connectors/src/index.ts:1` | 公共面：`.` 重导出两个子路径 |
| `packages/connectors/src/app-schema.ts:114` | `AppDeclarationSchema`；`OAuthClientDeclarationSchema` 在 `:44`，`RestInvokeDeclarationSchema` 在 `:73` |
| `packages/connectors/src/app-schema.ts:194` | `parseAppDeclarationFile()` — 解析并归一化声明文件 |
| `packages/connectors/src/app-connector-id.ts:13` | `asAppConnectorId()`（brand 类型）；`BUILTIN_CONNECTOR_IDS` 在 `:18` |

公共面：`@duya/connectors`、`@duya/connectors/app-connector-id`、`@duya/connectors/app-schema`（3 个源文件，305 行）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| `.app.json` 解析失败 | `packages/connectors/src/app-schema.ts:194` — schema 形状在此 |
| 新增一种声明字段 | `packages/connectors/src/app-schema.ts:73` / `:93` / `:114` — 三个 schema 逐层嵌套 |
| connector id 校验不过 | `packages/connectors/src/app-connector-id.ts:44` — `isWellFormedConnectorId` 的命名规则 |
| 插件自带连接器 id 不对 | `packages/connectors/src/app-connector-id.ts:53` — `pluginConnectorId(configName, connectorId)` |
| 连接器运行时不通 | `apps/desktop/src/main/services/app-connections/connector-service.ts:1`（本包只管声明，不管执行） |

## 边界

- `architecture-policy.yaml:565` — 模块 `connectors`，`managed: true`，`requires: []`（不 import 任何 `@duya/*` 包）。
- **App Connections（OAuth / REST / MCP）与每 bot 的频道连接器（飞书 / Telegram / 微信）是两个子系统**：后者在 `apps/desktop/src/main/channels/connector-runtime.ts:1`，不归本包。
