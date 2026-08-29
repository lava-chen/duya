# Plan 455: 统一 AppConnector 类 + 插件 .app.json 声明层（适配器出本地代码）

> **Status**: Phase A/B ✅（2026-08-29，分支 `feat/455-app-connector-registry`）；Phase C/D 待开工
> **Priority**: P1
> **Created**: 2026-08-29（同日结合 Plan 460 重写：统一类 + 适配器声明化收口）
> **前置**: Plan 449/450（审批分级、@激活、目录缓存，已落地）
> **配套**: [460-rest-template-connector](./460-rest-template-connector.md)（本计划 Phase A/B 是其硬前置；460 = `rest` 绑定实现 + slack/m365/google 迁移）；[452 Phase B/C](./452-mcp-direct-and-plugin-unification.md)（引用式 apps 声明 + plugin:// mention，与本计划共用 `.app.json`）；[452 Phase B](./452-mcp-direct-and-plugin-unification.md) 的官方插件包是本计划的分发载体
> **源码依据**: `E:\cloned-projects\codex`（`connectors/src/plugin_config.rs`、`snapshot.rs`、`plugin/src/manifest.rs`、`plugin/src/lib.rs:33-56`）

## Goal

两件事，同一个终点：

1. **统一 AppConnector 类**：现在 per-app 职责分散在 `providers/registry.ts`（OAuth
   client 数据）、`connectors/*.ts`（descriptor + invoke，每 app 一个 TS 文件）、
   `connector-service.ts`（闭合 `Map<ProviderId, ConnectorModule>`）三层。收敛为
   **单一 `AppConnector` 抽象 + 三种运行时绑定**（`mcp-remote` / `rest` / `custom`），
   由一个工厂从声明数据构造。
2. **适配器职责声明化**：per-app 的 OAuth client 数据、工具 descriptor、REST invoke
   模板全部落进插件 `<pluginDir>/.app.json`。duya 本地代码只保留**引擎**（OAuth
   flow、token vault、三种绑定运行时、审批/门控），不再保留**适配器**。

终态检验：新增/修改一个 app 的工具集 = 改一份 JSON，不改任何 TS。

## 现状：适配器职责分布（2026-08-29 核实）

| 位置 | 行数 | 承担的 per-app 职责 |
|---|---:|---|
| `types.ts:10` | — | `ProviderId` 11 字面量闭合 union |
| `providers/registry.ts` | 237 | OAuth client 配置（authUrl/tokenUrl/redirectPath/scopes/remoteMcpUrl/label/monogram） |
| `providers/{google,microsoft365,slack}.ts` | ~112 | userinfo/refresh 等 per-provider 特例 |
| `connectors/slack.ts` | 123 | descriptor + REST invoke（纯 HTTP+Bearer，可声明化） |
| `connectors/microsoft365.ts` | 112 | descriptor + REST invoke（可声明化） |
| `connectors/google.ts` | 341 | descriptor + REST invoke（80% 可声明化）+ MIME export/二进制下载/multipart（不可） |
| `connectors/wecom.ts` | 257 | spawn 外部 `wecom-cli` 子进程（不可声明化） |
| `connector-service.ts:51` | — | 闭合 `Map<ProviderId, ConnectorModule>` 路由 |
| `connector-types.ts` | — | `ConnectorModule` 接口（已是单形态，但 provider 字段闭合、工厂分散） |

## 职责去向表（本计划的核心）

| 职责 | 现在 | 去向 |
|---|---|---|
| id / label / category / monogram / description | `providers/registry.ts` | `.app.json` 顶层 + `interface` 段 |
| OAuth client 数据（authUrl/tokenUrl/revokeUrl/redirectPath/defaultScopes/remoteMcpUrl） | `providers/registry.ts` | `.app.json` `oauth` 段（**仅 public client 数据**，无 secret；env/user override 逻辑留在 registry） |
| 工具 descriptor（name/description/inputSchema/inputSchemaSummary/riskTier/action） | `connectors/*.ts` 的 `listXDescriptors` | `.app.json` `tools[]` |
| REST invoke 映射（method/url/headers/query/body/错误映射/dataPath） | `connectors/*.ts` 的 invoke 函数 | `.app.json` `tools[].invoke`（实现归 **Plan 460**） |
| 特殊 token 处理 / 二进制 / multipart / CLI 子进程 | `connectors/{wecom,google}.ts` | 本地 `custom` 绑定注册表（escape hatch，**只减不增**） |
| 路由 | `connector-service.ts` 闭合 Map | `AppConnectorRegistry`（.app.json 装载 + custom 注册表合流） |
| userinfo/refresh 特例 | `providers/{google,...}.ts` | OAuth 引擎通用化（标准 RFC 6749/9728 路径全部声明化；特例随 app 降级为 `custom` 或后续声明字段） |

