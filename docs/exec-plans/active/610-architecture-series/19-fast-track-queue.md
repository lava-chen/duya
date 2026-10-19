# 19 — 快速执行队列（T 卡）

Date: 2026-10-17. Parent: [610](README.md). Supersedes the **ordering** (not the
architecture) of [17 §5 切片队列](./17-shared-agent-platform-execution.md).

## 0. 本文是什么

- [17](./17-shared-agent-platform-execution.md) 定义**架构裁决**：职责边界、Rust 取舍、
  唯一执行事件序列、不能混淆的概念。那些结论**继续有效**，本文不改它们。
- 本文是**唯一执行队列**。17 的 S0–S9 是"成果级"切片，一个 agent 无法在一轮里做到绿；
  本文把它们切成 PR 级 **T 卡**，每卡都有：独占路径、首个失败证据、验收命令、回退。
- 卡片状态只认**具名测试 + commit**，不认 `Waiting` / `In progress`。
  一张卡没有可复跑的绿测试，就是没完成，无论代码写到哪里。

三条硬规则：

1. **一卡一 PR**，≤ ~400 行生产改动；超了就拆卡，不扩大卡片。
2. **先有失败证据，再改生产代码**。每卡的"首个失败证据"字段必须是一个测试文件:用例名
   ＋ 今天能复现的失败形态。写不出这一行，说明这张卡还没想清楚，不许开工。
3. **公共文件同一时刻只属于一条车道**（§3）。跨车道改动走"接缝请求"。

---

## 1. 基线（2026-10-17 实测，不是转述）

HEAD `a935741f`，Windows 11 / Node v24.16.0，**共享检出带其他 session 的未提交改动**。
共享检出当时有 2 个并发 session 正在改 `packages/host/**` 与
`apps/desktop/src/main/__tests__/**`，文件 mtime 在分钟级变动 —— 任何"落盘在途"的动作
都必须先确认树已静止，否则提交的是别人半成品。

### 1.1 17 里已经完成的（文档没写，这是最大的沉没成本）

| 17 的说法 | 实测 |
| --- | --- |
| S0 `Ready` / S1 `Waiting` | **S0 收口、S1 基本落地**：`15fa4850` Runtime 身份入台账 · `cdee21d5` 原生通道→durable + receipt + 终态屏障 + Desktop 面 · `a935741f` fence 进 run API · `ac1f5183` store 层 epoch 围栏 · `ee76c294` 台账测量 · `9c8d589a` 复现 |
| S0 两条 `it.fails` 待 S1 修 | `packages/host/tests/worker-product-runtime/native-event-ledger-roundtrip.test.ts:501/515` 已是正式 `it`，wrapper 已删 → **S0 合同转绿** |
| `worker-process-entry` 进程边界未覆盖 | `worker-subprocess-ledger.test.ts` 4 条，真 `spawn` 子进程写 stdout 喂真台账 |
| attempt/epoch 无列 | `packages/data/src/run-store.ts:310` `run_attempt_epoch` 迁移 + `epoch` 列 |
| — | 原生通道已是**唯一**台账写入者；legacy 帧只做反向翻译并计入降级计数（`run-orchestrator.ts:1907`） |

复核命令（本次实测全绿）：

```bash
npx vitest run packages/host/tests/worker-product-runtime/native-event-ledger-roundtrip.test.ts \
                packages/host/tests/worker-product-runtime/native-channel-faults.test.ts \
                packages/host/tests/worker-product-runtime/native-queue-settle-race.test.ts \
                packages/host/tests/worker-product-runtime/worker-subprocess-ledger.test.ts \
                packages/host/tests/run-attempt-fence-http.test.ts \
                packages/host/tests/worker-product-runtime/run-attempt-queue-lifecycle.test.ts \
                apps/desktop/src/main/__tests__/run-attempt-fence-real-adapter.test.ts \
                apps/desktop/src/main/__tests__/terminal-publication-barrier.test.ts
```

`npm run typecheck:all` exit 0（electron ratchet: 231 known / 0 new）。
**注意**：干净的 `typecheck:all` 需要先 `npm run build:packages` —— 本次首次运行失败在
`@duya/capabilities/dist` 缺 `mode-tools.*`（陈旧 dist），重跑 build 后才绿。这个假红会
反复吃掉半小时，已写进 §9。

### 1.2 真实剩余缺口（每条都有源码入口）

| # | 缺口 | 入口 | 影响的卡 |
| --- | --- | --- | --- |
| G1 | `turn.completed` 曾经**零生产发射点**（引擎从不发射，仅协议注册表/投影器/测试合成存在）→ **T01 已部分关闭**：`end_turn` 且 provider 报了 usage 的轮次现在有终态；`tool_use` 继续轮与无 usage 轮仍无（T01b） | `packages/agent-runtime/src/engine/run-engine.ts` `#publishTurnCompleted` | T01b |
| G2 | 正式 TUI 消费原生事件后**再投影成 LegacyFrame**，`TranscriptModel` 另有 reducer | `packages/cli/src/tui/host-event-stream.ts:24`、`packages/cli/src/chat.ts:37` | T10–T12 |
| G3 | `client-core` **零生产消费者**；唯一 `SurfaceModel` 使用点在退役包内 | `packages/agent/src/cli/ui/surface-view.ts:206` | T10–T12 |
| G4 | 能力三向（执行/消费/提供）未绑定，无客户端反向门禁 G11 | `packages/agent-protocol/src/{capabilities,host-capabilities}.ts`、`packages/agent-core/src/capability-negotiation.ts`；`scripts/architecture/` 无对应 gate | T13–T15 |
| G5 | `session:spawn*` 只在 Desktop；独立 Host 落 `unimplemented_domain` | `apps/desktop/src/main/agents/db-bridge.ts:664/763/770/809` vs `packages/host/src/worker-db-bridge.ts` | T20–T21 |
| G6 | Desktop 自持流状态（回调 + store + Electron 耦合） | `apps/desktop/src/renderer/lib/stream-session-manager.ts` | T23 |
| G7 | `apps/web` 不存在 | — | Wave 3 |
| G8 | `packages/host/bundle/*` **tracked 但比源码旧**（在途未提交重建） | `packages/host/bundle/` | T03 |
| G9 | 旧 Agent 退役 gate 仍 OPEN | `scripts/architecture/agent-retirement-gate.mjs` | Wave 3 |
| G10 | **CI `test` job 恒红且不携带任何信息**：守卫读不到 vitest 汇总行（`collected: UNKNOWN`），master 每个 commit 都一样 | `.github/workflows/*` 内嵌守卫；run `39040547246` / `39044714745` | T04。**红因已定位到 T04b**（测试把普通对象送进 pool 的 `process.send`，run 在 reporter 打印前被杀）；守卫本身已中性化（`unread` 退出 0 / `no-log` 退出 1），不再是红因 |

---

## 2. 为什么之前慢（每条对应本文的一个对策）

| 症状 | 根因 | 对策 |
| --- | --- | --- |
| 一轮做完还是"分析" | 切片是成果级（S2 = 状态层 + TUI + 删 reducer + PTY） | T 卡 ≤400 行，一卡一 PR |
| 下一位 agent 要从头勘察 | 卡片没有具名失败测试 → 必须先复现一次现状 | 每卡"首个失败证据"是**必填字段** |
| 计划与代码漂移 | 状态词是 `Waiting`，没人核 | §11 追踪表只写 `测试名 + commit`；T02 加机械同步检查 |
| 并发覆盖 | 4 个切片共享 `run-api.ts` / `run-orchestrator.ts` / `router.ts` / `worker-process-entry.ts` | §3 车道 + 文件所有权，公共文件单写者 |
| 假红吃掉半天 | 陈旧 `dist`（`@duya/capabilities/mode-tools`）、陈旧 bundle | T03 固化 bundle 策略；§9 写明先 `build:packages` |

---

## 3. 车道与文件所有权（冲突图）

| 车道 | 独占路径 | 不得触碰 |
| --- | --- | --- |
| **L-HOST** | `packages/host/src/{run-orchestrator,run-api,run-control-plane,http-server,http-client,worker-headless-run-host,run-event-spine,run-receipt}.ts`、`packages/agent-protocol/src/run-api.ts`、`apps/desktop/src/main/control-plane/host-run-api-adapter.ts`、`apps/desktop/src/main/agents/server/{index,router,native-run-event-writer}.ts` | renderer、cli、client-core |
| **L-CLIENT** | `packages/client-core/**`、`packages/cli/src/{chat.ts,tui/**}` | host 的 `run-*` 文件 |
| **L-DESKTOP** | `apps/desktop/src/renderer/**`、`apps/desktop/src/main/ipc/**`、`apps/desktop/src/preload/index.ts` | host ledger 路径 |
| **L-GATE** | `scripts/architecture/**`、`docs/exec-plans/**` | 任何 `src/**` 生产代码 |
| **L-APP** | `packages/plugin-*/**`、`apps/web/**`（Wave 3 才开） | 以上全部 |

