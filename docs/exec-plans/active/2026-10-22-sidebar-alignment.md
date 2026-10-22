# 侧栏对齐（桌面端实测基线）

状态：active · 负责人：mavis 会话 `mvs_3a16cab8300945e89691a940d998fbf5` · 更新：2026-10-22
分支：`codex/sidebar-claude-redo` · worktree：`.claude/worktrees/sidebar-claude-redo` · base：`2e6f265d`（最新 master）· owner：mavis

两轮：第一轮对齐 **Codex 桌面端**；第二轮按用户实机截图对齐 **Claude Code 桌面端**（行距 / 默认宽度 / 行内按钮收纳）。

## 目标与边界

用户可观察到的变化：**侧栏整体变紧凑**，会话密度从 10 行/屏提到 20 行/屏，行距与 Claude Code / Codex 桌面端一致。

- **行**：去掉前置状态圆环；状态标记移到行尾；行高 38px → 26px；行距 31px。
- **分组头**：38px → 28px，13px 字号，字距归零。
- **导航区**：行内边距 0.4rem → 0.25rem；侧栏容器 padding/gap 0.95rem → 0.5rem。
- **分组排列**：分组头三个按钮（新建 / 组内搜索 / 过滤器）保留，过滤器浮层沿用「分组方式 / 排序方式 / 显示空分组」。

### 方向变更（用户 2026-10-22 明确）

用户先要求对齐 **Claude Code**，实机对比后改口：**「更喜欢 Codex 的那个一点」**，并逐条点名
「thread 按钮高度 / 右击内容 / 不同 session 分组排列方式 / 显示方式 / 间距」，
随后又要求 **「不要学习 claude 的那个小圆环的 icon 去掉」**。

→ 本轮以 **Codex 桌面端**（`OpenAI.Codex_26.1016.8120.0`，本机 UWP 安装）为基线，
Claude 的前置圆环被明确排除。

允许修改路径：`packages/ui/src/components/layout/**`、`packages/ui/src/components/shared/ThreadListItem.tsx`、`packages/ui/src/styles/sidebar*.css`、`packages/ui/src/i18n/{zh,en}.ts`。
关联：调研记录在 `docs-local/research/claude-desktop-ui/`（不入库）。

### 第二轮反馈（用户 2026-10-22 23:24）

用户给了两张**自己机器上的截图**（Claude Code 侧栏 + duya 侧栏同框），提三条：

1. **「默认宽度太窄了」** —— duya 默认侧栏 260 CSS px，标题被截成「…」。
2. **「不同的 threads 之间文字之间的空隙还是太大了，可以看看这个间距学习一下」**。
3. **「hover 出来的按钮不要 hover 显示了，改动到这个『更多』按钮里面」** —— 行内不该再挂一排图标按钮。

参考基线换成 **Claude Code 桌面端**（用户截图自带，无第二个窗口可抓）。两张用户截图同一张内并排比对，比例一致。

| 指标 | Claude Code 参考（用户截图） | duya 第一轮 | duya 第二轮 |
| --- | --- | --- | --- |
| 文字行距 | 34 物理 px → **27.2 CSS px** | 31 | **27** |
| 选中行高亮块 | 33 物理 px → 26.4 CSS px | 26 | **26** |
| 侧栏宽 | 360 物理 px → ~288 CSS px | 260（默认） | **300**（默认） |
| 行内按钮 | 悬停只出 1 个 ⋮ | 悬停出 2 个（置顶 + ⋮） | **悬停只出 1 个 ⋮** |

> 换算：本机 `deviceScaleFactor=1.25`，用户截图 ÷1.25 得 CSS px。duya 第一轮的 31px 行距在同一张截图里量到 38.7 物理 px，反证换算正确。

## 基线数字（全部来自像素实测，不是目测）

对象：Codex 桌面端窗口位图 `codex-sidebar-full.png`（1453×844 物理像素，
本机 `deviceScaleFactor=1.25` → 除以 1.25 得逻辑像素）。

