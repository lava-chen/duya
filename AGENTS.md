# AGENTS.md

> 给 agent 的**地图 + 契约**，不是操作手册。需要细节就点链接，不要把知识背在上下文里。

## Start

- Repo: `https://github.com/lava-chen/duya`
- 开工前读 [docs/exec-plans/README.md](./docs/exec-plans/README.md)：**Active Plans 表是承诺清单**，
  每行写着一个具体下一步，从第一行开始。计划文件自己的 `Status:` 头会过期，不是真相。
- 动某个子树前读那个子树自己的 `packages/<pkg>/AGENTS.md`；技术细节查
  [ARCHITECTURE.md](./ARCHITECTURE.md)；**症状 → 包/文件**查 [ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md)。
- 多步骤任务先 `/plan`。回复用仓库根相对路径（`packages/ui/src/x.tsx:45`），不用绝对路径、不用 `~/`。
- 缺依赖：`npm install`，重试一次，然后报**第一个可执行的错误**。
- **基线不是全绿**：`npm test` 当前有既有失败。开工前记录基线失败集，才分得清自己的回归。

## Map

- 前端：`packages/ui/src/` — 共享 renderer（React 19）。`apps/desktop` 只是挂载壳，Web 入口是
  `apps/web/src/main.tsx`。路由是 zustand 里的 `currentView` 字符串（`packages/ui/src/App.tsx:1122`），
  不是 Zero Router。
- Harness 核心：`packages/agent-protocol/`（传输无关的线上契约，零运行时依赖）、
  `packages/agent-core/`（run 推理，零 IO）、`packages/agent-runtime/`（执行引擎 `RunEngineImpl`）、
  `packages/host/`（产品 worker：run manifest、`RunOrchestrator`、worker 监管、工具注册、DB 桥）、
  `packages/cli/`（CLI 控制面 + 终端 TUI，也是 worker bundle 的 esbuild 入口）、
  `packages/agent/`（遗留外壳，退役 OPEN，不要往里加实现）。
- Desktop：`apps/desktop/` — Electron 主进程 + Gateway。Agent Server 是**独立子进程**，不是进程内。
  Web：`apps/web/` — 浏览器客户端，走 loopback BFF 连独立 Host。
- 其他包：`packages/{ai,capabilities,client-core,command-catalog,computer-use,conductor,connectors,data,gateway,input-completion,memory,plugin-core,sandbox,tooling,voice}/`
- Slash 命令**只**定义在 `packages/command-catalog/`，Desktop 与 TUI 都从那里投影，不要手抄。

## Architecture

- **进程拓扑**：HTTP+SSE 三层分离 —— Main Process ↔ Agent Server（HTTP+SSE）↔ Worker Processes。
  IPC 用 invoke/handle（`db:*`、`gateway:*`、`automation:*`、`logger:*`…）+ Agent Server HTTP 端点；
  MessagePort 只承载 config / toolExec / toolStream 三通道，不含 agentControl。
- **数据库**：SQLite（better-sqlite3），默认 `~/.duya/duya-main.db`（全平台一致），`DUYA_DATA_ROOT`
  覆盖默认根目录，`duya-core.db` 与 `memory-state.db` 是同级文件。路径归 `@duya/data` 统一拥有。
- **模式（plan 224）**：modes 是声明式 `ModeModifier`，注册在
  `packages/host/src/worker-modes/modifiers/index.ts`；与 `AgentProfile`（基础工具集）、
  `PermissionMode`（授权）三者正交。新增模式 = 写 `<mode>-mode.ts` → 注册 → 加 popover 项，
  不动 `DuyaAgent` / `builtin.ts`。
- 详见 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## Commands

```bash
npm run dev                  # Vite dev server (:3000)
npm run electron:dev         # Vite + Electron
npm run build:packages       # 按依赖顺序构建所有 workspace 包
npm run typecheck:all        # 提交前必跑（esbuild 不做类型检查）
npm run architecture:check   # 架构边界门禁
npm run test                 # Vitest
npm run test:e2e             # Playwright（需先 npm run electron:build）
npm run electron:build       # worker + CLI + gateway bundle + Vite + Electron
npm run build:cli-dev        # 构建 CLI bundle
npm run dev:tui              # 跑 TUI —— 注意它跑的是 bundle 产物
```

⚠ `dev:tui` 跑的是 `packages/cli/bundle/cli.cjs`（gitignored）。新克隆或**新 worktree** 里没有它，
会直接 MODULE_NOT_FOUND —— 先 `npm run build:cli-dev`（或 `build:cli-bundle`）。

CLI 顶层命令（`serve` / `chat` / `tui` / `status` / `plugins` …）见 `packages/cli/src/index.ts:46`。

## Gates

- `npm run typecheck:all` **必须**通过；`npm run architecture:check` **必须**通过。后者是**棘轮**
  不是 lint：既有违规冻结在 `.architecture-baseline.json`，只有**新增**才拦；
  `architecture-policy.yaml` 里 `managed: true` 的模块零容忍、不可进基线。不要为了消音加指纹。
