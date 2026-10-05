# 06 — 六个新包

> **本阶段覆盖 587 §2「不提前建立通用 tools/memory/storage/ui 包」的禁令。**
> 代价是必须守住:**每个包都要有真实代码迁入,不允许长期空壳。**

---

## 0. 建立顺序

`tooling` **先行** —— 它是其他包的前置(其他包通过 contributor 接入 runtime)。

```text
tooling  →  capabilities  →  connectors
                     ↘     memory
data / ui(独立,不依赖 tooling)
```

---

## 1. `packages/tooling`

见 [02 文件](02-tooling-and-extensions.md) 完整设计。要点:

- 扩展契约 + 装配,**不是**万能注册表
- 13 个独立 contributor 槽位,不是一个 `register(plugin)`
- 装配期 `validate()` 必须有,否则会重复实现
- **不 import** capabilities / connectors / memory

**首个迁入:** `modes/index.ts` 的 `ModeModifier` 机制 + `tool/registry.ts` 的 registry 机制(只取机制,工具实现去 capabilities)。

---

## 2. `packages/capabilities`

**装:** Files / Shell / Browser / MCP / ComputerUse 的能力实现。

**不装:** Goal / Task / Session 生命周期的任何知识。能力不知道自己被谁调用。

| 迁入 | 从 | 备注 |
| --- | --- | --- |
| ReadTool / WriteTool / EditTool / GlobTool / GrepTool | `tool/ReadTool` `WriteTool` `EditTool` `GlobTool` `GrepTool` | 基础 FS |
| ApplyPatchTool | `tool/ApplyPatchTool` | |
| BashTool + PowerShellTool | `tool/BashTool/` `PowerShellTool` | **含第二 bundle 入口 `BashWorker.ts`** |
| OSTool + ComputerCuaTool | `tool/OSTool/`(7 文件) | platform-specific |
| BrowserTool 全家 | `tool/BrowserTool/`(**40 文件,402 KB**) | 含 20 个站点 extractor |
| CanvasConductor | `tool/CanvasConductor/`(25 文件) | |
| skills | `skills/`(16 文件) | |
| mcp | `mcp/`(11 文件) | |
| sandbox | `sandbox/`(7 文件) | |
| ModuleTool | `tool/ModuleTool` | |
| ImageGenerateTool / VisionTool | 对应目录 | |

**体积占比:约 1.5 MB,是本系列最大的包。**

### 2.1 BashWorker 的特殊约束

`BashWorker.ts` 是**第二个 esbuild 入口**,由 `scripts/build-agent-bundle.mjs` 单独 emit 到 `packages/agent/bundle/BashTool/BashWorker.js`,`external: []`(完全自包含)。

**迁移时必须同步改 `build-agent-bundle.mjs` 的两个 `entryPoints` 和 outdir**,否则打包产物路径错位。门禁 G22。

### 2.2 合法空壳状态

包建立后、迁入完成前,允许:`src/index.ts` + 已迁入的 1–2 个能力 + 对应测试。
**不允许:** 只有 `package.json` 和空的 `index.ts`。

---

## 3. `packages/connectors` — App Connectors

**只装 App Connectors。** 不装 MCP server(plugin-core 的 `mcp/` 归 capabilities),不装 plugin marketplace(归 `plugin-core` 自身)。

| 迁入 | 从 |
| --- | --- |
| App connector 目录与 schema | `packages/plugin-core/src/connectors/`(`app-connector-id.ts` `app-schema.ts`) |
| AppConnectionTool | `packages/agent/src/tool/AppConnectionTool/`(3 文件) |
| AppConnectorManageTool | `packages/agent/src/tool/AppConnectorManageTool/`(2 文件) |

**边界:** connector 提供"外部服务的能力",但**不知道 Goal / Task / Run**。它是能力的一种,不是生命周期的一部分。

**与 plugin-core 的关系:** `plugin-core` 是插件框架(安装、市场、manifest),`connectors` 是 App 连接能力。**两者不合并** —— 前者是分发机制,后者是运行时能力。

