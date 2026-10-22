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
| **A 列树渲染** | `codex/panel-layout-columns` / `panel-layout-columns` | 新增 `packages/ui/src/components/layout/panels/layout-model.ts`；`packages/ui/src/hooks/usePanel.ts`；`packages/ui/src/components/layout/PanelZone.tsx`；`packages/ui/src/components/layout/app-shell.tsx`；`packages/ui/src/styles/workspace.css`；`packages/ui/src/components/layout/PanelZone.test.tsx`；新增 `packages/ui/src/components/layout/__tests__/layout-model.test.ts` | 本计划 |
| **B 脱窗（Electron 侧）** | `codex/panel-layout-detach` / `panel-layout-detach` | `apps/desktop/src/main/**`；`apps/desktop/src/preload/**` | 本计划（IPC 契约与 A 的数据模型解耦，只用字符串参数） |
| **C 拖拽换位** | `codex/panel-layout-drag` / `panel-layout-drag` | `packages/ui/src/components/layout/PanelHeader.tsx`；`packages/ui/src/components/layout/ResizeHandle.tsx`；`layout-model.ts`；`usePanel.ts` | **A 落地后** |
| **D 用量浮层** | `codex/panel-layout-usage` / `panel-layout-usage` | `packages/ui/src/components/usage/**`；`packages/ui/src/styles/composer-panels.css` | 与 A 无冲突，可并行 |

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
- [x] 写本计划
- [x] A：列树渲染 + 归位规则（子 agent）· 分支 `codex/panel-layout-columns` · SHA `21b764e9`
- [ ] B：脱窗 Electron 侧（子 agent）
- [ ] C：拖拽换位（第二波）
- [ ] D：用量浮层对齐（第二波）

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
- **本机无 Workspace MCP 工具**（`workspace_get_context` 不可用），按根 AGENTS.md 允许的方式，改从版本化计划与 Git 对账推进共享状态。

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
- **面板集合收敛到 5 种**：文件 / 代码审查 / 浏览器 / 终端 / 后台任务（暂用 `workflow` 面板）。画布（`conductor`）不进卡片墙，但事件打开仍可用。新增 `panels/wall-pages.ts` 记录这张表，**没有改 `registry.ts`**。
- **模型从列树换成墙**：`layout-model.ts` 重写为 `panes / columns / columnRatios / rowRatios / expandedPaneId`；旧 payload（列树）识别不出来就按 tab 顺序迁移成墙；持久化仍是 `duya:panel:v2:<sessionKey>` 的可选字段 `layout`。
- **上面「切片 A 的取舍」那套（族内同列、区域宽=列宽之和、靠全局 tab 条做拖拽换位）随之作废**，由墙模型取代。

### 窗口整体布局的调整（用户追加要求）

用户追加：duya 的整体布局改成截图里的左右布局，并把右上角那排按钮并到窗口控制区旁边。

- **顶栏只盖内容区**：`.app-body` 变成「左：侧栏（整高）／右：`.app-content-column`（顶栏 + 工作区）」，侧栏因此占满窗口高度，标题栏只跨内容区——与截图一致（截图里左侧图标栏 + 侧栏是整高的，顶栏在内容区）。
- **会话动作并到窗口控制区旁**：`ChatHeaderActions` 从聊天 header 右侧移到 `TitleBar` 的 `.titlebar-actions`（`titlebar.css` 早就为 Windows 原生窗口按钮预留了 `padding-right: 140px`）。重命名动作经 `duya:rename-thread` 窗口事件回到 header，标题编辑仍归 header。
- **macOS 例外**：macOS 用原生 inset 标题栏、没有自绘顶栏，动作留在聊天 header 里（`hasCustomTitleBar()` 判定）。
- **未做**：`registry.ts` 里的画布页面本身没有删（不在本切片路径，且 i18n 键也在路径外）；侧栏内部结构（图标栏）没重做，只把它变成整高。

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

