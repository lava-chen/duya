# 侧栏对齐 Claude Code（Code 桌面端）

状态：active · 负责人：mavis 会话 `mvs_7251e193622240c18deeb19f1988120f` · 更新：2026-10-22
分支：`codex/sidebar-align` · worktree：`.claude/worktrees/sidebar-align` · base：`96dadf4d` · owner：mavis

## 目标与边界

用户可观察到的变化：侧栏的"行的语言"和"分组头的形态"对齐 Claude Code。

- **行**：左侧统一状态图标位（idle / 运行中 / 失败）；`⋮` 改为 hover 显形；可访问名逐行唯一（`<标题> 的更多选项`）；菜单项集对齐 Claude。
- **分组头**：名称 + 三个 22×22 按钮（新建会话 / 组内搜索 / 过滤器）。过滤器浮层改为"带当前值的子菜单 + 两个开关"，并把现有 `⋯` 的整理 / 排序并入。
- **组内搜索**：只过滤当前分组，不与 Cmd+K 全局调色板混用。
- **视觉**：保留 duya 玻璃拟态，只调对比度、字号与间距。

本轮明确不做（用户 2026-10-22 确认）：

| 不做项 | 原因 |
| --- | --- |
| 底部账号行 / 更新条 | 保留 duya 原样（扩展 / 设置 / 主题切换） |
| 会话分叉 | 留待 worktree 管理阶段一并实现 |
| 标记为未读 | 需新增持久化状态，一并后置 |
| 分组语义改造（仓库提到一级） | 要动 DB 与 `section-system`，另行评估 |
| 分割视图 / Cursor / VS Code / Zed / 资源管理器 | Claude 生态专属；duya 改为"在面板中打开 / 在新窗口中打开" |

允许修改路径：`packages/ui/src/components/layout/**`、`packages/ui/src/components/shared/ThreadListItem.tsx`、`packages/ui/src/styles/sidebar*.css`、`packages/ui/src/i18n/{zh,en}.ts`。
关联：调研记录在 `docs-local/research/claude-desktop-ui/`（不入库）；面板体系改造是另一切片，本 PR 不含。

## 验收

1. `npm run typecheck:all` 与 `npm run architecture:check` 退出码 0。
2. `npx vitest run packages/ui/src/components/shared/ThreadListItem.test.tsx` 通过，且新增断言覆盖状态图标位与菜单项集。
3. Playwright MCP 真跑 renderer：截图侧栏（深 / 浅各一），断言分组头三个按钮存在、会话行 `⋮` hover 显形、菜单项与快捷键文案对齐、`aria-label` 逐行唯一。
4. 手动核对：分组头过滤器浮层的"分组方式 / 排序方式"对当前分组生效（不只是项目分区）。

## 进度

- [x] 建独立 worktree + workspace junction（62 链接），`git status` 干净
- [x] P1 行级：状态图标位 + hover `⋮` + 菜单项集 + 可访问名
- [x] P2 分组头：三按钮 + 过滤器浮层（`SectionActions`，取代旧 `⋯ +`）
- [x] P3 组内搜索（每个分组独立 query，Esc 关闭）
- [x] P5 视觉：分组头字号/颜色、搜索框、菜单当前值
- [ ] 实机核对（electron dev 已起，见验证记录）
- [ ] P0 基线截图：**未做**。本会话没有 Playwright MCP，改为实机 electron dev 目视核对；基线截图留待有 MCP 时补
- [ ] 验证与 PR

## 发现与决策

- `DropdownMenu` 已支持 `submenu` / `checkbox` / `divider` / `section`，子菜单走 portal 浮层 → 过滤器浮层不需要新组件。
- duya 已有 `ProjectGroupBy`（按项目 / 在一个列表中）与 `ProjectSortBy`（三种排序）→ Claude 过滤器的"分组方式 / 排序方式"是**已有能力换入口与作用域**，不是新功能。
- `Thread` 接口无 `status` 字段（`packages/ui/src/stores/conversation-store.ts:38`）→ 状态图标只能在 renderer 侧派生，不落库。
- Claude 截图是 1.3× 缩放裁剪图 → 颜色与像素一律以 `report.md` 的采样值为准（侧边栏 269px、`#111111`、选中 `#363636`）。
- duya 侧栏默认宽 260px、可拖（`app-shell.tsx:28`），折叠 rail 56px → 本轮不改默认值。