---

## 4. `packages/memory` — Memory V2

**装:** `memory-state/` + `memory-rollout/`。**不装** transcript、不装 compaction。

| 迁入 | 从 | 备注 |
| --- | --- | --- |
| memory 布局与路径 | `memory-state/memory_layout.ts` `memory_paths.ts` `canonical_file.ts` `entity_dirs.ts` | |
| 策展账本与投影 | `memory-state/curation_*.ts`(4 文件,61 KB) | `curation_ledger` `curation_projection` `curation_projection_live` `curation_validator` |
| 资格与分层 | `memory-state/eligibility.ts` `tierConflicts.ts` | |
| lease / 对账 | `memory-state/lease.ts` `reconcile.ts` | |
| outbox | `memory-state/outbox.ts` | `assertSafe` 是安全断言,**与 capabilities 的路径校验是不同 subject,不合并** |
| 抽取器 | `memory-rollout/extractor.ts`(42 KB) | |
| 写入器 | `memory-rollout/writer.ts` | |
| 唤醒 | `memory-rollout/wakeup.ts` | **注意:`wake` 语义 → CP `wake/`,但 memory 唤醒是 memory 域,需区分** |
| stage1 策略 | `memory-rollout/stage1_policy_editor.ts` `stage1_prompt_loader.ts` | |
| prompt | `memory-rollout/prompt.ts` `compactMessages.ts` | |

### 4.1 `wakeup` 的归属歧义(实施前必须裁决)

`memory-rollout/wakeup.ts` 里的 "wakeup" 是 **memory 域的**("该注入记忆了"),不是 **CP `wake/` 域的**("该启动一个 run 了")。

**同名不同 subject,不合并。** 裁决:留在 `memory`,CP `wake/` 只管 run 级触发。

---

## 5. `packages/data`

**装:** SQLite / JSONL / filesystem 的**实现**。不含业务决策。

| 迁入 | 从 |
| --- | --- |
| SQLite 连接与 migrations | `apps/desktop/src/main/db/`(78 文件) |
| CP repository 的 SQLite 实现 | `control-plane/sqlite-repository.ts` |
| JSONL / filesystem 存储 | `memory-state/outbox.ts` 的文件侧、`bash-task-store.ts`(若确认为 subject C) |

**约束:** `data` **不认识** Goal / Task / Run 的业务语义,只认识 repository interface。业务规则在 CP。

**注意 better-sqlite3 的 V8-ABI 约束:** 这个 native 模块是 Electron 与本地 Node 两套 ABI,`scripts/ensure-sqlite-abi.mjs` 会在 pre-hook 自动换。**`data` 包不能假设任何特定的 ABI 状态**,也不要在 import 时做版本探测。

---

## 6. `packages/ui`

**装:** 共享 UI 组件。**不含** renderer 状态逻辑。

| 迁入 | 从 |
| --- | --- |
| 跨 host 复用的组件 | `packages/conductor/src/renderer/` 的可复用部分 |

**`apps/desktop/src/renderer/` 的绝大部分不进 `ui`** —— 它是 Desktop 私有的,`contracts/` 已经承担了 DTO 共享。

**空壳风险最高的一个包。** 如果实施时发现没有第二个 consumer,按 587 原则推迟 —— 但**推迟要记录,不能静默跳过**。

---

## 7. 门禁

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| G7 | `tooling` 不 import capabilities/connectors/memory | 加一条违规 import |
| G22 | bundle entry 路径与新包位置一致 | 改 `build-agent-bundle.mjs` 的 entryPoints 使产物错位 |
| G23 | 三个能力包不含 Goal/Task/Session 类型 | 在 capabilities 里 import `TaskId` |
| G24 | `data` 不含业务规则 | 在 data 里写一个 if-业务判断 |
| G25 | 无长期空壳(有 src 实现或明确推迟记录) | 提交一个只有 package.json 的包 |
