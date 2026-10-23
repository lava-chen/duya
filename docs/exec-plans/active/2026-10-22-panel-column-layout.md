# 面板列树布局

状态：active · 负责人：mavis 会话 · 更新：2026-10-22
分支：codex/panel-layout-plan（本计划）· codex/panel-layout-columns（A）· codex/panel-layout-detach（B）· codex/panel-layout-drag（C，第二波）· codex/panel-layout-usage（D，第二波）
worktree：E:\Projects\duya\.claude\worktrees\panel-layout-plan（计划）· 同前缀 panel-layout-columns / panel-layout-detach / panel-layout-drag / panel-layout-usage（实现）
base：96dadf4d · owner：mavis

## 目标与边界

把 duya 的侧面板从**「单列 + 面板 tab 互斥」**升级为**「多列 + 列内堆叠 + 可脱窗」**，对标 Claude Desktop 的窗格树。

用户能观察到的变化：

1. 同时打开两个不同类型的面板（如「文件」+「终端」）时，它们**并排成两列**，而不是互相顶掉 tab。
2. 同一列里可以上下堆叠两个面板；关掉其中一个，**同列剩余面板自动占满该列**，列宽不变。
3. 面板 header 提供「在新窗口中打开」，把面板变成**独立 OS 窗口**；原生关闭按钮 = 收回主窗，不是销毁。
4. 面板 header 的控件顺序统一为 8 控件范式。

允许修改：`packages/ui/src/components/layout/**`、`packages/ui/src/hooks/usePanel.ts`、`packages/ui/src/styles/workspace.css`、`packages/ui/src/styles/composer-panels.css`、`packages/ui/src/components/usage/**`、`apps/desktop/src/main/**`、`apps/desktop/src/preload/**`。

本次不处理：conductor 画布、orb、TUI、web 版布局；不动 `packages/ui/src/components/layout/panels/registry.ts` 里已存在的面板组件实现（只加描述符字段）；不改 `packages/agent/`。

### 切片与路径所有权

每个 agent 独占自己的 worktree 与分支，**不得修改他人拥有的路径**。

| 切片 | 分支 / worktree | 独占路径 | 依赖 |
| --- | --- | --- | --- |
| **A 列树渲染** | `codex/panel-layout-columns` / `panel-layout-columns` | 新增 `packages/ui/src/components/layout/panels/layout-model.ts`；`packages/ui/src/hooks/usePanel.ts`；`packages/ui/src/components/layout/PanelZone.tsx`；`packages/ui/src/components/layout/app-shell.tsx`；`packages/ui/src/components/layout/ResizeHandle.tsx`；`packages/ui/src/styles/workspace.css`；`packages/ui/src/components/layout/PanelZone.test.tsx`；新增 `packages/ui/src/components/layout/__tests__/layout-model.test.ts` | 本计划 |
| **B 脱窗（Electron 侧）** | `codex/panel-layout-detach` / `panel-layout-detach` | `apps/desktop/src/main/**`；`apps/desktop/src/preload/**` | 本计划（IPC 契约与 A 的数据模型解耦，只用字符串参数） |
| **C 拖拽换位** | `codex/panel-layout-drag` / `panel-layout-drag` | `packages/ui/src/components/layout/PanelHeader.tsx`；新增 `packages/ui/src/components/layout/PaneDragHandle.tsx`；`layout-model.ts`；`usePanel.ts` | **A 落地后** |
| **D 用量浮层** | `codex/panel-layout-usage` / `panel-layout-usage` | `packages/ui/src/components/chat/ContextUsageRing.tsx`；新增 `packages/ui/src/components/chat/ContextUsageBreakdown.tsx`（+ 同名测试）；`packages/ui/src/styles/composer-panels.css`；`packages/ui/src/styles/chat.css`；`packages/ui/src/styles/globals.css`（仅新增分桶调色板变量） | 与 A 无冲突，可并行 |

集成顺序：**A → C**；B、D 独立，可各自先合。

### 数据模型（A 负责，C 复用）

```ts
type ColumnId = string
type PaneId = string
interface Pane { id: PaneId; pageId: PageId; instanceKey: string; host: "docked" | "expanded" | "detached" }
interface Column { id: ColumnId; widthRatio: number; panes: PaneId[]; ratios: number[] }
interface WorkspaceLayout { columns: Column[]; activePaneId: PaneId | null }
```

## 验收

**通用（每个切片都要过）**

- `npm run typecheck:all` 退出码 0
- `npm run architecture:check` 退出码 0（不得加指纹掩盖新增违规）
- 切片相关 vitest 退出码 0，且**先记录同 base 的基线失败**再比较
- 交付走 PR；不直推 master；未经授权不合并

**A**

- `npx vitest run packages/ui/src/components/layout` 退出码 0，含新增 `layout-model` 单测
- `npm run test:e2e:ui-states` 不新增失败（与同 base 对照比较文件/用例/错误签名，不只比数量）
- 浏览器或真实 Electron 里可复现：开两个面板 → 两列并排；关掉一个 → 同列另一个占满；关闭前后列宽不变

**B**

- `npx vitest run apps/desktop/src/main` 退出码 0
- `npm run test:e2e:ipc` 不新增失败
- 真实 Electron 里：面板可脱成独立窗口；原生 X 收回主窗；主窗面板状态不丢

**C**

- `npx vitest run packages/ui/src/components/layout` 退出码 0
- 拖拽面板到另一列 / 另一栈位可见生效，布局持久化后重载仍在

**D**

- 用量浮层的分段色条与 9 桶分色与 `docs-local` 采样值一致（见「发现与决策」）
- light / dark 主题下都可用（主题变量来自 `packages/ui/src/styles/globals.css`）

## 进度

