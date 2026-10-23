# 2026-10-22 — 外置 Browser、Computer Use 与 Conductor Canvas

状态：active · 负责人：Codex 会话 · 更新：2026-10-23
分支：`codex/browser-plugin-migration` · worktree：`/workspace/duya-browser-migration` · base：`ebd76d4878add41aa3e7cdac65a5884eee6c93a1`
Marketplace 分支：`codex/browser-migration` · worktree：`/workspace/duya-marketplace-browser` · base：`dce6ffa` · 当前：`25a4d6b`（最终推送见 PR head）

## 目标与边界

让 DUYA 基础 agent 保持精简，Browser、Computer Use、Conductor Canvas 分别作为官方 Marketplace Plugin / MCP / Mini App 按需接入。先以 Browser 建立 CUA REPL 纵切片，再分别集成三个旧模块的删除。用户后续明确要求 Canvas 全部实现退出核心；当前三个删除切片已进入任务分支，不做共享 UI 大改。

关联：[616 duya_app 内置 MCP 层](616-duya-app-mcp-layer.md)、[618 桌面管理层](618-duya-desktop-management-layer.md)。Marketplace 定义在独立 `duya-marketplace` 仓库。本计划的新决策覆盖 616 里 Browser / Computer Use 迁入 `duya_app` 的旧安排；不覆盖 616 的 MCP/权限基础设施，也不恢复 Canvas 迁入 `duya_app`。

## 验收

- Browser：目标为官方市场插件的 `cua_repl` MCP，提供持久化 JS REPL、模块目录添加、会话 reset 三个工具。服务端强制首个 `js` 调用仅读 CUA 文档、第二个调用仅读当前浏览器状态；目标/标签切换后也必须另起调用读新状态才能继续。
- Browser target：插件自己管理 Chromium 与可用的 Chrome、Edge 标签，按 URL、tab id 或浏览器名选择目标。独立 managed Chromium 取代旧 DUYA daemon/IAB 控制面；不新增 Browser 专用 Host 接口，UI-only URL 展示不在本次范围。
- Browser：由 Marketplace 声明并经 DUYA Plugin/MCP 调用链接入；验证初始化、列工具、REPL 状态保留、浏览器导航与快照；先前 Playwright smoke 只算通用 MCP 基线，不算此目标形态通过。
- Computer Use：独立 Marketplace 插件启动用户配置的原生 Cua Driver MCP 进程，插件适配器限定桌面工具清单；DUYA 只按通用 plugin MCP 管理它。旧 Windows UIA/审计/撤销能力、跨平台权限和二进制分发仍需单独验收。
- Conductor Canvas：完整实现属于独立 Marketplace Plugin。DUYA 只保留所有 Mini App 共用的包加载、沙箱、生命周期、授权与 MCP 接口；不能经插件反调 DUYA 内置 Canvas executor、数据库或 renderer。现有 Canvas 旧实现只在迁移验收前保留作兼容。
- 分别迁移和提交三个模块；回退通过对应 Git 提交完成，不保留第二份内置实现。基础工具和共享 UI 不顺带大改。

## 进度

- [x] 同步 master，在独立 worktree 审计 Plugin / MCP / Mini App 边界，并审阅 Codex 上游公开实现。
- [x] Browser 官方插件拥有三工具 CUA REPL、自有 Chromium/CDP pipe 与扩展 relay；真实 managed Chromium REPL 已验收。
- [x] Computer Use 官方插件拥有驱动适配、工具限制、策略、目标身份、审计、撤销与驱动回收；真实原始 manifest→discovery→resolver→MCPManager 链路已验收。
- [x] Canvas 原编辑器/domain/native/widget/refine、数据/资产/项目库、历史、provider、链接与截图全部由插件实现。
- [x] DUYA 通用 App 宿主支持安装、独立 MCP/grant、隔离资源与消息、Apps 入口、更新热重载、禁用撤销和关闭回收；Notes 与 Canvas 的真实桌面链路已验收。
- [x] App Builder 提供 Agent 可复制并安装的独立 App + MCP 模板。
- [x] 三个旧模块分别删除；Canvas UI、Conductor 包、Browser 自动化/daemon/扩展打包和 Computer Use 执行入口已退出核心。
- [x] 清理 trusted Computer Use skill、锁文件、共享 recorder 内无调用方输入方法及专属协议/原生 worker 操作。
- [x] 最终静态类型门禁、架构门禁、完整桌面构建、编码/manifest/coverage清单/抑制规则/静态产物检查通过；未扩大 baseline。
- [ ] Chrome/Edge 扩展真实启动、Linux AT-SPI 与其他 OS、真实外部模型请求和代表性用户旧数据库迁移仍须对应环境验收，不列为本环境通过。
- [x] 用户明确授权合并；Marketplace #2 已用 merge commit 合入 main。
- [ ] DUYA #355 已同步最新 master 并解决冲突，重验后按仓库规则合并；最终 merge SHA 以 PR 状态为准。

