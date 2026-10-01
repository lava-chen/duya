# 目标结构设计与 Package 取舍裁决

> 阶段一交付物 3/5 · 生成日期 2026-10-01
> 输入：`01-current-state-audit.md`（实测）、`02-reference-repo-boundaries.md`（参考）
> 本文档回答：候选结构是否成立、每个 package 该建/该拆/该合、以及**为什么**。

---

## 0. 裁决原则（来自目标约束，逐条可检验）

一个 package 值得建立，当且仅当满足至少一条：

1. 有明确独立生命周期
2. 有明确依赖方向
3. 被 2 个以上 consumer 使用
4. 需要独立测试
5. 可能存在多个 host
6. 是重要架构 contract
7. 能显著降低 context / build / ownership complexity

本文档对每个裁决都标注命中的准则编号。**不命中的，一律不建。**

---

## 1. 对假设结构的裁决

假设结构：

```
apps/desktop/{src/{main,preload,renderer}}
packages/{agent-protocol,agent-core,agent-runtime}
packages/{ai,mcp,memory,storage,plugin-core}
packages/{computer-use,conductor,gateway,voice}
packages/ui
harness/agent/{tasks,runners,evaluators,fixtures,reports}
```

### 1.1 逐项裁决

| 假设项 | 裁决 | 命中准则 | 依据（实测） |
|---|---|---|---|
| `apps/desktop/` | ✅ **采纳（分阶段）** | 5,7 | electron+src = 336,613 LOC 占全仓 51%。ZCode 证明 host 侧独立 workspace 有独立依赖方向价值 |
| `agent-protocol/` | ✅ **采纳，最高优先级** | 3,5,6 | 缺失成本实测：`electron→agent` 142 条边中 17 条 deep import 全指向 `message/index.ts` 一个文件；另有 **125 条相对路径穿透**直接写进 `packages/agent/src/` |
| `agent-core/` | ✅ **采纳** | 1,2,4 | `agent/` 9,514 + `prompts/` 6,904 + `compact/` 4,554 + `context/` 2,340 ≈ 23k LOC，零外部进程/网络信号 |
| `agent-runtime/` | ✅ **采纳** | 1,2,5 | `process/` 8,235 + `session/` 5,332 + `cli/` 4,822 + `lifecycle/` 741；已由 `AgentProcessPool` 独立生命周期 |
| `agent-tools/` | ❌ **撤回** | — | plan 583 的 `@duya/browser`（19,139 LOC，对 agent/electron 零 import，13 个测试文件）证明**单能力独立成包**优于聚合袋。聚合袋内聚弱、且与"能力插件化"冲突 |
| `workspace/` | ⚠️ **条件采纳** | 2,6 | 只有 roots + path policy 值得（重复 5 次，且 realpath vs 词法两套逃逸检查语义不一致）。env/worktree/connector **不值得** —— 详见 `MONOREPO_RFC.md` §3.2 |
| `mcp/` | ❌ **不建** | — | 实测 `packages/agent/src/mcp` 仅 3,027 LOC 且已是 `@duya/plugin-core/src/mcp/` 的**消费方**（28 条 deep import）。已有 owner，再建包是双份真相 |
| `memory/` | ⚠️ **暂不建，先解耦** | — | `memory-state`(4,045) + `memory-rollout`(3,321) = 7,366 LOC，但 schema owner 在 `electron/memory-state/migrations/`（V1）。**先反转所有权，再谈拆包** |
| `storage/` | ⚠️ **暂不建** | — | 44 处 SQLite 触达分散在 7 个 owner。ZCode 的 `storage` 模块是 16 个塌缩模块里**唯一**被挖出来的 —— 说明它难，不说明该先做 |
| `plugin-core/` | ✅ **保留，但必须先加 build** | 3,6 | 49 条 deep import；无 build step 致 `exports` 完全不参与解析。**但这是加重因素而非唯一原因**（真正的量级是 161 条相对路径穿透） |
| `packages/ui/` | ❌ **现在不建** | — | `src/` 已有 793 文件的组件体系。UI 当前唯一的跨边界问题是 conductor 的 23 条 deep import，**修边界 ≠ 搬目录** |
| `agent-tools/` | ❌ **撤回** | 看到 plan 583 的 `@duya/browser` 后判定：单能力独立成包优于聚合袋。见 §3.1 |
| `harness/agent/` | ✅ **采纳，改名 `evals/`** | 实测：全仓 0 个 harness script，`e2e` 仅 14 个测试文件。改名理由见 `MONOREPO_RFC.md` §4.1（仓库内 "harness" 已有 3 种含义） |

