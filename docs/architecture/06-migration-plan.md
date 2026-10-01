# 迁移方案（可安全执行）

> 阶段一交付物 5/5（迁移部分） · 生成日期 2026-10-01
> 执行规范遵循 `AGENTS.md` 的 **Worktree → PR workflow**：每个阶段一个 worktree、一个 PR、`gh pr merge --merge`。
> **本阶段（阶段一）只做调查与设计，不执行任何迁移。** 以下是阶段二的执行计划。

---

## 0. 迁移的三条铁律

1. **先建强制机制，再动结构。** 在 `architecture:check` 上 CI 之前不做任何搬迁 ——
   否则搬迁产生的新违规无处可查。
2. **一次只解一类边。** 每个阶段只消除一种边界违规类型，且该阶段的 PR 必须能让 `typecheck:all` 通过。
3. **每阶段可独立回滚。** 合入顺序即回滚顺序。任一阶段失败，`git revert` 该 merge commit 即可。

---

## 1. 阶段总览

| 阶段 | 名称 | 消除的违规 | 风险 | 预估 PR 数 |
|---|---|---|---|---|
| **M0** | 建立架构检查（不移动任何代码） | — （只测量） | 极低 | 1 |
| **C1** | **解耦循环 SCC**（barrel 退出内部环） | 缩小最大 SCC（42 文件） | 中 | 1–2 |
| **M1** | 收敛 plugin-core | 49 deep + 1 missing-artifact | 低 | 2 |
| **M2** | 抽出 `agent-protocol` | 17 deep + 125 escape（agent 部分） | 中 | 2 |
| **M3** | 抽出 `shared`（解 electron→src） | 57 中约 45 | 中 | 2 |
| **M4** | conductor 解耦 + 删构建 hack | 2 + 构建顺序耦合 | 低 | 1 |
| **M5** | 切出 `agent-core` / `agent-runtime` / `agent-tools` | 包级边界成型 | 高（**需先做 C1**） | 3–4 |
| **M6** | 建立 `harness/agent` | — （新能力） | 低 | 3 |
| **M7** | 搬迁 `apps/desktop/` | 路径级 | 高（机械） | 2 |
| **M8** | ProcessScope + spawn 收敛 | ~50 spawn 点 | 中 | 2 |

**关键路径**：M0 → C1 → M5。M0 → M1 → M2 → M3 → M7。M5/M6 可与 M3 并行（不同文件所有权）。

> ⚠️ **C1 是第二轮审计新增的阶段。** 实测 `packages/**` 有 **18 个循环 SCC（最大 42 文件）**，
> 横跨 `modes`/`hooks`/`tool`/`process`/`agent` —— 正好压在 `agent-core` 与 `agent-runtime` 的切口上。
> 不先解耦，M5 的文件移动会导致编译失败。详见 `01-current-state-audit.md` §2.1 V7。

---

## 2. 阶段详情

### M0 — 建立架构检查（前置，不可跳过）

**目标**：让违规变成**可见的、可计数的**，且 CI 阻塞新增。

| 任务 | 产出 |
|---|---|
| M0.1 | `architecture-policy.yaml`（交付物 5 §2 的迁移前版本：全部模块 `managed: false`） |
| M0.2 | `scripts/architecture/architecture-check.mjs` + **能解析 workspace 包名与相对路径穿透**的 resolver |
| M0.3 | **`--self-test`**：断言能数出全部已知违规（568 cross / 161 escape / 117 deep / **18 cycle** / 1 missing-artifact） |
| M0.4 | `.architecture-baseline.json`（指纹式，含全部现有违规） |
| M0.5 | 接入 CI（**阻塞式 required check**）+ `AGENTS.md` 补 Gates 章节 |

**验收**：
- `npm run architecture:self-test` 输出的违规计数与
  `node scripts/architecture/audit-imports.mjs` 完全一致
- 故意新增一条违规 → CI 失败；`--changed` 模式能抓到下游破坏
- 现有代码**零改动**

