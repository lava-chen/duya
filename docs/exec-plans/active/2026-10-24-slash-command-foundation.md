# Slash Command 基础层清理与补齐

状态：active · 负责人：mavis · 更新：2026-10-24
分支：codex/slash-foundation · worktree：E:\Projects\duya\.claude\worktrees\slash-foundation · base：2ca7886f · owner：mavis

## 目标与边界

用户判断：duya 当前有大量「完全没必要没有用」的 slash command。先做一次**基础层**优化，优化完再考虑 slash 的新设计。

本轮做两件事：

1. **清理**：删掉声明了但没有实现、或指向不存在能力的命令。
2. **补基础层**：把 mcode 已验证的可用性模型（上下文求值 + 不可用原因）补进共享 catalog，让两个前端不再静默过滤。

**本轮不做**（用户明确说「优化完之后再考虑 slash 的新的设计」）：
- Skill 投影成 slash command（mcode 的 `buildTuiSkillCommands`）
- 命令扩展点 / 插件贡献命令（mcode 的 `TuiCommandContribution`）
- side mode 白名单、决策面板命令（`allow`/`always`/`deny`）
- 新增任何命令

关联：`docs/references/tui-slash-command-survey.md`（2026-10-15 四方调研，路径已过时但结论可用）。

## 审计结论（2026-10-24 实测基线）

四个表面各自维护命令定义，互不共享：

| 表面 | 定义处 | 声明数 | 实际可执行 |
| --- | --- | --- | --- |
| 共享 catalog | `packages/command-catalog/src/index.ts` | 46（desktop 35 / cli 27 / 双端 16） | 见下 |
| 桌面 executor | `packages/ui/src/lib/commands/executors/` | 35 键 | 30（5 条无实现） |
| CLI handler | `packages/cli/src/tui/slash/` | 21 键 | 21 |
| Gateway | `packages/gateway/src/commands/registry.ts` | 34 | **6** |

### 死命令分类

**A 类 — catalog 声明 desktop，但桌面没有 executor**（5 条）

`review` / `simplify` / `doctor` / `commit` / `plan`。

它们走 `packages/ui/src/lib/message-input-logic.ts:79-83` 的 `kind: 'agent_skill'`，提交后转成一句提示词 `Please use the review skill.` 发给模型。但 duya 内置 skill 只有 `packages/host/skills/.system/` 下 6 个：`memory-search` / `plugin-mcp-builder` / `self-config` / `self-knowledge` / `visual-component-verify` / `workflow`。**没有 review / simplify / doctor / commit / plan**。

逐条复核后的最终处置（与初判有出入，以复核为准）：

| 命令 | 复核结论 | 处置 |
| --- | --- | --- |
| `review` | 与 `diff` 完全重复——`diff` 的 executor（`view.ts:113`）就是 `openPanel('code-review')`，而 `code-review` 在 bridge 的 `SlashCommandPanel` 里（`bridge.ts:26`）。两个命令打开同一个面板。 | **删**（重复） |
| `plan` | 有真实能力：`useSlashCommands.ts:268` 的弹窗已有 "Plan Mode" 项（`modeValue: 'plan-task'`），且 bridge 提供 `toggleMode(mode)`（`bridge.ts:72`）。缺的是 executor，不是能力。 | **接线**，不删 |
| `simplify` | 无对应 skill、无对应面板、无对应 executor。 | **删** |
| `doctor` | 同上。 | **删** |
| `commit` | 同上。 | **删** |

初判时把 5 条一并删除，复核发现 `plan` 是「缺接线」而非「缺能力」，`review` 是「重复」而非「空壳」。只删真正没有落点的 4 条。

**B 类 — Gateway 声明 34 条，Main 侧只实现 6 条**

`apps/desktop/src/main/gateway/message-bus.ts:398` 的 `handleGatewayCommand` 只处理 `help` / `new` / `reset` / `clear` / `stop` / `status`，其余 28 条落到 `default:` 回复 `🚧 尚未在此构建中启用`。