## 发现与决策

### 当前接续（2026-10-23，覆盖下方早期实现与失败记录）

- 核心源码检查点 `313a857c`，最终 worker 更新 `16efac3b`。`git ls-files packages/conductor packages/computer-use resources/browser-extension` 无输出；worker metafile 不含退休包或 BrowserTool。普通 URL BrowserPanel 保留。Recorder/Orb/Wake 的真实观测依赖保留；无调用方的 AX 输入、UIA invoke/selectText、窗口截图及相关 Swift/PowerShell 协议实现已删除。Orb Insert Tab 的用户手势输入不属于 Agent 自动化工具。
- DUYA 只提供通用安装、App 资源发布、opaque-origin iframe、standalone MCP、grant、Apps 容器、更新/禁用撤销、进程回收。Notes 真实 install→MCP写入→update热重载保留数据→disable关闭→旧URL404通过。没有 Canvas 或 Computer Use 专属 Host 桥。
- Marketplace Canvas 检查点 `acf46fb`：原 renderer/domain/native/widget/refine、独立存储/项目库/资产、显式旧SQLite导出导入、undo/redo、provider/settings、并发校验创建agent、自有Chromium URL截图与视觉截图均由插件持有。生产资源 `index-DJmYZ_Gy.js` 已构建；后续仅移除无用 html2canvas 依赖和修正文档注释。
- Canvas 在 Electron44/Xvfb 的真实验收：UI元素创建/文本编辑、外部MCP同步、新启动后持久化、可见文本 Ctrl+Z/Shift+Ctrl+Z 撤销重做、full/viewport/element PNG 均已通过。修复 html2canvas 在 opaque-origin iframe 中的跨域错误后，改用插件内联 DOM/SVG 栅格化；动态 widget 经 source+nonce 校验的 postMessage 自截图，未降低宿主 sandbox。
- 最新动态 widget 验收：通过插件 MCP 创建绿色背景、`PLUGIN WIDGET PNG` 文本和黄色圆形的 `widget/dynamic`，实际 MCP element 截图 580×387、full 截图1232×333，均已目视确认包含组件像素与原生画布元素。再次 CLI disable 后 iframe 自动消失，Host仍运行时旧资源URL返回404。独立 profile 最终保持禁用，验收进程已关闭。
- Browser 完整 REPL 对真实 sandbox Chromium 验证 docs→state→导航/点击/evaluate→PNG→reset保留标签与DOM→关闭释放端口。Chrome151命令行 unpacked 扩展未成功加载；不能宣称 Chrome/Edge 扩展验收通过。
- Computer Use：官方 Cua Driver0.38.0，原始 manifest→当前root resolver→MCPManager，无手工插值补丁，0 discovery issues、source=plugin、21工具，guide/permissions/1440×900 PNG通过；disconnect后无driver/server残留。X11连接/XSendEvent可用；DBus无 org.a11y.Bus owner，AT-SPI不可用。`2a5c778b`修复路径展开阶段提前消费DISPLAY默认值；市场 `e375b68`修复子进程回收。
- 最新验证：完整 `electron:build`（official Electron44，`--ignore-scripts`，当前检出）退出0；Electron类型门禁退出0（206 known / 102 keys，无新增）；architecture退出0（2547 baselined / 0新增）；各静态类型子门禁、编码、manifest、coverage收集清单、no-ts-suppress和静态packaged-artifacts均通过。`typecheck:all`自带最终 node test runner，因此在该步骤前停止，静态门禁分项完成；未增加或运行新的测试套件。没有改baseline掩盖错误。
- 限制：独立App保留/复制旧session链接，不能浏览Host私有聊天；Chrome/Edge扩展、其他OS/原生可访问性、live provider和代表性用户数据导入均未在本环境验证。静态packaged-artifacts不代表带真实provider的安装包聊天验收。
- DUYA #355、Marketplace #2 保持 draft；均附加本任务，无master合并。最终head和推送状态以PR为准。任务worktree保留，未跟踪node_modules junction和旧包目录下生成文件不提交。