- [x] 调研 Claude Desktop 布局模型（AX 树 + 截图），确定列树结构与归位规则
- [x] 写本计划（PR #351）
- [x] A：列树渲染 + 归位规则（子 agent）· 分支 `codex/panel-layout-columns` · SHA `21b764e9`
- [x] A：方向重做为面板卡片墙 + 窗口外壳两轮布局 · 同分支 · SHA `a256e982` / `0d89b57f`
- [x] B：脱窗 Electron 侧（子 agent）—— 已实现并验证（PR #353）；分支 `codex/panel-layout-detach`
- [ ] D：用量浮层（分段色条 + 分桶明细）（子 agent 进行中 · `codex/panel-layout-usage`）
- [ ] C：拖拽换位（第二波，依赖 A 落地）

## 发现与决策

- **Claude 的主窗不是「聊天 + 侧栏」，是两层列树**：横向是列，列内纵向堆叠面板，列间与列内各有可拖分隔条。渲染只需 `flex row` + 每列 `flex column`，**不需要自由 docking 算法**。
- **分隔条的可访问名直接写出窗格树**，规律是 `调整 <该分隔条左侧所有 pane> 和 <右侧所有 pane> 的大小`，逗号分隔、从左到右。这让布局**可以被无障碍层读出**——本计划要求 duya 的分隔条照此命名（`role="separator"` + `aria-label`）。
- **归位规则（实测三轮：开终端 → 关更改 → 开文件）**：
  - 关闭面板 → **列内局部重排**，同列剩余面板撑满该列；
  - 关闭面板 → **不跨列迁移**，其它列原地不动；
  - 关闭面板 → **列宽不变**（分隔条比例前后一致）→ 列是**固定槽位**。
  → 布局管理器采用「**固定列槽位 + 局部重排**」，不是「全局有序队列 + 自动重新分配」。
- **打开面板的落点有两条候选规则，实测无法区分**：加入「当前活动面板所在列」vs 加入「最右侧尚有空位的列」。**duya 选前者**——让用户正在看的面板决定新面板落点，行为可预测；后者会让新面板跳到与视线无关的最右列。列容量定为 2。
- **tab 化不是终端专属**：Claude 只有「同族多实例」面板 tab 化（终端 → `Tab "终端标签页"`；文件打开文件后 → `Tab "打开文件"` → `TabItem "AGENTS.md , 预览"`），diff / 后台任务是独立面板。duya 现在把**所有**面板都 tab 化 → 在 `registry.ts` 描述符上加 `stackable` 字段区分，本计划保留 tab 机制而不拆掉它。
- **duya 已有可复用的骨架**：`panels/registry.ts`（面板身份 + 尺寸约束）、`PanelHeader.tsx`（header chrome）、`ResizeHandle.tsx`（分隔条）、`usePanel.ts` 的 `workspaceExpanded`（已对应「展开独占工作区」态）、`tabs`/`activeTabId`（对应终端/文件的 tab）。缺的是**多列、列内堆叠、拖拽换位、脱窗**。因此**面板组件本身不用改**，改造集中在容器层。
- **duya 有 Claude 没有的东西，要保留**：面板级尺寸约束（`minWidth`/`widthRatio`/`maxWidthRatio`）与快捷键（`Ctrl+\`` / `Ctrl+T` / `Ctrl+Shift+G` / `Ctrl+P` / `Ctrl+Alt+S`）。列宽计算要继续受聊天列最小宽度保护（现有 `MIN_CHAT_WIDTH` / `MAX_PANEL_RATIO`）。
- **脱窗有现成基建**：`apps/desktop/src/main/**` 已有 5 处 `new BrowserWindow`（overlay / badge / wake / safe-mode），`core/window-manager.ts` 提供主窗创建与背板处理。状态所有权留在主窗，脱窗窗口只发意图。
- **颜色必须采样不能目测**：本轮调研中目测曾把 Memory files 的灰色色块看成绿色。用量浮层采样值——MCP tools `#2A78D6`、System tools `#EB6834`、Messages `#1BAF7A`、System prompt `#EDA100`、Skills/Memory files/MCP server instructions `#898781`、Autocompact buffer `#C3C2B7`、Free space `#EEEDEC`；浮层宽 `450px`、内边距 `15px`、色条 `420×5px`、段间 `1–2px` 缝、明细行高 `23px`、色块 `9×9px`。
- **duya 已有上下文用量体系，切片 D 是「换呈现」不是「从零做」**：`packages/ui/src/components/chat/ContextUsageRing.tsx` 是环形指示器；`packages/ui/src/stores/context-usage-store.ts` 的 `composition` 已按**内容来源**分了 10 个桶（`system` / `conversation` / `injectedContext` / `skills` / `toolDefinitions` / `toolResults` / `attachments` / `memory` / `providerOverhead` + `unattributedObservedTokens`）。这与 Claude 的 9 桶是同一套思路，只是 duya 更细。切片 D = 环形 → **分段色条 + 按来源分桶的展开浮层**；数据侧不用改口径。
- **注意 `packages/ui/src/components/usage/` 是另一回事**（provider 配额 / 用量看板 / 日 token 图表），不是上下文窗口用量，别混。
- **本机无 Workspace MCP 工具**（`workspace_get_context` 不可用），按根 AGENTS.md 允许的方式，改从版本化计划与 Git 对账推进共享状态。
- **CI 只对 base=master 的 PR 触发**（`.github/workflows/test.yml:19-20` 是 `pull_request: branches: [master]`）。切片 A/B/D 的 PR 因此一律 base=master，计划文件随之进入各 PR（单独的"计划 PR"随之关闭）。堆叠到非默认分支会拿不到"必需检查通过"的证据。
- **`ResizeHandle.tsx` 归切片 A 而不是 C**：列内堆叠需要纵向分隔条，而现有实现只有横向（`ResizeHandle.tsx:6` 的 `side: "left" | "right"`、`:143` 写死 `aria-orientation="vertical"`）。C 不碰它，改为新建 `PaneDragHandle.tsx`。
- **分隔条命名沿用现有无障碍基础**：`ResizeHandle.tsx` 已有 `role="separator"` / `aria-orientation` / `aria-label` / `aria-valuenow|min|max` / 键盘方向键步进 / Home / End / Enter 重置 / 双击重置（`:104-168`）。新列树沿用这一套，`aria-label` 按 `调整 <左侧所有 pane> 和 <右侧所有 pane> 的大小`（纵向则是「上方 / 下方」）命名。
- **B 切片：脱窗窗口加载同一个 renderer，只靠入口参数区分身份**。没有为脱窗复制一套面板实现——脱窗窗口用同一份 `dist/index.html`、同一套 preload，只多带 `--duya-panel-id=` / `--duya-panel-page=`（preload 读得到）和 `?duyaPanel=` / `?duyaPanelPage=`（人可读、便于排障）两组入口参数。复制一套面板实现等于复制一份面板状态机，和「主窗持有布局真值」直接冲突。
- **B 切片：布局真值留在主窗，脱窗窗口只发意图**。列 / 面板顺序 / 列宽全在主窗 renderer；脱窗窗口只通过 `panel-window:*` 通道把「收回 / 置顶」等意图发回主进程。原生 X 不销毁面板实例——主窗的列树里那个 pane 一直在，只是 host 从 `detached` 变回 `docked`，所以「关掉脱窗 = 面板状态不丢」是天然成立的。
- **B 切片：原生 X 在主进程里被翻译成「收回主窗」**。做法是脱窗的 `close` 事件里 `preventDefault()` 拒绝这次关闭，再由主进程自己关一次；第二次关闭被推迟一个 tick（`setImmediate`），因为在 `close` 事件里再调 `close()` 是重入的。另外 `before-quit` 会置位一个 quitting 标志——否则「关窗 = 收回」会把应用退出也一起拦下来。
- **B 切片：置顶状态归主进程持久化**（`{userData}/panel-window-state.json`，原子写）。理由是生命周期：脱窗随时可能被关掉，偏好只存在那个窗口里就会跟着一起没；主进程比任何脱窗活得久。重新脱窗时按 paneId 恢复。实测第二次脱窗时原生窗口直接是 `alwaysOnTop=true`。
- **B 切片：脱窗窗口的 IPC 权限比主窗窄**。标准 `assertTrustedSender` 会直接拒绝一切辅助窗口（`unknown_window`），所以这里另写一套更严的判定：调用方按 webContents id 认领身份（主窗 or 本模块自己开的脱窗），脱窗只能操作**自己那个 pane**，且必须来自该窗口自己的顶层 frame（webview guest 的 routingId 不同）。否则一个飘在外的面板就能改别人的面板。
- **B 切片：新增通道不需要登记 IPC 普查**。`architecture:check` 里的 `ipc-channel-census.mjs` 查的是 **worker ↔ Main** 的请求/响应通道，不是 renderer ↔ Main；renderer 侧的通道由 `ipc-channel-contract.test.ts` / `ipc-contract.test.ts` 守（preload 调用的每个通道必须有 handler）。本切片四个通道都注册了 handler，两条测试都过，因此没有新增门禁登记项。
- **B 切片：脱窗窗口的原生标题栏要钉住面板名**。renderer 会写 `document.title`，默认会把原生标题栏覆盖成 app 名；用 `page-title-updated` + `preventDefault()` 把标题钉成面板名。脱窗窗口刻意不设 `titleBarStyle: 'hidden'`——移动 / 展开 / 关闭让位给原生控件，这是对标 Claude 的行为。

