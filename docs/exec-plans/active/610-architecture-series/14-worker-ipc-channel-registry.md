# 14 — Worker IPC 通道协议注册表

> **状态**：Proposed（2026-10-16）
> **归属**：[610 架构收口系列](./README.md)
> **依赖**：无。可独立推进，但落地后是 610 后续切片的安全网，建议排在 A 系列之后、Host 抽取之前。

## 0. 一句话

新增一条 worker IPC 通道，今天要在 **6 个文件、7 类站点、9 处物理落点**里手工各改一遍，而其中一处（`router.ts`）是同一条 `if` 的三份复制品。漏改任何一处，故障形态是 `UNKNOWN_ACTION` 或 15s/30s 静默超时——没有编译期错误，没有门禁。

## 1. 实测普查（2026-10-16，工作树 = `c3a1ed41` + 并行未提交改动）

样本通道选 `computer-use:cua`：它是 575 新增、横跨 worker → Main → Agent Server 三层的通道，站点最全，因此最能代表"一条通道的完整代价"。

| # | 站点 | 文件:行 | 角色 |
| --- | --- | --- | --- |
| 1 | worker 出站 | `packages/host/src/worker-process-entry.ts:906-935` + `:639/684/723/763/808/853/898/969` | **worker 出站**：`toolIpcRequest(channel, payload)` 是手工 if-chain，每个通道再接一个 per-channel helper（`computerUseIpcRequest` / `computerCuaIpcRequest` …），未列通道兜底落到 `conductorIpcRequest` |
| 2 | worker 入站 | `packages/host/src/worker-process-entry.ts:3368-3584` | **worker 入站**：`case '<channel>:response'` 解包信封 + 兑现 `pendingIpcRequests` |
| 3 | Host 丢弃白名单 | `packages/host/src/worker-manager.ts:376` | **Main 侧丢弃/转发**（与 `conductor:executor:rpc` 等并列的一条长 `\|\|`） |
| 4 | Main 执行路由 | `apps/desktop/src/main/agents/agent-server-lifecycle.ts:183/230/267/305/339/384/435/481` | **Main 执行侧路由**（真正做事、并回写 `<channel>:response` 的分支；每通道一个独立块） |
| 5 | Agent Server 转发 | `apps/desktop/src/main/agents/server/router.ts:1044-1088 / 2536-2579 / 3712-3748` | **Agent Server 转发** —— 同一条件重复 **三处**（"全变体"） |
| 6 | 跨 agent 转发 | `apps/desktop/src/main/agents/server/interagent-router.ts:288-310` | 子 agent 场景转发 + `workerDbRequests` 登记 |
| 7 | 响应回传 | `apps/desktop/src/main/agents/server/index.ts:69-166` | **响应回传 worker**（`workerDbRequests` 查表 → `workerChild.send`） |

**一个通道 = 6 个文件、7 类站点、9 处物理落点**（站点 5 内占 3 处）。落点数按通道有差：`computer-use:cua` 满 9 处；`appConnection:*` 缺站点 6；`memory-tier:rpc` / `bot-identity:rpc` 缺站点 3。

> 复现命令：`npm run architecture:ipc-census`（脚本为唯一事实源，上表由它产出，勿手工维护）。

### 1.1 P0 实测结果（脚本已落地）

`scripts/architecture/ipc-channel-census.mjs` 已在树上，`--json` / `--strict` 可用；测试 `scripts/architecture/ipc-channel-census.test.ts`（15 条，全绿）。

通道宇宙由**两个独立见证的并集**派生，而非手维护列表：

- 见证 A：worker 的 `case '<channel>:response'`（`worker-process-entry.ts`）
- 见证 B：Main 的 `type: '<channel>:response'` 发射（`agent-server-lifecycle.ts`）

双见证是刻意的：单靠见证 A 时，**删掉那一行 `case` 会让通道静默离开宇宙**，普查对一条已挂死的通道报绿。并集意味着通道只有在两处独立产物都消失后才会不见。`db` 按名排除（不同传输族）；单向通知（`bash_task:update` / `hook_task:update`）无需豁免——它们从不被回应，因而不被任何见证匹配，这正是被断言的性质。

当前红集：

| 级别 | 数量 | 站点 | 判定 |
| --- | --- | --- | --- |
| error | **0** | — | 每条通道都有出站、入站、执行路由、转发与回传 —— 家族今日结构完整 |
| asymmetry | **5** | `host-manager-drop`（`memory-tier:rpc`、`bot-identity:rpc`）、`server-forward-interagent`（`appConnection:invoke/listDescriptors/catalog`） | 需显式立项或显式豁免 |
| duplicate | **8** | `server-forward-router`（每通道 3 份） | 结构债，正确性无碍 |

两处 asymmetry 的**根因已定位，均属良性但隐式**：

- `host-manager-drop` 缺的两条会流向 `onWorkerMessage` → `run-execution.ts:295` `#onWorkerMessage`，而它只认 `db:request` 与 `chat:*` / `compact:*`，其余静默忽略。净效果与"被丢弃"相同 —— 但白名单读起来像权威关卡，实际不是。
- `server-forward-interagent` 缺的三条是 `appConnection:*`；同一文件对 `bot-identity:rpc` 留有一条注释，写明缺该转发会导致 15s 静默超时。兄弟站点的存在说明这更像遗漏而非设计，但需人工判定。

