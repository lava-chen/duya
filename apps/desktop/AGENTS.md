# @duya/desktop

> Electron 桌面外壳：拥有 main 进程、preload 桥、窗口、SQLite 启动、Agent Server 子进程、每 bot 频道管道，以及 app-connection 的桌面侧实现。

## 负责 / 不负责

- **负责**：`src/main/**`（进程、IPC、DB、Agent Server、频道、连接器）、`src/preload/**`（contextBridge 全量表面）、`src/contracts/**`；`src/renderer/**` 只是 3 文件挂载壳（`main.tsx` / `global.d.ts` / `vite-env.d.ts`）+ 转发 shim。
- **不负责**：React 组件 → `@duya/ui`（渲染器已整体搬走，`apps/desktop/src/renderer/main.tsx:3` 只 import `App`）；Host → `@duya/host`；agent 运行时 → `@duya/agent-runtime`；持久化真身 → `@duya/data`。

## 关键文件

| 文件 | 作用 |
| --- | --- |
| `apps/desktop/src/main/index.ts:210` | 主进程入口；`:292` 读 `boot.json` 解析数据库路径 |
| `apps/desktop/src/preload/index.ts:1` | 整个 `contextBridge` 表面（3220 行）—— renderer 能调什么全看这里 |
| `apps/desktop/src/main/ipc/index.ts:43` | 34 个 `register*Handlers` 的集中导出；`apps/desktop/src/main/ipc/lazy-ipc-registry.ts:1` 是懒注册表 |
| `apps/desktop/src/main/ipc/contracts.ts:34` | 高风险通道的 zod 入参 schema |
| `apps/desktop/src/main/agents/server/router.ts:1` | run 路由（4130 行）；`interagent-router.ts`、`workflow-runtime-manager.ts` 同目录 |
| `apps/desktop/src/main/agents/server/worker-manager.ts:20` | worker 路径解析：打包走 `resources/harness-bundle/worker-entry.js`（运行时路径，不在仓库内），开发走 `packages/host/bundle/worker-entry.js`（`:25`） |
| `apps/desktop/src/main/memory-state/migrations/index.ts:42` | `memory-state.db` 的 schema 迁移（**不是** `packages/data` 那套） |

公共面：无。`apps/desktop/package.json` 是 workspace app（`main` → `src/main/index.ts`），**没有 `exports` map**，不要当库 import。

## 排障入口

| 症状 | 先看这里 |
| --- | --- |
| `window.electronAPI` undefined | `apps/desktop/src/preload/index.ts` → `apps/desktop/src/main/ipc/index.ts:43` → `apps/desktop/src/main/ipc/lazy-ipc-registry.ts:1` |
| IPC 契约整体对不上 | `scripts/ipc-contract-census.mjs:66` 仍读**已删除**的 `electron/` 目录 → `node scripts/ipc-contract-census.mjs` 现在直接 exit 2，要查只能人工比对 preload 与 `apps/desktop/src/main/ipc/*.ts` |
| 白屏 / 窗口没内容 | `apps/desktop/src/main/core/window-manager.ts:329`（`loadURL`）→ 仓库根 `index.html:154`（挂载 `apps/desktop/src/renderer/main.tsx`） |
| 查不到某个持久化 store | `apps/desktop/src/main/db/core/index.ts:1` 是 barrel，**真身在 `packages/data`**（`apps/desktop/src/main/db/core/session-store.ts:1` 等多为转发 shim） |
| App Connector / bot 频道连接器不通 | `apps/desktop/src/main/services/app-connections/connector-service.ts:1`（App Connector）**或** `apps/desktop/src/main/channels/connector-runtime.ts:1`（bot 频道）—— 两套子系统 |
| CI 的 `test` job 红了，但日志说 `Test Files N passed` + `Errors 1 error` | 有一个**未捕获异常**，不是用例失败。查 `Uncaught Exception:` 那行指向哪个文件——2026-10 修过一处：`apps/desktop/src/main/logging/logger.ts` 的写流错误处理曾把 `ENOENT` 抛成未捕获异常（`Logger extends EventEmitter` 而全仓无 `error` 监听器，Node 语义即抛）。回归测试在 `apps/desktop/src/main/__tests__/logger-write-stream-error.test.ts` |

## 边界

- `architecture-policy.yaml:462` — 模块 `desktop-host`，`managed: false`（带基线债务）。`architecture-policy.yaml:377` 的 `legacy-desktop` 仍指向已删除的 `src` / `electron` 根，是过期条目。
- 构建入口在 `scripts/build-electron.mjs`（main、preload、agent-server）—— 改了入口必须重跑 `npm run electron:build`。
- 唯一的 gotcha：**别混两套清单**——renderer↔main（Electron IPC）无普查脚本；worker↔main↔host 的通道散落在 `apps/desktop/src/main/agents/server/` 与 `packages/host/src/`，同样无门禁脚本。持久化 store 也别在 `apps/desktop/src/main/db/core/` 里找，那里只是 barrel，真身在 `packages/data`。
