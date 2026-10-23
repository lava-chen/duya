# 11 — 常驻对账监督者

状态：todo · 负责人：待认领 · 更新：2026-10-23
分支：待建（建议 `codex/622-11-resident-reconciler`） · worktree：待分配
base：`d9eb7dba96f63b3e07b4fba9c068acd017616913` · owner：待认领

关联：[622 README](./README.md) · 前置：[08](08-background-subagent-lifecycle.md)

---

## 目标与边界

**目标**：让对账从**按需调用**变成**常驻行为**。

**先更正审计的措辞**（详见 [622 README §3.5](./README.md)）：
审计说「对账机制有缺口」，**不准确**——机制是齐的。
审计说「缺的是开机自动对账的常驻监督者」，**方向对但过头**——
Desktop **已经有**开机对账。

**精确的缺口是四条**：

| # | 缺口 | 证据 |
| --- | --- | --- |
| (a) | **rollout 对账没有开机调用** | `reconcileRollouts` 只挂在 IPC：`apps/desktop/src/main/ipc/db-handlers.ts:547`。`apps/desktop/src/main/index.ts:397` 的开机对账**只做** `reconcileStaleRuns([])` |
| (b) | **独立 Host / CLI 路径没有任何对账启动** | `packages/cli/src` 里 `reconcile` 的命中全是**同名不同物**（`packages/cli/src/tui/remote-session-watch.ts:187` 的私有 `reconcile(run)`，是 transcript 刷新）；`packages/host/src` 里对账只作为 **HTTP 端点**存在 |
| (c) | **没有周期性对账** | 开机一次不能覆盖"运行中崩溃"。Host 有 `setInterval` 定时器（idle reaper 等），但**没有一个是对账** |
| (d) | **后台子 Agent 生命周期无对账** | 见 [08](08-background-subagent-lifecycle.md) |

**边界**：

- **不新建对账机制**——复用既有的
  `reconcileStaleRuns`（`packages/host/src/workflow-run-api.ts:48`）与
  `reconcileRollouts`（`packages/host/src/session-api.ts:686`）。
- **不改** `packages/data/src/run-store.ts` 的 epoch 围栏
  （`run_attempt_epoch` 迁移在 `:310`）与
  `packages/agent-protocol/src/checkpoint.ts` 的 resume token epoch 栅栏。
- **不改** `reconcileStaleRuns` 的语义（它是对的）。
- 与 [09](09-security-and-governance.md) 的 D 子项**共用机制**，不并行改同一处。

---

## 验收

### 首个失败证据（今天长什么样）

**今天的失败形态**：对账**只能被人叫**，不会自己发生。

**(a) rollout 对账没有开机调用**

```text
packages/host/tests/host-reconcile-supervisor.test.ts   （新建）
  it('reconciles stale rollouts when the host starts', ...)
```

- 今天跑它，红的形态：Host 启动后，**没有任何代码路径**调用 `reconcileRollouts`。
  断言"启动后 `reconcileRollouts` 被调用过"失败，调用次数 **0**。

**(b) 独立 Host / CLI 没有对账启动**

```text
  it('reconciles stale runs when the standalone host starts', ...)
```

- 今天跑它，红的形态：`packages/host/src/local-host.ts`（或等价启动入口）
  里**没有** `reconcileStaleRuns` 的调用；调用次数 **0**。

**(c) 没有周期性对账**

```text
  it('reconciles periodically, not only at startup', ...)
```

- 今天跑它，红的形态：用假时钟推进 N 个周期，断言"对账被调用了 ≥ 2 次"失败，
  实际调用次数 **1**（只有开机那一次）或 **0**。

**(d) `activeRunIds` 参数从未被真正使用**

```text
  it('supplies the live run ids to the reconciler instead of an empty set', ...)
```

- 今天跑它，红的形态：断言"传给 `reconcileStaleRuns` 的 `activeRunIds`
  等于当前在跑的 run 集合"失败，实际传入的是**空数组**。
- ⇒ 这条用例同时守住一个**危险方向**：如果监督者传空数组，
  它会**把所有 running 的 workflow run 标成 interrupted**。
  ⇒ **这条用例必须有对照组**：造一个"确实在跑"的 run，
  断言它**没有**被标 interrupted。**没有对照组的这条用例会鼓励一个危险的实现。**

### 验收命令与预期结果

```bash
# 1) 监督者专属测试
npx vitest run packages/host/tests/host-reconcile-supervisor.test.ts
#    预期：全部 passed（含 (a)(b)(c)(d) 与 (d) 的对照组）

# 2) host 包 typecheck
npx tsc -p packages/host --noEmit
#    预期：exit 0

# 3) 桌面主进程不坏
npx vitest run apps/desktop/src/main/__tests__/
#    预期：与基线同红同绿（先记录基线）

# 4) 下游不许坏
npm run architecture:check     # 预期：仍 OK
npm run plan:sync              # 预期：仍 OK
```

