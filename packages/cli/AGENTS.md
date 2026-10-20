# @duya/cli

> CLI 控制面 + 可复用的终端 TUI。**不导入任何 agent 运行时**（`packages/cli/src/index.ts:8`）。

## 1. 负责 / 不负责

负责：
- Commander 程序 `buildProgram`（`packages/cli/src/index.ts:46`）
- 命令描述符注册表（`packages/cli/src/program/descriptors.ts`、`packages/cli/src/program/registry.ts`）
- 进程内 `duya_cli` 工具契约（`packages/cli/src/contract/index.ts:24`）、`buildAgentRunner`（`packages/cli/src/program/build-agent-runner.ts`）
- 终端 TUI（`packages/cli/src/tui/`）
- worker 入口路径解析 `resolveHostWorkerPath`（`packages/cli/src/worker-path.ts:5`）
- **worker bundle 的 esbuild 入口**（`packages/cli/src/agent-worker-entry.ts:1`，3 行：调 `@duya/host/worker-process-entry` 的 `startWorkerProcess`）

不负责：
- Host 与运行编排 → `@duya/host`（`packages/host/src/run-orchestrator.ts:289`）
- 运行引擎与事件流 → `@duya/agent-runtime`
- Electron / 渲染进程 → `apps/desktop`
- DB schema 与存储 → `@duya/data`
- 工具实现 → `@duya/capabilities`（真实来源见 `packages/agent/src/tool/builtin.ts:8` 的转发）

## 2. 关键文件

| 文件 | 作用 |
| --- | --- |
| `packages/cli/src/index.ts:34` | 公共面：根导出 + subpath `./contract`、`./tui`、`./providers`、`./host-session`、`./host-task-store`、`./transcript-persistence`、`./worker-services` |
| `packages/cli/src/index.ts:46` | `buildProgram` 是纯函数，不做 IO、不改 argv；`bin/duya` 负责接线 |
| `packages/cli/src/index.ts:69` | `duya serve` → `startLocalHost`（`@duya/host/local-host`） |
| `packages/cli/src/tui-command.ts:97` | `duya tui` → 附着已有 Host，或起一个 ephemeral Host |
| `packages/cli/src/contract/index.ts:24` | 硬规则：本模块**不得**导入 agent 运行时；agent 工具经此到控制面，不进 agent 内部 |
| `packages/cli/src/program/build-agent-runner.ts:12` | 进程内派发 + stdout/stderr 捕获（外部 `duya` CLI 不捕获，用户要看到输出） |
| `packages/cli/src/agent-worker-entry.ts:1` | worker bundle 入口；本包同时是 worker 的**装配方**（`workerProcessAssembly`） |

## 3. 排障入口

| 症状 | 先看这里 | 为什么 |
| --- | --- | --- |
| `dev:tui` 报 MODULE_NOT_FOUND | `package.json:114` | `dev:tui` 跑的是打包产物 `bundle/cli.cjs`（gitignored，见 `.gitignore:144`）；新克隆/新 worktree 没有它，先跑 `npm run build:cli-dev`（`package.json:113`） |
| `duya serve` 起不来 | `packages/cli/src/index.ts:69` | 起 Host 的唯一入口；端口非法直接 `exitCode=64`（`:63`） |
| `duya tui` 连不上 | `packages/cli/src/tui-command.ts:97` | 先尝试附着已有 Host，失败才起 ephemeral |
| CLI 说"没有 worker" | `packages/cli/src/worker-path.ts:5` | 解析不到 worker 入口时 Host 以 LEDGER-ONLY 模式运行（`packages/cli/src/index.ts:74`） |
| `duya_cli` 工具命令找不到 | `packages/cli/src/program/descriptors.ts` | 命令集在这里冻结；agent 工具与 CLI 共用同一份描述符（`packages/cli/src/contract/index.ts:9`） |
| agent 工具的输出污染了 TTY | `packages/cli/src/program/build-agent-runner.ts:12` | 只有这条路径捕获 stdout/stderr |

## 4. 边界约束

- 架构层 `host`（`architecture-policy.yaml:119`），模块 `legacy-cli` `managed: false`（`:795`），`requires` 含 `duya-host`、`data`、`agent-protocol`、`client-core`、`legacy-ai`、`command-catalog`（`:811`）。
- 硬规则：`packages/cli/src/contract/index.ts:24` 与 `packages/cli/src/index.ts:8` 都禁止导入 agent 运行时。CLI 与 agent 之间的唯一通道是 HTTP 控制面。
- `bundle/cli.cjs` 是 gitignored 的构建产物（`scripts/build-cli-bundle.mjs:23`），不是源码，别去"修"它。
