# 12 — 切片契约：从历史消息分支并继续对话（branch-from-history）

> 状态：**Active（实施中）** · 基线：`master@95e1fc7c` · worktree：`.claude/worktrees/610-branch-run`（分支 `plan/610-branch-from-history`）
>
> 本文是本切片的唯一状态源。它不是 610 A 线切片（A0–A7），而是使用 A3 已落地的
> RunEngine 生产路径的一个**产品切片**：把"用户从历史消息创建分支 → 输入新提示 →
> 实际启动一个新 Run"接成生产闭环。

---

## 0. 目标与验收口径

用户在会话中选中一条较早的历史消息，创建分支；随后在分支里输入新提示，实际启动一个
**新 Run**：

1. 新 Run 的模型上下文截止到选定边界（含该消息，不含其后消息）。
2. 新 Run 有独立 `runId`、独立事件序列、独立终态，并在 `runs.parent_run_id` 落记录。
3. 父会话与父 Run 完全不被修改。
4. 分支历史、父子关系、运行结果在应用重启后仍可读（SQLite + rollout）。
5. 非法边界 / 缺失父 Run / 存储失败 → 明确错误，不落半成品。
6. 重复提交同一分支请求不产生重复子分支。
7. 普通对话、旧 session fork、edit-and-resend 零回归。

**本切片不开启 resume/pause 能力**（见 §7）。

---

## 1. 语义裁决（写死，不留解释空间）

### D1 分支 = 子 session + 子 session 的首个 Run 携带 parentRunId

复用现有会话级 fork（`forkSession`，`apps/desktop/src/main/db/core/session-fork.ts:203`）：
分支创建一个**子 session**（复制边界前的有效时间线），用户随后在子 session 里正常发消息，
首条消息触发的 Run 即"分支 Run"。裁决依据：

- fork 后端已完整（session 行 + rollout 种子 + `parent_session_id` + `session_spawn_edges` 血缘），
  且有现成 IPC（`db:session:forkAt`），缺的只是 UI 入口与分支语义增强。
- 子 session 天然满足"父保持完整、分支可独立查看、重启可读"。
- plan 486 的同 session branched 投影层是另一种语义（同 session 内的分支层），
  与"独立 Run、独立事件序列"的验收不匹配；本切片**不接通**它的 UI wire，`forkTurn` /
  `bindRunForkMarker` / `projectModelMessages({runBranch})` 保持现状不动。

子 session 与子 Run 的关系：**子 session 的第一个 Run 记录 `parentRunId`；
该 session 后续 Run 是分支的延续，不再携带 `parentRunId`**（它们的父是子 session 里的
前一个 Run，由 `runs.session_id` + 时间序表达，无需新字段）。

### D2 边界 → 父 Run 的映射是确定性的，映射不出就报错

选中消息（`boundaryMessageId`）→ 父 Run 的映射规则（在 main 侧 `runs` 表上执行）：

- 候选：`runs.session_id = parentSessionId AND started_at <= message.created_at`，
  取 `started_at` 最新的一条；
- 校验：`message.created_at < (该 run 的 finished_at ?? 同 session 下一 run 的 started_at ?? +∞)`；
- 同 session 的 Run 顺序性由 POST /chat 的 busy 拒绝保证（`apps/desktop/src/main/agents/server/router.ts:819`）；
- 校验失败（消息不在任何 Run 窗口内，如运行记录缺失的 legacy/imported 会话）→
  `PARENT_RUN_NOT_FOUND`；窗口重叠 → `AMBIGUOUS_PARENT_RUN`。
- **禁止**在映射不出时静默回退到"最新 Run"或"全部历史"。

### D3 继承事件：planBranch 结构性排除生命周期与 checkpoint 事件

子 Run 的事件日志 = **继承的内容事件**（父 Run 事件前缀，重编号、标来源）+ **子 Run 自身事件**。