### 切片 A 的可见行为证据（真实 Electron，1600×900）

`docs-local/research/panel-column-layout/`（未入库）：`03-two-columns.png`、`04-after-close.png`、`05-stacked.png`、`06-stacked-after-close.png`、`layout-report.json`。

| 场景 | 观测 |
| --- | --- |
| 同时打开「文件」+「终端」 | `columnCount=2`，区域宽 640px，两列各 320px（left 961 / 1288）→ **并排**；分隔条 `aria-label="调整 文件 和 终端 的大小"` |
| 关掉「终端」 | `columnCount=1`，区域宽 320px，存活列仍 **320px**（列宽不变），空位还给聊天列 |
| 同族两个 pane（alpha.md / beta.md） | 落进**同一列**（列内 tab 互斥，未激活者 height 0 且 hidden），列间分隔条 `调整 文件 和 alpha.md，beta.md 的大小`，列内分隔条 `调整 alpha.md 和 beta.md 的大小` |
| 关掉其中一个 | 同列剩余 pane 高度从 406px 变 **816px**（占满该列），列宽仍 480px |

## 接续 / 结果

已实现（**方向已重做为面板卡片墙**）：

- `panels/layout-model.ts` 重写为**墙模型**（`panes / columns / columnRatios / rowRatios / expandedPaneId` + 形状推导、份额归一化、像素几何、分隔条命名）。
- 新增 `panels/PanelCard.tsx`（卡片 chrome：图标 + 标题 + 展开 + 关闭）、`panels/wall-pages.ts`（面板集合表）。
- `PanelZone.tsx` 渲染**网格 + 卡片 + 双向可拖分隔条 + 「+」空格**，不再渲染全局 tab 条；新增一条 28px 的墙工具条承载「加入面板」。
- `usePanel.ts` 换成墙状态与持久化（旧载荷迁移），区域宽与列份额解耦。
- `workspace.css` 换成墙样式（卡片间距 4px、卡片 header 28px、圆角 6px）。
- 窗口布局：顶栏只盖内容区（侧栏整高），会话动作移到顶栏右端、原生窗口按钮旁（`app-shell.tsx` / `TitleBar.tsx` / `ChatHeader.tsx`）。

已验证：见上表（`tsc --noEmit` 0、`vitest packages/ui/src/components/layout` 0 / 188 例、`vitest packages/ui` 0 / 2202 例、`architecture:check` 0、`test:e2e:ui-states` 0 / 4 例）。**本轮没有实机截图证据**：构建 + 启动真实 Electron 的成本太高，结论来自单测、e2e 与对用户截图的像素量测。

已合并：无（PR 未合并，等授权）。

PR：`https://github.com/lava-chen/duya/pull/354`（base = `master`，head = `codex/panel-layout-columns`）；标题与正文已改写为「面板卡片墙」方向。

外部副作用：本 worktree 的 `e2e/.e2e-userdata/` 留下隔离命名空间的测试会话；`docs-local/research/panel-wall/` 留有像素量测脚本（`measure.ps1` / `detect-lines.ps1`）与墙样式草稿（均不入库）。

阻塞：① **`@computer-use` 的 host 工具在本子会话不可调用**（无 `tool_search`、`tool_ref` 无法发现、`mcode-tools connector tools` 里没有 computer 能力），所以「亲自操作 Claude Code」这一步没做成——改用用户 8 张截图逐张量像素替代。② 画布页面本身没删（`registry.ts` / i18n 不在路径内），只从卡片墙入口里移除。③ 侧栏内部结构（图标栏）没重做。

回收：未回收（分支与 worktree 保留给评审与后续切片）。切片 C（拖拽换位）若继续，墙模型是它的写回点（`layout-model.ts` / `usePanel.ts`）；`PanelHeader.tsx` 现已不被 `PanelZone` 渲染，接手前先确认它的新定位。
