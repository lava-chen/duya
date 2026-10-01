# Duya 仓库架构现状审计 (Current-State Audit)

> 阶段一交付物 1/5 · 生成日期 2026-10-01
> 方法：静态导入图解析 + Cargo/manifest 读取 + 人工追踪运行时职责。
> **所有数字由 `node scripts/architecture/audit-imports.mjs` 复现**（该脚本读取每个 workspace 包的
> 真实 `exports` 字段来判定 public / deep import）。本轮已修正初版两处口径错误，见 §9。
> **本文档只描述事实，不含建议。**

---

## 0. 一句话结论

Duya 目前是**单 workspace、八个平级包、两个巨型文件夹**的结构。真正的架构问题不是"包太少"，而是
**没有任何一层被强制执行**：跨边界 import 有 **568** 条，其中 **117** 条是绕过 public entrypoint 的 deep import、
**161** 条是相对路径穿透包边界；`packages/agent` 内部有 **18 个循环依赖 SCC（最大 42 文件）**，
以 177k 行承载了 core + runtime + protocol + capability + infrastructure 五种生命周期。

---

## 1. Workspace / Package Inventory

`package.json:8-10` → `"workspaces": ["packages/*"]`。根目录**没有** `apps/`。

| package | version | main | deps（内部） | 内部 peer | src files | src LOC | 有独立 build | 有独立 test 配置 |
|---|---|---|---|---|---|---|---|---|
| `@duya/agent` | 0.1.0 | `dist/index.js` | ai, cli, computer-use, conductor, plugin-core | — | 870 | 177,278 | ✅ `tsc` | ✅ `tests/vitest.config.ts` |
| `@duya/ai` | 0.1.0 | `dist/index.js` | — | — | 94 | 17,627 | ✅ | ❌ |
| `@duya/cli` | 0.1.0 | `dist/index.js` | — | — | 39 | 9,614 | ✅ | ❌ |
| `@duya/conductor` | 0.1.0 | `dist/index.js` | — | react, react-dom | 120 | 22,913 | ✅ | ❌ |
| `@duya/plugin-core` | 0.1.0 | **`src/index.ts`** | — | — | 43 | 6,009 | ❌ **无 build** | ❌ |
| `@duya/computer-use` | 0.0.1 | `dist/index.js` | ai | — | 77 | 13,064 | ✅ | ❌ |
| `@duya/gateway` | 0.1.0 | `dist/index.js` | — | — | 70 | 16,850 | ✅ | ❌ |
| `@duya/voice` | 0.1.0 | `dist/index.js` | — | — | 11 | 1,406 | ✅ | ❌ |

非包根目录的两个巨型主体：

| 目录 | files | LOC | 说明 |
|---|---|---|---|
| `src/` | 793 | 168,483 | React Renderer |
| `electron/` | 640 | 168,130 | Electron Main + preload + DB + services |
| **合计主体** | **2,353** | **444,996** | **占全仓 68%** |

**测试分布**（`*.test.ts(x)` / `*.spec.ts`）：`packages` 520 · `electron` 235 · `src` 192 · `e2e` 14。
**仓库内没有任何 harness / eval 脚本**（`package.json` 无 `harness` 相关 script）。

---

## 2. Import Dependency Graph

由 `scripts/architecture/audit-imports.mjs` 生成。规模：**3047 个源文件 · 13700 条 import 边 ·
7978 条内部边 · 568 条跨边界边 · 34 条未解析**（未解析项为 stale 引用与字符串误匹配，见 §2.4）。

只列内部跨边界边：