未实现的包括 `retry` / `undo` / `save` / `history` / `title` / `commands` / `about` / `provider` / `reasoning` / `usage` / `compress` / `position` / `insights` / `whoami` / `profile` / `sethome` / `personality` / `voice` / `background` / `rollback` / `steer` / `fast` / `verbose` / `reload-mcp` / `update` / `delete` / `sessions` / `model`。

**C 类 — 基础层缺口**

- 可用性只有两个布尔位（`availableWhileBusy` / `requiresSession`），无法表达「运行中不可用」「未登录才显示」这类条件。
- 命令不可用时**静默消失**：CLI 的 `advertisedSpecs`（`packages/cli/src/tui/slash/registry.ts:88`）直接过滤掉，用户既看不到也得不到原因。mcode 会返回 `unavailableReason`（如 `Stop the running turn before using /fork.`）。

复核后的补充发现：

- **桌面端根本没有消费 `availableWhileBusy`**：catalog 声明了 9 条命令 busy 时可用，但桌面既不据此过滤，也拿不到 busy 状态（`CommandAppBridge.getSessionSnapshot()` 没有 `isStreaming`）。CLI 侧反而是健全的——每个 handler 自己检查 `ctx.busy` 并给出原因（`session-ops.ts:48` 的 `refuseWhileBusy`）。同一命令在两端行为不一致。
- **`availableWhileBusy` 的数据本身不完整**：CLI 实际允许 busy 时运行的只读/配置类命令（`export` / `capabilities` / `read-file` / `copy` / `help` / `skills` / `memory` / `mcp` / `diff` / `permission` / `effort` / `thinking` / `btw`）没有声明。桌面一旦开始消费这个字段就会把它们误伤——特别是 `/btw`，它的语义就是「不打断当前对话」，恰恰要在回合运行时可用。

## 验收

1. `npx vitest run packages/command-catalog/tests/catalog.test.ts packages/cli/src/tui/slash/__tests__/slash-commands.test.ts packages/ui/src/lib/commands` 全绿。
2. `npm run typecheck:all` 退出码 0。
3. `npm run architecture:check` 退出码 0（不加指纹、不扩 baseline）。
4. 新增测试断言：catalog 中每个 desktop/cli 条目都有对应 executor/handler（防回归）。
5. Gateway：声明的命令集合与 Main 侧实现集合一致，或明确标注为「未实现」并从注册表移除。
6. 不可用命令能给出原因（桌面 + CLI 两侧）。

## 进度

- [x] 建立独立 worktree（base `2ca7886f`）
- [x] 审计四个表面的命令现状，产出分类清单
- [x] 清理 A 类死命令：删 `review`/`simplify`/`doctor`/`commit`，给 `plan` 接 executor
- [x] 清理 B 类 Gateway 未实现命令（注册表 34 → 5）
- [x] 补基础层：catalog 增加 `CommandContext` / `commandAvailability` / `availableSpecsFor` / `unavailableReason`
- [x] 补齐 `availableWhileBusy` 数据（CLI 已验证的语义：只读/配置/开面板 busy 可用）
- [x] 桌面端加闸门（`runSlashCommand`）+ bridge 传 `isStreaming`
- [x] CLI 侧改用 `availableSpecsFor`
- [x] 三组完整性测试 + 反例臂验证
- [x] 跑门禁并记录
- [x] commit / PR / 更新接续记录（PR #439）

## 实际改动

