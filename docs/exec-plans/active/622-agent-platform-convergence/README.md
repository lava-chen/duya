# 622 — 平台收口系列（依赖测量先行）

> **一句话**：先把「依赖图测不准」这件事修好，再谈拆包、提层、退役。
> 本系列是 622 号工作项的**唯一状态源**；卡片状态只认**具名测试 + commit**。

- 编号：622（610–621 已占用）
- 目录名 `622-agent-platform-convergence` 沿用 610 系列的 `NNN-<kebab>` 惯例
- 基线：`d9eb7dba`（= `origin/master`，2026-10-23）
- 状态：active · 负责人：worker（`codex/plan-622`）· 更新：2026-10-23

---

## 0. 本系列解决什么

外部审计提出了一批「骨架已在、约束未贯穿」的指控。本系列**先复核、再排期**：
每一条断言要么被本系列的实测证实并落成卡片，要么被更正后记录在
[§3 裁决摘要](#3-裁决摘要)。

复核结论一句话：**本仓最紧的不是设计，是测量。**
`architecture:check` 100% 豁免、层表只覆盖 20 个包里的 10 个、切片图跨包边为 0——
在测量修好之前拆包，等于在一个坏尺子上量长度再决定怎么切。

### 边界

- **只排期，不改代码。** 卡片描述「怎么改」，执行由后续 agent 在各自检出完成。
- 独占路径（本系列只写文档）：`docs/exec-plans/active/622-agent-platform-convergence/**`、
  `docs/exec-plans/README.md`、`docs/exec-plans/catalog.md`。
- 每张卡片的**执行**路径在卡内「独占路径」字段单独声明，不属于本系列。

### 明确不做的事

| 不做 | 理由 |
| --- | --- |
| **不先拆 `@duya/host`** | 今天的层表看不见跨包边的 79.8%。无层且不受检的包越多，约束越弱。先修门禁与层表，再谈提包。见 [03](03-host-layer-verdict.md)。 |
| **不在测量修好前动 `packages/agent` 退役的消费者** | 退役门禁数的是字面引用（`@duya/agent` / `packages/agent/...`），不依赖依赖图；它可以并行，但**不要用"退役顺手改依赖"来掩盖层表问题**。 |
| **不新建第二个状态机** | 与[多 Agent 编排计划](../2026-10-23-multi-agent-orchestrator.md)一致：后台子 Agent 生命周期落盘复用 `BashTaskStore` 范式，不另起一套。 |
| **不重复写 610 T19 的根因记录** | T19 已经把 `resolveTarget` 的根因、受影响下游、与 T18 的分母耦合写完了。本系列 [01](01-import-graph-resolver.md) 只补执行细则与验收，不复述根因。 |
| **不合并任何 PR** | 未经用户授权。 |
| **不加 baseline 指纹、不放宽断言换绿** | 根 `AGENTS.md` 明令禁止。 |
| **不重排 610 的既有队列** | 610 §4 规则 4：卡片状态只认具名测试 + commit；本系列不改 610 的追踪表，只在卡内写明关系。 |

---

## 1. 为什么「现在拆包」是错的

三条实测事实（方法见 [§4 验证契约](#4-验证契约)）：

1. **切片图看不见任何跨包边。**
   `scripts/architecture/import-graph.mjs` 的 `resolveTarget`（`:283-319`）把裸
   `@duya/<rest>` 映射到 `packages/<rest 第一段>`（**子路径被丢弃**），候选只试
   `<pkg>.ts` / `<pkg>/index.ts`；而本仓**没有任何包在根目录放 `index.ts`**
   （入口一律 `src/index.ts`，实测 20/20）。结果：
   **755 个唯一 `@duya/*` 说明符全部解析为 `null`**，
   图里跨包 value 边 **0 条**，同包边 4132 条。
   正确的解析器（`audit-imports.mjs`，按各包 `package.json` 的 `name`/`exports` 建注册表）
   在同一棵树上看到 **2593 条跨边界边**。
2. **层门禁只看得见 20.2%。**
   `scripts/architecture/boundary-gates.mjs` 的 `LAYERS`（`:67-75`）只有四层
   （protocol / core / runtime / host），覆盖 10 个包；**另外 10 个包不在任何层**
   （`client-core` `command-catalog` `data` `host` `input-completion` `plugin-core`
   `sandbox` `tooling` `ui` `voice`）。实测：**2593 条跨边界边里 G1 只审 523 条（20.2%），
   跳过 2070 条（79.8%）**。跳过的主因是**源包无层**（1627 条）。
3. **主门禁当前 100% 豁免。**
   `architecture:check` 实测：检测 2608 / tolerated 2608 / blocking 0，
   baseline 2785 条指纹、**255 条已不再触发**。绿色目前只证明"没有新增违规"。

**推论**：现在拆 `@duya/host`（461 文件 / 95,948 LOC）等于在一个测不出跨包依赖的尺子上
做结构决策——新拆出的包会落在**没有层、没有反向边门禁**的状态里，而现状的 `@duya/host`
本身就是这样（它贡献了 1425 条被跳过的跨包边，占全部跳过边的 69%）。
**先修测量、再动结构**是本系列唯一的排序原则。

---

## 2. 切片总表

| 卡 | 标题 | 解决的审计断言 | 依赖 | 状态 |
| --- | --- | --- | --- | --- |
| [01](01-import-graph-resolver.md) | 修 `import-graph` 裸 `@duya/*` 解析 | A1 | 610 T19 | todo |
| [02](02-gate-wiring-and-single-resolver.md) | 两套解析器收敛 + 关键门禁接进 CI | A2 A3 A4 | 01 | todo |
| [03](03-host-layer-verdict.md) | `@duya/host` 层归属裁决 | A5 A6 | 01 02 | todo |
| [04](04-remaining-unlayered-packages.md) | 其余无层包的层归属 | A5 | 03 | todo |
| [05](05-client-axis-reverse-gate.md) | 客户端轴反向依赖门禁 G11 | B17 | 03 04 | todo |
| [06](06-runtime-purity.md) | runtime 纯净度：过渡导出 vs 实耦合 | A7 | 04 | todo |
| [07](07-workflow-dag-parallel.md) | workflow DAG 同层并行 | A8 | 多 Agent Phase 1 | todo |
| [08](08-background-subagent-lifecycle.md) | 后台子 Agent 生命周期落盘 | A10 | 多 Agent Phase 1 | todo |
| [09](09-security-and-governance.md) | 安全与治理一条线 | A11 A12 | — | todo |
| [10](10-retirement-and-doc-truth.md) | 退役收尾 · 残留目录 · 文档事实源 | A13 A14 A15 | — | todo |
| [11](11-resident-reconciler.md) | 常驻对账监督者 | B16 | 08 | todo |

---

## 3. 裁决摘要

本节是本系列**唯一**的裁决来源。卡片不重复论证，只链接到这里。

### 3.1 `@duya/host`：进层，且今天就能进

**裁决：`@duya/host` 进 `host` 层；同时把整个 legacy `@duya/agent` 包按 host 成分豁免。**

依据（实测三态对比）：

| 场景 | G1 审到的跨边界边 | 占比 | G1 会报的反向边 |
| --- | --- | --- | --- |
| A 现状（`@duya/host` 无层） | 523 | 20.2% | 0 |
| B 只把 `@duya/host` 进 `host` 层 | 1665 | 64.2% | **355**（其中 345 是 `pkg:agent -> pkg:host`） |
| C 进 `host` 层 **+** legacy `@duya/agent` 整包按 host 豁免 | 1665 | 64.2% | **0** |

- 场景 B 的 345 条反向边**全部来自待退役的 `packages/agent`**，不是活跃架构的违规：
  `pkg:agent -> pkg:host` 共 345 条，只有 **8 条**落在 `sourceLayerOf`（`:112-122`）
  已有的豁免洞（`packages/agent/src/cli/**` 与 `agent-process-entry.ts`）内，
  **337 条在洞外**。
- 场景 C 把豁免从「两条路径」扩到「整个 legacy 包」，与既有先例一致
  （`packages/agent` 本来就在退役中）。**结果：覆盖翻 3.2 倍，新增反向边 0。**
- 所以 `@duya/host` **不需要**被单独设计门禁，也**不需要**先拆包。
  它需要的是**进层表**——今天它贡献 1425 条被跳过的跨包边，是最大的单点盲区。

详见 [03](03-host-layer-verdict.md)。

### 3.2 runtime 纯净度：两条不同的路径

`packages/agent-runtime` 的跨层耦合必须拆成两件事，不能一把梭：

| 路径 | 现状 | 处置 |
| --- | --- | --- |
| **过渡导出** | → `@duya/client-core` 5 处引用，全在 `surface/index.ts:20,43` / `surface/legacy-projection.ts:28` / 根 `index.ts:194,217`，全是 `SurfaceModel` 的 re-export | **该迁走**。A8.1 已把 `SurfaceModel` 平移到 `client-core`（PR #270 / `943225cf`），这些 re-export 是平移留下的过桥 |
| **实耦合** | → `@duya/capabilities` 22 条跨包边 / 15 个 import 语句；→ `@duya/plugin-core` 2 处（`tools/catalog/catalog-identity.ts:9-10`，真值导入） | **不该直接迁走**。`authorization/permissions/types.ts:1` 与 `policy.ts:1` 的 `export * from '@duya/capabilities/permissions'` 是**值导出**（不是 type-only），说明权限模型本体住在 `capabilities` |

**裁决**：过桥的迁走，**契约的经端口注入**。硬编码一条判据：
`@duya/capabilities` 的权限契约要有一个**协议级或 core 级**的归属，
`agent-runtime` 通过**端口**拿到它，而不是通过包级 re-export。
这与 `@duya/capabilities` 与 `@duya/agent-runtime` **同层**的事实一致——
所以这不是层违规，是**职责归属**问题。详见 [06](06-runtime-purity.md)。

### 3.3 安全与治理合并成一条线

四件事共享同一个根：**"系统认为自己做了什么"和"系统实际做了什么"之间没有对账**。

| 项 | 现状实测 | 裁决 |
| --- | --- | --- |
| manifest 权限真实来源 | `manifest-factory.ts` 头部注释（`:19-30`）自述：路由层 `effectivePermissionRules` 是 legacy `{permissions:{...}}` 形状、不是 `PermissionRulesWire`；无线格式来源时 manifest 记 `hasRules:false`（`:187` / `:262`），`permissionPolicy` 标 `synthesised: true` | **建立唯一的 wire 格式来源**；legacy 形状在边界**显式转换**并标 `synthesised`，不是 cast |
| sandbox 隔离 | **比审计说的更重**：`wrapCommand` / `executeIsolated` 在 `@duya/sandbox` 之外**零生产消费者**；`BashTool.ts` 与 `BashWorker.ts` 零 sandbox 引用；`worker-process-entry.ts:1325` 只调 `setSandboxEnabled(true)` + 预热镜像（错误被 `.catch(() => {})` 吞掉） | **把 `none` 从"降级"改成"接线缺失"**：要么把 `executeIsolated` 接进 `ShellCommandRuntimePorts`，要么把 `setSandboxEnabled` 的假保证去掉 |
| 资源预算 | 协议 manifest 只有 `max_turns`；`BudgetLedger`（`worker-workflows/host.ts:83-107`）只管 workflow 的 agent 调用次数 | **预算要覆盖 CPU/内存、token、并发、文件写入、外部副作用**——并明确哪些是**已测量**、哪些是**未测量** |
| 不可验证结果的外部调用 | 与 [11](11-resident-reconciler.md) 同源 | 外部副作用必须可对账 |

详见 [09](09-security-and-governance.md)。

### 3.4 退役与文档事实源

| 项 | 实测 | 裁决 |
| --- | --- | --- |
| `packages/agent` 退役 | 门禁 `agent-retirement: OPEN`，扫 3772 个活跃文件、770 处引用（production-source=19 / build-tooling=84 / active-config=13 / test-target=654） | 门禁接进 CI；退役收尾按既有 [12](../610-architecture-series/12-agent-retirement-coordination.md) / [13](../610-architecture-series/13-agent-retirement-consumers.md) 执行，**本系列不重写** |
| 3 个未跟踪残留目录 | `packages/{computer-use,computer-use-demo,conductor}`：`git ls-files` 均为 **0**，磁盘上只剩 `dist/` `node_modules/` `tsconfig.tsbuildinfo`——**每个文件都被现有 ignore 规则命中**（`.gitignore:2` `node_modules/`、`:6` `dist/`、`:10` `*.tsbuildinfo`），所以 `git status` 对它们完全沉默 | **它们不是 Git 状态，删掉零风险**；但要先证明没有活路径指向它们 |
| 文档事实源漂移 | `ARCHITECTURE_MAP.md:16` 写「23 workspace packages」，`:33` 把已迁出的 `computer-use` 列为在册包并给 `src/access.ts:136`；`:60-62` 的「12 个包不在任何层」列了 `computer-use`（master 无此包）和 `web`（是 app 不是包）——**实测是 10 个包无层**。另：`docs/architecture/ARCHITECTURE.md` 仍有 3 处指向已删除的 `packages/computer-use/src/**`；`docs/development/test-inventory.json` 有 **162 处**指向已删除文件（生成物，跑 `npm run test:inventory:write` 即可修） | 改成「**20 packages + 2 apps**」的真实口径；生成物重跑；手写文档逐条核对 |

详见 [10](10-retirement-and-doc-truth.md)。

### 3.5 对账：机制齐，缺的是常驻监督者

**裁决：审计这条「不成立」要改写为「部分成立」。**

对账机制是齐的：`workflow-run-api.ts:48` 的 `reconcileStaleRuns`、
`session-api.ts:686` 的 `reconcileRollouts`、`packages/data/src/run-store.ts:310`
的 `run_attempt_epoch` 迁移与 epoch 栅栏、`packages/agent-protocol/src/checkpoint.ts`
的 resume token epoch 栅栏。

**但「缺常驻监督者」这个说法过头了，精确的事实是：**

- Desktop **有**开机对账：`apps/desktop/src/main/index.ts:397` 调
  `reconcileStaleRuns([])`，注释明写 Plan 560 §6.2「本进程刚启动，没有任何引擎在跑」。
  这不是"没有"，这是**一次性开机对账**，不是常驻循环。
- `reconcileStaleRuns(activeRunIds)` 的 `activeRunIds` 由**调用方提供**
  （`http-server.ts:2577` 从请求体取；`apps/desktop/src/main/agents/db-bridge.ts:2424`
  从 IPC 取）。唯一生产调用点传的是**空数组**。
  ⇒ 这个参数在生产里**从未被真正使用过**——它是一个安全阀，不是一个活性来源。
- `reconcileRollouts` 只挂在 IPC（`db-handlers.ts:547`）上，**没有开机调用**。
- `packages/host`（独立 Host）与 `packages/cli` **没有任何对账启动路径**。
- Host 有 `setInterval` 定时器（idle reaper 等），但**没有一个是对账**。

⇒ 真正缺的是：**(a) rollout 对账的开机调用；(b) 独立 Host/CLI 路径的开机对账；
(c) 周期性对账（开机一次不能覆盖"运行中崩溃"）；(d) 后台子 Agent 生命周期的对账
（见 [08](08-background-subagent-lifecycle.md)）**。

详见 [11](11-resident-reconciler.md)。

### 3.6 客户端轴：缺的是门禁，不是状态机

**裁决：审计这条「不成立」应改写为「成立，但性质是词汇债 + 门禁缺失」。**

- TUI 与 UI 的 run-session 视图**都**取 client-core 的 `RunSessionSnapshot`
  （`packages/cli/src/tui/run-session-view.ts:39`、`packages/ui/src/lib/run-session-view.ts:1`），
  client-core 有带 seq 校验与 late/replayed 处理的 reducer
  （`packages/client-core/src/session/run-session.ts:119`）。**状态机是共用的。**
- 遗留的是**词汇**：TUI 仍自持 `LegacyFrame`（`packages/cli/src/tui/blocks.ts`），
  UI 仍自持 `@/types/message`。
- 真正缺的是**门禁**：`15-slice-a8-client-core.md:20` 记着
  「客户端轴没有反向依赖门禁，G10 只覆盖浏览器入口」。

⇒ 卡片 [05](05-client-axis-reverse-gate.md) 落在**门禁**，不在"再统一一次状态模型"。

---

## 4. 验证契约

本系列所有卡片共享同一份基线。**任何卡片开工前必须先复现基线，失败先归因，
不吞退出码、不跳过用例、不放宽断言换绿。**

### 4.1 基线（2026-10-23 实测，非转述）

- SHA：`d9eb7dba96f63b3e07b4fba9c068acd017616913`（= `origin/master`）
- dirty 范围：**无**（`git status --short` 只有 `node_modules` 类的 ignored 条目）
- 环境：macOS 12.7.6（Darwin 21.6.0 x64）· Node v20.20.2 · npm 10.8.2 · vitest 3.2.4
- 检出：`.claude/worktrees/plan-622`，分支 `codex/plan-622`

| 命令 | 退出码 | 结果 |
| --- | --- | --- |
| `npm run plan:sync` | 0 | `plan-sync-check  16 done rows · 28 file refs · 14 test-name refs` → `plan-sync-check  OK` |
| `npm run architecture:check` | 0 | 检测 2608 / tolerated 2608 / blocking 0 / baseline 2785 / `255 baseline fingerprint(s) no longer triggered` → `OK — no new boundary violations.` |
| `npm run architecture:boundaries` | 0 | G1/G3/G4/G7/G8 全 BASELINED（known 0 / new 0 / stale 0）；G6 known 9；G9 known 5 → `no new findings.` |
| `npx vitest run scripts/architecture/slice-classification.test.ts` | 0 | 1 file / **30 passed** |
| `npx vitest run scripts/architecture/slice-cut-list.test.ts` | 0 | 1 file / **16 passed** |
| `npm run architecture:slice-graph` | 0 | files 4047 / typeEdges 7127 / valueEdges 5962 / sccType 18 / sccValue 6 |

### 4.2 复核脚本（本系列用来取证的一次性探针）

下面三条命令是本系列所有数字的来源。卡片里的数字必须能由它们复现。

```bash
# (1) 裸 @duya/* 的解析失败率
node -e "
import('/Users/chenxuanyu/Documents/GitHub/duya/.claude/worktrees/plan-622/scripts/architecture/import-graph.mjs')
" # 见 01 卡内的完整脚本

# (2) 切片图里的跨包边（实测 0）
node -e "
import('./scripts/architecture/import-graph.mjs').then(async (m) => {
  const g = m.buildGraphs();
  const cross = g.valueEdges.filter((e) => e.fromOwner.startsWith('pkg:')
    && e.toOwner.startsWith('pkg:') && e.fromOwner !== e.toOwner);
  console.log('cross-package value edges:', cross.length, 'of', g.valueEdges.length);
});
"

# (3) G1 层门禁的覆盖（实测 523/2593 = 20.2%）
node scripts/architecture/audit-imports.mjs --json > /tmp/audit.json
node -e "
const { LAYERS, layerOfSpecifier, sourceLayerOf } = await import('./scripts/architecture/boundary-gates.mjs');
const d = JSON.parse(require('fs').readFileSync('/tmp/audit.json','utf8'));
const pkgOf = (o) => o.startsWith('pkg:') ? '@duya/' + o.slice(4) : null;
let examined = 0;
for (const e of d.crossBoundaryEdges) {
  const f = pkgOf(e.fromOwner), t = pkgOf(e.toOwner);
  const fl = f ? sourceLayerOf(f, e.from) : undefined;
  const tl = t ? layerOfSpecifier(e.spec) : undefined;
  if (fl && tl) examined++;
}
console.log('G1 examines', examined, 'of', d.crossBoundaryEdges.length);
"
```

### 4.3 门禁契约

- 卡片**不得**用 `--write` 把新违规写进 baseline（根 `AGENTS.md`）。
- 卡片若改变 `architecture:check` 的判定结果，必须**先测、后改**，
  且在卡片里写明改前 / 改后的检测数、tolerated 数与 baseline 数。
- `plan:sync` 的追踪表行必须指向**存在的测试文件 + 能匹配上的用例名**，
  否则 `plan-sync-check --strict` 退出 1。

---

## 5. 依赖顺序与路径所有权

### 5.1 依赖图

```
            ┌─────────────────────────────────────────┐
            │ 01 import-graph 裸 @duya/* 解析（T19）    │
            └──────────────────┬──────────────────────┘
                               ▼
            ┌─────────────────────────────────────────┐
            │ 02 两套解析器收敛 + 门禁接进 CI           │
            └──────────────────┬──────────────────────┘
                               ▼
            ┌─────────────────────────────────────────┐
            │ 03 @duya/host 层归属裁决                │
            └──────────────────┬──────────────────────┘
                               ▼
            ┌─────────────────────────────────────────┐
            │ 04 其余无层包的层归属                   │
            └──────────┬───────────────┬──────────────┘
                       ▼               ▼
        ┌──────────────────────┐  ┌──────────────────────┐
        │ 05 客户端轴反向门禁  │  │ 06 runtime 纯净度    │
        └──────────────────────┘  └──────────────────────┘

  独立线：07 DAG 并行 · 08 生命周期落盘 · 09 安全治理 · 10 退役与文档
  08 ──▶ 11 常驻对账监督者
```

**排序理由**：

- **01 → 02 → 03 → 04 是硬依赖**。层表要改，就必须先能看见跨包边；
  否则改完层表也不知道它看见了什么。
- **05 在 04 之后**：`client-core` 是无层包之一，它的层归属不定，
  「客户端轴反向依赖」就没有被测对象。
- **06 在 04 之后**：判据要引用 `capabilities` 的层归属。
- **07 / 08 / 09 / 10 与 01–05 无依赖**，可并行开工。
- **11 依赖 08**：要周期对账后台子 Agent，得先有落盘的真相来源。

### 5.2 路径所有权

本系列**只写文档**，不碰生产代码。下表是各卡在**执行时**的独占路径，
用于并行派工时不互相覆盖。

| 卡 | 独占路径（执行时） |
| --- | --- |
| 01 | `scripts/architecture/import-graph.mjs`、`scripts/architecture/import-graph.test.ts`、`scripts/architecture/slice-cut-list.ts`、`scripts/architecture/slice-cut-list.test.ts`、`scripts/architecture/slice-classification.ts`、`scripts/architecture/slice-classification.test.ts`、`packages/agent-protocol/test/02-cycle-budget.test.ts` |
| 02 | `scripts/architecture/architecture-check.mjs`、`.github/workflows/test.yml`、`package.json`（script 行）、`scripts/architecture/audit-imports.mjs`、`scripts/architecture/boundary-gates.mjs` |
| 03 | `scripts/architecture/boundary-gates.mjs`（`LAYERS` / `sourceLayerOf`）、`scripts/architecture/boundary-gates.test.ts`、`docs/architecture/ARCHITECTURE_MAP.md` |
| 04 | `scripts/architecture/boundary-gates.mjs`、`scripts/architecture/boundary-gates.test.ts` |
| 05 | `scripts/architecture/client-closure-gate.mjs`、`scripts/architecture/client-closure-gate.test.ts`、`scripts/architecture/boundary-gates.mjs` |
| 06 | `packages/agent-runtime/src/surface/**`、`packages/agent-runtime/src/authorization/**`、`packages/agent-runtime/src/tools/**`、`packages/agent-protocol/src/**`（权限契约归属）、`packages/agent-runtime/test/**` |
| 07 | `packages/host/src/worker-workflows/engine.ts`、`packages/host/src/worker-workflows/node-runner.ts`、`packages/host/src/worker-workflows/execution-binding.ts`、`packages/host/tests/worker-workflows/**` |
| 08 | `packages/host/src/worker-subagents/background-lifecycle.ts`、`packages/host/src/worker-subagents/service.ts`、`packages/host/src/managed-shell/task-store.ts`、`packages/host/tests/worker-subagents/**` |
| 09 | `packages/host/src/manifest-factory.ts`、`packages/capabilities/src/shell/**`、`packages/capabilities/src/ShellCommandTool/**`、`packages/host/src/managed-shell/BashWorker.ts`、`packages/sandbox/src/sandbox-adapter.ts`、`packages/agent-protocol/src/manifest.ts` |
| 10 | `packages/agent/**`（退役）、`scripts/architecture/agent-retirement-gate.mjs`、`docs/architecture/ARCHITECTURE_MAP.md`、`docs/architecture/ARCHITECTURE.md`、`docs/development/test-inventory.{json,md}` |
| 11 | `packages/host/src/**`、`apps/desktop/src/main/index.ts`、`packages/cli/src/**` |

**公共文件（单写者）**：`scripts/architecture/boundary-gates.mjs`（02 / 03 / 04 / 05 共用）、
`scripts/architecture/architecture-check.mjs`、`architecture-policy.yaml`、
`packages/host/src/worker-workflows/engine.ts`。
非 owner 车道要改公共文件 → 在 PR 描述里写"接缝请求"（改哪个函数、为什么不能放自己车道）。

### 5.3 与既有计划的关系

| 既有计划 | 关系 |
| --- | --- |
| [610 T19](../610-architecture-series/19-fast-track-queue.md) | **引用**。T19 是根因记录；[01](01-import-graph-resolver.md) 是它的执行版，不复述根因 |
| [610 T18](../610-architecture-series/19-fast-track-queue.md) | **已被覆盖，不重写**。T18 记录的失败形态（`8 failed \| 22 passed`）**已过期**——`c62fdf60`（2026-10-23，删死规则）与 `1ce23ce3`（对齐 census）已把它修绿，实测 `slice-classification.test.ts` **30/30 passed**、`slice-cut-list.test.ts` **16/16 passed**。610 的追踪表尚未更新这条，**由 610 owner 处理**（不在本系列独占路径内） |
| [610 A8.2 / A8.3](../610-architecture-series/15-slice-a8-client-core.md) | **排序在…之前 / 被…覆盖**。A8.2（client-core 层定义）被 [04](04-remaining-unlayered-packages.md) 吸收；A8.3（客户端轴反向门禁）是 [05](05-client-axis-reverse-gate.md) 的**主体** |
| [610 §12 / §13 退役](../610-architecture-series/12-agent-retirement-coordination.md) | **引用**。退役的消费者清单与顺序由既有计划拥有；[10](10-retirement-and-doc-truth.md) 只做**收尾 + CI 守卫 + 文档事实源**，不重写退役序列 |
| [多 Agent 编排 Phase 1–4](../2026-10-23-multi-agent-orchestrator.md) | **引用 + 排序在…之前**。Phase 1（A1 补测 / A4 `FakeWorkflowHost`）**阻塞** [07](07-workflow-dag-parallel.md) 与 [08](08-background-subagent-lifecycle.md)；Phase 4（F1 落盘 / F3 状态映射）是 [08](08-background-subagent-lifecycle.md) 的**主体**，本系列不复制 |

---

## 6. 追踪表（唯一状态源）

> 规则（与 610 §4 规则 4 一致）：状态只认**具名测试 + commit**，
> 不认 `Waiting` / `In progress` / `已开工` 这类词。
> 一张卡没有可复跑的绿测试，就是没完成，无论代码写到哪里。

| 卡 | 状态 | 首个失败证据（今天长什么样） | 验收命令 | 依赖 |
| --- | --- | --- | --- | --- |
| [01](01-import-graph-resolver.md) | todo | `import-graph.test.ts` 里**没有任何**裸 `@duya/*` 用例；`resolveTarget('@duya/agent-protocol', …)` 返回 `null`（755/755 全 null） | `npx vitest run scripts/architecture/import-graph.test.ts` | T19 |
| [02](02-gate-wiring-and-single-resolver.md) | todo | `.github/workflows/test.yml` 里 `architecture:slice-graph` 命中 **0** 次；`agent-retirement-gate` 命中 **0** 次 | `grep -c "architecture:slice-graph" .github/workflows/test.yml` ≥ 1 且 `npm run architecture:check` 仍绿 | 01 |
| [03](03-host-layer-verdict.md) | todo | `boundary-gates.test.ts` 没有"每个包都有层"的断言；10/20 包无层；G1 只审 523/2593 条 | `npx vitest run scripts/architecture/boundary-gates.test.ts` + `npm run architecture:boundaries` | 01 02 |
| [04](04-remaining-unlayered-packages.md) | todo | 同上，"无层包"清单仍含 10 个 | `npx vitest run scripts/architecture/boundary-gates.test.ts` | 03 |
| [05](05-client-axis-reverse-gate.md) | todo | G11 只覆盖浏览器入口；`packages/client-core` / `packages/ui` / `packages/cli` 的反向边无人守 | `npx vitest run scripts/architecture/client-closure-gate.test.ts` | 03 04 |
| [06](06-runtime-purity.md) | todo | `authorization/permissions/types.ts:1` / `policy.ts:1` 的 `export * from '@duya/capabilities/permissions'` 让 runtime 运行时依赖 capabilities | `npx vitest run packages/agent-runtime/test/**` | 04 |
| [07](07-workflow-dag-parallel.md) | todo | 「同层两个无依赖节点的 host 调用**交错**执行」今天失败（`engine.ts:198` 的 `for…await` 串行） | `npx vitest run packages/host/tests/worker-workflows/**` | 多 Agent Phase 1 |
| [08](08-background-subagent-lifecycle.md) | todo | `packages/host/tests/worker-subagents/background-lifecycle.test.ts` **不存在**（零专属测试） | `npx vitest run packages/host/tests/worker-subagents/background-lifecycle.test.ts` | 多 Agent Phase 1 |
| [09](09-security-and-governance.md) | todo | `wrapCommand` / `executeIsolated` 零生产消费者；manifest `hasRules:false` | `npx vitest run packages/sandbox/tests/ packages/host/tests/**manifest**` | — |
| [10](10-retirement-and-doc-truth.md) | todo | 退役门禁 `OPEN`（770 处引用）；`ARCHITECTURE_MAP.md:16` 写「23 packages」；`test-inventory.json` 162 处指向已删文件 | `node scripts/architecture/agent-retirement-gate.mjs` + `npm run test:inventory` | — |
| [11](11-resident-reconciler.md) | todo | `packages/host` / `packages/cli` 无任何对账启动路径；`reconcileRollouts` 无开机调用 | `npx vitest run packages/host/tests/**reconcil**` | 08 |

---

## 7. 接续点

- 分支：`codex/plan-622`；worktree：`.claude/worktrees/plan-622`；
  base：`d9eb7dba96f63b3e07b4fba9c068acd017616913`。
- 本系列**只产出文档**。所有卡片的执行由后续 agent 在各自独立检出完成，
  一卡一 PR，按 §5.1 的依赖顺序。
- **下一步（一条能开始执行的动作）**：
  认领 [01](01-import-graph-resolver.md)，先在 T19 的根因上补一条
  `import-graph.test.ts` 用例，证明裸 `@duya/*` 今天解析为 `null`，
  然后再动 `resolveTarget`。**完成判据**：该用例在 base 上红、在修好的树上绿，
  且 `slice-cut-list.test.ts` 与 `slice-classification.test.ts` 仍全绿。
- **未做**：没有合并任何 PR（未经用户授权）；没有改任何生产代码、脚本或配置；
  没有运行 `npm test` 全量（本次是纯文档任务，见 [§8](#8-本次交付的验证记录)）。

---

## 8. 本次交付的验证记录

本系列**只产出文档**，不修改任何生产代码、脚本或配置。
下列命令是**本次交付**实跑的，退出码与关键行逐字记录。

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6（Darwin 21.6.0 x64）· Node v20.20.2 · npm 10.8.2 · vitest 3.2.4 | `npm run plan:sync` | **0** | `plan-sync-check  16 done rows · 28 file refs · 14 test-name refs` → `plan-sync-check  OK` |
| `d9eb7dba` / 干净 | 同上 | `npm run architecture:check` | **0** | 检测 **2608** / tolerated **2608** / blocking **0** / baseline **2785** / `255 baseline fingerprint(s) no longer triggered.` → `OK — no new boundary violations.` |
| `d9eb7dba` / 干净 | 同上 | `npm run architecture:boundaries` | **0** | G1/G3/G4/G7/G8 known **0** new **0** stale **0**；G6 known **9**；G9 known **5** → `no new findings.` |
| `d9eb7dba` / 干净 | 同上 | `npx vitest run scripts/architecture/slice-classification.test.ts` | **0** | 1 file / **30 passed** |
| `d9eb7dba` / 干净 | 同上 | `npx vitest run scripts/architecture/slice-cut-list.test.ts` | **0** | 1 file / **16 passed** |
| `d9eb7dba` / 干净 | 同上 | `npm run architecture:slice-graph` | **0** | files **4047** / typeEdges **7127** / valueEdges **5962** / sccType **18** / sccValue **6**；自写探针测得**跨包 value 边 0**（同包 **4132**） |
| `d9eb7dba` / 干净 | 同上 | `node scripts/architecture/audit-imports.mjs` | **0** | files scanned **4041** / file edges **16934** / internal **10728** / **cross-boundary edges 2593** / deep imports 0 / package escapes **14** / unresolved **6** |
| `d9eb7dba` / 干净 | 同上 | `node scripts/architecture/agent-retirement-gate.mjs` | **0** | `agent-retirement: OPEN`；scope **3772**；references **770**（production-source **19** / build-tooling **84** / active-config **13** / test-target **654**） |
| `d9eb7dba` / 干净 | 同上 | 一次性链接检查（`/tmp/check-links.mjs`，扫 14 个 md） | **0** | `files scanned : 14` · `links checked : 240` · `broken : 0` |
| `d9eb7dba` / 干净 | 同上 | 一次性锚点检查（`/tmp/check-anchors.mjs`） | **0** | `anchors checked: 10` · `broken anchors : 0`（跨文件锚点改为文件级链接，避免 slug 脆弱） |

**本次交付没有跑的**（如实记录）：

- `npm test` 全量——本次是**纯文档**变更，没有生产代码改动，
  跑全量不会增加对文档的信心，只会消耗预算。
  ⇒ **卡片执行时必须跑各自的相关测试**，本系列的卡片已写明验收命令。
- `npm run typecheck:all`——同上，无代码变更。
- `npm run electron:build`——同上，无构建产物变更。
- **未验证的外部事实**：`packages/agent` 退役后的真实 worker 构建与加载
  （由既有 [12](../610-architecture-series/12-agent-retirement-coordination.md) 的
  运行时验收负责，本系列只排期）。

