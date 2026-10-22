# 2026-10-22 — 外置 Browser、Computer Use 与 Conductor Canvas

状态：active · 负责人：Codex 会话 · 更新：2026-10-22
分支：`codex/browser-plugin-migration` · worktree：`/workspace/duya-browser-migration` · base：`ebd76d4878add41aa3e7cdac65a5884eee6c93a1`
Marketplace 分支：`codex/browser-migration` · worktree：`/workspace/duya-marketplace-browser` · base：`dce6ffa` · 已推送：`75b1ff2`

## 目标与边界

让 DUYA 基础 agent 保持精简，Browser、Computer Use、Conductor Canvas 分别作为官方 Marketplace Plugin / MCP / Mini App 按需接入。分期迁移并保留旧模块作兼容回退；Browser 优先建立完整的 CUA REPL 纵切片，Computer Use 与 Canvas 在插件侧并行推进；不做共享 UI 大改。

关联：[616 duya_app 内置 MCP 层](616-duya-app-mcp-layer.md)、[618 桌面管理层](618-duya-desktop-management-layer.md)。Marketplace 定义在独立 `duya-marketplace` 仓库。本计划的新决策覆盖 616 里 Browser / Computer Use 迁入 `duya_app` 的旧安排；不覆盖 616 的 MCP/权限基础设施，也不恢复 Canvas 迁入 `duya_app`。

## 验收

- Browser：目标为官方 `cua_repl` MCP，提供持久化 JS REPL、模块目录添加、会话 reset 三个工具。服务端强制首个 `js` 调用仅读 CUA 文档、第二个调用仅读当前浏览器状态；目标/标签切换后也必须另起调用读新状态才能继续。
- Browser target：控制面覆盖 DUYA 内置浏览器/IAB 标签与可用的 Chrome、Edge 标签，按 URL、tab id 或浏览器名选择目标。
- Browser：由 Marketplace 声明并经 DUYA Plugin/MCP 调用链接入；验证初始化、列工具、REPL 状态保留、浏览器导航与快照；先前 Playwright smoke 只算通用 MCP 基线，不算此目标形态通过。
- Computer Use：独立 Marketplace 插件启动用户配置的原生 Cua Driver MCP 进程，插件适配器限定桌面工具清单；DUYA 只按通用 plugin MCP 管理它。旧 Windows UIA/审计/撤销能力、跨平台权限和二进制分发仍需单独验收。
- Conductor Canvas：完整实现属于独立 Marketplace Plugin。DUYA 只保留所有 Mini App 共用的包加载、沙箱、生命周期、授权与 MCP 接口；不能经插件反调 DUYA 内置 Canvas executor、数据库或 renderer。现有 Canvas 旧实现只在迁移验收前保留作兼容。
- 每阶段保留旧模块及回退方式；基础工具和共享 UI 不顺带大改。

## 进度

- [x] 更新到最新 `origin/master` 并在独立 worktree 开工。
- [x] 审计 Plugin/MCP/Mini App 能力边界及旧计划冲突。
- [x] 克隆并只读审阅 OpenAI Codex 上游 `342ed69a174c206c1de52a59491b131e0753cfa5`，核对 CUA MCP 的宿主侧生命周期与安全边界。
- [x] Browser 通用 MCP 能力基线：官方 Playwright MCP 独立运行验证初始化、`tools/list`、`browser_navigate`、`browser_snapshot`。
- [x] 按图中 CUA REPL 形态定义工具 schema、持久状态、目标选择与初始化约束。
- [x] 在 Marketplace 新增 `browser` 插件，实现 `js`、`js_add_node_module_dir`、`js_reset` 持久 REPL 和 DUYA/Chrome/Edge CUA API。
- [x] 用模拟 Browser daemon 验证初始化约束、状态保留、截图图片结果、system tab ID 附加与 reset 保留浏览器状态。
- [x] 用 DUYA MCPManager 启动 Marketplace 插件 server 进程，完成 `tools/list`、JS 文档初始化与页面状态调用。
- [ ] 在真实 DUYA 桌面应用和 Browser Bridge 扩展中验证安装、当前 Chrome/Edge 标签附加及 DUYA IAB 控制。
- [x] 运行 DUYA 插件 manifest、MCP discovery/collector、runtime MCP 相关回归测试。
- [ ] 验证真实 Marketplace 插件安装后进入 MCP inventory 并通过 agent tool executor 调用。
- [x] Computer Use：Marketplace 独立 MCP 适配器 + 外部原生 Cua Driver，已撤回迁移分支中的 Host 专用桥接；尚未在真实桌面验证。
- [x] Canvas：Marketplace 内独立 MCP server、插件数据存储与 Mini App 原型；未依赖 DUYA 内置 Canvas。
- [x] DUYA 通用 standalone Mini App 运行时开发切片：独立于 agent run 的 MCP 会话、明确授权、插件变化通知与全窗口容器；待桌面实装验收。
- [ ] Canvas：已具备本地资产存储、旧库只读导出与整包导入，但原生元素、旧资产、数据视图、agent 协作及旧 UI 剥离仍未完成。
- [ ] 分别完成三个插件的桌面真实安装、权限授予及 agent/Mini App 使用验收后，才切换或删除各自旧实现。
- [ ] Computer Use：打包并验收原生驱动，补齐旧 UIA/审计/撤销语义，验证工具审批与 OS 权限后才能删除旧实现。
- [x] Browser：将新增的 Browser Bridge 标签附加逻辑及扩展源码交由 Marketplace 插件交付，DUYA 迁移分支撤回相应扩展改动。
- [ ] Browser：将旧 daemon 的浏览器专用逻辑与 IAB 控制面迁往插件；DUYA 最终只保留通用 App/Host 接口。