### 完成判据

1. **开机对账**：Desktop 启动时**既**做 workflow run 对账**又**做 rollout 对账。
2. **独立 Host 启动时**做同样的两件事（CLI 走独立 Host 时自动获得）。
3. **周期性对账**：有可注入的周期（便于假时钟测试），且默认周期有界。
4. **`activeRunIds` 真的有内容**：监督者维护"当前在跑的 run 集合"，
   传给 `reconcileStaleRuns`。
   ⇒ **对照组必须绿**：确实在跑的 run **不被**标 interrupted。
5. **对账可观测**：每次对账的次数、被标记的条数写进结构化日志
   （用所属包的 logger，禁止 `console.log`），不记录消息正文。

### 变异证明（门禁卡必填）

- **变异 ①**：把监督者的开机调用去掉
  → (a)(b) 两条用例**必须红**。
- **变异 ②**：把周期设为无限大（只开机跑一次）
  → (c) 那条用例**必须红**。
- **变异 ③**：把 `activeRunIds` 改成 `[]`（即使有在跑的 run）
  → (d) 那条用例**必须红**，且**对照组也必须红**
  （对照组验证"在跑的 run 被误标"这个后果）。

---

## 进度

- [ ] 写 (a)(b)(c)(d) 四条用例 + (d) 的对照组，确认红
- [ ] 在 Host 启动路径加开机对账（run + rollout 两件）
- [ ] 加周期对账（周期可注入，便于假时钟测试）
- [ ] 维护"当前在跑的 run 集合"并传给 `reconcileStaleRuns`
- [ ] 加结构化日志（次数 / 被标记条数）
- [ ] 跑 §验收 的 4 组命令
- [ ] 跑 §变异 的 3 组变异
- [ ] 与 [09](09-security-and-governance.md) D 子项合流：外部副作用进同一套对账

---

## 发现与决策

1. **Desktop 已经有开机对账，这条必须写进卡片，否则会重复劳动。**
   `apps/desktop/src/main/index.ts:386-409` 的注释原文：
   「Plan 560 §6.2 — crash reconciliation. This process has just booted, so no workflow
   engine is running anything yet … Mark them `interrupted` — never auto-resume;
   replaying a journal is the user's explicit decision.」
   ⇒ **裁决**：本卡**不重做** workflow run 的开机对账；
   本卡补的是 **(a) rollout 的开机对账**、**(b) 独立 Host 路径**、
   **(c) 周期性**、**(d) 活着的 run 集合**。

2. **`activeRunIds` 在生产里从未被真正使用过——这是本卡最重要的发现。**
   `reconcileStaleRuns(activeRunIds)`（`workflow-run-api.ts:48`）
   → `runs.reconcileStaleRuns(new Set(activeRunIds))`
   → `packages/data/src/workflow-run-store.ts:466`：
   查出所有 `status IN ('active','verifying','planning','awaiting_confirm')` 的行，
   **凡是不在 `activeRunIds` 里的，一律标 `interrupted`**
   （`'crash reconciliation: engine not running this run'`）。
   - HTTP 端点：`http-server.ts:2577`，`activeRunIds` 来自**请求体**
     （`body.activeRunIds`）⇒ 依赖客户端知道自己是活着的。
   - IPC 桥：`apps/desktop/src/main/agents/db-bridge.ts:2424`
     → `(p.activeRunIds as string[]) ?? []`。
   - **唯一生产调用点**：`apps/desktop/src/main/index.ts:397` → `reconcileStaleRuns([])`
     （空数组，因为开机时确实没有引擎在跑）。
   ⇒ **真相**：这个参数是**安全阀**（"如果你知道哪些还活着，告诉我"），
   **不是活性来源**。开机传空数组在那个时刻是对的，
     但它**证明不了**监督者知道谁活着。
   ⇒ **裁决**：本卡要做的是让监督者**自己知道**哪些 run 活着
   （Host 自己的 in-flight run 表），然后传进去。
   ⇒ **危险方向**：`reconcileStaleRuns([])` 在**运行中**调用会把所有 running 的
   workflow run 标成 interrupted。这就是 (d) 那条用例必须有对照组的原因。

3. **对账是"标状态"，不是"恢复"。**
   实测 `workflow-run-store.ts:466-489`：只 `UPDATE ... SET status='interrupted'`，
   **不自动重跑**。Desktop 的注释也明说「never auto-resume；
   replaying a journal is the user's explicit decision」。
   ⇒ **裁决**：监督者**不引入自动恢复**。它只保证"状态是诚实的"。
   ⇒ 这与 [11 的兄弟卡 08](./08-background-subagent-lifecycle.md) 的 `lost` 语义一致：
   **宁可说"丢了"，也不假装还活着。**