```
 electron-main → pkg:agent          142
 pkg:agent      → pkg:ai             80
 electron-main → pkg:plugin-core     67
 electron-main → src-renderer        57   ★ 方向反了
 pkg:agent      → pkg:plugin-core    28
 src-renderer   → pkg:conductor      23
 electron-main → pkg:ai              20
 src-renderer   → pkg:ai             18   ★ renderer 引 Node SDK
 electron-main → pkg:computer-use    16
 pkg:agent      → electron-main      16   ★★ agent 引 electron
 electron-main → pkg:gateway         13
 src-renderer   → pkg:plugin-core    12
 src-renderer   → electron-main       9   ★★ renderer 引 main
 electron-main → pkg:conductor        7
 pkg:agent      → pkg:computer-use    6
 src-renderer   → pkg:agent           4
 electron-main → pkg:voice            4
 pkg:agent      → pkg:cli             4
 pkg:computer-use → pkg:ai            4
 pkg:agent      → pkg:conductor       2   ★ 唯一的包级"环"来源
 pkg:cli        → pkg:plugin-core     2
```

### 2.1 硬违规清单（带证据）

**V1 — `packages/agent` → `electron/`（16 条）**
全部集中在测试 fixture，属于真实的 schema 所有权倒置：

| 源 | 目标 |
|---|---|
| `packages/agent/src/memory-state/__tests__/fixture.ts` | `electron/memory-state/migrations/000{1,2,3,5,6,7,8}_*.sql.ts`（7 个） |
| `packages/agent/src/memory-rollout/__tests__/extractor.retry.test.ts` | 同上 7 个 migration |
| `packages/agent/tests/unit/automationScheduler.test.ts` | `electron/automation/{schedule,types}.ts` |

> 根因：**SQL migration 的 owner 在 `electron/memory-state/migrations/`，但 schema 的消费者是 `packages/agent/src/memory-state/`**。这是数据所有权错位，不是"测试偷懒"。

**V2 — `src/` → `electron/`（9 条）**

| 源 | 目标 | 次数 |
|---|---|---|
| `src/lib/app-connection-ipc.ts` | `../../electron/services/app-connections/types` | 4 |
| `src/global.d.ts` | `electron/preload.ts` | 2 |
| `src/components/settings/ImportCookiesDialog.tsx` | `../../../electron/preload` | 1 |
| `src/lib/__tests__/permission-profile.contract.test.ts` | `../../../electron/lib/permission-profile` | 1 |
| `src/components/workflow/run-display/run-status.test.ts` | `../../../../electron/db/core/workflow-store` | 1 |

> 全部是 **type-only** 需求（`types.ts` / `preload` 的 `window.electronAPI` 声明），没有运行时实现泄漏。修复成本低。

**V3 — `src/` → `packages/agent`（4 条，走 public entrypoint，合法）**

| 源 | specifier |
|---|---|
| `src/components/chat/InlineTaskRow.tsx` | `@duya/agent` |
| `src/components/chat/MessageInput.tsx` | `@duya/agent` |
| `src/hooks/useTaskList.ts` | `@duya/agent` |
| `src/lib/project-message-transcript.ts` | `@duya/agent/message` |

> **修正说明（见 §9）**：初版误称这 4 条"走相对路径、绕过 `exports`"。实测全部是**裸标识符**，
> 经 `packages/agent/package.json` 的 `exports` 正常解析到 `dist/index.d.ts` / `dist/message/index.d.ts`。
> **它们不是 deep import，也不是包边界穿透。**
> 其中 `@duya/agent/message` 被计为 1 条 deep import，仅因为它是 `exports` 里的 subpath 而脚本
> 只把 `"."` 视作完全公开入口 —— 这是脚本口径的保守取值，不是违规。
> 真正的问题是这 4 条让 renderer 直接依赖了 agent 的**构建产物**，见 §6。

**V4 — `electron/` → `src/`（57 条，方向反了）**
最密集的是 provider 层：`electron/services/providers/*` 共 24 条 import `src/lib/providers/*`；
另有 `electron/preload.ts` → `src/types/{bash-task,hook-task,usage,index}.ts`（IPC 契约类型反向依赖 renderer）。
这是**当前最大的单一边界问题**：Main 依赖 Renderer 的类型定义，Renderer 又要能独立 typecheck。

**V5 — deep import inventory（117 条，按 `exports` 字段判定）**