### 1.2 假设之外必须新增的两项

假设结构遗漏了两个实测中最重要的东西：

**① `@duya/platform-ports`（或并入 protocol）**
`electron → src/` 57 条边（provider 24 + preload 4 + plugin 9 + …）是**当前最大的单一边界问题**。
ZCode 的对应物是 `packages/shared/src/platform.ts` 的 `IPlatformService` + `AGENTS.md:52`
"routing platform access through IPlatformService instead of `window.zcode`"。

**② `ProcessScope`（进程登记处）**
实测 spawn 点分散在至少 6 个 owner（`electron/services` 16、`electron/agents` 13、
`packages/agent/tool` 10、`electron/ipc` 6、`packages/agent/cli-control-plane` 6、`electron/plugins` 4）。
grok-build 用 `clippy.toml` 禁裸 `Command::spawn` 强制走 `ProcessScope::enroll`，
并且 Duya **已经有真实 bug 佐证**（`AGENTS.md` footgun：运行中的 Electron 锁住 `.node` 文件）。

---

## 2. 目标结构（修订版）

```
apps/
  desktop/                        # host 侧（独立 workspace，ZCode 模式）
    src/
      main/                       # ← electron/** 迁移
      preload/                    # ← electron/preload.ts
      renderer/                   # ← src/** 迁移
    package.json

packages/
  agent-protocol/                 # ★ 新建。零内部依赖的真叶子
  agent-core/                     # ★ 新建。从 @duya/agent 切出
  agent-runtime/                  # ★ 新建。从 @duya/agent 切出
  browser/                        # ★ 已在做（plan 583 缝 A 分支）。19k LOC 独立能力包
  ai/                             # 保留（provider/model layer）
  plugin-core/                    # 保留 + 补 build + 补 exports
  computer-use/                   # 保留
  conductor/                      # 保留但**重定位**（见 §3.2）
  gateway/                        # 保留
  voice/                          # 保留
  shared/                         # ★ 新建。跨进程 contract + 平台 port
  workspace/                      # ★ 新建（条件）。roots + path policy，见 MONOREPO_RFC §3.2

evals/                            # ★ 新建。不是 workspace member（见 04 §2）
  agent/
    tasks/ runners/ evaluators/ fixtures/ mock-provider/ reports/
```

包总数：8 → **14**。其中 6 个新建，1 个重定位，1 个已在进行中。
**未采纳的假设项：5**（`mcp` / `memory` / `storage` / `ui` / **`agent-tools` 聚合包**）。

> **变更记录**：初版此处是 `agent-tools` + `harness/`（13 包）。
> 看到 plan 583 的 `docs/browser-capability-split` 分支后：
> ① 撤回 `agent-tools` 聚合包 —— 单能力独立成包已被 `@duya/browser` 证明更优（见 §3.1）；
> ② `harness/` 改名为 `evals/` —— 仓库内 "harness" 已有 3 种含义，且 "Control Plane" 才是生产概念
> （见 `MONOREPO_RFC.md` §4.1）。

---

## 2.1 M7 已落地：`apps/desktop/`（2026-10-01）

`apps/desktop/{src/{main,preload,renderer}}` 已实际搬迁，取代原 `electron/` + `src/`：

```
apps/desktop/
  package.json              # @duya/desktop（private，暂不搬依赖）
  tsconfig.main.json        # main 层（不进 gate，见下）
  tsconfig.preload.json     # preload 层
  tsconfig.renderer.json    # renderer 层 —— 根 tsconfig.json extends 它
  src/main/                 # ← electron/**        （main.ts → index.ts）
  src/preload/              # ← electron/preload.ts（→ index.ts）
  src/renderer/             # ← src/**
```

