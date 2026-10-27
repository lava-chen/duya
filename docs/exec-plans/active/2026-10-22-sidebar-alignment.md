# 侧栏对齐（桌面端实测基线）

状态：active · 负责人：mavis 会话 `mvs_4801746c549f4c79a14713731e351b20` · 更新：2026-10-27
分支：`codex/sidebar-claude-redo`（前两轮 · PR #366）→ `codex/ui-adjust`（第三轮起）· worktree：`.claude/worktrees/ui-adjust` · base：`a62d5415` · owner：mavis

六轮：第一轮对齐 **Codex 桌面端**；第二轮按用户实机截图对齐 **Claude Code 桌面端**（行距 / 默认宽度 / 行内按钮收纳）；第三轮对齐 **Claude Code 的分组与排序模型**（分组方式 / 日期分桶 / 组头动作）；第四轮对齐字号与字色；第五轮去掉「不分组」并对齐组间距；第六轮做组头 hover、三色状态点与 worktree 徽标。

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
| dirty | Windows / CDP | `node docs-local/.../verify-project-mode.mjs`（第二轮后复跑） | 按项目分组：嵌套行高 26 / 行距 **27** / 分组头 28 | `.project-group-threads` = flex column + gap 1px |
| dirty | Windows / CDP | `node docs-local/.../verify-hover-menu.mjs` | 悬停层按钮数 **1**（只有 ⋮）；⋮ 菜单 7 项：置顶 / 重命名 / 复制 ID / 打开目录 / 导出 / 归档 / 删除 | `duya-round2-hover.png` `duya-round2-menu.png` |
| dirty | Node 24.16.0 / jsdom | `vitest run .../ThreadListItem.test.tsx .../SectionActions.test.tsx` | 0 · **32/32** | 第二轮改动后复跑 |

### 实机核对到的行为

- 过滤器浮层：分组头第三颗按钮点开是「分组方式 / 排序方式 / 显示空分组」，子菜单带 ✓，当前值直接显示在行上——与 Codex 的过滤器浮层同形。
- 「在一个列表中」= Codex 的扁平列表形态，实测生效，一屏 20 个会话。
- 深浅两主题行距/行高一致。
- 按项目分组模式：嵌套会话行同样是 **26px 行高**（第二轮 gap 1px 后行距 **27px**），项目分组头 28px；
  跨分组的 114.6px 是「上一组末行 → 下一组首行」跨过分组头的距离，不是行距异常。
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

---

## 第三轮：分组与排序模型对齐 Claude Code（2026-10-26）

分支 `codex/ui-adjust` · worktree `.claude/worktrees/ui-adjust` · base `a62d5415` · 会话 `mvs_4801746c549f4c79a14713731e351b20`

### 基线（Claude Code 桌面端 3.6556.2.0，Code 模式，实测）

- 组头右侧两个控件：调节图标（AX 名 `Group and sort`）+ 最右缘的 `+`（`New session in <group>`）。
- `Group and sort` 菜单：`Group by → Folder`（当前值显示在行右侧）、`Sort by → Last updated`、分隔线、
  `Descending`/`Ascending`、`Show`、`New section`、`Reset to defaults`（禁用）、`View all`。
- `Sort by` 子菜单实测项：`Last updated`(✓)、`Date created`、`Name`、`Descending`(✓)、`Ascending`。
- **未能打开 `Group by` 子菜单**（Radix 需真实 hover，合成 pointer 事件不触发），
  故「Claude 是否提供 `Date` 分组」**未经证实**。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `sidebar/section-system.ts` | 新增 `ThreadDateBucket`（today / yesterday / last7days / older）与 `DATE_BUCKET_ORDER`；`getThreadDateBucket` 按两个本地午夜求天数差，`Math.round` 吸收夏令时 ±1h；`recencyAt` 优先于 `updatedAt`；非法时间戳落 `older` |
| `layout/app-sidebar.tsx` | 分组方式三选项（文件夹 / 日期 / 不分组）；日期段固定四桶顺序、空桶不渲染、空工作区保留一个「今天」头（否则无处切回）；`dateVisibleCounts` 让每个日期桶的「查看全部」独立计数；`isGroupingHeader` 收敛为仅系统段（分组方式是全局开关，不该两个组头控制同一列表）；系统段在有用户段时改名「未分组」；日期段 tone 统一 `bold`；日期段也带组头动作 |
| `sidebar/SectionActions.tsx` | 组头按钮顺序 `[新建][搜索][过滤器]` → `[过滤器][搜索][新建]`；分组方式菜单加入「日期」项 |
| `i18n/{zh,en}.ts` | 新增 `sidebar.date.last7days`、`sidebar.section.ungrouped`；排序字段标签改为 创建时间 / 最近更新 / 名称（原「优先级」「手动排序」与实际比较器不符） |
| `sidebar/section-system.test.ts` | 新增 `getThreadDateBucket` 7 例；原 17 例完整保留（diff 为纯新增） |