### 切片 A 的取舍（子 agent 记录）

- **落点规则按「族」细分，否则验收里的「两个不同类型并排成两列」做不到**：计划原文写的是「新 pane 加到当前活动 pane 所在列」，但那样「文件 + 终端」会叠进同一列。实现取**同族（同一 pageId）才进活动列，否则新开一列**：同族 pane 在列内像 tab 一样互斥（浏览器 webview 因此仍保持"只显示一个"），异族 pane 各自成列 → 并排。族由 pageId 决定，**没有改 `registry.ts`**（不在本切片路径内），族判定放在 `layout-model.ts` 的 `resolveTargetColumn`，把「新 pane 的族」作为入参而不是从活动 pane 推断。
- **pane 的 id 就是 tab 的 id**：`tabs` 继续是面板元数据（标题/params）的唯一真源，`layout` 只回答「pane 在哪」。避免两套 id 互相翻译，`PanelHeader`（切片 C 拥有）不用改就能继续用全局 tab 条。
- **列宽用「区域宽 + 每列比例」两层**：区域宽（`panelWidth`）= 各列宽之和；`Column.widthRatio` = 该列在区域里的份额，列宽 = 区域宽 × 比例。关面板只重排**本列**、不动任何比例 → **列宽天然不变**；整列删掉时区域宽减去该列像素宽、其余列比例不变 → 存活列宽也不变、空出来的位置还给聊天列。
- **持久化不换 key**：`duya:panel:v2:<sessionKey>` 保持不变，只**新增可选字段 `layout`**。旧 payload 没有该字段时按「同族同列、异族各占一列」在内存里迁移；`sanitizeLayout` 会丢掉指向已消失 tab 的 pane、把 layout 里没有的 tab 补进列里，旧 localStorage 不会把 provider 搞崩。
- **分隔条沿用 `ResizeHandle` 的无障碍骨架并加纵向变体**：`side` 扩成 `left|right|top|bottom`，`top/bottom` 是横向分隔条（`aria-orientation="horizontal"`、上下键、row-resize 光标），**原有横向行为与调用方未变**（`left/right` 的 delta 符号、键盘映射原样保留）。
- **分隔条命名按实测格式 `调整 <左/上所有 pane> 和 <右/下所有 pane> 的大小`**（逗号分隔、从左到右）。这条格式是**中文硬编码**：本切片路径不含 `packages/ui/src/i18n/**`，无法加 i18n key，故英文界面下也是中文可访问名——留给拥有 i18n 与 `PanelHeader` 的后续切片本地化。
- **`workspaceExpanded` / `panelOpen` 仍是区域级开关**：展开态是整个区域铺满工作区，列树在其中横向排布；列树不引入第二个开关。