分层 tsconfig 采用 ZCode `packages/desktop` 的形态（main / preload / renderer 分离）。
**可借鉴的是分层，不是目录名** —— 见下。

### 为什么没有照抄 ZCode 的 `packages/desktop` + `packages/ui`

评估过 ZCode 的真实布局（`packages/desktop` + `packages/ui` + `packages/shared`，
只有 `apps/zcode-cli` 在 `apps/`），结论是**不采纳**，理由三条：

1. **先拆 ui 会制造一条新的违规边。** ZCode 能把 desktop 与 ui 分包，靠 `packages/shared`
   兜住跨进程契约（`zcode-protocol-v4` / `model-config` / `node` 等子路径）。
   本次明确**不建 shared**，54 条 `main → renderer` 的边只做机械改写。
   若 ui 独立成包，这 54 条就从"同包内相对路径"变成"main 反向 import renderer 包"，
   正好撞上 `05-architecture-governance.md` 要禁的规则 —— **净负收益**。
2. **准则 3 不满足。** ZCode 有 `@zcode/web` + `@zcode/client` 与 ui 并列，ui 才有 2 个以上
   consumer。duya 只有一个 renderer。
3. **`apps/` 与 `packages/` 的语义。** duya 是单一可部署单元；ZCode 自己把独立分发的
   `zcode-cli` 放在 `apps/`。`apps/desktop` = 可部署应用，`packages/*` = 库，语义更准。

### 抽 `packages/ui` 的触发条件（届时 M3 的 shared 应已就位）

1. 出现第二个真实 renderer consumer（web host，或 conductor 独立可消费）；
2. 先把 **109 个直接引用 `window.electronAPI` 的 renderer 文件**迁到平台端口层
   （实测 504 处引用，`src/lib/ipc-client.ts` 一个文件占 82 处，ZCode 的对应物是
   `packages/shared/src/platform.ts` 的 `IPlatformService`）；
3. 满足 1 + 2 后再抽包。

> **顺序不能反**：先补平台端口层，再抽 ui 包。现在硬抽等于把 109 个 Electron 耦合点
> 冻结进一个"共享包"，将来 web 接入时再全部拆一遍。

### 本次搬迁没有解决的

- **`packages/shared`（M3）未做** —— 54 条 `main → renderer` 边按原路径保留，留给 M3 收敛。
- **main 进程仍无类型门禁** —— `tsconfig.main.json` 已定义但**故意不进 `typecheck:all`**：
  `tsc -p apps/desktop/tsconfig.main.json` 实测有 **898 个既有错误**（与 plan 583 ISS-01 同源），
  挂上即红。main 的安全网目前是 `npm run build:electron`（esbuild 解析每一条 import 边）+ `npm test`。

---

## 3. 关键裁决详述

### 3.1 `agent-tools` 该不该独立？—— 裁决：**不建这个包，改用按能力抽包**

初版建议建一个 `agent-tools` 包收纳"可复用工具"。**在看到 plan 583 的分支后撤回该建议** ——
`@duya/browser`（`.claude/worktrees/browser-capability-split`）已经证明单能力抽包可行，
且优于一个泛化的 `agent-tools` 袋子。

**理由**：

| | `agent-tools`（初版建议） | `@duya/browser`（plan 583 缝 A） |
|---|---|---|
| 粒度 | 一个袋子装 40+ 工具 | 一个能力一个包 |
| 内聚 | 弱（浏览器/文件/进程混在一起） | 强（19k LOC 单一职责） |
| 依赖方向 | 需要自己定 | 已验证：`packages/browser` 对 agent/electron **零 import** |
| 测试 | 混在 agent 的 520 个测试里 | 自带 **13 个测试文件** |
| 演进 | 与 plugin 化冲突 | 与"能力插件化"（缝 B）天然衔接 |