- `planBranch`（`packages/agent-runtime/src/checkpoint/branch-plan.ts:75`）修改为：在重编号前
  **过滤掉** `run.started` / `run.completed` / `run.failed` / `run.cancelled` 与全部
  `checkpoint.*` 事件。理由：
  - 生命周期事件属于 Run 本身——一个 Run 恰好一个 started、一个 terminal。继承它们
    要么触发 ledger 的 `duplicate_terminal` / `event_after_terminal`（`packages/agent-protocol/src/run-ledger.ts`），
    要么让消费方把父的终态当成子的终态导致提前终止。结构性排除使错误不可能发生，
    不依赖调用方记得过滤。
  - `checkpoint.*` 事件携带父 ledger 的 `committedSeq` 引用，重编号后引用必然失效
    （ledger 不变量 `checkpoint_seq_not_emitted`）。
- 继承 envelope 上盖三个来源戳：`parentRunId`（协议字段已存在，
  `packages/agent-protocol/src/envelope.ts:94`）、`inheritedFromSeq`（新增可选字段）、
  子 Run 的 `traceId`（在 RunSession 播种时重写）。
- `inheritedFromSeq` 语义：**只做来源审计，不参与任何投影语义**——继承事件不驱动 UI、
  不驱动 SSE live/replay（子 session 的 UI 数据来自消息时间线，不来自 run_events；
  已核实 chat SSE 重连不读 `run_events` 表，`apps/desktop/src/main/agents/server/router.ts:3974`
  的重放源是内存日志）。
- **继承事件永远不进入模型上下文，更不会重执行任何工具副作用**。模型上下文来自
  子 session 的消息时间线（`forkSession` 种子），工具结果以文本形式存在于消息里，
  不存在"恢复历史重新执行"的路径。

### D4 边界在父 Run 事件空间里的切点

`atSeq` = 父 Run 事件中 `envelope.timestamp <= boundaryMessage.created_at` 的最大 `seq`
（时间戳为 ms 级，同 ms 归入 ≤，取 seq 最大者）。`atSeq = 0`（边界消息是某 Run 的首条
user 消息之前的情形，即继承前缀为空）时**不调用 planBranch**，子 Run 直接以空继承前缀
启动，仅记录 `parentRunId`。注意 `planBranch` 现有 `empty_parent` 拒绝语义保持不变——
调用方在 `atSeq >= 1` 时才调用它。

### D5 输入重建：控制平面做"验证 + 指纹"，模型消息装配保持 worker 单实现

新增共用接口 `buildBranchRunInput`（main 侧，控制平面边界），负责：

- 读取并验证子 session 的种子时间线（`messageLog.repairedProject`）；
- 校验边界完整性：种子末条消息可经 id 映射约定（`fork:<childSessionId>:<parentMessageId>`，
  `session-fork.ts:89`）回溯到 `boundaryMessageId`；对 `session_spawn_edges.history_digest`
  重算并比对（canonical JSON + sha256，协议层 `packages/agent-protocol/src/hash.ts` 现成）；
- 产出 `RunInputSnapshot` 形状的**引用型**快照（`packages/agent-runtime/src/engine/ports.ts:1554`）：
  `history = by_ref(digest=history_digest, locator=子 session rollout 种子区间)`、
  `attachments = by_ref(附件描述符列表)`、`catalog = by_ref(manifest capabilities 摘要)`、
  `revision = runInputRevision({sessionId, prompt, options})` 扩展
  （`packages/agent-protocol/src/input-revision.ts`，`runs.input_hash` 列已存在，
  `apps/desktop/src/main/db/core/run-store.ts:216`）；
- 快照 JSON 随 `run:create` 落 `runs` 行（新列 `input_snapshot_json`，可空，仅分支 Run 写）。

**有意不做**：在 main 侧再装配一份 `ModelMessage[]`。worker 的上下文装配
（`buildAgentContext` / `projectModelMessages` / 附件回填，`packages/agent/src/message/message-framework.ts:315`
与 `packages/agent/src/agent/DuyaAgent.ts:5152`）是唯一实现；控制平面再做一份就是两份真相源，
正是本系列反复付出的漂移代价。控制平面持有的是"输入的来源与指纹"，worker 持有"输入的展开"。

### D6 数据来源分工（查证结论，写下来防止以后搞混）

