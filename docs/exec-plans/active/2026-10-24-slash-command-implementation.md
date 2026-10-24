# Slash Command 实施（11 命令 / 4 PR）

状态：active · 负责人：mavis · 更新：2026-10-24
分支：codex/slash-command-implementation · worktree：E:\Projects\duya\.claude\worktrees\slash-commands · base：3a687e41（master，含 PR #439）· owner：mavis

## 目标与边界

用户依据 `docs/references/tui-slash-command-survey.md`（2026-10-15 调研）点名要补齐的 slash 命令：**compact, mcp, app, plugin, doctor, init, skills, btw, diff**，外加 **workflow**。

用户决策（2026-10-24）：
- 覆盖**桌面 + CLI 双端**。
- `/app` 学 codex：**把当前会话交接到桌面端**；`/apps` 学 codex：**列出应用**。
- 拆 **4 个 PR，串行合并**。

前置已合入：PR #439（slash 基础层：清死命令 + 可用性模型 + Gateway 收敛）→ `3a687e41`，master CI 绿。

关联：原始调研报告 `docs/references/tui-slash-command-survey.md`（2026-10-15 四方调研，**本地未入版本库**；它的「duya 现状」一节已被本计划下表修正）。

## 调研基线的修正（实测，master @ 3a687e41）

调研文档写于 9 天前，**「duya 现状」一节已过时**：

| 命令 | 调研文档结论 | 实际 | 真实缺口 |
| --- | --- | --- | --- |
| `/diff` | 缺命令入口 | 桌面 executor 已有（`executors/view.ts:131` 开 code-review 面板） | **CLI** |
| `/btw` | 缺 `/btw` 命令 | 桌面已有（`executors/view.ts:287` → agent-server `POST /sessions/:id/btw`） | **CLI** |
| `/skills` | 缺显式列表命令 | 桌面已有（`executors/info.ts:461` → `skills:list` IPC） | **CLI** |
| `/mcp` | 缺命令入口 | 桌面已有（`executors/view.ts:190` 开扩展页） | **CLI** + 桌面列表形态 |
| `/compact` | 未接线 | 桌面已有（`executors/session.ts:384` → `POST /sessions/:id/compact`） | **CLI** |
| `app` `apps` `plugin` `doctor` `init` `workflow` | 无 / 无 | 6 条全无 | **两端都无** |

所以本轮是「5 条补 CLI + 6 条全新」，不是 11 条从零。

## 三条传输家族（复用，不新造）

| 家族 | 用途 | 现状 |
| --- | --- | --- |
| Electron IPC（`window.electronAPI.*`） | 桌面原生 | 齐全 |
| **桌面 CLI API**（`apps/desktop/src/main/cli/cli-api-server.ts`） | 只给 `duya mcp/skill/plugin` 这类**顶层命令**用 | 有 `/v1/skills` `/v1/mcps` `/v1/plugins`；**但它在 Electron main 里，桌面不跑就没有** → 独立 TUI 用不了 |
| **Host HTTP**（`packages/host/src/http-server.ts`） | CLI TUI 的**唯一**后端通道 | 只有 session / run / workflow / 设置 / app-connection / plugin-setup 之类；**没有 skills、没有 mcps、没有 compact、没有 btw、没有 git** |
| agent-server HTTP（`apps/desktop/src/main/agents/server/router.ts`） | 会话内实时调用 | 桌面走它；**CLI 够不到** |

⚠️ 仓库里有**两套** CLI HTTP 服务，别混：`apps/desktop/src/main/cli/`（桌面 Electron 提供，桌面不跑就 404）与 `packages/host/src/http-server.ts`（Host 提供，独立 TUI 挂的就是它）。`packages/host/src/skills/skillService.ts` 的头注释说自己是「CLI API server (`GET /v1/skills`)」指的是**前者**。

CLI handler 只能经 `ctx.client`（`HostSessionHttpClient` 的 public 方法）；CLI 本身是 Node 进程，**可本地读盘 / 跑 git**（先例 `packages/cli/src/tui/slash/session-ops.ts:22` 的 `execFileSync`）。但 **CLI 不能运行时 import `@duya/plugin-core`**——它只是 devDependency，且现存的两条 `cli → plugin-core` 边（`packages/cli/src/commands/mcp.ts:27` 等）是**已入 baseline 的冻结债务**；新增一条新边会被 `architecture-check` 判为阻断。

## 4 个 PR

