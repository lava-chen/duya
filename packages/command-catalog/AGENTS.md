# @duya/command-catalog

> 斜杠命令的唯一定义处：只存元数据（名字 / 别名 / 描述 / 参数提示 / 适用界面），不存行为。

## 负责 / 不负责

- **负责**：`COMMAND_SPECS` 有序数组，`CommandSpec` / `CommandSurface` / `CommandCategory` 类型，以及查找、按界面过滤、文案渲染。
- **不负责**：命令的实际执行 → 桌面端 `packages/ui/src/lib/commands/registry.ts:64`、CLI 端 `packages/cli/src/tui/slash/registry.ts:32`；宿主 API → `@duya/host`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/command-catalog/src/index.ts:1` | 全部实现，单文件（638 行） |
| `packages/command-catalog/src/index.ts:90` | `COMMAND_SPECS` 有序数组；**数组顺序就是弹窗顺序** |
| `packages/command-catalog/src/index.ts:601` | `findSpec()` —— 精确查找，故意**不过滤** `surfaces` |
| `packages/command-catalog/src/index.ts:614` | `specsForSurface()` —— 弹窗 / `/help` 用的过滤视图 |
| `packages/command-catalog/src/index.ts:627` | `describeSpec()` / `formatSpecLabel()`（`:632`） |

公共面：`@duya/command-catalog`（单入口，无子路径导出）。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 弹窗里没有这条命令 | `packages/command-catalog/src/index.ts:614` — 看 `surfaces` / `requiresSession` / `availableWhileBusy` |
| 手动输入命令却报未知 | `packages/command-catalog/src/index.ts:601` — `findSpec` 故意不过滤 surface，查名字与别名拼写 |
| 桌面和 CLI 显示不一致 | `packages/command-catalog/tests/catalog.test.ts:18`（完整性）、`:132`（桌面平价） |
| 声明了但没有实现 | `packages/command-catalog/tests/catalog.test.ts:171` —「不声称自己没有 executor 的桌面支持」 |
| CLI 侧对不上 | `packages/cli/src/tui/slash/__tests__/slash-commands.test.ts:253` |

## 边界

- `architecture-policy.yaml:434` — 模块 `command-catalog`，`managed: true`，`requires: []`（零依赖）。
- **加命令 = 这里加一条 + 拥有它的界面加一个 handler**，不要手抄定义。
- 数组顺序即展示顺序（最常用在前），不要按字母排序。