**公共文件清单（单写者）**：`run-api.ts`（协议）、`run-orchestrator.ts`、
`agents/server/router.ts`、`worker-process-entry.ts`、`architecture-policy.yaml`。
非 owner 车道要改这些文件 → 先在 PR 描述里写"接缝请求"（改哪个函数、为什么不能放自己车道），
由该车道 owner 合入。

---

## 4. 卡片格式（缺任一字段 = 未定义，不许开工）

```text
T## 标题
车道 / 前置 / 预计规模
目标       一句话，可验收
独占路径   允许改的文件（超出即越界）
首个失败证据  测试文件:用例名 + 今天的失败形态
步骤       3–6 条，每条一个可验证动作
验收命令   可直接复制粘贴
变异证明   门禁卡必填：制造它要防的回归 → 红 → 回退 → 绿
回退       出错时怎么退（revert 范围 / 数据迁移是否需要反向）
```

---

## 5. Wave 0 — 收官（阻塞所有后续卡）

### T00 落盘 S1 fence + 终态屏障

- 车道 L-HOST ／ 前置 无 ／ 规模 已写好，只差提交
- 目标：把工作树里已验证的 fence 硬化与终态发布屏障提交到 master，使后续卡不再叠在未提交改动上。
- 独占路径：`packages/agent-protocol/src/run-api.ts`、`packages/host/src/{run-api,run-control-plane,run-orchestrator,http-server,http-client,worker-headless-run-host}.ts`、`apps/desktop/src/main/control-plane/host-run-api-adapter.ts`、`apps/desktop/src/main/agents/server/index.ts` ＋ 4 个新测试文件。
- 首个失败证据：无需（本卡是落盘，不是修复）。**但必须先证明绿**：
  §1.1 的 8 文件集合全绿 + `typecheck:all` exit 0。
- 步骤：
  1. 确认树静止：目标文件 mtime 连续 10 分钟不动，且无其他 session 正在改。
  2. 跑 §1.1 复核命令；任一新红 → 停止，先归因。
  3. `git add` 仅限独占路径（**排除** `packages/host/bundle/*`、`packages/capabilities/**`、
     `scripts/**`、`AGENTS.md`、`ARCHITECTURE.md`、`package.json`、其他 session 的 docs）。
  4. Conventional commit：`feat(agent): require an attempt fence on every run write`。
- 验收命令：`npx vitest run <§1.1 八个文件>` + `npm run typecheck:all`。
- 回退：单 commit revert；无 schema 变更（epoch 列已在 `ac1f5183` 落地）。
- 已知在途风险：本卡开工时检出里有**另一个 session 正在改**
  `apps/desktop/src/main/__tests__/terminal-publication-barrier.test.ts`、
  `packages/host/tests/worker-product-runtime/run-attempt-queue-lifecycle.test.ts`
  （22:18–22:19 仍在写）。树未静之前**不许提交**，否则提交的是别人半成品。
- **已落地**：`44123662`（22:2x 提交时 fence 文件集已静止 3 分钟、8 文件 55 测试全绿）。
  提交时另有 session 在改 `packages/cli/src/tui/**`，未纳入本卡。

### T01 `turn.completed` 生产者

- 车道 L-HOST（引擎侧）／ 前置 T00 ／ 规模 ~80 行 + 测试
- 目标：轮次结束由 Runtime 发射 `turn.completed`（携带 `turnId` / `index` / `stopReason` /
  `usage` / `durationMs`），使客户端不必靠 `run.completed` 或猜 `turn.started` 的对手来判定轮次终态。
- 独占路径：`packages/agent-runtime/src/engine/run-engine.ts`、`packages/agent-runtime/test/turn-terminal-event.test.ts`（新建）。
- 首个失败证据：`packages/agent-runtime/test/turn-terminal-event.test.ts` —— 离线 provider 跑一轮
  → 断言 envelope 流里存在 `turn.completed`。**今天为 0 次**（全仓无生产发射点，见 §1.2 G1）。
- 步骤：
  1. 写上面这条测试，确认红（不是"找不到发射点"，而是断言计数为 0）。
  2. 在引擎每轮收尾处发射，`seq` 继续用该 run 的单一序列（17 §4.2，不得另起）。
  3. 与 `run.completed` 的先后写成断言：turn 终态必须先于 run 终态。
  4. 若某条路径（取消 / 存储拒绝 / 上限）今天到达不了 turn 收尾，**登记为显式 unsupported**，
     不要用"必须为零"的测试把缺口固化成正确（17 §6 的教训）。
- 验收命令：`npx vitest run packages/agent-runtime/test/turn-terminal-event.test.ts packages/host/tests/worker-product-runtime/native-event-ledger-roundtrip.test.ts`
- 回退：发射点删除即可；无 schema、无迁移。

### T02 计划↔代码同步检查

- 车道 L-GATE ／ 前置 无 ／ 规模 ~150 行
- 目标：机器校验本文 §11 追踪表：凡标记 `done` 的卡，其引用的测试文件必须存在、
  引用用例名必须能在该文件里匹配到。防"文档说完成、代码没做"再次发生。
- 独占路径：`scripts/architecture/plan-sync-check.mjs`、`scripts/architecture/plan-sync-check.test.ts`。
- 首个失败证据：把 §11 任意一行标 `done` 并指向不存在的用例 → 脚本必须报红并打印
  `card T14 → packages/...test.ts: no test matching "..."`。
- 步骤：解析 §11 表格（Markdown 表格，固定列）→ 对 `done` 行做存在性 + 用例名匹配 →
  `--strict` 时退出码非 0 → 接进 `npm run architecture:check` 的调用链（或独立 npm script）。
- 验收命令：`node scripts/architecture/plan-sync-check.mjs --strict` + 上述变异。
- 回退：删脚本 + 移除 npm script 一行。

### T03 `packages/host/bundle` 策略定案

- 车道 L-GATE ／ 前置 无 ／ 规模 决策 + 脚本改动，无业务代码
- 目标：bundle 是 tracked 且**今天已比源码旧**（§1.2 G8）。二选一并写进 ARCHITECTURE：
  (a) 继续 tracked → 加一条 `bundle:verify` 脚本并在 CI 里生成后 `git diff --exit-code`；
  (b) 改成 gitignored → 从索引移除并在构建入口补生成。
- 首个失败证据：`bundle:verify` 脚本在**当前**树上必须红（证明它能测出源码↔bundle 漂移）。
- 独占路径：`scripts/architecture/bundle-verify.mjs`、`package.json`（script 一行）、`ARCHITECTURE.md`（一节）。
- 验收命令：`npm run bundle:verify`（当前故意红）→ 重建 bundle 后转绿。
- 回退：删脚本 / 恢复 `package.json`。

### T04 修 CI `test` 门禁的 summary 解析（P0）

- 车道 L-GATE ／ 前置 无 ／ 规模 ~30 行 + workflow
- 目标：让 `test` job 的结论重新具有信息量。**今天它红得毫无意义**：
  `gh run view 39040547246 --log-failed` 显示 master 每个 commit 都是
  `guard FAILED: could not read the vitest summary line. - test files collected: **UNKNOWN**`
  —— 而汇总行读不到，是因为 **run 在 reporter 打印之前就被杀了**，不是正则问题。
- 后果：`test` 在 master 与每个 PR 上**恒红**，因此它区分不了
  “11 条已知红” 与 “新增了一条真回归”。#275 的测试结果完全不可用。
- 首个失败证据（**实测，取代原卡的 `^[[` 字面量说法**）：master `a24b14eb` 的 run
  `39040547246` job `117419024954` 与 #275 run `39044714745` 同一行
  `##[error]Process completed with exit code 1` + `collected: UNKNOWN`。
  取回原始 job 日志逐字节量：
  - 真 ESC 字节 **43025** 个 —— vitest 的颜色码是**真 ESC**，写入方没有剥它；
  - 字面量 `^[[` 出现 **0** 次 —— “ESC 被转义成 `^[[` 字面文本”这个旧诊断与字节**不符**，
    它是错的（两条语法都留着接受，代价只是一个 alternation，但**不是 G10 的成因**）；
  - `passed` 出现 **0** 次 —— vitest 汇总块必然含 “passed”，所以**日志里从来没有过汇总块**。
  （本 PR 提交的逐字节摘录 `scripts/ci/__fixtures__/ci-crash-no-summary-39040547246.log`
  复核同一结论：ESC 150 / `^[[` 0 / `passed` 0。）
- 真正的失败形态：日志末尾是 **Unhandled Rejection**
  `[vitest-pool]: Unexpected call to process.send()` →
  `Caused by: TypeError … ERR_INVALID_ARG_TYPE`，栈底在
  `node_modules/vitest/dist/chunks/coverage.*.js` 的 `deserialize`。
  即：**某个测试把一个普通对象送进了 vitest forks pool 自己的 `process.send` 通道**，
  run 在 reporter 打印汇总前死亡。**这条才是 T04 的完成判据**，已独立开卡为 T04b。