**回滚**：删除 `.github/workflows` 中的该 step 即可，无代码影响。

> ⚠️ **这是整个迁移中唯一"必须先做"的阶段。** 跳过它，M1–M8 全部不可验证。

---

### M1 — 收敛 `@duya/plugin-core`（消除 49 条 deep import）

**为什么先做这个**：它是**物理障碍**（无 build step ⇒ `exports` 字段完全不参与解析 ⇒ 任何边界收紧都做不到）。
且 49 条 deep import 中 28 条集中在 `connectors/app-connector-id.ts` 一个文件。

| 任务 | 内容 |
|---|---|
| M1.1 | 给 plugin-core 加 `tsc` build + `exports` 字段；`scripts/build-electron.mjs` 的 `alias` 改为指向 `dist`（保留 worktree 安全注释逻辑） |
| M1.2 | 收窄 `exports`：把 9 个 deep target 提升为显式 subpath export |
| M1.3 | 改写 49 条 `electron → plugin-core` 的 deep import 为 public 路径 |
| M1.4 | plugin-core 转 `managed: true`，从 baseline 移除对应指纹 |

**风险点**：M1.1 会改变 electron 的打包解析。必须验证 `electron:build` + 首轮 chat 冒烟。

**验收**：`architecture:check` 的 `deep-import` 计数减少 49；`typecheck:all` 通过；打包冒烟通过。

---

### M2 — 抽出 `packages/agent-protocol`（最高价值）

**依据**：`electron → agent` 的 142 条边中，17 条 deep import **全部指向 `message/index.ts` 一个文件**。
这不是 17 个违规，是一个缺失的 protocol 包。

| 任务 | 内容 |
|---|---|
| M2.1 | 新建 `packages/agent-protocol`，从 `agent/src/{message,permissions,ipc}` + `wake/types` + `channels/types` 迁入（~9k LOC） |
| M2.2 | `SSEEvent` / `PermissionRequestEvent` / `AgentProgressEvent` 从 `@duya/ai` **迁入** protocol；`@duya/ai` 反向依赖 protocol |
| M2.3 | 加 `RunEvent` / `RunRequest` / `RunHandle` / `AgentRuntimeApi`（交付物 4 §3） |
| M2.4 | **真叶子测试**：遍历 protocol 的 import 图，任何指向实现包的边都 fail（grok 教训） |
| M2.5 | 事件闭合性测试：`RunEvent.type` 全集 round-trip（grok `define_methods!` 模式） |
| M2.6 | 改写 17 + 4 条 deep import；protocol 转 `managed: true` |

**风险点**：M2.2 是破坏性的类型移动，会波及 `packages/agent` 内大量文件（`types.ts` 是 re-export 枢纽）。
建议 M2.2 单独一个 PR。

**顺序理由**：M2 在 M3 之前，因为 `apps/desktop` 搬迁（M7）需要 protocol 已经稳定。

---

### M3 — 抽出 `packages/shared`（解 `electron → src`）

**为什么必须做**：`electron → src/` 有 **57 条**边。不解开，M7 的目录搬迁会产生 400+ 文件的路径改写。

| 任务 | 内容 |
|---|---|
| M3.1 | 抽 `src/lib/providers/{types,legacy,catalog,domain/ProviderValidation}` 到 `packages/shared`（占 24 条中的大部分） |
| M3.2 | 抽 `src/types/{bash-task,hook-task,usage,index}` 到 `packages/shared`（preload 契约类型，4 条） |
| M3.3 | 抽 `src/{lib/plugin-types,lib/plugin-error-messages,types/import}` 到 `packages/shared`（9 条） |
| M3.4 | 改写 electron 侧引用；`src/` 保留 re-export 保持渲染层零改动 |
| M3.5 | 解 `src → @duya/ai`（18 条）：provider **类型**留在 `ai`，但 renderer 只能引类型（`import type`），运行时逻辑走 IPC |