实测（`packages/browser`，19,139 LOC / 73 src 文件 / 13 test 文件）：
对 `@duya/agent` 与 `electron/` 的 import 数为 **0**。

**修正后的规则：可复用能力各自成包，不建 `agent-tools` 聚合包。**

判据仍是同一条 —— *脱离 Electron、脱离 Duwa 概念是否成立* —— 但**结论是"独立成包"而不是"进 agent-tools"**：

| 能力 | 裁决 |
|---|---|
| Browser（19k LOC） | ✅ **独立包** `@duya/browser`（plan 583 已在做） |
| Bash / OS / PowerShell | ⚠️ 与进程/权限强耦合，暂留 runtime |
| Read/Edit/Write/Grep/Glob | ❌ 太薄（合计 ~3k），留在 runtime |
| Canvas/Widget/AppConnection/PostToRoom/SendToAgent/ManageRoutine | ❌ 宿主耦合，留在 runtime |
| Subagent（2.7k） | ❌ 是 runtime 能力不是工具 |

> **注意**：这改变了包数量。`agent-tools` 去掉，新增 `@duya/browser`。
> 8 包 → **14 包**（+6 新建），见 §7。

### 3.2 `@duya/conductor` 重定位：它不是 agent 包

实测 `packages/conductor/src/` 只有三个目录：`database/` · `elements/` · `renderer/`。
`renderer/` 里有 `ConductorView.tsx` / `CapsuleToolbar.tsx` / `CanvasArea.tsx` / `RefinePanel.tsx` 等 **100+ React 文件**。
`packages/agent` 对它的依赖只有 **2 条**：

```
packages/agent/src/tool/WidgetRenderer/HeadlessWidgetRenderer.ts
  → @duya/conductor/elements/widget-css-bridge
  → @duya/conductor/elements/widget-sanitizer
```

**裁决**：
1. 这 2 条依赖是**纯函数**（widget CSS 桥接 + sanitizer），与 React 无关 →
   抽到 `packages/agent-protocol` 或新建 `packages/canvas-widgets`（仅当 renderer 也要用时）。
2. 抽离后，`@duya/conductor` 与 agent **零耦合** → `build:agent` 的
   `|| echo conductor-pass1-errors-ignored` + `clean` + 重编 **三段 hack 可以直接删除**。
3. conductor 本身是 **UI + domain** 包，不属于 agent harness 图。它应留在 host 侧。

> 这是本次审计中**投入产出比最高的一次裁决**：改 2 个 import，删掉一整段构建顺序 hack。

### 3.3 `types.ts` 不能直接升格为 `agent-protocol`

`packages/agent/src/types.ts` 只有 **50 行**，但它是大量 re-export 的枢纽。
升格它会立刻产生 grok-build 式的"名义契约 crate 不是叶子"问题。

**正确做法**：从三个**已经干净**的模块组合出 protocol：

| 来源 | LOC | 外部信号 | 干净度 |
|---|---|---|---|
| `message/` | 3,433 | **零** | ✅ 真叶子候选 |
| `permissions/` | 3,686 | SYS:1 | ✅ |
| `ipc/` | 1,252 | PROC:1 | ✅ |
| `wake/types.ts`, `channels/types.ts` | ~700 | 零 | ✅ |

→ `agent-protocol` 目标 **~9k LOC，零外部 IO，零内部包依赖**，
并**必须**有一个测试遍历其 import 图，任何指向 `agent-core`/`agent-runtime` 的边都 fail
（grok-build 的 `sampling-types` 教训）。

### 3.4 `@duya/plugin-core` 必须先有 build

实测：`"main": "src/index.ts"`，无 `build` script。
`scripts/build-electron.mjs` 专门写 esbuild `alias` 指向包根目录，注释说明是为了 worktree 安全。

**后果**：`package.json` 的 `exports` 字段**从不参与解析**。
这解释了为什么 49 条 `electron → plugin-core` deep import 能长期存在而无人察觉 ——
**根本没有机制能拦住它们。**