### 切片 A 的方向调整：面板卡片墙（2026-10-22 按用户反馈重做）

用户看截图后判定「完全不对」：目标不是「列树 + 全局 tab 条」，而是 Claude Code「Code」模式的**面板卡片墙**——右侧是网格，每张卡片是独立面板（文件查看 / 代码审查 / 浏览器 / 终端 / 后台任务），画布不管。重做时按截图逐张**量像素**，不目测。

- **量出来的规格**（截图 `屏幕截图 2026-10-19 211831.png`，1920×1031）：卡片墙左沿 x=780、右沿 x=1912；列分隔在 x=1201（卡片间缝 3–4px）；卡片 header 高 ≈ 28px（图标中心 y=53，卡片顶 y=40）；行分隔带 y=527–543。
- **网格形状随卡片数**：1–2 张 = 1 列（上下堆叠，每张占满宽）；≥3 张 = 2 列 × ⌈n/2⌉ 行。空格子渲染成「+」格，作为加入面板的入口。
- **每张卡片自带 header**（图标 + 标题 + 展开 + 关闭），**没有全局 tab 条**：`PanelHeader.tsx` 未被本切片改动，但 `PanelZone` 不再渲染它。
- **区域宽与列宽解耦**：区域宽由左边缘拖拽条决定（`panelWidth`），列/行只分配区域内的份额（ratio）。拖列分隔条只改份额，区域宽不变。
- **面板集合收敛到 5 种**：文件 / 代码审查 / 浏览器 / 终端 / 后台任务（暂用 `workflow` 面板）。画布（`conductor`）不进卡片墙，但事件打开仍可用。新增 `panels/wall-pages.ts` 记录这张表，**没有改 `registry.ts`**。（本轮收敛到 4 种：`workflow` 作为面板页已从 `PageId` 与 `WALL_PAGE_IDS` 移除，`TaskDrawerToggle` 删除；`WorkflowPanel.tsx` 只剩类型被 `components/workflow/**` 引用。见「外壳第三轮」。另：本轮 `registry.ts` 也在改动路径内。）
- **模型从列树换成墙**：`layout-model.ts` 重写为 `panes / columns / columnRatios / rowRatios / expandedPaneId`；旧 payload（列树）识别不出来就按 tab 顺序迁移成墙；持久化仍是 `duya:panel:v2:<sessionKey>` 的可选字段 `layout`。
- **上面「切片 A 的取舍」那套（族内同列、区域宽=列宽之和、靠全局 tab 条做拖拽换位）随之作废**，由墙模型取代。

### 窗口整体布局的调整（用户追加要求）

用户追加：duya 的整体布局改成截图里的左右布局，并把右上角那排按钮并到窗口控制区旁边；随后又明确「标题栏这排（图标 / 前进后退 / 菜单）放到 sidebar 上面，取消 titlebar drag region」。

- **标题栏整行在最上**：`.app-shell` 是列，标题栏是第一个子元素（整宽），下面才是 `.app-body`（行：侧栏 + 工作区）→ 图标 / 前进后退 / 菜单正好落在**侧栏上方**，内容区在标题栏下面。
- **会话动作并到窗口控制区旁**：`ChatHeaderActions` 从聊天 header 右侧移到 `TitleBar` 的 `.titlebar-actions`（`titlebar.css` 早已为 Windows 原生窗口按钮预留 `padding-right: 140px`）。重命名动作经 `duya:rename-thread` 窗口事件回到 header，标题编辑仍归 header。
- **取消 drag region**：`.titlebar-drag-region` 改成普通 `.titlebar`（去掉 `-webkit-app-region: drag`），删掉 `.titlebar-drag-fill` 与两处 `no-drag` 声明；窗口不再能靠标题栏拖动。（第三轮撤销了此项，见「外壳第三轮」）
- **macOS 例外**：macOS 用原生 inset 标题栏、没有自绘顶栏，动作留在聊天 header 里（`hasCustomTitleBar()` 判定）。
- **未做**：`registry.ts` 里的画布页面本身没有删（不在本切片路径，且 i18n 键也在路径外）；侧栏内部结构（图标栏）没重做。

> 排查记录：同一份代码在 dev server 下与 preview 模式下表现不同——preview 模式加载 `dist/`（旧构建）会显示旧布局。**验证布局改动必须确认 DevTools 标题是 `http://localhost:3000/`**，否则看到的是上一次构建的产物。

### 窗口外壳的第二轮调整（用户实机截图 + `ui-mockup-shell.html` 对照）

用户看了实机截图后指出两处：① 图标区应该是**上下**关系（不是最左侧一条竖排窄栏）；② 左上角那个按钮**原来是 app icon**，怎么变样了。参照物是 `docs-local/research/claude-desktop-ui/ui-mockup-shell.html`（用户自己的 Claude Desktop 外壳实现）与用户新发的 Claude Code 侧栏截图。

- **量出来的规格**（用户截图 `16-18-18-244`，361×1382 侧栏切片）：图标行在**侧栏顶部**，横向排列 `≡ ⊞ ← →`；16px 图标、中心间距 30px、首个图标左边距 ≈17px、图标行高 ≈44px（下方 ≈53px 处才是分段控件）。
- **图标行改成侧栏顶行**：`app-shell.tsx` 把 `AppRail` + `AppSidebar` 包进 `.app-sidebar-column`（列），`.app-rail` 由 `flex-direction: column` 改成 `row`、`height: 44px`；会话列表落在图标行下方 → 上下关系。
- **app icon 复位**：左上角恢复 master 的 app icon 芯片（`icon.png`，hover 换成侧栏折叠图标，点击折叠/展开侧栏）。上一轮把它换成 ⊞ 图标属于改动过头。
- **菜单收成一个下拉**：文件 / 编辑 / 视图 / 帮助 四个菜单并成一个 ≡ 按钮，每项是 submenu（`›` 箭头）。
- **← → 留在侧栏顶行**：中途按 mockup 把它挪到内容区顶栏，用户明确「也在侧栏顶栏」→ 放回图标行。
- **会话标题进顶栏**：内容区顶栏左侧是会话标题（复用 `ChatHeader` 组件，CSS 去掉它自己的行内边距/底边框），右侧是会话动作（⋯），紧挨原生窗口按钮；聊天区紧贴顶栏，从底部顶到上面。
- **顶栏不再是拖拽区**：去掉 `-webkit-app-region: drag`，窗口不能靠标题栏拖动。（第三轮补回，见「外壳第三轮」）
- **macOS 例外**：macOS 无自绘顶栏，`hasCustomTitleBar()` 为 false，`ChatHeader` 仍留在聊天视图内。

