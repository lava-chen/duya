# 插件 UI 通过 MCP resources/read 加载

状态：active（S1-S6 已随 PR #440 合并；真实 worker E2E 补充 PR 待 review）· 负责人：Codex `/root` 会话 · 更新：2026-10-24
分支：`codex/plugin-ui-worker-e2e` · worktree：`.claude/worktrees/plugin-ui-mcp-resources` · 最新 base：`686f3c81eace1477010b3b94c74f59ac78732a36` · S1：`b60eeed8` · S2：`b45e51a9` · S3：`d5e7d0b4` · S4：`b9c20b9a` · S5：`d6b1c4dd` · S6：`9b43f12e` · worker E2E：`384af5af` · owner：`/root`

## 目标与边界

插件 App 在 manifest 的 `apps[].ui.surfaces` 声明 MCP UI surface；宿主通过所属 MCP server 的 `resources/read` 取得内容，并沿用现有 loopback 文档通道、document token、launch nonce、opaque-origin iframe 与逐次 invoke 复核，在侧栏 tab 中显示。保留静态 `entry` 兼容。

不引入完整 MCP Apps 协议；不新增 tab 状态源；不将插件页面常驻面板 DOM；不改市场运营或排序；只迁移一个纯查看型示例插件，并保留一个静态 entry 插件做兼容回归。

每个切片独立提交 Conventional Commit；不合并、不直推主分支。S1 完成后暂停，先报告契约 diff 与受影响调用方，再推进 S2。

## 验收

- 安装后 surface 入口可见，内容来自 MCP `resources/read`；同 surface 重复点击复用已有 tab。
- 非当前 iframe 消息丢弃；token 不匹配、非 loopback、跨插件资源名、超限资源体被拒绝且 UI 显示错误。
- agent 的 `select` / `highlight` 能更新界面；无活动会话时隐藏 `availability: session` surface。
- 原静态 `entry` 插件仍可用；安装态变化能刷新目录。
- 运行 `npm run typecheck:all`、`npm run architecture:check`、相关包测试；main/preload 变更后重建 Electron；UI 走真实产品路径。
- 每条验证记录包含环境、SHA、命令和退出码；PR 前如 master 前进则 rebase 并重跑门禁；开 draft PR 到 master，不合并。

## 进度

- [x] S1 契约：定义 surface schema，校验所属 MCP server、`ui://` URI、插件内唯一 ID；保持静态 `entry` 双向兼容。
- [x] S2 发现与目录：投影到已安装插件目录，拒绝跨插件同名 surface，安装态变化刷新目录。
- [x] S3 宿主资源解析：调用 MCP `resources/read`，校验 MIME、大小、来源 server，再通过现有文档通道签发 token 与 nonce。
- [x] S4 UI 入口：插件应用区与侧栏 tab 渲染 surface，按会话可用性隐藏入口；真实 Electron smoke 已通过安装插件、打开 Apps surface、读取 MCP 资源并在 token 化 loopback iframe 渲染的产品路径。
- [x] S5 双向通道：保留 guest→host invoke；资源页用当前 document token 完成 ready 握手；只将当前插件 server 的成功 `duya_ui_select` / `duya_ui_highlight` / `duya_ui_refresh` 工具结果按当前 surface 发给本次 iframe，payload 限 8 KiB。
- [x] S6 示例与兼容：新增 MCP 资源型只读 Report Viewer；真实 stdio MCP 测试读取 HTML、调用事件工具，并验证页面 select/highlight/refresh 更新；manifest 回归确认静态 `hello-app` 仍保留 `entry`。

## 发现与决策

