# Plan 527: Dock 布局树与智能窗口管理

**Status**: Planning（2026-09-13 立项）
**Motivation**: 当前布局写死在 `app-shell.tsx`（Sidebar | 主列单视图 | PanelZone 单面板区），
session 视图与 conductor 画布只能二选一占据主列，无法分屏对比、无法弹出独立窗口。
目标是对齐 VS Code 式的 dock 体验：session / 画布 / 各面板可拖拽到任意分区、
任意组合分屏，并可将任意叶子 detach 为独立 BrowserWindow。

## 现状盘点（2026-09-13 调研结论）

- 布局树写死：`src/components/layout/app-shell.tsx:175`；
  PanelZone（`src/components/layout/PanelZone.tsx`）= 右侧单面板区 + tab + 手写拖宽。
- 面板注册表：`src/components/layout/panels/registry.ts`（8 种 PageId，含
  `multiInstance`/`minWidth`/`widthRatio` 声明），重面板 lazy-load。
- 布局持久化雏形：`usePanel.ts` 的 `duya:panel:v2:{sessionKey}`（tabs/activeTab/
  panelOpen/panelView）+ `duya:panel:user-widths:v1`；读取时按 registry 校验丢未知 id。
- session 视图：`ChatView.tsx` 由 `App.tsx` 按 conversation-store 切换后塞入 `<main>`；
  耦合点 = zustand 单例 store。同进程多订阅已支持（`stream-session-manager`
  每 session 持 listeners Set）。
- conductor 画布已示范双挂载形态：全屏 `ConductorView` / 内嵌 `SidebarConductorView`。
- 窗口侧：主窗口 bounds 已持久化（`electron/core/window-state.ts`，plan 331）；
  orb 已示范第二窗口独立入口（`wake.ts` ensureOrb）；MessagePortMain（config/conductor
  port）与 `BrowserWindow.getAllWindows()` 广播（`mailbox-broadcaster.ts`）两条通道现成。
- Agent Server 是进程级 HTTP 服务：任何窗口经 `agent-server:getPort` 均可自建 SSE 流，
  断线续传走 `fetchHistory(sessionId, sinceEventId)`。
- 依赖现状：已有 `react-grid-layout`（仪表盘网格语义，不适合 dock）、zustand、
  framer-motion；**没有** react-resizable-panels / dnd-kit / golden-layout。

## 设计决策

1. **布局数据结构** = 递归 dock 树：
   `{ type: 'split', dir, children, sizes } | { type: 'tab', children: LeafId[], active }`，
   叶子为 `viewId` 字符串（`session:<threadId>` / `conductor:<canvasId>` / `files` /
   `preview` / `review` / `terminal` / `browser` / `bot-settings:<id>` …）。
   viewId 是跨 Phase 的序列化契约，Phase 1 就定死。
2. **库选型**：`react-resizable-panels`（分屏）+ 拖拽手势（dnd-kit 或继续手写
   mousemove）；不复用 react-grid-layout，不引入 golden-layout（重、主题难融）。
3. **统一可拖拽内容抽象**：把 `PAGE_REGISTRY` 泛化为全局 `DOCKABLE_REGISTRY`，
   叶子组件统一签名 `{ viewId, focused }`；session 照 conductor 双形态模式写
   `EmbeddedSessionView`（ChatView 的 conversation-store 依赖收窄为 props/context）。
4. **detach 优先做命令式**（tab 右键弹出/吸附），真跨窗口拖拽放 Phase 3 可选——
   HTML5 drag 不能跨 renderer 进程，跨窗拖拽需主进程全程仲裁，成本最高且体验增益小。
5. **落地方式**：框架级多模块改动，按 AGENTS.md 走 worktree + PR（`gh pr merge --merge`）。

## Phase 1 — 窗口内 dock（session/画布任意分屏）

- [ ] 新增依赖 `react-resizable-panels`（评估拖拽是否需要 dnd-kit，能手写则不引）。
- [ ] `src/components/layout/dock/`：DockTree 类型 + 纯函数模块
      （insert/detach leaf、split/tab 互转、sizes 归一化、viewId parse/serialize）。
      纯函数必须可单测（沿用现有 `*.test.ts` colocated 惯例）。