- 步骤：
  1. 在守卫里同时接受 `^[[` 字面量与真 ESC 两种形态（或先不带 `--color` 重定向）。
  2. 加一条：解析不到汇总行时必须报 `UNKNOWN` 并**以中性退出**（不吞红，但也不把
     “没采到” 报成 “测试失败”）；真正的测试失败由 vitest 退出码决定。
     —— **`unread` 中性、`no-log` 必须红**：日志**存在但没有汇总**说明守卫读到了输入、
     读坏了，run 的真实结局另有记录；日志**根本不存在**说明是接线坏了，
     守卫是唯一还能说话的东西，此时退出 0 等于把断线说成通过。
  3. 变异：把一个必然失败的测试注入 → job 必须因**测试**红；撤掉 → 因守卫解析而红不了。
- 回退：单文件 revert（workflow 内嵌脚本或 `scripts/ci/test-summary-guard.mjs`）。

### T04b 让任何测试都不可能把普通对象送进 pool 的 `process.send`（P0）

- 车道 L-GATE ／ 前置 T04 ／ 规模 ~200 行（含 5 个测试文件改写）
- 目标：把 T04 里那条 Unhandled Rejection 的**成因**消掉，而不是只让守卫学会闭嘴。
  完成判据不是“日志变绿”，而是 **CI 的 `test` job 第一次真的打出 vitest 汇总行**
  （`Test Files` / `Tests` 两行同时出现）。
- 首个失败证据（本地实测，非 CI 转述）：
  `npm test` 全量跑在 reporter 打印汇总前被杀，1.15 MB 日志里 `Test Files` 出现 **0 次**；
  崩溃载荷是一个 `db:request`：
  `{"type":"db:request","action":"message:append","payload":{"sessionId":"sess-1","messages":[{"id":"journal:u-1:user_msg_added",…}]}}`
  → 栈：`[vitest-pool]: Unexpected call to process.send()` + `Buffer.from` 的
  `ERR_INVALID_ARG_TYPE`。**载荷证明源头是 db 层，不是某个测试的断言。**
- 根因（两条，同一个致命后果）：
  1. `worker-db-client` 原有的守卫是 `if (!process.send) throw`。在 vitest forks worker 里
     `process.send` **是存在的**——只是它属于 pool，不属于我们。守卫因此从未生效。
  2. 打桩形状是“存下真 `process.send` → 换成假 → `afterEach` 还原”。只要还有一条
     in-flight `db:request`（journal flush、mode-state 轮询）在 `process.nextTick`
     之后才落地，它的发送就发生在**还原之后**，于是普通对象进了 pool 通道。
- 修法（按要求取“更正确”的那条）：
  - `packages/host/src/worker-db-client.ts` 注入 transport port：
    `setDbTransport({ send })`。transport **没有全局可还原**，所以“还原”这件事本身消失了，
    不存在可被竞态命中的窗口。
  - 模块加载时记下 `PRISTINE_SEND`。解析顺序：已安装的 transport → 测试自己替换过的
    `process.send`（与 PRISTINE 不同，说明是测试的假通道，安全）→ 生产真实通道。
  - **护栏**：在测试进程里，若以上都没有，就**拒绝发送并抛出指名的错误**，
    而不是把普通对象交给 pool。忘装 transport 的测试从“杀死整个 run”降级成
    “一个点名道姓的红”。
  - 4 个打桩点（`engine-event-spine-and-surface` / `engine-control-command-proof` /
    `engine-declared-tools-refresh-proof` / `engine-before-commit-phase`）改为装 transport。
  - `journal.test.ts` 的 `vi.mock` 指向错了 module id（打在 agent 侧兼容 shim 上，
    而 host 的 `Journal` 直接 import `'../worker-db-client.js'`），mock 从未生效，
    于是真实 db 流量一路走到 pool。改指 `@duya/host/worker-db-client`。
  - `vitest.config.ts` 给 `@duya/host` 补上与其他包同款的 worktree-safe source alias。
- 验证：新增 `packages/host/tests/worker-db-client-transport.test.ts` 钉住“拒绝”这条保证；
  变异（把护栏条件短路）后 3 条里恰好 2 条转红。
- 回退：单文件 revert（`worker-db-client.ts` + 5 个测试文件 + `vitest.config.ts`）。

### T01b 拓宽 `turn.completed` 的 `StopReason`（T01 的两个 refusal）

- 车道 L-HOST ／ 前置 T01 ／ 规模 ~120 行 + 协议
- 目标：让**工具轮**也有轮次终态。T01 落地的发射点对两种观测选择不发事件：
  - `ModelStopReason = 'tool_use'` 在事件 `StopReason` 里没有成员；
  - provider 未报 `usage`。
  而 `tool_use` 是**普通继续轮**——一次多轮工具执行只有最后一轮带终态，正是 17 §5 S2
  要求“turn 终态不得再被窄投影丢掉”的那个洞。
- 首个失败证据：`packages/agent-runtime/test/turn-terminal-event.test.ts` 新增
  “a tool-continuation turn also reports its ending” —— 今天计数为 0（T01 的 refusal 表已写明）。
- 步骤：`packages/agent-protocol/src/events/payloads.ts` 的 `StopReason` 加 `tool_use`；
  决定 `usage` 是否 optional（若 optional，消费端 `SurfaceModel` 合计逻辑必须区分
  “没报”和“为 0”）；同步 `required.ts` / registry 的描述。
- 回退：协议成员删除；不可与已落库的历史事件冲突（additive）。

### T14b 门禁接线、bundle 重建与超时卫生

- 车道 L-GATE ／ 前置 T14、T03 ／ 规模 ~40 行 + 一次 bundle 重建
- 目标：让 #277 落地的两道门禁**真的生效**。今天它们存在、能变红、但没有任何东西跑它们。
- 首个失败证据（三条，全部实测于 #277 的 worktree）：
  1. `architecture:client-closure` 与 `bundle:verify` **没有接进 CI**（PR 自己写明“Not in this PR”）；
  2. `bundle-verify` 在合并后的树上仍是 `STALE 24/1053`，其中 1 个输入**已删除**
     （`packages/agent-runtime/src/surface/surface-model.ts` 被 `943225cf` 移走），
     即 check-in 的 bundle 仍引用一个不存在的文件；
  3. `scripts/architecture/browser-closure-gate.test.ts` 的 live-tree 用例
     （`reaches across a package boundary`）**默认 10 s 超时**，实测单跑 9.9 s、
     两文件并行即超时。**注意**：#277 说明里把它写成 “pre-existing red”，
     但实测 master 上同一组合 27/27 通过、PR 分支同组合 1 失败 —— 它不是既有红，
     是这条用例本来就贴着超时线，被并行拖过界。
- 步骤：
  1. 给所有 walk 全仓的 live-tree 用例显式 `timeout: 30_000`（或降低单次 walk 成本），
     并记录实测耗时，避免再用默认值。
  2. 重建 `packages/host/bundle` 并随同一次提交（`npm run build:packages -- --target @duya/host`），
     让 `bundle:verify` 转绿；若决定不重建，必须在 ARCHITECTURE 写明“bundle 允许落后”并撤掉该门禁。
  3. 把两道门禁接入 CI 与 `gate-scan-guard` 注册；接入前先确认它们在当前树上各自的预期结论
     （`client-closure` 红属 T16，`bundle:verify` 应转绿）。
- 回退：workflow 与 script 行删除；bundle 提交单独 revert。

### T16 切断 `chat.ts` 到 runtime 的值导入边

- 车道 L-CLIENT ／ 前置 无（可与 T10 并行） ／ 规模 ~30 行
- 目标：让 G11-1 转绿。今天 `packages/cli/src/chat.ts` 经
  `host/local-host.ts:84` → `run-execution.ts` → `run-orchestrator.ts:69` 值导入
  `@duya/agent-runtime`；CLI 是一个**客户端**入口，它不该在自己的进程里装配执行引擎。
- 首个失败证据：`node scripts/architecture/client-closure-gate.mjs` →
  `G11-1 FAIL 1/2 client entries clean`，链与 `via` 已在输出里点名。
- 步骤（§12 的裁决覆盖上面两条：不用动态 `import()` 躲扫描）：
  1. 把 `runTuiCommand` 整体搬进 `packages/cli/src/tui-command.ts`——`duya tui` 本来就是
     **服务器引导**（它起一个 ephemeral Host），不是客户端入口；
  2. `chat.ts` 保留 `chatTui` / `chatInteractive` 等纯 HTTP client 侧代码，不再值导入
     `@duya/host/local-host`。
- 收尾：G11-1 转绿后，`client-closure-gate.test.ts` 里那条"live tree is RED"的断言
  **必须反转**（它在注释里已经写明：断言的是事实，不是判据；修好后它会红）。
- 回退：把 `runTuiCommand` 搬回 `chat.ts`。

**已落地**：`chat.ts` 闭包 **320 → 219**，`G11-1 PASS` exit 0。变异：把
`@duya/host/local-host` 值导入接回 `chat.ts` → 门禁 exit 1（闭包回到 318）、
gate 测试 **3 红 / 16 绿**（夹具组保持绿，正是分离该有的样子）；还原后 SHA-256
逐字节回到 `37D09674…C9CC`。本地对照组（把两个源文件 stash 回 HEAD）证明
`chat-tui-host-stop-continue` 的红与本卡无关。

