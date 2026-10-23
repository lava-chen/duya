# 04 — 其余无层包的层归属

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-04-unlayered-packages`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 前置：[03](03-host-layer-verdict.md) ·
覆盖 610 的 **A8.2**（`client-core` 层定义缺失，见
[15-slice-a8-client-core.md:19](../610-architecture-series/15-slice-a8-client-core.md)）

---

## 目标与边界

**目标**：把剩下 9 个无层包逐个定层或定豁免，让 G1 的覆盖率从 64.2% 往 100% 走。

**边界**：

- **不重新讨论 `@duya/host`**（那是 [03](03-host-layer-verdict.md) 的裁决，已定）。
- **不改 `packages/**` 的任何源码**。本卡是层表与门禁的活。
- **不改** `LAYERS` 的层集合本身（protocol / core / runtime / host 四层不变）——
  本卡只往里放包，或写明豁免。
- 不动 `apps/desktop` / `apps/web` 的构建配置。

---

## 验收

### 首个失败证据（今天长什么样）

**今天的失败形态**：与 [03](03-host-layer-verdict.md) 的第一条用例**同源但更深一层**——
[03](03-host-layer-verdict.md) 之后（`@duya/host` 已进层），无层包从 10 个降到 **9 个**：

`client-core` `command-catalog` `data` `input-completion` `plugin-core`
`sandbox` `tooling` `ui` `voice`

**必须先写的用例**：

```text
scripts/architecture/boundary-gates.test.ts
  it('gives every workspace package a layer or an explicit exemption with a reason', ...)
```

在 [03](03-host-layer-verdict.md) 落地后，这条用例的红形态从"10 个"变成"**9 个**"，
且失败信息要能逐个点名。**这条用例在 [03](03-host-layer-verdict.md) 与本卡之间是接力，不是重复。**

**覆盖度证据**（实测，`d9eb7dba`）：

| 状态 | G1 审到 | 占比 | 仍被跳过 |
| --- | --- | --- | --- |
| 今天（`@duya/host` 无层） | 523 | 20.2% | 2070 |
| [03](03-host-layer-verdict.md) 落地后 | 1665 | 64.2% | 928 |

**剩余 928 条的归属（实测）**：
跳过源因分成两类——**源包无层**（1627−892 = **735** 条）与**目标说明符无层**（443 条）。

### 逐包裁决输入（实测数据）

| 包 | 源侧无层边数 | 目标侧无层边数 | 层方向建议 | 理由 |
| --- | --- | --- | --- | --- |
| `@duya/data` | 39 | 78 | **不设独立层**，作为**叶子存储层** | 它是 SQLite 所有权与迁移（`packages/data/src/main-schema.ts:23`）。当前 `runtime` 层已含 `@duya/memory`，`memory` 也落库。**先定方向**：data 不得被 runtime 反向依赖 |
| `@duya/client-core` | 13 | 22 | **core 层** | 传输中立的 surface 模型 + reducer，零 IO（`packages/client-core/src/surface/surface-model.ts`）。它已被 A8.1 平移进 `client-core`（PR #270 / `943225cf`），定位就是纯客户端状态层 |
| `@duya/plugin-core` | 0 | 57 | **core 层** | 插件格式、MCP 纯解析、信任分级、App schema（`packages/plugin-core/src/security/trust-engine.ts:25`），**零 IO** |
| `@duya/ui` | 69 | 22 | **host 层**（app 层） | 整个 renderer。它被 `src-renderer` / `electron-main` 依赖，属于应用面 |
| `@duya/connectors` | 0 | 38 | **已在 runtime 层** | `LAYERS:72` 已含 `@duya/connectors`；这里只需确认（实测它出现在"目标无层"里是因为说明符带子路径，需核 `layerOfSpecifier` 的子路径匹配） |
| `@duya/memory` | 0 | 34 | **已在 runtime 层** | 同上，`LAYERS:72` 已含 |
| `@duya/input-completion` | 0 | 9 | **core 层** | 纯补全规则（`packages/input-completion/src/trigger.ts`），候选由各端提供 |
| `@duya/command-catalog` | 0 | 7 | **core 层** | 只有 slash 命令元数据，无行为（`packages/command-catalog/src/index.ts`） |
| `@duya/sandbox` | 0 | 10 | **runtime 层**（或 core？见下） | 命令沙箱。`isPathWithinRoots` 是纯路径判定，但 `executeIsolated` 会拉 Docker —— **IO** |
| `@duya/voice` | 0 | 4 | **runtime 层** | 麦克风 → 流式 STT → 文本，**有 IO** |
| `@duya/tooling` | 0 | 1 | **core 层**（契约） | 扩展契约 + 13-slot registry，零 IO |

**这张表里有三处**待核对**，本卡必须先核再定**：

1. **`@duya/connectors` / `@duya/memory` 已在 runtime 层**，但实测它们出现在
   "目标无层"清单里 ⇒ 可能是 `layerOfSpecifier`（`:124-136`）的**子路径匹配**问题。
   **核对动作**：读 `layerOfSpecifier` 对 `@duya/memory/xyz` 的返回值。
2. **`@duya/sandbox` 的层归属取决于拆不拆**：`isPathWithinRoots` 纯，
   `executeIsolated` 有 IO。它当前一个包同时装了两者。
   **核对动作**：读 `packages/sandbox/src/index.ts` 的导出面，
   确定 `isPathWithinRoots` 与 `executeIsolated` 是否可分。
   若不可分 ⇒ 归 **runtime**（有 IO 的那个面定层），并把纯路径判定记为
   "runtime 内的纯函数"，**不**为了好看而假装它是 core。
3. **`@duya/tooling` 只有 1 条边**，且是**目标侧**（别的包依赖它）。
   它同时是 610 §18 记录的「a contract, no production caller found」。
   ⇒ 归 core 层，但它**没有生产消费者**这件事**另记**（见
  [06](06-runtime-purity.md) 与 [10](10-retirement-and-doc-truth.md) 的事实源部分）。

### 验收命令与预期结果

```bash
# 1) 层表覆盖
npx vitest run scripts/architecture/boundary-gates.test.ts
#    预期：全部 passed；无层包 = 0（或全部带 why 的显式豁免）

# 2) 门禁不红
npm run architecture:boundaries
#    预期：G1 BASELINED — known 0  new 0  stale 0；整段 "no new findings."

# 3) 覆盖度
#    跑 [622 README §4.2](./README.md) 的 (3)
#    预期：G1 examines 2593 of 2593（今天 523）；revFound = 0

# 4) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **20 个包全部有层，或带 `why` 的显式豁免**（豁免形状照
   `UNCLASSIFIED_PREFIXES`（`slice-classification.ts:667`）：每条带 `why`）。
2. **G1 examines = 2593 of 2593**，即**没有一条跨包边因为"某端无层"而被跳过**。
3. **新增反向边 = 0**。若某条边在定层后变成反向边，**那是真违规**，
   要么修代码，要么在豁免里写明理由——**不许靠把包移出层表来消掉**。
4. `ARCHITECTURE_MAP.md` 的层表与「无层包」清单与代码**逐字一致**。

### 变异证明（门禁卡必填）

- **变异 ①**：把 `@duya/ui` 从层表里拿掉 → "每个包都有层"那条用例**必须红**。
- **变异 ②**：往 `packages/ui/src/` 加一行
  `import { x } from '@duya/agent-protocol'`（ui=host 层，protocol=protocol 层，
  **向上**）→ G1 必须红（证明新层在守方向，不只是"有层"）。
- **变异 ③**：往 `packages/agent-protocol/src/` 加一行
  `import { x } from '@duya/client-core'`（protocol → core，**向上**）→ G1 必须红
  （证明 `client-core` 真的被当成 core 层，而不是一个摆设）。
- **变异 ④**：给某个包加一条**不带 `why`** 的豁免 → 必须红
  （照 `slice-classification.test.ts` 那条
  `"states a reason for every unclassified prefix, so a gap is a decision"` 的形状）。

---

## 进度

- [ ] 核对 §逐包裁决输入 里的三处「待核对」（connectors/memory 的子路径匹配、sandbox 的 IO 面、tooling 的消费者）
- [ ] 写 `it('gives every workspace package a layer or an explicit exemption with a reason')` 的续作，确认红（9 个）
- [ ] 逐包定层；每条豁免带 `why` 与 `until`
- [ ] 跑 §验收 的 4 组命令，确认 examines = 2593、revFound = 0
- [ ] 跑 §变异 的 4 组变异
- [ ] 更新 `docs/architecture/ARCHITECTURE_MAP.md:52-63` 的层表与「无层包」段
- [ ] 把 A8.2（`client-core` 层定义）标记为被本卡覆盖（**不改 610 的文件**，
      在本卡记录即可，见 §接续）

---

## 发现与决策

1. **A8.2 被本卡吸收，不要重写。**
   [15-slice-a8-client-core.md:19](../610-architecture-series/15-slice-a8-client-core.md)
   记 A8.2 为「`client-core` 层在 A0 的 L0–L3 里不存在，边界未定义」。
   本卡给 `client-core` 定 **core 层**，A8.2 的内容就此落定。
   ⇒ 决策：**本卡不改 15 号文件**（那是 610 的文件，owner 是 610）；
   在本卡 §接续 里写明"A8.2 已被本卡覆盖，落点 = core 层"。

2. **app 层与 package 层的关系还没定。**
   `LAYERS:74` 的 `host` 层里有 `@duya/desktop`，但 master 上**没有** `packages/desktop`
   （对应的是 `apps/desktop`）。实测：`packages/` 下 20 个带 `package.json` 的目录里没有 `desktop`。
   ⇒ 决策：本卡**保留** `@duya/desktop` 条目（它是 app 的占位），
   但在层表旁**明确注释**它指向 app 而非 package；
   app 的分层（`apps/desktop` / `apps/web`）**另立**为后续卡，不在本卡范围。

3. **`@duya/ui` 定 host 层会让 `src-renderer → pkg:ui` 变成什么？**
   `HOST_BOUNDARIES`（`import-graph.mjs:263-268`）把 `src-renderer` /
   `electron-main` / `electron-preload` / `desktop-contracts` 当作 **host 边界**，
   这与 `LAYERS` 的 `host` 层是**两套东西**。
   ⇒ 决策：给 `pkg:ui` 定 host 层之前，必须先确认 `layerOfSpecifier` 对
   `@duya/ui/...` 子路径的处理——**否则 `@duya/ui` 会被判成比 `electron-main` 更高**。
   这是本卡最容易出错的一步。

4. **不要为了"覆盖率好看"把包塞进错误的层。**
   实测：给 9 个包随便定层，examines 会立刻到 2593，
   但 revFound 会从 0 涨起来——那些是**真违规**。
   ⇒ 决策：**覆盖率是必要条件，不是充分条件**。
   每个包定层时必须回答"这个包的依赖方向是什么"，
   而不是"哪个层能让我不被判违规"。涨起来的 revFound 是**发现**，不是障碍。

5. **`@duya/tooling` 的"无生产消费者"是既有事实，不是本卡的新发现。**
   `ARCHITECTURE_MAP.md:31` 已写「a contract, no production caller found」。
   实测补充：`packages/capabilities/src/fs-contributors.ts:15` 有
   `import type { ToolContributor } from '@duya/tooling'` —— **类型级**消费者存在，
   **运行时**消费者不存在（`packages/capabilities/src/index.ts:13` 的注释自述
   「`@duya/tooling` is used for the `ToolContributor` DECLARATION only」）。
   ⇒ 决策：`tooling` 归 core 层；"无运行时消费者"记进事实源清单
   （[10](10-retirement-and-doc-truth.md)），**不在本卡处理**。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `node` 探针：`LAYERS` ∪ 各包 `package.json` 的 `name` | 0 | 无层包 **10 个**（含 `@duya/host`）；幽灵条目 `@duya/desktop` |
| `d9eb7dba` / 干净 | 同上 | `node scripts/architecture/audit-imports.mjs --json` + G1 覆盖计算 | 0 | 跨边界边 **2593**；审 **523（20.2%）**；跳过 **2070**（源无层 1627 / 目标无层 443）；反向边 **0** |
| `d9eb7dba` / 干净 | 同上 | 同上，假设 `@duya/host` 进层 | 0 | 审 **1665（64.2%）**；跳过 **928** |
| `d9eb7dba` / 干净 | 同上 | 按包统计跳过边数 | 0 | 源侧：`host` 892 / `ui` 69 / `data` 39 / `client-core` 13；目标侧：`host` 533 / `agent-protocol` 121 / `data` 78 / `plugin-core` 57 / `src-renderer` 52 / `connectors` 38 / `memory` 34 / `ui` 22 / `client-core` 22 / `ai` 20 |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "@duya/tooling" packages apps --include=*.ts` | 0 | 仅 `packages/capabilities/src/fs-contributors.ts:15`（`import type`）与 `packages/capabilities/src/index.ts:13`（注释）；**无运行时消费者** |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：**被 [03](03-host-layer-verdict.md) 阻塞**——`@duya/host` 不进层，
  本卡的"覆盖到 2593"无法验收（`host` 一个包就占 1425 条）。
- **被本卡覆盖的既有条目**：610 的 **A8.2**（`client-core` 层定义）——
  落点 = **core 层**。**不改 610 的 15 号文件**，由 610 owner 记账。

**下一步**：认领本卡，先做三处「待核对」——
(1) `layerOfSpecifier('@duya/memory/xyz')` 到底返回什么；
(2) `packages/sandbox/src/index.ts` 的导出面能否把纯路径判定与 Docker IO 分开；
(3) `layerOfSpecifier('@duya/ui/contracts/git')` 在 ui 定 host 层后判成什么。
**完成判据**：三处都有明确答案，且每个答案都带"这会改变门禁的哪条判定"。

**回退**：只动 `scripts/architecture/boundary-gates.{mjs,test.ts}` 与
`docs/architecture/ARCHITECTURE_MAP.md` ⇒ 单提交 revert 即回原状。
**无生产代码、无数据、无 schema 变更。**
