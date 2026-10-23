# 05 — 客户端轴反向依赖门禁 G11

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-05-client-axis-gate`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 前置：[03](03-host-layer-verdict.md)、[04](04-remaining-unlayered-packages.md) ·
覆盖 610 的 **A8.3**（见 [15-slice-a8-client-core.md:20](../610-architecture-series/15-slice-a8-client-core.md)）

---

## 目标与边界

**目标**：把「客户端轴没有反向依赖门禁」这个洞补上——G11 要覆盖
**全部客户端轴入口**，不只是浏览器入口。

**边界**：

- 只动 `scripts/architecture/client-closure-gate.mjs` 与它的测试，
  以及 `scripts/architecture/boundary-gates.mjs` 里与客户端轴相关的部分。
- **不改**客户端状态模型（`packages/client-core/src/session/run-session.ts` 已经是
  共用的正确实现，见 [§发现 1](#发现与决策)）。
- **不做**"再统一一次状态模型"——遗留的只是**词汇**
  （TUI 的 `LegacyFrame`、UI 的 `@/types/message`），不是状态机。
- 不改 `packages/cli/src/tui/**` 与 `packages/ui/src/**`（610 T11 的遗留工作，
  属 L-CLIENT 车道）。

---

## 验收

### 首个失败证据（今天长什么样）

**今天的失败形态**：`scripts/architecture/client-closure-gate.test.ts` 存在且今天
**19/19 绿**（610 T16 的记录），但它**只断言三个根**：

```text
packages/client-core/src/index.ts
packages/cli/src/chat.ts
packages/cli/src/tui/index.ts
```

**缺的是**：客户端轴上的**其它入口**没有被登记为根。
实测客户端轴的入口至少还有：

- `packages/ui/src/**`（整个 renderer，`packages/ui/src/App.tsx:97`）
- `packages/cli/src/tui/index.ts` 之外的 TUI 子入口
- `apps/desktop/src/renderer/**`（如果它还直接依赖 runtime）

**必须先写的用例**：

```text
scripts/architecture/client-closure-gate.test.ts
  it('registers every client-axis entry as a root, so none can reach the runtime', ...)
```

**今天跑它，红的形态是**：断言"客户端轴的每个入口都在根清单里"失败，
失败信息点名**未被登记的入口**（具体名单由实现时按
`packages/ui/src/**` 与 `apps/desktop/src/renderer/**` 的实际入口确定）。

**第二个必须先写的用例**（守"反向"这个方向）：

```text
scripts/architecture/client-closure-gate.test.ts
  it('flags a client-axis module that reaches the runtime', ...)
```

**今天跑它，红的形态是**：往 `packages/ui/src/` 塞一条到 runtime 的导入，
门禁**必须红**——如果它不红，说明门禁根本没在看这条边。

### 验收命令与预期结果

```bash
# 1) 门禁自身
npx vitest run scripts/architecture/client-closure-gate.test.ts
#    预期：全部 passed；新用例断言"客户端轴入口清单完整"

# 2) 门禁在 CI 里且真的会红
npm run architecture:client-closure
#    预期：G11-1 PASS（exit 0）—— 今天实测即为 PASS

grep -c "architecture:client-closure" .github/workflows/test.yml
#    预期：≥ 1（今天实测 1，已在 CI 里）

# 3) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run architecture:boundaries # 预期：仍 "no new findings."
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **客户端轴的每一个入口都在门的根清单里**，清单有明确推导规则
   （不是手写一串路径）。
2. **门禁能红**：往任一客户端轴入口接一条到 runtime 的边 → 门禁红；
   撤掉 → 绿。**这条必须双向验过并记录。**
3. **门禁不误报**：今天已绿的链路（`chat.ts` 那条四跳链在 T16 后已断）
   仍然绿。

### 变异证明（门禁卡必填）

- **变异 ①**：接回 `packages/cli/src/chat.ts → host/local-host.ts` 这条链
  → 门禁必须红（610 T16 的原始变异，重跑一次）。
- **变异 ②**：把根清单里的 `packages/ui/src/index.ts` 删掉
  → "入口清单完整"那条用例必须红。
- **变异 ③**：往 `packages/ui/src/` 加一条到 `@duya/agent-runtime` 的导入
  → 门禁必须红，且报错信息**点名这条边**。

---

## 进度

- [ ] 盘点客户端轴入口（`packages/ui/src/**`、`packages/cli/src/tui/**`、
      `apps/desktop/src/renderer/**`），产出**清单 + 推导规则**
- [ ] 写 `it('registers every client-axis entry as a root, so none can reach the runtime')`，确认红
- [ ] 写 `it('flags a client-axis module that reaches the runtime')`，确认红
- [ ] 扩根清单与推导规则
- [ ] 跑 §验收 的 3 组命令
- [ ] 跑 §变异 的 3 组变异
- [ ] 记录与 610 T14 / T16 / T14b 的关系（不重做它们已落地的部分）

---

## 发现与决策

1. **"第二套状态解释"比审计说的更浅——客户端轴的状态机已经是共用的。**
   实测：
   - TUI：`packages/cli/src/tui/run-session-view.ts:39` 取
     `import type { PermissionAction, RunSessionSnapshot } from '@duya/client-core'`。
   - UI：`packages/ui/src/lib/run-session-view.ts:1` 取
     `import type { RunSessionSnapshot } from '@duya/client-core'`。
   - 共享 reducer：`packages/client-core/src/session/run-session.ts:119` 起，
     有 seq 校验与 late/replayed 处理（`:121` 的 `isLate` 分支、
     `acceptWindow` 的 `previousSeq` 校验）。
   ⇒ **状态机是同一个。** 遗留的是**词汇**：
   TUI 仍自持 `LegacyFrame`（`packages/cli/src/tui/blocks.ts`），
   UI 仍自持 `@/types/message`（`packages/ui/src/lib/run-session-view.ts:2`）。
   ⇒ **裁决：本卡只补门禁，不碰词汇统一。**
   词汇统一是 610 T11 步骤 ②③ 的遗留（"渲染源开关本身未接"、
   "删与 SurfaceModel 重复的裁决"），属 L-CLIENT 车道。

2. **G10 只覆盖浏览器入口，这句是准确的。**
   `scripts/architecture/browser-closure-gate.mjs` 在 CI 里
   （`npm run architecture:browser-closure`），管的是浏览器入口。
   G11（`client-closure-gate.mjs`）管的是 CLI + client-core。
   **两者都不是"整个客户端轴"** ⇒ A8.3 的缺口真实存在。

3. **不能用层规则兜底。**
   [15-slice-a8-client-core.md:189](../610-architecture-series/15-slice-a8-client-core.md)
   已经写明：「**注意不能用层规则兜底**：`layers:` 块把 `cli` 归在 `host` 层」。
   原因：`host` 层**高于** runtime，所以 `cli → runtime` 在层规则下是**向下、合法**的，
   而它实际上**不合法**（客户端不该直接依赖执行引擎）。
   ⇒ 决策：G11 必须**独立**于层表，定义自己的"客户端轴不得触达执行引擎"规则。
   这也是本卡不能被 [04](04-remaining-unlayered-packages.md) 吸收的原因。

4. **门禁与层表会重叠，但不能互相替代。**
   [03](03-host-layer-verdict.md) / [04](04-remaining-unlayered-packages.md) 的层表
   会把 `@duya/client-core` 定为 core 层，于是 `client-core → agent-protocol` 是**向下、合法**的，
   `client-core → agent-runtime` 也是**向下、合法**的（runtime 层比 core 高，
   所以 core → runtime 是**向上**，会被 G1 抓到）。
   ⇒ 但**向上被抓 ≠ 客户端轴语义被表达**。
   "客户端不得触达执行引擎"是一条**语义**规则，不是一条**方向**规则。
   两道门禁都要有。

5. **`packages/client-core` 已经是 core 层这一裁决，会让 G11 的目标更清晰。**
   `client-core` 定 core 层后：
   `client-core → agent-protocol`（向下，合法）、
   `client-core → agent-runtime`（向上，G1 抓）。
   而 `packages/ui`（host 层）→ `agent-runtime` 也是向上，G1 抓。
   ⇒ **G11 的增量价值在于"闭合"**：它保证**即使层表被改坏**，
   客户端轴仍然不能触达执行引擎。**这是纵深防御，不是重复。**

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `sed -n '1,5p' packages/cli/src/tui/run-session-view.ts` + `packages/ui/src/lib/run-session-view.ts` | 0 | 两端都从 `@duya/client-core` 取 `RunSessionSnapshot`；UI 额外取 `@/types/message` |
| `d9eb7dba` / 干净 | 同上 | `sed -n '110,135p' packages/client-core/src/session/run-session.ts` | 0 | `isLate` 分支 + `#validate` + `acceptWindow` 的 `previousSeq` 校验 |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "architecture:client-closure\|architecture:browser-closure" .github/workflows/test.yml` | 0 | 两道门禁**都已在 CI** |
| `d9eb7dba` / 干净 | 同上 | `npm run architecture:client-closure` | 0 | `G11-1 PASS` |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：**被 [03](03-host-layer-verdict.md) / [04](04-remaining-unlayered-packages.md) 阻塞**
  ——`client-core` 与 `ui` 的层归属未定，"客户端轴"就没有确定的边界。
- **被本卡覆盖的既有条目**：610 的 **A8.3**。**不改 610 的 15 号文件**，由 610 owner 记账。

**下一步**：认领本卡，先做"盘点入口"这一步——
列出 `packages/ui/src/**`、`packages/cli/src/tui/**`、`apps/desktop/src/renderer/**`
里**实际能触达 runtime 的入口**，并说明每个入口为什么算"客户端轴"。
**完成判据**：清单有推导规则，不是手写路径。

**回退**：只动 `scripts/architecture/client-closure-gate.{mjs,test.ts}` ⇒
单提交 revert 即回原状。**无生产代码、无数据、无 schema 变更。**
