# 631 TUI 插件市场管理界面

状态：active · 负责人：未认领 · 更新：2026-10-26
分支：未建 · worktree：未建 · base：master（需含 630a） · owner：无

## 目标与边界

用户在 TUI 输入 `/plugin` 得到多 tab 界面：Discover（全市场浏览，`/` 搜索、空格多选、`i` 批量安装、Enter 进安装范围菜单）、Installed（按 user/project 分组、状态图标、Enable/Disable/Update/Uninstall）、Marketplaces（列表 + `a` 添加源，接受 `owner/repo`、git URL、本地目录/json）、Errors。所有变更走 Host HTTP，不依赖 Electron 进程。

允许修改：`packages/host/src/`（新写路由）、`packages/plugin-core/src/`（安装执行上收）、`packages/cli/src/tui/slash/plugin.ts` 及面板、`packages/command-catalog/src/index.ts`（`/plugin` 的 surfaces/description 已存在，只校准文案）。
本次不处理：插件内 MCP 子项配置向导、userConfig 询问流、市场信任策略/blocklist、Errors tab 可先降级为结果行文本。

关联：[系列](README.md)；依赖 630a 面板原语；安装目录发现逻辑见 443（[2026-10-25 插件安装路径](../2026-10-25-host-plugin-install-path.md)已合并）。

## 现状事实（2026-10-26 核对）

- 持久化真源是 `config.toml [plugins]`，key `<id>@<marketplace>`，值只存 `enabled` 用户意图（`packages/host/src/local-plugin-registry-api.ts:1-30`，plan 334 决策 11）；installPath 由磁盘探测派生。
- Host 对外只有只读 `GET /v1/local/plugins`（`packages/host/src/http-server.ts:1695`）。
- 变更能力全在 Desktop Electron IPC：`installFromCatalog` / `installFromPath` / `setEnabled` / `remove`（`apps/desktop/src/main/plugins/PluginManager.ts:90` 起）、marketplace add/remove/refresh（`apps/desktop/src/main/ipc/plugin-handlers.ts:251-286`，Plan 455）。marketplace 缓存目录与 git clone 执行也在 Desktop 的 `plugins/marketplace/manager.ts`。
- `plugin-core` 只有源解析（`parseMarketplaceSource`：git URL / `owner/repo` 简写 / 本地目录，https-only 校验，`packages/plugin-core/src/marketplace/source-parse.ts:50-138`），无 clone/安装执行。
- TUI `/plugin` 现为纯列表（`packages/cli/src/tui/slash/plugin.ts:270` showEntries）。

## 验收

- 无 Electron 在场：`duya tui` 内添加一个本地目录市场 + 一个 `owner/repo` git 市场，浏览、安装、禁用、卸载各走通，`config.toml [plugins]` 结果与 Desktop 设置面板读数一致；Desktop 打开后能看到 TUI 装的插件。
- 安装后退出面板提示 reload/重启会话生效，不在面板内热生效。
- `typecheck:all`、`architecture:check`、`npm test -- packages/plugin-core packages/host packages/cli` 相对基线零新增失败；架构门禁无新增违规（host/plugin 相关 managed 模块零容忍）。

## 进度

- [ ] 安装执行从 Desktop 上收 `plugin-core`（clone、缓存目录、install/uninstall 纯函数化），Desktop 改调用、行为不变。
- [ ] Host 写路由：marketplace add/remove/refresh、plugin install/setEnabled/remove；边界 schema 用现有 zod helper。
- [ ] TUI 三 tab 面板（Discover/Installed/Marketplaces）基于 630a 原语。
- [ ] catalog 文案校准 + 双端平价测试更新。

## 发现与决策

- 「安装目录在 Electron userData」是独立 Host 的历史妥协（registry-api 头注释）；本切片把缓存目录参数化到 Host data root，保持对既有 `%APPDATA%/duya` 布局的读取兼容，避免 Desktop/TUI 各装一份。
- enabled 与 install 分离的既有模型正好对应参考实现的「installed 记录 + settings 级联 enabled」，不需要新配置文件。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 待执行 | win32 / Node 24 | 验收清单全部命令 | — | 基线在开工检出重记 |

## 接续 / 结果

下一步：等 630a 合入后建实现 worktree，从「安装执行上收」开始；完成判据是该项单测 + Desktop 回归不变。阻塞：630a 未合入前不得动 TUI 面板部分。