| 边界 | 条数 | distinct targets |
|---|---|---|
| electron-main → plugin-core | 49 | 9（`connectors/app-connector-id` 独占 28） |
| src-renderer → conductor | 23 | 17 |
| pkg:agent → plugin-core | 19 | 11 |
| electron-main → agent | 17 | **1**（`packages/agent/src/message/index.ts` 独占 17） |
| pkg:agent → cli | 4 | 1（`packages/cli/src/contract/index.ts`） |
| pkg:agent → conductor | 2 | 2 |
| pkg:cli → plugin-core | 2 | 1 |
| src-renderer → agent | 1 | 1（`@duya/agent/message`，见 V3 修正） |

> `electron → agent` 的 17 条 deep import **全部指向同一个文件** `packages/agent/src/message/index.ts`。
> 这不是 17 个违规，是**一个缺失的 protocol package**。

**V6 — 包边界穿透（相对路径进入 `packages/`）：161 条，全部来自 `electron/`**

| 发起方 | 条数 | 代表 specifier |
|---|---|---|
| `electron-main → pkg:agent` | 125 | `../../packages/agent/src/agent-profile/config-agents.js` |
| `electron-main → pkg:plugin-core` | 16 | `../../packages/plugin-core/src/types` |
| `electron-main → pkg:gateway` | 13 | `../../packages/gateway/src/adapters/feishu` |
| `electron-main → pkg:conductor` | 7 | `../../../packages/conductor/src/database/types` |
| **`src-renderer → *`** | **0** | — |
| `tests/` `e2e/` → `*` | 0 | — |

> **实测确认：全仓从 `src/` 出发的相对路径进入 `packages/` 的 import 为 0 条。**
> renderer 侧对 `packages/` 的全部引用都是合法的 `@duya/*` 裸标识符。
> 穿透全部集中在 Electron Main，且规模（161）是 deep import（117）的 1.4 倍 ——
> **相对路径穿透才是 main↔packages 耦合的主因，而不是缺 `exports` 声明。**

**V7 — 模块级循环依赖：18 个 SCC，最大 42 文件** ⚠️ **（第二轮修正，初版误报 0）**

Tarjan SCC 扫描 `packages/**`（`.ts`/`.tsx`，排除 tests）→ **18 个 size>1 的循环分量**。
由 `node scripts/architecture/audit-modules.mjs` 复现，并用独立 BFS 逐对验证可达性
（`scripts/architecture/validate-scc.mjs`：抽样 14 对，0 误报；SCC#1 的 42 个成员两两互相可达）。

最大的 SCC（42 文件）横跨 5 个模块：

| 模块 | 文件数 |
|---|---|
| `agent/src/modes` | 6 |
| `agent/src/hooks` | 5 |
| `agent/src/tool` | 4 |
| `agent/src/process` | 3 |
| `agent/src/agent` | 2 |

**一条已验证的 8 跳环路**（`verify-cycle.mjs` 实测路径）：

```
modes/index.ts
 → modes/goal/goal-mode.ts
 → modes/goal/goal-tools.ts
 → modes/goal/goal-evaluator.ts
 → tool/SubagentTool/runAgent.ts
 → src/index.ts                     ← 公共 barrel 参与了内部环
 → agent/DuyaAgent.ts
 → tool/StreamingToolExecutor.ts
```

其余 SCC：14（`tool` 7 + `skills` 4 + `permissions` 2 + `types.ts` 1）·
9（`conductor/src/renderer`）· 4（`agent/compact`）· 3（`agent/tool`）· 3（`computer-use/memory`）·
其余为 2 文件的小环。

> **这一条改变了设计前提。** 初版（本轮之前）报告"模块级循环依赖 0"，并据此把
> `forbidCycles: true` 当作"唯一已满足的规则"。该结论是脚本的路径拼接 bug 造成的假阴性
> （图的键用相对路径、边值用绝对路径，导致无边匹配）。
>
> 真实含义：**`modes` / `hooks` / `tool` / `process` / `agent` 五者互相咬合**，
> 它们不是可以按 A/B/C/D/E 干净切开的五个抽屉。最大的 42 文件 SCC 正好横跨
> 目标结构里的 `agent-core`（modes）与 `agent-runtime`（tool/process/hooks）边界
> —— **M5 拆包必须先解耦这条环，否则拆分无法编译通过。**
>
> 根因之一：`src/index.ts` 这个公共 barrel 参与内部环路（`runAgent.ts → src/index.ts → DuyaAgent.ts`）。
> barrel 不该被内部模块 import，这条可独立修掉，能显著缩小 SCC。