| 文件 | 改动 |
| --- | --- |
| `packages/command-catalog/src/index.ts` | 删 4 条死命令；加 `CommandContext` / `commandAvailability` / `availableSpecsFor` / `unavailableReason`；补 13 条 `availableWhileBusy` |
| `packages/command-catalog/tests/catalog.test.ts` | 加「可用性」测试块；加「死命令不再解析」断言 |
| `packages/ui/src/lib/commands/executors/registry.ts` | `runSlashCommand` 加可用性闸门（唯一出答案的地方） |
| `packages/ui/src/lib/commands/executors/bridge.ts` | `getSessionSnapshot()` 加 `isStreaming` |
| `packages/ui/src/lib/commands/executors/view.ts` | 加 `/plan` executor（`toggleMode('plan-task')`） |
| `packages/ui/src/lib/commands/executors/__tests__/view.test.ts` | 加 `/plan` 与「可用性闸门」测试 |
| `packages/ui/src/lib/commands/registry.test.ts` | 加「catalog 声明的桌面命令必须有 executor」 |
| `packages/ui/src/lib/message-input-logic.ts` | 删 5 条 `agent_skill` badge 项 |
| `packages/ui/src/components/chat/MessageInput.tsx` | bridge 传 `isStreaming` |
| `packages/ui/src/i18n/{zh,en}.ts` | 删整组无人引用的 `slashCommands.*` 键（9 键 × 2） |
| `packages/cli/src/tui/slash/registry.ts` | `advertisedSpecs` 改用 `availableSpecsFor`；`/help` 改用 `findSpec` |
| `packages/cli/src/tui/slash/__tests__/slash-commands.test.ts` | 加「catalog 声明的 CLI 命令必须可执行」+ 例外显式化 |
| `packages/gateway/src/commands/registry.ts` | 34 → 5 条，只留 Main 侧真正实现的 |
| `packages/gateway/src/commands/registry.test.ts` | 新建：注册表即承诺给用户的菜单 |
| `packages/{command-catalog,gateway}/AGENTS.md` | 更新接口与排障入口 |

## 发现与决策

**决定：本轮不引入 Skill 投影。** 用户说「优化完之后再考虑 slash 的新的设计」，Skill 投影属于新设计。本轮只做清理 + 基础层，让后续设计有干净的落地面。

**决定：`plan` 接线而非删除；`review` 删除而非接线。** 初判时把 5 条无 executor 的命令一并删除，复核后分开处理：`review` 的 executor 就是 `openPanel('code-review')`，与 `/diff` 完全重复；`plan` 有真实能力（弹窗里的 "Plan Mode" 项，`modeValue: 'plan-task'`），缺的只是 executor。`simplify` / `doctor` / `commit` 才是真正的空壳——它们把提示词发给一个 duya 不存在的 skill（内置 skill 只有 `packages/host/skills/.system/` 下 6 个）。

**决定：Gateway 注册表只保留 Main 侧真正实现的命令。** 34 条里 28 条返回「尚未启用」，而 `COMMAND_REGISTRY` 正是 Telegram `/commands` 菜单的来源——产品自己发布的菜单里全是必然失败的项。

**发现：桌面端从来没有消费过 `availableWhileBusy`。** catalog 声明了 9 条命令 busy 时可用，桌面既不据此过滤，`CommandAppBridge` 也拿不到 busy 状态。CLI 侧反而健全（每个 handler 自己检查 `ctx.busy` 并给原因）。同一命令在两端行为不一致，且桌面是宽松的那一侧。本轮把桌面补成与 CLI 一致。

**发现：`availableWhileBusy` 的数据本身不完整。** CLI 实际允许 busy 时运行的只读/配置类命令没有声明。桌面一旦开始消费这个字段就会误伤——特别是 `/btw`，它的语义就是「不打断当前对话」，恰恰要在回合运行时可用。已按 CLI 的实际行为补齐 13 条。

**发现：CLI 的 6 条命令由 chat loop 自己实现，不进 `slash/` 注册表。** `new` / `resume` / `clear` / `queue` / `exit` / `help` 在 `packages/cli/src/chat.ts:1160-1244` 用 if-else 链处理——它们需要 loop 的 queue、transcript 和 session transition，handler 拿不到。这是真实存在的分层，已在测试里显式列为例外，而不是让断言变松。

**发现：Gateway 注册表与共享 catalog 完全独立。** Gateway 有自己的 `CommandDef` 类型、自己的 `resolveCommand`、自己的 help 生成，注释写明「cannot import from src/」，且 `packages/gateway/package.json` 不依赖任何 workspace 包（`architecture-policy.yaml:735` 的 `legacy-gateway` 是 `managed: false` + `requires: []`）。收敛到共享 catalog 要新增依赖边，本轮不做。

**发现：`packages/agent/src/cli/slash-commands.ts` 是遗留层。** 27 条注册、8 个 stub（`retry`/`undo`/`title`/`stop`/`compress`/`agents`/`plan`/`usage`）。`packages/agent/AGENTS.md` 明确标注 LEGACY 退役中、不新增实现。本轮不动，但记录待清理。

