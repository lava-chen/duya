# TUI 插件/应用/技能查看菜单交互化 + @ 插件 mention

状态：active · 负责人：ZCode 会话（lava-chen 授权任务） · 更新：2026-10-25
分支：`codex/tui-plugin-slash-mention` · worktree：`E:/Projects/duya/.claude/worktrees/tui-plugin-slash-mention` · base：`270ba528` · owner：本会话

## 目标与边界

用户观察到的变化：

1. `/plugin` `/apps` `/skills` `/mcp` 从静态文本面板改为可交互列表：↑↓ 在条目间移动、选中行下方显示摘要、Enter 打开该条目的详情页、Esc 返回列表（codex `/plugins` 浏览器同型）。无法应答的 Host（404 named code）与空列表仍走既有静态面板文案。
2. TUI 的 `@` 补全出现已安装插件行（与桌面端一致：附件路径之后、插件在前），接受后插入 `@<pluginId> `；提交时改写为 `[@Name](plugin://id)` 并在 `startAgentRun` 的 `options` 携带 `mentionedPlugins` / `mentionedProviders` / `displayContent`，worker 既有 `<plugin-activation>` 注入链路直接生效（无需改 worker）。

允许修改：`packages/cli`（tui/slash/chat/candidates）、`packages/input-completion`（接收下沉的纯 mention 改写模块）、`packages/ui`（改 import + 迁走对应测试）、`packages/agent-protocol`（plugin-inventory 投影扩展）、`packages/host`（清单投影补非凭据字段）。

本次不处理：插件启用/禁用开关、安装/卸载操作、skills 直接执行、`/mcp` 的 verbose 细节、桌面端 UI 行为变化、agent CLI（packages/agent）。

关联：`docs/references/tui-slash-command-survey.md`（P0/P2 建议）；桌面端 mention 语义 `packages/ui/src/lib/plugin-mentions.ts`；worker 注入 `packages/host/src/worker-mentions.ts:354`。

路径所有权：本 worktree 独占以上路径；无共享文件冲突预期。

## 验收

- `npx vitest run packages/cli/src/tui/slash/__tests__/{plugin,apps,skills,mcp}.test.ts`（改造后）＋新增 candidates/mention 用例全绿；先记录基线失败再比较。
- `npx vitest run packages/input-completion`（迁入的 plugin-mentions 测试）与 `packages/ui/src/lib/__tests__`（ui 侧改 import 后）全绿。
- `npx vitest run packages/host/tests`（清单投影用例，含新增字段）相关文件绿。
- `npm run typecheck:all`、`npm run architecture:check` 退出码 0。
- 手工链路核对（真机冒烟留待 PR 阶段）：`npm run build:cli-dev` 后 `dev:tui`，`/plugin` 可 ↑↓+Enter 查看详情；`@` 弹出插件行，接受+提交后 Host 侧日志出现 `Plugin activation: <id>`。

## 进度

- [x] S1 调研对账：TUI 面板/补全现状、桌面 mention 链、worker options 链路（本文件“发现与决策”）
- [x] S2 协议+Host：`HostPluginInventoryEntry` 增加可选 `description` / `appConnections` / `mcpServers` / `skillNames`（仅名称，无凭据无路径）；registry 读 manifest + skills 目录；`plugin-inventory-http.test.ts` 升级为结构化凭据边界断言
- [x] S3 下沉 `rewritePluginMentionTokens` → `@duya/input-completion`（含 `PluginMentionCapabilities`/`PluginMentionRewrite` 类型）；ui 改 import、测试随迁（12 用例）
- [x] S4 TUI 交互列表：WindowManager 增 `initialSelected`；TUIApp 增 `showListPanel`/`showDetailPanel`/`recheckCompletion`；TuiSlashHost 增可选方法；shared 增 `showEntries`（交互优先、静态回退）；plugin/apps/skills/mcp 四命令改造
- [x] S5 TUI @ mention：`tui/plugin-candidates.ts`（TTL 缓存 + stale-while-revalidate + onUpdated 重绘）；chat.ts `context()` 出插件行、会话边界刷新、`runTurn` 统一改写（fresh/queued/steer 三路共此一处）并带 `options.mentionedPlugins/mentionedProviders/displayContent`
- [x] S6 测试与门禁：见验证记录（cli 1414 全绿、ui lib 276 绿、chat 组件 517 绿、host 5 绿、input-completion 63 绿、architecture:check OK；typecheck:all 待出）
- [ ] S7 提交、PR、真机冒烟记录

## 发现与决策

