# CLI TUI：AGENTS、Context 与插件扩展

## 目标

把已合入的工作台侧栏推进到可日常使用：能直接在主 agent 与 subagent 的消息流之间切换；在侧栏读到当前 Context 用量、窗口容量条和主要分类；给可信的 TUI 扩展留出受限的侧栏贡献接口。完成后构建此检出的 CLI bundle，供用户用 `dev:tui` 临时运行。

## 边界与验收

- 主 agent 与每个 subagent 各占一行，整行点击即切换消息流，当前行高亮；不在行内放“查看”、跟随/暂停或停止按钮。滚动离开暂停跟随，`Ctrl+End` 回到底部，既有 `Ctrl+K` 停止所选 subagent。
- 工作状态与后台任务集中放入 `AGENTS`；侧栏不显示模型名或 provider 名。
- `CONTEXT` 显示 token 用量、上下文窗口容量条和基于可见 transcript 的主要估算分类；未归因部分单列，unknown 用量保持 unknown。保持底部 session 累计 token 语义不变。
- 侧栏提供受限的纯文本插件状态注入点；不在 CLI 主进程无条件执行市场插件 JavaScript。报告当前插件能力缺口与 Pi 对照，明确后续信任和清理合同。
- 在本 worktree 完成变更，运行所需静态门禁和 `npm run build:cli-dev`；不安装或改写全局 CLI。UI 实机验收范围如环境不可用需明确记录。

## 分配

- Owner：`/root`
- Managed worktree：`/home/lavachen/.codex/worktrees/tui-agents-context-plugin/duya`
- Branch：`codex/tui-agents-context-plugin`
- Base：`origin/master`，fetch 后 `53c9537baf45d98316d48d02409d3a8ed7dbb4f3`
- 当前 base working tree：clean；路径所有权：本任务 TUI、插件接口、执行计划和入口。

## 进度

- [x] 核对 Pi 交互背景、已有 AGENT transcript、Host token usage 数据和插件 inventory 边界。
- [x] 实现 AGENTS 点击切换及侧栏布局。
- [x] 实现 Context 进度和 transcript 分类估算；精确 Host composition 协议留后续。
- [x] 实现 TUI 受限状态注入点并写明 Pi 对照/安全边界；Host marketplace 接入留后续。
- [x] 执行静态检查、构建 CLI bundle，并记录临时 dev 命令。

## 发现与决策

- 现有 TUI 已实时缓存 subagent transcript，也已有滚动暂停、`Ctrl+End` 跟随和 `Ctrl+K` 停止；主要缺口是侧栏把查看动作表达成任务详情/后台任务行，需改成选中 agent 的 transcript。
- `/context` 用 `computeContextEstimate` 与共享 `capacityBar`；Host worker 同时计算 `computeContextComposition`，但目前通过 Desktop `chat:token_usage` 发给 renderer，CLI 的 run protocol 只投影 `assistant.usage`。本切片按可见 transcript 做分类估算、将其余量单列；精确 Host composition 仍需单独的 Host→CLI 协议事件，不能从账单 token 伪造分类。
- CLI 插件 inventory 有意不透出 manifest、路径或 MCP 凭据。Pi 扩展以受信任的 in-process API 注册 UI hook；Duya 不应直接复制任意市场 JS 注入。先为状态贡献定义最小合同，保持非可执行、可验证的投影。

## Pi 插件 UI 调研与建议

- Pi 的 `ExtensionAPI` 提供状态与 working message、编辑器上下 widgets、header/footer/custom UI、editor 扩展等 UI hook；另有 `registerMessageRenderer`、`registerToolRenderer`、`registerEntryRenderer`。Tool renderer resolver 可链式调用 `next()`，不必覆盖其他扩展。hooks、commands、shortcuts 和每次注册的清理函数共同构成生命周期。
- Duya 已有插件市场/manifest、MCP、skills、CLI、hooks 与 Desktop App；Desktop App 使用声明式 placement。CLI `/plugin` 通过 Host 读取 inventory；inventory 明确剥掉完整 manifest、安装路径和敏感 MCP 配置。目前不存在 CLI TUI plugin loader 或渲染 hook。
- 本实现只提供 `TUIAppOptions.workbenchSidebarStatusItems`，字段仅有纯文本 `id/label/value` 与固定语义色阶；它可供可信的 in-tree TUI 集成注入，但尚无 marketplace loader 调用该接口，不能称作已完成 Duya 插件接入。
- 建议下一阶段新增 `tui.sidebar.status` 声明与 Host 的最小安全投影（插件 ID、状态项、固定 tone），校验长度/命名空间/数量，只允许受限的已注册 action。若后续要执行插件 JavaScript，应先明确用户授权与隔离方式、插件报错策略、跨 renderer component 合同及 unload disposer，再讨论工具/消息行 renderer；任意主题 CSS/ANSI 注入不作为第一阶段。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `53c9537baf45d98316d48d02409d3a8ed7dbb4f3` → source/docs dirty | Linux x64 / Node 26.13.0 / npm 11.20.0 | `npm run build:cli-dev` | exit 0; CLI `bundle/cli.cjs` built, 4.82 MB | local worktree artifact |
| same | Linux x64 / Node 26.13.0 | `npm run typecheck:all` | exit 0; no new type errors. Script's final `eval:agent:core:check` also ran its 4 Node checks; no dedicated suite run | baseline gate: 164 known Electron type errors |
| same | Linux x64 / Node 26.13.0 | `npm run architecture:check`; `git diff --check` | both exit 0; no new architecture findings | 3,208 existing baseline violations tolerated |
| same | Linux x64 / Node 26.13.0 | First `npm ci` / retry `PUPPETEER_SKIP_DOWNLOAD=1 npm ci` | first exit 1 because stale cached Puppeteer Chrome folder lacked executable; retry exit 0 | independent node_modules in this worktree |

## 接续 / 结果

实现、验证与构建产物均留在此分支/worktree；不安装全局 CLI、不直接合并 master。临时运行命令：`cd /home/lavachen/.codex/worktrees/tui-agents-context-plugin/duya && npm run dev:tui`。CLI 交互终端未在本轮启动；用户可用此命令做实机验收。PR 与提交 SHA 待交付后补记。

回收：pending。
下一步：完成 commit 与 draft PR，附加 PR 到当前任务；保留 branch/worktree 等待 review 与用户终端反馈。
