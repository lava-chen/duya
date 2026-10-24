# 插件 UI 通过 MCP resources/read 加载

状态：active · 负责人：Codex `/root` 会话 · 更新：2026-10-24
分支：`codex/plugin-ui-mcp-resources` · worktree：`.claude/worktrees/plugin-ui-mcp-resources` · base：`21351df668adefc0357741a5f79a1513e297df61` · owner：`/root`

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
- [ ] S2 发现与目录：投影到已安装插件目录，拒绝跨插件同名 surface，安装态变化刷新目录。
- [ ] S3 宿主资源解析：调用 MCP `resources/read`，校验 MIME、大小、来源 server，再通过现有文档通道签发 token 与 nonce。
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

## 接续 / 结果

S1 契约与 manifest reader 已提交，代码切片提交为 `d426cd4ee8382f6aec941ce19ac87f5a91b73eb2`。完整 `electron:build` 因官方资源下载失败未通过，但 `node scripts/build-electron.mjs` 已重编 main/preload bundle。共享 `/workspace/duya` 仍为 `work` / `2baa95df` 且干净。

下一步：向用户报告 S1 契约 diff、受影响调用方及验证记录；得到接续后从 S2 发现与目录切片开始。
