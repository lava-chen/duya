# 18 — Runtime Harness 诊断报告（H0 / H1）

Date: 2026-10-17. 计划：[18-runtime-harness-diagnostic-plan.md](./18-runtime-harness-diagnostic-plan.md)
症状：**工具调用或多步执行中途停下**。

**结论先行：本场景在 L2 层未复现。** 用真实生产 driver、真实 `RunEngineImpl`、真实 ports 跑通
三段串联工具链 `A → B → C → final`，四轮真实请求全部发生，工具结果没有丢失，引擎不是被
轮次上限或重复调用保护停掉的。因此**不建议现在改生产逻辑**——没有可归因的缺陷。

同时测出两条与本次执行相关的硬事实：**当前 bundle 比源码旧**，以及**共享检出的在途 S1
在本次诊断期间仍在改动**（诊断结束时 HEAD 已从 `15fa4850` 前进到 `cdee21d5`）。这两条会直接
影响「结论适用于哪一份运行产物」。

> **修订记录（第二轮审查后）**：本文档初稿的诊断测试存在 **1 处 HIGH 级空洞守卫**与
> **1 处 MED-HIGH 覆盖漏洞**，均由独立审查 agent 查出并已在测试中修复（见 §7）。
> §2.2「终止原因」与 §4「已证实」两行因此**已从实测降级为推断**，§6 补记了一处此前未披露的
> 静默降级。**结论本身未变，但它的证据强度被下调了。**

---

## 7. 独立审查结果与据此所做的修正（第二轮）

审查 agent 对本文档与诊断测试做了对抗式复核。结论：`PARTIAL`——claim 1/4/5 复跑成立，
claim 3 的代码引用准确但结论属推断，claim 2 的恢复已验证而变异结果未由它复现。

### 7.1 已修复的缺陷

| # | 严重度 | 缺陷 | 处置 |
| --- | --- | --- | --- |
| D1 | **HIGH** | `expect(outcome.proposed?.reason ?? 'completed')` 是**空洞守卫**。`proposed` 可为 null（`run-event-spine` 初始化即 null，orchestrator 腿直接返回 null），为 null 时两条断言都退化成读 `'completed'` 并静默通过——**而它们恰恰是检测轮次上限的那两条**，且退化发生在本报告自己承认「未知」的那条腿上 | 先 `expect(outcome.proposed).not.toBeNull()` 再读 reason。**修后实测 `proposed` 确实非 null**，故 §2.2 该行现在是实测而非推断 |
| D2 | **MED-HIGH** | `toolResultTexts` **不校验 callId 绑定**，任何 `tool_result` 都算「已送达」。**错绑的工具结果是本症状的典型成因，且在本测试里会通过** | 新增 `toolResultBindings()`，从 `tool_call_id` / `tool_use_id` 读取真实 id；对 fixture 自己发出的每个 callId，断言下一轮请求存在同 id 绑定且携带该环节自己的标记 |
| D3 | MED | 顺序断言按数组元素取 index；三个标记落在同一元素时全为 0，`[0,0,0]` 满足排序比较但什么也没证明 | 先 join 再取 `indexOf`，顺序在整段文本上度量 |
| D5 | LOW | 第二条用例名为「reports WHICH link a stop would occur at」，但它**不碰任何生产代码**（直接 new fixture 调 streamChat），名字过度声称 | 改名 `FIXTURE SELF-CHECK (no production code)`，并在注释里写明它只守卫 fixture 的检测能力，不构成对 harness 的断言 |
| D7 | LOW | `finalAnswer` 被写入并暴露却从不断言 | 补断言：finalAnswer 必须含全部三个标记 |

### 7.2 判定为「非缺陷」的项

- **D4**（`t.includes(previous.marker ?? '')` 在 marker 为 null 时退化为 `includes('')`）：
  经核对分支顺序（`fed` 在 153 行计算，`runCount === 0` 在 155 行先行返回，`!fed` 在 166 行），
  且执行器把 `runCount += 1` 与 `link.marker = marker` 写在相邻两行，**`marker === null` 蕴含
  `runCount === 0`**，故该路径当前**实际不可达**。属潜在隐患（若两行被拆开会静默放过），
  非现存缺陷，保留观察。
- 标记比对确为**跨源**（执行器铸造 vs 请求读出），不是 `a === a`；`deviations` 断言经上述分支
  证明 + `runCount` 循环 + `toHaveLength(4)` 共同承重。

### 7.3 此前未披露的降级（D6）