> **但要诚实排序**：实测全仓 **161 条**相对路径穿透，其中 16 条指向 plugin-core、
> **125 条指向 `packages/agent`**。`exports` 对相对路径本就无效，
> 所以 plugin-core 的 build 缺失是**加重因素**，不是唯一原因。
> M1（plugin-core 收敛）与 M2（agent entrypoint 收敛）必须都做。

**裁决**：加 `tsc` build + 收紧 `exports` 是**迁移的前置条件**，不是可选项。
其中 `connectors/app-connector-id.ts` 独占 28 条 deep import，需要单独设计公共面。

---

## 4. 依赖方向（目标态）

```
                  ┌─────────────────────────────┐
                  │      agent-protocol         │  零内部依赖
                  │   (message/permissions/ipc)  │  零 IO
                  └──────────────┬──────────────┘
                                 │ 单向向下
              ┌──────────────────┼──────────────────┐
              ▼                  ▼                  ▼
      ┌──────────────┐   ┌──────────────┐   ┌──────────────┐
      │  agent-core  │   │   browser   │   │     ai       │
      │ (纯 reasoning)│   │ (可复用能力) │   │ (provider)   │
      └──────┬───────┘   └──────┬───────┘   └──────────────┘
             └────────┬─────────┘
                      ▼
             ┌─────────────────┐        ┌──────────────┐
             │  agent-runtime  │───────▶│ plugin-core  │
             │ (进程/生命周期)  │        │  (MCP/插件)  │
             └────────┬────────┘        └──────────────┘
                      │
        ══════════════╪══════════════  进程边界（子进程 / HTTP+SSE）
                      ▼
   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
   │ desktop  │  │   cli    │  │ harness  │  │  gateway │  ← 平级 consumer
   │ (host)   │  │ (host)   │  │ (非成员) │  │  (host)  │
   └──────────┘  └──────────┘  └──────────┘  └──────────┘
```

**四条硬规则**（将由 CI 强制，见交付物 4/5）：

| 规则 | 依据（实测违规） |
|---|---|
| `agent-protocol` → 任何实现包 = **禁止** | grok `sampling-types` 教训 |
| `agent-core` → `electron` / `packages/*/host` = **禁止** | V1：16 条 |
| `src/renderer` → `electron` 实现 = **禁止** | V2：9 条 |
| `packages/*` → 根 `src/` 或 `electron/` = **禁止** | V4 反向：57 条需先解耦 |
| `agent-core` ↔ `agent-runtime` 互相 import = **禁止** | V7：18 个循环 SCC，最大 42 文件横跨切口 |

> **V7 是本结构最大的落地风险。** 实测 `modes`/`hooks`/`tool`/`process`/`agent` 同处一个
> 42 文件 SCC。`agent-core`(modes) 与 `agent-runtime`(tool/process/hooks) 的切口
> **被一条真实的环穿过** —— 在解耦之前，TypeScript 层面这个边界不存在。
> 迁移必须先做 C1（见 `06-migration-plan.md`），不能把 M5 当成机械的文件移动。

---

## 5. 明确"暂时不要拆"的清单

以下都是**看起来该拆但现在拆会亏**的，理由逐条给出：

| 不拆 | 理由 |
|---|---|
| `packages/ai` | 17,627 LOC，2 个外部依赖（`@anthropic-ai/sdk`/`openai`），依赖方向已干净（无人 deep import 它）。它已经是正确的 provider layer |
| `packages/voice` | 1,406 LOC。拆它只增加包数量，不减少任何复杂度（不满足准则 7） |
| `packages/gateway` | 16,850 LOC，独立生命周期 + 独立 bundle 已具备。它是 host 侧 consumer，不属于 agent harness 图 |
| `packages/computer-use` | 13,064 LOC，自带 MCP SDK + nut.js + uiohook，独立生命周期成立。但它有自己的 electron backend（`src/electron/`），拆分应与 platform-ports 一起做，不是独立议题 |
| `agent-core` 内的 `modes/`（16,202） | `workflow`(12,186) + `goal`(4,751) + `research`(2,354) 各自内部自洽，且**已经**通过 `ModeModifier` 机制解耦（见 `AGENTS.md` plan 224）。但它同时是最大循环 SCC 的成员（6 个文件），拆分前必须先解环 |
| `agent-core` 内的 `memory-state`/`memory-rollout` | 7,366 LOC，但 schema owner 在 electron。**先反转所有权（V1），再评估拆包** |
| `packages/ui` | 见 §1.1。UI 的问题是边界泄漏，不是缺包 |

