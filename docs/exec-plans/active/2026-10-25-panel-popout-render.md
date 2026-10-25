# 面板脱窗渲染闭环

状态：active · 负责人：本会话（claude）· 更新：2026-10-25
分支：`codex/panel-popout-render` · worktree：`.claude/worktrees/panel-popout-render` · base：`270ba528`（origin/master）· owner：claude 会话

## 背景与目标

Claude Code 桌面端实测（2026-10-25，见 `docs-local/research/claude-desktop-ui/`）确认其右侧面板是完整生命周期系统：面板可堆叠、可 toggle、可弹出为独立 OS 窗口，弹窗头部有"合并回主窗口"。duya 的对应能力（面板列树计划切片 B，PR #353）已把 Electron 侧全部建好（`panel-window:*` 四通道 + preload 桥），但切片 B 验收明确记录"渲染侧仍缺"：

1. 脱窗窗口目前渲染的是**完整 app 外壳**，没有"只渲染这一个面板"的收敛入口；
2. 主窗 `PanelCard` 没有"在新窗口打开"按钮，renderer 对 `panelWindow` **零调用**；
3. open 契约不带 `params`，file-path 类面板（preview）弹出后拿不到上下文。

本任务补齐这条链，使 duya 的面板获得与 Claude 实测一致的闭环：墙上弹出 → 独立窗口（只渲染该面板）→ 合并回 / 原生 X 收回 → 墙上恢复。

## 边界

允许修改：`packages/ui/src/components/layout/panels/**`（PanelCard、新增 detached-panel-root）、`packages/ui/src/components/layout/PanelZone.tsx`、`packages/ui/src/components/icons.tsx`（不加图标，仅 import）、`packages/ui/src/i18n/{zh,en}.ts`、`packages/ui/src/index.ts`、`packages/ui/src/styles/workspace.css`、`apps/desktop/src/main/ipc/contracts.ts`、`apps/desktop/src/main/core/panel-window-manager.ts`、`apps/desktop/src/preload/index.ts`、`apps/desktop/src/renderer/main.tsx`、新增测试。

不处理：拖拽换位（切片 C 的 `layout-model.ts` / `usePanel.ts` / `PanelHeader.tsx` 不碰）、用量浮层（切片 D）、侧栏（侧栏对齐计划在跑）、composer、`registry.ts` 面板组件实现。

## 实现

1. **契约扩展**（`contracts.ts`）：`PanelWindowOpenSchema` 加 optional `params: record(unknown)`；manager 的 `DetachPanelRequest`、additionalArguments（`--duya-panel-params=<encodeURIComponent(JSON)>`）、`buildDetachedPanelUrl` query（`duyaPanelParams`）同步；preload `PanelWindowContext` 加 `params`，`ElectronAPI.panelWindow.open` 签名加第四参。
2. **PanelCard**：头部加"在新窗口打开"（`ArrowUpRightIcon`），仅当调用方传入 `onPopout`（web 下不传 → 不渲染）；展开动作沿用 CornersOut 不冲突。
3. **PanelZone**：本地 `detachedPaneIds` 集合 —— 挂载时对每个 pane 查 `getState`，订阅 `onEvent` 维护（`opened` / `returned`）；detached 的墙格渲染**占位卡**（图标 + 标题 + "已在独立窗口打开" + 收回按钮），不挂载面板组件（webview 不双实例化），墙形状不变；PanelCard 接 `onPopout` → `open(paneId, pageId, title, params)`。
4. **DetachedPanelRoot**（新组件，进 barrel）：读 `panelWindow.context`，头部 = 图标 + 标题 + 置顶切换（Pin）+ 合并回（ArrowDownLeft → `close()` 无参 = 返回自己），body = `<Suspense>` 包 registry 组件（`tab = {id: paneId, pageId, title, params: context.params}`）。
5. **main.tsx 分流**：`panelWindow.context.paneId` 非空 → 渲染 `DetachedPanelRoot`，`<App/>` 及其全部副作用（会话订阅、scheduled-turns、mailbox listener）不启动。
6. **i18n**：`panel.openInNewWindow` / `panel.detachedRunning` / `panel.returnToMain` / `panel.alwaysOnTop` / `panel.alwaysOnTopOff`（zh + en）。

## 验收

- `npm run typecheck:all` 0（含 electron gate）
- `npm run architecture:check` 0，不加指纹
- `npx vitest run packages/ui/src/components/layout` 0（先记录同 base 基线）
- `npx vitest run apps/desktop/src/main` 0（panel-window 既有 31 例 + params 用例）
- 真实 Electron：面板弹出为独立窗口且只渲染该面板；合并回/原生 X 后墙上恢复；preview（带 filePath params）弹出可用

## 进度

- [x] Claude Desktop 实测（三区域交互全集 + resize 交互细节，截图在 docs-local/research/claude-desktop-ui/）
- [x] 读 B 切片契约与 panel-window-manager 实现
- [x] 契约扩展（contracts / manager / preload，`z.record(z.string(), z.unknown())` 适配 zod v4）
- [x] PanelCard popout 按钮 + PanelZone detached 占位与事件同步
- [x] DetachedPanelRoot + main.tsx 分流
- [x] i18n + 样式
- [x] resize 交互实测：分隔条 = slider thumb，值=一侧面板百分比（a11y `Resize A and B = N`），键盘步进 ~1.6%/键、下限 10%；聚焦态蓝色指示条、拖拽态 "Resize" 药丸 + 指示条；聊天列可压至 ~190px
- [x] resize 视觉统一：ResizeHandle 药丸指示条（沿缝方向 36×4，拖拽 56×4 + accent）+ 拖拽中 "调整大小" badge；覆盖面板墙列/行分隔、面板区左缘、侧栏边缘
- [x] 第二轮实测补充：`+` 的 "Clear context" chip 是用户安装的 Claude Mod 渲染（非原生，笔记已更正）；session rail 四卡（Context/Connectors/Environment/Changes）与折叠摘要模式实测
- [x] TaskDrawer → session rail：overlay 抽屉改 `.chat-body-row` 内常驻挤压列；section 卡片化；新增 ContextCard（46% used + 分段色条 + 10 桶图例，读 context-usage-store，零桶隐藏、free space 收尾）；窄容器 ≤980px 退回 overlay
- [x] 门禁：ui tsc 0、layout vitest **227 例** 0（含 ContextCard 3 例）、typecheck:all 0、architecture:check 0
- [ ] 真机 Electron 冒烟（弹出/收回 + rail 挤压列 + Context 卡数据）
- [ ] PR