### T05 修掉已失效的“引擎不发射 `turn.completed`”断言

- 车道 L-HOST ／ 前置 T01 ／ 规模 ~20 行
- 目标：把 `packages/host/tests/worker-product-runtime/native-event-authority-loss.test.ts`
  里的 `it('never mints turn.completed: the engine has no emit site for it')` 改成
  当前事实。它**今天仍然绿**，但只因 fixture 不发 `usage` 帧 → T01 的 refusal 生效 →
  计数确实为 0。断言与它叙述的理由已经分叉，属于 Plan 593/#265 一直在清的
  “绿着但什么也没证明”。
- 首个失败证据：不需要新红；证据是阅读：`lastMessage.current.usage === undefined`
  （`run-engine.ts:3239`）时 `#publishTurnCompleted` 提前返回。
- 步骤：把该用例改名为“a turn with no reported usage emits no terminal, and says why”，
  并把 T01 之前的“no emit site”叙述删除；若 T01b 落地使此路径也不再成立，
  直接改成断言 `turn.completed` 存在。
- 回退：纯测试文本，无生产影响。

---

## 6. Wave 1 — S2（共享状态）与 S3（能力）并行

两条车道可以同时开：L-CLIENT 做 T10→T11→T12，L-GATE 做 T13→T14→T15。
交汇点只有一个：T11 需要 T13 定的能力词汇（消费方向），所以 T13 必须在 T11 之前出文档级结论。

### T10 `RunSession`：client-core 的窄状态层

- 车道 L-CLIENT ／ 前置 无（可与 Wave 0 并行设计，T00 后合） ／ 规模 ~350 行
- 目标：把"用一个 SurfaceModel 消费一条 run 事件流"的**准入与订阅**做成可测的窄边界：
  run 身份（`runId` + `epoch`）、`(runId, seq)` 去重、断线重连游标、跨 run 隔离、稳定快照
  （`revision + 不可变快照`，供 React/TUI 订阅）。平台 IO（HTTP/SSE/文件）由注入 port 承担。
- 独占路径：`packages/client-core/src/session/run-session.ts`（新建）、
  `packages/client-core/test/run-session.test.ts`（新建）、`packages/client-core/src/index.ts`。
- 首个失败证据：`run-session.test.ts` 四条（先写成红）：
  1. 乱序到达（seq 3 先于 2）后，状态机不得把 3 当作已确认前缀；
  2. 重复投递同一 `(runId, seq)` → 快照 revision 不变；
  3. 跨 run 事件（不同 `runId`）不得写入当前 run 状态；
  4. 重连以 `cursor = 已确认 seq` 请求，缺失区间补回后快照与 live 一致。
- 步骤：定义 port（`fetchWindow(afterSeq)` / `subscribe()`）→ 实现 admission/去重/快照 →
  把 `SurfaceModel` 当**纯 reducer** 调用，不把它的可变对象直接交给订阅者。
- 验收命令：`npx vitest run packages/client-core/test/run-session.test.ts` + `npm run typecheck:client-core`
- 回退：新文件删除；无消费者前不影响生产。

### T11 正式 TUI 接 `RunSession`

- 车道 L-CLIENT ／ 前置 T10、T13 ／ 规模 ~250 行
- 目标：`packages/cli/src/chat.ts` 不再自己拼流：`HostEventStream` 的 native→legacy 投影
  降级为**视图适配**，状态由 `RunSession` 持有；`TranscriptModel` 只渲染，不再裁决状态。
- 独占路径：`packages/cli/src/chat.ts`、`packages/cli/src/tui/host-event-stream.ts`、
  `packages/cli/src/tui/TUIApp.ts`（接线处）、`packages/cli/src/tui/__tests__/*`。
- 首个失败证据：`packages/cli/src/tui/__tests__/run-session-view.test.ts`（新建）——
  喂同一段录制事件（含 `permission.requested` / `tool.timed_out` / `run.completed`），
  断言视图产出的块序列与共享状态一致；今天的 `TranscriptModel` 在
  `tool.timed_out` 与 `permission` 上会丢/错序（17 §5 S2 已列）。
- 步骤：先并存（`RunSession` 产状态、旧 reducer 仍渲染）→ 切渲染源 → 删旧 reducer 分支 →
  保持 611 的队列、取消、终端资源清理不动。
- 验收命令：`npx vitest run packages/cli/src/tui/__tests__` + `npm run typecheck:cli`
- 回退：切渲染源是单点开关，回退即恢复旧 reducer。

### T12 真 PTY 验收 + 删重复 reducer

- 车道 L-CLIENT ／ 前置 T11 ／ 规模 ~150 行（删多于加）
- 目标：`TranscriptModel` 里与 `SurfaceModel` 重复的裁决逻辑删除；用**真实 PTY** 验证输入、
  重连、取消、权限、窄窗口。
- 首个失败证据：`packages/cli/test/tui-pty.test.ts`（新建，真 `node-pty`）——在 80 列窄窗跑一轮
  含权限请求的工具调用；当前无此覆盖，先写必红（命令不存在 / 断言无输出）。
- 验收命令：`npx vitest run packages/cli/test/tui-pty.test.ts`
- 回退：删除的 reducer 在 git 里，单 commit revert。

### T13 能力三向普查与 owner 定案

- 车道 L-GATE ／ 前置 无 ／ 规模 文档 + 1 条断言
- 目标：把 `capabilities.ts`（执行侧）、`host-capabilities.ts`（提供侧）、
  `capability-negotiation.ts`（协商实现）以及 core 里的同名 `HostCapabilities` 逐项分类为
  **执行 / 消费 / 提供**，指定唯一协议 owner，并写明 `both` 的满足关系。
- 独占路径：`docs/exec-plans/active/610-architecture-series/20-capability-directions.md`（新建）、
  `packages/agent-protocol/src/capabilities.ts`（仅注释/类型，不改语义）。
- 首个失败证据：`packages/agent-protocol/test/capability-directions.test.ts`（新建）——
  断言三个词汇表里没有任何一个能力名同时出现在两个方向而没有显式 `both` 声明。
- 验收命令：`npx vitest run packages/agent-protocol/test/capability-directions.test.ts`
- 回退：删文档 + 测试。

### T14 门禁 G11-1：客户端入口闭包不含 Runtime

- 车道 L-GATE ／ 前置 T10（需一个真实客户端入口作扫描根） ／ 规模 ~200 行
- 目标：从 `packages/client-core/src/index.ts` 与 `packages/cli/src/chat.ts` 出发做值导入闭包，
  断言不含 `@duya/agent-runtime` / `@duya/agent-core`；`import type` 不误报；`walked > 0`。
- 独占路径：`scripts/architecture/client-closure-gate.mjs` + `.test.ts`
- 首个失败证据：在 `packages/client-core/src/index.ts` 加一行
  `import { RunEngineImpl } from '@duya/agent-runtime'` → 门禁必须红并指出该边。
- 变异证明：注入 → 红；`git checkout` 该文件 → 绿；再断 `walked > 0`（把入口改成空文件）→ 红
  （防"什么都没扫到"的假绿，610 §4 第 4 条）。
- 验收命令：`node scripts/architecture/client-closure-gate.mjs` + `npm run architecture:self-test`
- 回退：删脚本 + policy 一行。

### T15 绑定一个真实消费能力 + 降级闭环

- 车道 L-CLIENT ／ 前置 T13、T14 ／ 规模 ~200 行
- 目标：客户端在握手时声明消费能力，Host 返回**有效提供能力 + 版本 + 限制 + 不支持原因**；
  选一个真实界面能力贯通：CLI 的"工作区文件读取"。缺少能力必须可见（明确文本），
  且请求仍经服务端权限校验（advertised capability 不是授权凭据）。
- 独占路径：`packages/cli/src/**`（声明处）、`packages/host/src/http-server.ts`（握手响应）
  仅限新增字段；如需改 `run-api.ts` → 走 L-HOST 接缝请求。
- 首个失败证据：`packages/cli/test/capability-degradation.test.ts`（新建）——
  Host 声明不支持 `workspace.read` 时，CLI 必须打印明确原因并**不发起**该请求；今天无此路径。
- 验收命令：`npx vitest run packages/cli/test/capability-degradation.test.ts`
- 回退：字段与声明可选，缺失时退化为今天的"不做校验"。

---

## 7. Wave 2 — S4（独立 Host / Bot）与 S6（Desktop）

### T20 typed Host session service

- 车道 L-HOST ／ 前置 T00 ／ 规模 ~400 行
- 目标：把 `session:spawn{List,Get,Reply,Cancel,Rename,Archive}` 收敛为带类型的 Host 服务，
  由 `packages/host` 拥有；独立 Host（无 Electron）可完成创建/列出/追问/取消/改名。
- 首个失败证据：`packages/host/tests/session-service.test.ts`（新建，**不启动 Electron**）——
  今天落到 `unimplemented_domain`（`worker-db-bridge.ts` 无对应分支），断言必红。
- 回退：新服务旁挂，Desktop 仍可走旧桥。