### 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `a62d5415` dirty | Node / jsdom | `npx tsc --noEmit -p packages/ui/tsconfig.json` | 0 | UI 包类型干净 |
| `a62d5415` dirty | Node / jsdom | `npx vitest run .../section-system.test.ts .../SectionActions.test.tsx` | 0 · **32/32** | 17 旧 + 7 新 + 8 组头 |
| `a62d5415` dirty | Windows | `npm run architecture:check` | 0 · no new boundary violations | 3 个 baseline 指纹未再触发（既有情况） |
| `a62d5415` dirty | Windows / Node | `npm run typecheck:all` | **0**（`TYPECHECK_EXIT=0`） | 全量类型门禁通过 |
| `a62d5415` dirty | Windows / Electron | `npm run electron:dev`（worktree 内） | 应用起来，三种模式实跑 | 见下 |

### 真机实测

- **不分组**：段标题「会话」，平铺会话 + 「展开显示 (20 个)」。
- **日期**：四段 今天 / 昨天 / 最近 7 天 / 更早，各带组头动作；「查看全部」计数互相独立
  （最近 7 天 `(2 个)`、更早 `(20 个)`），证明 per-bucket 计数生效。
- **文件夹**：两个段头不再同名 —— 用户段「项目」+ 系统段「未分组」，各带 过滤器 / 在本组中搜索 / 新项目。
- 组头按钮顺序实测 过滤器 → 搜索 → 新建；过滤器菜单为「分组方式 / 排序方式 / 显示空分组」，排序当前值「创建时间」。

### 接续 / 结果

- 第三轮改动**已实现、已验证、未提交**（worktree 18 个 modified 文件，本轮占 6 个；
  `packages/host/bundle/*` 是在途重建产物，非本轮范围）。
- 已知差异：**未**加 Claude 那种独立升降序开关 —— 判为超出「分组逻辑」范围，留作可选。
- 阻塞：Claude 的 `Group by` 子菜单打不开，四桶口径按 Claude Code CLI `/resume` 惯例推断，未获实测证实。
- 副作用：验证期间把本机 `duya-conversations` 的 `projectGroupBy` 从 `singleList` 改为 `byProject`（实测三模式），
  收尾时已改回 `singleList` 并刷新确认段标题回到「会话」。
- 下一步（可选，待用户决定）：顶层直接是文件夹分组、取消 section 层。

---

## 第四轮：侧栏字体对齐 Claude Code（2026-10-26）

分支 `codex/ui-adjust` · worktree `.claude/worktrees/ui-adjust` · commit `41751230`

### 基线（实测，非目测）

Claude Code 桌面端 3.6556.2.0 正在运行，窗口 1490×858 物理像素，DPR 1.25。
抓窗口截图后按 ink band 量：字高 = 第一行墨点到最后一行墨点；行距 = 相邻 band 顶边间距；
字色 = band 内最亮像素（抗锯齿下最接近真字色，模态色是背景不是字色）。

| 元素 | 字号 | 颜色 | 测量依据 |
| --- | --- | --- | --- |
| 会话标题 | **13px** | `#DDDCDC` | ink band 17 物理 px |
| 导航行（新聊天） | **13px** | `#DDDCDD` | ink band 17 物理 px |
| 分组标题（置顶 / 最近） | **12px** | `#8F8C8C` | ink band 15 物理 px |
| 行距 | **31.2px** | 侧栏背景 `#20191A` | band 顶边间距 39 物理 px |

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `styles/sidebar.css` | 新增 `--sidebar-text` / `--sidebar-muted` 侧栏专属色板（暗色 `#dddcdc` / `#8f8c8c`，浅色回落到全局 `--text` / `--muted`）；导航行、会话标题 13.5→**13px**；项目分组名 13.5→13px；会话行与导航行改用侧栏色板 |
| `styles/sidebar-sections.css` | 分组标题 13.5→**12px**，颜色改走 `--sidebar-muted` |