| PR | 命令 | 桌面 | CLI | 后端改动 | 风险 |
| --- | --- | --- | --- | --- | --- |
| **1 会话类** | compact / btw / diff | 已有，微调 | **新增 3 条** | Host 新增 `POST /v1/sessions/{id}/compact`、`POST /v1/sessions/{id}/btw`（按 plan 613 的 D2 约定）；`/diff` CLI 进程内跑 git | 中：Host 新出口要走 `agent-protocol` 契约 |
| **2 能力类** | mcp / skills | 已有 | **新增 2 条** | 无新后端：CLI 本地读 `plugin-core` 的 MCP user-config；skills 走 `@duya/host/skills/skillService` | 低 |
| **3 扩展类** | app / apps / plugin / workflow | **新增 4 条** | **新增 4 条** | `/apps` 走 `listAppConnections`；`/plugin` 走 `listPluginAppInstances`；`/workflow` 走 `listRuns`；**`/app` 需新增 `duya://` deep link 机制**（Electron 协议注册 + TUI 调 OS 打开） | **高**：`/app` 是新机制，可独立拆为第 5 个 PR |
| **4 新功能类** | doctor / init | **新增 2 条** | **新增 2 条** | `/doctor` 需把 `packages/cli/src/commands/doctor.ts` 的诊断逻辑抽到共享包；`/init` 需项目探测 + 模板 + 主进程写文件 | 中高：`/init` 需 FS 写权限（renderer 不能写盘） |

## 与既有计划的关系

- **plan 613**（`613-cli-manual-compaction.md`）已设计 CLI `/compact`：`packages/host/src/session-compaction.ts` + `http-server.ts` 出口 + `packages/cli/src/tui/slash/compact.ts`。**PR-1 复用它的设计**，不重复造；实施后回填 613 的接续记录。
- **plan 616**（`616-duya-app-mcp-layer.md`）讲的是 `duya_app` 内置 MCP 工具层，与 `/app` 无关，但它占用「app」一词——本计划明确：`/app` = 桌面端交接，`/apps` = 应用连接器。
- plan 610 / 611 / 614 / 615 / 617-619 与本轮无交集。

## 命名约定（避免歧义）

| 词 | 在 duya 本轮的含义 | 别混淆 |
| --- | --- | --- |
| app | 桌面端交接（codex 语义） | `packages/connectors/src/app-schema.ts` 的 `.app.json` = 连接器 |
| apps | 应用连接器（slack / google / microsoft365 / wecom / qq-mail / remote-mcp） | `packages/plugin-core/src/apps/` 的 plugin mini-app = 插件内嵌 UI |

## 验收

1. 每个 PR：`npm run typecheck:all` 与 `npm run architecture:check` 退出码 0；相关 vitest 全绿。
2. catalog 中每条 desktop/cli 声明都有对应 executor/handler（`packages/command-catalog/tests/catalog.test.ts`、`packages/ui/src/lib/commands/registry.test.ts`、`packages/cli/src/tui/slash/__tests__/slash-commands.test.ts` 三处既有完整性测试保持绿）。
3. 新增命令在两端都给出「为什么不可用」（PR #439 的 `commandAvailability` 已提供）。
4. CLI 侧 `chat.ts:312-317` 那句「面板命令（/diff /memory /mcp）在桌面端」必须随新命令更新。

## 进度

- [x] 合并 PR #439 入 master（`3a687e41`，CI 绿）
- [x] 三路并行摸底（CLI 接入面 / 后端能力 / 桌面 UI 资产与 app 语义）+ 一路补查（mcp/skills 取数路径）
- [x] 建 worktree + junction + 依赖构建
- [x] 写本计划
- [ ] PR-1 会话类（compact / btw / diff）— 实现完成，门禁与 PR 待办
- [ ] PR-2 能力类：mcp / skills
- [ ] PR-3 扩展类：app / apps / plugin / workflow
- [ ] PR-4 新功能类：doctor / init

### PR-1 已实现（work package 拆分）

| WP | 内容 | 提交 |
| --- | --- | --- |
| WP-A | Host 会话级出口：`POST /v1/sessions/{id}/compact`（SSE）+ `POST /v1/sessions/{id}/btw`（JSON）、`SessionCompactor` / `SessionSideQuestioner`、`WorkerManager.addMessageListener` 多订阅 fan-out、Host client 两个新方法 | `850fc300` + `efa99845` |
| WP-B | CLI `/compact` + `/btw` + `reloadTranscript` 动作 | `5355e26e` + `ae48b01a` |
| WP-D | CLI `/diff`（进程内 git，含 untracked） | `4fbf5a1a` |
| 主 agent | catalog surfaces 扩到 cli、CLI 注册表接线、完整性测试名单、拆除临时 client cast | `bc0328e0` `eafb535b` `ae48b01a` |