| 指标 | Codex 实测 | duya 改前 | duya 改后 |
| --- | --- | --- | --- |
| 会话行高 | 26.4 | 38 | **26** |
| 会话行距 | 31.2 | 39.2 | **31** |
| 选中行底色 | `#322B2C` | `#3A2F31` | 沿用 duya 叠加体系 |
| 侧栏底色 | `#20191A` | `#2B1E1F` | 沿用 |
| 前置图标位 | 无 | 有（圆环） | **无** |
| 状态标记位置 | 行尾 | 行首 | **行尾** |
| 分组标题字号 | 13px / 13.6 逻辑 px | 12.5px | **13px** |
| 导航行距 | 33–34（同一张对比图） | 40–42 | **32–33.6** |

> ⚠️ 截图墨迹带测量会**低估行距**（量的是字形顶边，不是行盒）。本轮一度据此误判
> 「gap 从未生效」，实际 `getBoundingClientRect` 读数是 31px。**行距必须用行盒测**。

## 改了什么

| 文件 | 改动 |
| --- | --- |
| `ThreadListItem.tsx` | 去掉前置 `.thread-item-status`；状态标记移入 `.thread-item-actions-default` 行尾槽；`idle` 不渲染任何标记。**第二轮：删掉悬停层的置顶按钮**，`.thread-item-actions-hover` 只剩 ⋮「更多」触发器（置顶本来就已在 ⋮ 菜单里） |
| `sidebar.css` | `.app-sidebar .thread-item` 38→26px、字号 14→13px、圆角 9→6px；hover 预留 52→48px；`.app-sidebar` padding/gap 0.95→0.5rem；`.sidebar-primary-link` / `.sidebar-new-chat-btn` 纵向内边距 0.4→0.25rem、字号 0.9→0.875rem；`.project-group-header` 38→28px；`.thread-list` gap 0→5px；`.project-group-threads` 改 flex column + gap 5px。**第二轮：两处 gap 5→1px（行距 31→27）；hover 预留 48→8px；删掉 `.thread-item-pin-btn` 规则** |
| `sidebar-sections.css` | `.sidebar-section-header` 38→28px、字号→13px、圆角→6px、字距→0；`.sidebar-section-body` 改 flex column + gap 5px。**第二轮：gap 5→1px** |
| `app-shell.tsx` | **第二轮**：`DEFAULT_SIDEBAR_WIDTH` 260 → **300**（MAX 400 / MIN 200 不变） |
| `ThreadListItem.test.tsx` | 状态图标用例改为 Codex 语义：idle 无标记；非 idle 标记在标题之后（`compareDocumentPosition`） |

`.sidebar-section-body` 需要自己的 gap：扁平列表（singleList 模式）的行是它的**直接子元素**，
而 `.thread-list` 这个类实际没有任何组件在用。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `2e6f265d` 干净 | Windows / PowerShell 5.1 | `git worktree add .claude/worktrees/sidebar-claude-redo -b codex/sidebar-claude-redo origin/master` | 0 | worktree 建于最新 master |
| `2e6f265d` 干净 | Windows | `node scripts/junction-worktree.mjs .` | 0 · 62 链接 | worktree 依赖就绪 |
| `2e6f265d` 干净 | Windows | `npm run build:packages` | 0 · 22 包 | `packages/client-core/dist` 缺失会让 vite 报 `Failed to resolve entry for package "@duya/client-core"` |
| dirty | Node 22.22.2 / jsdom | `vitest run .../ThreadListItem.test.tsx .../SectionActions.test.tsx` | 0 · **32/32** | 状态标记 4 例 + 菜单项集 4 例 + SectionActions 8 例 |
| dirty | Node 22.22.2 | `tsc --noEmit -p packages/ui/tsconfig.json` | 0 · 无输出 | UI 包类型干净 |
| dirty | Windows / Electron | `npm run electron:dev`（worktree 内） | vite :3000 · 6 个 electron 进程 | 实机截图 |
| dirty | Windows / CDP | `node docs-local/.../verify-acceptance.mjs` | 行距 31 / 行高 26 / 前置图标 0 | 与 Codex 基线逐项比对 |
| dirty | Windows / CDP | `node docs-local/.../verify-themes.mjs` | 深浅两主题均 行高 26 / 行距 31 / 图标 0 | `duya-light.png` `duya-dark.png` |
| dirty | Windows / CDP | `node docs-local/.../verify-project-mode.mjs` | 按项目分组：嵌套行高 26 / 行距 31 / 分组头 28 | `.project-group-threads` = flex column + gap 5px |
| dirty | Windows / CDP | `node docs-local/.../verify-round2.mjs` | 行距 **27** / 行高 26 / 侧栏宽 **300** / pin 按钮 **0** / 行尾菜单按钮 601 / 前置图标 0 | 对照 Claude Code 参考值 27.2 / 26.4 / ~288 |
| dirty | Windows / CDP | `node docs-local/.../verify-hover-menu.mjs` | 悬停层按钮数 **1**（只有 ⋮）；⋮ 菜单 7 项：置顶 / 重命名 / 复制 ID / 打开目录 / 导出 / 归档 / 删除 | `duya-round2-hover.png` `duya-round2-menu.png` |
| dirty | Node 24.16.0 / jsdom | `vitest run .../ThreadListItem.test.tsx .../SectionActions.test.tsx` | 0 · **32/32** | 第二轮改动后复跑 |