## 发现与决策

- DUYA 原 Plugin App 的 bind/invoke/revoke 与活跃聊天 run 绑定，五分钟过期，不适合长期编辑的 App。新通用 standalone 模式只持有插件自己声明的 MCP 服务和显式 grant，并按插件启停/更新撤销与重开；Canvas 不得有宿主特例。
- Plugin MCP 经 `mcp/servers.json` → plugin capability discovery → `buildMCPCandidates` → Host MCP apply → worker registry 接入。Plugin source 有独立身份；旧 BrowserTool 是 Host builtin，两条路能并存。
- Marketplace 已有 `playwright` 插件，提供独立 Playwright 浏览器上下文。本次另新增 `browser` CUA 插件，不替换 Playwright。Browser CUA 服务是无外部依赖 stdio MCP，server 源码与声明留在 Marketplace。
- Codex 上游公开客户端源码确认 `cua_repl` 是单独识别的 MCP server：MCP 调用历史把它归为 computer activity（`codex-rs/tui/src/history_cell/mcp.rs`），插件清理 hook 通过 `unified-computer-use@openai-bundled` 调用 `cua_repl.turn_ended`（`codex-rs/plugin/src/bundled_hooks.rs`），Guardian 对 `cua_repl` 运行独立的电脑/浏览器审查策略，并把 REPL 子调用作为不可信证据递归审阅（`codex-rs/prompts/templates/guardian/node_repl_policy.md`、`codex-rs/core/src/context/node_repl_review_evidence.rs`）。迁移时要保留会话生命周期、活动展示和嵌套动作审查边界。
- 该 Codex 克隆没有 `cua_repl` MCP 服务端实现或工具 schema；这部分不能直接从开源仓库复刻。图示中的三工具 schema 与初始化前置条件仍作为 Browser 插件产品需求，需在 DUYA/Marketplace 自己实现并验证。
- 当前 `packages/computer-use` 中的 `McpCuaDriverBackend` 是 DUYA 的 MCP client adapter，调用外部 `cua-driver` server；它不是能被 Marketplace 安装的 CUA MCP server，也没有持久化 JS REPL。
- 现有 `computer_cua` 是单一工具 + `tool` enum 的 Windows Host IPC 面；它不提供跨平台浏览器标签目标选择，也没有 `js` / `js_add_node_module_dir` / `js_reset` 的 session 语义。
- 现有 CDP webview bridge 只注册 `sessionId -> webContentsId`，Browser 面板的 `AgentBrowserTab` 会为 agent session 创建独立标签。它没有列出或附着到用户当前 DUYA 浏览器标签的接口；系统 Chrome/Edge 标签控制也由现有 Browser Bridge 扩展与 agent daemon 路由处理。因而图示的 target selection 需要一条窄 Host bridge，不能只在 Marketplace 写一个 MCP server 就覆盖全部目标。
- Browser 插件通过现有 daemon `/webview-command` 控制自身的 DUYA agent webview tab；Marketplace 插件内的 Browser Bridge 扩展提供 `tabs.available` / `tabs.attach` 操作，供 CUA 按 tab ID 或 URL 附加到用户现有 HTTP(S) Chrome/Edge tab。扩展对附加 tab 只登记 session、复用现有 debugger 通道；session reset/结束时 detach，不关闭用户 tab。DUYA 内置一键安装器仍交付旧 1.5.8 版扩展，安装新插件扩展目前需要手动 Load unpacked。内置 DUYA Browser 面板中非 agent 的用户标签仍不支持附加。
- 插件的 `permissions/policy.json` 表达分档意图，但通用 MCP apply 当前向 executor 传 `source: 'plugin'`，没有把该文件中的 Playwright action tier 映射到每个 MCP tool。此阶段沿用 DUYA 对 plugin MCP 的统一审批门；细粒度执行必须在后续权限集成里单独验证。
- Computer Use 依赖本机 OS 权限与平台特定后端。市场插件现在用独立 MCP 适配器启动 Cua Driver，并限定工具清单；它尚未复现 DUYA 旧 guard/audit/revoke 行为，不能把语法检查当作安全验收。
- 早期 `canvas_invoke` Host 桥接方案已撤回：它把 Canvas 的真实执行仍留在 DUYA，违背独立插件目标。当前 Marketplace Canvas 的 MCP server 自己持有模型和持久化；agent 与 Mini App 各有 MCP 进程，插件用跨进程锁保护 JSON 事务。它仍是简化编辑器，尚未达到旧 Canvas 功能对等。
- 2026-10-22 更新 616 决策：Browser / Computer Use / Canvas 都不迁入 `duya_app`，而是分别作为 Marketplace 插件迁移。Browser 采用 CUA REPL MCP；Computer Use 单独封装 OS 控制；Canvas 使用 Mini App/renderer bridge。迁移验证通过前不删旧工具、后端、浏览器面板或 Canvas 实现。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| Marketplace `codex/browser-migration`; `plugins/browser/**` | Linux x64, Node 24.19.0 | `node --test plugins/browser/test/server.test.cjs` + `node --check plugins/browser/server.cjs` + JSON parse checks | 5 tests passed；验证三工具 schema、首次单独 docs/状态调用、同调用操作拦截、持久 JS/浏览器状态、截图 image block、系统 tab attach、DUYA webview tabs 和 module dir | `/workspace/duya-marketplace-browser/plugins/browser/test/server.test.cjs` |
| DUYA Browser Bridge 扩展源 | Linux x64, Node 24.19.0 | `node --check` + JSON parse；VM harness 驱动 `tabs.available` / `tabs.attach` / session close | 通过；HTTP(S) 标签可列出并附加，session 结束会 detach 且不会关闭附加的用户标签 | 本会话命令输出 |
| 历史 Computer Use Host 桥接（已撤回）；`packages/host/src/worker-tool-bindings/computer-use-capability-bridge.ts` | Linux x64, Node 24.19.0 | 当时的 Host capability MCPManager/tool executor 与 collector/resolver/manifest/loader 定向测试 | 当时 91 tests passed；对应实现现已撤回，不作为当前分支验收证据 | 本会话命令输出 |
| Marketplace `fe27c03`；`plugins/computer-use/**` | Linux x64, Node 24.19.0 | MCP 适配器 `node --check`、catalog/manifest JSON 校验 | 0；插件不再声明 DUYA Host capability，启动用户配置的 Cua Driver；尚未进行驱动和桌面联调 | `/workspace/duya-marketplace-browser/plugins/computer-use/` |
| Marketplace `75b1ff2`；`plugins/browser/extension/**` | Linux x64, Node 24.19.0 | 扩展三个 JS 文件 `node --check`、manifest JSON 解析、`git diff --check` | 0；仅验证源码语法与打包路径，未在真实 Chrome/Edge 与 DUYA 联调 | `/workspace/duya-marketplace-browser/plugins/browser/extension/` |
| 历史 Canvas Host 桥接（已撤回） | Linux x64, Node 24.19.0 | Plugin App IPC/session/host/invocation/capability tests | 33 tests passed，但对应实现已移除；不作为当前插件架构的验收证据 | 本会话命令输出 |
| DUYA workspace package build | Linux x64, Node 24.19.0 | `npm run build:packages` | plugin-core 构建通过；随后 capabilities typecheck 在 `GlobTool.ts:7` 因既有 `picomatch` 类型声明缺失失败。独立 Host typecheck 另有 workspace dist/export 不完整错误 | 本会话命令输出 |
| 历史 external capability 回归集合（部分实现已撤回） | Linux x64, Node 24.19.0 | `npx vitest run` 20 个指定文件（Plugin manifest/app host, worker bridge, MCP collector/resolver/loader, Host capability bridges, UI guest protocol, MCP suites） | 当时 20 files / 214 tests passed；不代表当前代码已通过 | 本会话命令输出 |
| DUYA `codex/browser-plugin-migration`; Marketplace browser plugin | Linux x64, Node 24.19.0, fake browser daemon | Host `MCPManager.addServer` spawn Marketplace `server.cjs`，`tools/list`，调用 `js(getApiDocs)`、`js(getState)` | 通过；返回三个工具并能完成工具调用 | 本会话命令输出 |
| DUYA base `ebd76d48`; 无改动 | Linux x64, Node 24.19.0, Chromium installed to user cache | `npx --yes @playwright/mcp@0.0.83 --headless --browser chromium`，MCP initialize/list/call navigate + snapshot `https://example.com` | 0；MCP 25 tools，导航与快照通过。此结果仅为通用 MCP 基线，非目标 CUA REPL 验收 | 本会话命令输出；浏览器下载位于 `/home/agent/.cache/ms-playwright` |
| DUYA worktree；build/test | Linux x64, Node 24.19.0 | `npm run build:packages` 后运行 Plugin manifest / MCP collector / capability discovery / MCP suites；校验 Browser Bridge JS 语法和 manifest JSON | 11 files / 128 tests passed；扩展脚本语法与 JSON 解析通过。首次未构建 workspace dist 的运行出现 8 个 import failures；构建后重跑通过 | 本会话命令输出 |
| Marketplace base `dce6ffa`; `plugins/playwright/{README.md,mcp/servers.json}` | Linux x64 | Marketplace validator误用 DUYA 旧格式 validator；该 validator 不识别 `.duya-plugin/plugin.json` | 不适用；不作为插件格式失败证据 | DUYA marketplace 有独立 manifest/discovery loader |
| Marketplace `1985e42`；Canvas standalone Mini App 与 MCP store | Linux x64, Node 24 | `node --check plugins/conductor-canvas/server.cjs`；内联页面脚本 `vm.Script` 语法检查；`git diff --check` | 0；只证明语法与 diff，不证明桌面功能 | 当前会话命令输出 |
| DUYA 当前 dirty worktree；通用 standalone App 宿主 | Linux x64, Node 24 | `npm run build:electron`、`npx vite build`、`npm run architecture:check` | 0 / 0 / 0；分别证明 Main/Preload 构建、UI 生产构建、无新增架构门禁违规；未运行桌面安装流程 | 当前会话命令输出 |
| DUYA 当前 dirty worktree；完整打包前置 | Linux x64, Node 24 | `npm run electron:build` | 1；下载 Electron binary 失败，未进入应用打包。桌面真实验收受阻 | 当前会话命令输出 |