### 早期调查与实现记录

- 用户指定以 GPT-6 Luna / high 子代理并行完成迁移。分工：`canvas_marketplace` 迁原编辑器与模型；`browser_marketplace` 迁自有浏览器桥接服务；`computer_marketplace` 处理驱动与运行时；`duya_canvas_detach` 准备旧 Canvas 依赖闭包删除；`duya_app_host` 修复通用访客通信和 App 导航；`agent_app_builder` 负责 Agent 建 App 模板及插件自有数据视图后端。每个实现使用独立 worktree，主代理审阅后集成到上述两个 PR 分支。
- 2026-10-22 同步 `origin/master` 到 `96dadf4d`，以 merge commit `2fe3a6bf` 合入迁移分支；原主线变更为目录/文档整理。已撤回的 Computer Use Host 桥接测试仅保存在本地具名 stash，不参与当前实现或验收。
- 真实 Electron 验收发现本地插件 registry 只持久化启停信息，`hydrateViewItem` 却在解析安装软链接之前尝试读取 manifest，导致 App 声明丢失、授权前直接返回 `grant_denied`。当前切片改为先解析安装路径再读取已安装 manifest，并以安装版本显示元数据。
- Electron 44 的独立探针确认 webview 内 `window.parent === window`；既有 App 使用的 iframe 式 `parent.postMessage` 不能抵达嵌入窗口。通用宿主正在替换此传输，Main IPC/MCP 验收不得冒充 App 页面已可用。
- 通用 App 静态资源现在按启动会话发布到随机 loopback 地址，校验 Host、安装目录 realpath 和文件边界，关闭/更新撤回资源令牌；Opaque-origin iframe 可加载相对模块、字体和样式，开发版与打包版使用同一入口。页面消息还需携带独立的 documentToken，防止 iframe 自行导航后其他文档继续使用原 App 会话。
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
| DUYA `2fe3a6bf` + 本地 manifest hydration 修复 | Linux x64, Node 24.19.0, Electron 44.2.0, Xvfb `:99` | `ELECTRON_OVERRIDE_DIST_PATH=... npm --ignore-scripts run electron:build`；已另行验证 Electron 下 better-sqlite3 可加载 | 0；完整桌面构建通过。缺失的已锁定 `@types/picomatch` 仅安装到 worktree 自有依赖 overlay；未穿过共享 node_modules 安装 | 当前会话命令输出 |
| 同上；`PluginManager{,.listInstalled.test}.ts` | Linux x64, Node 24.19.0 | 定向 Vitest，真实 Electron 隔离 namespace 下 installLocal → App open → bind → MCP invoke | 3 tests passed；本地插件 App 声明可见；模拟一次授权后绑定 31 个工具，`canvas_manage list` 返回插件空数据。尚未验证 App 页面访客通信 | 当前会话命令输出 |
| DUYA `acb9ec56` + App assets 切片 | Linux x64, Node 24, Electron 44.2.0, Xvfb `:99` | assets/host 定向 Vitest；Electron Main 构建与类型门禁；真实 preview `file://` 和 dev `http://localhost:3000` 页面内注入隔离 iframe并使用生产 MainIPC relay | 4 tests passed；构建/类型门禁退出 0；两模式均显示 Canvas 插件服务已连接，关闭后 entry URL 返回 404。此处是实际资源/MCP链路探针，生产 PluginAppHost UI 集成仍待验收 | 当前会话命令输出 |

## 用户授权集成（2026-10-23）

