# CLI TUI 渲染 todolist

状态：active · 负责人：mavis · 更新：2026-10-23
分支：codex/tui-todo-list · worktree：.claude/worktrees/tui-todo-list · base：c81ed169 · owner：mavis

## 目标与边界

用户能观察到的变化：

1. 模型调用 `todo` 工具后，transcript 里出现可读的清单行（`✔ Todo list 2/5` + 每项一个状态标记），
   取代现在的 `todo(todo-1, todo-2)` 加一坨 JSON。
2. 折叠的 thinking 段落只占**一行**，不再是一行预览加三行 overflow。

允许修改：`packages/cli/src/tui/**`（todo 解析与渲染、thinking 预览预算）及其测试。
本次不做：底部常驻 todo 面板与快捷键（minimax-code 的 `TuiTodoPanel`），留 Phase 2。
关联参考：`E:\cloned-projects\codex`（`codex-rs/tui/src/history_cell/plans.rs`）、
`E:\cloned-projects\minimax-code`（`packages/tui/src/tui/todo/`、`shell/todo-panel.ts`、`transcript/view.ts`）。

## 验收

- `npx vitest run packages/cli/src/tui/__tests__/` 全绿
- `npm run typecheck:all` 退出码 0
- `npm run architecture:check` 退出码 0
- 新增用例覆盖：todo 结果解析、清单渲染、todo 不与其他 tool 合并成 batch、缓存 key 随状态变化

## 进度

- [x] 读完两个参考项目的 todo 渲染实现
- [x] 确认 duya CLI 缺口：`BlockKind` 无 todo；`tool-render.ts` 只认 grep/glob
- [x] 分配 worktree、构建包、记录基线
- [x] 新增 `packages/cli/src/tui/todo.ts`：类型 + 结果解析 + 计数
- [x] `blocks.ts`：`ToolBlock` 带 `todos`；`completeTool` 解析 todo 结果
- [x] `transcript-view.ts`：todo 行头 + 清单 body；todo 不参与 batch 合并
- [x] `transcript-cache.ts`：缓存 key 纳入 todos
- [x] thinking 折叠预览由三行改一行，并去掉独立的 overflow 行
- [x] 测试 + typecheck + architecture:check
- [x] commit + PR（#387，draft）

## 发现与决策

- codex 与 minimax-code 的**共同底座**是 transcript 里的独立清单单元：codex 的 `PlanUpdateCell`
  （`history_cell/plans.rs:85`，标记 `✔ `/`□ `），minimax-code 的 `kind:'todo'` cell
  （`transcript/view.ts:1027`，标记 `✓`/`●`/`×`/`○`）。minimax-code 在此之上**多一层**底部面板
  （`shell/todo-panel.ts`，紧凑/展开两态 + Ctrl+T）。本次落共同底座，面板列 Phase 2。
- duya 的 todo 工具返回**全量**列表（merge 语义，`TodoTool.ts:111`），每次工具结果都是完整快照，
  因此不需要新增事件通道——从既有 `tool.call_completed` 的 result 解析即可。
- duya 的 footer 是固定两行（`footer.ts:9`，"Two rows, never three"），加常驻面板要动布局，
  收益不足以在本次承担。
- duya 已有「renderer follows the tool」层（`tool-render.ts:11-22`），todo 渲染按该哲学落位，
  `transcript-view.ts` 只做分派。
- todo 工具连续两次写入是两个**不同的列表**，不能像 `read` 那样合成 batch header。
- thinking 折叠预览按用户要求压到一行：**head 一行 + 预览一行**，不再有独立的 `… N more lines` 行。
  边沿规则不变（流式取尾、封口取头），`[+]`/`[-]` 仍是展开开关。
- `Styles` 的函数各自只包**一层** tag，嵌套调用（`styles.muted(styles.strike(x))`）会把内层
  tag 当文本转义。清单的完成态改用 `rawTagPair` 手工组合，文本只 escape 一次。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| c81ed169 clean | Windows / Node | `npx vitest run packages/cli/src/tui/__tests__/` | 1（4 suite 因缺 `@duya/ai/context` 失败，678 passed） | 未构建 dist 的基线 |
| c81ed169 clean | Windows / Node | `npm run build:packages` | 0（20 packages） | worktree 内 dist 就绪 |
| f324857a | Windows / Node | `npx vitest run packages/cli/src/tui/__tests__/` | 0（61 files / 710 passed） | todo-only 中间态绿 |
| a89e65a7 | Windows / Node | `npx vitest run packages/cli/src/tui/__tests__/` | 0（61 files / 710 passed） | thinking 改动后绿 |
| a89e65a7 | Windows / Node | `npm run typecheck:all` | 0 | 全仓类型门禁 |
| a89e65a7 | Windows / Node | `npm run architecture:check` | 0（2608 baselined / 0 新增违规） | 架构门禁 |
| a89e65a7 | Windows / Node | `npx vite-node docs-local/preview-todo.ts` | 0 | 走真实渲染路径打印 ANSI:清单成形、两次写入各自成块、thinking 折叠成两行 |
| a89e65a7 | Windows / Node | `npx vitest run packages/cli/src/tui/__tests__/perf/baseline.test.ts` | 0（4 passed） | 全量并行跑时该 suite 报过一次失败,**单独复跑即绿** —— 机器负载造成的假失败,非本次改动 |
| ba3ab9b4 | Windows / Node | CI（PR #387） | 全绿：architecture / test scope / typecheck / test / build | GitHub Actions |

## 渲染实录

`docs-local/preview-todo.ts` 走真实渲染路径(`TranscriptModel` + `renderTranscript` + `own`
renderer)打印一个完整回合,ANSI 去掉后:

```
└ • Thought [+]
    The task needs three steps. Let me write them down before touching code.

● 先把这三步记下来,免得漏掉收尾。

└ ✔ Todo list 1/3
    ✔ 读 schema,确认 todo 工具的返回形状
    ● 实现 parseTodoItems 与清单渲染
    ○ 补测试:解析 / 渲染 / 不合批

● 第一版清单写进去了,再更新一次状态。

└ ✔ Todo list 2/3
    ✔ 读 schema,确认 todo 工具的返回形状
    ✔ 实现 parseTodoItems 与清单渲染
    ● 补测试:解析 / 渲染 / 不合批
```

## 接续 / 结果

已提交四个 commit：`f324857a`（todo 清单渲染）、`a89e65a7`（thinking 折叠一行）、
`d39d0d5d`（本计划文档）、`ba3ab9b4`（验证记录 + PR）。
PR #387：https://github.com/lava-chen/duya/pull/387 —— CI 全绿，门禁与渲染实录见上。
已合并（2026-10-24，`mergedAt 08:07Z`）。合并后真机反馈「有 todo 仍不显示」是解析侧问题
（执行器给的结果带 `[completed]` / `[Duration]` 信封），由
[2026-10-24 TUI 三项反馈缺陷](../archive/2026-10-24-tui-reported-defects.md)修复，本计划不再跟进。

未提交路径：无。worktree `.claude/worktrees/tui-todo-list` 独占 `packages/cli/src/tui/**`。
下一步:等 review 与 CI；获集成授权后合并并重验,再回收检出。
Phase 2（底部常驻 todo 面板 + 快捷键）未开工。
