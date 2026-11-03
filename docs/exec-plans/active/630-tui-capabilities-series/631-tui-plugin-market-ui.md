# 631 TUI 插件市场管理界面

状态：Draft PR [#602](https://github.com/lava-chen/duya/pull/602) · 未合并 · 负责人：Codex · 更新：2026-11-03
分支：`codex/shared-plugin-service` · managed worktree：`D:\codex\worktrees\shared-plugin-service\duya` · base：`cbb3a7617540ba815eec0f042130f28e83b36d6d` · owner：Codex

## 目标与边界

2026-11-03 用户授权实施共享插件服务：Desktop、CLI、TUI 共用业务实现、配置与安装存储；CLI 自动连接/启动独立 Host。当前 managed worktree：`D:\codex\worktrees\shared-plugin-service\duya`；分支：`codex/shared-plugin-service`；base：`cbb3a7617540ba815eec0f042130f28e83b36d6d`。本任务独占 Host 插件服务/HTTP、协议、CLI plugin 入口、Desktop 插件适配器与本计划。先交付统一业务与命令适配，市场多 tab 展示按原验收继续跟踪。

依赖已复核：#512、#514 均已合并，旧阻塞解除。workspace_get_context/activity 工具不可用，以版本化计划、Git 与 PR 对账。实现切片：共享管理/目录/注册表与根目录端口 → Host API 与 CLI 自动附着 → Desktop/TUI 适配 → 无 Electron 的安装/启禁/卸载及配置一致性验证 → 门禁、PR。

用户在 TUI 输入 `/plugin` 得到多 tab 界面：Discover（全市场浏览，`/` 搜索、空格多选、`i` 批量安装、Enter 进安装范围菜单）、Installed（按 user/project 分组、状态图标、Enable/Disable/Update/Uninstall）、Marketplaces（列表 + `a` 添加源，接受 `owner/repo`、git URL、本地目录/json）、Errors。所有变更走 Host HTTP，不依赖 Electron 进程。

允许修改：`packages/host/src/plugins/` 共享管理实现与 HTTP adapter、`packages/agent-protocol/` 安全 DTO、`packages/plugin-core/` 纯解析与权限 schema、`packages/cli/` 命令/TUI Host client、`apps/desktop/src/main/plugins/` 兼容适配器、架构与用户文档。
本次不处理：插件内 MCP 子项配置向导、userConfig 询问流、市场信任策略/blocklist、Errors tab 可先降级为结果行文本。

关联：[系列](README.md)；依赖 630a 面板原语；安装目录发现逻辑见 443（[2026-10-25 插件安装路径](../2026-10-25-host-plugin-install-path.md)已合并）。

## 现状事实（2026-10-26 核对）

- 持久化真源是 `config.toml [plugins]`，key `<id>@<marketplace>`，值只存 `enabled` 用户意图（`packages/host/src/local-plugin-registry-api.ts:1-30`，plan 334 决策 11）；installPath 由磁盘探测派生。
- Host 对外只有只读 `GET /v1/local/plugins`（`packages/host/src/http-server.ts:1695`）。
- 变更能力全在 Desktop Electron IPC：`installFromCatalog` / `installFromPath` / `setEnabled` / `remove`（`apps/desktop/src/main/plugins/PluginManager.ts:90` 起）、marketplace add/remove/refresh（`apps/desktop/src/main/ipc/plugin-handlers.ts:251-286`，Plan 455）。marketplace 缓存目录与 git clone 执行也在 Desktop 的 `plugins/marketplace/manager.ts`。
- `plugin-core` 只有源解析（`parseMarketplaceSource`：git URL / `owner/repo` 简写 / 本地目录，https-only 校验，`packages/plugin-core/src/marketplace/source-parse.ts:50-138`），无 clone/安装执行。
- TUI `/plugin` 现为纯列表（`packages/cli/src/tui/slash/plugin.ts:270` showEntries）。

## 验收

- 无 Electron 在场：独立 CLI 自动启动 Host，添加本地目录市场、查看市场和可用插件、安装、禁用、查询、卸载、移除市场均读写同一 `config.toml`；Desktop IPC 与 CLI 互相可见。
- TUI `/plugin` 的管理子命令复用该 Host API，确认变更并在忙碌时拒绝；安装后提示重新加载会话。
- Discover/Installed/Marketplaces 三 tab 面板仍是后续 UI 切片，不作为本轮共享服务交付门槛。
- `typecheck:all`、`architecture:check`、`npm test -- packages/plugin-core packages/host packages/cli` 相对基线零新增失败；架构门禁无新增违规（host/plugin 相关 managed 模块零容忍）。

## 进度

- [x] 插件管理、目录、注册表、安装布局与市场操作抽到 Host；Desktop 保留适配器，plugin-core 保留纯声明/解析 schema。
- [x] Host 写路由：marketplace add/remove/refresh、plugin install/setEnabled/remove/update；输入验证和无凭据 DTO。
- [x] 顶层 CLI 自动发现/启动 Host；插件列表、查询、安装、启禁、更新、卸载及市场管理共用 Host 服务。
- [x] TUI `/plugin` 管理子命令调用同一 Host API，变更先确认，忙碌时拒绝变更。
- [ ] TUI 三 tab 面板（Discover/Installed/Marketplaces）基于 630a 原语。
- [x] catalog 文案校准；共享权限声明 schema；跨实例配置与旧 Desktop 安装布局回归。

本轮用户授权目标为共享业务、配置与客户端适配，三 tab 的展示增强继续作为此计划的 UI 后续项；本轮以 `/plugin` 管理子命令提供可操作入口。

## 发现与决策

- 「安装目录在 Electron userData」是独立 Host 的历史妥协（registry-api 头注释）；本切片把缓存目录参数化到 Host data root，保持对既有 `%APPDATA%/duya` 布局的读取兼容，避免 Desktop/TUI 各装一份。
- enabled 与 install 分离的既有模型正好对应参考实现的「installed 记录 + settings 级联 enabled」，不需要新配置文件。
- **上收成本实测比计划预估低**：Desktop 侧 `apps/desktop/src/main/plugins/marketplace/git-source.ts` 只有 `getMarketplacesCacheRoot()` 一处 `import { app } from 'electron'`，其余每个函数都已带 `rootOverride?: string` 形参（`:30/:35/:195/:250/:275/:300/:358`）；`manifest.ts` 与 `manager.ts` 不引 electron。也就是说搬动主要是换 root getter，不是重写调用链。
- **Host `[plugins]` / `[marketplaces]` 写路由被 PR #514 阻塞**（2026-10-26 核对，推翻「只被 630a 阻塞」的原假设）：master 的 `packages/host/src/config-agents/config-file.ts` 外科手术 TOML 编辑器对 `[agents]` 硬编码；通用化的 `readConfigNamespace` / `editConfigNamespace` / `verifyConfigNamespace` / `writeConfigNamespace` 目前只存在于未合并分支 `codex/632-provider-write-routes`（#514）。631 不把分支叠在 632 上——那会把 631 的提交带进 #514 的 diff，评审面失控。
- 因此第一项（安装执行上收 `plugin-core`）与第三项（TUI 面板）都不受该阻塞，可先行；只有第二项「Host 写路由」等 #514 合入。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d80ca3c6`（只读核对，未改动） | win32 / Node 24 | grep `electron` / `rootOverride` 于 `apps/desktop/src/main/plugins/marketplace/*`；读 `packages/host/src/config-agents/config-file.ts` 与 #514 diff | — | 「现状事实」与「发现与决策」第 3、4 条的证据来源 |
| `cbb3a761` + 本计划实现改动 | Windows / Node 24.16.0 | `npm run typecheck:all`；`npm run architecture:check` | 0；0 个新错误/边界违规 | ignored `docs-local/plugin-typecheck-all-final.log`、`plugin-architecture-final.log` |
| `cbb3a761` + 本计划实现改动 | Windows / Node 24.16.0 | 插件 Host/Desktop/CLI/TUI、command-catalog、UI schema 相关 Vitest | 28 files / 297 tests passed | ignored `docs-local/plugin-final-regression.log` |
| `cbb3a761` + 本计划实现改动 | Windows / Electron 44.9.1 / Node 24.16.0 | `npm --ignore-scripts run electron:build` | 0；worker、CLI、Gateway、Desktop 构建完成 | ignored `docs-local/plugin-electron-build-final.log` |
| `cbb3a761` + 本计划实现改动 | Windows / Electron 44.9.1 / Node 24.16.0 | IPC Playwright：Desktop 安装 → CLI 查询/禁用 → Desktop 状态确认 → CLI 卸载 | 1 / 1 passed | ignored `docs-local/plugin-electron-e2e.log` |
| `cbb3a761` + 本计划实现改动 | Windows / Node 24.16.0，隔离临时数据根目录，无 Desktop | CLI marketplace add/list、`plugin list --available`、指定 marketplace 安装、禁用、查询、卸载、移除；另验证无 `--yes` 的 update 返回 3 | 8 个操作成功；未确认写操作按预期拒绝 | ignored `docs-local/plugin-cli-smoke-final.json` |

## 接续 / 结果

### 2026-11-03 共享服务实施

已实现：Host `plugins/` 单一业务实现和依赖端口，Desktop 的原模块转为适配器；共享 `config.toml` 和既有安装目录，不复制用户配置。新增 Host 管理/目录/市场路由、安全 DTO、持久控制面审计，CLI 自动连接或启动 Host。TUI 使用已连接的 Host，变更经过确认。安装按 staging 发布，配置损坏时拒绝覆盖，非法存储 ID 与越界卸载被拒绝；已有 policy/trust 检查保留，权限声明不提升为运行时授权。`@duya/connectors` 是零 IO 的 `.app.json` schema，Host 的显式依赖白名单补入该模块；未添加 baseline 指纹。

基线：Windows / Node 24.16.0，首次运行缺少本检出 dist；构建依赖后，修改 Desktop 适配器前的 6 文件 65 项测试全部通过。当前相关测试与真实 CLI 子进程证据持续更新于本节；原始日志保留 ignored `docs-local/plugin-*.log`，不写入版本库。

真实 CLI：隔离 `DUYA_DATA_ROOT`，无 Desktop，Host 自动启动；本地市场的添加/列出、可用插件浏览、指定市场安装、禁用、查询、卸载和移除均成功。Desktop IPC 与 CLI 跨进程共享状态的真实 Electron 用例通过。非交互更新缺少 `--yes` 返回退出码 3，没有执行写操作。

实现提交：`2bb5e80361c209834b22dc308a068faa59749f6b`。Draft PR #602 已推送；worker bundle freshness 为 `FRESH 0/1092`。没有合并。原三 tab 浏览界面继续作为后续 UI 切片。旧 `.claude/worktrees/631-plugin-host` 不属于本会话，不修改或回收；#512/#514 的旧依赖阻塞已解除。
