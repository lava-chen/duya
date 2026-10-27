# 新建对话页布局对齐 Claude 桌面端

状态：active · 负责人：mavis 会话 `mvs_4801746c549f4c79a14713731e351b20` · 更新：2026-10-27
分支：`codex/new-chat-layout` · worktree：`.claude/worktrees/new-chat-layout` · base：`d80ca3c6`（master）· owner：mavis

## 目标与边界

用户可观察到的变化：**新建对话页删掉最近会话列表**，中部出现常驻的环境选择卡（路径输入框 · 项目行 · 「选择环境」下拉），标题保留 duya 问候语，输入框吸底。

- 允许修改：`packages/ui/src/components/home/**`、`packages/ui/src/components/chat/{NewChatView,ChatView}.tsx`、`packages/ui/src/styles/welcome.css`、`packages/ui/src/i18n/{zh,en}.ts`
- 不涉及：侧栏、会话数据、Host / IPC 契约
- 基线：Claude Code 桌面端 3.6556.2.0「New session」页截图
- 与侧栏对齐计划无交集，故单开计划（master 上的侧栏计划只到第二轮，第六轮记录在未合并的 `codex/ui-adjust` 分支）

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `home/EnvironmentCard.tsx` | 新增：路径输入框 · 项目行 · 1px 分隔线 · 「选择环境」Disclosure；回车提交路径 |
| `home/SessionSelector.tsx` | 删最近会话列表组件（props / CSS / i18n 一并删） |
| `chat/NewChatView.tsx` | 三段式布局：`.new-chat-title` → `.new-chat-environment` → `.new-chat-composer` |
| `chat/ChatView.tsx`、`home/WelcomeView.tsx` | 去掉 `onSelectThread` 传参与随之无用的回调 |
| `styles/welcome.css` | 新增 `.new-chat-*` / `.environment-card-*`；删 `.welcome-recent` / `.recent-*` |
| `i18n/{zh,en}.ts` | 删 `chat.recentThreads`；加 `chat.chooseEnvironment` / `chat.workingDirectory` / `chat.workspaceInherited` |

## 验收

- `npx tsc --noEmit -p packages/ui/tsconfig.json` → 0
- `npx vitest run packages/ui/src` → 0
- `npm run architecture:check` → 0
- 真机：卡片几何对齐 Claude；`.welcome-recent` 不存在；路径回车可切换项目；「选择环境」可展开

## 进度

- [x] 像素量 Claude 基线（卡片 / 药丸 / 标题）
- [x] 删最近会话列表（组件 + props + CSS + i18n）
- [x] 环境卡 + 三段式布局
- [x] 路径输入框回车提交
- [x] UI 门禁 + 架构门禁 + 真机 CDP 验证
- [x] 全量 `npx vitest run` 与 `npm run typecheck:all`
- [x] commit（未获授权，不 push、不开 PR）

## 发现与决策