### T21 Desktop bridge 退化为转发

- 车道 L-DESKTOP ＋ L-HOST 接缝 ／ 前置 T20 ／ 规模 ~200 行
- 目标：`apps/desktop/src/main/agents/db-bridge.ts:664/763/770/809` 只做转发与会话上下文注入，
  不再自己实现 spawn 语义。
- 首个失败证据：`apps/desktop/src/main/ipc/__tests__/session-spawn-bridge.test.ts`——
  桥必须调用 Host 服务而不是本地实现（mock 计数为 0 → 红）。

### T22 Bot 子任务持久化投递与对账

- 车道 L-HOST ／ 前置 T20 ／ 规模 ~400 行
- 目标：Bot 委派给子 session/run 的完成通知走**持久化 outbox**：去重、重启后对账可重投递不重放副作用；
  区分 `botId` / `sessionId` / `runId` / 委派任务身份；返回可追踪受理记录。
- 首个失败证据：`packages/host/tests/worker-product-runtime/bot-delegation-outbox.test.ts`——
  "进程重启后同一次委派只被应用一次"，今天的 `setImmediate + Promise.then` 无持久化，必红。
- 回退：outbox 表 additive；删除投递路径即回到内存投递（会丢，但不会错）。

### T23 Desktop `stream-session-manager` 首块接 client-core

- 车道 L-DESKTOP ／ 前置 T10、T14 ／ 规模 ~300 行
- 目标：先只切 **text / tool / turn** 三类事件的解释权给 `RunSession`；通知、窗口、rAF、
  preload 等平台职责留在原处。权限/模式/mailbox/compaction/usage/subagent 留到下一卡。
- 首个失败证据：`apps/desktop/src/renderer/lib/__tests__/stream-session-shared.test.ts`——
  同一段录制事件（含工具错序）在 Desktop 与 TUI 两侧产出一致的**业务状态**（呈现差异允许）。
- 验收：真实 Electron + Playwright 跑一轮含工具与审批的对话（vite 浏览器预览不算）。

---

## 8. Wave 3 — 骨架（开工前必须先由 owner 用当时代码细化）

| 卡 | 目标 | 前置 | 硬约束 |
| --- | --- | --- | --- |
| T30 Plugin App manifest | 在现有 manifest 上加兼容 App 声明（appId/入口/所需能力/状态 schema 版本），区分安装包 / App 定义 / App 实例 / session-run | T14、T15 | 一个 Plugin 可提供多个 App；状态不得只存在 React 组件 |
| T31 App Bridge | 受控桥：验证来源、实例身份、schema、方法、权限作用域；不发放 electronAPI / Host bearer / MCP 凭据 | T30 | 与 Agent 共用同一授权与审计路径，不做"App 专用免审批执行器" |
| T32 示例 Plugin | ≥2 个 App 入口、≥2 个隔离实例、共用其 MCP 能力；真实 Electron + Playwright 验收 | T31 | 演示数据必须标注 |
| T40 最小 Web | 连接独立 Host：选会话/发送/流式工具/审批/取消/刷新恢复 | T20、T23 | 部署与认证写清楚；不允许开放本机 bearer 或任意 CORS |
| T41 共享 UI 缝隙 | 当 Desktop 与 Web 都真消费一组组件后再抽；先跨目录复用 browser-safe 组件 | T40 | 共享展示层不依赖 client-core |
| T50 Remote Relay | 运行时出站注册、可撤销身份、心跳/存在状态；Relay 只转发被授权请求 | T14、T40 | 不得用 `@duya/gateway`（消息渠道）冒充 Relay |
| T51 远端审批 | 审批绑定 run/tool/input/expiry，服务端时钟与重复提交裁决 | T50 | 断线重连不得把过期/撤销变成允许 |
| T60 兼容层退出 | 逐个 shim 标消费者、退出条件、最晚切片；旧 Agent / 旧投影按消费者归零 | 各卡 | gate 出口 0 ≠ 状态 CLOSED；`self-test` 要过 |

---

## 9. 每波关口（可直接复制）

```bash
# 0) 任何卡开工前：树是否静止（有并发 session 时必做）
git status --short | head -30

# 1) 包级构建（缺这一步会得到假红：@duya/capabilities/mode-tools 找不到）
npm run build:packages

# 2) 类型门禁
npm run typecheck:all

# 3) 架构门禁（ratchet：只挡新增，不得加 baseline 指纹吞自己的边）
npm run architecture:check
npm run architecture:self-test        # 改动 gate / resolver 时必跑

# 4) 本卡具名测试（卡片"验收命令"字段）
npx vitest run <cards' test files>

# 5) 改动 bundle / module / packaging 边界时
npm run electron:build
```

**已知假红清单（先归因再动手）**

| 现象 | 真因 |
| --- | --- |
| `Cannot find module '@duya/capabilities/mode-tools'` | 陈旧 `packages/capabilities/dist` → `npm run build:packages` |
| `typecheck:all` 在 `@duya/agent` 处失败一串 TS2307 | 同上（build 顺序） |
| `architecture:check` 自造 finding（`vite-node not found`） | 缺 `node_modules` 的检出 → 先 `npm install` |
| 桌面/UI spec 报"element not found" | 端口 3000 上跑着**另一个检出**的 Vite（`reuseExistingServer: true`），先释放端口 |

---

## 10. 停止清单（别再做的事）

1. **不要**再写"现状审计"章节：§1 已实测，S0/S1 已完成部分不再重开。
2. **不要**把 S0/S1 的结论再推一遍：17-S0 第二版已推翻第一版三条（重建 vs 缺失、单一终态 writer、`it.fails` 语义）。从 §4.2 出发，不要从第一版出发。
3. **不要**给 `turn.completed` 之外的历史缺口写"必须为零"的断言（17 §6）。
4. **不要**在没有第二个真实 React 消费者之前抽共享 UI 包（17 §6、15 §A8）。
5. **不要**用 `--write` 把新引入的门禁违规写进 baseline；managed 包零容忍。
6. **不要**手写 worktree 清理；用 `scripts/remove-worktree.sh`。

---

## 11. 追踪表（唯一状态源；只有 `done` 需要 T02 校验）