## 接续 / 结果

已实现：Browser 官方市场插件 CUA REPL；Computer Use 市场插件通过独立 MCP 适配器启动用户配置的原生 Cua Driver，插件限定可见的桌面工具，不再声明 DUYA Host capability；Canvas 市场插件拥有独立 MCP/Mini App、显式旧库导出/导入和本地资产存储；App Builder 插件提供 Agent 可复制的独立 App 模板。DUYA 通用 standalone App 宿主包含独立 MCP 会话、grant 审批、版本失效和全窗口容器。原 Canvas 的完整界面、旧资产、动态组件和数据视图尚未搬完；Computer Use 还依赖外部驱动安装，旧 UIA/审计/撤销能力未对齐。三个旧模块都保留。迁移分支撤回了新增的 Computer Use Host 专用桥接，先前 Canvas Host 专用桥接也已撤回；历史测试数字不得作为当前代码通过的证据。

下一步：完成 Canvas 原功能与资产迁移，把 Browser daemon 的专用逻辑改成插件自有服务并为 IAB 定义通用 Host 接口，安装并验收 Computer Use 原生驱动的跨平台权限与旧能力对齐；拿到 Electron binary 后在实际桌面进程中安装三个目标 Marketplace 插件和 App Builder 示例，验证权限、重载、App 与 agent 工具调用，再逐项切换并删除旧实现。`electron:build` 曾因 binary 下载失败，不能以 Main/UI 分别构建通过替代桌面验收。