H1 运行的 stderr 一直有 `unexpected db action in h1 diagnostic: message:append`，
即 `tool_result_added` / `assistant_message_finalized` 的 Journal 持久化**硬失败**。
**因此本报告证明的 carryover 是纯内存的，任何经 DB 的往返环节未被执行。**
该 fixture 只应答 `modeState:get` 与 `mailbox:claimBatch`。

### 7.4 强化后的变异证明（第二轮）

对**加固后**的测试重跑同一变异（冻结 `createLegacyAssembleTurn` 的投影）：

```
× carries A -> B -> C through three real requests and produces the final artefact
  → probe_b never executed: expected +0 to be 1
Test Files 1 failed (1) | Tests 1 failed | 1 passed (2)
```

仍是 **1 failed / 1 passed** 且仍精确指到 probe_b。恢复后按字节校验：
`sha256 6d8510df…313b6` 与原文件一致、无残留、`git status` 该路径无输出。
恢复后四文件合跑 **32 passed (32) / 4 files**。

---

## 8. 本轮已落地的修复（测试 fixture，非生产代码）

初稿 §1.4 记录的 `turn-assembly-seam.test.ts` 两条确定性红，已修复。

- **根因**：`worker-db-client.ts:1158` 在模块加载时自调用 `initDbClient()`（`:131` 一次性闩）。
  该测试文件原用**静态** `import { makeWorkerSession } from './engine-turn-harness.js'`，
  而 harness 经 `engine-turn-harness.ts:67 → worker-tools/assembly.ts:1 → worker-session-runtime
  → worker-db-client` **传递加载** db-client，于是监听器在 `PRE_EXISTING` 快照之前就挂上了，
  后续显式 `initDbClient()` 是幂等空操作，减法得到空集 → 抛错。
  姊妹文件 `turn-loop-product-behavior.test.ts` 之所以不受影响，正是因为它在快照**之后**
  才动态 import harness。
- **修法**：把 harness import 改为动态，放到 `PRE_EXISTING` 快照**之后**（27 插入 / 1 删除，
  新增行全 ASCII，CRLF 保持）。**未改任何生产代码。**
- **注意（修复 agent 的纠正，已复核成立）**：**不能**改用 harness 导出的
  `installEngineTurnIpc()`——它在调用时才采集 `preexisting`，此时本文件的该集合已含 db 监听器，
  会跳过 fallback 里的每个监听器，**把抛错变成挂起**。快照顺序才是正确修法。
- **结果**：`2 failed / 11 passed (13)` → **`13 passed (13)`**；
  与姊妹文件合跑 `30 passed (30)`。
- **基线更正**：初稿派工时我写的三文件基线「19」是**错的**（19 属于
  `h1 + turn-loop + turn-pipeline` 这一组，不是本修复涉及的组合）。正确值为
  `turn-assembly-seam(13) + turn-loop(8) + turn-pipeline(9) = 30`，与 runner 计数一致。

---

## 1. 快照与复现

| 项 | 值 |
| --- | --- |
| SHA | `15fa48501c53f1575ff6e04659bcd9a8e9c88473`（`master`） |
| Node / OS | v24.16.0 / win32 |
| 起始工作树 | 32 条 dirty（基线已存盘） |
| 结束工作树 | 34 条 dirty |
| 新增文件 | `packages/host/tests/worker-product-runtime/h1-chained-tool-carryover-diagnostic.test.ts`（本轮诊断） |
| 起始命令 | `npx vitest run packages/host/tests/worker-product-runtime/h1-chained-tool-carryover-diagnostic.test.ts` |

### 1.1 快照在诊断期间是移动的（重要）

- `packages/host/src/run-orchestrator.ts` 的 mtime 为 **20:47:40**，落在本轮执行窗口内，
  且不在我的改动清单里 —— **另一个 session 在我跑测试期间修改了它**。
- 新增未跟踪文件 `packages/host/tests/worker-product-runtime/native-queue-settle-race.test.ts`
  在收尾时出现，同样不属于本轮。
- **HEAD 已从 `15fa4850` 前进到 `cdee21d5`**（审查 agent 在其执行窗口内观测到）。

**所以本报告的结论只对「约 20:50 时刻的 `worker-run-composition.ts` / `run-engine.ts` /
`worker-engine-driver.ts`」负责，`15fa4850` 这个 SHA 已不再标识被测的那棵树，
不能用来给当前树或 bundle 背书。**

### 1.2 bundle 与源码不同步（已实测）

```
packages/host/bundle/worker-entry.js          5,514,650 bytes   20:29:50
packages/host/src/run-orchestrator.ts                         20:47:40   ← 比 bundle 新
packages/host/src/worker-run-composition.ts                   20:50:42   ← 我的恢复动作（内容未变）
```

