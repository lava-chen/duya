# 07 — workflow DAG 同层并行

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-07-workflow-dag-parallel`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

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

- [ ] 写 `dag-concurrency.test.ts` 的两条用例（同层无依赖 → 交错；同层有依赖 → 串行），确认红/绿
- [ ] 写第三条用例（并发上限），确认红
- [ ] `engine.ts` 改为**按依赖分层并发**调度（Kahn 分层），复用现有 `Semaphore`
- [ ] 跑 §验收 的 3 组命令
- [ ] 跑 §变异 的 3 组变异
- [ ] 与 Phase 2 C2（失败级联）/ C3（后台子 Agent 节点）划清边界并记录

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

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `sed -n '195,235p' packages/host/src/worker-workflows/engine.ts` | 0 | `:198` `for (const node of topoSort(phase.nodes))`；`:230` `node.map ? await runMapNode(ctx, this.semaphore) : await runNode(ctx)` |
| `d9eb7dba` / 干净 | 同上 | `grep -n "Semaphore" packages/host/src/worker-workflows/engine.ts` | 0 | 构造 `:155`；**唯一使用点 `:230`**（只喂 `runMapNode`） |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "run_in_background" packages/host/src` | 0 | `worker-workflows/execution-binding.ts:86` = `false`；`research-mode/research-fanout.ts:185` = `false`；`worker-subagents/service.ts:272` = `agentInput.run_in_background !== false`（**默认后台**） |
| `d9eb7dba` / 干净 | 同上 | `ls packages/host/tests/worker-subagents/` | 0 | `engine-run.test.ts` / `subagentParams.test.ts` / `transcript.test.ts` / `worktree-isolation.test.ts`；**无 `background-lifecycle.test.ts`** |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：**被多 Agent 编排 Phase 1 阻塞**（`background-lifecycle.test.ts` 缺失）。
  C3 部分另**被 [08](08-background-subagent-lifecycle.md) 阻塞**（`TaskStatus` 映射表要先定）。

**下一步**：认领本卡，先写**不依赖后台子 Agent**的那条用例——
`it('interleaves two independent sibling nodes in the same layer')`，
用假 host 记录调用序列，确认它红且红的原因是"严格串行"。
**完成判据**：用例在 base 上红，且失败信息能看出"两个调用没有交错"。

**回退**：只动 `packages/host/src/worker-workflows/{engine,node-runner,execution-binding}.ts`
与 `packages/host/tests/worker-workflows/**` ⇒ 按子步分提交，单提交 revert 即回原状。
**无 schema 变更、无数据迁移。**