### 2.4 未解析 specifier（34 条）
主要为两类：stale 引用（如 `packages/agent/src/tool/AgentTool/*` —— 目录已改名 `SubagentTool`）
与正则误匹配的字符串字面量（`./__stories__/frame`、`.length);`）。
**不影响本文档的任何结论**，但它们本身就是死代码的信号。

---

## 3. Build Dependency Graph

`package.json:16` 暴露了真实的构建顺序问题：

```
"build:agent": "npm run build:ai && npm run build:cli
              && (npm run build:conductor || echo conductor-pass1-errors-ignored)   ← ①吞错
              && npm run -w @duya/agent build
              && npm run -w @duya/conductor clean                                   ← ②清掉重来
              && npm run build:conductor"                                            ← ③再编一次
```

**为什么需要"编两次"**：`packages/agent/src/tool/WidgetRenderer/HeadlessWidgetRenderer.ts` import
`@duya/conductor/elements/widget-{css-bridge,sanitizer}`。`@duya/conductor` 是 agent 的**下游依赖**。
`|| echo ...-ignored` 吞掉第一次的失败，是为了让 agent 的 `tsc` 有机会先看到 conductor 的 `dist/*.d.ts`。
这不是循环依赖，而是**类型层面的构建顺序耦合**。

**tsconfig 层面的边界管理：**

| 文件 | 关键设置 |
|---|---|
| `tsconfig.json:23-31` | `paths` 只映射 `@duya/agent`→`dist`、`@duya/plugin-core`→`src`、`@duya/conductor/renderer`→`src/renderer`；`include` 混入 `packages/conductor/src/renderer/**`；`exclude` 掉 `electron/**` |
| `packages/agent/tsconfig.json` | `module: NodeNext`，`lib: ["ES2022"]`（无 DOM） |
| `packages/conductor/tsconfig.json` | `moduleResolution: Bundler`，`exclude: src/renderer/**` |

> 根 `tsconfig` **把 conductor 的 renderer 当成自己的一部分编译**，而 agent 的 tsconfig 靠 `NodeNext` 隔离 DOM。
> 同一份 UI 代码在两套 resolution 策略下工作，这是 build 脆弱性的来源。

**打包编排（`scripts/`）：** `build-electron.mjs` 有 4 个 entry（`main` / `preload` / `agent-server` / `project-database-worker`）；
`build-agent-bundle.mjs` 单独产出 `packages/agent/bundle/agent-process-entry.js`。
esbuild 的 `alias` 里专门写了 `@duya/plugin-core` → 本地路径，注释说明是为了 worktree 安全（`AGENTS.md` 的 worktree→PR 流程产物）。

---

## 4. Runtime / Process Graph

| 进程 | 入口 | 拥有者 |
|---|---|---|
| Electron Main | `electron/main.ts` → `dist-electron/main.js` | `electron/main.ts` |
| Preload | `electron/preload.ts` | 同时 import `src/types/*`（V4） |
| Agent Server (HTTP+SSE) | `electron/agents/server/index.ts` → `dist-electron/agent-server.js` | `electron/agents/` |
| Project DB Worker | `electron/project-database/worker.ts` | worker thread |
| **Agent 子进程** | `packages/agent/src/process/agent-process-entry.ts` | `AgentProcessPool` (main 侧 `electron/agents/process-pool/`) |
| Agent Worker | `packages/agent/src/tool/WorkerPool.ts` | agent 内部 |
| Gateway | `packages/gateway` | `electron/gateway/message-bus.ts` 驱动 |
| CLI | `packages/cli` | 独立 bundle (`build-cli-bundle.mjs`) |

**child_process 使用分布**（spawn/fork/child_process 出现文件数）：
`electron/services` 16 · `electron/agents` 13 · `packages/agent/tool` 10 · `electron/ipc` 6 · `packages/agent/cli-control-plane` 6 · `electron/plugins` 4 · 其余分散。