**风险点**：M3.5 若处理不当，会把 Node SDK 拖进浏览器 bundle。
`vite.config.ts:optimizeDeps.needsInterop` 现有的 4 条配置就是泄漏的**成本证据**。
验收时要确认 bundle 里不再出现 `@anthropic-ai/sdk` / `openai` 的运行时代码。

**验收**：`electron → src` 计数归零；`architecture:check` 的 `forbiddenDependencies` 中
`packages/** → src/**` 一条不再触发。

---

### M4 — conductor 解耦 + 删除构建顺序 hack

**投入产出比最高的一步**：改 **2 个 import**，删掉一整段构建 hack。

**当前**（`package.json:16`）：
```
"build:agent": "... && (npm run build:conductor || echo conductor-pass1-errors-ignored)
              && npm run -w @duya/agent build && npm run -w @duya/conductor clean
              && npm run build:conductor"
```

| 任务 | 内容 |
|---|---|
| M4.1 | 把 `widget-css-bridge` / `widget-sanitizer` 两个纯函数从 `packages/conductor/src/elements/` 移到 `packages/shared`（或 `agent-protocol`，取决于是否 renderer 也用） |
| M4.2 | 改写 `HeadlessWidgetRenderer.ts` 的 2 条 import |
| M4.3 | `build:agent` 简化为 `build:ai && build:cli && build:agent`（删除 `|| echo`、删除 `clean`、删除二次 build） |
| M4.4 | `@duya/conductor` 重定位为 host 侧 UI/domain 包（不进 agent harness 图） |

**验收**：`npm run build:agent` 在干净 checkout 上一遍成功；`|| echo` 消失。

---

### M5 — 切出 `agent-core` / `agent-runtime` / `agent-tools`

**本阶段风险最高**，因为 `packages/agent` 有 870 文件 / 177k LOC，且 `tool/` 58k 行是单体。

| 任务 | 顺序 | 内容 |
|---|---|---|
| M5.1 | 先切叶子 | `agent-core` = `agent/` + `prompts/` + `compact/` + `context/`（~23k LOC） |
| M5.2 | 再切 runtime | `agent-runtime` = `process/` + `session/` + `cli/` + `lifecycle/`（~19k） |
| M5.3 | 选择性切 tools | 只搬可复用工具（见交付物 3 §3.1），宿主耦合的留在 runtime |
| M5.4 | 处理残留 | `modes/`（16k，含 plan 224 的 `ModeModifier` 机制）**暂不动** |

**关键约束**：
- **必须在 C1 之后**。实测 `modes`/`hooks`/`tool`/`process`/`agent` 处在同一个 42 文件 SCC 里，
  直接移动会得到一个编译不过的中间态。C1 把 barrel 从内部环里摘出来后，切口才存在。
- M5.1/M5.2 之间，`packages/agent` 仍需存在并 re-export，保持 `electron` 侧 142 条 import 不变
- 只有当 M5.4 也完成后，才删除 `packages/agent` 并批量改写 electron 引用

**建议**：M5.1–M5.3 各一个 PR，每个 PR 结尾 `packages/agent` 变成纯 re-export shim。
最后 M5.5 一个 PR 切换 electron 侧引用 + 删除 shim。

---

### C1 — 解耦循环 SCC（M5 的前置，第二轮审计新增）

**为什么必须先做**：最大 SCC 的 42 个文件同时包含目标结构里的 `agent-core`（`modes/`）
与 `agent-runtime`（`tool/`、`process/`、`hooks/`）。在这条环解开之前，
`agent-core` 与 `agent-runtime` 的边界在编译层面根本不存在。

| 任务 | 内容 | 验证 |
|---|---|---|
| C1.1 | 让公共 barrel 退出内部环：`src/index.ts` 不应被 `tool/SubagentTool/runAgent.ts` 等内部模块 import，改为直接引用具体模块 | `node scripts/architecture/audit-modules.mjs` 的 SCC#1 规模下降 |
| C1.2 | 逐个拆解剩余 SCC，优先拆 14 文件那个（`tool` 7 + `skills` 4 + `permissions` 2 + `types.ts` 1） | SCC 数量 / 规模逐轮下降 |
| C1.3 | 把 `cycle` 规则的 baseline 从 18 逐步降到 0 | 每降一个，从 baseline 移除对应指纹 |

