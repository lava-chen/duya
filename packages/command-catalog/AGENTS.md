# @duya/command-catalog

> 斜杠命令的唯一定义处：只存元数据（名字 / 别名 / 描述 / 参数提示 / 适用界面），不存行为。

## 负责 / 不负责

- **负责**：`COMMAND_SPECS` 有序数组，`CommandSpec` / `CommandSurface` / `CommandCategory` 类型，以及查找、按界面过滤、文案渲染。
- **不负责**：命令的实际执行 → 桌面端 `packages/ui/src/lib/commands/registry.ts:64`、CLI 端 `packages/cli/src/tui/slash/registry.ts:32`；宿主 API → `@duya/host`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/command-catalog/src/index.ts:1` | 全部实现，单文件 |
| `packages/command-catalog/src/index.ts` | `COMMAND_SPECS` 有序数组；**数组顺序就是弹窗顺序** |
| `packages/command-catalog/src/index.ts` | `findSpec()` —— 精确查找，故意**不过滤** `surfaces` |
| `packages/command-catalog/src/index.ts` | `specsForSurface()` —— 弹窗 / `/help` 用的过滤视图 |
| `packages/command-catalog/src/index.ts` | `commandAvailability()` / `availableSpecsFor()` —— 可用性判定 + 不可用原因 |
| `packages/command-catalog/src/index.ts` | `describeSpec()` / `formatSpecLabel()` |

公共面：`@duya/command-catalog`（单入口，无子路径导出）。

## 可用性模型

命令能否运行由**两个事实**决定：有没有会话、有没有回合在跑。catalog 用两个声明表达这件事：

| 字段 | 含义 |
| --- | --- |
| `requiresSession` | 需要一个会话才能有意义 |
| `availableWhileBusy` | 回合运行时仍然安全（只读、配置、开面板） |

判定入口是 `commandAvailability(spec, context)`，返回 `{ available: true }` 或 `{ available: false, reason }`。**原因由 catalog 出**，所以桌面端和 CLI 说法一致；`unavailableReason` 可按命令覆盖默认文案。

两个表面都消费它：桌面在 `executors/registry.ts` 的 `runSlashCommand` 里做闸门，CLI 在 `tui/slash/registry.ts` 的 `advertisedSpecs` 里做过滤。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| 弹窗里没有这条命令 | `packages/command-catalog/src/index.ts` — 看 `surfaces` / `requiresSession` / `availableWhileBusy` |
| 手动输入命令却报未知 | `findSpec` 故意不过滤 surface，查名字与别名拼写 |
| 桌面和 CLI 显示不一致 | `packages/command-catalog/tests/catalog.test.ts`（完整性）、`:132`（桌面平价） |
| 声明了但没有实现 | `packages/command-catalog/tests/catalog.test.ts` —「不声称自己没有 executor 的桌面支持」 |
| 命令在运行时被拒绝 | `commandAvailability` 的两个事实 + catalog 的两个声明 |
| CLI 侧对不上 | `packages/cli/src/tui/slash/__tests__/slash-commands.test.ts` |

## 边界

- `architecture-policy.yaml:434` — 模块 `command-catalog`，`managed: true`，`requires: []`（零依赖）。
- **加命令 = 这里加一条 + 拥有它的界面加一个 handler**，不要手抄定义。
- 数组顺序即展示顺序（最常用在前），不要按字母排序。
