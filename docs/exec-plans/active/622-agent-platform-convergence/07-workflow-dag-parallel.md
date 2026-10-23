# 07 — workflow DAG 同层并行

状态：已实现（未合并） · 负责人：本次会话（worker） · 更新：2026-10-23
分支：`codex/622-07-workflow-dag-parallel` · worktree：`.claude/worktrees/622-07`
base：`6c6a411f`（= `codex/plan-622`；**堆叠 PR**：#384 先合，本卡 PR 再合） · owner：worker

关联：[622 README](./README.md) ·
**与 [多 Agent 编排 Phase 2](../2026-10-23-multi-agent-orchestrator.md) 共用同一份实施**——
本卡是它的**排序与验收对齐**，不是重写。

---

## 目标与边界

**目标**：`packages/host/src/worker-workflows/engine.ts` 在 **DAG 的同一层内**
并发执行无依赖的兄弟节点。

**今天的失败形态（实测）**：

```text
packages/host/src/worker-workflows/engine.ts:198
  for (const node of topoSort(phase.nodes)) {
    ...
    const result = node.map ? await runMapNode(ctx, this.semaphore) : await runNode(ctx);
```

- `topoSort` 给出一个**拓扑序**，循环体里 `await runNode(ctx)` —— **同层无依赖兄弟节点永不交错**。
- `Semaphore`（`:155` 构造，`:230` 只喂给 `runMapNode`）**只管单节点内的扇出**，
  不管节点之间的并发。

**边界**：

- **不改** `packages/host/src/worker-workflows/host.ts` 的 `Semaphore` 实现
  （多 Agent Phase 2 C1 明确要求"复用现有 `Semaphore`"）。
- **不改** `map` 节点的既有并行语义。
- **不做**失败级联（那是 Phase 2 C2，同一份实施的一部分）。
- **不做**重试退避（Phase 3 E1）。
- 不改 `packages/host/src/worker-workflows/node-runner.ts` 以外的生产代码。

**与既有计划的关系**：多 Agent 编排计划的 **Phase 2** 已经写好了 C1 / C2 / C3 的形状与验收。
本卡**只做三件事**：(a) 把 C1 的实施排到 Phase 1 之后；
(b) 补 C1 在本仓的**首个失败证据**（Phase 2 只写了验收，没写今天长什么样）；
(c) 明确 C3（后台子 Agent 节点）与 [08](08-background-subagent-lifecycle.md) 的边界。

---

## 验收

### 首个失败证据（今天长什么样）

多 Agent 编排计划的验收原文是：「新增用例断言『**同层两个无依赖节点的 host 调用交错执行**』」。

**今天跑它，红的形态**（本卡必须先把它写出来）：

```text
packages/host/tests/worker-workflows/dag-concurrency.test.ts   （新建）
  it('interleaves two independent sibling nodes in the same layer', ...)
```

- 夹具：一个 phase，两个**无依赖**节点，每个节点调一次假的 host。
- 断言：两个节点的 host 调用**交错**（第一个未完成时第二个已经开始）。
- **今天跑它，红的形态是**：断言 `interleaved === true` 失败，
  实际**两个节点严格串行**（第一个完成并返回后第二个才开始），
  且**没有任何超时或挂起**——它就是慢，不是坏。

**关键**：这条用例**必须在 base 上红**。
多 Agent 计划的验收要求写得很清楚：「每个新用例必须在 base 上跑红」，
且「『两种状态下答案相同』的断言一律不收」。
⇒ 断言必须能区分"交错"与"串行"，**不能**只断言"两个节点都跑了"。

**对照组要求**：同一个文件里要有**一条**"同层但**有**依赖"的用例，
它今天必须**绿**（串行是对的）——否则"交错"这条用例可能只是在断言"并发"，
而不是"同层无依赖才并发"。

### 验收命令与预期结果