- MCP 连接器新增/改动必须过 conformance 套件（`packages/agent/tests/integration/mcp-conformance.test.ts`，L1–L9）。
- UI 改动必须用 Playwright MCP 真跑一遍，不许跳。
- 不提交密钥、API key、凭据。打包 / 构建产物 / 懒加载边界可能变化时，推送前跑 `npm run electron:build`。
- 改完架构要更新 [ARCHITECTURE.md](./ARCHITECTURE.md)。

## Worktree Development Contract

```
- Read the active execution plan and scoped AGENTS.md before editing.
- Parallel writing agents MUST use separate managed worktrees.
- Never modify the shared checkout from an isolated session.
- The Harness owns worktree creation, environment setup, locking,
  recovery, integration and deletion.
- Do not install dependencies through shared node_modules junctions.
- Record task ID, base commit, branch and verification evidence.
- Run targeted tests, typecheck and applicable architecture gates.
- Do not claim completion based only on a model-generated verdict.
- Changes must pass review and required CI gates before integration.
- Never force-remove a dirty or active worktree automatically.
- Preserve unmerged work and task state before cleanup.
```

可执行流程（创建 / junction 环境 / 验证 / PR / 合并 / 安全拆卸 / 误删恢复）：
**[docs/development/worktree.md](./docs/development/worktree.md)**。
拆卸只能走 `scripts/remove-worktree.sh`（fail-closed）；手工 `rm -rf` 一个 worktree
在 Windows 上会穿过 junction 删掉主检出的源码，已经出过两次事故。

## Engineering Loop Contract

闭环：`Goal → Task → Run → Worktree → Commit/PR → Verification → Integration →（失败回合）`。

- **证据先于结论**：验证输出才是证据，模型自己的总结是输入。没验证输出不得声称完成。
- **隔离先于并行**：两个写代码的 Agent 必须两个 worktree。
- **恢复靠对账，不靠重跑**：中断后先对账已发生的副作用，再决定续跑还是回滚。
- **状态必须落盘**：Task 状态、base commit、分支、验证证据写进版本化记录（plan / task store / PR 正文）。
- **不合并未验证的分支**：验证失败就留在原地修。

角色契约（Planner / Worker / Evaluator / Integration Controller）、当前能力与缺口：
**[docs/development/engineering-loop.md](./docs/development/engineering-loop.md)**。

## Git

- Conventional Commits，**英文**。`<type>(<scope>): <description>` — imperative、小写、句末无句号、≤72 字符。
  `type`: `feat` `fix` `refactor` `docs` `test` `chore` `build` `ci`。
- body 讲 **what / why**，不讲 how。换行 72 字符。breaking change 加 `BREAKING CHANGE:` 或 `!`。
- **一个 commit 一个逻辑变更**，调试残留先清掉。
- 大改动（跨模块、模式/权限面、打包链路）走 worktree + PR，用 `gh pr merge --merge`
  保留显式 merge 节点；**不 squash、不 fast-forward-only**。小修复可直接提交 master。
- 合并后同步本地 master，拆掉 worktree。
- GitHub 操作优先用 `gh`（`gh pr create` / `gh pr merge` / `gh release view`），网络不稳时更可靠。

## Code

- TS strict，不用 `any`；用 `unknown` + 窄化适配器。外部边界用 `zod` 或既有 schema helper。
- 注释**只用英文**。
- UI 用 `globals.css` 的 CSS 变量（`var(--bg-canvas)`、`var(--text)`、`var(--accent)`），
  适配 light/dark（`data-theme`）。跟随 `packages/ui/src/components/` 既有写法。
- 日志用结构化 logger（`apps/desktop/src/main/logging/logger.ts`），**禁止 `console.log/warn/error`**。

## Docs

| 路径 | 用途 |
| --- | --- |
| [AGENTS.md](./AGENTS.md) | 本文件 —— 地图 + 契约，入口 |
| [ARCHITECTURE.md](./ARCHITECTURE.md) / [ARCHITECTURE_MAP.md](./ARCHITECTURE_MAP.md) | 架构与数据流 / 症状 → 包·文件 |
| `packages/<pkg>/AGENTS.md` | 单包职责 + 排障入口 |
| [docs/exec-plans/README.md](./docs/exec-plans/README.md) | 执行计划索引（开工先读） |
| [docs/development/](./docs/development/README.md) | 开发专题：worktree / 工程闭环 / 测试 / 构建 / 日志 / 发布 / 坑 |
| [docs/design-docs/](./docs/design-docs/) · [docs/product-specs/](./docs/product-specs/) | 设计决策 / 产品规格 |

## Principles

- **渐进披露**：先小后深，能点开的不要贴上来。**代码即真相**：仓库里的版本化产物才是事实源。
- **验证优先**：先有验证工具，再有功能。**先看计划**：动手前先确认当前工作状态。

## 文档与脚本

- 新增仓库级脚本前读 [scripts/README.md](scripts/README.md)：进 scripts/ 必须先登记 npm run 入口，一次性脚本用完即删。
