# Plan: Popover Auto-flip on Viewport Overflow

> **Status**: In Progress
> **Priority**: P1
> **Created**: 2026-09-03

## Goal

让 duya 的每一个 anchor-anchored popover（hover / click / autocomplete）都自动避开
被裁剪/被遮挡的位置——不够空间朝下就翻上去，不够空间朝上就翻下来，并且能自动
shift 水平溢出。统一手段，消灭散点 `getBoundingClientRect + bottom-full/top-full`
魔法定位。

## Why

现状：每个 popover（`HoverPopover` / `SlashCommandPopover` / `ModelSelector` /
`FilePreviewPanel` 的 file-preview-open-menu / 各种 `position: fixed` overlay）
各自用以下三种手法定位，缺乏 viewport 边界检测：

1. 写死 placement（如 `SlashCommandPopover` 一律 `placement='top'`，触发器贴底
   时整张面板被裁）。
2. `className` toggle 二选一（`ModelSelector.tsx:163` `placement === 'below' ? 'top-full mt-1' : 'bottom-full mb-1'`）。
3. 自己拿 `getBoundingClientRect()` + `style.left / style.top` 算一次性坐标
   （`CodeReviewPanel.tsx:266`、`PanelHeader.tsx` 等）。

结果：触发器靠近 chat-input 底、靠近侧栏顶、靠近 viewport 边缘时，多处面板
会被裁掉或贴住工具栏。

`HoverPopover.tsx:21-23` 已经把这个分工约定写进注释：

> Positioning: purely declarative via props, no runtime measurement.
> Callers that need measured positioning (e.g., flip on overflow) can layer
> their own useLayoutEffect on top by passing `popoverStyle`.

允许继续散点修，但每加一个新 popover 都要重做一次，注定翻车。

## Scope

- [ ] 引入 `@floating-ui/react`（约 12 KB gzipped，零运行时痛点）。
- [ ] 新增 `src/components/ui/usePopoverPlacement.ts` —— 统一 hook，封装
      `useFloating({ placement, middleware: [flip(), shift({padding: 8})],
      whileElementsMounted: autoUpdate })`。
- [ ] 让 `HoverPopover` 消费这个 hook（替换 `basePopoverStyle` 的轴向魔法）。
      同时确认 `portal` 那段 hack（避免 `overflow: hidden` 父元素裁切）
      在 floating 接管定位后是否还需要。
- [ ] 列出迁移候选表（`SlashCommandPopover` / `ModelSelector` /
      `ModelProviderSelector` / `FilePreviewPanel` 的 file-preview-open-menu
      / `PermissionReviewDialog`），分批改；不在本 plan 内一次性全切。
- [ ] 在 Playwright MCP 里跑两个验证用例：
      1. chat input 贴底部触发 slash command → popover 出现在上方；
      2. ModelSelector 贴近视窗底 → 候选面板出现在按钮上方。
- [ ] `npm run typecheck:all` 通过。

## Guardrails

- 严格保留各 popover 现有的 `popoverClassName` / 视觉样式（只换定位策略）。
- 不动 popover 外的触发逻辑（hover-open / click-open / openDelay）。
- 迁移要 atomic —— 每个 popover 独立 commit、独立 plan checkbox 勾选。
- 不要把 switch / dialog / 全屏 overlay 卷进来；这一轮只处理
  anchor-anchored popover。

## Out of Scope

- popover 进入/退出动画（`HoverPopover` 当前也无动画）。
- arrow / 三角指示（floating-ui 支持但先不上，避免视觉 diff）。
- dropdown menu / context menu —— 它们有自己的 trigger rect 体系，
  走 `Menu.tsx` 单独再开一 plan。

## Files Touched

- `package.json` — 加 `@floating-ui/react`
- `src/components/ui/usePopoverPlacement.ts` — 新增
- `src/components/ui/HoverPopover.tsx` — 改造定位
- `docs/exec-plans/README.md` — 添加 active 索引（plan 创建脚本通常自动做）

## Verification

- 单元：`vitest run src/components/ui/usePopoverPlacement.test.ts`
  （测 hook 在 `jsdom` 里不同 `innerHeight` 下的 placement 翻转）。
- 视觉：Playwright MCP，两个 case（如上）。
- 全量：`npm run typecheck:all`。