> 关键发现：**子进程创建权分散在 main、agent tool、cli-control-plane、hooks、gateway、computer-use 至少 6 个位置**，没有统一的 process-scope 概念（对比 grok-build 的 `xai_tty_utils::ProcessScope::enroll`）。

---

## 5. Data Ownership Graph

**SQLite 触达文件分布：**

| Owner | 文件数 |
|---|---|
| `electron/db` | 37 |
| **`packages/agent`** | **24** |
| `electron/memory-state` | 17 |
| `electron/memory` | 10 |
| `electron/services` | 10 |
| `electron/agents` | 7 |
| `electron/ipc` | 5 |
| `electron/conductor` / `cli` / `project-database` | 各 2–3 |
| `packages/voice` | 1 |

**Migration owner：`electron/memory-state/migrations/`** — 12 个文件（`0001_init` … `0012_extend_agent_type_check_with_room`）。
但 schema 消费方是 `packages/agent/src/memory-state/`（15 files, 4,045 LOC，`E-SQLITE:5`），且其测试直接 deep-import electron 的 `.sql.ts`（V1）。

> **数据所有权结论：memory-state 的 schema owner 与 domain owner 分离在两个进程边界内，且方向是 domain → electron。这必须反转。**

**Provider 层特殊问题**：`electron/services/providers/*`（24 条）与 `src/lib/providers/*` 双向纠缠（V4），
而 `src/renderer` 又直接 import `packages/ai/src/index.ts` 18 次（`E-LLM` 的 Node SDK 进入浏览器图）。

---

## 6. Public API / Deep Import Inventory

`@duya/agent` 的 `exports` 字段有 **4 个入口**：

```json
"exports": {
  ".":                 { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
  "./file-parser":     { ... },
  "./message":         { ... },
  "./context/os-context": { ... }
}
```

`packages/agent/src/index.ts` 是一个**刻意收窄的 barrel**，注释明确说明设计意图：

> "This barrel intentionally exposes only the agent constructor and the small type surface consumed by the desktop renderer and library callers."

**`exports` 只对裸标识符生效，对相对路径完全无效。** 实测：
`electron/` 有 **161 条相对路径**直接写进 `packages/*/src/...`（V6），
其中 **125 条指向 `packages/agent/src/`** —— 这些完全绕过了 `exports`。

`@duya/plugin-core` 更极端：`"main": "src/index.ts"` —— **没有 build step**，
`electron` 的 esbuild 通过 `alias` 硬指向包根目录，导致 `package.json:exports` 完全不参与解析。

---

## 7. `packages/agent/src` 模块分类（按真实 import 指纹）

不按目录名判断，按每个模块的外部依赖信号 + 内部 peer 图。
由 `node scripts/architecture/audit-modules.mjs` 复现：**36 个顶层模块 · 669 个非测试文件 · 156,994 LOC**
（含测试为 870 文件 / 177,278 LOC；两个口径都给出，避免歧义）。

> ⚠️ **本表的分类是"归属倾向"，不是"可独立抽出的边界"。** V7 实测的 18 个循环 SCC
> （最大 42 文件，横跨 modes/hooks/tool/process/agent）说明这五类互相咬合，
> 任何一类都不能原样搬走。见 §9 修正记录第 4 条。