- [ ] `DOCKABLE_REGISTRY`：泛化 `PAGE_REGISTRY` 为全局注册表，每项声明
      `parse(viewId)`、组件、`minSize`、`title/icon`、是否 multiInstance；
      未知 viewId 校验丢弃逻辑照搬 `usePanel.ts` 现行为。
- [ ] `DockRoot` 组件替换 `app-shell.tsx` 的 `app-main + PanelZone` 固定分栏：
      递归渲染 split/tab，拖 leaf 标签落到半区高亮 drop indicator。
- [ ] `EmbeddedSessionView`：ChatView 解耦——`useConversationStore` 的读写收窄为
      props/context 注入，支持同一 session 渲染在多个 dock 叶子（依赖 listeners Set
      的既有能力）。
- [ ] conductor 画布从 PanelZone 专属页签迁入 registry（复用 SidebarConductorView）。
- [ ] 布局树持久化 v3：工作区级整树存 userData JSON 文件（沿用 `window-state.ts`
      原子写 + 校验模式）；per-session tab 归属与宽度沿用/迁移 localStorage 键，
      `duya:panel:v2` 读旧写新。
- [ ] 侧栏宽度（现 `app-shell.tsx:43` 纯 useState）并入持久化。
- [ ] 单测：dock 纯函数（树变换边界：删叶子收链、单子折叠、tab 拖空）、
      registry 校验、持久化 v2→v3 迁移。

## Phase 2 — detach 为独立 BrowserWindow

- [ ] renderer 入口参数化：同一 renderer URL + `?window=<kind>&...` 参数；
      renderer 侧白名单校验 kind，不接受任意视图加载。
- [ ] `electron/core/window-manager.ts` 扩展 `createDetachedView(options)` +
      子窗口 registry（父子关系登记：随父关闭、焦点联动、托盘 hide 行为对齐）。
- [ ] `window-state.ts` 泛化为多窗口持久化（`window-state.json` 改按 windowId 数组，
      兼容读旧单对象格式）。
- [ ] 子窗口数据通道：复用 preload + `agent-server:getPort` 直连 SSE（不转发流）；
      会话生命周期/侧栏状态等跨窗同步用 `mailbox-broadcaster` 的
      `getAllWindows()` 广播模式。
- [ ] 交互入口：dock leaf tab 右键 →「弹出为窗口」/ 子窗口 →「吸附回主窗口」
      （detach = 主窗布局树删叶子 + 子窗建同 viewId；attach 反向）。
- [ ] attach 时子窗口 store 状态丢弃、主窗重订阅（不要求实时状态迁移）。
- [ ] electron 侧类型检查：`npx tsc -p electron/tsconfig.json`
      （typecheck:all 不覆盖 electron/，见 AGENTS.md）。

## Phase 3 — 跨窗口拖拽（可选，默认不做）

- [ ] 源窗口 dragover 坐标持续 IPC → 主进程判断悬停窗口 → 转发目标窗口渲染
      drop indicator → drop 时主进程仲裁：源窗删叶、目标窗插入同 viewId。
- [ ] 仅当 Phase 2 的命令式 detach/attach 实测后仍被体验卡脖子时才立项。

## Verification

- `npx vitest run src/components/layout/` — dock 纯函数 / registry / 迁移测试绿。
- `npm run typecheck:all` + `npx tsc -p electron/tsconfig.json`（改 electron 文件时）。
- 手动冒烟必须在真实 Electron renderer 里做（preload/MessagePort 路径，
  浏览器 Vite 不算）：分屏拖拽、持久化重开还原、detach 弹窗后 SSE 续流、
  attach 回收、打包版（`electron:pack`）子窗口 preload 生效。
- 本环境不跑 Playwright UI 验证（Electron 无法在其下运行），以 typecheck + Vitest
  + 手动冒烟为准。

## Follow-ups（不在本 plan）

- 跨窗口拖拽细节协议（Phase 3 立项时细化）。
- orb 窗口纳入同一 window registry 统一生命周期。
- 布局树按「项目/工作区 profile」多套保存与快速切换。