### 外壳第三轮：拖拽区、展开态标题、收起栏缝隙、面板卡片亮度

用户实机指出四点：① 顶部无法拖拽移动窗口；② 面板放大后 header 消失；③ 侧栏收起后不留小侧栏（给了参考图）；④ 面板背景色与 session 背景色不一致、面板浅一点。

- **拖拽区补回**：`c7a72618` 记录过「取消 drag region」，那是这一版无法拖窗的直接原因——`titleBarStyle:'hidden'` + `titleBarOverlay` 把原生标题栏去掉了，窗口移动**只剩** CSS `-webkit-app-region: drag` 一条路。给 `.titlebar` 与 `.app-rail` 各加回 drag，并对其中每个可点控件（`button` / `input` / `a`、`.chat-header-*`、`.titlebar-panel-launcher`、`.app-rail-brand`）逐条 `no-drag` 退让。拖窗走原生路径，CDP 无法验证，需用户实机确认。
- **展开态保留会话标题**：`.panel-zone-expanded` 绝对定位只盖 `.app-workspace-row`（y 从 44px 起），顶栏本来就在覆盖范围之外；`TitleBar.tsx` 之前用 `workspaceExpanded` 隐藏标题，等于在盖不到的地方留一条空带。改为始终按 `currentView === "chat" && !!thread` 判定，删掉对 `useOptionalPanel` 的依赖。
- **收起栏的色差是缝隙不是缺栏**：收起后 56px 图标栏（`.app-rail`）本来就在。真正的问题是 `.app-sidebar-column > .app-sidebar` 又叠了一层半透明 `--glass-chrome`，两层透明填充叠出更深一条带；去掉 `border-right` 后仍留一条上下色差。修法：侧栏在该列内 `background: transparent`，由列自己铺一层玻璃；图标统一成 34px / 圆角 8px 与 `.app-sidebar-rail .rail-btn` 对齐。实测收起栏自上而下连续 `#252525`。**用户随后决定「侧栏就先这样不动了」**，此轮只到这里。
- **面板卡片亮度**：量像素证明本版卡片与画布在两个主题下都完全相同（暗 30/30、亮 255/255），用户给的截图来自另一个产品，其参考值为聊天区 rgb(21,21,21) / 面板 rgb(26,26,25)（亮一档）。按用户选择**照参考图略亮一档**：新增 `--panel-surface`（亮 `#ffffff`，暗 `#232323`）。亮色画布已是纯白、没有余量，所以保持贴平、靠 1px 边框区分；暗色抬一档。落点是 `.panel-wall-cell { --main-bg: var(--panel-surface) }`——重声明画布 token 而不是设 `background`，卡片自身与它内部所有画 `var(--main-bg)` 的页面体一起抬起，而卡片外的 8px 内缩环不在这棵子树里、继续与聊天画布齐平。`preview-drawer.css` 补一条：原生毛玻璃下 `.sidebar-panel-inner` 强制 `var(--main-bg)`，否则 sidebar 的玻璃 scrim 会把内缩环染成另一色。
  - 不能用 `color-mix()` 从 `--main-bg` 推导 `--panel-surface`：那会构成自定义属性环 → 计算值无效。所以两主题各写死一个值。
  - 第一次采样读到 rgb(32,32,32) 而非 35，用红色覆盖探针（`--panel-surface:#ff0000!important` → 抓到 rgb(255,0,0)）排除遮罩与色彩管理，重抓后卡片稳定 rgb(35,35,35)、画布 rgb(30,30,30)——32 是一帧过渡态。

- **随同一提交入库的其他改动（第二个写者的工作，见「接续 / 结果」）**：workflow 面板页从 `PageId` / `WALL_PAGE_IDS` / `registry.ts` 移除、`TaskDrawerToggle` 删除；新增 `panels/PanelLaunchers.tsx` + `panels/launch.ts`（启动器与快捷键表，由顶栏、聊天 header、卡片墙共用）；`ChatHeader` 把 ⋯ 动作簇放到标题紧挨着（`hasCustomTitleBar()` 为 true 时），项目名改成 pill 菜单（在资源管理器里显示 / 在项目目录开终端 / 复制路径），macOS 才走 `chat-header-actions` 那一支；`PanelCard` / `PanelZone` / `usePanel` / `composer-panels.css` 配合调整，`i18n/en.ts`、`zh.ts` 补启动器与 pill 文案。

- **待评审的死支**（本轮未动，避免混进已验收的改动）：`TitleBar.tsx:144` 的 `{!hasCustomTitleBar() && <ChatHeaderActions />}` 恒不成立——`app-shell.tsx:282` 只在非 macOS 挂载 `TitleBar`，而那时 `hasCustomTitleBar()`（`platform !== "darwin"`）必为 true。要么删掉这一支连同 `ChatHeaderActions` / `hasCustomTitleBar` 两个 import，要么重新定义 `TitleBar` 的挂载条件与 `is-mac` 分支（它现在带着一个永不生效的 `--window-controls-offset: 70px`）。

### 开发环境的两个坑（本轮实测）