| 模块 | files | LOC | 外部信号 | 分类 | 理由 |
|---|---|---|---|---|---|
| `tool/` | 282 | 58,427 | FS:39 SYS:36 SCHEMA:28 PROC:8 NET:4 BROWSER:3 | **B+E 混合** | 60k 行里同时有纯 tool 定义与直接 spawn 进程的宿主代码 |
| `modes/` | 67 | 16,202 | SYS:16 FS:10 SCHEMA:6 | **A+D** | 23640 LOC 中 `workflow` 12186 + `goal` 4751 + `research` 2354 |
| `agent/` | 28 | 9,514 | SYS:2 | **A Core** | 唯一接近纯 reasoning 的部分 |
| `process/` | 11 | 8,235 | SYS:6 FS:3 | **E Infra** | `agent-process-entry` + `worker-protocol` + backend |
| `prompts/` | 54 | 6,904 | FS:11 SYS:7 TPL:2 | **A Core** | 但含 handlebars 模板与 fs 加载 |
| `session/` | 12 | 5,332 | FS:6 SQLITE:2 PROC:1 | **B+C** | 同时是 run 状态与持久化 |
| `cli/` | 16 | 4,822 | SYS:9 TUI:2 SQLITE:1 | **B Runtime** | agent 内的 CLI/control-plane 宿主 |
| `compact/` | 22 | 4,554 | — | **A Core** | 纯逻辑，唯一零外部信号的实质模块 |
| `utils/` | 24 | 4,231 | SYS:12 FS:7 | **E Infra** | |
| `hooks/` | 14 | 4,223 | SYS:5 FS:4 PROC:2 | **D Capability** | |
| `memory-state/` | 15 | 4,045 | SYS:13 FS:10 SQLITE:5 | **E Infra** | 真正的 data layer |
| `skills/` | 16 | 3,960 | FS:9 SYS:6 | **D Capability** | |
| `permissions/` | 5 | 3,686 | SYS:1 | **C Protocol** | 纯策略定义 |
| `message/` | 10 | 3,433 | — | **C Protocol** | 零外部信号 = 纯 contract；但被 electron 依赖 17 次 |
| `memory-rollout/` | 9 | 3,321 | SYS:7 FS:5 SQLITE:2 | **E Infra** | |
| `mcp/` | 12 | 3,027 | MCP:5 SYS:2 | **D Capability** | |
| `context/` | 10 | 2,340 | FS:2 | **A Core** | |
| `ipc/` | 1 | 1,252 | PROC:1 | **C Protocol** | 单文件 1252 行 |
| `sandbox/` | 7 | 1,098 | PROC:2 | **E Infra** | |
| `channels/`, `wake/`, `decisions/`, `lifecycle/`, `mentions/`, `journal/`, `observability/` | 27 | 4,466 | 少 | **B/D 混合** | host 概念泄漏进 agent |
| `types.ts`, `queue.ts`, `abort.ts`, `constants.ts`, `providers/`, `security/` | 6 | 900 | — | **C Protocol** | `types.ts` 仅 50 行，做了大量 re-export |

**结论**：`packages/agent` 内（排除测试 156,994 LOC）中，**A(Core) 约 30k、B(Runtime) 约 30k、
C(Protocol) 约 8k、D(Capability) 约 25k、E(Infrastructure) 约 30k** — 五类均匀混杂。
**V7 的 18 个循环 SCC 提供了硬证据**：它们通过 `tool/`（58k 行单体）与 `modes/` 互相咬合，
最大 SCC 的 42 个文件横跨 A/B/E 三类，**因此五类都不能原样抽出**。

这直接约束目标结构：`agent-core` / `agent-runtime` 的切分必须**先解耦**，
不能当作机械的文件移动来做。详见 `03-target-structure.md` §3.5。

---

## 8. 关键结论（供设计阶段使用）

1. **不需要大规模重构，但需要先建立强制机制。** 117 条 deep import 里 49+19 条集中在 `plugin-core` 一个包，
   17 条集中在 `agent/message` 一个文件 —— 这是两个点状修复，不是全仓重排。
2. **缺失的不是包，是三样东西**：一个 protocol package（承载 `message` + `types` + `permissions` 形状）、
   一个 agent entrypoint 收敛（消除相对路径 import）、一个 CI 边界检查。
3. **`@duya/conductor` 名不副实**：实际内容是 `database/` + `elements/` + `renderer/`（React canvas），
   与 agent 的耦合仅 2 处 widget 工具函数。它当前承担 `build:agent` 的顺序耦合，纯属命名与位置的偶然。
4. **`plugin-core` 无 build step** 会加重 `exports` 失效，但**这不是 main↔packages 耦合的主因** ——
   主因是 **161 条相对路径穿透**（125 条指向 agent）。收紧 `exports` 之前，必须先消除相对路径引用。
