> Historical / superseded for execution. 原位置：`docs/architecture/03-target-structure.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

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
| `workspace/` | ❌ **不建包** | — | 撤回初版的"条件采纳"。职责只有 roots + cwd + accessPolicy 解析，**唯一 consumer 是 Control Plane**（准则 3 不满足，准则 5 仅可能性）。落点：`apps/desktop/src/main/control-plane/workspace/` 内部 module；跨边界形状放 `agent-protocol` 的 `WorkspaceSnapshot`。抽包的三条触发条件见 `MONOREPO_RFC.md` §3.2 |
| `mcp/` | ❌ **不建** | — | 实测 `packages/agent/src/mcp` 仅 3,027 LOC 且已是 `@duya/plugin-core/mcp/` 的**消费方**（deep import）。已有 owner，再建包是双份真相 |
| `memory/` | ⚠️ **暂不建，先解耦** | — | `memory-state`(4,045) + `memory-rollout`(3,321) = 7,366 LOC，但 schema owner 在 `electron/memory-state/migrations/`（V1）。**先反转所有权，再谈拆包** |
| `storage/` | ⚠️ **暂不建** | — | 44 处 SQLite 触达分散在 7 个 owner。ZCode 的 `storage` 模块是 16 个塌缩模块里**唯一**被挖出来的 —— 说明它难，不说明该先做 |
| `plugin-core/` | ✅ **保留，已加 build** | 3,6 | Plan 584 / 06-M1 已落地：加 `tsc` build + 14 个 subpath 的 `exports`，deep import 93 → 0，模块转 `managed: true`。**但这只是加重因素而非全部**——真正的量级是 161 条相对路径穿透（`package-boundary-escape`），留待后续阶段 |
| `packages/ui/` | ❌ **现在不建** | — | `src/` 已有 793 文件的组件体系。UI 当前唯一的跨边界问题是 conductor 的 23 条 deep import，**修边界 ≠ 搬目录** |
| `agent-tools/` | ❌ **撤回** | — | 看到 plan 583 的 `@duya/browser` 后判定：单能力独立成包优于聚合袋。见 §3.1 |
| `harness/agent/` | ✅ **采纳，改名 `evals/`** | 4,5,7 | 实测：全仓 0 个 harness script，`e2e` 仅 14 个测试文件。改名理由见 `MONOREPO_RFC.md` §4.1（仓库内 "harness" 已有 3 种含义） |

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

**③ `packages/cli/src/contract`（第三轮补录，初版遗漏）**
CLI 控制面契约**已经存在且干净**，但它现在被 `@duya/agent` 的 `tool/DuyaCliTool/`
通过子路径 import，违反 host 侧持有实现的依赖方向。其模块头注释已自证边界：

```
Hard rule: this module MUST NOT import any agent runtime
(no `duyaAgent`, no `REPL`, no `loadSkills`, no `session/db.ts`).
```

它与 `apps/desktop/src/main/cli/handlers/`（26 个 handler / 8,713 行，**零个
import `@duya/agent`**）构成一对：**实现住在 `apps/` 里，谁都 import 不到。**
裁决：与 M3 的 `shared/` 一起处理 —— descriptor registry + invocation/result envelope
进 `shared`，handlers 留在 main 作为实现层。**这同时是 §6.2 "第二个 host" 条件
已经满足一半的证据**：传输层（loopback HTTP + bearer）已多 host，缺的是共享代码层。

---

## 1.3 路径注记（阅读本文前必读）

本文成文时 `electron/` 与根 `src/` 尚存，**M7 搬迁后它们已消失**（§2.1）。
下文所有路径按下表换算，不要按字面去找文件：

| 文中写法 | 现路径 |
|---|---|
| `electron/…` | `apps/desktop/src/main/…` |
| `src/…`（renderer 语境） | `apps/desktop/src/renderer/…` |
| `src/renderer` | `apps/desktop/src/renderer` |

**未随之更新的实测数字**（仍以旧路径统计得出，需重跑确认）：
`electron → src/` 57 条边、`packages/* → electron/` 161 条相对路径穿透、
`main → renderer` 54 条。这些是 M3 的输入，M3 开工第一步应重跑
`node scripts/architecture/audit-imports.mjs` 取得新基线。

### 1.4 2026-10-03 复测（`master @ 0dfaf650`）：基线已全部对齐

上表的旧数字已重跑并更新。`architecture-policy.yaml` 的 `selfTest` 块与
`.architecture-baseline.json` **同批重录**，`npm run architecture:check` 现为
**全绿：802 条违规全部 baselined，0 blocking**。

| 指标 | 旧（文档/初测） | 现（实测） |
|---|---|---|
| cross-boundary edges | 568 | **583** |
| deep imports | 117 | **25** |
| package escapes | 161 | **162** |
| unresolved | 34 | **10** |
| 循环 SCC | 18 | **16** |

跨 owner 边 Top 7（现值）：`electron-main→agent` **145** · `agent→ai` 80 ·
`electron-main→plugin-core` 67 · `electron-main→renderer` **53** ·
`agent→plugin-core` 27 · `renderer→conductor` 23 · `electron-main→ai` 21。

> **`deep imports` 117 → 25 不是治理成果，是 resolver 修复。** 详见
> `architecture-policy.yaml` 的 "Re-measured 2026-10-08" 与 "Re-measured 2026-10-02"
> 两段：`exports` 子路径被误判、注释被当代码解析，两次修复共消掉 93 条假阳性。
> **读本文档时不要把 117 当历史峰值去衡量今天。**
>
> **`package escapes` 161 → 162 才是唯一真实增长**，且来自 plan-583 栈
> （`git log` 已核，不是推断）。构成：agent 126 / plugin-core 16 / gateway 13 / conductor 7。
>
> **同时暴露一个此前无人发现的问题**：`.architecture-baseline.json` 是用
> **修复前的 resolver** 录的，导致 941 条指纹里 815 条已不再触发、
> 802 条现存违规全部报 "not in baseline"（641 blocking）。
> **`selfTest` 一直在维护，baseline 从没跟上** —— 闸门是红的，且红得毫无意义。
> 这是"闸门永远是红的 = 没人读"的标准案例，policy 文件开头那段 ratchet 注释
> 描述的正是它自己的失效。

---

## 2. 目标结构（修订版）

```
apps/
  desktop/                        # host 侧（独立 workspace，ZCode 模式）
    src/
      main/                       # ← electron/** 迁移
        control-plane/            # 逻辑层，不是 package（见 §3.5）
          goals/ tasks/ runs/ scheduler/ wake/ approvals/ checkpoints/
          workspace/              # ★ Workspace 落这里：roots / cwd / accessPolicy
          storage/ ipc/ platform/
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

evals/                            # ★ 新建。不是 workspace member（见 04 §2）
  agent/
    tasks/ runners/ evaluators/ fixtures/ mock-provider/ reports/
```

包总数：8 → **13**。其中 5 个新建，1 个重定位，1 个已在进行中。
**未采纳的假设项：5**（`mcp` / `memory` / `storage` / `ui` / **`agent-tools` 聚合包**）。
**另撤回 1 个条件项**：`packages/workspace` → Control Plane 内的 `workspace/` module
（理由与抽包触发条件见 `MONOREPO_RFC.md` §3.2）。

> **变更记录**：初版此处是 `agent-tools` + `harness/`（13 包）。
> 看到 plan 583 的 `docs/browser-capability-split` 分支后：
> ① 撤回 `agent-tools` 聚合包 —— 单能力独立成包已被 `@duya/browser` 证明更优（见 §3.1）；
> ② `harness/` 改名为 `evals/` —— 仓库内 "harness" 已有 3 种含义，且 "Control Plane" 才是生产概念
> （见 `MONOREPO_RFC.md` §4.1）。
> **第二轮（2026-10-01）**：③ 撤回 `packages/workspace` 的"条件采纳" ——
> 它的唯一 consumer 是 Control Plane，收成 `control-plane/workspace/` 内部 module，
> 跨边界只留 `agent-protocol` 的 `WorkspaceSnapshot` 契约（`MONOREPO_RFC.md` §3.2）。

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
> 8 包 → **13 包**（+5 新建），见 §7。

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

### 3.5 Workspace：不是 package，是 Control Plane 内的 module

§1.1 撤回了 `packages/workspace` 的"条件采纳"。**这一节说明撤回后它落在哪。**

重复是真的 —— 5 处 path containment、4 处 permission policy 解析、3 个 cwd normalizer ——
但重复的**收束目标**是一个目录，不是一个包：

```
apps/desktop/src/main/
  control-plane/
    goals/  tasks/  runs/  scheduler/  wake/  approvals/  checkpoints/
    workspace/                 ← roots / cwd / accessPolicy 解析
      workspace-state.ts       # { workspaceId?, cwd, roots[], accessPolicy }
      resolve-workspace.ts
      canonicalize-path.ts     # realpath + 词法两套语义在这里统一
      allowed-roots.ts
      access-policy.ts
```

| 判据 | 是否满足 | 事实 |
|---|---|---|
| 3 · 2 个以上 consumer | ❌ | 唯一 consumer 是 Control Plane；CLI / evals 拿的是物化后的 `RunManifest` |
| 5 · 多个 host | ⚠️ 仅可能性 | 第二个 host 不存在 |
| 1 · 独立生命周期 | ❌ | workspace 状态只在 Run 启动时读一次 |
| 6 · 重要 contract | ⚠️ 部分 | contract 由 `agent-protocol` 的 `WorkspaceSnapshot` 承担 |

**跨边界只留纯数据契约**（`agent-protocol/src/workspace.ts`，零 IO）：

```ts
export interface WorkspaceSnapshot {
  readonly cwd: string;
  readonly roots: readonly WorkspaceRoot[];
}
```

**依赖方向**：

```
agent-protocol (WorkspaceSnapshot)
       ▲ contract
control-plane/workspace/   owns mutable state + resolution
       │ resolve → materialize（run 启动时一次）
       ▼
  RunManifest (immutable)
       ▼
  Agent Runtime          ✗ 不得反查 workspace
```

**抽包的三条触发条件（同时满足才建 `packages/workspace`）**：
① 出现第二个真实 host 且不复用 Control Plane；
② `canonicalizePath` / `resolveRoots` / `validateCwd` / `isWithinRoots` 已稳定且被独立使用；
③ realpath 与词法的语义分歧已关闭。
详见 `MONOREPO_RFC.md` §3.2。

> **不建包不等于不设边界。** 边界由 `agent-protocol` 的只读契约 +
> materialize 唯一入口（`MONOREPO_RFC.md` §6.1）+ CI 的 `control-plane` 禁依赖
> `packages/*` 规则共同保证 —— 与目录层级无关。

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
| `agent-core` ↔ `agent-runtime` 互相 import = **禁止** | V7：最大 42 文件环横跨切口（实测环数 16，基线上限 18） |

> **V7 是本结构最大的落地风险。** 实测 `modes`/`hooks`/`tool`/`process`/`agent` 同处一个
> 42 文件 SCC。`agent-core`(modes) 与 `agent-runtime`(tool/process/hooks) 的切口
> **被一条真实的环穿过** —— 在解耦之前，TypeScript 层面这个边界不存在。
> 迁移必须先做 C1（见 `06-migration-plan.md`），不能把 M5 当成机械的文件移动。
> 切口归属表与解环顺序见 §5.1 / §5.2。

---

## 5. 明确"暂时不要拆"的清单

以下都是**看起来该拆但现在拆会亏**的，理由逐条给出：

| 不拆 | 理由 |
|---|---|
| `packages/ai` | 17,627 LOC，2 个外部依赖（`@anthropic-ai/sdk`/`openai`），依赖方向已干净（无人 deep import 它）。它已经是正确的 provider layer |
| `packages/voice` | 1,406 LOC。拆它只增加包数量，不减少任何复杂度（不满足准则 7） |
| `packages/gateway` | 16,850 LOC，独立生命周期 + 独立 bundle 已具备。它是 host 侧 consumer，不属于 agent harness 图 |
| `packages/computer-use` | 13,064 LOC，自带 MCP SDK + nut.js + uiohook，独立生命周期成立。但它有自己的 electron backend（`src/electron/`），拆分应与 platform-ports 一起做，不是独立议题 |
| `agent-core` 内的 `modes/`（16,095） | `workflow`(12,186) + `goal`(4,751) + `research`(2,354) 各自内部自洽，且**已经**通过 `ModeModifier` 机制解耦（见 `AGENTS.md` plan 224）。但它同时是最大循环 SCC 的成员（6 个文件），拆分前必须先解环。**信号判据：全模块只有 1 个进程信号，切掉它即可整体进 core**（见 §5.1） |
| `agent-core` 内的 `compact/`（4,561） | 外部信号为零，本应是 core 最干净的一块，**但它自己是 4 文件环**（§5.2）。零信号 ≠ 零环 |
| `agent-core` 内的 `memory-state`/`memory-rollout` | 7,366 LOC，但 schema owner 在 electron。**先反转所有权（V1），再评估拆包** |
| `packages/ui` | 见 §1.1。UI 的问题是边界泄漏，不是缺包 |

---

## 5.1 `agent-core` / `agent-runtime` 的切口由「外部信号」决定，不由体量决定

第三轮实测（`node scripts/architecture/audit-modules.mjs`，2026-10-03）推翻了一个想当然的推法：
**按 LOC 大小划切口会划错。** `modes/` 16k 行里混着一个进程信号，
`compact/` 零信号却自己成环，`tool/` 60k 行里 9 个进程 + 4 个网络信号。判据只能是**外部信号**。

| 模块 | 文件 | LOC | 外部信号 | 归属 |
|---|---|---|---|---|
| `compact` | 22 | 4,561 | **零** | core |
| `message` | 10 | 3,433 | **零** | **protocol** |
| `wake` | 7 | 932 | **零** | **protocol** |
| `context` | 10 | 2,340 | FS2 SYS2 | core |
| `agent` | 29 | 9,556 | SYS3 FS1 | core |
| `prompts` | 54 | 6,904 | SYS15 FS11 TPL2 CONF1 | core |
| `modes` | 66 | 16,095 | SYS20 FS10 SCHEMA6 CONF3 **PROC1** | core（须切掉那 1 个 PROC） |
| `ipc` | 1 | 1,264 | PROC1 | runtime |
| `sandbox` | 7 | 1,098 | PROC2 SYS2 FS1 | runtime |
| `hooks` | 14 | 4,223 | PROC2 SYS7 FS4 SCHEMA2 | runtime |
| `cli` | 16 | 4,822 | PROC1 SYS10 FS5 TUI2 SQLITE1 | runtime |
| `session` | 11 | 5,276 | **SQLITE2** PROC1 | runtime |
| `process` | 11 | 8,350 | SYS7 FS3 | runtime |
| `skills` | 16 | 3,960 | SYS13 FS9 | runtime |
| `utils` | 24 | 4,224 | PROC2 SYS13 FS7 IMG1 | runtime |
| `memory-rollout` | 9 | 3,321 | **SQLITE2** SYS7 FS5 | 归属待反转 |
| `memory-state` | 15 | 4,045 | **SQLITE5** SYS16 FS10 | 归属待反转 |
| `tool` | 287 | 60,137 | **PROC9 NET4** SYS59 FS40 SCHEMA29 | runtime |
| `permissions` | 6 | 3,806 | SYS2 | **protocol** |

按此得到三个切分集合：

```
core     = agent + modes + prompts + compact + context   ≈ 39.5k LOC
runtime  = tool + process + session + cli + hooks
           + skills + utils + sandbox + ipc               ≈ 93.4k LOC
protocol = message + wake + permissions                  =  8,171 LOC
```

**`protocol` 的 8,171 行与现存 `packages/agent-protocol` 的 8,171 行完全相等** ——
M2.1 的 "~9k LOC" 不是估的，是照这三个模块量出来的。

> **一个重要区分**：`core` 的判据是"无进程/网络信号"，**不是**"零外部信号"。
> `modes` 有 20 个 SYS + 10 个 FS 信号，但只有 **1 个 PROC** ——
> 那一个就是切口本身，切掉它 `modes` 整体可进 core。
> 反过来 `compact` 信号为零，**自己却是 4 文件环**
> （`compact/transforms/{imageTruncation,micro,canvas}Transform.ts` + `compact/projectionCompress.ts`）：
> **零信号 ≠ 零环**，它不能直接搬。

---

## 5.2 循环 SCC 全谱（实测 16 个）

```
node scripts/architecture/audit-modules.mjs
cyclic groups (SCC > 1)   16        ← 实测值（2026-10-03）
```

**`18` 是 `05-architecture-governance.md` §基线的上限，不是一个应当被覆写的实测值。**
`packages/agent-protocol/test/02-cycle-budget.test.ts` 卡的是 `SCC ≤ 18`，
因此 18 → 16 是**改善**；基线暂不收紧，等 C1 落地后再决定收到 16 还是更低。

全谱（`size 42` 一行脚本只输出前 20 个成员，余 22 个未展示）：

| size | 成员 | 性质 | 解环成本 |
|---|---|---|---|
| **42** | `modes`(6) + `hooks`(5) + `agent`(3) + `tool`(3) + `process`(3) | 阻塞 M5 | 高 |
| **14** | `types.ts` + `tool/{types,catalog-types,catalog-identity,registry,BaseTool,snapshot}` + `skills/{types,registry,rootSnapshotCache,conditionalSkills}` + `permissions/{types,policy}` + `tool/SubagentTool/loadAgentsDir` | **纯类型/注册表环** | **低** |
| 9 | `conductor/renderer/{CanvasArea,ElementChrome,ElementRenderer,GroupLayer,FreeformLayer,Native*}` | React 组件环，与 agent 无关 | 中 |
| 4 | `compact/{transforms/*,projectionCompress}` | core 内部环 | 低 |
| 3 | `computer-use/memory/{core,slice,index}` | barrel 环 | 极低 |
| 3 | `tool/BrowserTool/{CDPClient,HumanLikeCDPClient,WebviewCDPClient}` | 接口环 | 低 |
| 2 | `ai/{index↔retry-client}` · `ai/providers/{catalog↔catalog-data}` · `ai/{types↔auth/helpers}` | barrel 环 | 极低 |
| 2 | `computer-use/backend/mcp/{result-parser↔cua-driver}` | — | 低 |
| 2 | `cli/commands/{doctor↔doctor-config}` | 与 agent 无关 | 极低 |
| 2 | `session/{bash-task-store↔bash-task-registry}` | — | 低 |
| 2 | `prompts/bot/{epoch↔framework}` | — | 低 |
| 2 | `skills/{skillsSync↔loader}` | — | 低 |
| 2 | `tool/OSTool/{context-tool↔ComputerUseTool}` | — | 低 |
| 2 | `permissions/{classifier↔permissions}` | — | 低 |

**16 个环里 15 个可在不碰架构的前提下解掉**，唯一的硬骨头是 42 那个。

## 5.3 barrel 的真实位置：它在路径上，但不在环里

初版（`01` §V7 与迁移计划 C1.1）断言："公共 barrel `src/index.ts` 参与了内部环
（`tool/SubagentTool/runAgent.ts → src/index.ts → agent/DuyaAgent.ts → tool/StreamingToolExecutor.ts`），
修掉这一条能显著缩小 SCC。"

**第三轮实测把这句话拆成两半：一半成立，一半未验证。**

**成立的部分** —— `verify-cycle.mjs` 复现出的路径确实经过 barrel：

```
modes/goal/goal-mode.ts
 → modes/goal/goal-tools.ts
 → modes/goal/goal-evaluator.ts
 → tool/SubagentTool/runAgent.ts
 → src/index.ts                    ← 公共 barrel 确实在这条路径上
 → agent/DuyaAgent.ts
 → tool/StreamingToolExecutor.ts
```

`runAgent.ts` 确有 `import { duyaAgent } from '../../index.js'`。

**未验证的部分** —— **但 `src/index.ts` 不是任何 SCC 的成员**
（`audit-modules.mjs --json` 逐环校验：16 个环无一包含它）。
两者不矛盾：`StreamingToolExecutor.ts` 的 import 全部落在 `tool/` 内部与 `types.js`，
**它不回到 `src/index.ts`**，所以环是在别处闭合的，`index.ts` 只是路径上的一个中转站。

因此：

- 结论"barrel 参与内部环路"**字面上不精确** —— 它参与的是通往环的**路径**，
  不是环本身；
- 结论"修掉这一条能显著缩小 SCC"**从未被验证，且证据倾向于否定** ——
  既然 `index.ts` 不是成员，删掉那条 import 不会让该文件退出任何 SCC；
- 但 **`index.ts` 仍是一个被内部模块 import 的 barrel**，卫生问题依然成立
  （`01` §V7 记录了全仓只有一处内部 barrel import 命中：`mentions/__tests__/`）。

**barrel 参与内部环的真正案例长在别处**，且规模很小：

| 环 | 成员 | 说明 |
|---|---|---|
| 3 | `computer-use/memory/{core,slice,index}` | `index.ts` 是成员 |
| 2 | `ai/{index.ts ↔ retry-client.ts}` | `index.ts` 是成员 |
| 3 | `tool/BrowserTool/{CDPClient,HumanLikeCDPClient,WebviewCDPClient}` | 接口环 |
| 2 | `ai/providers/{catalog↔catalog-data}` · `ai/{types↔auth/helpers}` | — |
| 2 | `computer-use/backend/mcp/{result-parser↔cua-driver}` | — |

**因此 C1 的入口仍是 14 环，但理由要换成不依赖被证伪前提的那一条**：
那 14 个文件**全部是类型与注册表**（`types.ts` / `tool/types.ts` / `catalog-types.ts` /
`permissions/types.ts` / `skills/types.ts` / `registry.ts` / `BaseTool.ts` / `snapshot.ts` / …），
互相 import 是纯粹的卫生问题，**成员清单已完整枚举、逐条可核对**；
且它含 `types.ts` / `permissions/types.ts` / `tool/types.ts` / `tool/registry.ts` / `tool/BaseTool.ts`，
是 42 环里多处依赖的类型来源，拆掉它会**连带缩小 42 环**。
这个理由独立于 barrel 假设，且更强。

> **方法论教训（值得写进流程）**：本轮先只查了 `--json` 的环成员就断言 barrel 无关，
> 又用 `verify-cycle.mjs` 才发现路径真实经过 barrel。
> **"是否在 SCC 成员里"与"是否在通往 SCC 的路径上"是两个不同的问题**，
> 审计脚本各答一个，两者都不足以单独支撑"删掉它能解环"的结论。
> 任何解环任务落地前，都要用**删改 + 重跑 SCC 计数**实测，而不是靠读图推断。

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
| **已落地** | `apps/desktop`（M7 · PR #115，见 §2.1） | 5,7 |
| **模块（非包）** | `control-plane/workspace/`（roots + cwd + accessPolicy） | 见 §3.5 · 契约在 `agent-protocol` |
| **进行中** | `packages/browser`（plan 583 缝 A 分支已建） | 1,3,4 · 见 §3.1 |
| **保留+修复** | `@duya/plugin-core`（加 build + exports） | 6 |
| **保留** | `@duya/ai`, `@duya/cli`, `@duya/voice`, `@duya/gateway`, `@duya/computer-use` | 1,3,5 |
| **重定位** | `@duya/conductor` → host 侧 UI/domain 包 | 7 |
| **不建** | `packages/mcp`, `packages/memory`, `packages/storage`, `packages/ui`, `packages/agent-tools` | — |
| **不建（撤回条件采纳）** | `packages/workspace` | 准则 3/5 不满足 · 见 §3.5 |

**净变化：8 包 → 13 包（+5 新建，1 进行中，1 重定位，5 个假设项被否决，
1 个条件项撤回为 Control Plane 内部 module）。**
每一条都对应实测证据，没有一条基于"目录整齐"。