---

## 5.1 `agent-core` / `agent-runtime` 的切口为什么不是现成的

第二轮审计（`audit-modules.mjs` + `validate-scc.mjs`）给出硬证据：
`packages/**` 存在 **18 个循环 SCC**，最大一个 **42 文件**，构成如下：

| 模块 | 文件数 | 归属 |
|---|---|---|
| `agent/src/modes` | 6 | A Core |
| `agent/src/hooks` | 5 | D Capability |
| `agent/src/tool` | 4 | B Runtime |
| `agent/src/process` | 3 | E Infra |
| `agent/src/agent` | 2 | A Core |

**这个 SCC 同时包含 A/B/D/E 四类**，正好压在 `agent-core` 与 `agent-runtime` 的切口上。
含义有两层：

1. **不能按目录整体搬。** `modes/` 与 `tool/` 互相依赖，单独搬任一个都会留下悬空引用。
2. **必须先有一轮解耦。** 成本最低的第一步：公共 barrel `src/index.ts` 参与了内部环
   （`tool/SubagentTool/runAgent.ts → src/index.ts → agent/DuyaAgent.ts → tool/StreamingToolExecutor.ts`）。
   barrel 不该被内部模块 import —— 修掉这一条能显著缩小 SCC，且是纯粹的边界卫生问题。

**因此本设计的 M5 阶段被显式降级为"解耦后再拆"**，并在迁移计划中新增 C1 阶段作为前置。

---

## 6. 依赖方向的反直觉发现

**`electron → src/` 的 57 条边必须先解耦，否则 `apps/desktop` 的迁移无法进行。**

如果直接搬 `electron/**` 和 `src/**` 到 `apps/desktop/`，这 57 条相对 import 会全部断裂。
其中 `electron/services/providers/*` → `src/lib/providers/*` 有 24 条，
且 `src/renderer` 又 import `packages/ai`（18 条）。

**正确顺序**（详见交付物 5/5 的迁移阶段）：
1. 先把 provider 类型抽到 `packages/shared`
2. 再把 preload 契约类型抽到 `agent-protocol`
3. **最后**才搬目录

跳过 1–2 直接搬目录，会产生一次 400+ 文件的路径改写 PR，且 review 不可行。

---

## 7. 本文档的裁决汇总

| 动作 | 对象 | 命中准则 |
|---|---|---|
| **新建** | `packages/agent-protocol` | 3,5,6 |
| **新建** | `packages/agent-core` | 1,2,4 |
| **新建** | `packages/agent-runtime` | 1,2,5 |
| **新建** | `packages/shared`（跨进程 DTO + 平台 port） | 3,6 |
| **新建** | `evals/agent`（非 workspace 成员） | 4,5,7 |
| **新建** | `apps/desktop`（分阶段） | 5,7 |
| **新建（条件）** | `packages/workspace`（仅 roots + policy） | 2,6 · 见 `MONOREPO_RFC.md` §3.2 |
| **进行中** | `packages/browser`（plan 583 缝 A 分支已建） | 1,3,4 · 见 §3.1 |
| **保留+修复** | `@duya/plugin-core`（加 build + exports） | 6 |
| **保留** | `@duya/ai`, `@duya/cli`, `@duya/voice`, `@duya/gateway`, `@duya/computer-use` | 1,3,5 |
| **重定位** | `@duya/conductor` → host 侧 UI/domain 包 | 7 |
| **不建** | `packages/mcp`, `packages/memory`, `packages/storage`, `packages/ui`, `packages/agent-tools` | — |

**净变化：8 包 → 14 包（+6 新建，1 进行中，1 重定位，5 个假设项被否决）。**
每一条都对应实测证据，没有一条基于"目录整齐"。
