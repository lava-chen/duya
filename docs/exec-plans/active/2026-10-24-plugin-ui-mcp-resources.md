# 插件 UI 通过 MCP resources/read 加载

状态：active · 负责人：Codex `/root` 会话 · 更新：2026-10-24
分支：`codex/plugin-ui-mcp-resources` · worktree：`.claude/worktrees/plugin-ui-mcp-resources` · base：`21351df668adefc0357741a5f79a1513e297df61` · S2：`da8f56bbf3a92e520144d32260bdbfc6a091ab1f` · S3：`27a60f22809737dd26bffac748aeb7b3534f17d5` · owner：`/root`

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
- [ ] S4 UI 入口：插件应用区与侧栏 tab 渲染 surface，复用安装/启用进度及失败提示；按会话可用性隐藏入口。
- [ ] S5 双向通道：保留 guest→host invoke，新增 host→guest `select` / `highlight` / `refresh`，仅寻址当前 launch 的 surface。
- [ ] S6 示例与兼容：迁移一个纯查看型示例插件，并用静态 entry 插件回归。

## 发现与决策

- `origin/master` 基线为 `21351df668adefc0357741a5f79a1513e297df61`；旧 `work` 检出为 `2baa95df`，保持未修改。
- 当前 master 将架构入口放在 `docs/architecture/ARCHITECTURE.md`；`docs/exec-plans/README.md` 没有根规则旧版本提到的 “Verified baseline” 小节，基线将按本次工作重新测量。
- `.codegraph/` 与 CodeGraph 工具均不可用；代码定位通过 `rg` 和源码交叉核对。
- S1 将双语标题固定为当前产品的 `en` / `zh`；surface 位于 `apps[].ui.surfaces`，静态 `entry`、resource-only surface、两者并存均可声明。Desktop 三种 manifest 路径都把 surface 的 `server` 绑定到该插件实际声明的 `mcpServers`。
- worktree 链接脚本读取了旧共享检出的 workspace 列表，缺少 master 新增包；仅在任务 worktree 补齐 `packages/` 与 `apps/` 的当前 master overlay。锁文件有 `@types/picomatch@4.0.3`，共享依赖目录缺失；包安装在 `/tmp` 并从 worktree overlay 引用，未写入共享依赖目录。
- 完整 `electron:build` 需要下载 ripgrep 与 Electron 二进制；下载失败。共享 `node_modules/electron` 无二进制且未被修改；单独执行仓库 main/preload bundle 构建成功。
- 当前上下文未提供 Playwright MCP 工具，完整 Electron 二进制也未下载；surface 的真实应用 UI 验收记录在 S4/S6，不在 S1 声称完成。
- 参考官方 `zai-org/ZCode` 开源仓库（浅克隆 SHA `3c5b227649371507ddc4eb46ac5133afe6db1cab`）：`plugins/listUiSurfaces` 是与 tab 状态分离的只读目录投影，仅返回启用插件的 surface；本任务采用目录投影与资源归属检查的经验，不引入其 MCP Apps 页面 API、工具注册、订阅或 widgetState 协议。
- S2 从已安装 Plugin App 声明生成独立只读 surface 目录；跨已安装插件重复 ID 全部隔离并返回 owner 冲突，目录仅提供启用插件的唯一 surface。安装、启用、停用、卸载和设置变化复用既有 `plugin-app:changed` 事件供目录消费者刷新。
- S3 经现有 MCP SDK `Client.readResource` 加载 surface：活动会话 worker 存活时复用其 MCPManager，并以 worker 身份与 generation 复核响应；无 worker 或 standalone/always 入口通过同一 MCPManager 实现短连接读取，仅连接 manifest 声明的 server。worker 和 Main 都要求 server `source=plugin`、插件归属匹配、资源 URI 完全匹配、唯一文本 `text/html` 内容且不超过 8 MiB。Main 将已校验 HTML 挂到随机 token 的 loopback `/index.html` 单文档路由；该 mount 不提供包内静态资源，文档 CSP 禁止网络连接，沿用既有 launch nonce 与 opaque-origin iframe。静态 `entry` 路径保持原样。

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

## 接续 / 结果

S1 契约与 manifest reader 已提交，代码切片提交为 `d426cd4ee8382f6aec941ce19ac87f5a91b73eb2`。S2 directory builder、IPC 和 preload list API 已提交于 `da8f56bbf3a92e520144d32260bdbfc6a091ab1f`。S3 MCP resource loader、worker bridge、tokenized loopback document mount 与架构说明已提交于 `27a60f22809737dd26bffac748aeb7b3534f17d5`。共享 `/workspace/duya` 仍为 `work` / `2baa95df` 且干净。

下一步：推进 S4 插件应用区入口、侧栏 tab 呈现、同 surface 单 tab 复用、session availability 隐藏和用户可见错误提示。