**与 plan 613 的偏差（已定）**：
1. `reserve(input)` **同步**返回 `{ok:true, events}` 或 `{ok:false, status, code, message}`，而不是 613 草拟的 `compact(input): Promise<SessionCompactResult>`。理由：路由必须在写任何 header **之前**决定回 JSON 错误还是 200 SSE；拿到 promise 时响应形态已定。
2. 拒绝判定顺序 `session_busy` → `compact_in_flight` → `no_live_worker`，全部 409。`no_live_worker` 是 613 Phase 0 的 Go/No-Go 降级：**不拉起 worker、不补 provider 配置**。
3. `/btw` **不做 busy 拒绝**——它的语义就是「不打断当前对话」，加 busy 拒绝会让功能自相矛盾；桌面端 `handlePostSideQuestion` 也不拒。
4. SSE 解析器 `readServerSentFrames` 抽为模块级唯一实现，`watchAgentRunEvents` 一并复用。

## 验证记录（PR-1）

| SHA / dirty 范围 | 环境 | 命令 | 退出码 / 结果 |
| --- | --- | --- | --- |
| `79cad6bf` clean | Windows / Node 24 | `npm run typecheck:all` | 0 |
| `79cad6bf` clean | Windows / Node 24 | `npm run architecture:check` | 0 · `OK — no new boundary violations`；baseline 2530 / tolerated 2730，2 个 fingerprint 不再触发（缩债，非失败） |
| `79cad6bf` clean | Windows / Node 24 | `node scripts/architecture/bundle-verify.mjs` | 0 · `FRESH 0/950 bundle inputs changed after the bundle commit` |
| `69bd03b7` | Windows / Node 24 | `git merge origin/master` | 1 → 手工解决 `docs/exec-plans/README.md` 计划索引表冲突（取 master 版再插回本计划一行），其余自动合并 |
| `79cad6bf` clean | Windows / Node 24 | `npx vitest run packages/command-catalog packages/ui packages/cli packages/gateway packages/host packages/agent-protocol` | 0 · 568 文件 / 5905 通过 / 3 跳过 |

**未验证（真机）**：冷启动 worker 的 provider-config 解析（613 R1）、5 分钟无字节 SSE 存活探测、压缩后 transcript rebase 经 `includeSuperseded=false` 可见、端到端 `/btw` 对接真实 provider。以上均只有 fake worker / stub server 的单测级覆盖。

## 关键事实速查

- 桌面 executor 注册点：`packages/ui/src/lib/commands/executors/index.ts:20-24`；`CommandAppBridge`（`executors/bridge.ts:35`）是桌面唯一后门，无通用 IPC 逃生口。
- CLI handler 定义：`packages/cli/src/tui/slash/<name>.ts`，导出 `TuiSlashCommandDef[]`，注册在 `packages/cli/src/tui/slash/registry.ts:49-61`；分组枚举在 `slash/types.ts:115`，顺序在 `registry.ts:114`。
- CLI handler 能力边界：能开 modal/prompt/panel、能异步回报、能经 `ctx.actions.interrupt()` 中断；**不能**向模型发问、不能排队、不能注入用户消息。
- 桌面 `CommandResult` 变体：`text` / `error` / `dismiss` / `session_reset` / `forward`（`packages/ui/src/lib/commands/types.ts:88-93`）。
- 通用列表原语：`OptionPanel`（`packages/ui/src/components/ui/OptionPanel.tsx:88`）可搜索可选列表；`CommandResultDialog`（`components/chat/CommandResultDialog.tsx:22`）纯文本结果。
- 桌面已有可复用页面：扩展市场 `components/extensions/MarketplacePage.tsx`、工作流 `components/workflow/WorkflowPage.tsx`、技能 `components/skills/SkillsView.tsx`、连接器段 `components/extensions/InstalledPage.tsx:381-443`。
- 桌面弹窗条目来源 = catalog 投影 + 硬编码（`packages/ui/src/hooks/useSlashCommands.ts:205-299` 的 `__thinking/__style/__compact/__btw/__focus` 与 mode 三项）。
- **`packages/cli/package.json` 里 `@duya/plugin-core` 只是 devDependency**（`@duya/host` / `@duya/command-catalog` 才是运行时依赖）→ CLI 侧 `/mcp` 不能直接 import plugin-core，要么升为运行时依赖，要么走 Host 出口。