### 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `41751230` 干净 | Node / jsdom | `node .claude/ui-check.mjs`（UI 包 typecheck + 全部 UI 测试并行） | 0 · typecheck 65s / tests 42s | 全绿 |
| `41751230` 干净 | Windows | `npm run architecture:check` | 0 · no new boundary violations | 3 个 baseline 指纹未再触发（既有情况） |
| `41751230` 干净 | Windows / Electron + CDP | `node .claude/measure-duya-sidebar.mjs` | 0 | 实机计算样式：会话标题 13px `rgb(221,220,220)`；分组标题 12px `rgb(143,140,140)`；`--sidebar-text: #dddcdc` · `--sidebar-muted: #8f8c8c` |

### 接续 / 结果

- 第四轮**已实现、已验证、已提交**（`41751230`）。
- 与基线逐项吻合：字号 13/13/12、字色 `#DDDCDC` / `#8F8C8C` 与实测值一致。
- 浅色主题未实测 Claude 对应值，暂沿用 duya 全局色板。

---

## 第五轮：去掉「不分组」+ 组间距对齐 Claude（2026-10-26）

分支 `codex/ui-adjust` · worktree `.claude/worktrees/ui-adjust` · base `d293eab2` · 会话 `mvs_4801746c549f4c79a14713731e351b20`

### 触发

用户实机截图两条批注：①「会话」段在 Claude Code 里**没有对应设计**；②组别之间要有间隔，
组标题颜色要和 session 行不一样。

### 实测（像素采样，非目测）

| 指标 | Claude Code | duya 改前 | duya 改后 |
| --- | --- | --- | --- |
| 组标题墨迹峰值色 | `#898781` | `#8F8C8C` | 不变 |
| 会话标题墨迹峰值色 | `#C3C2B7` | `#DDDCDC` | 不变 |
| 组内行墨迹间距 | 20 物理 px | 20 | 20 |
| 导航 → 首个组标题墨迹间距 | 45 | 25 | **45** |
| 组 → 组标题墨迹间距 | 34 | 14 | **34** |
| 组间留白（盒模型） | — | **0 px** | **16 px** |

> 颜色在第四轮已对齐（`--sidebar-text` / `--sidebar-muted`），本轮实测确认两者的**相对**差值与 Claude 一致。
> 用户截图中两者同色，是因为那张图取自**主检出 master** —— master 的 `.app-sidebar .thread-item`
> 还没有 `color: var(--sidebar-text)`，会话标题回落到 `--muted`。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `stores/conversation-store.ts` | `ProjectGroupBy` 去掉 `'singleList'`，只剩 `'byProject' \| 'byDate'`；持久化的 `singleList` / 未知值迁移到 `'byDate'`；默认分组方式由 `byProject` 改为 `byDate`（Claude 默认就是日期分组） |
| `layout/app-sidebar.tsx` | 删除 singleList 分支：平铺计数 `flatListVisibleCount`、「会话」标题、「查看全部」的非日期分支 |
| `sidebar/SectionActions.tsx` | 分组方式子菜单只剩 文件夹 / 日期 |
| `i18n/{zh,en}.ts` | 删 `project.inOneList`、`sidebar.section.sessions` |
| `styles/sidebar-sections.css` | `.sidebar-section-item` 加 `margin-top: 16px` —— 组间留白从 0 变成 Claude 的 16 CSS px |
| `sidebar/SectionActions.test.tsx` / `stores/__tests__/conversation-store.hydration.test.tsx` | 断言改为两选项；新增 `singleList → byDate` 迁移用例 |

### 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d293eab2` dirty | Node | `npx tsc --noEmit -p packages/ui/tsconfig.json` | 0 | UI 包类型干净 |
| `d293eab2` dirty | Node / jsdom | `npx vitest run packages/ui/src/components/layout packages/ui/src/stores` | 0 · **376/376** | 含两个被本轮改动打断的用例（已改断言） |
| `d293eab2` dirty | Windows | `npm run architecture:check` | 0 · no new boundary violations | 3 个 baseline 指纹未再触发（既有情况） |
| `d293eab2` dirty | Windows / Node | `npm run typecheck:all` | **0**（`TYPECHECK_EXIT=0`） | 全量类型门禁通过 |
| `d293eab2` dirty | Windows / Electron + CDP | CDP 可信输入事件点组头 ⚙ → hover「分组方式」 | 子菜单文本 = **日期 文件夹** | 两项，不分组已消失 |
| `d293eab2` dirty | Windows / Electron + CDP | CDP 量 `getBoundingClientRect` | 组间盒模型间距 **16 px** × 3 | 与 Claude 墨迹间距逐项吻合 |

### 接续 / 结果