**验收**：`node scripts/architecture/validate-scc.mjs` 的交叉验证保持 0 误报；
`typecheck:all` 通过；每一步 SCC 数量或最大规模严格下降。

> **经验参考**（codex）：它的 `core → app-server-protocol` 只有 2 个文件用它，
> 结果被当成"已知 wart"长期挂着。**Duya 的 18 个 SCC 是同一类问题的规模版，
> 不做 C1 就直接 M5，等于把编译失败推给拆包阶段。**

---

### M6 — 建立 `harness/agent`

**可以与 M3/M5 并行**（文件所有权不重叠：只新增 `harness/**`）。

按交付物 4 §9 的 H1–H7：

| 任务 | 内容 | 依赖 |
|---|---|---|
| M6.1 | `harness/agent/{tasks,runners,evaluators,fixtures,reports}` 骨架 + README | 无 |
| M6.2 | `local-runner` 跑通单次 run | M2（Run API） |
| M6.3 | `mock-provider`（wire-level，grok 模式）+ 3 个 smoke task | M6.2 |
| M6.4 | `subprocess-runner` / `http-runner`，验证三者行为一致 | M6.3 |
| M6.5 | 4 个 evaluator + `reports/` 历史与跨 run 比较 | M6.3 |
| M6.6 | 接 CI（PR 上跑 smoke） | M6.4, M6.5 |

**M6.2 之前的 H1 可以立刻开始**（protocol 已在 M2 建好）。

---

### M7 — 搬迁 `apps/desktop/`

**必须在 M2、M3 之后**。此时 `electron ↔ src`、`electron ↔ agent` 的边都已收敛或已指向 public 入口，
搬迁主要是机械的路径改写。

| 任务 | 内容 |
|---|---|
| M7.1 | `apps/desktop/` 骨架 + 独立 workspace 配置（ZCode 模式：host 侧独立依赖方向） |
| M7.2 | `electron/**` → `apps/desktop/src/main/`；`electron/preload.ts` → `src/preload/` |
| M7.3 | `src/**` → `apps/desktop/src/renderer/` |
| M7.4 | 更新 `tsconfig` / `vite.config` / `scripts/build-electron.mjs` / `electron-builder.yml` |
| M7.5 | 更新 `AGENTS.md` 的 Map 与 Footguns 章节 |

**风险**：`AGENTS.md` 里有大量 `electron/` 路径引用需同步更新；
`electron-builder.yml` 的 `files` 规则需验证打包产物。

**验收**：全流程 `electron:build` + `electron:pack:win` + 冒烟（首轮 chat 到达 `ready`）+
`app.log` 无 `ERR_MODULE_NOT_FOUND`。

---

### M8 — ProcessScope + spawn 收敛

来自 grok-build `clippy.toml` 的最高价值单条建议。Duya 有真实 bug 佐证
（`AGENTS.md` footgun：Windows 上运行中的 Electron 锁住 `.node` 文件）。

| 任务 | 内容 |
|---|---|
| M8.1 | `packages/process-scope`：`ProcessScope.spawn/fork`，统一登记 + 生命周期绑定 + 清理 |
| M8.2 | `disallowed-process-spawn` 规则先以 `warn` 模式全量记录 spawn 点 |
| M8.3 | 迁移 6 个 owner 的 spawn 点（`electron/services` 16、`electron/agents` 13、`packages/agent/tool` 10、`electron/ipc` 6、`cli-control-plane` 6、`electron/plugins` 4 …） |
| M8.4 | 规则转 `error` |

---

## 3. 依赖关系图

```
M0（架构检查）  ← 必须最先，且必须阻塞
 │
 ├── M1（plugin-core）──┐
 ├── M2（protocol）─────┼── M5（core/runtime/tools）──┐
 ├── M4（conductor）────┘                             ├── M7（apps/desktop）
 ├── M3（shared）─────────────────────────────────────┘
 └── M6（harness）  ← 可与 M3/M5 并行（只新增文件）
 
M8（ProcessScope）← 独立，随时可做
```