```bash
# 1) workflow 包测试
npx vitest run packages/host/tests/worker-workflows/
#    预期：全部 passed；新用例 2 条（同层无依赖 → 交错；同层有依赖 → 串行）

# 2) host 包 typecheck
npx tsc -p packages/host --noEmit
#    预期：exit 0

# 3) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **同层无依赖节点交错执行**（用例绿）。
2. **同层有依赖节点仍串行**（对照组仍绿）。
3. **`map` 节点的既有并行语义不变**（既有 workflow 测试仍全绿）。
4. **并发上限仍受 `Semaphore` 约束**：新增一条用例，
   断言"同层节点数 > `options.concurrency` 时，实际并发不超过 `concurrency`"。
   ⇒ **没有这条，"并行"就可能变成"无限并发"。**
5. **失败级联可表达**：C2 的 `blocked` / `errorClass='dependency_failed'`
   若在本次实施，配套用例必须落；**若不在，本次实施必须显式记录"未做"**，
   不允许含糊（610 §停止清单 3：不给历史缺口写"必须为零"的断言）。

### 变异证明（门禁卡必填）

- **变异 ①**：把 `engine.ts:198` 的循环改回**严格串行**（例如用 `Promise.all` 之外的
  逐个 await，或把 `runNode` 外面再包一层串行化）
  → "交错"那条用例**必须红**，"有依赖仍串行"那条必须**仍绿**
  （证明这条用例测的是交错，不是"变快了"）。
- **变异 ②**：去掉 `Semaphore` 的并发上限
  → "并发不超过 `concurrency`"那条用例**必须红**。
- **变异 ③**：让**有依赖**的节点也并发
  → 对照组那条用例**必须红**（证明对照组有牙齿）。

---

## 进度

- [x] 写 `dag-concurrency.test.ts` 的两条用例（同层无依赖 → 交错；同层有依赖 → 串行），确认红/绿
- [x] 写第三条用例（并发上限），确认红
- [x] `engine.ts` 改为**按依赖分层并发**调度（Kahn 分层），复用现有 `Semaphore`
- [x] 跑 §验收 的 3 组命令
- [x] 跑 §变异 的 3 组变异
- [x] 与 Phase 2 C2（失败级联）/ C3（后台子 Agent 节点）划清边界并记录

**实测结果（细节见 §验证记录）**：

| 项 | base（`6c6a411f`） | 改后 |
| --- | --- | --- |
| 同层无依赖 → 交错 | **红**：`start:alpha -> end:alpha -> start:beta -> end:beta`（严格串行，慢而不是坏） | 绿 |
| 同层有依赖 → 串行（对照组） | **绿**（今天就绿，所以它有资格当对照组） | 仍绿 |
| 并发上限 ≤ `options.concurrency` | **红**：`expected 1 to be 2`（今天根本没有并发） | 绿（peak = 2） |
| `map` 扇出并行 + `concurrency:1` 不死锁 | 绿（回归护栏） | 仍绿 |

- 新增文件：`packages/host/tests/worker-workflows/dag-concurrency.test.ts`（4 条用例）。
- 改动文件：`packages/host/src/worker-workflows/engine.ts`（**唯一**生产代码改动）。
- `node-runner.ts` **未改**（不需要改：分层调度在 engine 层完成）。

---

## 发现与决策

1. **审计对因果链的判断是准确的："workflow 子 Agent 节点阻塞 → DAG 无法并行"。**
   实测：`packages/host/src/worker-workflows/execution-binding.ts:86` 固定
   `run_in_background: false`；
   `packages/host/src/worker-modes/research-mode/research-fanout.ts:185` 同。
   而**子 Agent 服务默认是后台**：
   `packages/host/src/worker-subagents/service.ts:272`
   `const effectiveRunInBackground = agentInput.run_in_background !== false;`
   ⇒ **系统支持后台子 Agent，是 workflow 节点不肯用。**

2. **"Semaphore 只喂给 runMapNode"这个描述准确，且它解释了为什么并行没有发生。**
   `engine.ts:230` 是 `Semaphore` 的**唯一**使用点，
   它的作用域是**单节点内**的扇出（`runMapNode`）。
   ⇒ 并行的**上限机制已经存在**，缺的是**节点间的调度**。
   这让 Phase 2 C1 的改法很小：换调度，不换限流。

3. **顶层 `topoSort` 的结构限制了并行的形状。**
   `topoSort(phase.nodes)` 给出一个**线性序**；要并行必须改成**分层**
   （Kahn 的分层版本：每层内无依赖，层间有序）。
   ⇒ 决策：**不要**在现有 `topoSort` 上打补丁（那会得到"部分交错"的怪异语义），
   **改成分层拓扑**，让"层"成为显式概念。这样 C2 的失败级联
   （"其传递依赖者标 blocked"）也才有自然的表达位置。

4. **C3（后台子 Agent 节点）与 [08](08-background-subagent-lifecycle.md) 的边界。**
   Phase 2 C3 写的是：「在 `execution-binding.ts:80-115` 增加后台分支
   （`run_in_background: true`），并把 `TaskStatus` 映射进 journal，使 `wait` 语义可表达」。
   ⇒ 决策：
   - **C3 在本卡范围内**（它是 engine 调度的一部分），但**只做"节点可以派生后台子 Agent"**。
   - **"后台子 Agent 的状态怎么活过进程重启"是 [08](08-background-subagent-lifecycle.md)**，
     本卡**不**做。
   ⇒ 顺序：**08 的状态模型要先定**（Phase 4 F3 的 `RunLifecycleState ↔ TaskStatus` 映射表），
   否则 C3 映射进 journal 的 `TaskStatus` 没有稳定语义。
   ⇒ **本卡因此排在 [08](08-background-subagent-lifecycle.md) 之后实现，
   但它的"交错"用例可以先写**（不依赖后台子 Agent）。

5. **Phase 1 是硬前置。**
   多 Agent 编排计划 §发现 3 写明：「`background-lifecycle.ts`（22.7 KB，持有 Worker 状态机）
   **零专属测试**，而 Phase 2 会改动同一片语义。**决策：先补测再改行为**」。
   实测：`packages/host/tests/worker-subagents/` 下只有
   `engine-run.test.ts` / `subagentParams.test.ts` / `transcript.test.ts` /
   `worktree-isolation.test.ts` —— **没有 `background-lifecycle.test.ts`**。
   ⇒ 本卡**被 Phase 1 阻塞**（若 Phase 2 的 C3 触及同一片）。

6. **本卡不重复 Phase 2 的实施。**
   Phase 2 已经把 C1 / C2 / C3 的目标、改法与验收写完了。
   ⇒ 本卡的增量是**本仓的首个失败证据** + **并发上限用例** + **边界切分**，
   不是另一份设计。**执行时以 Phase 2 为准，本卡只补充。**

7. **决策：`map` 节点不占"节点级"信号量槽位。**
   `runMapNode` 自己按 item 取槽（`map-runner.ts` 里 `semaphore.acquire()`），
   所以节点级再包一层 `semaphore.run()` 会让**节点与它的 item 抢同一个上限**——
   `concurrency: 1` 时节点占着唯一的槽、item 永远等不到 ⇒ **死锁**。
   ⇒ 决策：**普通节点走 `this.semaphore.run(...)`，`map` 节点仍走
   `runMapNode(ctx, this.semaphore)`**（既有并行语义一字未改）。
   ⇒ 用例 `keeps map fan-out parallel and deadlock-free at concurrency 1` 锁住这条。

8. **决策：层内"谁上报失败/挂起"按层内声明顺序决定。**
   并行后一层里可能同时有多个失败节点。旧实现是"拓扑序里第一个出事的节点赢"，
   现在的对应物是"层内声明顺序里第一个出事的节点赢" ⇒ 结果可复现，不依赖完成先后。
   ⇒ 同层其余节点已经发起，无法回滚；**后续层不再启动**。

9. **行为变化（有意为之）：独立节点之间不再保证执行先后。**
   旧 `topoSort` 是 DFS 后序（`c, a, b` 这样的顺序），新 `topoLayers` 按依赖分层，
   独立节点同层并发。依赖顺序**仍然被层次严格保证**（依赖者必在更后层）。
   ⇒ 依赖某个"副作用先后"的旧工作流会受影响；这是本卡的目标本身，不是回归。

10. **决策：`packages/agent/src/modes/workflow/engine.ts` 不用改。**
    实测它是 `export * from '@duya/host/worker-workflows/engine';`（**再导出**，无重复实现），
    ⇒ 遗留层自动继承新行为，不需要同步改动。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `sed -n '195,235p' packages/host/src/worker-workflows/engine.ts` | 0 | `:198` `for (const node of topoSort(phase.nodes))`；`:230` `node.map ? await runMapNode(ctx, this.semaphore) : await runNode(ctx)` |
| `d9eb7dba` / 干净 | 同上 | `grep -n "Semaphore" packages/host/src/worker-workflows/engine.ts` | 0 | 构造 `:155`；**唯一使用点 `:230`**（只喂 `runMapNode`） |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "run_in_background" packages/host/src` | 0 | `worker-workflows/execution-binding.ts:86` = `false`；`research-mode/research-fanout.ts:185` = `false`；`worker-subagents/service.ts:272` = `agentInput.run_in_background !== false`（**默认后台**） |
| `d9eb7dba` / 干净 | 同上 | `ls packages/host/tests/worker-subagents/` | 0 | `engine-run.test.ts` / `subagentParams.test.ts` / `transcript.test.ts` / `worktree-isolation.test.ts`；**无 `background-lifecycle.test.ts`** |

