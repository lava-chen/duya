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
| G1 | `turn.completed` **零生产发射点**（引擎从不发射，仅协议注册表/投影器/测试合成存在） | `packages/agent-runtime/src/engine/run-engine.ts` | T01 |
| G2 | 正式 TUI 消费原生事件后**再投影成 LegacyFrame**，`TranscriptModel` 另有 reducer | `packages/cli/src/tui/host-event-stream.ts:24`、`packages/cli/src/chat.ts:37` | T10–T12 |
| G3 | `client-core` **零生产消费者**；唯一 `SurfaceModel` 使用点在退役包内 | `packages/agent/src/cli/ui/surface-view.ts:206` | T10–T12 |
| G4 | 能力三向（执行/消费/提供）未绑定，无客户端反向门禁 G11 | `packages/agent-protocol/src/{capabilities,host-capabilities}.ts`、`packages/agent-core/src/capability-negotiation.ts`；`scripts/architecture/` 无对应 gate | T13–T15 |
| G5 | `session:spawn*` 只在 Desktop；独立 Host 落 `unimplemented_domain` | `apps/desktop/src/main/agents/db-bridge.ts:664/763/770/809` vs `packages/host/src/worker-db-bridge.ts` | T20–T21 |
| G6 | Desktop 自持流状态（回调 + store + Electron 耦合） | `apps/desktop/src/renderer/lib/stream-session-manager.ts` | T23 |
| G7 | `apps/web` 不存在 | — | Wave 3 |
| G8 | `packages/host/bundle/*` **tracked 但比源码旧**（在途未提交重建） | `packages/host/bundle/` | T03 |
| G9 | 旧 Agent 退役 gate 仍 OPEN | `scripts/architecture/agent-retirement-gate.mjs` | Wave 3 |

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
| T01 `turn.completed` 生产者 | L-HOST | T00 | **next** | — |
| T02 计划↔代码同步 | L-GATE | — | todo | — |
| T03 bundle 策略 | L-GATE | — | todo | — |
| T10 `RunSession` | L-CLIENT | — | todo | — |
| T11 TUI 接共享状态 | L-CLIENT | T10、T13 | todo | — |
| T12 PTY 验收 + 删 reducer | L-CLIENT | T11 | todo | — |
| T13 能力三向普查 | L-GATE | — | todo | — |
| T14 G11-1 客户端闭包门禁 | L-GATE | T10 | todo | — |
| T15 消费能力 + 降级 | L-CLIENT | T13、T14 | todo | — |
| T20 Host session service | L-HOST | T00 | todo | — |
| T21 Desktop bridge 转发 | L-DESKTOP | T20 | todo | — |
| T22 Bot 投递对账 | L-HOST | T20 | todo | — |
| T23 Desktop 首块接共享状态 | L-DESKTOP | T10、T14 | todo | — |
| T30–T60 | 见 §8 | — | skeleton | 开工前必须细化 |