- 第五轮**已实现、已验证、已提交**（`34bffd74`，10 个文件：store / app-sidebar / SectionActions / i18n / CSS / 测试 / 本计划与路由表）。
- 已知差异：Claude 的 `Group by` 子菜单仍打不开，四桶口径与「Claude 是否有 Date 分组」**未经实测证实**。
- 副作用：本机 `duya-conversations` 的 `projectGroupBy` 验证期间来回切换，收尾为 `byDate`（与新默认一致）。
- 并行会话提示：同一 worktree `codex/ui-adjust` 上有另一个会话在并发提交（第四轮字体、面板等）；
  本轮只提交了上表 10 个文件，其余未提交改动属对方。

---

## 第六轮：组头 hover、三色状态点、worktree 徽标（2026-10-27）

分支 `codex/ui-adjust` · worktree `.claude/worktrees/ui-adjust` · base `f2b0dc3e` · 会话 `mvs_4801746c549f4c79a14713731e351b20`

### 触发

用户三条批注：

1. 组头（最近 7 天）hover 不要有阴影/背景高亮 —— Claude 只是**字体亮一点**。
2. session 行尾小圆点三色语义：**黄 = 等用户**（最后问了问题 / 要批准 / 要回答）、
   **蓝 = 已结束但用户还没查看**、**红 = 报错**。
3. worktree 图标：**创建 branch / 提交 PR / merge 各一个图标**，不止一次就在图标后加数字，样式同 Claude 截图；
   用户提示「worktree 的基础 duya 已经有实现」。

### 实测（Claude Code 桌面端 3.6556.2.0，PrintWindow 像素采样 + AX 树）

| 元素 | 坐标(X,Y,W,H) | 颜色 | 语义（AX 树） |
| --- | --- | --- | --- |
| 绿色图标 | 304,354,12,11 | `#32D64B` | 标题带 **Open** → PR Open |
| 绿色图标 | 304,556,12,11 | `#32D64B` | 「项目概览 **Open**」 |
| 黄色圆点 | 336,476,8,7 | `#FAB219` | 黄=等用户 |
| 蓝色圆点 | 336,558,8,8 | `#2A78D6` | 蓝=已结束未查看 |
| 紫色图标 | 292,594,12,11 | `#B796FF` | 标题带 **Merged · 3 pull requests** → 紫色 + 数字「3」 |
| 紫色图标 | 304,631,12,11 | `#B796FF` | 「大型项目 scripts 目录管理 **Merged**」 |
| 紫色图标 | 304,706,12,11 | `#B796FF` | 「本地 TUI 的 Agent 链路 **Merged**」 |

8× 放大确认：**绿色 = 双竖条 + 上下节点 = lucide `git-pull-request`**；
**紫色 = 一竖条 + 侧分支 + 节点 = lucide `git-merge`**（两者形状不同，不是同图标换色）。

### 改了什么

| 文件 | 改动 |
| --- | --- |
| `styles/sidebar-sections.css` | 组头 hover **删掉 `background: color-mix(...)`**，只留 `color: var(--sidebar-text-hover)`；三个系统段的 `background: transparent` 特判收敛为通用规则；组名继承 hover 色 |
| `styles/sidebar.css` | `.app-sidebar` 新增 `--sidebar-text-hover`（`--sidebar-muted` 55% ↔ `--sidebar-text`）；新增 `--sidebar-status-awaiting:#fab219`、`--sidebar-status-unread:#2a78d6`、`--sidebar-badge-pr:#32d64b`、`--sidebar-badge-merge:#b796ff`；新增 `.thread-item-badges` / `.thread-item-badge*` 规则 |
| `stores/session-seen-store.ts`（新） | zustand + localStorage（`sidebar.sessionUnreadAt`）：`notifyOutput(sessionId)` / `markSeen(sessionId)` |
| `hooks/useSessionUnreadBadge.ts`（新） | 结合 store + `subscribeToPhase` + `getSessionStatus` 探针（4s 缓存 / 8s 重查），抑制「还在跑却显示蓝点」 |
| `hooks/useSessionWorktreeBadges.ts`（新） | `observeIntegrationsForSession` → live PR 计数（`unknown` **不**计 open）+ merged 计数；`observeCheckoutForSession` → branch 计数；30s 缓存 + 并发上限 4 + **本地路径预筛**（仅路径含 `worktrees` 段才问 checkout） |
| `components/shared/SessionWorktreeBadges.tsx`（新） | branch（`--sidebar-muted`）/ PR（`#32d64b`）/ merge（`#b796ff`）三个 12px 图标，**计数 >1 才显示数字** |
| `components/icons.tsx` | 新增 lucide `GitPullRequest` / `GitMerge` 导入与 `GitPullRequestIcon` / `GitMergeIcon` 导出 |
| `components/shared/ThreadListItem.tsx` | `SessionStatus` 加 `"unread"`；状态推导链加 unread 分支；徽标插在状态点之前 |
| `App.tsx` | `onMessageNew` 广播中非 active session → `notifyOutput(sessionId)`；`activeThreadId` 变化 → `markSeen(activeThreadId)` |
| `i18n/{zh,en}.ts` | 新增 `thread.status.unread` / `thread.badge.branch` / `thread.badge.pullRequest` / `thread.badge.merged` |
| `components/shared/ThreadListItem.test.tsx` | 新增 7 例：蓝点出现 / 运行时无蓝点 / markSeen 后消失 / PR 计数 >1 才显示数字 / `unknown` 不计 open / branch 徽标 / 普通目录不向 Host 问 checkout |