| 卡 | 车道 | 前置 | 状态 | 证据（测试文件:用例 / commit） |
| --- | --- | --- | --- | --- |
| T00 落盘 S1 fence | L-HOST | — | **done** | `44123662` · 8 文件 / 55 测试全绿；`typecheck:all` exit 0（231 known / 0 new） |
| T01 `turn.completed` 生产者 | L-HOST | T00 | **done** | [#275](https://github.com/lava-chen/duya/pull/275) · merge `00ac7149` · `packages/agent-runtime/test/turn-terminal-event.test.ts:5/5`（变更前 0/5）· roundtrip 7/7 · `architecture` check 绿 |
| T01b 拓宽 `turn.completed` 的 `StopReason` | L-HOST | T01 | **done（已落 master）** | [#287](https://github.com/lava-chen/duya/pull/287) · merge `970f308f`（`ddd499e9`/`05ed8366` 协议+测试 → `71053e45` 消费端 → `5ad8c25f` bundle）· `packages/agent-runtime/test/turn-terminal-event.test.ts`: "a tool-continuation turn also reports its ending" · `packages/client-core/test/surface-model.test.ts`: "does not let a turn that reported no usage erase the run-level reading" · 协议 `StopReason` 加 `tool_use`、`usage` 转 optional，引擎只在 provider 真报了 usage 时才带上它 · 消费端 `SurfaceModel` **两处**都区分"没报"与"为 0"：turn 级 `event.usage ?? null`、run 级 `if (event.usage !== undefined)` 才覆盖（run 级原先漏改，`typecheck` 报 TS2322 才暴露）· 107/107 · 变异 ① `tool_use:'tool_use'`→`null` → 1 红/5 绿 ② run 级守卫→`event.usage ?? null` → 1 红/68 绿（红的正是 run 级那一条），两次还原哈希均逐字节回原值 · **门禁代价**：改这 4 个文件会让 `bundle:verify` 转 `STALE 4/1057`，需 `node scripts/build-agent-bundle.mjs` 后提交 `packages/host/bundle`（门禁自印的修法 `build:packages --target @duya/host` 无效，该 target 的 build 只是 `tsc -b`，不产出 bundle）· **仍未做**：模型流中途被取消/失败的轮不发射终态（有意保留） |
| T02 计划↔代码同步 | L-GATE | — | **done（自带反空洞条款）** | `scripts/architecture/plan-sync-check.test.ts`: "reports zero names when no done row carries one" · 12/12 · 接进 **architecture** job（`plan:sync`）· 实测 `9 done rows · 8 file refs · 4 test-name refs` → OK；变异：把 T16 的用例名换成不存在的一条 → `T16 … → client-closure-gate.test.ts: no test matching "a test that was never written"`，exit 1，还原 SHA-256 逐字节回 `632B7257…1900` · **卡片原本预设的失败证据今天不成立**：追踪表当时 `0 test-name refs`，一个只认「文件:用例名」的检查器会空洞全绿，所以脚本把「done 行存在但零用例名」判为 VACUOUS（`--strict` 下 exit 1） |
| T03 bundle 策略 | L-GATE | — | **done** | [#277](https://github.com/lava-chen/duya/pull/277) · merge `1a3412e3` · `scripts/architecture/bundle-verify.test.ts` 16/16 · 决策=tracked + git 输入比对（非字节比对，esbuild 产物不可复现） |
| T04 修 CI test 门禁的 summary 解析 | L-GATE | — | **done（追踪表欠账，已补）** | [`a3aab276 fix(ci): fail the summary guard when the test log is missing`](https://github.com/lava-chen/duya/commit/a3aab276) · 守卫 `unread` 中性 / `no-log` 退出 1 |
| T04b 让任何测试都不可能把普通对象送进 pool 的 `process.send` | L-GATE | T04 | **done（完成判据已实测）** | #279 merge `6ff661c3`（`50485c02`）· 判据是"CI 第一次同时打出两行汇总"，2026-10-18 在 run `39100448943` job `117595462000` 实测两行俱在：`Test Files 94 failed \| 1262 passed \| 9 skipped (1365)` 与 `Tests 338 failed \| 15112 passed \| 112 skipped (15562)`；守卫另报 `test files collected: 1365` / `tests collected: 15562` |
| T05 修掉 `native-event-authority-loss` 里已失效的断言 | L-HOST | T01 | **done** | `packages/host/tests/worker-product-runtime/native-event-authority-loss.test.ts`: "emits no turn.completed when the provider reports no usage" 6/6 · T01 落地后 `run-engine.ts:894` 已调 `#publishTurnCompleted`（定义在 `:2801`），"引擎没有发射点"不再是事实；计数仍为 0 是因为**本夹具不发 usage**，属 T01 的两条 refusal 之一 |
| T10 `RunSession` | L-CLIENT | — | **done（主体随 #280 落库，第 4 条判据本轮补齐）** | `packages/client-core/src/session/run-session.ts` 准入/去重/跨 run 隔离/深冻结快照/`acceptWindow` 重连游标 · 四条判据逐一落在用例上：乱序→`run-session.test.ts` "rebuilds in sequence order when replay supplies unseen older events"、去重→"keeps duplicate admission idempotent and preserves the stable snapshot"、跨 run→"rejects envelopes from another run or session without changing state"、重连→**本轮新增** `packages/client-core/test/run-session.test.ts`: "reconnects with the confirmed cursor and lands on the projection live delivery would have" · 该用例用**同一段 transcript 走两条投递路径**（live 连投 vs 断线后以 `lastAcceptedSeq` 为 cursor 补回）比对投影相等，只有 live 侧是对照组；窗口故意稀疏（seq 1→5）以区分「最高已确认 seq」与「收到过几个事件」两种读法 · client-core 102/102（run-session 9 + 对抗 24 + surface-model 69）· 变异：快照游标 `lastAcceptedSeq`→`#seen.size` → **11 红**（含新用例），还原 SHA-256 逐字节回 `397136BB…5CD3` · `tsc -p packages/client-core --noEmit` exit 0 · **尚未做**：注入式 IO port（`fetchWindow(afterSeq)`）不存在——`RunSession` 只管准入与快照，流的抓取在 T11 的 `HostEventStream` 里 |
| T11 TUI 接共享状态 | L-CLIENT | T10、T13 | **done（唯一步骤是"有意不翻"，不是遗漏；删 reducer 那步已由审计结清）** | 新建 `packages/cli/src/tui/run-session-view.ts`：把 `RunSession` 快照投影成 TUI 帧的**视图适配器**（纯函数、输出增量）· `chat.ts` 现在用 `RunSession` 持有 run 状态并推送适配器补上的帧，旧 `HostEventStream` 帧仍然照旧推送（并存，非替换）· `TranscriptModel` 新增 `tool_timed_out`（标记超时但**不编造 result**）与 `permission_resolved`（落成 transcript notice 行）两个分支，`ToolBlock` 加 `timedOut` · `packages/cli/src/tui/__tests__/run-session-view.test.ts`: "emits a frame for each fact the legacy projector dropped" · 4/4 · **对照组**写在同文件第一条：同一批事件过旧投影器时 `tool.timed_out` 与 `permission.resolved` 都返回 `null`，否则"新路径覆盖了它"和"它根本没丢"分不开 · TUI 目录 579/579 · `tsc -p packages/cli --noEmit` exit 0 · 变异：去掉去重行 → 2 红/2 绿（红的正是"幂等"与"只发一次"两条），还原 SHA-256 逐字节回 `34B07599…C46D` · **仍未做**：②切渲染源 ③删旧 reducer 分支 · 权限决议目前只进 transcript notice，**没有**就地关掉 picker（picker 需要 overlay 侧按 `requestId` 记账，属第②步）· `packages/cli/tsconfig.json` 加 `@duya/client-core` 的 `paths`（沿用既有 `@duya/host` 写法），此前 cli 的跨包类型只能解析到 junction 指向的陈旧 dist · **第二步（本轮）**：`run-session-view.ts` 加 `projectRunSessionFrames(snapshot)`——按 **timeline 顺序**（不是实体表顺序）给出整段 run 派生块序列，可 `clear()` 后重放 · 交叉比对用例证明切换渲染源不是回归：`packages/cli/src/tui/__tests__/run-session-view.test.ts`: "produces the same block sequence, plus exactly the two facts legacy drops"（把新投影按旧投影器能处理的帧类型过滤后，与旧 reducer 逐块相等；差的恰好只有那两条）· 顺序用例 "places a tool row where the run sequence put it, not after every message" · 6/6 · TUI 581/581 · 变异：把 timeline 排序改成"工具事件排最后"（最朴素的错误实现）→ **2 红**，还原 SHA-256 逐字节回 `86DB6C84…926C` · **第二步剩余**：渲染源开关本身未接。已查实的约束——**用户输入块不在快照里**（快照 `messages` 只有 assistant 侧，用户块来自本地输入），所以开关**不能整体替换 transcript**，只能把 run 派生段就地拼接；`TranscriptModel` 加 `replayRunSegment(frames)`：保留最后一个 user 块及之前的本地输入前缀，重建其后的 run 派生段（帧仍走 `apply`，block id 继续递增，相关性映射随段重建）· 接缝用例 "keeps the local user blocks and rebuilds only the run-derived segment" 与 "drops a stale tool row rather than leaving it beside the replay" · 8/8 · TUI 583/583 · 变异：把 splice 改成整体替换（`slice(0,0)`）→ **2 红**，还原 SHA-256 逐字节回 `AE59C9D6…CD83` · **为什么开关还没翻**：今天的 `chat.ts` 只有单趟流，没有重连路径，而每来一个事件就全量重放投影在流式期间是 O(n²)。开关的**接缝已就位并有测试**，等重连落地再翻是一行改动；这个取舍记在这里，免得被读成"忘了" · **第三步仍未做**：删旧 reducer 分支——但审计已查清这一步没有可机械删除的对象（见 T12 行的 ③④：除第一步合并掉的那一处重复，其余是刻意产品裁决），所以剩下的实际动作只有 owner 对三条决策事实的取舍裁定，已在 T12 行落地 |
| T12 PTY 验收 + 删 reducer | L-CLIENT | T11 | **done（两项主体都落地：PTY 验收 #300，删重复裁决由审计结清 + owner 裁定落地 #298）** | **卡片字面要求当前不可行的原因已查实**：`duya tui` 一直 `startLocalHost()` 起真 Host + 真 worker，**没有任何注入点**，所以"跑一轮含权限请求的工具调用"在无凭证的 CI 里跑不动（`node-pty` 本身是根 devDependency，已装）· **本轮补上接缝**：`attachedHostFromEnv`（`packages/cli/src/tui-command.ts`）允许附着到已在跑的 Host，**必须 `DUYA_TUI_ATTACH=1` 且 `DUYA_TUI_HOST_ORIGIN` 同时存在才生效**——只凭 origin 就静默改变行为，会让用户以为起的是新 Host，而唯一症状是"会话不在预期位置" · `packages/cli/src/__tests__/tui-host-attach.test.ts`: "starts its own Host when nothing is set" · 5/5 · 变异：去掉 opt-in 守卫 → 2 红/3 绿（红的正是"什么都没设置"与"非 1 的 opt-in"两条），还原 SHA-256 逐字节回 `6144D1D7…8B53` · **仍未做**：①真 PTY 测试本身（现在有了接缝，可对受控的假 Host 写，但尚未写）②`TranscriptModel` 里与 `SurfaceModel` 重复的裁决逻辑删除——它与 T11 第三步是同一处代码 · **③ 本轮把「重复」这件事查清了，它不是一刀切**：审计了 `TranscriptModel.apply` 的全部 41 个分支。约 15 条做「这是不是 transcript 内容」的裁决（`status` / `token_usage` / `tool_use_delta` / `turn_start` / `retry` / `mode_changed` / `goal_updated` / `tool_progress` / `tool_group_progress` / `agent_progress` / `compact:*` / `done`），`SurfaceModel` **确实**都持有对应的结构化事实——但其中不少是**刻意的产品决定而非重复**：`status` 分支的注释明写「落成 notice 会变成读者永远滑过去的永久 transcript 行」，`tool_use_delta` 明写「播报前已经有名字和参数，渲染 JSON 片段是噪声」。所以「删掉与 SurfaceModel 重复的裁决」必须逐条判断"这份事实该不该有 transcript 行"，而这是产品判断不是机械重构——**未经确认就删，等于删掉决定**。真正的重复只有一类：**同一事实被裁决两次**（帧判一次、快照再判一次），第一步的适配器已经把它们合并了。 · **④ owner 已裁定，本轮落第一批**：三类事实要有持久 transcript 行——`turn.retry_scheduled` / `assistant.mode_changed` / `assistant.goal_updated`；其余保持 chrome-only 不动。实现分两层：`run-session-view.ts` 加 `projectRunSessionDecisionFrames` + `advanceRunSessionView`（`retriedTurns` / `statedMode` / `statedGoal`），`blocks.ts` 三条分支从 `{kind:'none'}` 改为 `addNotice`（retry 显 `attempt n/max`、mode 带来源、objective 裁到 80 列）· **决策帧从共享状态读，不从事件读**：`assistant.mode_changed` 与 `turn.retry_scheduled` 在协议注册表里都是 **volatile**，重连窗口不会重投，事实在 SurfaceModel 里才活得下来 · `packages/cli/src/tui/__tests__/decision-lines.test.ts` 9 条（含三层各自的对照组）· CLI 849 测 / 843 过 / 6 失败（失败数与基线相同，6 条全是既有红测）· **测试当场抓到我自己写的一个 bug**：空 `retry` 帧渲染出 `Retrying (attempt 0)`——`attempt` 是协议必填且 1-based，补 `attempt < 1` 守卫；该守卫同时是既有 `tui-blocks.test.ts` "reports progress ticks as nothing visible" 里那三条的存活条件（删掉它两条一起红），已把该用例拆成 chrome 与"无字段的决策帧"两段 · 变异 ① mode 改从 `timeline` 读（即"事件到了才说"）→ **1 红**，红的正是重连那条；② `advanceRunSessionView` 不锁 `statedMode` → **4 红**；③ 删 `attempt < 1` 守卫 → **2 红**；④ **重放投影器原本会静默吞掉这三类**（同一个快照两条路径不一致），补齐后变异 `statedMode = true`→`false`（重放每次变更都播报终值）→ **首跑 17 全绿、这条守卫当时没有牙齿**：夹具只切一次模式，"播报一次"与"每次都播报"产出相同。改成显式钉住**分歧方向**（两次切模式：delta 两条、重放一条，因为快照只留终值）后同一变异 → **1 红**；还原 SHA-256 逐字节回 `D78375C2…75FE`、`04934CA8…F5D0` 与 `7EF0924A…C068` · **由此得到一条翻开关前必须知道的事**：快照只保留终值，所以重连重放**重建不出中间的 mode/goal 变更**，翻渲染源会少掉那些行（不是重复，是缺失）· `tsc -p packages/cli --noEmit` exit 0 · `G11-1 PASS` 0/2 · `bundle-verify` exit 0（这两个文件不在 bundle 输入集内，实测确认）· `architecture:check` / `self-test` / `plan:sync --strict` exit 0 · **②删重复裁决**这条已被审计结清**：除了第一步合并掉的那一处，剩下的是 12 条刻意的产品裁决，不是重复；本轮是按 owner 裁定把其中三条**反过来**变成持久行，不是删除。**T12 剩下的唯一未做项是真 PTY 验收测试** · **⑤ 本轮补上真 PTY 验收**：`packages/cli/test/tui-pty.test.ts` —— 真 `node-pty`、80 列窄窗、跑一轮**含权限请求**的工具调用，跑 `y` 与 `n` 两个方向 · 用的是 `packages/cli/bundle/cli.cjs`（发布产物，自包含）：`packages/cli/dist` 的工作区依赖会经 `node_modules` junction 解析回**共享检出**，等于在测别人的 `@duya/host` · Host 仍是真 `startLocalHost` + 假 worker，假 worker 只在收到 Host 回传的 `permission:resolve` 之后才发最终文本，所以屏幕上的 `worker saw allow_once` 不是"画出了一行"，而是**这个按键变成了这条 HTTP 请求并抵达 worker** · **`beforeAll` 按需构建**：bundle 比它依赖的源码旧才 `npm run build:cli-bundle` · 2/2 · 变异 ① `chat.ts` 的 `status` 写死 `'allow'` → **拒绝那条红、批准那条仍绿**（先试过改 `decision` 字段，**变异不生效**——Host 回传给 worker 的决议取自 `status`，不是 `decision`，这正是「变异不生效要先查传导链而不是怀疑守卫」）；② `TUIApp.ts` 的 `return:` 不再提交 → **2 红**，证明测试走的是真实提交路径 · 还原 SHA-256 逐字节回 `9053F2F0…51D0` 与 `4D2FDD77…25B8`，重建 bundle 后回到 2/2 · CLI 853 测 / 847 过 / 6 失败（失败数与基线相同，6 条仍是既有红测）· **读屏方法本身就是第一道发现**：composer 不写空格，它画 `run` → `ESC[1C` 光标右移 → `the` → 再右移 → `thing`，空格在屏幕上有、在字节流里没有，所以"剥掉转义再找 `run the thing`"永远匹配不到用户明明看得见的提示词。`readScreen` 因此把 `ESC[nC` 还原成 n 个空格 · **实测踩到的真实缺陷（未修，属本卡范围外）**：① 在 TUI 完成启动前打字，**Enter 会被吞掉**——composer 留着文本、状态仍是 Ready、run 没启动；等屏幕安静（连续 300ms 不变）后再发 Enter 就正常，`Ctrl+C` 绑定在同期是好的，所以是 Enter 这条路径，不是 `program.key` 通道 ② 文本与 `\r` 在**同一次写入**里时 Enter 同样被吞（ConPTY 合并突发）。两条都指向"启动期/突发期的键被丢"，值得单独开一张卡查 `bindKeys` 与启动期的重入 · **顺带修掉的一个本地陷阱**：`npm run build:packages`（`build:cli` 会调）会把 `packages/capabilities/src/ModuleTool/inline-content.ts` 改写成 LF，`bundle:verify` 哈希工作区字节，于是**内容零差异**也让 required 的 `architecture` job 转红（STALE 1/1057）；把那一个文件转回 CRLF 即回到 exit 0 |
| T13 能力三向普查 | L-GATE | — | **done** | `packages/agent-protocol/test/capability-directions.test.ts`: "refuses a second direction on a name that is not declared both" · 13/13 · **31 个名字**（执行 3 / 提供 22 / 消费 6），三表**字面重叠 0**，消费侧由 `MESSAGE_GATES` 现推（6 个门 ↔ `PROTOCOL_CAPABILITIES` 6 名）· 首次红因是真实的 31 个未分类名字，不是文件缺失 · 变异 ① `checkpoint_repository` 加第二方向（未写 `both`）→ **1 红/12 绿**（红的正是那条）；② 删掉仍在代码中导出的 `orb` 行 → **3 红/10 绿**，且计数下限 `30 < 31` 同时触发；还原 SHA-256 `1356777B…0AF` 逐字节回原值 · 文档自带的门禁在写完前就抓到了我自己写的裸文件名引用（`host-capabilities.ts:133` 无法解析）→ 已改全路径 · **发现 3 对"换名"重叠，按名字做的门禁看不见**：① `tool_preview`↔`tool_call_preview`（执行侧 `capabilities.ts:323` 与消费侧 `capability-negotiation.ts:185` 读同一字段但判据不同，**对同一 runtime 可给出相反答案**）；② `checkpoint_repository`↔`checkpoint_resume`（消费侧只问事件可不可发，**比执行侧弱，可发假承诺**）；③ `permission_coordinator`↔`permission_expiry`（**同一谓词两个名字**，三对里唯一零风险可合并）· **均为未改的语义问题**，留给 owner，见 [20 §4/§5](./20-capability-directions.md) · `capabilities.ts` 仅加注释 |
| T14 G11-1 客户端闭包门禁 | L-GATE | T10 | **done（门禁在，树是红的）** | #277 · `client-closure-gate.test.ts` 18/18 · 实测 `client-core=2` 干净 / `cli/chat.ts=315` 红，链 `chat.ts→host/local-host.ts→run-execution.ts→run-orchestrator.ts→agent-runtime` |
| T14b 门禁接线 + bundle 重建 + 超时卫生 | L-GATE | T14、T03 | **done（三条失败证据里两条已过期）** | ① 两道门禁接进 **architecture** job（required 那个 job，`test` 从 265 行才开始），不是无人跑的脚本 · ② `bundle:verify` 实测已 `FRESH 0/1057`，bundle 随 #280 的 `1749a783` 重建过，**本卡这条"证据"早已过期**，无需重建 · ③ 两个 live-tree describe 加显式 `timeout: 30_000`，实测 2 文件 27 用例 17.7s（测试 4.9s / collect 16.6s）· 变异：接回引擎边 → 门禁 exit 1（闭包 219→318），还原 SHA-256 逐字节回 `37D09674…C9CC` · `scripts/architecture/browser-closure-gate.test.ts`: "is green, and reports the scope the verdict is about" · `scripts/architecture/client-closure-gate.test.ts`: "measures both roots, named, one report each" |
| T16 切断 `chat.ts` 到 runtime 的值导入边 | L-CLIENT | T10 或独立 | **done** | `runTuiCommand` 搬进新建的 `packages/cli/src/tui-command.ts` · `G11-1 PASS` exit 0 · `chat.ts` 闭包 320→219 · 变异接回值导入 → 门禁 exit 1 + gate 测试 3 红/16 绿 · `client-closure-gate.test.ts` 19/19 · `architecture:self-test` exit 0 · `tsc -p packages/cli` exit 0 · `scripts/architecture/client-closure-gate.test.ts`: "reports the CLI entry CLEAN — the four-hop chain is severed at the source" |
| T15 消费能力 + 降级 | L-CLIENT | T13、T14 | **done（三项跨车道欠账本轮由 owner 授权后一并清掉）** | `packages/cli/test/capability-degradation.test.ts`: "refuses to read a workspace file, and says why, when the Host does not provide it" · : "treats an advertised capability as a hint, not a credential" · : "has no aliased capability pair on the provide axis, which is what makes a name gate complete here" · 7/7 · 往返：CLI 声明 **3/6** 消费能力（`tool_call_preview` / `tool_outcome_detail` / `usage_accounting`，按 `tui/host-event-stream.ts` 实际投影的事件量出来的，不声明 `permission_expiry` / `replay` / `checkpoint_resume`——那是**承诺没人兑现**），Host 回 **2/22** 提供能力（`session_persistence` + `workspace_filesystem`）+ 版本 + `limits`（`maxFileBytes` 33554432 / `absentCapabilityPolicy: error`）+ **20 条**不支持原因 · 门禁**按名字**比较，并断言今天提供侧**没有**别名对（T13 §4 三对全是 execute↔consume），该断言会在别名落到提供侧时转红 · **零声明不是全许可**：`provides` 缺失 → 拒绝并说明，测试单列一条 · 变异 ① Host 谎报支持 → **1 红/6 绿**（红的正是拒绝那条；计数钉住的那条**没**抓到，因为它的 Host 本来就注册了该 API——如实记录）；② 删掉 CLI 门禁 → **2 红/5 绿**；还原后 SHA-256 逐字节回 `8CEB3D36…EF72` 与 `52DE46C5…F8EB` · `vitest.config.ts` 补 `packages/cli/test/**/*.test.ts`（否则无人收集，`check-test-coverage` 判为 orphan） · **仍未做**：①**没有任何生产代码调用 `requestWorkspaceFileRead`**——自然的第一个消费者是 TUI 的 `/read-file`，而 `packages/cli/src/tui/**` 本轮归别人所有，未动；②`consumedBy` 回显已落地但 **runtime 侧尚未消费**，即"客户端说能消费什么"目前还没有改变任何事件下发行为；③"读工作区文件"借用现存的 `POST /v1/local/rollouts/import`，专用的 `/v1/workspace/file` 属 L-HOST 接缝；④`HOST_VERSION` 是照抄 `packages/host/package.json` 的字面量（打包后 `package.json` 查找不可靠） · **生产调用点（本轮补）**：`/capabilities` 斜杠命令（`packages/cli/src/tui/slash/capabilities.ts` + 注册进 `registry.ts`）把协商结果与**拒绝原因**直接打印给用户，`packages/cli/src/tui/__tests__/capabilities-command.test.ts`: "states the Host reason when the capability is refused" · 4/4，含对照组"同一个命令在提供该能力时报 available"，否则"打印了拒绝"可能只是夹具性质 · 变异：拒绝分支改印 `available` → 1 红/3 绿，还原 SHA-256 逐字节回 `125E9103…A19F` · CLI 595/595 · `tsc -p packages/cli` exit 0 · **接缝请求（L-HOST）**：卡片要的"贯通一个真实界面能力"需要一个真的读文件端点。`requestWorkspaceFileRead` 目前骑在 `POST /v1/local/rollouts/import` 上，那不是文件读；本轮**没有**把它包装成 `/read-file`，那等于捏造一个 Host 没有的端点。因此 `/capabilities` 交付的是用户能据此行动的那一半（协商 + 拒绝原因），另一半等 L-HOST 加端点 · **⑥ owner 授权后接 L-HOST，三项欠账一次清掉（本轮）**：① **专用端点真的加上了**——`POST /v1/workspace/file`，由 `workspaceFileApi` 提供，`registeredHostCapabilities` 改成「rollout 通道**或**文件通道任一存在即声明 `workspace_filesystem`」；`requestWorkspaceFileRead` 不再骑 `POST /v1/local/rollouts/import`（那条会解析 transcript 并恢复会话，**它不是文件读**，而且收的是客户端给的**绝对路径**）。新请求体是 `{workspaceId, relativePath}`——**客户端根本无法说出工作区外的路径**，`..`/盘符/绝对路径在这个 API 里没有拼法，containment 是结构性的而不是一层要人写对的过滤。`HostWorkspaceFileReadInput/Result` 进 `session-api.ts` ② **真实消费点**：`/read-file` 斜杠命令（`packages/cli/src/tui/slash/read-file.ts` + catalog 注册），Workspace 取自 `ctx.session.workspace` 而不是让用户再报一次；`/capabilities` 的注释同步改成「它是诊断，`/read-file` 才是消费」 ③ `HOST_VERSION` 字面量**保留**（打包后 `package.json` 查找不可靠，这点原判断正确），改为加守卫测试 `packages/host/tests/host-version-literal.test.ts` 钉住字面量与 manifest 不一致即红——两处不一致时两边会一起自信地撒谎，没有任何系统会察觉 · 测试：`packages/host/tests/workspace-file-read-http.test.ts` 8/8（含**symlink 越界**这一条路径层守卫看不见的情形；目录被拒而不是读成空文件；客户端可少要不可多要；未认证 403；能力**派生**于注册的 API，所以不注册就没有该名字）、`read-file-command.test.ts` 4/4（拒绝时**零次** Host 调用）、`capability-degradation.test.ts` 7/7（迁到新端点）、`host-version-literal` 1/1 · 变异 ① 去掉 symlink 越界检查 → **1 红**（正是那条）；② 能力不再从文件 API 派生 → **4 红**（Host 侧 1 + CLI 侧 3）；③ 门禁不再拦住已拒绝的读 → **3 红**；还原 SHA-256 逐字节回 `7F4497E8…6228`、`AED0BDDEF…4DE2`、`1451B62F…7BF3F` · `tsc -p packages/{agent-protocol,host,command-catalog,cli}` 全 exit 0 · `G11-1 PASS 0/2` · `architecture:check` / `self-test` / `plan:sync --strict` 全 exit 0 · **bundle 已重建**（4 个输入文件在 worker bundle 的 metafile 里，必须与源同一个提交）· ④ `consumedBy` 仍**未被 runtime 消费**——这一项本轮**没有**关闭，且它确实跨车道（runtime 侧）：客户端声明能消费什么，目前还没有改变任何事件下发行为。需要单开一张卡。· **踩到的两个本地陷阱**：① `packages/cli/tsconfig.json` 的 `paths` 原来只映射 `@duya/host` 与 `@duya/client-core`，**没有映射 `@duya/agent-protocol*`**，所以跨包新增的协议类型在本地解析到共享检出的陈旧 dist，报错长得像"类型不存在"；已按既有写法补三条映射 ② worktree 里 `packages/host/node_modules` 建 junction 时**不要给全部 @duya 依赖都建**——`@duya/capabilities` 那条会让 `declaration: true` 推出不可命名的类型路径（TS2742）；只建需要的那一条（`agent-protocol`）即可 |
| T20 Host session service | L-HOST | T00 | todo | — |
| T21 Desktop bridge 转发 | L-DESKTOP | T20 | todo | — |
| T22 Bot 投递对账 | L-HOST | T20 | todo | — |
| T23 Desktop 首块接共享状态 | L-DESKTOP | T10、T14 | todo | — |
| T30 App manifest | L-APP | T14、T15 | implemented / unmerged | 2026-10-19：合同、独占路径与证据见 [22](22-wave3-dispatch.md)；共享 schema + 真 manifest parser + 已安装列表投影；不含 App 实例 |
| T31 App Bridge | L-APP | T30 | partial / unmerged | 22 的 T31a 只实现绑定校验和 Runtime MCP 审批执行内核；待实例 store、worker RPC、iframe 生产调用 |
| T40 最小 Web | L-APP | T20、T23 | partial / unmerged | 22 的 T40a 交付 loopback 同源 BFF；浏览器 UI、RunSession 消费和真刷新恢复待验收，T23 依赖不变 |
| T32、T41、T50、T60 | 见 §8 | — | skeleton | 本轮未实现 |