5. **Renderer → `@duya/ai`（18 条）把 Node SDK 拖进浏览器图**，`vite.config.ts:optimizeDeps.needsInterop`
   专门为此配置 CommonJS interop —— 这是边界泄漏的**成本证据**，不是配置偏好。
6. **renderer 侧的包引用本身是干净的**：`src/` → `packages/` 的 4 条全部走 public entrypoint，
   0 条相对路径穿透。真正需要治理的是 Electron Main 的 161 条。
7. **`packages/agent` 内部有 18 个循环依赖 SCC（最大 42 文件）**，横跨 modes/hooks/tool/process/agent。
   这意味着 A–E 五类**不是五个可独立抽出的抽屉** —— M5 拆包必须先解耦，否则编译不过。
   可独立先修的一条：`src/index.ts` 这个公共 barrel 参与了内部环
   （`runAgent.ts → src/index.ts → DuyaAgent.ts → StreamingToolExecutor.ts`），barrel 不该被内部模块 import。

---

## 9. 本轮修正记录

审计经两轮。第一轮结论依赖一次性解析脚本且该脚本有路径拼接 bug；第二轮改为**提交进仓库的解析器**，
并对关键结论做独立交叉验证。修正如下：

| # | 初版断言 | 实测 | 影响 |
|---|---|---|---|
| 1 | `src → packages/agent` 4 条"走相对路径、绕过 `exports`" | 4 条全是裸标识符（3× `@duya/agent` + 1× `@duya/agent/message`），经 `exports` 正常解析 | 传导到 `05` 的 `escapesPackageBoundary` 规则与 `06` 的 M0 门槛数字；两处均已修正 |
| 2 | 跨边界 import "217 处" | **568** 条 | 初版把 `src→electron` 与部分 `electron→packages` 计入不同口径；现统一为"跨 owner 且非 external" |
| 3 | 包边界穿透未单独统计 | **161 条，且 100% 来自 `electron/`；`src/` 为 0** | 补为 V6，并修正了"renderer 是主要问题"的错误权重 |
| 4 | **模块级循环依赖 "0"** | **18 个 SCC，最大 42 文件** | **实质性错误。** 初版脚本的图用相对路径作键、绝对路径作边值，无边匹配 → 假阴性。`forbidCycles` **未**满足；M5 拆包前必须先解耦 |
| 5 | `packages/agent/src` "35 个模块" | **36 个** | 初版手工列举遗漏 `modules/`（空目录被顺带计入）。现由脚本输出 |
| 6 | `packages/agent/src` "177,278 LOC" | **156,994 LOC（排除 tests）/ 870 文件（含 tests）** | 两个数字口径不同：前者排除测试，后者含测试。现两者都给 |

### 4 的根因与修法

`scripts/architecture/validate-scc.mjs` 用**独立 BFS 可达性**交叉验证 Tarjan 结果：
抽样 14 对互查 0 误报，SCC#1 的 42 个成员两两互相可达 —— **环是真的**。
`scripts/architecture/verify-cycle.mjs` 可打印任一文件对之间的实际环路路径作为证据。

**复现方式**：

```bash
node scripts/architecture/audit-imports.mjs          # 跨边界 import 图
node scripts/architecture/audit-modules.mjs          # 循环 + agent 模块指纹
node scripts/architecture/audit-modules.mjs --json   # 完整边集
node scripts/architecture/validate-scc.mjs           # SCC 的 BFS 交叉验证
node scripts/architecture/verify-cycle.mjs <a> <b>   # 打印具体环路
```

### 关键不变量（`05` / `06` 的 self-test 必须与之一致）

```
── audit-imports.mjs ──
files scanned        3047
file edges           13700
internal edges       7978
cross-boundary edges 568
deep imports         117
package escapes      161   (src/ 0 · electron/ 161 · tests+e2e/ 0)
unresolved           34

── audit-modules.mjs ──
packages/ files           1597
cyclic groups (SCC > 1)   18
agent/src top-level mods  36
agent/src files (no tests) 669
agent/src LOC (no tests)  156994
```
