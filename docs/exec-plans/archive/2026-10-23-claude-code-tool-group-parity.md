# Claude Code 式工具组 UI 对齐（轮级汇总 / caret / 展开持久）

状态：done · 负责人：mvs_82ed50bdb9b04e228b7d48bcb2ea011a · 更新：2026-10-23
分支：codex/claude-code-tool-group-parity · worktree：E:\Projects\duya\.claude\worktrees\claude-code-parity · base：a37c5d68 · owner：mavis
PR：https://github.com/lava-chen/duya/pull/368（已合并 `2c91e9b7`）

## 目标与边界

用户可观察的变化：聊天转录里每轮工具活动折叠为一行**分类动词 + 轮级 diffstat**（对齐 Claude Code / Codex），caret 改到行尾且常显，展开态跨重渲染保留。

允许修改：`packages/ui/src/components/chat/**`、`packages/ui/src/i18n/**`、`packages/ui/src/styles/**`。
本次不做（留后续）：压平 3 层结构、diff 语法高亮 / 上下文行 / 内部滚动、展开卡片完整路径头。

关联：调研见 `docs-local/research/codex-transcript-ui/codex-vs-duya-tool-group.md`；Claude Code 实测见本计划「发现」；截图 `docs-local/research/tool-group-parity/`。

## 验收

- `npm run typecheck:all` 通过；`npm run architecture:check` 通过且不新增基线指纹。
- `packages/ui` 相关 vitest 全绿；新增轮级汇总单测覆盖分类计数、diffstat 聚合、截断。
- UI 实跑：Electron 起 dev，折叠行显示「分类动词 + +N −M」，caret 行尾常显，展开后分组呈边框卡片。

## 进度

- [x] computer-use 实测 Claude Code（Desktop Code 标签页）取事实
- [x] 开 linked worktree、配置 junction
- [x] 轮级汇总行：分类动词 + 轮级 diffstat
- [x] caret 移到行尾并常显
- [x] 轮级展开状态持久化
- [x] 分组展开体改边框卡片 + 行分隔线
- [x] 验证与 PR

## 发现与决策

- Claude Code 轮级摘要实测为 `Created a file, read a file, edited 2 files, ran 13 commands +272 −77`（AX 树 Button 名），与调研文档的 Codex 截图 `Edited 6 files, read 4 files, ran 3 commands +23 −14` 同构：**分类动词在前、轮级 diffstat 固定在末尾**。两个参考互相独立证实差距点 1。
- Claude Code 的 caret 在**行尾**且常显（`… +272 −77 ›`），duya 在行首且悬停才显。按参考统一到行尾。
- Claude Code 把「创建文件」与「编辑文件」分成两个动词（`Created a file` / `edited 2 files`）。duya 现有 `classify` 把 write/create 并入 `editFiles`，本轮拆出 `createFiles` 类别（新增 i18n 键 `groupSummary.createFiles.*`）。
- 轮级 diffstat 直接复用每行已有的 `computeFileEditStats`（抽到 `tools/fileEditStats.ts` 共享），按轮求和；折叠行的数字与展开后每行数字必然一致（UI 实跑断言过：轮级 `+2-1` == 各行之和）。
- 分类顺序按参考定为「文件类 → 命令 → 其他」（`editFiles → createFiles → readFiles → commands → …`），轮级与组头共用同一个顺序表，避免同一屏里两套语序。
- 轮级预算比组头宽（5 类 vs 3 类）：参考里一轮常见 create+read+edit+commands 四类，组头那套 3 类预算会把「已运行 N 次命令」折进「+N more」。
- 轮级 diffstat 紧跟动词短语（不右对齐），因为参考就是 `… ran 13 commands +272 −77` 连读；组头的 diffstat 走共享行 chrome 的右对齐尾槽，与 duya 其它行一致。
- Claude Code 展开后是**整块边框圆角卡 + 行分隔线**，故把 Group body 改成卡片（`--border` 描边 + `--surface` 底 + `--border-weak` 行分隔线，全用主题变量，禁 `dark:`）；Group 头暂留（压平属后续）。
- 展开态持久化：`Group.tsx` 的模块级 Map 抽成共享 `tools/expansionStore.ts`（组级 / 轮级两个 scope），轮级 key 取该轮首个 tool_use id。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| a37c5d68 干净 | Windows / Node 24 | computer_use 实测 Claude Desktop Code 页 | 取得 13 条轮级摘要 AX 名 | AX 树 Button 名清单 |
| a37c5d68 干净 | Windows / Node 24 | `node scripts/junction-worktree.mjs .` | 0，62 link | worktree node_modules 存在 |
| 改动后 | Windows / Node 24 | `npx vitest run packages/ui` | 0，212 文件 / 2224 用例全绿 | vitest 输出 |
| 改动后 | Windows / Node 24 | `npm run typecheck:all` | 0 | 各包 tsc + eval 检查全过 |
| 改动后 | Windows / Node 24 | `npm run architecture:check` | 0，`OK — no new boundary violations` | baseline 2785，未重录 |
| 改动后 | Windows / Node 24 / Electron dev | CDP + Playwright 实跑（浅色/深色） | 断言全过 | 轮级 `+2-1` == 各行之和；caret 在行尾常显；卡片 1px `--border` + 6.4px 圆角 + 行分隔线 |

## 接续 / 结果

已实现：轮级汇总行（分类动词 + 聚合 diffstat）、分类顺序文件优先、create 独立成类、caret 行尾常显、轮级展开态持久化、分组展开体卡片化。
已验证：`typecheck:all` / `architecture:check` / packages/ui 全量 vitest / Electron dev 实跑（双主题，断言 + 截图）。
PR URL：https://github.com/lava-chen/duya/pull/368（已合并 `2c91e9b7`）。

回收：已合并回收。
下一步：P2（[工具组 P2](2026-10-23-tool-group-flatten-and-diff.md)）已合并 `43df59f4`。**注意 P2 把本计划的轮级统计回退了**——轮级折叠行改回只报耗时，统计移回组级折叠行（分层契约见 P2 计划的「发现与决策」）。本计划里的「轮级 diffstat 紧跟动词短语」不再是当前形态。