| 数据 | 来源 | 说明 |
| --- | --- | --- |
| 分支后的模型上下文 | 子 session 的 rollout 时间线（forkSession 种子） | 唯一上下文来源；worker 经 `message:getBySession` 读 |
| 父 Run 事件前缀 | `run_events` 表（经 `run:get-events`） | 仅作继承审计与来源标记，不作上下文 |
| 消息与 Run 的映射 | `runs` 表时间窗 + `message_index.created_at` | 无消息级 runId；映射规则见 D2 |
| 分支血缘 | `session_spawn_edges`（spawn_type='fork'）+ `runs.parent_run_id` | edge 是分支请求的真相源；run 行是 Run 级父子真相源 |
| 压缩上下文 | rollout 的 `compaction` 行 | 现有 forkSession 种子**只复制 message 行、丢 compaction 行**（`session-fork.ts:80` 注释"message-only"）——本切片修复：分支种子需包含 ≤ 边界的 compaction 行（forkAt 老行为保持，见 Phase 2） |

### D7 幂等与原子性

- 幂等键 = `(parent_session_id, boundary_message_id, spawn_type='fork')`。重复请求返回
  既有子 session（响应带 `existing: true`），不创建第二个。语义裁决：同一父 session 的
  同一边界消息只允许一个分支。
- 原子性：`forkSession` 的三步写（`sessions.create` / `messageLog.appendBatch` /
  `spawnEdges.record`，`session-fork.ts:246-272`）与分支增强写包进**同一个事务**（三者在
  同一 SQLite 连接上；实现时核实连接归属，必要时经 core-connection 提供事务入口）。
  任一步失败 → 全部回滚，不残留 session 行 / rollout 行 / edge 行。
- 分支 Run 启动失败（继承事件 absorb 不通过等）→ Run 不启动、无 `runs` 行残留，
  错误沿现有 `RunStartError` 通道（`packages/agent-runtime/src/controller.ts:227`）返回，
  fail closed。

---

## 2. 现状事实基线（2026-10-10 静态核对，`master@95e1fc7c`）

| 断言 | 证据 |
| --- | --- |
| `planBranch` 仅测试调用，无生产调用方 | `packages/agent-runtime/test/checkpoint-branch.test.ts:53`；`src/index.ts:335` 仅导出 |
| `controller.resume()` 抛未实现 | `packages/agent-runtime/src/controller.ts:756-761` |
| `CheckpointPort` 可选且引擎未调用 | `packages/agent-runtime/src/engine/ports.ts:1144, 2088-2095` |
| `parentRunId` 协议/存储就绪、无生产写入方 | `packages/agent-protocol/src/manifest.ts:182`；`run-store.ts:181,300`；`run-control-plane.ts:112`；`manifest-factory.ts:148,257` |
| fork 后端完整、UI 缺失 | `session-fork.ts:203`；preload `index.ts:2308`；renderer `ipc-client.ts:691` 无调用方 |
| edit-and-resend = rebase 投影截断 + 普通 chat | `db-handlers.ts:1218-1246`；`ChatView.tsx:933-1036` |
| 正常 chat 链路 | `App.tsx:406` → `agent-http-client.ts:205` → `router.ts:1288` `openRun` → `run-orchestrator.ts:341` → `controller.start`（`controller.ts:470`）→ worker `agent-process-entry.ts:3456` `driveRunWithEngine` → SSE `router.ts:507` |
| run 事件持久化 | `run-store.ts:354`（`run_events` INSERT）；写链 `run-orchestrator.ts:272-315` → `db-bridge.ts:348` → `run-control-plane.ts:134-171` |
| `SEQ_CONTRACT.step = 1` | `packages/agent-protocol/src/envelope.ts:131-137`（planBranch 重编号兼容） |
| 会话 Run 顺序性 | busy 拒绝 `router.ts:819` |

---

## 3. 目标生产调用链