**发现：architecture:check 报的「256 baseline fingerprint 不再触发」是仓库既有状态**，不是本轮引入。已用 stash 在 base 上复跑对比确认：base 同样是 256。本轮只让 `module-dependency-permitted` 从 2553 → 2554（新增 1 条 `ui → command-catalog` 允许边；该模块级依赖已在 `architecture-policy.yaml:457` 声明）。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `2ca7886f` clean | Windows / Node 24 | 静态解析四个命令定义处 | — | catalog 46（desktop 35 / cli 27）、桌面 executor 35 键、CLI handler 21 键、Gateway 34 条 / Main 侧 6 case |
| `2ca7886f` clean | Windows / Node 24 | `git diff --stat master origin/master -- packages/command-catalog packages/ui/src/lib/commands packages/cli/src/tui/slash packages/gateway/src/commands` | 0 行输出 | 命令相关代码在本地 master 与 origin/master 间无差异，审计结论对 base 有效 |
| `2ca7886f` + 本轮改动 | Windows / Node 24 | `npx vitest run packages/command-catalog packages/ui packages/cli packages/gateway` | 0；329 文件 / 3572 通过 / 2 跳过 | 全量相关测试绿 |
| `2ca7886f` + 本轮改动 | Windows / Node 24 | `npm run typecheck:all` | 0 | 无新类型错误 |
| `2ca7886f` + 本轮改动 | Windows / Node 24 | `npm run architecture:check` | 0 | OK — no new boundary violations；baseline 文件未改动 |
| `2ca7886f` + 本轮改动 | Windows / Node 24 | 反例臂：向 catalog 注入 `zz-fake-no-executor` 后重跑 | 1（按预期变红） | 新测试精确报出 `zz-fake-no-executor`，非空断言；随后移除注入 |
| base（stash 本轮改动后） | Windows / Node 24 | `npm run architecture:check` | 0 | base 同样报「256 fingerprint 不再触发」——该缩水是仓库既有状态 |
| `b5f5b827` clean | Windows / Node 24 | `npm run typecheck:all` | 0 | 最终门禁（与改动后同结果） |
| `b5f5b827` clean | Windows / Node 24 | `npm run architecture:check` | 0 | `OK — no new boundary violations`；baseline size 2785，tolerated 2665 |
| `21d67ac7` (PR head) | GitHub Actions / ubuntu-latest 22.x | PR #439 CI | 全绿 | `architecture` / `test scope` / `typecheck` / `test` / `build` 五项均 SUCCESS；`mergeStateStatus: CLEAN` |

## 接续 / 结果

**已实现、已验证、已提交并开出 PR。CI 全绿。未获集成授权，PR 保持未合并。**

- 分支：`codex/slash-foundation`（base `master` @ `2ca7886f`）
- PR：<https://github.com/lava-chen/duya/pull/439>
- 提交：
  | SHA | 说明 |
  | --- | --- |
  | `5cf910ae` | `refactor(gateway): drop commands the main process cannot run` |
  | `b5f5b827` | `refactor(slash): remove dead commands and gate on availability` |

下一步（需用户授权）：review → CI 通过 → 用 merge commit 合并 → 同步 master → 重验 → 回收 worktree。

**留给下一轮（用户说「优化完之后再考虑 slash 的新的设计」）**：

1. Skill 投影成 slash command（mcode 的 `buildTuiSkillCommands`）——收益最大。duya 已有 `skills.list()` IPC 与桌面弹窗的 skill 项，缺的是把它变成一等命令。
2. 命令扩展点（mcode 的 `TuiCommandContribution`）——先确认插件体系成熟度再动。
3. Gateway 收敛到共享 catalog——需要给 `legacy-gateway` 加 `command-catalog` 依赖边并评估 `managed` 状态。
4. CLI 的 6 条 chat-loop 命令下沉到 `slash/` 注册表。
5. `packages/agent/src/cli/slash-commands.ts` 遗留层的 8 个 stub 清理。
