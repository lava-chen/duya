# 09 — 安全与治理一条线

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-09-security-governance`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 独立线（不被 01–05 阻塞）

---

## 目标与边界

**目标**：把四件共享同一个根的事排成一条线。

> **共同根**：**"系统认为自己做了什么"与"系统实际做了什么"之间没有对账。**

| 子项 | 现状（实测） | 缺什么 |
| --- | --- | --- |
| **A. manifest 权限真实来源** | `manifest-factory.ts:19-30` 自述：路由层 `effectivePermissionRules` 是 legacy `{permissions:{...}}` 形状、不是 `PermissionRulesWire`；无线格式来源时 manifest 记 `hasRules:false`（`:187` / `:262`），`permissionPolicy` 标 `synthesised: true`（`:319`） | 一个**真的** wire 格式来源 |
| **B. sandbox 隔离** | `wrapCommand` / `executeIsolated` 在 `@duya/sandbox` 之外**零生产消费者**；`BashTool.ts` 与 `BashWorker.ts` 零 sandbox 引用；`worker-process-entry.ts:1325` 只调 `setSandboxEnabled(true)` + 预热镜像（错误被 `.catch(() => {})` 吞掉） | **接线**，不是"降级提示" |
| **C. 资源预算** | 协议 manifest 只有 `max_turns`（`packages/agent-protocol/src/manifest.ts:22` 的注释明说"the nearest real thing is the agent's `max_turns`"）；`BudgetLedger`（`packages/host/src/worker-workflows/host.ts:83-107`）只管 workflow 的 agent 调用次数 | CPU/内存、token、并发、文件写入、外部副作用的预算与**测量** |
| **D. 不可验证结果的外部调用** | 见 [11](11-resident-reconciler.md) | 对账 |

**边界**：

- **不改** `packages/sandbox/**` 的**沙箱实现**（Docker / bubblewrap 包装本身）。
- **不改** `packages/capabilities/src/permissions/policy.ts` 的路径策略
  （`isPathWithinRoots` 那条线是好的）。
- **不改** `packages/agent-protocol/src/manifest.ts` 的**已发布字段语义**
  （新增是 additive；改既有字段的语义要走协议版本）。
- **不做** [11](11-resident-reconciler.md) 的对账循环本体。
- 不改 `packages/data/src/main-schema.ts` 的既有表。

---

## 验收

### 首个失败证据（今天长什么样）

**A. manifest 权限真实来源**

```text
packages/host/tests/manifest-permission-source.test.ts   （新建）
  it('records the permission rules on the manifest from a real wire-form source', ...)
```

**今天跑它，红的形态是**：Desktop 路径产出的 manifest 里
`permissionPolicy.rules` **不存在**，`provenance.permissionPolicy.synthesised === true`。
（实测 `manifest-factory.ts:187` `const hasRules = intent.permissionRules !== undefined;`、
`:211` `...(hasRules ? { rules: copyRules(...) } : {})`、
`:319` `permissionPolicy: attributed('permissionPolicy', 'host_chat_request', !flags.hasRules)`。）

**B. sandbox 隔离接线**

```text
packages/capabilities/tests/shell-sandbox-wiring.test.ts   （新建）
  it('runs a shell command through the sandbox provider that the adapter selected', ...)
```

**今天跑它，红的形态是**：命令**原样**到达执行器——
断言"执行时用的 provider 与 `getActiveProvider()` 选出的 provider 相同"失败，
实际是 **`none` / 无沙箱**。
**更精确的证据（今天可以先写的静态断言）**：

```text
  it('has a production consumer for the sandbox execution path', ...)
```
- **今天红**：`grep` 级证据 —— `wrapCommand` 与 `executeIsolated` 的调用点
  **只有** `packages/sandbox/src/index.ts` 的 re-export，
  `packages/capabilities/src/ShellCommandTool/BashTool.ts` 与
  `packages/host/src/managed-shell/BashWorker.ts` 里**零** sandbox 引用。
  ⇒ **测试可以直接断言这一点**：从 `@duya/sandbox` 导入的
  `wrapCommand` / `executeIsolated` 在生产代码里**没有调用点**。

**C. 资源预算**

```text
packages/host/tests/worker-resource-budget.test.ts   （新建）
  it('records which resource ceilings are measured and which are not', ...)
```

**今天跑它，红的形态是**：manifest 的 `budget` 只有 `max_turns`，
`provenance.budget` 里没有"哪些是未测量"的标记。

**D. 外部副作用对账**

```text
packages/host/tests/external-effect-reconciliation.test.ts   （新建）
  it('reconciles an external side effect whose result cannot be verified', ...)
```

**今天跑它，红的形态是**：外部调用发出后**没有**任何持久化的"预期副作用"记录，
重启后无法判断它到底发生没有。

### 验收命令与预期结果

```bash
# 1) 各子项专属测试
npx vitest run packages/host/tests/manifest-permission-source.test.ts \
                packages/capabilities/tests/shell-sandbox-wiring.test.ts \
                packages/host/tests/worker-resource-budget.test.ts \
                packages/host/tests/external-effect-reconciliation.test.ts
#    预期：全部 passed

# 2) sandbox 包自身不坏
npx vitest run packages/sandbox/tests/
#    预期：全部 passed（今天 `setSandboxEnabled` 的 provider 探测用例在此）

# 3) capabilities 与 host 包 typecheck
npx tsc -p packages/capabilities --noEmit   # 预期：exit 0
npx tsc -p packages/host --noEmit            # 预期：exit 0

# 4) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

**A. manifest 权限真实来源**

1. Desktop 路径上有一个**真的** `PermissionRulesWire` 来源。
2. legacy 形状在**边界显式转换**，转换后标 `synthesised: false`
   （或明确标 `source: 'legacy_context_converted'`），
   **不是**在 cast 后面转换。
3. `manifest-factory.ts` 头部的"三字段尚无真实数据"注释**随之更新**，
   且**只**更新已解决的那一条。

**B. sandbox 隔离**

1. `wrapCommand` / `executeIsolated` **至少有一个真实生产调用点**
   （在 `ShellCommandRuntimePorts` 的实现侧或 `BashWorker` 里）。
2. **或者**：若接线成本过高，**把 `setSandboxEnabled(true)` 这个假保证去掉**，
   让系统不再声称自己被沙箱保护。**两者选其一，不许两者都不做。**
3. `none` provider 的语义被**写进用户可见的地方**
   （至少是 `initAgent` 的一条 `diagnostic` 与 manifest 的 provenance），
   不是只写在 `sandbox-adapter.ts` 的注释里。

**C. 资源预算**

1. 预算覆盖至少：**CPU/内存**、**token**、**并发**、**文件写入**、**外部副作用**。
2. 每一项在 manifest 的 provenance 里标 **measured / unmeasured**。
   ⇒ **判据**：**没有一项可以既不测量也不标记**。
3. 测得的就**真的测量**（不是写一个常量上限）。

**D. 外部副作用对账**

1. 外部调用发出前**持久化**"预期发生什么"。
2. 重启后能判断它**发生没有**、或**部分发生**。
3. 与 [11](11-resident-reconciler.md) 的对账循环共用机制（**不新建第二套**）。

### 变异证明（门禁卡必填）

- **变异 ①**：把 `hasRules` 硬编码成 `true`
  → "records the permission rules … from a real wire-form source"那条用例**必须红**。
- **变异 ②**：把 `wrapCommand` 的调用点从 `BashWorker` 里去掉
  → "has a production consumer for the sandbox execution path"那条用例**必须红**。
- **变异 ③**：把预算某一项的 `measured` 标记改成 `true`（而它其实没测）
  → "records which resource ceilings are measured"那条用例**必须红**。
  ⇒ 这条要求该用例**真的去核对测量**，不能只看标记。

---

## 进度

- [ ] 写 4 条红用例（见 §首个失败证据）
- [ ] A：定 `PermissionRulesWire` 的唯一来源与 legacy 转换点
- [ ] B：决定"接线"还是"去掉假保证"，并把 `none` 的语义写进用户可见处
- [ ] C：逐项确认预算的 measured / unmeasured，并给未测项装上标记
- [ ] D：定"预期副作用"的持久化形状（与 [11](11-resident-reconciler.md) 共用）
- [ ] 跑 §验收 的 4 组命令
- [ ] 跑 §变异 的 3 组变异
- [ ] 更新 `packages/host/src/manifest-factory.ts` 的头部注释（只更新已解决项）

---

## 发现与决策

1. **sandbox 这一条比审计说的更严重，必须更正措辞。**
   审计原话：「sandbox 降级到 `none` 时无 OS 隔离，命令原样返回，仅正则防护在位」。
   **这段对 `sandbox-adapter.ts` 的描述是准确的**
   （`:47-48` 与 `:64-65` 返回 `'none'`；`:123` 注释
   「none: returns command unchanged (regex defense still active)」；`:140-141` 原样返回）。
   **但它暗示"降级是可达的"——而实际不是。**
   实测：`wrapCommand` 与 `executeIsolated` 的调用点**只有**
   `packages/sandbox/src/index.ts:12-13` 的 re-export。
   `packages/capabilities/src/ShellCommandTool/BashTool.ts` 里
   **零** sandbox 引用（它经注入的 `ShellCommandRuntimePorts` 执行）；
   `packages/host/src/managed-shell/BashWorker.ts` 里同样**零**。
   ⇒ **真相是：OS 隔离从来没接进命令执行路径，不是"降级到 none"。**
   ⇒ 这比"降级"更糟：`worker-process-entry.ts:1325-1326` 会调
   `prepareWorkerSandbox()` → `setSandboxEnabled(true)` + 预热镜像，
   **让人以为沙箱开着**，而实际上没有任何命令经过它。
   ⇒ **裁决**：这是**接线缺失 + 假保证**，不是"降级要提示"。

2. **"仅正则防护在位"也需要更正。**
   除正则外，**路径策略是另一条独立且在位的防线**：
   `isPathWithinRoots`（`@duya/sandbox`）被
   `packages/capabilities/src/{ReadTool,EditTool,ApplyPatchTool,WriteTool,GlobTool,GrepTool}/`
   与 `packages/capabilities/src/permissions/policy.ts` 使用。
   ⇒ **裁决**：路径根策略**不是**沙箱降级的受害者，它一直在。
   本卡要处理的是**命令执行**这一条。
   ⇒ **不要**把这两条防线混成一句话——那会让"修好路径策略"看起来像"修好沙箱"。

3. **manifest 这一条是仓库自己写清楚的，不是审计的发现。**
   `manifest-factory.ts:14-38` 的头部注释已经把三件事标成
   「The Three fields the protocol flags as not yet backed by real data」，
   并且 `:26-29` 明说「converting one to the other behind a cast would put a value
   in the run row that no reader could interpret, which is the silent substitution
   this slice exists to prevent」。
   ⇒ **裁决**：本卡**不重新发明**这个语义；
   它要做的是**找到真正的 wire 格式来源**，或者
   **让 legacy 转换成为一次显式、可测的转换**（带 `source` 标记）。
   ⇒ 这正是"缺少真实来源"和"转换不诚实"的区别：
   **诚实的不做**（今天）比**偷偷地做**（cast 后面）好，
   所以当前状态是**已知的欠账**，不是**隐藏的 bug**。

4. **预算不要一次做完，要先能说清"哪些没测"。**
   协议只承认 `max_turns`；`BudgetLedger` 只管 workflow 的 agent 调用次数。
   ⇒ 裁决：**第一步不是加预算，而是加标记**——
   在 manifest 的 provenance 里为每一项预算写 `measured | unmeasured`。
   这一步成本低、收益大（它让"没测"变成事实而不是沉默）。
   ⇒ 然后按"外部副作用 → 文件写入 → token → 并发 → CPU/内存"的顺序补测量，
   因为**越靠前的越便宜**。

5. **外部副作用的对账与 [11](11-resident-reconciler.md) 是同一套机制。**
   ⇒ 决策：**先做 [11](11-resident-reconciler.md) 的对账循环骨架**，
   本卡只往里加"外部副作用"这一类被对账对象。
   ⇒ 反过来说，[11](11-resident-reconciler.md) 的验收要包含"至少一类
   不可验证结果的外部调用"，否则对账循环会退化成"只查 run 状态"。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `sed -n '14,40p' packages/host/src/manifest-factory.ts` | 0 | 「The Three fields the protocol flags as not yet backed by real data」；`:25-29` legacy 形状与 cast 的自述 |
| `d9eb7dba` / 干净 | 同上 | `grep -n "hasRules\|permissionPolicy: attributed" packages/host/src/manifest-factory.ts` | 0 | `:187` `hasRules = intent.permissionRules !== undefined`；`:211` 条件展开；`:262` `hasRules`；`:319` `attributed(..., !flags.hasRules)` |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "wrapCommand\|executeIsolated" packages --include=*.ts \| grep -v "/dist/"` | 0 | 调用点**只有** `packages/sandbox/src/index.ts:12-13`（re-export）；**零生产消费者** |
| `d9eb7dba` / 干净 | 同上 | `grep -n "sandbox\|wrapCommand\|executeIsolated" packages/capabilities/src/ShellCommandTool/BashTool.ts` | 1 | **零命中**（BashTool 经注入的 `ShellCommandRuntimePorts` 执行） |
| `d9eb7dba` / 干净 | 同上 | `grep -n "sandbox\|Sandbox" packages/host/src/managed-shell/BashWorker.ts` | 1 | **零命中** |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "@duya/sandbox" packages/capabilities/src --include=*.ts` | 0 | **8 处**全是 `isPathWithinRoots`（Read/Edit/ApplyPatch/Write/Glob/Grep + `permissions/policy.ts`）——路径策略在位，与命令沙箱是两条线 |
| `d9eb7dba` / 干净 | 同上 | `sed -n '1320,1330p' packages/host/src/worker-process-entry.ts` | 0 | `:1325-1326` `prepareWorkerSandbox((message) => log(message))`；其内部 `setSandboxEnabled(true)` + `void buildSandboxImage(reportProgress).catch(() => {})` |
| `d9eb7dba` / 干净 | 同上 | `grep -n "class BudgetLedger\|BudgetExceededError\|agentBudget" packages/host/src/worker-workflows/host.ts` | 0 | `:72` class / `:83` class / `:107` `throw new BudgetExceededError('agent', this.agentUsed, this.agentBudget)`——只管 agent 调用次数 |
| `d9eb7dba` / 干净 | 同上 | `grep -n "max_turns" packages/agent-protocol/src/manifest.ts` | 0 | `:22` 注释「the nearest real thing is the agent's `max_turns`」 |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：无（本卡是独立线）。**但 D 子项与 [11](11-resident-reconciler.md) 共用机制**，
  两者**不可并行改同一处**——见 §5.2 的公共文件清单。

**下一步**：认领本卡，先做 B 子项的**静态断言**——
写 `it('has a production consumer for the sandbox execution path')`，
让它红，并让失败信息直接列出"当前只有 re-export，没有生产调用点"。
**完成判据**：该用例在 base 上红，红的信息能让人立刻知道"这不是降级，是没接线"。

**回退**：本卡会改 `packages/host/src/manifest-factory.ts`、
`packages/capabilities/src/shell/**`、`packages/capabilities/src/ShellCommandTool/**`、
`packages/host/src/managed-shell/BashWorker.ts`、`packages/sandbox/src/sandbox-adapter.ts`、
可能的 `packages/agent-protocol/src/manifest.ts`
⇒ **按子项分提交**（A / B / C / D 各一个），每个可单独 revert。
**协议新增是 additive**；**落盘格式**（若 D 引入）回退时要能读旧数据。