- **本 worktree 里 Vite 的 HMR 是失效的**：`vite.config.ts` 的 `server.watch.ignored` 含 `**/.claude/**`，而 worktree 就在 `.claude/worktrees/` 下 → watcher 忽略全部源码，改完代码重载页面仍是旧模块（看起来像改动没生效）。**改完必须重启 Vite**（`npx vite --port 3000 --strictPort`）再重载页面。
- **`PrintWindow` 抓不到窗口右上角**：原生窗口控件叠加区（`titleBarOverlay`）在 `PrintWindow` 的位图里是空的，会让人误判「顶栏右端的 ⋯ 按钮没渲染」。改用 `electron --remote-debugging-port=9222` + CDP `Page.captureScreenshot` 抓渲染页，并用 `Runtime.evaluate` 直接查 DOM 几何（实测 ⋯ 按钮在 x=1049、22×22、白色描边，DOM 里一直在）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 96dadf4d / 仅 3 个未跟踪文件 | Windows 11 / Node 主检出 | `git worktree add .claude/worktrees/panel-layout-plan -b codex/panel-layout-plan origin/master` | 0 | worktree 列表含 5 项 |
| 96dadf4d | 同上 | Claude Desktop 布局归位实测三轮 | 行为已记录 | 见「发现与决策」 |
| 275dab09 / clean（切片 A 基线） | Windows 11 / Node 24.16 / worktree `panel-layout-columns` | `npx vitest run packages/ui/src/components/layout` | 1 | 5 个 suite 因 `@duya/ai` 的 dist 未构建而无法解析（`Failed to resolve entry for package "@duya/ai"`）——**worktree 环境缺产物**，非用例失败 |
| 275dab09 / clean（切片 A 基线） | 同上 | `npm run test:e2e:ui-states` | 1 | 4 个用例：3 过 1 失败。失败文件 `e2e/ui-states/ui-states.spec.ts:376`，用例「the theme switch repaints the shell in both themes and persists both」，错误签名 `could not get an unobstructed click on the theme toggle … a modal overlay (div.fixed.inset-0.z-50) still covers the shell after 15000ms; on-screen text: DUYA` |
| 21b764e9 / clean | 同上 | `npm run build:packages` | 0 | 22 个包构建完成，补上 worktree 缺失的 dist（上面 5 个 suite 因此转绿） |
| 21b764e9 / clean | 同上 | `npx vitest run packages/ui/src/components/layout` | 0 | 19 个 suite / 146 个用例全过，含新增 `layout-model` 26 例 |
| 21b764e9 / clean | 同上 | `npx vitest run packages/ui` | 0 | 210 个 suite 全过（无回归） |
| 21b764e9 / clean | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；`.architecture-baseline.json` 未改动 |
| 21b764e9 / clean | 同上 | `npm run typecheck:all` | 0 | 含 electron gate `OK — no new type errors` |
| 21b764e9 / clean | 同上 | `npm run test:e2e:ui-states` | 1 | 与基线**同文件 / 同用例 / 同错误签名**的既有失败，未新增失败 |
| 21b764e9 / clean | 同上 | `npm run electron:build` + `node docs-local/research/panel-column-layout/column-evidence.mjs` | 0 | 真实 Electron 里截图与数值见下 |
| a256e982 / clean（面板墙） | 同上 | `npx vitest run packages/ui/src/components/layout` | 0 | 19 个 suite / 188 个用例全过；`layout-model` 27 例 + `PanelZone` 7 例为新增/重写 |
| 15da2da4 / clean（面板墙 + 窗口布局） | 同上 | `npx tsc --noEmit` | 0 | web 侧类型检查通过 |
| 15da2da4 / clean | 同上 | `npx vitest run packages/ui` | 0 | 210 个 suite / 2202 个用例全过（2 skipped） |
| 15da2da4 / clean | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；`.architecture-baseline.json` 未改动 |
| 15da2da4 / clean | 同上 | `npm run test:e2e:ui-states` | 0 | 4 个用例全过；基线上那条主题开关的既有失败（`ui-states.spec.ts:376`）本次也通过 |
| 0d89b57f / clean（外壳第二轮） | 同上 | `npx tsc --noEmit` | 0 | web 侧类型检查通过 |
| 0d89b57f / clean | 同上 | `npx vitest run packages/ui/src/components/layout packages/ui/src/components/chat` | 0 | 72 个 suite / 691 个用例全过 |
| 0d89b57f / clean | 同上 | `npx vitest run packages/ui` | 0 | 210 个 suite / 2202 个用例全过（2 skipped） |
| 0d89b57f / clean | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；`.architecture-baseline.json` 未改动 |
| 0d89b57f / clean | 同上 | `npm run build` | 0 | 58.17s |
| 0d89b57f / clean | 同上 | `npm run test:e2e:ui-states` | 0 | 首次 2 例失败（`.e2e-userdata` 残留命名空间：DB owner 锁文件丢失 + 新手引导遮罩盖住主题开关），清掉命名空间后 **4 例全过** |
| 0d89b57f / clean | 同上 | 真实 Electron（Vite 3000 + `npx electron . --remote-debugging-port=9222`） | 0 | CDP `Page.captureScreenshot` + `Runtime.evaluate` 实测：图标行 = 侧栏顶行（app icon x=12、≡ x=42、← x=72、→ x=102，均 26×26）；会话列表在 y=44 以下；顶栏 ⋯ 在 x=1049、22×22 |
| 5d973be1 / clean（外壳第三轮） | Windows 11 / Node 24.18 / worktree `panel-layout-columns` | `npx tsc --noEmit`（`packages/ui`） | 0 | — |
| 5d973be1 / clean | 同上 | `npm run typecheck:all` | 0 | 含 electron gate `OK — no new type errors` |
| 5d973be1 / clean | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；tolerated 2792 全部为既有 baseline，未新增指纹 |
| 5d973be1 / clean | 同上 | `npx vitest run packages/ui/src/components/layout` | 0 | 18 个 suite / 186 个用例全过（`panel-zone-workflow-view` 套件随 workflow 面板移除而删除） |
| 5d973be1 / clean | 同上 | `npx vitest run packages/ui` | 0 | 209 个 suite / 2200 个用例全过（2 skipped） |
| 5d973be1 / clean | 同上 | 真实 Electron（已在跑的 dev 实例 + CDP `:9222`，未另开窗口） | 0 | 见下「第三轮像素与几何实测」 |

