# @duya/plugin-core

插件分发框架。拥有 manifest / catalog 格式适配器、MCP 纯解析引擎、信任与安全原语、workflow 模板 schema、App 声明 schema。

## 1. 负责 / 不负责

**负责**

- 插件清单的**格式适配与归一化**（duya 原生 / claude-code / codex / cursor）。
- MCP 的纯计算部分：工具枚举、错误分类、熔断处置、deadline clock、环境变量展开、source 遮蔽、工具名分配。
- 插件能力发现的**扫描**、信任等级、App 声明与 workflow 模板 schema。

**不负责**

- 插件的运行时执行与注册 → `@duya/host`（`packages/host/src/connector-services/apply.ts:427` 把声明变成注册表条目）。
- 运行时权限裁决 → `@duya/agent-runtime`（`packages/agent-runtime/src/authorization/permissions/permissions.ts:238` 的 `decideMcpSource`）。
- 桌面侧清单读取 → 桌面 app（`apps/desktop/src/main/plugins/manifest.ts:844` 的 `readPluginManifest`）。
- 插件贡献的**工具实现** → `@duya/capabilities`。

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/plugin-core/src/mcp/core/index.ts:6` | 纯 MCP 引擎 barrel：`classifyMcpError` / `breakerDisposition`（`:6-13`）、`createDeadlineClock`（`:21`）、`canonicalizeJson` + `computeSchemaRevision`（`:27`）、`listAllTools`（`:31`）、alias 分配（`:45`）。无 Node 内建依赖。 |
| `packages/plugin-core/src/mcp/resolve.ts:591` | `resolveMCPDiscovery()`——唯一带 fs 的 MCP 文件；静态路径检查 `staticPathCheck:415`。 |
| `packages/plugin-core/src/mcp/provider-tool-name.ts:233` | `computeProviderName()`；策略表 `AnthropicToolNamePolicy:29`、`OpenAIToolNamePolicy:37`。 |
| `packages/plugin-core/src/mcp/scope.ts:34` | `scopedPluginServerName`；`toolInternalKey:48`、`buildInventoryId:110`。 |
| `packages/plugin-core/src/formats/types.ts:81` | `NormalizedPluginManifest`；适配器 `packages/plugin-core/src/formats/duya.ts`、`packages/plugin-core/src/formats/claude-code.ts`、`packages/plugin-core/src/formats/codex.ts`、`packages/plugin-core/src/formats/cursor.ts`，注册表 `packages/plugin-core/src/formats/registry.ts:33`。duya 原生路径 `.duya-plugin/plugin.json`（`packages/plugin-core/src/formats/duya.ts:24`）。 |
| `packages/plugin-core/src/plugins/loader/capability-discovery.ts:114` | `discoverMcpServers`；`discoverAgentPluginsMcpServers:272`、`discoverAllCapabilities:423`。 |
| `packages/plugin-core/src/security/trust-engine.ts:25` | `TRUST_LEVEL_CAPABILITIES`——静态信任分层。 |
| `packages/plugin-core/src/apps/declarations.ts:47` | `PluginAppDefinitionSchema`（zod）；workflow 模板 `packages/plugin-core/src/workflows/schema.ts:23`、`packages/plugin-core/src/workflows/instantiate.ts:90`。 |

公共面：`packages/plugin-core/src/index.ts`（barrel），外加 `packages/plugin-core/package.json` 里 21 个子路径导出（`./mcp/resolve`、`./mcp/user-config`、`./security/path-validator` 等）。

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| MCP server 明明配了却"找不到" | `packages/plugin-core/src/mcp/resolve.ts:415` + `packages/host/src/connector-services/loader.ts:80` | 解析层只做**静态**检查（脚本缺失 / env 缺失 / 路径越界），运行时加载在 host。 |
| 插件加载失败 | `packages/plugin-core/src/plugins/loader/capability-discovery.ts:423` + `apps/desktop/src/main/plugins/manifest.ts:844` | 一半是扫描，一半是清单解析。 |
| 插件不被信任 / 权限被拒 | `packages/plugin-core/src/security/trust-engine.ts:25` + `packages/agent-runtime/src/authorization/permissions/permissions.ts:238` | 前者是静态分层，后者才是运行时闸门。 |
| MCP 工具改名 / 名字冲突 | `packages/plugin-core/src/mcp/provider-tool-name.ts:233` | provider 可见名与 internalKey 是两套命名。 |
| 插件贡献的工具没出现在模型列表里 | `packages/host/src/connector-services/apply.ts:425` | `providerNameToInternalKey` 映射表在此建立。 |

## 4. 边界约束

- `architecture-policy.yaml:524-527`：模块 `legacy-plugin-core`，`managed: true`，`requires: []`。
- **barrel 刻意不 re-export 三个带 Node 内建的模块**（`packages/plugin-core/src/index.ts:71-93`）：`mcp/resolve`、`mcp/user-config`、`security/path-validator`。Node 侧消费者走 `@duya/plugin-core/<subpath>` 子路径导入——加回 barrel 会把 `fs` / `path` / `@iarna/toml` 拖进浏览器包。
- `packages/plugin-core/src/security/permission-service.ts:40` 是**审计账本，不是运行时拦截**。它头部 `:5-7` 指向的那个 agent 侧 MCP 权限闸门文件已不存在，真正的运行时闸门在 `@duya/agent-runtime`。