### 本卡实施（base `6c6a411f` = `codex/plan-622`）

环境统一为：macOS 12.7.6 · Node v20.20.2 · npm 10.8.2 ·
worktree `.claude/worktrees/622-07` · 分支 `codex/622-07-workflow-dag-parallel`。
（先跑 `npm run build:packages` → `built 20 package(s)`，否则 `@duya/ai` 无 dist，
vitest import 期即失败——**环境性**，与本卡无关。）

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `6c6a411f` / 干净 | 同上 | `npx vitest run packages/host/tests/worker-workflows/`（**基线**） | 0 | 12 files · **185 tests passed**（改动前的 workflow 基线） |
| `6c6a411f` / dirty（**仅新增测试文件**，生产代码未动） | 同上 | `npx vitest run packages/host/tests/worker-workflows/dag-concurrency.test.ts` | **1** / 2 failed · 2 passed | **首个失败证据**：① `interleaves two independent sibling nodes in the same layer` → `the two independent siblings must overlap, got start:alpha -> end:alpha -> start:beta -> end:beta: expected false to be true`（**严格串行；没有超时、没有挂起——它就是慢**）；② `caps same-layer concurrency at options.concurrency` → `expected 1 to be 2`（今天根本没有并发）；③ 对照组 `keeps two dependent nodes serial inside one phase` **当时就绿**（所以它有资格当对照组）；④ `map` 回归护栏绿 |
| `6c6a411f` + 实现 / dirty | 同上 | `npx vitest run packages/host/tests/worker-workflows/` | 0 | 13 files · **189 tests passed**（185 既有 + 4 新增） |
| 同上 | 同上 | `npx tsc -p packages/host --noEmit` | 0 | 无输出 |
| 同上 | 同上 | `npm run architecture:check` | 0 | `OK — no new boundary violations`（tolerated 2608 / baseline 2785；"255 fingerprint 不再触发"是既有提示，**未用 `--write` 重录基线**） |
| 同上 | 同上 | `npm run plan:sync` | 0 | `plan-sync-check  16 done rows · 28 file refs · 14 test-name refs` → `OK` |
| 同上 | 同上 | `npx vitest run packages/host/tests/worker-workflows/dag-concurrency.test.ts` × 10（连跑） | 0 × 10 | 每次 `Tests  4 passed (4)` ⇒ 新用例**无抖动** |
| 同上 | 同上 | **变异 ①**：层内改回逐个 `await`（严格串行） | **1**（预期红） | `interleaves two independent sibling nodes…` **红**（同 base 签名）；`keeps two dependent nodes serial…` **仍绿** ⇒ 这条用例测的是"交错"，不是"变快了" |
| 同上 | 同上 | **变异 ②**：去掉 `this.semaphore.run(...)`（并发上限消失） | **1**（预期红） | `caps same-layer concurrency…` **红**：`expected 5 to be less than or equal to 2`；其余三条仍绿 |
| 同上 | 同上 | **变异 ③**：`topoLayers` 忽略依赖（全部塞进一层） | **1**（预期红） | 对照组 **红**：`expected [ 'start:alpha', 'end:alpha' ] to deeply equal [ 'start:alpha', 'end:alpha', …(2) ]`（`beta` 因 `${alpha.output}` 未就绪被跳过）⇒ 对照组有牙齿 |
| `6c6a411f` / 干净 **vs** 改后 | 同上 | `npx vitest run packages/host/tests/`（**整包**） | **1**（两边一致） | **既有环境故障**：vitest worker 进程崩溃 `Unhandled Rejection: Error: Channel closed` / `ERR_IPC_CHANNEL_CLOSED`（tinypool），**base 与改后日志逐行同签名**，且都只跑到 `message-compaction-controller` + `CompactionManager.loop-guards` 两个文件 ⇒ **不是本卡引入**，整包门禁在本机不可用；本卡以 `packages/host/tests/worker-workflows/` 为准 |