**可并行**（文件所有权不重叠）：
- M1 ∥ M4 ∥ M6 ∥ M8
- M2 → M3 → M5 → M7 为串行关键路径

---

## 4. 每阶段的通用验收门槛

每个阶段的 PR 必须同时满足（`AGENTS.md` Gates）：

```bash
npm run typecheck:all          # 必过（esbuild 不做类型检查）
npm run test                   # 必过
npm run architecture:check     # 必过（M0 后）
npm run electron:build         # M1/M2/M7 必过
```

UI 相关阶段额外：`AGENTS.md` 要求用 Playwright MCP 验证，M7 需完整打包冒烟。

**PR 规范**（`AGENTS.md`）：Conventional Commits，英文，≤72 字符标题，
worktree 内提交（`node_modules` 需 junction），`gh pr merge --merge` 保留 merge commit。

---

## 5. 风险登记

| 风险 | 概率 | 影响 | 缓解 |
|---|---|---|---|
| M0 的 resolver 漏检（复制 ZCode 的洞） | 中 | 高（治理假象） | **`--self-test` 断言已知违规计数**（568 cross / 161 escape / 117 deep / **18 cycle** / 1 missing） |
| **M5 撞上 18 个循环 SCC** | **高** | **高** | **已在计划中：C1 必须先做** —— 见下方新增的 C1 任务 |
| M2 类型移动波及面超预期 | 中 | 中 | M2.2 单独 PR；`types.ts` 的 re-export 分层迁移 |
| M3.5 把 Node SDK 拖进 renderer bundle | 中 | 中 | 验收时检查 bundle 内容；优先 `import type` |
| M5 在 177k LOC 上做移动 | 高 | 高 | 每步保留 `packages/agent` 为 re-export shim；小 PR |
| M7 破坏打包 | 中 | 高 | M7 前先验证 M1/M2 的打包链路已跑通 |
| CI 长期红 → 团队绕过 | 中 | 高 | M0 起用 `managedOnly: true`，**只拦新增** |

---

## 6. 阶段一交付物清单

| 文件 | 内容 |
|---|---|
| `docs/architecture/01-current-state-audit.md` | 实测：8 个图 + 7 类违规 + agent 模块分类 + 修正记录 |
| `docs/architecture/02-reference-repo-boundaries.md` | ZCode / codex / grok-build 的边界成因与共同失败模式 |
| `docs/architecture/03-target-structure.md` | 目标结构 + 逐项裁决（7 准则）+ 不拆清单 |
| `docs/architecture/04-agent-harness-design.md` | Run API / 事件 / 权限 / 取消恢复 / evaluator / 落地顺序 |
| `docs/architecture/05-architecture-governance.md` | policy yaml + 12 规则 + 执行引擎设计 |
| `docs/architecture/06-migration-plan.md`（本文） | M0–M8 阶段、依赖图、验收门槛、风险登记 |
| **`scripts/architecture/audit-imports.mjs`** | **可复现审计器**：读取各包真实 `exports` 字段判定 public/deep/escape，输出本文档全部数字 |

**阶段一未修改任何产品代码。** 仓库改动为 7 份设计文档 + 1 个审计脚本。

---

## 7. 本文档的已知修正

初版 M0 门槛要求 checker 复现 "8 escape"（4 条 `src→agent` + 4 条 `src→electron`）。
该前提**错误**：实测 `src → packages/` 的相对路径穿透为 **0**，
那 4 条 `src→agent` 是裸标识符（3× `@duya/agent` + 1× `@duya/agent/message`），经 `exports` 正常解析。

真实穿透数是 **161**，且 100% 来自 `electron/`（其中 125 条指向 `packages/agent`）。
修正后 M0 门槛数字与 `05-architecture-governance.md` §4.2 / §5 一致。
详见 `01-current-state-audit.md` §9。
