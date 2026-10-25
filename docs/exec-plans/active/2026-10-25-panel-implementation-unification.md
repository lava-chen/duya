# 面板实现统一：预览收敛到 workspace、审查 diff 收敛到 @pierre/diffs

状态：active · 负责人：panel-unification 会话 · 更新：2026-10-25
分支：codex/panel-unification · worktree：.claude/worktrees/panel-unification · base：270ba52869b6414094e553dd7f9abde5a1e429f7 · owner：本会话

## 目标与边界

用户观察到"代码预览面板和代码审查面板各有两套实现"。指示：保留后来实现，删除旧的，统一调用侧。

- 预览：保留 `workspace` 页（FileWorkspacePanel + CodeSurface，2026-10-22 ce77b467），删除 `preview` 页（FilePreviewPanel + PanelFileTreeSplit）。聊天链路已在 `duya:open-file-preview-panel` → workspace（usePanel.ts:742），残余调用侧（FileTreePanel 文件树点击）改走同一事件契约。
- 审查：CodeReviewPanel 的 diff 模式从手写 UnifiedHunk/SplitHunk 换成 @pierre/diffs 的 `PatchDiff`（plan 572 引入的库，preview 模式已在用其 `File`）；删除手写 hunk 渲染与 `collapseContextLines`/`toSplitRows`。
- 允许修改：packages/ui 内面板、hooks、lib、i18n、styles；相关测试。
- 不处理：TUI diff 视图、聊天工具行内 diff、files 页（FileTreePanel 本体保留）、`@pierre/diffs` 依赖版本、行评论接入 diff 模式（保持现状：评论只在 preview 模式）。

## 验收

- `npx vitest run packages/ui/src/lib/chat-file-links.test.ts packages/ui/src/components/layout/panels/code-review-diff.test.ts packages/ui/src/components/file-workspace` 及其余受影响测试通过（先记录 base 失败基线）。
- `npm run typecheck:all`、`npm run architecture:check` 通过（baseline 之外零新增）。
- 全仓 `rg -l "FilePreviewPanel|PanelFileTreeSplit|panel\.preview|preview-focus-lines"` 零生产引用（历史计划文档除外）。
- UI 改动按测试指南应真跑 Playwright MCP；本环境 Electron 不可 Playwright（记忆约束），以 typecheck + vitest 覆盖 + 真机冒烟待办记录，PR 注明。

## 进度

- [x] 勘察两套实现的全部调用点（见发现）
- [x] S1 预览侧统一：删 preview 页与旧组件，残余调用改走 workspace 契约
- [x] S2 审查侧统一：diff 模式换 PatchDiff，删手写 hunk 渲染
- [x] 门禁：typecheck:all + architecture:check + 相关 vitest
- [x] commit + PR（draft，等真机冒烟）

## 发现与决策

- 聊天链路已统一：`duya:open-file-preview-panel` 事件在 usePanel.ts:701-756 内部已路由到 workspace 页 + `duya:workspace-open-file`（带 lineStart）。`preview` 页仅剩 FileTreePanel:315（文件树点击）等残余。
- FileWorkspacePanel 能力完备：text/image/pdf/markdown/html/unsupported 全覆盖，同用 `files.preview` IPC；文档内评论是本地 Map（未接 code-comment-store，本任务不动）。
- `duya:preview-focus-lines` 唯一消费者是 FilePreviewPanel（已删）；lineStart/lineEnd 由 usePanel 转发到 workspace 事件，该 follow-up 事件随组件一起删，chat-file-links 测试同步更新。
- `workspaceTreeOpen`/`setWorkspaceTreeOpen`（PanelProvider 状态）唯一消费者是 FilePreviewPanel + PanelFileTreeSplit，已随删（含持久化字段；旧 payload 缺字段时按 undefined 容忍，loadPersistedState 逐字段读取）。
- @pierre/diffs 1.5.1 `PatchDiff` 直吃 patch 字符串；`BaseDiffOptions.diffStyle: 'unified'|'split'`、`expandUnchanged`、`collapsedContextThreshold` 原生支持分栏与折叠上下文。无空白可视化（·/→）等价物 → 「显示空白字符」开关删除（PR 注明）。
- `parseReviewPatch` 增加 `raw` 字段（含 `diff --git` 行的每文件 verbatim patch），供 PatchDiff 直接消费；hunks 仍用于 diffstat。
- WALL_EVENT_PAGE_IDS 无任何导入者（死代码），已随 preview 删除。
- 旧 localStorage 持久化的 preview 页签被 loadPersistedState 的 isPageId 校验静默丢弃；补了一条回归测试钉住该行为。
- `panels/CodeReviewPanel.test.tsx` 与 `panels/__tests__/CodeReviewPanel.test.tsx` 是并存的两个测试文件（又一个"两套"回声）；本次各自适配新渲染器，未合并（超范围）。
- PatchDiff 在 jsdom 需要 `ResizeObserver` 与 `CSSStyleSheet.replaceSync` stub（真实 renderer 无此问题）；Shadow DOM 查询不可达，一个测试文件用 light-DOM stub 保留内容断言语义。
- **architecture baseline 债务观察**：checker 报告 2 条指纹因本次删除失效；但 baseline（2530 条）与当前 master 代码之间本就存在约 113 条陈旧指纹与漂移（`--write` 会净增 426 条）。门禁仍 OK（blocking=0）。定点收缩需在 master 层面统一重录 baseline，不属本任务，未动 baseline。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 270ba528（base，主检出） | Win11 / Node v24.16.0 / Git Bash | `npx vitest run packages/ui/src/hooks packages/ui/src/components/layout packages/ui/src/components/file-workspace packages/ui/src/lib/chat-file-links.test.ts` | 0；400/400 通过 | 基线绿，无预存失败 |
| 本任务 dirty（S1+S2 全部） | Win11 / Node v24.16.0 | 同上批测试（worktree 内） | 0；401/401 通过（+1 新增持久化丢弃用例） | 无回归 |
| 本任务 dirty | 同上 | `npm run typecheck:all` | 0；0 error | |
| 本任务 dirty | 同上 | `npm run architecture:check` | 0；OK — no new boundary violations（2 条指纹失效提示，见发现） | |
| 本任务 dirty | 同上 | `npx vitest run .../code-review-diff.test.ts .../code-review-status-colors.test.ts .../__tests__/CodeReviewPanel.test.tsx .../CodeReviewPanel.test.tsx` | 0；29/29 通过 | |
| 未执行 | — | Electron 真机冒烟（面板打开/聊天链接/workspace 页/diff 模式视觉） | 待办 | Electron 不能跑 Playwright（环境约束）；PR 注明 |

## 接续 / 结果

已实现：S1+S2 落码并过全部可跑门禁；已验证：上表与 e2e（`e2e/ipc/file-workspace.spec.ts` 1 passed）及合并后 CI 5 项 SUCCESS；未验证：Electron 真机视觉/交互冒烟。
PR：https://github.com/lava-chen/duya/pull/486（merged，`147ceda3`）
回收：worktree 可回收（分支已并入 master）。
下一步：真机冒烟（聊天链接/文件树打开 → workspace 页；审查面板 diff 模式分栏与折叠交互）；发现问题开新分支修复并走 PR。