**变异证明**（活性验证，非 fixture）：在真实源码上临时制造缺陷，确认脚本报红后原样还原 ——

| 变异 | 结果 |
| --- | --- |
| `interagent-router.ts` 改一个通道条件 | asymmetry 5 → **6**，精确命中 `server-forward-interagent \| memory-tier:rpc` |
| `server/index.ts` 改一个回传条件 | error 0 → **1**，精确命中 `server-response-relay \| computer-use:cua` |

两文件均已 `git status` 复核为干净还原。fixture 层另有 15 条测试逐规则给反例（`exactly` 的缺失与重复、`min` 的缺失、`consensus` 的偏差），含"控制组：完全同步的树报告为空"。

## 2. 代价不是假设，是记录在案的两起

仓库既有记录（454、575 两次）：漏同步的通道不会在构建期报错，而是运行时表现为
`UNKNOWN_ACTION`，或 15s / 30s 后静默超时。**这条约束今天只靠"记得改五处"维持。**

## 3. 目标形态

引入**唯一的通道描述符**，让"注册一条通道"成为一个原子动作：

```ts
// 形态示意，字段名待定
interface WorkerIpcChannel {
  readonly channel: string;                 // 'computer-use:cua'
  readonly direction: 'request' | 'rpc';
  readonly outbound: OutboundDispatch;      // 站点 1 的分发
  readonly responseCase: InboundCase;       // 站点 2
  readonly mainRoute: MainRoute;            // 站点 4
  readonly serverForward: ForwardRule;      // 站点 5/6
  readonly responseRelay: RelayRule;        // 站点 7
  readonly ignoreWhitelist: boolean;        // 站点 3
}
```

配套两条硬约束：

1. **成对性由类型保证**：站点 3/5/6/7 从注册表派生，而不是各写一遍 `if`；`router.ts` 的三处变体合并为一处 `for (const c of registry)`。
2. **成对性由门禁钉死**：一个普查脚本枚举通道常量，断言"每个通道的每个站点都存在且唯一"，今天对 `computer-use:cua` 就该红（因为它恰恰是唯一手工补齐的样本）。

## 4. 分期（每期独立可交付、独立可回滚）

| 期 | 交付 | 完成判据 |
| --- | --- | --- |
| **P0** ✅ | 只读普查脚本 `scripts/architecture/ipc-channel-census.mjs`（+ `.ts` 类型面 + `ipc-channel-census.test.ts`；`npm run architecture:ipc-census`） | **已交付**：枚举通道并对 7 类站点逐个计数；**零行为变更**（无生产代码改动）；红集已跑出（§1.1）；变异证明已过 |
| **P1** | host 侧注册表 | 站点 1/2/3 由注册表派生；删除 `toolIpcRequest` 的 if-chain 与 per-channel helper 的手工分发 |
| **P2** | agent-server 侧注册表 | 站点 4/5/6/7 派生；`router.ts` 三处合并为一处迭代 |
| **P3** | 门禁接入 | `architecture:ipc-census` 纳入 `architecture:check` 或 610 门禁组，替代"记得改五处"的隐性约束 |

P0 已确立后续两期必须收掉的具体清单：**8 处 duplicate 是 P2 的作业**（router 三合一）；**5 处 asymmetry 必须逐条判决** —— 要么在 P1/P2 里补齐，要么在注册表里写成显式豁免并附理由。不得静默保留。

## 5. 验收证据（必须是正面的，不是"没报错"）

- ~~P0 普查脚本对本轮全部已知通道逐个给出站点清单，红/绿逐条可见。~~ ✅ **已达成**：8 条通道 × 7 类站点，`--json` / `--strict`（`--strict` 在 error/asymmetry 上 exit 1）；红集 0/5/8；真实源码变异证明两条（§1.1）；fixture 反例 15 条全绿。
- P1/P2 落地后，`packages/host/tests/worker-product-runtime/` 目录保持全绿（本轮实测 **11 文件 / 76 测试**，见 90 执行日志同日条目）。
- P3 接入后，反向证明：手工注释掉任一站点，门禁必须报红（与 A1 的 `mutation-proof-a1.mjs` 同法）。P0 已在真实树预演过该手法（§1.1 变异证明），P3 只需把它固化为脚本。

## 6. 非目标

- **不改通道语义、不改消息形状、不动 worker 进程模型。** 这是收敛，不是重设计。
- 不合并 `conductor:executor:rpc`（另一套 executor proxy 契约，站点在 `apps/desktop/src/main/conductor/executor-proxy.ts`）——它是本期普查的输入，不是改造对象。
- 不做远端注册 / 新客户端通道；Web 客户端（`apps/web`）留在 610 收口之后再开。
- 不碰 resources / prompts 能力链（那属于 580/581 的评估范围）。

## 7. 与既有计划的关系

- 这是 610 的**结构债收口**切片，与 [12 退役协同](./12-agent-retirement-coordination.md) / [13 消费者清单](./13-agent-retirement-consumers.md) 正交：退役解决"旧类还在"，本切片解决"新链靠记忆维持"。
- 它不阻塞退役，但**退役完成后立刻需要它**——否则 `packages/agent` 删掉后，剩下的通道表没有任何事实源。
