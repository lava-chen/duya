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
- [ ] A：列树渲染 + 归位规则（子 agent 进行中 · `codex/panel-layout-columns`）
- [x] B：脱窗 Electron 侧（子 agent）—— 已实现并验证，见「验证记录」；分支 `codex/panel-layout-detach`
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

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 96dadf4d / 仅 3 个未跟踪文件 | Windows 11 / Node 主检出 | `git worktree add .claude/worktrees/panel-layout-plan -b codex/panel-layout-plan origin/master` | 0 | worktree 列表含 5 项 |
| 96dadf4d | 同上 | Claude Desktop 布局归位实测三轮 | 行为已记录 | 见「发现与决策」 |
| B 切片 `e028447d` / 仅本切片 9 个文件 + 计划文件 | Windows 11 / Node 20 / worktree `panel-layout-detach` | `npx vitest run apps/desktop/src/main` | 0 | 296 文件通过 / 1 跳过，3564 用例通过 / 11 跳过（含新增 31 例：窗口生命周期 18 + IPC 契约 13） |
| B 切片 `e028447d` | 同上 | `npm run architecture:check` | 0 | 2792 条全部落在 baseline，无新增违规 |
| B 切片 `e028447d` | 同上 | `npm run typecheck:electron:prepared` | 0 | no new type errors（231 个既有错误 / 111 个 key） |
| B 切片 `e028447d` | 同上 | `npx tsc --noEmit --project apps/desktop/tsconfig.preload.json` | 0 | preload 无类型错误（该 project 不在任何 npm 脚本里，手工跑） |
| B 切片 `e028447d` | 同上 | `npm run typecheck:all` | 0 | 全量类型门禁通过（含 electron / evals 两道 ratchet） |
| **基线** 275dab09（同 base，未改代码） | 同上 | `npm run test:e2e:ipc` | 0 | 48 passed / 2 skipped / 0 failed（8.4m） |
| B 切片 `e028447d` | 同上 | `npm run test:e2e:ipc` | 0 | 48 passed / 2 skipped / 0 failed（8.3m）——与基线逐文件 / 逐用例一致，无新增失败 |
| B 切片 `e028447d` | 同上 | `npm run electron:build` + 真实 Electron 脚本驱动 | 0 | 见下「脱窗实测」 |

## 接续 / 结果

已实现：无（本次为首个切片落地）。已验证：调研结论与计划本身。已合并：无。

外部副作用：调研期间在 Claude Desktop 主窗开关过「终端」「文件」面板，已恢复为介入前的「更改 + 后台任务」同列（列宽 35% 与介入前一致）。

阻塞：Wave 2（C/D）依赖 A 落地。

回收：未回收（owner 会话在线，分支与 worktree 保留）。

下一步：A、B 两个子 agent 在各自 worktree 并行开工；A 完成后开 C、D。

**B 切片（脱窗 Electron 侧）结果** —— 分支 `codex/panel-layout-detach`，worktree `.claude/worktrees/panel-layout-detach`，base `275dab09`，提交 `e028447d`（PR base = master）。

已实现：独立 OS 窗口生命周期（`apps/desktop/src/main/core/panel-window-manager.ts` + `panel-window-state.ts`）、`panel-window:*` 四个 IPC 通道（`apps/desktop/src/main/ipc/panel-window-handlers.ts`）、preload 桥 `window.electronAPI.panelWindow`（`apps/desktop/src/preload/index.ts`）。已验证：单测 31 例、main 全量 3564 例、architecture:check、electron 类型门禁、e2e ipc 与同 base 逐用例一致、真实 Electron 里脱窗 / 置顶 / 原生 X 收回全链路跑通。已合并：无（未获授权，不合并）。

**脱窗实测（真实 Electron，截图见 `.e2e-userdata/panel-detach-check/evidence/`）**：主窗 `panelWindow.context = {paneId:null,pageId:null}`；`panel-window:open` 返回 `{ok:true,paneId:'pane-e2e-1',windowId:2}`，真的多出一个原生窗口（1128×878，独立标题栏，标题为面板名「终端」），URL 为 `…/dist/index.html?duyaPanel=pane-e2e-1&duyaPanelPage=terminal`，脱窗内 preload 读到 `context={paneId:'pane-e2e-1',pageId:'terminal'}`；`set-always-on-top` 后原生窗口 `isAlwaysOnTop()=true`（主窗不受影响）；点原生 X（等价 `win.close()`）后脱窗消失、主窗收到 `{type:'returned',reason:'native-close'}`、`get-state` 回到 `detached:false` 且 `alwaysOnTop:true` 保留，`{userData}/panel-window-state.json` 落盘 `{"panes":{"pane-e2e-1":{"pageId":"terminal","alwaysOnTop":true}}}`。

未完成 / 阻塞：**渲染侧仍缺**——脱窗窗口目前渲染的是完整 app 外壳，「只渲染这一个面板」要靠切片 A 读 `panelWindow.context.paneId` 后自己收敛；本切片不碰 `packages/ui/**`。B 不依赖 A 即可合入，A 的接线契约见 PR 正文。

外部副作用：本次只在 worktree 内跑真实 Electron，产物落在 `.e2e-userdata/panel-detach-check/`（未跟踪）；`packages/host/bundle/*` 等被构建改写的已跟踪文件已按「只保留本任务成果」还原。
