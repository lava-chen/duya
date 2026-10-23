# 03 — `@duya/host` 的层归属裁决

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-03-host-layer`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 前置：[01](01-import-graph-resolver.md)、[02](02-gate-wiring-and-single-resolver.md)

---

## 目标与边界

**目标**：给 `@duya/host` 一个**不留空**的层归属裁决，并把裁决变成可测的门禁行为。

**裁决（详见 [622 README §3.1](./README.md)）**：

> **`@duya/host` 进 `host` 层；同时把整个 legacy `@duya/agent` 包按 host 成分豁免。**
> 结果：G1 审到的跨边界边从 **523 → 1665**（20.2% → 64.2%），
> **新增反向边 0**。

**为什么不是另外两条路**：

- **不选「留在无层」**：它贡献 **1425 条**被跳过的跨包边（占全部跳过边的 **69%**）。
  无层 = 不受检 = 约束为零。
- **不选「先拆包再进层」**：本仓现状是**无层且不受检的包越多，约束越弱**。
  在测量（[01](01-import-graph-resolver.md)）与门禁（[02](02-gate-wiring-and-single-resolver.md)）
  修好之前拆包，等于把一个盲区切成两个盲区。
- **不选「进层并接受 355 条反向边」**：其中 **345 条是 `pkg:agent -> pkg:host`**，
  全部来自**正在退役**的 `packages/agent`，不是活跃架构的违规。
  用一个已经判了死刑的包去否决一个正确裁决，是本末倒置。

**边界**：

- 只改 `scripts/architecture/boundary-gates.mjs`（`LAYERS` / `sourceLayerOf`）
  与 `scripts/architecture/boundary-gates.test.ts`，
  以及 `docs/architecture/ARCHITECTURE_MAP.md` 的层表描述。
- **不改** `packages/host/**` 的任何源码。**不拆包**、不提目录、不动文件布局。
- **不删** `packages/agent`（退役是 [10](10-retirement-and-doc-truth.md) 与既有
  [12](../610-architecture-series/12-agent-retirement-coordination.md) 的事）。
- 不改 `LAYERS` 之外的层（`protocol` / `core` / `runtime` 三层不动）。
- 不动 `architecture-policy.yaml` 的 `layers:` 块（它是装饰品，见
  [02 §发现 2](./02-gate-wiring-and-single-resolver.md#发现与决策)）——但**要**在
  `ARCHITECTURE_MAP.md` 里把"层表在哪"讲准。

---

## 验收

### 首个失败证据（今天长什么样）

**今天的失败形态**：`scripts/architecture/boundary-gates.test.ts` 的
`describe('G1 — no reverse dependency edge between layers')`（`:174` 起）里
**没有一条**断言"每个 workspace 包都有层"。它只测**已分层包之间**的反向边
（`:175` core→runtime、`:190` protocol→core、`:198` 向下允许、`:206` 同层允许）。
所以"10 个包无层"这件事**今天连一个会红的用例都没有**。

第一条必须先写的用例：

```text
scripts/architecture/boundary-gates.test.ts
  it('gives every workspace package a layer or an explicit exemption with a reason', ...)
```

**今天跑它，红的形态是**：断言"20 个包全部有层"失败，
失败信息列出 **10 个无层包**：`client-core` `command-catalog` `data` `host`
`input-completion` `plugin-core` `sandbox` `tooling` `ui` `voice`。

**第二个必须先写的用例**（守裁决本身，不是守实现）：

```text
scripts/architecture/boundary-gates.test.ts
  it('puts @duya/host in the host layer, so its edges are examined', ...)
```

**今天跑它，红的形态是**：`layerOfSpecifier('@duya/host')` 返回 `undefined`，
而不是 `'host'`。

**覆盖度证据（实测）**：
`boundary-gates.mjs:161` 的 `if (!fromLayer) continue;` 与 `:166` 的
`if (!toLayer) continue;` 是**两道早退守卫**——
它们让无层包的边**整条跳过**，而不是"判成违规"。
（审计原话把机制说成"目标层为空时 `findIndex` 返回 -1 直接跳过"——
**机制描述有误**：`findIndex` 在这两处永远拿不到 `-1`，因为 `-1` 的可能性
已被守卫提前排除。**结论正确，机制不对**。）

### 验收命令与预期结果

```bash
# 1) 层表覆盖
npx vitest run scripts/architecture/boundary-gates.test.ts
#    预期：全部 passed；且新用例断言"20 个包全部有层或被显式豁免且带理由"

# 2) 门禁跑起来不红
npm run architecture:boundaries
#    预期：G1 BASELINED — known 0  new 0  stale 0
#    预期：整段仍 "no new findings."

# 3) 覆盖度真的涨了（不是"看起来对"）
#    跑 [622 README §4.2](./README.md) 的 (3)
#    预期：G1 examines 1665 of 2593（今天 523 of 2593）

# 4) 新增反向边 = 0
#    同上脚本的 revFound
#    预期：0（今天也是 0，但 examined 从 523 涨到 1665）

# 5) 下游不许坏
npm run architecture:check     # 预期：仍 OK — no new boundary violations.
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **20 个包全部有层，或被显式豁免且豁免带理由**（豁免必须写在代码里并带
   `why`，不是靠"这个包恰好没被测到"）。
2. **G1 审到的跨边界边 = 1665**（`@duya/host` 进 `host` 层后的实测值）。
   这是**可测的数字**，不是"感觉变严了"。
3. **新增反向边 = 0**。
4. 剩余被跳过的 **928** 条边，其跳过原因**逐条可归因到具体的包**
   （这是 [04](04-remaining-unlayered-packages.md) 的输入）。

### 变异证明（门禁卡必填）

- **变异 ①**：把 `@duya/host` 从 `LAYERS` 里删掉 → 新增用例**必须红**，
  且 "G1 examines" 的数字必须退回 **523**（证明这条断言今天靠"在层表里"通过，
  不是靠"恰好没违规"通过）。
- **变异 ②**：把 legacy `@duya/agent` 的豁免**缩小回原来的两条路径**
  （`packages/agent/src/cli/**` + `agent-process-entry.ts`）
  → G1 必须报出 **345** 条 `pkg:agent -> pkg:host` 反向边
  （证明豁免是**必需**的，不是顺手加的）。
- **变异 ③**：往 `packages/host/src/` 加一行 `import { x } from '@duya/agent-protocol'`
  （向下，允许）→ **必须仍绿**（防止把层方向搞反）。
- **变异 ④**：往 `packages/agent-protocol/src/` 加一行
  `import { x } from '@duya/host'`（向上）→ G1 必须红
  （证明新层真的在守方向）。

### 落地形状（具体到文件与行）

```js
// scripts/architecture/boundary-gates.mjs:67-75
export const LAYERS = [
  { name: 'protocol', packages: ['@duya/agent-protocol'] },
  { name: 'core', packages: ['@duya/agent-core', '@duya/ai'] },
  { name: 'runtime', packages: ['@duya/agent-runtime', '@duya/agent', '@duya/capabilities', '@duya/connectors', '@duya/memory'] },
  // ↓ 新增：@duya/host 是产品 worker，属于 host 层
  { name: 'host', packages: ['@duya/host', '@duya/desktop', '@duya/cli', '@duya/gateway'] },
];
```

```js
// scripts/architecture/boundary-gates.mjs:112-122
// ↓ 现有豁免只覆盖两条路径；本卡把 legacy @duya/agent 整包按 host 成分豁免
export function sourceLayerOf(pkg, file) {
  if (pkg === '@duya/agent') {
    // The legacy monolith is retiring (610 §12/§13). Its 337 edges into
    // @duya/host are retirement debt, not an architecture violation of the
    // live system, so the whole package is treated as host composition code
    // until it is deleted. The exemption is scoped to THIS package and
    // disappears with it.
    return 'host';
  }
  return layerOf(pkg);
}
```

**注意**：`@duya/desktop` 在 `LAYERS` 里是**幽灵条目**——
master 上**没有** `packages/desktop`（实测：`packages/` 下只有 20 个带
`package.json` 的目录，`desktop` 不在其中）。它对应的是 `apps/desktop`。
⇒ 本卡**保留** `@duya/desktop`（`apps/desktop` 的 npm 包名将来可能真是它，
删掉是另一个决定），但要在 `LAYERS` 旁加注释标明它是 app 层的占位，
并在 [04](04-remaining-unlayered-packages.md) 里处理 app 与 package 的分层关系。

---

## 进度

- [ ] 写 `it('gives every workspace package a layer or an explicit exemption with a reason')`，确认红（列出 10 个无层包）
- [ ] 写 `it('puts @duya/host in the host layer, so its edges are examined')`，确认红（`undefined`）
- [ ] `LAYERS` 加 `@duya/host`；`sourceLayerOf` 把 `@duya/agent` 整包按 host 豁免
- [ ] 跑 §验收 的 5 组命令，确认 examined = 1665、reverse = 0
- [ ] 跑 §变异 的 4 组变异
- [ ] 更新 `docs/architecture/ARCHITECTURE_MAP.md`：层表（`:52-58`）加 `@duya/host`；
      `:60-63` 的「12 packages in no layer」改成实测的 **10 个**
      （并删掉其中已不存在的 `computer-use` 与不是包的 `web`）
- [ ] 把剩余 928 条跳过边按包归因，写进 [04](04-remaining-unlayered-packages.md) 的输入

---

## 发现与决策

1. **"无层的包"不是一个状态，是一个盲区。** 实测：2593 条跨边界边里，
   **1627 条因为源包无层被跳过**，**443 条因为目标说明符无层被跳过**。
   ⇒ 门禁的强度直接等于"层表覆盖率"。今天 20.2%。

2. **`@duya/host` 是最大的单点盲区。** 892 条（源）+ 533 条（目标）= **1425 条**，
   占全部跳过边的 **69%**。它是 461 文件 / 95,948 LOC 的包，
   含 worker runtime、control plane、HTTP API、client adapter。
   ⇒ **先给它层**，收益超过其余 9 个包加起来。

3. **"host" 层现在指的是三个包，`@duya/host` 不在里面。**
   `LAYERS:74` 的 `host` = `['@duya/desktop', '@duya/cli', '@duya/gateway']`。
   而 `@duya/desktop` **在 master 上不存在**（`packages/` 下 20 个包里没有 `desktop`）。
   ⇒ 这层表今天实际只管住 **2 个真实包**（`cli` 与 `gateway`）。
   这解释了为什么 G1 的 known 是 **0** —— 它几乎没在管任何东西。

4. **`@duya/host` 的规模不是它进层的理由，也不是它不进层的理由。**
   实测规模：461 文件 / 95,948 LOC / 108 个根级模块 / 26 个子目录；
   最大单文件 `http-server.ts` **5529** 行、`worker-process-entry.ts` **3662**、
   `run-orchestrator.ts` **2685**、`worker-session-runtime.ts` **2465**。
   ⇒ **规模问题另立卡片**（拆包），**层次问题本卡解决**。
   本卡**不**把"大"当成"不能进层"的理由——恰恰相反，正因为它大且无层，
   它才是约束最松的地方。

5. **legacy 豁免的形状已有先例，不必新造。**
   `sourceLayerOf`（`:112-122`）今天已经为 `@duya/agent` 开了两条路径的洞
   （`packages/agent/src/cli/` 与 `packages/agent/src/process/agent-process-entry.ts`），
   注释写明理由是"这些是应用组合代码，正在从本包退役"。
   ⇒ 本卡只是**把同一理由 applied 到整个待退役包**，因为 `packages/agent`
   在退役中（门禁 `OPEN`，770 处引用）。豁免**随包删除而消失**，不是永久开口。

6. **豁免必须带"为什么"和"什么时候消失"。**
   `scripts/architecture/slice-classification.ts` 的 `UNCLASSIFIED_PREFIXES`
   （`:667`）已经是这个形状（每条带 `why`），并且
   `slice-classification.test.ts` 有一条
   `"states a reason for every unclassified prefix, so a gap is a decision"`——
   **没有 `why` 的豁免会让那条用例转红**。
   ⇒ 本卡的层豁免要沿用同一形状（带 `why` + `until`）。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `node` 探针：读 `LAYERS` + 各包 `package.json` 的 `name` | 0 | 层表覆盖 10 个包；**10 个包无层**；`@duya/desktop` 是幽灵条目（无 `packages/desktop`） |
| `d9eb7dba` / 干净 | 同上 | `node scripts/architecture/audit-imports.mjs --json` + `boundary-gates.mjs` 的 `sourceLayerOf` / `layerOfSpecifier` | 0 | 跨边界边 **2593**；G1 审 **523（20.2%）**；跳过 **2070（79.8%）**（源无层 1627 / 目标无层 443）；门禁会报的反向边 **0** |
| `d9eb7dba` / 干净 | 同上 | 同上，假设 `@duya/host` 进 `host` 层 | 0 | 审 **1665（64.2%）**；反向边 **355**（`pkg:agent -> pkg:host` **345** + `pkg:agent -> pkg:cli` 10） |
| `d9eb7dba` / 干净 | 同上 | 同上，**再**把 `@duya/agent` 整包按 host 豁免 | 0 | 审 **1665（64.2%）**；反向边 **0** |
| `d9eb7dba` / 干净 | 同上 | 统计 `pkg:agent -> pkg:host` 边在既有豁免洞内的分布 | 0 | 共 **345** 条；洞内 **8** 条；**洞外 337** 条 |
| `d9eb7dba` / 干净 | 同上 | `find packages/host/src -type f \( -name '*.ts' -o -name '*.tsx' \) \| wc -l` 等 | 0 | **461** 文件 / **95,948** LOC / 根级模块 **108** / 子目录 **26** |
| `d9eb7dba` / 干净 | 同上 | `find packages/host/src -name '*.ts' -exec wc -l {} + \| sort -rn \| head -5` | 0 | `http-server.ts` **5529** / `worker-process-entry.ts` **3662** / `run-orchestrator.ts` **2685** / `worker-session-runtime.ts` **2465** / `http-client.ts` **2229** |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：无。**前置**：[01](01-import-graph-resolver.md) 与
  [02](02-gate-wiring-and-single-resolver.md) 未落地时，本卡的"覆盖从 523 涨到 1665"
  无法验收（因为切片图本身测不出跨包边）。

**下一步**：认领本卡，先做"写两条红用例"这一步——
`it('gives every workspace package a layer or an explicit exemption with a reason')`
与 `it('puts @duya/host in the host layer, so its edges are examined')`。
**完成判据**：两条都红，且失败信息分别是"10 个无层包"与"`undefined`"。

**回退**：只动 `scripts/architecture/boundary-gates.{mjs,test.ts}` 与
`docs/architecture/ARCHITECTURE_MAP.md` ⇒ 单提交 revert 即回原状。
**无生产代码、无数据、无 schema 变更。**