- 用户已明确要求合并，允许按依赖顺序集成两个 PR，不使用 admin bypass。
- Marketplace #2 已合并到 `main`，merge commit `38970870dde580a860b2c795a73e1ca0f1708722`。本任务 worktree 已同步到该提交；合并树的 catalog、四个插件 manifest 与 MCP/模板声明均可解析，树内容与此前验收 head 一致。
- DUYA 主干前进到 `7b339024`（Host lifecycle/integration sync、工具组、侧栏与面板重构）。在迁移 worktree 中合入它，重新生成 worker 产物；冲突解决保留主干的面板列树、FileWorkspace、新 PanelWindow IPC、工具组统计/展开持久化与通用 prompt composer，同时不恢复 Canvas、AgentBrowser 或 Computer Use 的旧注册。
- 已核对 GitHub ruleset：DUYA 必需审批数为0、必需状态检查列表为空；市场分支没有匹配的 ruleset。classic protection 读取返回403，因此合并只走 GitHub 正常 PR merge 路径，由服务端继续执行其保护规则；不以本地权限替代服务器检查。
- 独立只读审阅已完成：主干面板列树/FileWorkspace/PanelWindow IPC、工具组展开/diff统计、通用prompt composer（含suffix）均保留，未恢复三项旧能力注册。共享OS context采集继续按前述Recorder/Orb/Wake范围保留。
- 整合重验通过：完整 `electron:build` 退出0；Electron/CLI/Web/evals静态类型门禁全部退出0（Electron仍206 known，0新增）；架构2581条均为基线、0新增；编码/manifest/coverage收集/no-ts-suppress/静态产物检查均退出0。首次workspace构建暴露主干新增工具摘要中的旧Canvas分类，修复后完整桌面闭包构建通过。
- 使用当前构建出的 `file://.../dist/index.html` 在Electron44/Linux/Xvfb重新打开真实Canvas App，既有内容显示、MCP full PNG1232×333（含dynamic widget）通过；CLI disable自动关闭iframe，Host仍运行时旧asset URL404。初次诊断的CLI初始化等待和file-origin首次引导由验收脚本修正，未修改产品去绕过这两步。
- 最终合并仍走服务端普通merge路径；最终merge SHA以PR状态为准。合并后保留含依赖 junction 和本地验收材料的任务 worktree，不强制删除或回收其他 agent 检出。

## 最终验证补充

| 检查点 | 命令或操作 | 结果 |
| --- | --- | --- |
| DUYA `0ab86bdb` + 后续仅删除旧测试/生成worker | `ELECTRON_OVERRIDE_DIST_PATH=/workspace/.tools/duya-electron-44 npm --ignore-scripts run electron:build` | 退出0，当前检出Main/Preload/UI/worker/recorder worker及依赖构建通过 |
| 同源码 + `313a857c` 删除已退役方法的旧测试用例 | `npm run typecheck:electron:prepared`；`npm run architecture:check` | 退出0；206 known类型错误、0新增；2547基线架构违规、0新增。早期普通sandbox执行因spawnSync受限未真正运行，启用所需执行权限后完成门禁 |
| DUYA `313a857c` | check:encoding / check:manifest-keys / check:test-coverage / check:no-ts-suppress / check:packaged-artifacts | 全部退出0；coverage为收集清单检查，不执行测试 |
| Marketplace `acf46fb` | Canvas typecheck、build、嵌入widget JS `vm.Script`语法检查 | 全部退出0；修复String.raw转义和重复根节点；生产资源index-DJmYZ_Gy.js |
| DUYA `313a857c`当前Main/Vite + Canvas `acf46fb` | 真实插件MCP创建widget、element/full截图、CLI disable | PNG580×387/1232×333，目视确认内容；iframe自动消失，旧URL404；profile隔离 |

## 接续 / 结果

本分支已实现并完成本环境可执行的迁移验收：三个具体能力都由官方市场插件提供；DUYA保留通用桌面Plugin/Mini App/MCP入口；Agent可使用App Builder模板建立并安装自己的App。核心旧实现分别移除，生产构建通过。用户已授权集成；Marketplace已合并，DUYA在同步主干与重验后按正常PR merge流程集成。最终merge SHA以PR状态为准。

剩余环境覆盖：Chrome/Edge扩展真实安装启动、Windows/macOS与AT-SPI、真实外部模型请求、代表性旧用户数据库迁移、带provider的安装包聊天验收。按当前接续的限制记录，不将源码迁移或静态检查当作这些场景的通过证据。
