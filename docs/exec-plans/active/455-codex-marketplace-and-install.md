# Plan 455: codex 对齐的插件来源与下载安装机制(Marketplace + Git/Local 双源)

> **Status**: In progress
> **Priority**: P0
> **Created**: 2026-08-29
> **依据**: `docs/references/codex-deep-dive/17-plugin-marketplace-and-app-connector.md`
> **取代**: plan 88(multi-source discovery)、plan 90(marketplace system)——两者 checkbox 已陈旧,
> 其代码(`electron/plugins/resolvers/`、`electron/plugins/marketplace/`)在 commit `04521cb2`
> 的产品定义重构中被删除,本计划按 codex 17 章规格重建并收敛。

## 背景

当前树只有 builtin catalog + 本地 `userData/plugins/marketplace.json` + 本地目录安装,
无任何网络拉取能力。目标:marketplace = git 仓库 + `marketplace.json` catalog,
支持 `owner/repo` 简写与 https git URL,`marketplace add → clone → 浏览 → install` 全链路。

**用户决策**(2026-08-29):

1. 来源范围 = **Local + Git**(Npm 后续增量,catalog schema 预留)。
2. **内置一个默认官方 marketplace**(`official`),启动自动同步,失败 WARN 不阻塞。

## 复用资产(不重造)

| 资产 | 位置 |
| --- | --- |
| plan 89 版本化缓存 + staging + symlink | `electron/plugins/cache/`、`PluginManager.installFromCatalog` |
| plan 92 TrustEngine / PolicyEngine / PermissionService | `packages/plugin-core/src/security/` |
| `[plugins]` 复合键 `<pluginId>@<marketplace>` | `electron/plugins/PluginRegistryStore.ts` |
| install 后刷新链 `notifyMcpConfigChanged` → `POST /plugins/reload` → `reload:skills`+`reload:mcp` | `electron/services/mcp-write-reload.ts` |
| marketplace 形状的本地 catalog(policy 字段已预留) | `electron/plugins/catalog.ts` |
| TrustEngine `source==='marketplace' && marketplaceName → verified` | `packages/plugin-core/src/security/trust-engine.ts` |

## 设计决策

| Decision | Choice | Reason |
| --- | --- | --- |
| D1 来源 | Local + Git;仅 `https://` URL 与本地目录;`owner/repo` → `https://github.com/<x>.git` | codex 发布态主路径;ssh/npm 后续增量 |
| D2 SSRF | source 解析层硬校验 host:拒绝 localhost/环回/私有/保留地址;仅 http/https | 安全约束;纯函数可单测 |
| D3 catalog 路径 | 根 `marketplace.json`、`.agents/plugins/marketplace.json`、`.agents/plugins/api_marketplace.json`、`.claude-plugin/marketplace.json`、`.cursor-plugin/marketplace.json`,按此优先级取首个 | codex parity,兼容 Claude/Cursor 生态 |
| D4 clone 安全 | `GIT_TERMINAL_PROMPT=0` + staging → rename 原子落盘 + `canonicalize().startsWith()` 越界校验 + 120s 超时 | codex 17.4 全套 |
| D5 物化 | 与 codex 不同:从 clone 拷入 `cache/{marketplace}/{id}/{version}/` + symlink;marketplace 刷新不被动改已装插件,只标「可升级」 | 保持 plan 89 模型,升级显式化 |
| D6 存储 | 来源清单存 ConfigStore `[marketplaces]`;clone 落 `~/.duya/plugins/cache/marketplaces/<safe-name>/` | plan 334 config.toml 唯一权威源哲学 |
| D7 policy 门 | `installation: not_available` 拒装;`authentication: on_install` 且插件声明 `apps/connections.json` → 装完弹连接引导 | codex 17.3.1;自动连接全量归 plan 452-B |
| D8 信任 | marketplace 安装 → `verified`;official 源 → `official`;PolicyEngine marketplace allowlist 钩子保留 | 既有映射,零新增 |

## Phase 划分

- [ ] **Phase 1 — 来源解析与存储**:ConfigStore schema 加 `marketplaces`;plugin-core
      `marketplace/source-parse.ts`(解析 + SSRF host 校验,纯函数)+ 单测。
- [ ] **Phase 2 — clone 与 manifest**:`electron/plugins/marketplace/git-source.ts`
      (staging clone / fetch-reset / rename + 越界校验)、`marketplace/manifest.ts`
      (5 路径搜索 + zod 校验);本地 git fixture 单测(不起网络)。
- [ ] **Phase 3 — catalog 与安装**:`listCatalog` 三源合并;`installFromCatalog(pluginId, marketplace)`
      接 policy 门 + 物化 + registry + refresh;marketplace add/remove/refresh + 升级检测;PluginManager 单测。
- [ ] **Phase 4 — 启动同步与默认源**:启动时逐源容错同步;预置 `official` 默认源。
- [ ] **Phase 5 — UI**:MarketplaceModal 改造(添加来源 / 源列表 / 分组浏览 / 安装 /
      升级徽标 / 本地安装入口);preload + `src/lib/plugin-ipc.ts` 同步新通道。
- [ ] **Phase 6 — 收口**:`npm run typecheck:all` + 全量 vitest;ARCHITECTURE.md 更新;
      worktree → PR → merge。

## IPC 面

`plugin:marketplace:list` / `:add` / `:remove`(有已装插件时拒绝)/ `:refresh`;
`plugin:install` 扩展 `installFromCatalog(pluginId, marketplace?)` 消歧。

## 验证

- 单测:source-parse(SSRF/简写/非法输入)、manifest(5 路径优先级/坏 JSON)、
  PluginManager(policy 拒装/版本缓存/复合键)、git-source(本地 fixture + staging 原子性 + 越界拒绝)。
- 手动:electron:dev 下添加真实 GitHub marketplace → 安装 → @/skills/MCP 生效 → 升级/移除。
- 不做 Playwright UI 验证(环境限制),typecheck + Vitest 代替。

## 明确不做

Npm 源、远端 connector directory 服务、24h 定时同步(先启动 + 手动)、
plan 452-B 的 apps.json 统一与自动连接全量(本计划只留 on_install 弹窗钩子)。