---

## 接续 / 结果

- **已实现**：`engine.ts` 的 `topoSort`（线性拓扑序）→ `topoLayers`（Kahn 分层）；
  同层节点用 `Promise.all` 并发；**普通节点**经 `this.semaphore.run(() => runNode(ctx))`
  取号 ⇒ **并发上限 = `options.concurrency`**；**`map` 节点**仍走
  `runMapNode(ctx, this.semaphore)`（不改既有并行语义，且不占节点级槽位 ⇒ `concurrency:1` 不死锁）。
  层内失败/挂起按**层内声明顺序**决定上报者（可复现）。
- **已验证**：见 §验证记录。4 条新用例 + 既有 185 条全绿；3 条变异全部按预期变红；
  `tsc` / `architecture:check` / `plan:sync` 全绿；新用例连跑 10 次无抖动。
- **已合并**：**无**。PR 未合并、未获授权集成。
- **未提交路径**：无（提交后为空；只暂存本卡 3 个文件）。
- **副作用**：无（无 schema 变更、无数据迁移、无共享检出改动）。
- **阻塞**：无。

### C2（失败级联 / `blocked` / `errorClass='dependency_failed'`）：**未做**（显式记录）

理由（不是含糊的"以后再说"）——C2 要"节点失败 → 其**传递依赖者**标 blocked → **无关分支继续跑完**"，
它需要三件同时落地的事，而**没有一件能只在本卡的独占路径内完成**：