4. **epoch 栅栏已经在了，不要重造。**
   `packages/data/src/run-store.ts:310` 的 `run_attempt_epoch` 迁移 +
   `packages/agent-protocol/src/checkpoint.ts` 的 resume token epoch 栅栏
   ⇒ 写在 run 行里的 attempt 围栏保证"旧 attempt 的写入被拒"。
   ⇒ **裁决**：监督者**不碰** epoch 逻辑。它只决定"哪些 run 该被标 stale"。

5. **对账必须是按类别对账，不是全表扫。**
   `workflow-run-store.ts:466` 的 SQL 是全表扫四个状态。
   ⇒ 裁决：监督器的周期对账**必须带上限/分页**，否则一个长跑实例上
   周期扫描会变成负载。周期与批量大小可注入。

6. **日志用结构化 logger，不记录消息正文。**
   根 `AGENTS.md`：「日志用所属包的结构化 logger，禁止生产代码
   `console.log/warn/error`，不记录密钥或消息正文。」
   ⇒ 对账日志只记**计数与 ID 摘要**，不记用户内容。

---

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `d9eb7dba` / 干净 | macOS 12.7.6 · Node v20.20.2 | `grep -rn "reconcileStaleRuns\|reconcileRollouts" packages/host/src` | 0 | `workflow-run-api.ts:48` / `session-api.ts:686`（定义）；`http-server.ts:788` / `:2577`（**端点**）；`http-client.ts:757` / `:1022`（客户端） |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "reconcile" apps/desktop/src packages/cli/src --include=*.ts` | 0 | `apps/desktop/src/main/index.ts:397` `reconcileStaleRuns([])`（**开机对账，已存在**）；`ipc/db-handlers.ts:547` `reconcileRollouts()`（**仅 IPC**）；`agents/db-bridge.ts:2424`（IPC 桥）；`packages/cli/src` 的命中是**同名不同物**（`tui/remote-session-watch.ts:187` 的 transcript 刷新） |
| `d9eb7dba` / 干净 | 同上 | `sed -n '466,492p' packages/data/src/workflow-run-store.ts` | 0 | `SELECT * FROM workflow_runs WHERE status IN ('active','verifying','planning','awaiting_confirm')`；不在 `activeRunIds` 里的一律 `mark.run('interrupted', 'crash reconciliation: engine not running this run', …)` |
| `d9eb7dba` / 干净 | 同上 | `grep -n "run_attempt_epoch" packages/data/src/run-store.ts` | 0 | `:310` 迁移（epoch 列与围栏在位） |
| `d9eb7dba` / 干净 | 同上 | `grep -rn "setInterval" packages/host/src --include=*.ts` | 0 | 11 处定时器（idle reaper、进度、heartbeat 等）；**无一个是对账** |
| `d9eb7dba` / 干净 | 同上 | `sed -n '386,409p' apps/desktop/src/main/index.ts` | 0 | Plan 560 §6.2 开机对账注释；`reconcileStaleRuns([])`；`logger.info` 记被标记条数 |

---

## 接续 / 结果

- **已实现 / 已验证 / 已合并**：本卡**尚未开工**。以上是开工前的基线取证。
- **未提交路径**：无。
- **副作用**：无。
- **阻塞**：**被 [08](08-background-subagent-lifecycle.md) 阻塞**（子 Agent 生命周期要落盘，
  才有可对账的真相来源）。
- **与 [09](09-security-and-governance.md) 的关系**：D 子项（外部副作用对账）
  与本卡**共用机制**；两者**不可并行改同一处**，须串行或由同一 owner 承接。

**下一步**：认领本卡，先做最危险的那一步的取证——
读 `packages/data/src/workflow-run-store.ts:466-489` 与
`apps/desktop/src/main/index.ts:397`，写出**"如果在运行中调用
`reconcileStaleRuns([])` 会发生什么"**的精确描述，并确认现有代码里
**没有**这样的调用路径。
**完成判据**：描述有源码依据，且能指出 (d) 那条用例的对照组该怎么写。

**回退**：本卡会改 `packages/host/src/**`（启动路径 + 新的监督者模块）、
`apps/desktop/src/main/index.ts`、可能的 `packages/cli/src/**`
⇒ 按子步分提交：(1) 开机 rollout 对账 → (2) 独立 Host 对账 →
(3) 周期对账 → (4) 活着的 run 集合。每个子步可单独 revert。
**无 schema 变更、无数据迁移**；但对账会**改写 run 行状态**
⇒ 回退时要考虑已被标 `interrupted` 的行（它们本来就是崩溃残留，
不构成数据损失，但**要记在验证记录里**）。