- `origin/master` 基线为 `21351df668adefc0357741a5f79a1513e297df61`；旧 `work` 检出为 `2baa95df`，保持未修改。
- PR 前 `git fetch origin master` 发现 master 先前前进到 `cb7513dbe4fb96a54f8e527934daec031bb37943`，后又前进到 `40787b394d08207ed78c863d9c78dc413a9d1038`；任务分支 14 个提交已无冲突 rebase 到最新 SHA，所有切片代码提交 SHA 已更新为页眉所列短 SHA，第二次 rebase 后门禁重跑完成。
- 当前 master 将架构入口放在 `docs/architecture/ARCHITECTURE.md`；`docs/exec-plans/README.md` 没有根规则旧版本提到的 “Verified baseline” 小节，基线将按本次工作重新测量。
- `.codegraph/` 与 CodeGraph 工具均不可用；代码定位通过 `rg` 和源码交叉核对。
- S1 将双语标题固定为当前产品的 `en` / `zh`；surface 位于 `apps[].ui.surfaces`，静态 `entry`、resource-only surface、两者并存均可声明。Desktop 三种 manifest 路径都把 surface 的 `server` 绑定到该插件实际声明的 `mcpServers`。
- worktree 链接脚本读取了旧共享检出的 workspace 列表，缺少 master 新增包；仅在任务 worktree 补齐 `packages/` 与 `apps/` 的当前 master overlay。锁文件有 `@types/picomatch@4.0.3`，共享依赖目录缺失；包安装在 `/tmp` 并从 worktree overlay 引用，未写入共享依赖目录。
- 完整 `electron:build` 需要下载 ripgrep 与 Electron 二进制；下载失败。共享 `node_modules/electron` 无二进制且未被修改；单独执行仓库 main/preload bundle 构建成功。
- 当前上下文未提供 Playwright MCP 工具，完整 Electron 二进制也未下载；surface 的真实应用 UI 验收记录在 S4/S6，不在 S1 声称完成。
- 参考官方 `zai-org/ZCode` 开源仓库（浅克隆 SHA `3c5b227649371507ddc4eb46ac5133afe6db1cab`）：`plugins/listUiSurfaces` 是与 tab 状态分离的只读目录投影，仅返回启用插件的 surface；本任务采用目录投影与资源归属检查的经验，不引入其 MCP Apps 页面 API、工具注册、订阅或 widgetState 协议。
- S2 从已安装 Plugin App 声明生成独立只读 surface 目录；跨已安装插件重复 ID 全部隔离并返回 owner 冲突，目录仅提供启用插件的唯一 surface。安装、启用、停用、卸载和设置变化复用既有 `plugin-app:changed` 事件供目录消费者刷新。
- S3 经现有 MCP SDK `Client.readResource` 加载 surface：活动会话 worker 存活时复用其 MCPManager，并以 worker 身份与 generation 复核响应；无 worker 或 standalone/always 入口通过同一 MCPManager 实现短连接读取，仅连接 manifest 声明的 server。worker 和 Main 都要求 server `source=plugin`、插件归属匹配、资源 URI 完全匹配、唯一文本 `text/html` 内容且不超过 8 MiB。Main 将已校验 HTML 挂到随机 token 的 loopback `/index.html` 单文档路由；该 mount 不提供包内静态资源，文档 CSP 禁止网络连接，沿用既有 launch nonce 与 opaque-origin iframe。静态 `entry` 路径保持原样。
- S4 的 Apps 目录将 surface 按插件归组并调用既有 `PanelProvider.openOrActivatePage`；tab 去重键为 `pluginId + surfaceId`。session surface 无活动会话时不出现在目录，PanelZone 同时关闭 session tab；插件 iframe 只在面板打开且卡片可见时挂载。旧 preload 没有 surface 目录能力或目录读取失败时，静态 `entry` launcher 仍从插件 registry 渲染。
- 首次 Electron 启动受环境限制：共享 `node_modules/electron` 没有二进制且网络 fetch 失败，环境起初也没有 `Xvfb`。后续在 `/tmp` 下载并解压 Electron 44.9.1 与 Xvfb，以临时 Playwright loader 提供可执行文件路径和 `--no-sandbox`，没有改写共享依赖；真实产品 smoke 随后通过。
- 产品 smoke 首次运行发现安装后的 Report Viewer 把相对 MCP server 路径按宿主工作目录解析，导致资源读取失败。改用 `${DUYA_PLUGIN_ROOT}/mcp/reports-server.mjs`，并加入真实 Electron E2E 回归用例；该用例通过真实 preload/Main IPC 安装插件，Main MCP SDK 启动 stdio server 并执行 `resources/read`，随后在 Apps 与侧栏 tab 确认内容和重复激活去重。
- 实际 Electron E2E 已覆盖安装至资源渲染和重复点击去重；agent worker 工具调用到当前 iframe 的完整联动仍由 MCP stdio 示例测试及 UI 事件桥测试分别覆盖，尚未在同一个桌面 worker turn 中端到端运行。因此 PR 继续保持 draft，待补齐这一组合路径验收后再标 ready。
- PR #440 的 base 原为 `40787b394d08207ed78c863d9c78dc413a9d1038`；2026-10-24 GitHub 比较显示 master 前进 22 个提交至 `c426d029668ed0a0d6dae5ca9429b4a878925abd`。首次普通 fetch 被代理拒绝；以提升权限重试后 fetch 成功，任务分支 19 个提交无冲突 rebase，并重跑全仓类型、架构、9 个相关测试文件、Electron 构建与真实 Electron surface smoke，均通过。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `21351df668adefc0357741a5f79a1513e297df61` | Linux，Node v24.19.0，npm 11.9.0 | `git fetch origin` | 0 | `origin/master` 更新至基线 SHA |
| `21351df668adefc0357741a5f79a1513e297df61` | Linux，Node v24.19.0 | `node scripts/junction-worktree.mjs . --dry-run` | 0 | 36 个链接；实际初始建立 40 个链接，后为当前 master 补齐 overlay |
| `21351df668adefc0357741a5f79a1513e297df61` | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run packages/plugin-core/tests/apps/declarations.test.ts`（S1 基线） | 0 | 1 个文件、9 个测试通过 |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0 | `npm run build:plugin-core` | 0 | 新 schema / 声明编译通过 |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0 | `npm run build:desktop:deps` | 0 | current master 的 17 个 Desktop 依赖包构建通过；使用 task-local workspace overlay 与 `/tmp` 类型包 |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0，Vitest 3.2.4；允许 loopback | `npx vitest run packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 3 个文件、56 个测试通过；无 loopback 权限时 host 测试报 `listen EPERM` |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0；额外执行权限用于 git 子进程 | `npm run typecheck:all` | 0 | 所有阶段通过；Electron ratchet 无新增错误，报告 9 个 baseline key 可收紧 |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0 | `npm run architecture:check` | 0 | 无新增边界违规；255 个既有 fingerprint 不再触发 |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0；允许网络但资源下载失败 | `npm run electron:build` | 1 | ripgrep / Electron 二进制 fetch 失败；未写入共享 `node_modules/electron` |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux，Node v24.19.0 | `node scripts/build-electron.mjs` | 0 | Electron main/preload bundle 编译完成并复制运行时 native modules |
| `21351df668adefc0357741a5f79a1513e297df61` + S1 dirty | Linux | `git diff --check` | 0 | 无空白错误 |
| `da8f56bbf3a92e520144d32260bdbfc6a091ab1f` | Linux，Node v24.19.0 | `npm run build:plugin-core` | 0 | 新增目录投影契约类型编译通过 |
| `da8f56bbf3a92e520144d32260bdbfc6a091ab1f` | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run apps/desktop/src/main/plugins/plugin-ui-surface-directory.test.ts` | 0 | 1 个文件、2 个测试通过；覆盖启用态投影与跨插件冲突隔离 |
| `da8f56bbf3a92e520144d32260bdbfc6a091ab1f` | Linux，Node v24.19.0；授权执行以允许检查脚本启动 git 子进程 | `npm run typecheck:all` | 0 | 全仓类型检查通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 可收紧 |
| `da8f56bbf3a92e520144d32260bdbfc6a091ab1f` | Linux，Node v24.19.0；授权执行以允许架构脚本启动 node 子进程 | `npm run architecture:check` | 0 | 无新增边界违规；255 个既有 fingerprint 不再触发 |
| `da8f56bbf3a92e520144d32260bdbfc6a091ab1f` | Linux，Node v24.19.0 | `npm run build:electron` | 0 | Electron main / preload bundle 重建完成 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0，npm 11.9.0 | `npm run build:plugin-core`；`npm run build -w @duya/agent-protocol`；`npm run build -w @duya/capabilities`；修复可空 worker manager 后 `npm run build -w @duya/host` | 0 | Plugin UI 8 MiB 上限、RPC 类型、MCP `readResource` client 与 worker API 编译通过 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0 | `npm run typecheck:preload -w @duya/desktop` | 0 | 新增 surface launch 参数编译通过 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0 | `npm run typecheck:main -w @duya/desktop` | 2 | 独立 main 检查被仓库已有项目级错误挡住；完整 electron ratchet 后续确认无新增错误，改动文件没有匹配诊断 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty（首次） | Linux，Node v24.19.0 | `npm run typecheck:all` | 1 | Host 检查发现 `manager` 可空；修复后完整重跑通过 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0，npm 11.9.0 | `npm run typecheck:all` | 0 | 20 个包构建与全仓检查通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 可收紧；4 个 agent core recorder 检查通过 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty（首次） | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/plugin-app-assets.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts apps/desktop/src/main/agents/server/__tests__/plugin-app-bridge.test.ts` | 1 | MCP test server fixture 未实现连接阶段必需的 `tools/list`；补齐后同命令通过 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0，Vitest 3.2.4；允许 loopback | 同上 6 个测试文件 | 0 | 6 个文件、83 个测试通过；覆盖真实 in-process MCP `resources/read`、manifest、worker bridge、host MIME/来源/大小拒绝与 loopback 单文档路由 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0 | `npm run architecture:check` | 0 | 无新增边界违规；255 个既有 fingerprint 不再触发 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux，Node v24.19.0 | `npm run build:electron` | 0 | Electron main / preload bundle 重建完成 |
| `6accc976ca6bf9a4e5000ed574f5a269d4223c40` + S3 dirty | Linux | `git diff --cached --check` | 0 | S3 暂存 diff 无空白错误 |
| `72e30ee3783eeecf88a86823fb37db49f7c86e5b` + S4 初版 UI dirty | Linux，Node v24.19.0，npm 11.9.0 | `npm run typecheck:all` | 0 | 20 个包构建及全仓检查通过；Electron ratchet 无新增错误（206 已知），9 个基线项收敛；recorder 4/4 |
| `72e30ee3783eeecf88a86823fb37db49f7c86e5b` + S4 dirty | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/components/layout/PanelZone.test.tsx packages/ui/src/components/layout/PanelHeader.test.tsx` | 0 | 4 个文件、31 项通过；覆盖目录投影、tab 去重及 iframe 隐藏/卸载 |
| `72e30ee3783eeecf88a86823fb37db49f7c86e5b` + S4 dirty | Linux，Node v24.19.0，授权子进程 | `npm run architecture:check` | 0 | 无新增边界违规；255 个既有 fingerprint 不再触发 |
| `5e0ee6c356dca1e040ffa171c6ad27d6d4131aeb` | Linux，Node v24.19.0，npm 11.9.0 | `npm run typecheck -w @duya/ui` | 0 | 包级 UI 类型检查覆盖最终兼容回退与测试代码 |
| `5e0ee6c356dca1e040ffa171c6ad27d6d4131aeb` | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/components/layout/PanelZone.test.tsx packages/ui/src/components/layout/PanelHeader.test.tsx` | 0 | 4 个文件、32 项通过；增加目录 API 不可用时静态入口仍可见 |
| `5e0ee6c356dca1e040ffa171c6ad27d6d4131aeb` | Linux | `git diff --cached --check` | 0 | S4 代码提交前无空白错误 |
| `5e0ee6c356dca1e040ffa171c6ad27d6d4131aeb` | Linux；无 Electron 二进制、无 Xvfb；网络受限 | `test -x node_modules/electron/dist/electron; command -v xvfb-run; node -p "require('electron')"` | 1 | Electron 包触发二进制下载后 fetch 失败；没有可运行桌面显示服务，因此真实 UI/IPC/worker 验收未完成 |
| `1d8cfcd9` | Linux，Node v24.19.0，npm 11.9.0 | `npm run typecheck -w @duya/ui` | 0 | 新事件桥、surface MCP server 参数与 UI 测试类型通过 |
| `1d8cfcd9` | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx` | 0 | 4 个文件、36 项通过；测试日志包含既有 jsdom canvas 未实现提示 |
| `5e0ee6c356dca1e040ffa171c6ad27d6d4131aeb` + S5/S6 dirty | Linux，Node v24.19.0，Vitest 3.2.4 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx`（首次） | 1 | 初次断言未计入 ready 握手后暂存事件的发送；调整时序断言后通过 |
| `199d19fb` | Linux，Node v24.19.0，Vitest 3.2.4；允许 stdio 子进程 | `npx vitest run packages/capabilities/tests/mcp/report-viewer-example.test.ts apps/desktop/src/main/plugins/manifest.test.ts` | 0 | 2 个文件、44 项通过；使用真实 MCP SDK stdio client `resources/read` / `tools/list` / `tools/call`，并执行 MCP 返回 HTML 验证 ready 与 select/highlight/refresh；确认 hello-app 静态 entry |
| `0898ee6a` + S6 dirty | Linux，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all` | 0 | 20 包构建、web bundle 和各 TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个基线 key 收敛；recorder 4/4 |
| `0898ee6a` + S6 dirty | Linux，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；255 个既有 fingerprint 不再触发 |
| `0898ee6a` + S5/S6 dirty | Linux，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | UI、panel、manifest、resource host、capabilities 示例及 plugin-core 声明 9 个文件测试 | 0 | 9 个文件、103 项通过；此轮后示例测试再扩展 refresh 并以 `199d19fb` 的 44 项命令复验 |
| `d34a4bab`（rebase 后） | Linux，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all` | 0 | 20 包构建与全部 TS 门禁通过；Electron ratchet 无新增错误（206 已知），9 个 baseline key 收敛；recorder 4/4 |
| `d34a4bab`（rebase 后） | Linux，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；1 个既有 fingerprint 不再触发 |
| `d34a4bab`（rebase 后） | Linux，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `d34a4bab`（rebase 后） | Linux | `git diff --check origin/master...HEAD` | 0 | rebase 后任务 diff 无 whitespace error |
| `d34a4bab`（rebase 后） | Linux，GitHub fetch | `git fetch origin master`；`git rebase origin/master` | 0 | master 为 `cb7513dbe4fb96a54f8e527934daec031bb37943`；12 个任务提交无冲突重放 |
| `956b53db`（rebase 后） | Linux，Node v24.19.0 | `npm run build:electron` | 0 | main / preload Electron bundle 构建完成；有既有 esbuild external 警告 |
| `956b53db` | Linux，GitHub remote | `git push --set-upstream origin codex/plugin-ui-mcp-resources` | 0 | 任务分支已推送；未推送 master |
| `c073724c`（第二次 rebase 后） | Linux x86_64，Node v24.19.0，npm 11.9.0 | `git fetch origin`；`git rebase origin/master` | 0 | master 为 `40787b394d08207ed78c863d9c78dc413a9d1038`；14 个任务提交无冲突重放 |
| `c073724c`（第二次 rebase 后） | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all` | 0 | 20 个 workspace 包构建、web bundle 与全部 TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `c073724c`（第二次 rebase 后） | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；1 个既有 fingerprint 不再触发 |
| `c073724c`（第二次 rebase 后） | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `c073724c`（第二次 rebase 后） | Linux x86_64，Node v24.19.0 | `npm run build:electron` | 0 | Electron main / preload bundle 重建完成；有既有 esbuild external 警告 |
| `c073724c`（第二次 rebase 后） | Linux x86_64；Electron 二进制与 Xvfb 均不可用 | `test -x node_modules/electron/dist/electron; command -v xvfb-run` | 1 | 无法启动 Electron 桌面环境；真实 UI/IPC/worker 产品路径仍待具备 Electron 与显示服务的环境验证，未用 mock 代替 |
| `e0dd4f51` | Linux x86_64，GitHub remote | `git push --force-with-lease=refs/heads/codex/plugin-ui-mcp-resources:4fb21546a2d30b1e4e8548ec9f739fff3395fc95 origin HEAD:refs/heads/codex/plugin-ui-mcp-resources` | 0 | PR 分支更新为 `e0dd4f51e9ce9a2d0fc9644ce64a73623baa41b2`；master 未变 |
| `e0dd4f51` | Linux，GitHub remote | `github_get_pr_info(440)` | open / draft / mergeable | PR #440 base 为 `master` / `40787b394d08207ed78c863d9c78dc413a9d1038`，head 与远端任务分支一致；未合并 |
| `e0dd4f51` | Linux x86_64；系统 Chromium 与 Playwright 存在，无 Electron binary、无显示服务 | `command -v electron chromium chromium-browser google-chrome Xvfb xvfb-run weston` 与 Electron package binary 检查 | Electron / display 不可用 | 只有系统 Chromium，不能覆盖 Electron main/preload IPC 与 worker 链路；真实产品路径仍待具备 Electron 和显示服务的环境验证 |
| `37a22819` | Linux x86_64，GitHub remote | `git push origin HEAD:refs/heads/codex/plugin-ui-mcp-resources` | 0 | PR 进度记录已同步到任务分支；master 未变 |
| `37a22819` | Linux，GitHub remote | `github_get_pr_info(440)` | open / draft / mergeable | PR #440 base 为 `master` / `40787b394d08207ed78c863d9c78dc413a9d1038`；head 与刚推送分支一致；未合并 |
| `1505c1e0` + server path / E2E dirty | Linux x86_64，Node v24.19.0；Electron 44.9.1 与 Xvfb 从临时下载目录运行；Playwright Electron loader 补入 binary 路径和 `--no-sandbox` | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 1 个真实 Electron 产品 smoke 通过：真实安装 IPC、surface 目录、MCP stdio `resources/read`、loopback opaque iframe 内容与同 surface tab 去重；约 44 秒 |
| `1505c1e0` + server path / E2E dirty | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all` | 0 | 20 个 workspace 包、web bundle 和全部 TypeScript 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `1505c1e0` + server path / E2E dirty | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；1 个既有 fingerprint 不再触发 |
| `1505c1e0` + server path / E2E dirty | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；包含真实 stdio MCP `resources/read` / `tools/call`、资源页事件行为和静态 entry manifest 回归 |
| `475f59f0` | Linux x86_64 | `git diff --check`；`git diff --cached --check` | 0 | 插件 server 安装路径修正及 Electron E2E 提交无空白错误 |
| `475f59f0` + plan dirty | Linux x86_64；shell network proxy | `git fetch origin` | 1 | 代理 `8080` 无法连接；GitHub compare API 只读核实 `master` 为 `c426d029668ed0a0d6dae5ca9429b4a878925abd`、相对旧 base ahead 22 |
| `c426d029668ed0a0d6dae5ca9429b4a878925abd` | Linux x86_64，GitHub remote；提升权限用于网络 fetch | `git fetch origin master`；`git rebase origin/master` | 0 | master 为 `c426d029668ed0a0d6dae5ca9429b4a878925abd`；19 个任务提交无冲突重放 |
| `ad511786`（新 master rebase 后） | Linux x86_64，Node v24.19.0，npm 11.9.0；提升权限允许脚本启动子进程 | `npm run typecheck:all` | 0 | 20 个 workspace 包、web bundle 与全部 TypeScript 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `ad511786`（新 master rebase 后） | Linux x86_64，Node v24.19.0；提升权限允许架构检查启动子进程 | `npm run architecture:check` | 0 | 无新增边界违规；1 个既有 fingerprint 不再触发 |
| `ad511786`（新 master rebase 后） | Linux x86_64，Node v24.19.0，Vitest 3.2.4；提升权限用于 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `ad511786`（新 master rebase 后） | Linux x86_64，Node v24.19.0；提升权限允许脚本启动子进程 | `npm run build:electron` | 0 | main / preload bundle 重建完成；有既有 esbuild external 警告 |
| `ad511786`（新 master rebase 后） | Linux x86_64，Node v24.19.0；Electron 44.9.1、Xvfb 和 Playwright loader 均为 `/tmp` 临时文件 | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 真实 Electron 产品 smoke 通过；1 test、35.2 秒，覆盖安装 IPC、MCP `resources/read`、loopback iframe 和重复激活去重 |
| `554f24b102f8fb456e9671200395e8d3a94b81b4` | Linux，GitHub remote | `github_get_pr_info(440)` | closed / merged | PR #440 在 `2026-10-24T11:02:32Z` 合并，merge commit 为 `554f24b102f8fb456e9671200395e8d3a94b81b4`；最终状态不再是 draft。该合并发生于本会话最后一次状态核对期间，未由本任务触发 |
| `554f24b102f8fb456e9671200395e8d3a94b81b4` | Linux x86_64，GitHub remote | `git fetch origin master` | 0 | 最新 master 包含 PR #440 merge commit `554f24b1` |
| `c8c6818d134b32ee1e68adde94b84c07755c835b` | Linux x86_64，Git 2.x | `git switch -c codex/plugin-ui-worker-e2e origin/master`；`git cherry-pick 135092c8` | 0 | 从合并后的 master 新建 follow-up 分支；只带入未包含在 #440 的真实 Agent Server/worker select/highlight smoke |
| `c8c6818d134b32ee1e68adde94b84c07755c835b` | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all` | 0 | 20 个 workspace 包、web bundle 与全部 TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `c8c6818d134b32ee1e68adde94b84c07755c835b` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；1 个既有 fingerprint 不再触发 |
| `c8c6818d134b32ee1e68adde94b84c07755c835b` | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `c8c6818d134b32ee1e68adde94b84c07755c835b` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run build:electron` | 0 | Electron main / preload bundle 重建通过；有既有 esbuild external 警告 |
| `c8c6818d134b32ee1e68adde94b84c07755c835b` | Linux x86_64，Node v24.19.0；Electron 44.9.1、Xvfb 与 Playwright loader 为 `/tmp` 临时文件 | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 2 个真实 Electron smoke 通过，1.2 分钟：MCP resources/read 到资源 iframe；真实 UI turn 经 Agent Server/worker 执行 select/highlight 并更新打开的 iframe |
| `a1e1d5dc` | Linux x86_64，GitHub remote；提升权限用于 fetch / rebase | `git fetch origin master`；`git rebase origin/master` | 0 | master 前进到 `d26bec34ff6d8179f2352b1250112da92bff7fc5`；2 个 follow-up 提交无冲突重放 |
| `a1e1d5dc` | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all` | 0 | 20 个 workspace 包、web bundle 与全部 TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `a1e1d5dc` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；1 个既有 fingerprint 不再触发 |
| `a1e1d5dc` | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `a1e1d5dc` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run build:electron` | 0 | Electron main / preload bundle 重建通过；有既有 esbuild external 警告 |
| `a1e1d5dc` | Linux x86_64，Node v24.19.0；Electron 44.9.1、Xvfb 与 Playwright loader 为 `/tmp` 临时文件 | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 2 个真实 Electron smoke 通过，1.3 分钟：资源安装/读取/iframe tab 去重；真实 Agent Server/worker 执行 select/highlight 并更新 iframe |
| `a8bc71d2` | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限 | `npm run typecheck:all`（初次） | 1 | 新 master 新增的 `@duya/workflow` 未被旧共享 checkout 的 worktree junction 脚本枚举；只在当前 worktree 的 `packages/node_modules` 与 `apps/node_modules` 补本地链接后重跑 |
| `a8bc71d2` | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限，worktree-local `@duya/workflow` links | `npm run typecheck:all`（重跑） | 0 | 21 个 workspace 包、web bundle、workflow / Electron TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `a8bc71d2` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；2 个既有 fingerprint 不再触发 |
| `a8bc71d2` | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `a8bc71d2` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run build:electron` | 0 | Electron main / preload bundle 重建通过；有既有 esbuild external 警告 |
| `a8bc71d2` | Linux x86_64，Node v24.19.0；Electron 44.9.1、Xvfb 与 Playwright loader 为 `/tmp` 临时文件 | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 2 个真实 Electron smoke 通过，1.1 分钟：资源安装/读取/iframe tab 去重；真实 Agent Server/worker 执行 select/highlight 并更新 iframe |
| `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666` | Linux x86_64，GitHub remote；提升权限用于 fetch / rebase | `git fetch origin master`；`git rebase origin/master` | 0 | master 前进到 `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666`；3 个 follow-up 提交无冲突重放 |
| `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666` + follow-up | Linux x86_64，Node v24.19.0，npm 11.9.0；worktree-local `@duya/workflow` links | `npm run typecheck:all` | 0 | 21 个 workspace 包、web bundle、workflow / Electron TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666` + follow-up | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；2 个既有 fingerprint 不再触发 |
| `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666` + follow-up | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666` + follow-up | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run build:electron` | 0 | Electron main / preload bundle 重建通过；有既有 esbuild external 警告 |
| `ffc6fc89ed6eb28c6c3ace5fc8a9fc9261110666` + follow-up | Linux x86_64，Node v24.19.0；Electron 44.9.1、Xvfb 与 Playwright loader 为 `/tmp` 临时文件 | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 2 个真实 Electron smoke 通过，1.1 分钟：资源安装/读取/iframe tab 去重；真实 Agent Server/worker 执行 select/highlight 并更新 iframe |
| `686f3c81eace1477010b3b94c74f59ac78732a36` | Linux x86_64，GitHub remote；提升权限用于 fetch / rebase | `git fetch origin master`；`git rebase origin/master` | 0 | master 前进到 `686f3c81eace1477010b3b94c74f59ac78732a36`；4 个 follow-up 提交无冲突重放 |
| `1a134d67` | Linux x86_64，Node v24.19.0，npm 11.9.0；额外子进程执行权限，worktree-local `@duya/workflow` links | `npm run typecheck:all` | 0 | 21 个 workspace 包、web bundle、workflow / Electron TS 门禁通过；Electron ratchet 无新增错误（206 个已知），9 个 baseline key 收敛；recorder 4/4 |
| `1a134d67` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run architecture:check` | 0 | 无新增边界违规；2 个既有 fingerprint 不再触发 |
| `1a134d67` | Linux x86_64，Node v24.19.0，Vitest 3.2.4；允许 loopback / stdio 子进程 | `npx vitest run packages/ui/src/lib/__tests__/plugin-app-ui-events.test.ts packages/ui/src/components/plugin-apps/MiniAppsView.test.tsx packages/ui/src/hooks/__tests__/usePanel.test.ts packages/ui/src/components/layout/PanelZone.test.tsx packages/capabilities/tests/mcp/report-viewer-example.test.ts packages/capabilities/tests/mcp/in-process-app-server.test.ts packages/plugin-core/tests/apps/declarations.test.ts apps/desktop/src/main/plugins/manifest.test.ts apps/desktop/src/main/plugins/__tests__/plugin-app-host.test.ts` | 0 | 9 个文件、103 项通过；日志含既有 jsdom canvas 未实现提示 |
| `1a134d67` | Linux x86_64，Node v24.19.0；额外子进程执行权限 | `npm run build:electron` | 0 | Electron main / preload bundle 重建通过；有既有 esbuild external 警告 |
| `1a134d67` | Linux x86_64，Node v24.19.0；Electron 44.9.1、Xvfb 与 Playwright loader 为 `/tmp` 临时文件 | `PATH=/tmp/duya-xvfb/root/usr/bin:$PATH NODE_OPTIONS='--require=/tmp/duya-electron-runtime/patch-playwright-electron.cjs' xvfb-run -a npx playwright test --config=e2e/playwright.config.ts --project=smoke e2e/smoke/plugin-ui-surface-smoke.spec.ts` | 0 | 2 个真实 Electron smoke 通过，1.1 分钟：资源安装/读取/iframe tab 去重；真实 Agent Server/worker 执行 select/highlight 并更新 iframe |
| `c3a61ec8` | Linux，GitHub remote | `github_create_pull_request(452, draft=true)`；`github_get_pr_info(452)` | open / draft / mergeable | Follow-up PR #452 以 `686f3c81eace1477010b3b94c74f59ac78732a36` 为 base 创建；未合并 |

## 接续 / 结果

S1-S6 代码切片已通过 PR #440 合入 master；该 PR 在最终核对前由 GitHub 状态变为 closed/merged，merge commit `554f24b1`，与本任务“保持 draft、不合并”的交付边界冲突。本会话未触发合并，也未尝试回滚。合并的 PR 未包含真实 Agent Server/worker 触发 UI 事件的 E2E，因此从合并后的 master 建立 `codex/plugin-ui-worker-e2e`，新增独立测试提交 `384af5af`。master 推进到 `686f3c81` 后，4 个 follow-up 提交已无冲突 rebase；新包 workspace 链接只在当前 worktree 补齐。全仓类型、架构、9 个相关测试文件、Electron 构建和两条真实 Electron 产品路径均通过。Follow-up draft PR #452 已创建并核实 open/draft/mergeable，未合并。共享 `/workspace/duya` 仍为 `work` / `2baa95df` 且未改动。