### 切片 A 的可见行为证据（真实 Electron，1600×900）

`docs-local/research/panel-column-layout/`（未入库）：`03-two-columns.png`、`04-after-close.png`、`05-stacked.png`、`06-stacked-after-close.png`、`layout-report.json`。

| 场景 | 观测 |
| --- | --- |
| 同时打开「文件」+「终端」 | `columnCount=2`，区域宽 640px，两列各 320px（left 961 / 1288）→ **并排**；分隔条 `aria-label="调整 文件 和 终端 的大小"` |
| 关掉「终端」 | `columnCount=1`，区域宽 320px，存活列仍 **320px**（列宽不变），空位还给聊天列 |
| 同族两个 pane（alpha.md / beta.md） | 落进**同一列**（列内 tab 互斥，未激活者 height 0 且 hidden），列间分隔条 `调整 文件 和 alpha.md，beta.md 的大小`，列内分隔条 `调整 alpha.md 和 beta.md 的大小` |
| 关掉其中一个 | 同列剩余 pane 高度从 406px 变 **816px**（占满该列），列宽仍 480px |

### 第三轮像素与几何实测（真实 Electron，1510×844 @ dpr 1.25）

用 `Runtime.evaluate` 读计算样式，用 `Page.captureScreenshot` + 自写 PNG 解码器（`tmp/png-pixel.js`）按 CSS 像素取样。

| 场景 | 观测 |
| --- | --- |
| 顶栏 / 图标行拖拽属性 | `.titlebar`、`.app-rail` = `drag`；`.chat-header-title`、`.chat-header-btn`、`.chat-header-project`、`.titlebar-panel-launcher`、`.app-rail-brand` = `no-drag` |
| 面板展开（`data-panel-expanded="true"`） | `.panel-zone` x=56、w=1454，起于 44px 顶栏之下；顶栏仍渲染会话标题 + 项目 pill |
| 侧栏收起 | 56px 图标栏整列连续 `#252525`，无上下色带（修法见上） |
| 改动前面板卡片 vs 画布 | 暗色 rgb(30,30,30) / rgb(30,30,30)、亮色 255 / 255 —— **完全相同**，用户看到的浅色来自参考产品而非本构建 |
| 抬亮后卡片 | `.panel-wall-cell` 计算 `--main-bg: #232323`、背景 rgb(35,35,35)；`rgb(35)` 与画布 `rgb(30)` 差 5 级，与参考图差值一致 |
| 抬亮后内缩环 | 卡片外 8px 环取样 x=1052 处 rgb(30,30,30) —— 与聊天画布齐平，未跟随抬起 |
| B 切片 `e028447d` / 仅本切片 9 个文件 + 计划文件 | Windows 11 / Node 20 / worktree `panel-layout-detach` | `npx vitest run apps/desktop/src/main` | 0 | 296 文件通过 / 1 跳过，3564 用例通过 / 11 跳过（含新增 31 例：窗口生命周期 18 + IPC 契约 13） |
| B 切片 `e028447d` | 同上 | `npm run architecture:check` | 0 | 2792 条全部落在 baseline，无新增违规 |
| B 切片 `e028447d` | 同上 | `npm run typecheck:electron:prepared` | 0 | no new type errors（231 个既有错误 / 111 个 key） |
| B 切片 `e028447d` | 同上 | `npx tsc --noEmit --project apps/desktop/tsconfig.preload.json` | 0 | preload 无类型错误（该 project 不在任何 npm 脚本里，手工跑） |
| B 切片 `e028447d` | 同上 | `npm run typecheck:all` | 0 | 全量类型门禁通过（含 electron / evals 两道 ratchet） |
| **基线** 275dab09（同 base，未改代码） | 同上 | `npm run test:e2e:ipc` | 0 | 48 passed / 2 skipped / 0 failed（8.4m） |
| B 切片 `e028447d` | 同上 | `npm run test:e2e:ipc` | 0 | 48 passed / 2 skipped / 0 failed（8.3m）——与基线逐文件 / 逐用例一致，无新增失败 |
| B 切片 `e028447d` | 同上 | `npm run electron:build` + 真实 Electron 脚本驱动 | 0 | 见下「脱窗实测」 |

## 接续 / 结果

已实现（**方向已重做为面板卡片墙**）：

- `panels/layout-model.ts` 重写为**墙模型**（`panes / columns / columnRatios / rowRatios / expandedPaneId` + 形状推导、份额归一化、像素几何、分隔条命名）。
- 新增 `panels/PanelCard.tsx`（卡片 chrome：图标 + 标题 + 展开 + 关闭）、`panels/wall-pages.ts`（面板集合表）。
- `PanelZone.tsx` 渲染**网格 + 卡片 + 双向可拖分隔条 + 「+」空格**，不再渲染全局 tab 条；新增一条 28px 的墙工具条承载「加入面板」。
- `usePanel.ts` 换成墙状态与持久化（旧载荷迁移），区域宽与列份额解耦。
- `workspace.css` 换成墙样式（卡片间距 4px、卡片 header 28px、圆角 6px）。
- 窗口外壳两轮布局（`app-shell.tsx` / `TitleBar.tsx` / `ChatHeader.tsx` / `ChatView.tsx` / `titlebar.css` / `sidebar.css`）：侧栏列 = 顶行图标（app icon + ≡ 菜单下拉 + ← →）+ 会话列表；内容列 = 顶栏（会话标题 + ⋯ 靠原生窗口按钮）+ 工作区（聊天 + 面板墙）。
- 外壳第三轮（`5d973be1`）：44px 顶栏与图标行补回拖拽区并逐控件退让；面板展开时保留会话标题；收起栏去掉叠加玻璃与半边框、图标统一到 34px；新增 `--panel-surface`，`.panel-wall-cell` 重声明 `--main-bg` 使卡片及其内部页面抬一档、内缩环保持齐平。