`packages/host/bundle/worker-entry.js` 相对 HEAD 亦为 dirty（diff 2195 行）。

**含义：当前运行产物不包含当前源码。** 任何「Desktop 里复现不出 / 复现出」的结果都不能直接
归因到源码结论，反之亦然。这条独立于用户症状，但它是后续做 L4 验证前必须先解决的障碍。

### 1.3 入口链（已核对，非推测）

```text
Desktop → packages/host/src/run-orchestrator.ts:2223 createWorkerExecutionChannel
        → chat:start 命令（此处才注入 options.maxTurns）
        → packages/host/src/worker-process-entry.ts:2279-2311
        → driveRunWithEngine（worker-engine-driver.ts:104）
        → selectRunDriverLeg（worker-run-composition.ts:223）
        → 两条腿：{ kind:'engine' } | { kind:'orchestrator', frames }
        → composeLegacyRunPorts → RunEngineImpl
```

`worker-process-entry.ts:2308` 把 `msg.options?.maxTurns` 透传给 driver；
`run-orchestrator.ts:2226-2230` 只在 `manifest.budget.maxTurns > 0` 时注入。
**未配置即不注入**，这一点与 §4 的 `max_turns` 排除直接相关。

### 1.4 H0 定向失败集合（本次现测，不沿用任何历史数字）

| 文件 | 结果 | 错误签名 | 分类 |
| --- | --- | --- | --- |
| `turn-assembly-seam.test.ts` | **2 failed / 11 passed（13）** | `Error: db-client registered no message listener` | **确定性，fixture 缺陷，非产品缺陷** |
| `turn-loop-product-behavior.test.ts` | 8 passed | — | 绿 |
| `engine-run-composition.test.ts` | 18 passed（合并跑时） | — | 绿 |

合并跑三文件为 `2 failed / 26 passed (28)`；**单独跑 `turn-assembly-seam.test.ts` 仍是
`2 failed / 11 passed`**，所以它不是跨文件污染，是确定性失败。

**成因（已定位）**：`packages/host/src/worker-db-client.ts:1158` 在**模块加载时**自己调用了
`initDbClient()`，注册监听器；而该测试文件的静态 import 链先加载了 `worker-db-client`，
于是监听器落在模块级 `PRE_EXISTING` 快照（`turn-assembly-seam.test.ts:229`）之前，随后
`installFakeDbIpc()` 再调 `initDbClient()` 是**幂等空操作**，过滤后为空 → 抛错。

`worker-db-client.ts` 与该测试文件都不在 dirty 清单内，因此**这是 HEAD 上的既有失败，不是 S1 引入**。
讽刺的是被挡住的两条正是「what the cycle sends the model」差分用例——即 H1 最想复用的那两条。

---

## 2. H1 复现：未复现

### 2.1 复现装置

新增 `packages/host/tests/worker-product-runtime/h1-chained-tool-carryover-diagnostic.test.ts`
（复用既有 `engine-turn-harness.ts`，未另造框架）。设计要点：

- **驱动真实链**：真实 `duyaAgent` → `driveRunWithEngine` → 真实 spine → 真实 `RunEngineImpl`
  → 真实 `composeLegacyRunPorts` → 真实 worker `convertSSEToAgentMessage`。
- **fixture 不预置答案**。这是关键：脚本不是「依次调用 A、B、C、结束」的重放，而是
  **从每个请求实际携带的内容决定回复**：
  - 请求里带着 A 返回的标记 → 才发 B 的调用；
  - 请求里带着 B 返回的标记 → 才发 C 的调用；
  - **任何一环缺失 → 记录 deviation，并用纯文本作答**——这正是用户看到的「中途停下、
    没有最终产物」。
- **跨源标记**：每个标记由**工具执行器**生成并存进测试变量，再与**模型实际收到的
  `messages` 数组**里读出的文本比对，两个独立来源，绝非 `a === a`。
  标记在 executor 运行时才随机生成，任何预置都造不出来。

### 2.2 实测结果（通过）

| 观测项 | 实测 |
| --- | --- |
| provider 请求次数 | **4**（A、B、C 三轮工具 + 一轮最终作答） |
| 三个工具各执行次数 | **各 1 次**，无重复、无漏 |
| deviation（断链记录） | **0 条** |
| 最终请求携带的标记 | A、B、C **全部存在且顺序正确**（位置严格递增） |
| 最终请求 role | 含 `assistant` 与 `tool` |
| 终止原因 | **既非 `max_turns`，也非 `repeated_tool_calls`**（**第二轮加固后为实测**：`proposed` 非 null 已被显式断言；初稿写法在 `proposed` 为 null 时会静默通过，见 §7.1 D1） |
| 产品帧 | 含 `FINAL:` 文本帧与终止 envelope |