- **环境选择器落地为常驻居中卡片**（用户 2026-10-27 明确选择），不是弹层。
- **标题保留 duya 问候语**（用户明确选择），位置对齐 Claude 左上角标题。
- **最近会话列表整体删除**：侧栏已列会话，页内再列一份是重复。
- 卡片在环境中段 flex 居中，而不是写死 `padding-top`：写死的偏移在更高的窗口上会让卡片相对位置上移（812px 高时占 44%，1000px 高时只剩 36%）；居中后稳定在 44–45%。
- 颜色走 duya 主题令牌（`--surface` / `--border` / `--muted`），只把几何尺寸取自 Claude 实测；Claude 的绝对色值仅作深色主题核对。
- 路径输入框回车提交：命中已知项目则切换，否则 `addProjectFolder` 注册为新项目；失焦不提交（避免误注册目录），提交后主动失焦，让长路径从头显示。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d80ca3c6` 干净 | Windows / PS 5.1 | `git worktree add .claude/worktrees/new-chat-layout -b codex/new-chat-layout origin/master` | 0 | base = master `d80ca3c6` |
| dirty | Node / jsdom | `npx tsc --noEmit -p packages/ui/tsconfig.json` | 0 | UI 包类型干净 |
| dirty | Node / jsdom | `npx vitest run packages/ui/src` | 0 · 233 文件 | UI 包全过 |
| dirty | Node / jsdom | `npx vitest run .../new-chat-view-layout.test.tsx` | 0 · 8/8 | 三段顺序 / 问候语 / 卡片 / 路径 / disclosure / 最近列表已消失 / 两条回车提交分支 |
| dirty | Windows | `npm run architecture:check` | 0 | no new boundary violations |
| dirty | Windows | `npm run typecheck:all` | 0 | 全量类型门禁通过 |
| dirty | Node / jsdom | `npx vitest run`（全量 1271 文件） | 2 失败 / 1266 过 / 3 跳过 | 失败全是 30s 超时，单独复跑均通过（见下） |
| dirty | Windows | `npm run build:packages` | 0 · 21 包 | 新 worktree 缺 dist 会让 10 个 suite 报 resolve entry 失败 |
| dirty | Windows / Electron + CDP | `node docs-local/.../measure-duya-new-chat.mjs 9223` | 卡片 **312×111**（Claude 311×112）· 顶偏移 **307**（Claude 307）· 标题 **11px**（Claude 10.8）· 药丸 **28px** · 卡片中心 44.6%（Claude 44%）· `recentExists: false` | 截图 `duya-new-chat.png` |
| dirty | Windows / Electron + CDP | `node docs-local/.../verify-path-commit.mjs 9223` | 回车后项目从 `tui-polish` 切到 `duya`，输入框已失焦（`scrollLeft: 0`，路径从头显示） | 提交确实执行（blur 只在 commitPath 里调用） |
| dirty | Windows / Electron + CDP | `node docs-local/.../verify-environment-menu.mjs 9223` | 下拉展开：搜索框 + 11 个项目 + 3 个动作，菜单 392×362 | 截图 `duya-environment-menu.png` |

## 接续 / 结果

已实现 + 已验证（真机几何与交互），门禁通过，改动已提交。

### 全量测试的基线失败

全量 `npx vitest run` 在本机会出现 **30s 超时**，且失败文件身份每次都变。取样：

| 场景 | 结果 |
| --- | --- |
| 带改动，负载高 | 4 / 6 / 6 个 host 文件超时 |
| 干净基线（stash），同批文件 | 6/6 通过 |
| 带改动，同两个文件连跑 2 次 | 2/2 通过 |
| 带改动，安静环境全量 | 2 个文件超时（`browser-closure-gate`、`coalescing-throughput`，与前几轮完全不同） |
| 上面 2 个文件单独跑 | 2/2 通过，19s（负载下分别 41s / 67s） |

判据：

1. 失败签名全是 `Test timed out in 30000ms`，**没有断言失败**；`vitest-worker: Timeout calling "onTaskUpdate"` 说明 worker 本身被饿死。
2. `packages/host` 对 `packages/ui` **零依赖**（依赖表里没有 `@duya/ui`），改动无法传导。
3. `browser-closure-gate` 的 G10 用例基线 **9.738s**、带改动 **9.674s**，没有变慢——它只是全量负载下从 9.7s 涨到 41s 越过 30s 上限。

→ 判定为本机 Windows 上 git worktree / worker 派生相关的时序抖动，与本次改动无关。

下一步：走 PR 流程等 review 与集成授权；本分支不 push、不自行合并。

### 环境坑

1. 参考图附件扩展名 `.png` 但签名是 JPEG，必须用 `sharp` 解码。
2. `vite.config.ts` 的 `server.watch.ignored` 含 `**/.claude/**`，worktree 位于 `.claude/worktrees/**` → 改 TSX / CSS 必须**重启 vite**，`location.reload()` 不够。
3. `Page.captureScreenshot` 要先 `Page.bringToFront` 再等 600ms，否则抓到空白。
4. `window.electronAPI.project.getGroups()` 返回 snake_case（`working_directory` / `project_name`），不是驼峰。
5. **CDP 的键盘事件送不到后台 Electron 窗口**：`Input.dispatchKeyEvent` 之后输入框上的 keydown 监听器一条都没收到。鼠标事件正常。验证键盘交互要在元素上 `dispatchEvent(new KeyboardEvent(...))`。
6. **截图可能拿到陈旧帧**：DOM 已经是新页面时，`captureScreenshot` 仍可能返回上一帧（实测抓到 Bots 空态）。`bringToFront` + 600ms 不够，要先强制重绘（改一个影响布局的属性再读 `offsetHeight`）并等 1.5s。**判断渲染结果一律以 CDP 计算样式和像素采样为准，截图只作佐证。**
7. 测「输入框是否失焦」是判定提交逻辑是否执行的好探针——`blur()` 只在 `commitPath` 里调用。