- 四个查看命令现状均为 `showPanel` 静态文本（`packages/cli/src/tui/slash/{plugin,apps,skills,mcp}.ts`）；WindowManager 已有 `items/detail/filterable/onActivate` 全套选中能力（`packages/cli/src/tui/window.ts:46`），纯命令侧接线即可，无需新窗口组件。
- TUI `@` 只有文件路径：`chat.ts:747 context: () => []`（candidates.ts 头注说明 legacy skill/mode 来源未迁移）。`resolveItemSelection` 对 context 行插入 `@<value> `（`packages/input-completion/src/insert.ts:38`），与桌面 token 形态一致。
- 桌面 mention 全链已落地且 worker 侧按 `msg.options.mentionedPlugins` 消费（`worker-process-entry.ts:2213`→`worker-session-runtime.ts:692`→`collectPluginInjections`）；Host `/v1/agent-runs/start` 的 options 袋只剥离 HOST_ADJUDICATED 键后原样透传（`run-turn-overrides.ts:79`、`run-execution.ts:491`）。→ TUI 端补齐即可，零 worker/Host 运行时改动。
- Host 插件清单投影（`local-plugin-inventory-api.ts`）刻意不含 manifest；但 description、appConnection id、MCP/skill 名称均为非凭据事实，可进投影。技能名取 `discoverSkills(installPath)`（与 worker 实际加载一致），appConnections 取 v2 manifest `components.appConnections`（string[]，`packages/ui/src/lib/plugin-types.ts:216`）。
- `rewritePluginMentionTokens`（`packages/ui/src/lib/plugin-mentions.ts`）零 import 纯函数 → 下沉 `@duya/input-completion`（cli/ui 都已依赖该包），避免 CLI 引 React 包或复制逻辑。
- 静态面板的 “cannot answer ≠ empty” 区分必须保留；列表化只替换“有清单可答”分支。
- 真机约束：CLI 包内 vitest 需从仓库根 `npx vitest run`（历史坑）；worktree 验证注意共享 .vite 缓存；重命令 `TEMP=E:/tmp`。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| base 270ba528 + S2 改动（dirty） | win32 / Node v24.16.0 / worktree | `npx vitest run packages/host/tests/plugin-inventory-http.test.ts` | 0，5 passed | 清单投影含 description/appConnections/mcpServers/skillNames；凭据结构化断言过 |
| 同上 + S3 | 同 | `npx vitest run packages/input-completion/test` | 0，3 files 63 passed | plugin-mentions 迁入后 12 用例绿 |
| 同上 + S4 | 同 | `npx vitest run packages/cli/src/tui/slash/__tests__/{plugin,apps,skills,mcp}.test.ts` | 0，45 passed | 存量静态回退路径未破 |
| 同上 | 同 | `npx vitest run packages/cli/src/tui/slash/__tests__/interactive-list.test.ts packages/cli/src/tui/__tests__/tui-window.test.ts` | 0，17 passed | 列表/详情/回位 initialSelected 行为钉住 |
| 同上 + S5 | 同 | `npx vitest run packages/cli` | 0，118 files 1414 passed | 含 chat 循环 mention 改写 2 新用例与 plugin-candidates 5 用例 |
| 同上 | 同 | `npx vitest run packages/ui/src/lib/__tests__ packages/ui/src/components/chat` | 0，276+517 passed | ui 侧 mention import 迁移后全绿 |
| 同上 | 同 | `npm run architecture:check` | 0，OK no new boundary violations | 2 条 baseline 指纹不再触发；按规不 `--write`（master 漂移勿顺手收缩） |
| 同上 | 同 | `npm run typecheck:all` | 0（9 条 electron-gate baseline 指纹收缩，未 `--write`） | 全链类型门禁过 |

## 接续 / 结果

已实现并验证（见验证记录），交付状态：**draft PR 等待 review / CI / 真机冒烟**。

- 分支 `codex/tui-plugin-slash-mention`（4 commits，head `7dedabd9`→docs 收尾后以实际为准），PR：https://github.com/lava-chen/duya/pull/497（draft，base master）
- 提交切分：①host 清单投影 ②mention 改写下沉 input-completion ③TUI 交互列表 + @ mention ④计划文档
- 未提交路径：无（`packages/capabilities/src/ModuleTool/inline-content.ts` 仅有 CRLF checkout 噪声、无内容差异，不属本任务，未动）
- 副作用：无（构建产物均在 worktree 内；`build:packages` 重建了 worktree 的 dist，属本检出产物）
- 阻塞/待办：真机冒烟——`npm run build:cli-dev` 后 `npm run dev:tui`：
  1. `/plugin` `/apps` `/skills` `/mcp`：↑↓ 选中、Enter 进详情、Esc 返回且停原行；
  2. `@` 弹出插件行（Host 有插件时），接受 `@<id>` 提交后 Host 日志出现 `Plugin activation: <id>`，转写中 prompt 为 `[@Name](plugin://id)` 而用户气泡为原文。
- 下一条动作：用户真机冒烟通过 → 转 ready 交 review/CI；发现交互问题回到 S4/S5 修复。
回收：不回收——PR 未集成，worktree 与分支按指南保留。
下一步：等待真机冒烟结果；集成须获用户授权后由集成者核对必需 review/CI。