已验证：见上表（`tsc --noEmit` 0、`vitest packages/ui/src/components/layout` 0 / 188 例、`vitest packages/ui/src/components/layout packages/ui/src/components/chat` 0 / 691 例、`vitest packages/ui` 0 / 2202 例、`architecture:check` 0、`build` 0、`test:e2e:ui-states` 0 / 4 例；第三轮 `typecheck:all` 0、`architecture:check` 0、`vitest packages/ui` 0 / 2200 例）。**实机证据**：用 CDP 抓了真实 Electron 的渲染页（`docs-local/research/panel-wall/cdp-shot*.png`），量了图标行与会话列表的几何、卡片与画布的像素底色。**未验证**：拖窗本身走原生窗口路径，CDP 与截图都无法证明，需用户在实机上拖动确认。

已合并：B 切片 PR #353 已合并；A 切片随本 PR #354 合并。

PR：`https://github.com/lava-chen/duya/pull/354`（base = `master`，head = `codex/panel-layout-columns`）；标题与正文已改写为「面板卡片墙」方向。第三轮已推到同一分支，不另开 PR。

⚠️ **同一 worktree 里出现过第二个写者**：`0d89b57f` 之后 `PanelZone.tsx`、`i18n/en.ts`、`i18n/zh.ts` 被改动，并新增 `panels/PanelLaunchers.tsx`、`panels/launch.ts`（面板启动器 + 快捷键表）。这些已由 `5d973be1` 一并提交，与本轮外壳改动混在同一 commit 里——评审时按文件而不是按 commit 看。接手前仍先 `git status` 对账，勿覆盖。

外部副作用：本 worktree 的 `e2e/.e2e-userdata/` 留下隔离命名空间的测试会话；`docs-local/research/panel-wall/` 留有像素量测脚本（`measure.ps1` / `detect-lines.ps1` / `crop.ps1` / `capture.ps1`）与 CDP 工具（`cdp-eval.mjs` / `cdp-shot.mjs`，均不入库）。第三轮的量测工具写在会话级临时目录（`cdp.js` 求值 / `cdp-shot2.js` 整窗截图 / `cdp-clip.js` 区域截图 / `cdp-reload.js` 重载 / `png-pixel.js` 自写 8-bit PNG 解码器按 CSS 像素取样），**不入库、可能被清理**，重建契约：连 CDP 前须设 `CDP_PORT=9222`（脚本默认 9223）；整窗截图按 dpr 1.25 取样（`SCALE=1.25`，1510×844 视口对应 1888×1055 位图）。

阻塞：① **`@computer-use` 的 host 工具在本子会话不可调用**（无 `tool_search`、`tool_ref` 无法发现、`mcode-tools connector tools` 里没有 computer 能力），所以「亲自操作 Claude Code」这一步没做成——改用用户 8 张截图逐张量像素替代。② 画布页面本身没删（`registry.ts` / i18n 不在路径内），只从卡片墙入口里移除。③ 侧栏内部结构（会话列表本身）没重做。④ **收起侧栏的目标形态未定**：用户先给了「收起后整栏消失、只留顶栏那排」的描述与参考图，随后决定「侧栏就先这样不动了」，此需求未实现，恢复工作时先与用户重确认形态。

回收：未回收（分支与 worktree 保留给评审与后续切片）。切片 C（拖拽换位）若继续，墙模型是它的写回点（`layout-model.ts` / `usePanel.ts`）；`PanelHeader.tsx` 现已不被 `PanelZone` 渲染，接手前先确认它的新定位。

**B 切片（脱窗 Electron 侧）结果** —— 分支 `codex/panel-layout-detach`，worktree `.claude/worktrees/panel-layout-detach`，base `275dab09`，提交 `e028447d`（PR base = master）。

已实现：独立 OS 窗口生命周期（`apps/desktop/src/main/core/panel-window-manager.ts` + `panel-window-state.ts`）、`panel-window:*` 四个 IPC 通道（`apps/desktop/src/main/ipc/panel-window-handlers.ts`）、preload 桥 `window.electronAPI.panelWindow`（`apps/desktop/src/preload/index.ts`）。已验证：单测 31 例、main 全量 3564 例、architecture:check、electron 类型门禁、e2e ipc 与同 base 逐用例一致、真实 Electron 里脱窗 / 置顶 / 原生 X 收回全链路跑通。已合并：PR #353。

**脱窗实测（真实 Electron，截图见 `.e2e-userdata/panel-detach-check/evidence/`）**：主窗 `panelWindow.context = {paneId:null,pageId:null}`；`panel-window:open` 返回 `{ok:true,paneId:'pane-e2e-1',windowId:2}`，真的多出一个原生窗口（1128×878，独立标题栏，标题为面板名「终端」），URL 为 `…/dist/index.html?duyaPanel=pane-e2e-1&duyaPanelPage=terminal`，脱窗内 preload 读到 `context={paneId:'pane-e2e-1',pageId:'terminal'}`；`set-always-on-top` 后原生窗口 `isAlwaysOnTop()=true`（主窗不受影响）；点原生 X（等价 `win.close()`）后脱窗消失、主窗收到 `{type:'returned',reason:'native-close'}`、`get-state` 回到 `detached:false` 且 `alwaysOnTop:true` 保留，`{userData}/panel-window-state.json` 落盘 `{"panes":{"pane-e2e-1":{"pageId":"terminal","alwaysOnTop":true}}}`。

未完成 / 阻塞：**渲染侧仍缺**——脱窗窗口目前渲染的是完整 app 外壳，「只渲染这一个面板」要靠切片 A 读 `panelWindow.context.paneId` 后自己收敛；本切片不碰 `packages/ui/**`。B 不依赖 A 即可合入，A 的接线契约见 PR 正文。

外部副作用：本次只在 worktree 内跑真实 Electron，产物落在 `.e2e-userdata/panel-detach-check/`（未跟踪）；`packages/host/bundle/*` 等被构建改写的已跟踪文件已按「只保留本任务成果」还原。