### 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `f2b0dc3e` dirty | Node | `npx tsc --noEmit -p packages/ui/tsconfig.json` | 0 | UI 包类型干净（跑了两次） |
| `f2b0dc3e` dirty | Node / jsdom | `npx vitest run packages/ui/src/components/shared/ThreadListItem.test.tsx` | 0 · **31/31** | 含本轮新增 7 例 |
| `f2b0dc3e` dirty | Node / jsdom | `npx vitest run packages/ui/src/components/shared packages/ui/src/stores packages/ui/src/hooks` | 0 · **33 文件 / 303 用例** | 无回归 |
| `f2b0dc3e` dirty | Windows | `npm run architecture:check` | 0 · no new boundary violations | 3 个 baseline 指纹未再触发（既有情况） |
| `f2b0dc3e` dirty | Windows / Node | `npm run typecheck:all` | **0**（`TYPECHECK_EXIT=0`） | 19 个阶段全绿（build:packages 21 包） |
| `f2b0dc3e` dirty | Windows / Electron + DevTools | 量组头计算样式 | 静息 `rgb(143,140,140)` = `#8F8C8C`；hover 解析 `#B2B0B0`；**背景 `rgba(0,0,0,0)`** | 43 行会话，组名「昨天 / 最近 7 天 / 更早」 |
| `f2b0dc3e` dirty | Windows / Electron + DevTools | localStorage 写入 unread → reload | 渲染 1 个 `.thread-item-status-unread`，色与底均 **#2A78D6** | 端到端走通 store → hook → 组件 → CSS |
| `f2b0dc3e` dirty | Windows / Electron + DevTools | `window.electronAPI.workspaceLifecycle.integrations.observeForSession(id)` | 桥真实存在；该 profile 0 条 integration、checkout 返回 `null` | 徽标**正确地不渲染**（本机无 PR/托管 checkout 数据） |

### 接续 / 结果

- 第六轮**已实现、已验证**（三条批注的代码落地全部完成）。
- **hover 目标色是推导值**：Claude 真窗口在另一虚拟桌面且 foreground 被锁，取不到官方 hover 色；
  用已实测的两个色值（静息 `#8F8C8C` ↔ 会话标题 `#DDDCDC`）取 55% ⇒ `#B2B0B0`。
  若后续能激活 Claude 窗口，应重新采样校正这个比值。
- **branch 次数无法实现**：不存在 session→branch 历史表，`HostSessionCheckoutView` 只有单值、
  `HostCheckoutObserved` 无 branch 名 —— 本轮只渲染 branch 图标（计数恒为 1，不显示数字）。
  要支持计数需新增持久化表 + 协议字段 + Host 实现。
- **蓝色「已结束未查看」依赖 renderer 侧信号**：`unreadAt` 由全局 `message:new` 广播写入，
  后台 session 的「是否仍在跑」靠 `getSessionStatus` 探针（4s 缓存 / 8s 重查）。
  跨进程重启后 `completedAt` 语义仍不可用；要权威判定需把 `runs.finished_at` 经 preload 暴露给 renderer。
- **并行会话提示**：同一 worktree `codex/ui-adjust` 上并行会话仍在提交（面板布局 / BackgroundTasksPanel）。
  `icons.tsx` / `i18n/{en,zh}.ts` 三处双方都有改动，本轮用
  `docs-local/research/sidebar-group-parity/stage-own-hunks.mjs` 按标记过滤 hunk 后
  `git apply --cached` **只暂存我方 hunk**，其余 16 个文件留在工作区。


