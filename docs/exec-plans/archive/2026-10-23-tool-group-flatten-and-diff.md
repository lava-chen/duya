# 工具组 P2：组级折叠态 / diff 增强 / 路径头

状态：done · 负责人：mvs_82ed50bdb9b04e228b7d48bcb2ea011a · 更新：2026-10-23
分支：codex/claude-code-tool-group-p2 · worktree：E:\Projects\duya\.claude\worktrees\claude-code-parity · base：origin/master 7b339024 · owner：mavis
PR：https://github.com/lava-chen/duya/pull/374（已合并 `43df59f4`）

## 目标与边界

P1 把折叠行改成了「分类动词 + 轮级 diffstat」，P2 原计划再压平一层。用户验收后确认 **duya 原本的分层是对的**：轮级折叠行只报耗时；展开后**两段 txt 之间的工具/思考算一组**，由组的折叠行承载统计。

因此本分支同时回退 P1 的轮级统计与 P2 的压平，恢复组级折叠态；P2 的路径头与 diff 高亮保留。

允许修改：`packages/ui/src/components/chat/**`、`packages/ui/src/components/diff/**`、`packages/ui/src/lib/**`、`packages/ui/src/styles/**`、`packages/ui/src/i18n/**`、`packages/ui/package.json` + `package-lock.json`。

## 验收

- `npm run typecheck:all` / `npm run architecture:check` 通过且不新增基线指纹。
- `packages/ui` vitest 全绿；新增用例覆盖「轮级只有耗时」「组级折叠行带统计 + diffstat」。
- UI 实跑（Electron dev，深浅双主题）：轮行 = `耗时 37m 32s ›`；展开后每组一行 `已编辑 1 个文件，已运行 1 次命令 · x.ts +2 -1 ✓ ›`；再展开出工具行卡片。

## 进度

- [x] 回退 P1 轮级统计：轮折叠行只剩耗时
- [x] 恢复组级折叠态：组头 = 语义描述 + 组级 diffstat，可展开
- [x] diffstat 徽标对齐参考图（始终 `+N -M`，改用 `--diff-*` 主题变量，贴紧文字）
- [x] 保留 P2：展开文件路径头 + 复制按钮、diff 语法高亮
- [x] 验证与 PR

## 发现与决策

- **「txt 之间的工具算一组」是天然规则**：`segments.ts` 里 text/widget 会 flush 当前 run，所以两段 txt 之间的工具/思考本来就是**一个 group**，组级统计口径与参考图天然一致，不需要新的切分逻辑。
- **语义描述在 duya 侧极罕见**：全量扫 1144 个 rollout，`progressTitle` 只出现 15 处 / 3 个会话。所以组头以分类动词为主，只有存在真语义标题时才用模型的原话（`resolveGroupDisplayTitle` 已有这个优先级：语义标题 → 分类动词 + 文件名）。
- **组级 diffstat 与行级同源**：`aggregateFileEditStats` 和行级的 `computeFileEditStats` 是同一份数字，组徽标必然等于组内各行之和（已用断言锁住）。
- **老会话的 edit 行没有行级 stat**：老会话的 edit 结果格式解析不出来（`parseEditResult` 返回 null），input 里也没有 old/new string，所以老会话只统计得到 create。**既有数据限制，不是本次改动引入。**
- **diff 高亮走 refractor AST，不走组件**：`react-syntax-highlighter` 的 `PrismLight` 就是 `refractor/core` 的同一个单例，自己按行摊平 AST 才能保留 duya 现有的「行号列 + ±底色 + 左边条」布局（组件的 `wrapLines` 会拿掉行号列的控制权）。
- **两侧各自整篇 token 化**：删除行取旧文件、行号取旧文件号；新增行取新文件。跨行 token（块注释、模板串）因此每行着色都正确。
- **路径头用中段截断**，且**文件名永不截断**：读者认的是文件名，让位的是中段。
- **diff 颜色统一到主题变量**：`components/diff/diff-styles.css` 此前是孤儿文件，现在引入 globals.css，并补 `--diff-added-border` / `--diff-removed-border` 与 `--diff-syn-*` 语法色板。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| 本分支全部改动 | worktree claude-code-parity | `npm run typecheck:all` | 0 | 全仓通过 |
| 同上 | 同上 | `npm run architecture:check` | 0 | OK — no new boundary violations（2 条旧指纹不再触发，未重录基线） |
| 同上 | 同上 | `npx vitest run packages/ui` | 0 | 216 文件全绿；新增 DiffStatBadge 3 例 + 轮级/组级折叠态用例 |
| 同上 | Electron dev + CDP | `node docs-local/ui-verify-p3.mjs` | 0 | 全部断言通过：轮行只有耗时、组行带 `+2 -1`、组体默认折叠、展开出带分隔线的卡片、组统计 = 行统计之和、路径头 + 复制 + diff 高亮 |
| 同上 | Electron dev + CDP | `node docs-local/verify-collapsed.mjs` | 0 | 真实会话无报错：轮行 `耗时 1m 8s / 3m 2s / 37m 32s`，展开后组行出现，无压平卡 |
| 同上 | 截图（深浅各 3 张） | — | — | `docs-local/research/tool-group-parity/p3-*.png`、`docs-local/verify/*.png` |
| P2 早期改动 | 同上 | `node docs-local/diff-verify.mjs` | 0 | 9/9：token 类存在、颜色随主题变、行号列保留、±底色随主题变、源码逐字保留 |

## 接续 / 结果

已实现：轮级回到「耗时」、组级折叠态恢复（语义描述 + 组级 diffstat）、diffstat 徽标对齐参考图；P2 的路径头 + 复制 / diff 语法高亮保留。已验证：typecheck、architecture、vitest、Electron dev 深浅双主题实跑（真实会话 + 组件 harness）。PR：https://github.com/lava-chen/duya/pull/374（已合并 `43df59f4`）。
回收：已合并回收。
下一步：无。后续若要再动工具组的折叠态分层，先读这份和 P1 那份归档计划——两份都记了各自改了什么、为什么被改回去。