## Design Decisions

| # | Decision | Choice | Reason |
|---|---|---|---|
| D1 | 类型开放 | `ProviderId` 闭合 union → branded `AppConnectorId`（`string & { readonly __brand: 'AppConnectorId' }`）；内置 11 id 保留为 `BUILTIN_CONNECTOR_IDS` 常量 + narrow 函数 | 对齐 codex plain-String newtype；目录不再闭合在类型层。DB `provider` 列存原始 string，无迁移 |
| D2 | 统一类 | `AppConnector`（演进替换 `ConnectorModule`）：`{ id, binding: 'mcp-remote'\|'rest'\|'custom', meta, oauth?, listDescriptors(connectionId), invoke(action, args, accessToken) }` + **单一工厂** `createAppConnector(decl, runtime)` 按 binding 分派 | 三种形态一个接口一个工厂；`invoke(action,...)` 的 action 分发键语义不变（rest→模板、custom→注册表、mcp-remote→透传） |
| D3 | 单一声明文件 | per plugin root 一份 `.app.json`（对齐 codex `PluginAppFile`/`.app.json` 命名，兼并 452 Phase B 既有计划）。**引用式与定义式是同一 schema 的两个子集**：引用式条目 `{ id, category? }`（452），定义式条目含 `oauth` + `tools[]`（本计划 + 460） | 452/455/460 三个计划收敛到一个文件家族，不再有 connectors.json/.app.json 分叉 |
| D4 | custom 安全边界 | **只有首等方代码可注册 `custom` 绑定**（`CustomConnectorImplementations` 本地 map）；插件声明数据永远不能执行本地代码——第三方只能用 `mcp-remote` / `rest` | 声明化不能变成任意代码执行通道；wecom/google-multipart 是仅有的合法居民 |
| D5 | OAuth 安全 | `.app.json` `oauth` 段仅允许 public client 数据（PKCE，无 secret）；`remoteMcpUrl`/`authUrl`/`tokenUrl` 仅 https；第三方包**永不**内嵌凭据；trust level（plan 92）可整体禁用第三方 connector | client secret 不可分发；与 460 D9 一致 |
| D6 | riskTier | `tools[].riskTier` 声明生效；缺失时走 449 annotations/fallback；`destructive` 强确认路径不可被声明绕过 | 审批面零新协议（449） |
| D7 | 生命周期 | 插件卸载 → 其声明 connector 下线、连接记录保留（对齐 plan 314 准则 4/5）；内置 official 包（452 Phase B）随 app 分发、不可卸载 | 全局连接与插件解耦 |
| D8 | 迁移排序 | builtin 迁移**不归本计划**：slack/m365/google 走 460 Phase 2-4（REST Template 声明化），wecom 留 custom；452 Phase B 的官方插件包是迁移后的落点 | 渐进：先有统一类和 schema（455），再逐 provider 迁（460），最后打包（452 B） |

## Phases

### Phase A: 类型开放
- [x] `AppConnectorId` brand + `BUILTIN_CONNECTOR_IDS` + `asAppConnectorId` narrow
- [x] 全部消费点切换（types / providers / connectors / connector-service /
      connection-store / token-service / oauth flows / manifest + renderer DTO）
- [x] 单测：brand narrow + 常量完备性（plugin-core `tests/app-schema.test.ts`）

### Phase B: 统一类 + .app.json schema + 解析
- [x] `packages/plugin-core/src/connectors/app-schema.ts`：zod schema——
      引用式子集（452）+ 定义式子集（`interface`/`oauth`/`tools[]`）+
      `tools[].invoke` 字段位（460 填充）；id 命名空间 `plugin-<config-name>-<id>`
- [x] `AppConnectorResolution`（binding/meta/declaration）+ `AppConnectorRegistry.resolve`
      作统一分派点（rest 分支 fail-closed 占位，460 接管）+ `registerCustomConnector`
      首等方 custom 注册表 + `declarativeDescriptors` 投影