```
[UI] MessageItem 悬停工具条"从此消息分支"
  → renderer ipc-client branchAtMessageIPC (新增封装)
  → preload 'db:session:branchAt' (新增)
  → main db-handlers branchAt handler (新增)
     1) repairedProject 定位边界消息 → 无则 INVALID_BOUNDARY
     2) 幂等查 edge (parent, boundary, 'fork') → 命中返回既有子 session
     3) D2 映射父 Run → PARENT_RUN_NOT_FOUND / AMBIGUOUS_PARENT_RUN
     4) 读父 run_events, 算 atSeq (D4)
     5) forkSession(includeContextRows) — 单事务: session 行 + 种子 + 增强 edge
        (boundary_message_id / parent_run_id / branch_at_seq / history_digest)
     6) history_digest = sha256(canonicalJson(种子 payload 列表))
  → renderer 切换到子 session；用户输入新提示
  → POST /sessions/:id/chat (现有链路不动)
  → router openRun → runOrchestrator.openRun
     - 检测: 子 session 有 'fork' edge 且其下无既有 run
     - RunIntent.parentRunId = edge.parent_run_id → manifest.parentRunId
     - buildBranchRunInput: 重算种子 digest 比对 edge.history_digest, 产出快照+revision
     - 读父 run_events ≤ branch_at_seq → planBranch → InheritedEvent[]
     - controller.start(manifest, input, { inherited })   ← 新可选参数
       → RunSession.seedInheritedHistory: ledger.absorb(重编号 envelope)
          (1..N, parentRunId/inheritedFromSeq/子 traceId 落 envelope)
       → run.started = seq N+1, 先落盘再 dispatch (现有契约不动)
     - run:create 带 parentRunId + inputHash + input_snapshot_json
  → worker driveRunWithEngine (现有) → RunEngineImpl → SSE → UI
  → 终态: run:complete (现有 CAS) — 与继承事件无关 (D3 已排除生命周期事件)
```

---

## 4. 阶段边界

### Phase 1 — 协议与 runtime（无生产行为变化）
- `RunEventEnvelope` 增加可选 `inheritedFromSeq?: number`（additive；`codecs.ts` 同步）。
- `RunLedger` 增加 `absorb(envelope)`：校验已编号 envelope（seq 连续、payload 不变量、
  terminal 检查）并推进 `#seq`，不铸造。单测覆盖非法 absorb。
- `planBranch`：继承过滤（D3）+ 盖 `parentRunId`/`inheritedFromSeq` 戳；更新
  `checkpoint-branch.test.ts` 并做变异证明（往父事件塞 `run.completed` → 断言 plan 不含）。
- `RunSession.seedInheritedHistory(events)` + `controller.start(..., { inherited })`：
  先写继承批次（走既有 flush/persistence），再 mint `run.started`。单测：继承 1..N 后
  `run.started = N+1`；`started_not_durable` 检查覆盖继承批次；终态词表不受影响。
- 门禁：`packages/agent-runtime` vitest 全绿（基线 632/632, 50 文件）。

### Phase 2 — 存储（main 侧）
- `session_spawn_edges` 迁移：加列 `boundary_message_id` / `parent_run_id` /
  `branch_at_seq` / `history_digest`（nullable，幂等 PRAGMA 模式）+ 按
  `(parent_session_id, boundary_message_id)` 的查询 API。
- `deriveForkSeed` 增加 `includeContextRows?: boolean`：为 true 时把 ≤ 边界的 `compaction`
  行纳入种子（实现前先查证 `text`/`tool_result`/`turn_started` 行是否参与模型上下文组装，
  参与者一并纳入；参与者判定以 worker 读取路径为准，不凭直觉）。`forkAt` 默认 false
  保持行为，`branchAt` 用 true。
- `db:session:branchAt` handler + preload + renderer ipc-client 封装；单事务（D7）；
  全错误路径（`INVALID_BOUNDARY` / `PARENT_RUN_NOT_FOUND` / `AMBIGUOUS_PARENT_RUN` /
  存储失败回滚）真实 SQLite 测试（参照 `run-create-ack-real-bridge.test.ts` 模式）。
- 门禁：新增 main 测试全绿；`typecheck:all` exit 0。

### Phase 3 — 编排接线
- `run-orchestrator.openRun`：fork edge + 无既有 run → 分支 Run 路径（D3/D5/D7）。
- `buildBranchRunInput`（main 侧控制平面边界）+ `runs.input_snapshot_json` 迁移。
- agent-server 测试（真 RunController + 真 SQLite）：分支 Run 的 `runs.parent_run_id`、
  `run_events` 继承前缀（renumbered + 戳）、`run.started` seq 连续、终态正确、
  非分支 session 零行为变化。