### 2.3 首次偏离

**不存在首次偏离——在 L2 层没有偏离可指。** 这是本轮最重要的一条：计划 §3 的证据链走到
「第 N+1 轮组装 → provider 实际收到结果」时，链路是完整的。

### 2.4 读码排除（非执行证据，仅用于收敛候选）

- `run-engine.ts:1943` — `if (turnWork.dispatched > 0) return null;`：只要本轮派发过工具，
  就**不会**在 finalize 边界停。有进展的任务不会被 `dispatched` 判据误停。
- `run-engine.ts:2297-2301` — `#maxTurns()` 在未声明上限时返回 `Number.POSITIVE_INFINITY`，
  且 `run-orchestrator.ts:2226` 只在 `> 0` 时注入。**因此未配置预算的运行不可能触发 `max_turns`。**
- `run-engine.ts:412` — `RepeatedCallStreak` 是 run-scoped cell（不是每轮新建），且
  `run-engine.ts:1901` 的硬停**只在 host 下发 `repeatedCallStop` 策略时才布防**。
- 既有前作：`engine-fork-metadata-proof.test.ts:683-710` 记录过一个**完全吻合**本症状的历史
  缺陷（`createLegacyAssembleTurn` 每轮重投影 + `projectModelMessages` 丢弃 branched 行，
  导致第 2 轮看不到第 1 轮的工具结果，fork run 实测 `["user","user"]`）。**该缺陷已修复**，
  其断言现在要求 forked run 的第 2 轮必须含 `tool`。**不是本次症状。**

---

## 3. H3 变异证明：诊断测试确实能抓故障

绿灯不能自证，所以做了反向变异。

**变异**：`packages/host/src/worker-run-composition.ts` 的 `createLegacyAssembleTurn` 把
投影结果**冻结在第 1 轮**（`handle.projectTurnMessages()` 只调一次并缓存），即人为制造
「第 1 轮工具结果到不了第 2 轮请求」。

**结果**：

```
× carries A -> B -> C through three real requests and produces the final artefact
  → probe_b never executed: expected +0 to be 1
✓ reports WHICH link a stop would occur at ...        （自检用例，按设计保持绿）
```

**1 failed / 1 passed**，且失败信息**精确指出断点是 B**（第一个依赖丢失结果的环节），
而不是笼统地说「链路失败」。这正是计划 §6 第 2 条要求的「指出第一次丢失进展的边界」。

**恢复已按字节校验**：

```
restored sha256 6d8510dfcaaa83ee76acaeabdaca2d6e776ffb60a91c42c6113014fef74313b6
expected      6d8510dfcaaa83ee76acaeabdaca2d6e776ffb60a91c42c6113014fef74313b6
BYTE IDENTICAL: true      MUTATION RESIDUE: false      git status: 该路径无输出（干净）
```

恢复后复跑：`h1-chained + turn-loop-product-behavior + turn-pipeline-producer`
= **19 passed (19) / 3 files**，无回归。

---

## 4. 根因置信度

**已证实**：工具结果在 L2 层完整到达后续每一轮请求（**含 callId 绑定正确**，第二轮加固后实测）。

**降级为推断（初稿曾写「已证实」，经审查更正）**：

- `max_turns` 不是本快照的停止原因 —— 这**主要是读码推断**。且存在初稿未提及的一环：
  `#maxTurns` 除 budget 外还会回落到 `#options.defaultMaxTurns`，而 `run-engine-execution.ts:31`
  正是由 `options.maxTurns` 赋值的。「未配置即无限」因此依赖 **options 字段**而不只是 budget；
  本测试自身传的是 `{ maxTurns: 8 }`，**从未走过它所论证的那条未设上限路径**。
- 重复调用保护未触发 —— 同为读码推断（`:1901` 需 host 下发策略才布防），无执行证据。

**已证实**：bundle 落后于源码；`turn-assembly-seam` 的 2 红是 HEAD 既有 fixture 缺陷（已修复，见 §8）。

**已披露的静默降级**：`message:append` 在 H1 fixture 中硬失败，Journal 持久化未跑通，
**carryover 结论仅在内存层成立**，经 DB 的往返未验证（见 §7.3）。

**待验证（本轮未覆盖，不能声称）**：