- [x] `connector-service.ts`：闭合 Map → `AppConnectorRegistry`；providers registry
      开放为 `Map` + `registerProviderConfig`/`unregisterProviderConfig`（Phase C 装载
      `.app.json` 时投影 `ProviderClientConfig`）；policy-gate 已是 string 键无需改
- [x] 单测：schema 9 条（坏 JSON/非 https/命名/枚举/首错路径）+
      `app-connector-registry.test.ts` 7 条（三绑定分派、引用回落、builtin 保留、
      卸载生命周期）+ provider-registry 开放注册 3 条

### Phase C: 接线 + UI
- [ ] 插件安装/启动时装载 .app.json → registry 合流；卸载下线（连接行保留）
- [ ] 设置页连接列表 + @ 弹层渲染声明式 connector（category 分组复用 marketplace）
- [ ] `oauth` 段接线：public client 数据进 OAuth flow（env/user override 优先级不变）
- [ ] 内置 11 provider **双轨**：registry 常量继续供给，声明式路径并行验证（迁移归 460）
- [ ] 单测 + typecheck

### Phase D: 验证
- [ ] `npm run typecheck:all` + 全量 vitest
- [ ] 手动：装一个声明 .app.json 的测试插件（mcp-remote 绑定）→ 连接 → @ 提及出工具
      → 审批走 449 分级 → 卸载插件 connector 下线、连接记录保留
- [ ] ARCHITECTURE.md「Official app connections」小节改为「AppConnector 统一模型 +
      .app.json 声明层」


> **落地记录（2026-08-29，Phase A/B）**
> - 文件名定为 `.app.json`（codex `core-plugins/src/loader.rs:67` 实证，OQ1 关闭）。
> - brand 用 string 字面量可直接赋值的实现验证：TS 对 `string & {__brand}` 交叉类型
>   拒绝普通 string（TS2322/TS2345），字面量需经 `asAppConnectorId`；测试字面量全部收窄。
> - 解析修复（worktree 自洽）：root/electron tsconfig 增 `@duya/plugin-core` paths、
>   `build-electron.mjs` 增 esbuild alias、`vitest.config.ts` 增 string-prefix alias
>   （原配置存在两个 `resolve` 键，后者覆盖前者，alias 已并入生效块）。
> - 验证：electron tsc 与 root tsc 对 master 基线 **零新增错误**；非 DB 测试 604 全绿
>   （4 个 DB 测试文件因 Electron 运行锁 ABI 未能执行，与本次改动无关）。

## Success Criteria

| Area | Standard |
|---|---|
| 统一类 | connector-service 无 per-app 路由分支；三种 binding 走同一 `AppConnector` 接口与工厂 |
| 声明化 | 引用式（452）与定义式（455/460）同一份 .app.json schema；内置 provider 迁移后 registry 无 per-app OAuth/工具数据 |
| 安全 | 插件包内无凭据；https-only；custom 绑定插件不可注册；destructive 强确认不可绕过 |
| 兼容 | 内置 provider 双轨期间行为与 449/450 一致；DB 无迁移 |
| 生命周期 | 卸载下线、连接保留（plan 314 准则 4/5） |

## Open Questions

1. ~~文件名~~ **已定**：`.app.json`（codex `core-plugins/src/loader.rs:67` `DEFAULT_APP_CONFIG_FILE` 实证）。
2. `providers/{google,microsoft365,slack}.ts` 的 userinfo/refresh 特例能否全部被标准
   OAuth 覆盖？**建议** Phase C 时逐个核：标准路径声明化，真特例（如 Slack
   `requiresClientSecret` 用户自备）降为 `oauth` 段枚举字段而非 custom 模块。
3. 内置 official 包的分发形态（452 Phase B 的 `packages/plugin-core/src/plugins/builtin/`）
   与声明式 loader 的装载优先级：builtin 定义与用户安装插件冲突 id 时谁赢？
   **建议** builtin 恒赢 + warn。

## 延伸阅读

- [460-rest-template-connector](./460-rest-template-connector.md) — `rest` 绑定实现 + slack/m365/google 声明化迁移（依赖本计划 Phase A/B）
- [452-mcp-direct-and-plugin-unification](./452-mcp-direct-and-plugin-unification.md) — 引用式 apps 声明 + @ 弹层插件化 + plugin:// mention
- [449-app-connection-approval-parity](./449-app-connection-approval-parity.md) — riskTier 分级 + tool_overrides 审批模板
- [314-global-connector-registry-design-suite](./314-global-connector-registry-design-suite.md) — canonical connectorId 依赖声明