- 门禁：`typecheck:all`；architecture:check 无新增（新 import 全部走既有依赖方向）。

### Phase 4 — UI
- `MessageItem` 工具条加"从此消息分支"（`GitFork` 图标已存在，`icons.tsx:110`）；
  成功后切到子 session（复用现有会话切换机制，实现时定位）；失败 toast 明确错误码。
- 渲染层测试 + **真实 Electron 验证**（repo 规则：preload 路径浏览器 Vite 测不出来）。

### Phase 5 — 验收与文档
- §5 验收矩阵逐项跑通并记录 HEAD 与命令 scope。
- 追加 610 执行日志（主 checkout 的未提交文档不动，在分支提交内更新本文件状态；
  合并后由用户/后续会话把索引行与执行日志收口）。

---

## 5. 验收矩阵（全部要求真实存储 + 真实 RunEngine，可控 provider）

| # | 验收 | 怎么测 |
| --- | --- | --- |
| 1 | 上下文截止边界 | 种子时间线 = 前缀（含 compaction 行）+ worker 组装输入仅含前缀（scripted provider 记录实际收到的 messages） |
| 2 | 分支执行成功 | 分支 Run（新提示）经 engine harness 完成，消息落子 session |
| 3 | 父完整 | 分支前后父 rollout 行数 / runs 行 / run_events 逐字节不变 |
| 4 | 父子关系正确 | `runs.parent_run_id`；子 run_events 继承前缀 renumbered + `parentRunId`/`inheritedFromSeq`；终态恰一个 |
| 5 | 重启可读 | 关库重开：session 行、edge、runs 行、run_events、消息时间线均可读 |
| 6 | 错误明确 | 非法边界 / 缺父 / 歧义 / 存储失败 各自错误码与无残留断言 |
| 7 | 幂等与原子 | 重复 branchAt 返回同一子 session；注入失败后三表无残留 |
| 8 | 零回归 | `forkAt`（无 compaction 场景）行为不变；edit-and-resend 测试不动且绿；普通 chat 路径测试不动且绿 |

---

## 6. 明确不做（本切片边界）

- 不开 resume/pause：`controller.resume()` 保持抛错；`CheckpointPort` 不接；安全点/
  attempt/epoch/fence、跨 attempt 预算、工具结果 unknown 协调、执行器暂停——全部保持
  `unsupported.ts` 清单原状，见 §7。
- 不承诺 provider 中途续写、不承诺外部 API exactly-once。
- 不接 plan 486 branched-thread 的 UI wire。
- 不改 `appendRebase` / edit-and-resend 语义。

## 7. 恢复能力缺口审计（交付时随附，来自 `checkpoint/unsupported.ts` 现状核对）

| 能力 | 现状 | 解锁前置 |
| --- | --- | --- |
| `execution_resume` | probe 返回 NO_RESUME；`controller.resume():756` 抛错 | replay window + manifest 指纹校验（`recoverRun` 已有半成品，无生产调用方） |
| `pause` | 无执行器 suspend 路径 | isSafeCheckpointPoint 可识别安全点，但无"暂停在安全点"的执行器行为 |
| 安全点检查点持久化 | `CheckpointStore` 接口 + InMemory 实现在，无 Sqlite 生产 adapter，引擎不调用 CheckpointPort | 生产 adapter + 引擎接线 |
| attempt/epoch/fence | `AttemptLeasePort` 定义在（`ports.ts:1607`），无生产实现 | 存储侧旧写拒绝（fence CAS）落地 |
| 跨 attempt 预算累计 | 无 | 预算 ledger 定义归属 |
| 工具结果 unknown 协调 | `danglingToolCalls()` 在（run-ledger），关闭时补 unknown 的宿主行为未接 | 宿主 close-run 路径接线 |

本切片交付后，`SUPPORTED_AFTER_D71` 中"branch as a NEW run"一条从"协议支持"变为
"生产已接线"；其余条目不变。