| # | 未越过的生产边界 | 为什么它仍可能就是这个症状 | 证据层级 |
| --- | --- | --- | --- |
| 1 | **真实 provider adapter**（HTTP / SSE 分帧 / `tool_use`·`tool_result` 块编码 / `stop_reason` 映射） | provider 在 `@duya/ai` 工厂接缝处被脚本替换，**真实 adapter 一行都没跑**。adapter 侧丢块或错配 `stop_reason` 的表现与本症状完全同形 | L2 |
| 2 | **重建后的 bundle + 真实 Desktop** | §1.2 已实测 bundle 比源码旧。跑的不是这份源码，一切结论都要重测 | 缺失 |
| 3 | **orchestrator 腿** | `selectRunDriverLeg` 命中 `{kind:'orchestrator'}` 时**整个 engine 被绕过**，`#shouldStop` 等判据一概不适用。**用户失败任务的 mode/profile 走哪条腿，目前无人知道** | L2 |
| 4 | **S1 观测层**（Desktop writer / 队列结算 / 终态） | 「执行正确但事件流停了」与「真的没继续」在 UI 上不可区分。收尾时新出现的 `native-queue-settle-race.test.ts`（queued `run:event` 与 done 帧竞态）正指向这一类，**需要与本症状对照** | 部分 |
| 5 | **3 段串联 × `discarded` 单向闩** | `StreamingToolExecutor.discarded` 是不回头的闩。2 轮已覆盖、3 轮在 `turn-pipeline-producer` 单独覆盖，但**「串联 carryover」与「跨 3 轮 pipeline」从未组合测过** | L2 |

### 下一项区分实验（按信息量排序）

1. **在真实 adapter 之后取证**（区分表 #1）。用本机 loopback provider 起真实 HTTP 端点跑同一条
   三段链，**逐轮落盘 adapter 实际发出的请求字节与收到的原始响应**。若 adapter 侧完整而 engine
   也完整，则症状落在 #2–#4；若 adapter 侧就缺块，根因即刻收敛。这是唯一能把「harness 丢轮」
   与「provider 帧丢失」分开的实验。
2. **补齐真实用户任务的 mode/profile**（区分表 #3），确定走的是 engine 腿还是 orchestrator 腿。
   在此之前，engine 腿的全绿**不能代表用户那条路径**。
3. **先重建 bundle 再做真实 Desktop 复现**（区分表 #2 + #4）。用同一条三段链，分别取
   「worker 事件时间线」与「UI 时间线」，以区分「仍执行但不可见」和「真的没继续」。

---

## 5. 最小修复建议

**本轮不提出生产修复。** 未复现即无可归因的缺陷，按计划 H4 第 1 条，根因未明时不启动重构。

**不做的三件事**（计划明令）：不增加自动继续循环、不提高轮次上限、不改 `#terminalCandidate`
的状态映射。

**唯一建议立刻处理的**（与症状无因果关系，但挡路）：

- ~~`turn-assembly-seam.test.ts` 的 fixture~~ **已修复，见 §8。**
- 重建 `packages/host/bundle/worker-entry.js`，或明确记录「本次结论不适用于 bundle」。
  **必须由该产物的 owner 做**：`worker-entry.js` 相对 HEAD dirty 2195 行且属于在途 S1，
  在共享检出上重建会覆盖他人产物并触发 SQLite ABI 切换。

## 6. 未执行的检查（如实列出）

- 未跑真实 provider / 真实模型 smoke（计划 H1 最后一条）——需先解决 §1.2 的 bundle 问题。
- 未做 L3（真实 worker 子进程 + Host）与 L4（真实 Desktop）验证。
- 未测量 orchestrator 腿的任何行为。**审查认定这是最高价值的缺口**：若用户失败的任务走的是
  orchestrator 腿，则 §2.2 的全绿测的是用户从未走过的路径，「未复现」这一负面结论即失效。
  补齐真实用户任务的 mode/profile 是一次台账查询，不是新 harness。
- 未验证 Journal/DB 往返：H1 fixture 中 `message:append` 硬失败（§7.3）。
- 未跑 `architecture:check` / `typecheck:all`（本轮未改生产代码）。**注意：没有任何 typecheck
  配置覆盖这两个测试文件**——`packages/host/tsconfig.json` 的 `include` 只有 `src/**/*`，
  根 tsconfig 只覆盖 renderer glob，esbuild 又不检查类型。因此测试文件只有运行时证据，
  没有类型门禁。
- 未编写 H2 部件覆盖矩阵的完整逐行盘点。
- 未在干净 worktree 上隔离复现那 2 条红（基线取自脏树，靠「不在 dirty 清单」间接佐证；
  且树此后已移动，该佐证比当时更弱）。
- 审查 agent 未复跑变异（需改源码），亦未核实 bundle 相对 HEAD 的 2195 行 diff 规模。