### 实机核对到的行为

- 过滤器浮层：分组头第三颗按钮点开是「分组方式 / 排序方式 / 显示空分组」，子菜单带 ✓，当前值直接显示在行上——与 Codex 的过滤器浮层同形。
- 「在一个列表中」= Codex 的扁平列表形态，实测生效，一屏 20 个会话。
- 深浅两主题行距/行高一致。
- 按项目分组模式：嵌套会话行同样是 **26px 行高 / 31px 行距**，项目分组头 28px；
  跨分组的 126.6px 是「上一组末行 → 下一组首行」跨过分组头的距离，不是行距异常。
- 第二轮：悬停一条会话，**只出现一个 ⋮ 按钮**（原来有两个：置顶 + ⋮）；
  点开 ⋮ 菜单有 7 项，置顶在菜单里，不再单独占一个行内按钮。
- 第二轮：标题可用宽度从 149px 涨到 **189px**（侧栏 260→300），实测不再截断。

## 环境坑（记录用）

1. `ELECTRON_RUN_AS_NODE=1` 会让 electron 以 node 模式跑 ⇒ 主进程 `app` 为 `undefined`。必须清掉该变量。
2. `:3000` 被别的工作树占用时，`--strictPort` 直接失败 → 先释放 3000。
3. **CDP 要走 `concurrently -k "vite ..." "wait-on ... && electron . --remote-debugging-port=9222"`**，
   直接 `node node_modules/electron/cli.js . --remote-debugging-port=9222` 会让 GPU 进程反复 `0xC0000005` 崩溃。
4. `npm run electron:dev` 被 bash 后台任务托管时，任务超时（1800s）会连带杀掉 electron。
   用 `Start-Process cmd /c` 脱离任务生命周期。
5. CDP 连上后默认停在 **Bots 标签**，侧栏没有 `.thread-item` —— 测量前先点「工作」标签。
6. **vite 的文件 watcher 在 `.claude/worktrees/**` 下不触发**（隐藏目录）—— 改完 CSS 后
   `page.reload()` 拿到的还是旧样式，必须重启 vite + electron 才生效。第一轮验证时因此读到
   「gap 还是 5px」的假象。
7. **`Stop-Process -Force` 强杀 electron 会丢 `~/.duya/duya-main.db` 里的
   `sidebar_sections` / `sidebar_section_projects` 行**（会话数据在 `duya-core.db`，未丢）。
   表现是侧栏「暂无项目」。用 app 自己的 IPC 重建即可：
   `window.electronAPI.sidebarSections.create({name:'项目'})` + `assignProject(id, wd)`，
   工作目录取自 `window.electronAPI.project.getGroups()`。
8. **窗口最小化时 `PrintWindow` 抓到的是全黑图**，不是空白。截图前先
   `computer_app_activate` 把窗口拉回前台。
9. Electron 里 `page.screenshot()` 会卡到超时 —— 用 `capture-window.ps1`（PrintWindow）抓窗，
   再用 PIL 裁侧栏。

## 接续 / 结果

两轮改动都已落地：第二轮在第一轮基础上把行距 31→27、默认侧栏宽 260→300、
行内按钮从「置顶 + ⋮」收成只剩「⋯ 更多」。

下一步：

1. PR #366 待审，**未获授权不合并**。
2. 未做：把导航从 5 项收敛到 Claude 的 2 项 + 「更多」（属产品决策，本轮不动功能）。