1. **`EngineOutcome` 的"部分失败"聚合语义**：`EngineOutcome` 是 `@duya/host` 的公开导出，
   `packages/host/src/worker-workflows/manager.ts:418 toLaunchResult()` 按 `status` 分支消费它。
   新增"部分失败"变体**必须同步改 `manager.ts`** —— 而 `manager.ts` **不在本卡的独占路径内**
   （本卡只准改 `engine.ts` / `node-runner.ts` / `packages/host/tests/worker-workflows/**`）。
2. **`blocked` 节点终态与 `dependency_failed` 错误类**：`WorkflowErrorClass` 定义在
   `packages/host/src/worker-workflows/error-class.ts`，同样在本卡独占路径之外。
3. **`on_error='fail'` 的语义从"停整个 run"变成"停这条分支"**：这是**运行级契约变更**，
   会影响 `manager.ts` / `runner.ts` 与桌面端的失败呈现。

⇒ **半做**（只标 `blocked`、不做聚合）会留下一个自相矛盾的契约
（节点被跳过，但 run 仍报 `failed`，且"无关分支继续跑完"并没有发生）——**比不做更糟**。
⇒ 按 610 §停止清单 3，**本卡不给这个历史缺口写任何"必须为零"的断言**，
  新增的 4 条用例也**没有一条断言 C2 的行为**（避免给未做的功能发"通行证"）。
⇒ **留给 Phase 2 C2**（与本卡共用同一份实施，由编排计划会话承接）。
  本卡交付的**分层调度**正是 C2 需要的结构：失败节点的依赖者**必在更后层**，
  "其传递依赖者标 blocked"在层结构里有天然表达位置（`topoLayers` 的层边界）。
- **C3（后台子 Agent 节点）**：**未做**，仍**被 [08](08-background-subagent-lifecycle.md) 阻塞**
  （`RunLifecycleState ↔ TaskStatus` 映射表要先定，见 Phase 4 F3）。本卡不碰
  `execution-binding.ts`，该文件也**不在**本卡独占路径内。

### 下一步（给后续会话）

1. Phase 2 **C2**：先定 `EngineOutcome` 的"部分失败"聚合形态与 `manager.ts` 的消费方式，
   再在 `topoLayers` 的层边界上实现"失败节点的传递依赖者标 `blocked`"。
2. Phase 2 **C3**：等 [08](08-background-subagent-lifecycle.md) 的 `TaskStatus` 映射表定稿后，
   在 `execution-binding.ts` 加后台分支。
3. **整包 host 测试在本机不可用**（既有 tinypool 崩溃，见 §验证记录最后一行）——
   后续若要跑整包，需先修环境（Node ≥22 / 原生模块），否则只能按目录跑。

**回退**：只动 `packages/host/src/worker-workflows/engine.ts`（唯一生产代码改动）
与 `packages/host/tests/worker-workflows/dag-concurrency.test.ts`（新增）
⇒ 按子步分提交，单提交 revert 即回原状。
**无 schema 变更、无数据迁移。**