### 收尾轮修掉的四个缺陷（2026-10-22 晚）

| 缺陷 | 位置 | 后果 |
| --- | --- | --- |
| 行的单键命令没有 `e.target !== e.currentTarget` 守卫 | `ThreadListItem.tsx` onKeyDown | 行内重命名输入框的按键会冒泡到行，改名打到 `d` 就删会话 |
| `showEmptyGroups` 的补全块写在 `userSectionDescriptors` / `unassignedGroups` 之后 | `app-sidebar.tsx` sidebarStructure | 空项目写进 `allProjectGroups` 时两个数组已算完 → 开关点了没用（死功能） |
| 状态图标优先级 `running > awaiting` | `ThreadListItem.tsx` sessionStatus | `awaiting_permission` 本身是 active phase → 琥珀点在授权等待时永不出现 |
| 组内搜索框渲染在行列表之后、且折叠时仍显示 | `SidebarSectionItem.tsx` | 搜索框出现在自己的结果下面（读起来像 footer） |

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `96dadf4d` 干净 | Windows / PowerShell 5.1 | `node scripts/junction-worktree.mjs .` | 0 · 62 链接 | worktree `git status` 干净 |
| dirty（10 改 3 新） | Node 22.22.2 | `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.json` | 0 · 无输出 | 根 tsconfig 覆盖 `packages/ui` |
| dirty | Node 22.22.2 / jsdom | `vitest run packages/ui/src/components/shared/ThreadListItem.test.tsx` | 0 · 24/24 | 新增状态图标 4 例 + 菜单项集 4 例 |
| dirty | Node 22.22.2 / jsdom | `vitest run packages/ui/src/components/layout/sidebar/SectionActions.test.tsx` | 0 · 8/8 | 新增组件首测：按钮按能力出现、过滤行显示当前值、开关写回下一值 |
| dirty | Windows / Electron | `npm run electron:dev`（worktree 内） | 进程存活、vite :3000、**0 条 GPU 报错** | `tasklist` 6 个 electron 进程 |

启动 electron dev 的两个环境坑（记录用）：

1. 本会话环境带 `ELECTRON_RUN_AS_NODE=1`（agent 自身是 Electron 应用）⇒ electron 以 node 模式跑，主进程 `app` 为 `undefined`，报 `Cannot read properties of undefined (reading 'getPath')`。必须 `env -u ELECTRON_RUN_AS_NODE`。
2. 用 `node node_modules/electron/cli.js . --remote-debugging-port=9222` 直连 CDP 时 GPU 进程反复 `0xC0000005` 崩溃直至 `GPU process isn't usable`（加 `--disable-gpu` 无效），而 `npm run electron:dev` 同一棵树 0 报错 ⇒ 需要 CDP 时不能用这条路径。
3. `:3000` 被 `panel-layout-columns` worktree 的孤儿 vite 占用且 `--strictPort` + 端口探测顺序 3000→3005 ⇒ 会连到别的工作树，必须先释放 3000（本轮已获用户授权结束该进程）。


## 接续 / 结果

代码侧 P1／P2／P3／P5 已落地并通过 typecheck + 26 条单测；electron dev 已在本 worktree 起来（vite :3000 + 6 个 electron 进程）。

下一步：

1. 实机上点一遍：分组头三个按钮（`+` / 🔍 / 过滤器）、行内 `⋮` hover、行右键菜单顺序与 P/R/A/D、组内搜索只影响本组、过滤器"显示空分组"真的多出空项目。
2. 视核对结果决定是否需要 P0 基线截图（需 Playwright MCP）。
3. `npm run architecture:check` 与 `npm run typecheck:all` 通过后开 PR（未获授权不合并）。

