# @duya/input-completion

> 输入补全的**纯规则**：弹窗何时打开、过滤后剩什么、接受一项写回什么。无 React、无 Electron、无 IO、无候选来源。

## 负责 / 不负责

- **负责**：触发检测（`@` / `/` / 技能 / 插件）、子串 / 模糊子序列 / 相关度排序三种过滤、选中写回与上下循环。
- **不负责**：候选从哪来 → 各界面自带（桌面 `packages/ui/src/lib/skill-mentions.ts:1`、`packages/ui/src/lib/plugin-mentions.ts:1`；CLI 读 `packages/agent/src/skills`）；UI 组件 → `@duya/ui`；命令名定义 → `@duya/command-catalog`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/input-completion/src/index.ts:1` | 公共面：全部导出在此 |
| `packages/input-completion/src/trigger.ts:19` | `detectPopoverTrigger()` — 决定弹窗是否打开 |
| `packages/input-completion/src/filter.ts:38` | `filterItems()`（子串）/ `:54` `filterItemsFuzzy()` / `:85` `filterItemsRanked()` |
| `packages/input-completion/src/insert.ts:18` | `resolveItemSelection()` — 接受一项写回什么；`:54` `cycleIndex()` |
| `packages/input-completion/src/fuzzy.ts:170` | `fuzzyMatch()`；`:207` `fuzzyFilter()` |
| `packages/input-completion/src/types.ts:58` | `PopoverItem` / `PopoverMode` / `InsertResult` / `TriggerResult` 等类型 |

公共面：`@duya/input-completion`（单入口）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 补全不弹出 | `packages/input-completion/src/trigger.ts:19` — 看触发字符与光标位置判定 |
| 弹出了但项被过滤掉 | `packages/input-completion/src/filter.ts:38` — 子串 / 模糊 / 排序三条路径语义不同 |
| 接受后写回文本不对 | `packages/input-completion/src/insert.ts:18` — `InsertResult` 决定替换还是插入 |
| 上下键选择跳位 | `packages/input-completion/src/insert.ts:54` — `cycleIndex` 的环绕规则 |
| 桌面弹窗整体坏掉 | `packages/ui/src/lib/message-input-logic.ts:46` → `packages/ui/src/hooks/useSlashCommands.ts:1` |

## 边界

- `architecture-policy.yaml:588` — 模块 `input-completion`，`managed: true`，`requires: []`（**零依赖**是它存在的理由）。
- 候选来源不属于本包：桌面给技能 / 插件 / 模式，CLI 给技能 / 模式 / 工作区树；只有**选择规则**共享。
- 消费方：`packages/ui/src/lib/message-input-logic.ts:46`、`packages/ui/src/types/slash-command.ts:10`、`packages/cli/src/tui/completion.ts:33`、`packages/cli/src/tui/window.ts:40`。
