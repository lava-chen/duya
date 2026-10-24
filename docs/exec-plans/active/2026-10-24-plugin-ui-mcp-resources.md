# 插件 UI 通过 MCP resources/read 加载

状态：active · 负责人：Codex `/root` 会话 · 更新：2026-10-24
分支：`codex/plugin-ui-mcp-resources` · worktree：`.claude/worktrees/plugin-ui-mcp-resources` · 初始 base：`21351df668adefc0357741a5f79a1513e297df61` · 最新 rebase base：`40787b394d08207ed78c863d9c78dc413a9d1038` · S1：`c79f9122` · S2：`2865357c` · S3：`a1b46a5e` · S4：`af8cc9aa` · S5：`ca3fa154` · S6：`b76776c5` · owner：`/root`

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
- [~] S4 UI 入口已提交：插件应用区与侧栏 tab 渲染 surface，按会话可用性隐藏入口；UI 类型检查和目录/面板测试通过。真实 Electron UI 链路验证待有 Electron 二进制与显示服务的环境补跑。
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
- S4 真实桌面 UI 验证受环境限制：`node_modules/electron/dist/electron` 不存在，`require('electron')` 尝试下载二进制但网络 fetch 失败，且没有 `Xvfb` / `xvfb-run`；未用 mock 替代 IPC/worker 链路验收。继续切片，最终仍需在具备 Electron 和显示服务的环境完成真实产品路径验证。

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

## 接续 / 结果

S1-S6 代码切片依次重放为 `c79f9122`、`2865357c`、`a1b46a5e`、`af8cc9aa`、`ca3fa154`、`b76776c5`；每个切片的进度文档也各自独立提交。分支已 rebase 到最新 `origin/master` `40787b394d08207ed78c863d9c78dc413a9d1038`，第二次 rebase 后全仓类型检查、架构检查、9 个相关测试文件与 Electron main/preload 构建均通过。Draft PR #440 已同步任务分支，base 与最新 master 一致，仍为 open/draft/mergeable 且未合并。共享 `/workspace/duya` 仍为 `work` / `2baa95df` 且干净。

下一步：在具备 Electron 二进制与显示服务的环境运行真实产品 UI/IPC/worker smoke；当前 PR 保持 draft 并记录该验收阻塞，不合并。
