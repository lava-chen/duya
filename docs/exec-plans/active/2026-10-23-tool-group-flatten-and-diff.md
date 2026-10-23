# 工具组 P2：压平展开层级 / diff 增强 / 路径头

状态：active · 负责人：mvs_82ed50bdb9b04e228b7d48bcb2ea011a · 更新：2026-10-23
分支：codex/claude-code-tool-group-p2 · worktree：E:\Projects\duya\.claude\worktrees\claude-code-parity · base：origin/master 7b339024 · owner：mavis
PR：https://github.com/lava-chen/duya/pull/374（P1 的 PR #368 已由用户合并，P2 另开 PR）

## 目标与边界

P1 已把「折叠行 = 分类动词 + 轮级 diffstat / caret 行尾 / 展开持久 / 分组卡片」做掉。P2 做调研文档剩下的三个差距点：**压平一层**（轮展开后直接给行列表）、**diff 增强**（语法高亮）、**展开文件路径头**。

允许修改：`packages/ui/src/components/chat/**`、`packages/ui/src/components/diff/**`、`packages/ui/src/lib/**`、`packages/ui/src/styles/**`、`packages/ui/src/i18n/**`、`packages/ui/package.json` + `package-lock.json`。

本次不做：diff 上下文行（需要带 context 的 diff 算法，调研文档自己就标了「可独立做」）；流式路径的组头（流式态需要组头折叠来保持安静，与 P1 的取舍一致）。

## 验收

- `npm run typecheck:all` / `npm run architecture:check` 通过且不新增基线指纹。
- `packages/ui` vitest 全绿；新增用例覆盖压平后的行数 / 路径头 / 高亮 token 化。
- UI 实跑：Electron dev，展开一轮只看到「卡片 + 行」，无组头；diff 有语法着色 + 路径头 + 复制。

## 进度

- [x] 压平一轮展开体（去组头，组内语义标题降级为卡内标签）
- [x] 展开卡片加完整路径头 + 复制按钮
- [x] diff 语法高亮（按行 token 化，±底色留在行容器）
- [x] 验证与 PR

## 发现与决策

- **组头不是纯冗余**：它承载 `progressTitle`（模型的 provider commentary 语义标题，如「Ran architecture gate」）。压平时不能丢——降级成卡内一行淡标签，只有存在真语义标题时才出现；分类计数摘要不重复显示（轮级行已经有了）。
- **流式态保留组头**：流式路径没有轮级汇总行，组头是唯一把一串工具调用收成安静一行的东西。压平只作用于**已结束轮次的展开体**。
- **diff 高亮走 refractor AST，不走组件**：`react-syntax-highlighter` 的 `PrismLight` 就是 `refractor/core` 的同一个单例（见 `react-syntax-highlighter/dist/esm/prism-light.js`），直接拿它的 AST 自己按行摊平，才能保留 duya 现有的「行号列 + ±底色 + 3px 左边条」布局；用组件的 `wrapLines` 会拿掉行号列的布局控制权（行号是连续序号，而 diff 的删除行/新增行各自要原文件行号）。
- **refractor 从传递依赖升为直接依赖**：它此前只是 `react-syntax-highlighter` 的传递依赖，直接 import 属于未声明依赖。已加入 `packages/ui` 的 dependencies 并同步 lock（lock 保持 CRLF，只多一行）。
- **两侧各自整篇 token 化**：删除行取旧文件、行号取旧文件号；新增行取新文件。跨行 token（块注释、模板串）因此在每一行都着色正确。
- **路径头用中段截断**，且**文件名永不截断**：读者认的是文件名，`ActionsGroup.tsx` 比没有路径更糟；让位的是中段（项目根留在头）。参考里是 `E:\…\packages\host\src\wor…PromptSystem.ts`；duya 现有 `truncatePath` 只留尾部，不够用。
- **diff 颜色统一到主题变量**：`components/diff/diff-styles.css` 此前是孤儿（没有任何文件 import 它）。现在引入 globals.css，补 `--diff-added-border` / `--diff-removed-border` 与 `--diff-syn-*` 语法色板；组件里的硬编码 `bg-[#2ea04326]` 换成 `var(--diff-added-bg)`。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| P2 全部改动 | worktree claude-code-parity | `npm run typecheck:all` | 0 | 全仓通过 |
| P2 全部改动 | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations（2 条旧指纹不再触发，未重录基线） |
| P2 全部改动 | 同上 | `npx vitest run packages/ui` | 0 | 215 文件全绿；新增 diff-highlight 9 例 + SimpleDiffViewer 4 例 |
| P2 全部改动 | Electron dev + CDP | `node docs-local/diff-verify.mjs` | 0 | 9/9 断言通过：token 类存在、颜色随主题变、行号列保留、±底色随主题变、源码文本逐字保留 |
| P2 全部改动 | Electron dev + CDP | `node docs-local/ui-verify-p2.mjs` | 0 | 20/20 断言通过：压平后 1 张卡 0 个组头、行间有分隔线、轮级体无左缩进线、路径头 + 复制按钮、卡内 diff 有高亮 |
| P2 全部改动 | Electron dev + CDP | 截图（深浅各 2 张） | — | `docs-local/research/tool-group-parity/{diff,p2}-*.png` |
| P2 重放到 origin/master 7b339024 后 | worktree claude-code-parity | `npm run architecture:check` | 0 | OK — no new boundary violations（那 2 条「不再触发」的指纹在**未改动的 origin/master 上同样出现**，是既有状态，未重录基线） |
| 同上 | 同上 | `npm run typecheck:all` + `npx vitest run packages/ui` | 0 | 见 PR #374 的 CI 证据 |

## 接续 / 结果

已实现：压平一轮展开体 / 路径头 + 复制 / diff 语法高亮（refractor AST + `--diff-syn-*` 主题色板）；已验证：typecheck、architecture、vitest、Electron dev 深浅双主题实跑（均在 origin/master 7b339024 之上复跑）；PR URL：https://github.com/lava-chen/duya/pull/374（未合并，未获授权）。
回收：未回收（PR 未集成）。
下一步：review / CI / 授权后合并。
