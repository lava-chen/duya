> Historical / superseded for execution. 原位置：`docs/exec-plans/active/584-agent-protocol-implementation.md`。
> 唯一执行入口：[587 主计划](../README.md)；设计冲突以 [00 合同](../00-contracts.md) 为准。旧 Status / checkbox / 行号保留为历史证据。

# Plan 584: `@duya/agent-protocol` 落地

> **Status**: Ready · **Priority**: P1 · **Owner**: TBD
> **立项**: 2026-10-01
> **依据**: `docs/architecture/07-agent-protocol-spec.md`（接口规格 + M0–M11 迁移顺序）、
> `06-migration-plan.md`（阶段顺序与关键路径）、`05-architecture-governance.md`（强制机制）、
> `04-agent-harness-design.md`（Run API 草案）
> **硬前置**: §3 的 G1–G3 必须先绿（归属 Plan 583 ISS-01，不在本 plan 内实现）
> **分界**: 本 plan **只做 protocol**。06 的 C1（解耦 SCC）、M1（plugin-core）、
> M3（packages/shared）、M4（conductor）、M5（切 agent-core/runtime）、M6–M8 均不在此。
> **证据基线**: 07 的全部 file:line 引自 `master` @ `7c5bf050`；
> 本 plan 新增的实测引自 `fix/583-track-a-p0` @ `de44018e`（2026-10-01）。
> 行号会随提交漂移，实现时以**符号与结构**为准，行号仅供定位。

---

## 0. 一句话目标

按 07 的规格新建 `packages/agent-protocol`——一个**零 IO、零依赖、CI 强制的真叶子包**，
把今天散落在 `@duya/ai`、`packages/agent/src/{message,permissions,ipc}` 和
`electron/agents/server/router.ts` 里的 wire contract 收敛成**一个闭合事件注册表**，
并用 14 条 drift test 把它钉死。

不做这一步，`packages/agent` 的 18 个循环 SCC（最大 42 文件）永远无法切开，
因为切口上没有一个稳定的类型边界。

---

## 1. 开工前必须承认的三个前提

### 1.1 M 编号在两份文档里冲突，排期会排错

| 标签 | `06-migration-plan.md` §1 | `07-agent-protocol-spec.md` §16 |
|---|---|---|
| M0 | 建立架构检查 | 建 `architecture-check.mjs`（**同一件事**） |
| M1 | 收敛 plugin-core | 建**空壳** protocol 包 |
| M2 | 抽出 agent-protocol | 从 `@duya/ai` **搬纯数据** |
| M5 | 切出 agent-core/runtime/tools | permission 词汇统一 |

同一个标签指两件不同的事。**本 plan 统一用 `PP-n`**，并在 §4 给出三向映射。
后续若要回改 06/07 的编号，另开一个纯文档 PR。

### 1.2 06 的 M2.1 已被 07 推翻，不要照着做

`06:92` 写的是「从 `agent/src/{message,permissions,ipc}` + `wake/types` +
`channels/types` 迁入」。但 07 §0.1 裁决：那 17 个 deep import 导入的是
`MessageEntry` / `AgentMessage` / `CompactionEntry` / `ingestMessage` /
`THREAD_METADATA_KEY` ——**是 durable message-log 存储模型，不是 wire contract**，
把它们全部改指 protocol 是范畴错误。07 §14 另把「存储模型」整条列入禁止清单。

> **边界**：只有 `Message` / `MessageContent` 进 protocol；
> 存储模型留给 PP-11 的独立 storage 模块。

### 1.3 「package 已有 40+ import 点」是本 plan 最大的隐藏成本

`SSEEvent` 的再导出点分布在 `@duya/ai` 下游、`src/`、`electron/`、`packages/*`。
PP-2 若不留足时间，会变成一次跨半个仓库的机械重写。

---

## 2. 范围

### 2.1 In Scope

- 新建 `packages/agent-protocol` workspace member（ESM，`composite: true`）
- 36 条事件的闭合注册表（`EVENT_SPECS` + `defineEventUnion()`）
- `RunEventEnvelope` / `ControlFrame` / `RunManifest` / `AgentRuntimeApi` /
  `RunHandle` / `ResumeRequest` / `RuntimeCapabilities` / `ERROR_CODES`
- `permission.ts`（统一词汇与唯一时钟）、`codecs.ts`、`transport.ts`（纯 port）
- `legacy/sse-event.ts` 隔离子路径 + 删除期限
- `testing/fixtures.ts` 进 `dist`，供其他包复用
- 14 条 drift test（07 §15）
- `scripts/architecture/architecture-check.mjs` + policy + baseline（PP-0）

### 2.2 Out of Scope

| 项 | 理由 |
|---|---|
| `packages/agent-core` / `agent-runtime` / `agent-tools` 的切分 | 06 的 M5，需先做 C1 解耦；本 plan 不碰 |
| `packages/shared`、解 `electron → src` | 06 的 M3。与本 plan 并行但不同文件所有权 |
| `apps/desktop/` 搬迁 | 06 的 M7 |
| `harness/agent/` | 06 的 M6；刻意在 workspace 之外，边界检查独立（05:48） |
| 云端 / Bot consumer | 07 §5.1 明确标为阻塞项，本轮范围外 |
| 存储模型（`MessageEntry` 等） | 07 §14 禁止进入 protocol |
| 清理既有类型错误 / 294 个 electron 老债 | 07 §17 + 门禁棘轮；本 plan 只加棘轮，不做清理冲刺 |

### 2.3 与 electron 逻辑重写的边界

用户已明确下一步要重写 electron 部分逻辑。本 plan **不重写任何 electron 业务逻辑**，
但 PP-3 会改 `electron/agents/server/router.ts` 的事件路径（`seq` 铸造、删
`normalizeWorkerEvent`、删 `multiLineBuffer`）。

> **排期建议**：PP-3 之前不要启动 electron 大重写。两者都动 `router.ts` 的同一条事件路径，
> 必然冲突；且 PP-3 依赖的 replay 语义（`Last-Event-ID`）会被大重写推翻。
> 若重写必须先做，则 PP-3 要在重写后**重新核对** 07 §5 的映射表是否仍然成立。

---

## 3. 硬前置（归属 Plan 583，不在本 plan 内实现）

> 没有可运行的门禁，下面 12 个阶段的验收标准全部无法验证。
> 本轮实测（2026-10-01）确认这三项**目前都不成立**。

| # | 前置 | 当前实测状态 | 证据 |
|---|---|---|---|
| **G1** | CI 的 `push` 到 `master` 被触发 | ❌ `test.yml:4-5` 只监听 `main, develop`，仓库主分支是 `master`。运行历史里 9-14 → 10-01 有 17 天空档，**从无 push-to-master 运行** | `.github/workflows/test.yml:4-5` |
| **G2** | `electron/` 被类型检查覆盖 | ❌ `tsconfig.json:34` 排除 `electron/**`，无 `typecheck:electron` 脚本。实测该树 **898 个错误**，其中 43% 是 8 个 renderer 文件被误拉入编译 | `tsconfig.json:34` |
| **G3** | 棘轮门禁自身可信 | ❌ PR #86 已实现 G1+G2（`typecheck:electron` + 基线），但**卡在 2 个 router.ts 错误**：`router.ts:1570:47 TS2345` / `router.ts:2876:80 TS2353`。本地跑门禁报的是 `1567:47` / `2873:80`（**与基线一致**），即 CI 与本地存在恒定 3 行偏移，且 CI 报的 `1570:47` 落在一条仅 34 字符的行上，物理上讲不通 | PR #86 / run 36833837786 |

**G3 的处置（待决，见 §6 的 D2）**。在 G1–G3 全绿之前，**PP-0 不得开工**——
`architecture-check.mjs` 的验收标准就是「基线数字没变」，而基线需要一道可信的门来读。

---

## 4. 阶段总览

`PP-n` ↔ 07 §16 `M-n` ↔ 06 §1 阶段。关键路径 **PP-0 → PP-1 → PP-2**。

| PP | 名称 | ↔ 07 | ↔ 06 | 绑定的 drift test | 风险 | 预估 PR |
|---|---|---|---|---|---|---|
| **PP-0** | 架构检查器 | M0 | M0 | — | 极低 | 1 |
| **PP-1** | 空壳 protocol 包 | M1 | M2 部分 | 1,2,3,4,5,6,10,12 | 无 | 1 |
| **PP-2** | 从 `@duya/ai` 搬纯数据 | M2 | M2 | 1,3,4,9 | **最高** | 2 |
| **PP-3** | bridge + router 切换 | M3 | — | 8,9 | 中 | 2 |
| **PP-4** | RunManifest + Runtime API（仅接口） | M4 | — | 11,14 | 无 | 1 |
| **PP-5** | permission 词汇统一 | M5 | — | 7 | 中 | 1 |
| **PP-6** | manifest 成为唯一 run-start 路径 | M6 | — | 12 | 高 | 2 |
| **PP-7** | ControlChannel cancel/pause/resume | M7 | — | 8 | 中 | 1 |
| **PP-8** | subprocess adapter | M8 | — | 8,13 | 低 | 1 |
| **PP-9** | HTTP+SSE adapter | M9 | — | 8,13 | 中 | 1 |
| **PP-10** | CLI + harness in-process adapter | M10 | — | 13 | 低 | 1 |
| **PP-11** | 重定 17 个 import | M11 | M2 收尾 | 1,2 | 中（diff 最大） | 2 |

> **PP-2 与 PP-3 之间要留整整一个 release**：PP-2 只做纯类型再导出，不改任何行为。
> 见 §5 PP-2 的「双阶段」。

---

## 5. 阶段详解

### PP-0 — 架构检查器（前置，不可跳过） ✅ 已交付（CI 接线除外）

**目标**：让违规变成可计数的，并让 CI 阻塞新增。**不移动任何代码。**

- [x] 0.1 `architecture-policy.yaml`：迁移前版本——**全部模块 `managed: false`**，
      `agent-protocol` 除外（它从第一天起 `requires: []` / `managed: true`，05:333-336）
- [x] 0.2 `scripts/architecture/architecture-check.mjs` +
      **能解析 workspace 包名与相对路径穿透**的 resolver
      （ZCode 的 checker 只解析相对 import，因此从未检查过任何跨包 import——05:184-205）
- [x] 0.3 `--self-test`：断言能数出全部已知违规
      —— **562 module / 161 escape / 117 deep / 18 cycle / 1 missing-artifact**
- [x] 0.4 `.architecture-baseline.json`（指纹式，**941** 条，含全部现有违规）
- [ ] 0.5 接入 CI（阻塞式 required check）+ `AGENTS.md` 补 Gates 章节
      —— `AGENTS.md` 已补；**CI 接线挂起**，见 §6 D2（G1 push-to-master 从未触发）

**验收**
- [x] `npm run architecture:self-test` 的违规计数与 `audit-imports.mjs` **完全一致**
- [x] 故意新增一条违规 → 检查失败（植入跨 3 条边界的探针，报出正好 4 条、exit=1；移除后恢复绿）
- [x] 现有代码**零改动**（只动 `scripts/`、policy、baseline、`AGENTS.md`、根 `package.json`）

**回滚**：删掉 workflow 里那一步，无代码影响。

**证据**：`05-architecture-governance.md:300-331`、`06-migration-plan.md:43-63`

#### 0.4 期间发现并修掉的两个 resolver 缺陷（2026-10-08）

**不是协议包引入的，是门禁自己的洞**。协议包对这两项的贡献是 **0**。

1. **计数依赖本地构建状态。** 16 条 electron-main 深导入写死指向
   `packages/agent/dist/...`（如 `electron/services/wake.ts` 导入
   `../../packages/agent/dist/context/os-context/index.js`）。干净检出没构建过 →
   它们是 `unresolved`、不计数；跑过 `npm run typecheck:all`（内含 `build:agent`）→
   多出 8 条边、门禁变红。**同一个 commit，两种结论。**
   修法：`audit-imports.mjs` 把指向**本仓库自己** `packages/<x>/dist/` 的 specifier
   归一化回产出它的 `src/` 文件——耦合本来就在源码里，门禁该量源码，不是量构建布局。
   已验证有/无 `dist/` 均为 161。**161 是更高的真值，不是回归。**

2. **注释被当成代码。** 两个审计脚本都对原始文本跑正则，于是文档里写的
   `from '...'` 变成一条边，**被注释掉的 import 也被当成活边**——意味着删掉一行注释
   会看起来像「消掉了一个违规」。这比多算更危险。
   修法：新增 `scripts/architecture/strip-comments.mjs`（保偏移的词法器），
   替掉之前按名字打补丁的 `SKIP_SPEC` 带子。实测：**移除 6 条误报、新增 0 条**
   （逐条 diff 前后边集确认过）。module-dependency 570 → 562；
   escape / deep-import / cycle / missing-artifact **全部不变**——这正是「只删掉了散文」的证据。
   自测 `scripts/architecture/strip-comments.test.ts`（11 断言）钉住它，
   因为词法器错了会**静默少算违规**，是这个仓库最坏的失败模式。

**基线数字因此重录：938 → 941 指纹，selfTest 567/153 → 562/161。**
两个数字的来历都写进了 `architecture-policy.yaml` 的注释里，而不是留在聊天记录里。

**遗留的已知限制（有意为之）**：`02-cycle-budget.test.ts` 刻意**不**共用
strip-comments 词法器——共用需要 `pkg:agent-protocol -> scripts/...` 一条依赖边，
而这个包的全部主张就是零条。代价是有界的：一旦环里出现被注释掉的 import，
交叉校验会**响亮地**失败并指名盲点，而不是静默。

---

### PP-1 — 空壳 `packages/agent-protocol` ✅ 已交付

**目标**：在包还很小的时候就把「假叶子」探测器落地。
grok `sampling-types` 的失败模式是文档声称 "no I/O" 而 `Cargo.toml` 拉进了 `reqwest`——
**第一天就抓**，而不是抽取之后。

- [x] 1.1 workspace member：ESM、`"type": "module"`、`composite: true`、
      `requires: []`、`managed: true`
- [x] 1.2 `src/` 骨架：`index.ts`（唯一公开入口，05:86）、`version.ts`、`primitives.ts`、
      `errors.ts`、`events/{payloads,registry}.ts`、`testing/fixtures.ts`
      —— 实际拆成 18 个模块，见下方「实际结构」
- [x] 1.3 **排在最前面先构建** —— **偏离原写法，见下**
- [x] 1.4 加入 `typecheck:all`（`typecheck:protocol` 排在**第一位**）
- [x] 1.5 落 drift test **1, 2, 3, 4, 5, 6, 10, 12** —— 全绿，另加 09 与 hash 两个
- [x] 1.6 `schema/` —— **刻意不建**，见下

**1.3 偏离**：本仓库**没有任何 tsconfig 用 project references**
（`packages/agent` 都不是 `composite`），引入 reference 图比「排前面构建」改动更大。
按仓库既有约定实现为：根 `build:agent` 的**第一个**子命令变成 `npm run build:protocol`。
1.4 同理，`typecheck:all` 第一位是 `typecheck:protocol`。

**1.6 偏离，且是本计划最重要的一条设计决定**：
`schema/` **不存在**，因为这个包是**类型优先**而非 schema 优先
（`10-reference-comparison.md` D7）。pi 能 schema-first 是因为它声明「无兼容承诺」，
而 Duya 有 4 个独立部署、独立版本、可以各自落后一个 minor 的 host；
拿入库 schema 做运行期校验会让**老 host 遇到新 runtime 的新字段直接崩**，
正是 07 §13 禁止的。
所以 drift test #10 被**改写为偏离守卫**：它不检查新鲜度，它检查**不存在**——
`schema/` 一旦出现就失败，并要求同一个 commit 附上生成器。
手写的 schema 落不了地。这比「检查一个没人维护的 JSON 有没有过期」有用得多。

**PP-1 第三轮（2026-10-01）：把 25 个 `chat:*` 事件全扫一遍，又挖出 5 处**

第二轮我只手工挑了 9 组事件做字段覆盖，**剩下 16 个根本没进过检查**。
这一轮改成机器扫描全部事件，结论是同一句话又成立了两遍：
**「把规格当事实来源」。**

| # | 问题 | 真相 | 处置 |
|---|---|---|---|
| N-1 | `StopReason` 词汇也是编的 | 代码真实值 `aborted, completed, end_turn, error, length, max_tokens, stop_sequence`；protocol 漏掉 `completed` 和 `length`，多出代码里查无此串的 `tool_use, refusal, pause` | 改用运行时自己的拼写；provider 的原始值放 `DiagnosticDetail` |
| N-2 | 40 个 `ErrorCode` 里 32 个在代码里查无此串 | 代码实际用的是 `internal_error, missing_arg, invalid_request, agent_not_found, connector_auth_required, provider_error, unknown_action, http_<status>, scheduler_unavailable, cron_not_found, not_in_catalog, connection_revoked…` **一个都不在闭合集里**，而 `chat:error.code` 是自由字符串 | **未修，记为最大缺口**：闭合错误分类需要一张 32+ 条的映射表，且要先裁决「哪一层的 code 上 wire」 |
| N-3 | `PermissionRequest.expiresAt` 没有生产者 | worker 的 `chat:permission` 只有 `{id, toolName, toolInput}`，整个权限路径**找不到任何 timer** | **未修，记为协议洞**：`kind`/`mode`/`expiresAt` 三个必填字段当前无一能填；注释里「单一权威时钟」应读作**对运行时的要求**，不是对现状的描述 |
| N-4 | checkpoint 事件缺失 | worker 有 `type: 'checkpoint'`（`{messages, generation}`），protocol 注册表**无任何 checkpoint 事件**，却对外承诺 `checkpointGeneration` resume | **未修，记为协议洞**：host 无从得知某个 generation 存在 |
| N-5 | `agent_progress` 的 11 个字段落不进去 | `data` / `toolInput` / `agentEventType` 三个字段在 `subagent.*` 和 `hook.invoked` 里都没有位置 | 三个字段补进 `HookInvokedPayload`（`agentEventType` 尤其重要：它决定了这一帧被拆成哪个事件） |

顺带删掉 `TurnRetryScheduledPayload.errorClass` —— worker 侧**不存在**这个分类，
是又一次凭规格加的字段，host 会去分支一个永远收不到的值。

**结构性修法：把 UNMAPPED 变成决策日志而不是注释。**
`worker-event-coverage.test.ts` 现在要求**每个 worker 事件要么被映射、要么被显式登记**
（含未映射的原因，以及是否属于「协议洞」而非「适配器问题」）。
已植入假事件验证：worker 一旦新增事件而两边都没登记，测试立即变红。
**「没人看过」从此不可能被误读成「这样没问题」。**

**这一轮的教训值得单独记：三轮里最贵的两类错误（P0-1 mode、N-1 stopReason、
N-2 错误码）全部是同一个动作造成的——把一个来源不携带信息的字段收紧成闭合 union，
或者照着规格文档抄一份词汇表。**
收紧 union 之前必须先问：这个值在代码里的**真实取值集合**是什么。
答不上来就不能收紧，只能保持 `string` 并配一个转换点。

**PP-1 第二轮评审（2026-10-01）：对着真实 worker 实现复核，发现 6 处语义级问题**

第一轮评审查的是「protocol 内部是否自洽」。第二轮把 protocol 和
`packages/agent/src/process/worker-protocol.ts`（runtime 真正打印的东西）逐条对，
结论是**不能把 PP-1 当作「协议已定型」**。六条全部复核成立：

| # | 问题 | 真相 | 处置 |
|---|---|---|---|
| P0-1 | `assistant.mode_changed` 枚举错了 | worker 真实值是 `general\|plan\|explore\|verify\|code-review`（`SwitchModeTool/constants.ts` 的 `ALL_MODES`）；protocol 原先写的是 `default\|plan\|research\|conductor\|goal` | 改用 runtime 真实词汇，并**双向**断言（worker 能发的都能表达、protocol 允许的 runtime 都会发） |
| P0-2 | `goal_updated` 静默丢字段 | 丢了 `pauseMessage` / `totalWorkerRounds` / `totalVerifyRounds` / `elapsedMs` / `createdAt` / `executionWait`，且 `history` 从 `{at,event,detail?,reason?}` 被改成 `{at,note}` | 全部补回；`history` 对齐真实结构 |
| P0-3 | tool 关联 id 不统一 + durability 隐患 | `call_started` 用 `toolCallId`、`call_completed` 用 `toolUseId`；且 `call_started` 是 volatile | 全部收敛为 `toolCallId`；`call_started` 改 **durable**——崩溃后「本想调用」这条记录是 side-effect ledger 唯一的对账依据 |
| P0-4 | `RunFailedPayload` 绕开错误分类 | `{code: string; message: string}` 让自由字符串从后门回到闭合的 `ErrorCode` 体系 | 改为 `ProtocolErrorInfo`；`RunTerminalState` 改为 discriminated union，`failed` 必须有 error、其他状态禁止有 |
| P1-5 | capabilities 两个事实来源 | `run.maxEventBytes` 与 `limits.maxEventBytes` 并存；`catalog.connectors` 混了层（capability 不该带用户的 `connectionId`） | 删掉 `run.maxEventBytes`；connectors 改为 `connectorProviders: string[]` |
| P1-6 | resume 判断有实质 bug | `from.seq <= replayWindow` 拿**绝对 seq** 比**窗口大小**。500 条 ring 在 seq=1200 时保存 701–1200，从 1000 resume 合法却被拒 | capability 改为 `oldestAvailableSeq` / `latestSeq`，用 `isReplayable()` 判断 |

**根因是一个方法论错误，不只是六个 bug。**
drift test #9 认真对照的是 `packages/ai/src/types.ts` 的 SSE union，
但**那里 `mode` 就是个 `string`，不带任何信息**——
「把 string 收紧为闭合 union」时从一个不携带事实的字段推导词汇，只能靠编。
P0-1 就是这么来的。同理 SSE union 里根本没有 goal 的那些字段，
所以「对齐 SSE union」看起来是完整的 P0-2 实际上在丢数据。

**因此新增 `test/worker-event-coverage.test.ts`：以 worker-protocol.ts 为事实来源，
逐事件断言「target 表达的不少于 source」。** 包含：

- 9 组 worker event → protocol payload 的字段覆盖，**改名显式登记**成审计表
  （`result`→`content`、`name`→`toolName`、`duration_ms`→`durationMs`……），
  改名表本身也被双向校验：指向的字段必须真的存在，源字段必须真的还在；
- mode 词汇**双向**断言；tool 关联 id 唯一性；`call_started` 的 durable；
- `RunFailedPayload` 不得出现自由 `code: string`；`RunTerminalState` 必须是四臂 union。

**已植入探针逐条验证会咬人**：把 P0-1 / P0-2 / P0-3(id) / P0-3(durable) / P0-4 的修复
逐个回退，对应断言全部变红（durable 那条同时被自己的测试和 #5 快照抓到）。
过程中测试自己也踩了两次「看起来有覆盖其实没有」的坑，已修：
CRLF 让 `line === '}'` 永不成立、`readonly` 修饰符让字段正则失配。

**顺带修了审计 resolver 的第三个洞**：它解析不了 `.mjs` 文件，
候选列表里只有 `.ts`/`.tsx`/`.js`。所以 `scripts/architecture/` 下的
`.mjs` 互相 import 一直是 `unresolved`——**不可解析的边会豁免本该套在它身上的规则**。
修完 self-test 回到 562，无需重录基线。

**命名在 PP-1 评审时改过一轮（2026-10-01）**

初版有三个名字与**被迁移方**同名，而冲突要等到迁移那一刻才会进同一个文件作用域：

| 初版 | 改为 | 冲突在哪 |
|---|---|---|
| `PermissionDecision`（host 的回答） | `PermissionResponse` | `packages/agent/src/permissions/types.ts` 里的 `PermissionDecision` 是 **policy engine 的判断** `{behavior: allow/ask/deny}`，在有人被问之前就产生了 |
| `PermissionMode`（单个 request 的交互场景） | `PermissionRequestMode` | 与 `PermissionModeName`（整条 run 的策略）同名但不同层 |
| `PermissionModeName`（run 级策略） | `PermissionPolicyMode` | 用 `…Name` 后缀消歧是弱约定，不如两边都把层次写进名字 |
| `PermissionRequested` / `PermissionResolved` | `PermissionRequest` / `PermissionResolution` | 与四段链条对齐 |

最终链条：**Evaluation（runtime 内部，故意不上 wire）→ Request → Response → Resolution**。
`PermissionDecision` 这个名字**故意不导出**，留给 policy engine，避免迁移时两个同名类型并存。
改名成本此刻是零（包还没有任何消费者），PP-2 之后就晚了——由 `test/permission-naming.test.ts` 钉住，
已植入探针确认把旧名写回去会导致两条断言失败。

**同时修掉一处我自己写错的事实**（评审指出，复核成立）：
注释称 `ToolPermissionRulesBySource` "含三个 ReadonlyMap，不能 JSON 化"。实际它是
`{[source]?: string[]}`，**本来就是 JSON 安全的**；真正的 `ReadonlyMap` 是同一个
`ToolPermissionContext` 上的 `additionalWorkingDirectories`（`Map` 序列化会变成 `{}`）。
结论（wire 上用可 JSON 化结构）成立，**证据不成立**。
**这正是 file:line 反向引用会腐烂的现成例子**——所以代码里的 `file:line` 引用一并去掉了。

**关键约束（都守住了）**
- `events/payloads.ts` 与 `events/registry.ts` **分成两个文件**：registry 只有
  `import type`（编译期擦除），drift test #1 断言它**零运行时 import**——实测通过
- `transport.ts` 只放 **binding，零 adapter**

**实际结构**（18 个源文件，`dependencies: {}` 零运行时依赖）：
`version / hash（纯 TS sha256）/ primitives / errors / permission / capabilities /
resume / manifest / envelope / run / transport / framing / codecs`
+ `events/{payloads,registry}` + `legacy/sse-event` + `testing/fixtures`

**drift test 实际交付：10 个文件 / 127 断言全绿**

| # | 文件 | 断言 | 状态 |
|---|---|---|---|
| 1 | `01-import-graph` | 零依赖、零 `node:*`、registry 零运行时 import、三 subpath | ✅ 10 |
| 2 | `02-cycle-budget` | SCC ≤ 18、protocol 贡献 0、无自环、仍是叶子 | ✅ 5 |
| 3 | `03-event-union-closed` | 36 事件 round-trip、未知 type 不抛 | ✅ 45 |
| 4 | `04-event-exhaustive-switch` | 编译期 `never` + 运行期覆盖 | ✅ 5 |
| 5 | `05-event-type-snapshot` | 36 类型快照 | ✅ 5 |
| 6 | `06-error-code-snapshot` | RETRYABLE/TERMINAL 划分 | ✅ 7 |
| 9 | `09-sse-legacy-bridge` | 26 个 legacy 类型**与 `packages/ai/src/types.ts` 跨包取证一致** | ✅ 10 |
| 10 | `10-json-schema-freshness` | 偏离守卫（见上） | ✅ 2 |
| 12 | `12-no-secret-in-manifest` | 凭据不入 manifest | ✅ 8 |
| — | `hash` | 4 组公开向量 + 与 `node:crypto` 交叉验证 + 黄金指纹 | ✅ 21 |

**#2 上线当天就抓到一个真环**：初版把 `EventSource`/`EventSink` 放在 `transport.ts`，
而 `run.ts` 从那里导入、`transport.ts` 又导入回 `RunHandle`——循环组 18 → 19。
修法是**分层**不是 `eslint-disable`：把这两个通道原语下沉到 `envelope.ts`（它本来就是叶子），
`run.ts` 依赖它、`transport.ts` 依赖两者，单向、无环。已植入探针复现，确认测试会红。

**测试抓到的另外两个真 bug**：
`ToolCallCompletedPayload extends ToolResult` 让 `type: 'tool_result'` 覆盖了事件判别式
（改为独立 interface）；`replay_unavailable` 漏在 RETRYABLE/TERMINAL 之外（补进 TERMINAL）。

**风险**：无。

**第一版的范围定义**：包完整 + 上述 drift test 全绿 + 参考对比落档。
**PP-2a（迁移 122 条边 / 98 个文件）不在第一版内**——G1–G3 未绿时动它是不可验证的大爆炸。
实测 `@duya/ai` 被 122 条边、98 个文件 import（pkg:agent 80、electron-main 20、src-renderer 18、
pkg:computer-use 4）。

---

### PP-2 — 从 `@duya/ai` 搬纯数据（**单步风险最高**）

**目标**：把 wire contract 搬进 protocol，`@duya/ai` 降级为再出口。

**双阶段，不可压缩**

| 子阶段 | 内容 | 可否发布 |
|---|---|---|
| **2a** | 搬类型 + `@duya/ai` 改为从 protocol 再导出 + 把 protocol 列为 `@duya/ai` 依赖。**零行为改动** | ✅ 与 2a 同 release 或更早 |
| **2b** | 才是任何行为侧改动 | ❌ 至少隔一个 release |

> 2a 必须在 2b 之前**完整走一个 release**。`SSEEvent` 有 40+ 个 import 点，
> 一次性搬完并改行为，回归定位会非常昂贵。

- [ ] 2.0 搬入清单（全部去 Promise、去 `Map`/`Set`、去回调）：
      `Message` / `MessageContent` / `TextContent` / `ThinkingContent` / `ToolUse` /
      `ToolResult` / `TokenUsage` / `UsageCall` / `StopReason` /
      `PermissionRequestEvent` / `AgentProgressEvent`
- [ ] 2.1 新增 `RunEvent`（由注册表派生）
- [ ] 2.2 `SSEEvent` 移入 `legacy/sse-event.ts`，暴露为 `@duya/agent-protocol/legacy`，
      **带删除期限**；不进主入口的永久 export
- [ ] 2.3 `packages/agent/src/types.ts` 退化为 re-export shim
      —— **先例已存在**：`types.ts:14-56` 已从 `@duya/ai` 再导出
- [ ] 2.4 drift test 1, 3, 4, 9

**禁止搬入**（07 §14）：密钥、携带 Promise 的字段（`ToolResult.pendingExtraResult` /
`pendingContext`）、`Map`/`Set`、回调、工具实现、内联 `import()` 类型引用、
**存储模型**、UI 视图模型、zod/ajv 运行时依赖。

> `ToolPermissionRulesBySource` 含三个 `ReadonlyMap`（`permissions/types.ts:427-434`），
> 过不了 JSON——这是「直接搬 `permissions/types.ts`」的具体阻塞点。
> 协议边界必须展平为 `Record`。

**风险**：最高。**缓解**：2a/2b 拆分 + 一个 release 的静止期。

---

### PP-3 — bridge + router 切换

- [ ] 3.0 **先补完枚举**：`normalizeWorkerEvent`（`router.ts:450-569`）在 `:569` 之后
      还有约 **120 行**（research / workflow 分支）被抽样但未完整枚举（07 §17）。
      **映射表必须先写完再删函数。** drift test #9 会兜住剩余部分，但不能替代清单。
- [ ] 3.1 `legacy/sse-event.ts` 持有 `SSE_EVENT_TO_PROTOCOL: Record<SSEEvent['type'], EventType>`
- [ ] 3.2 删 `normalizeWorkerEvent`，换成注册表驱动的 `codecs.toEnvelope(workerFrame)`。
      `default` 分支发 `extension.custom` + 一条 `diagnostic`，**而不是静默转发未知帧**
- [ ] 3.3 **`seq` 铸造从 router 移到 runtime**。今天的 `seqNum` 是每连接计数器，
      而 `handleGetChat` 重放时用**新计数器重新编号**（`router.ts:2479`），
      同时写入的 `id:` 却来自 ring 的原始 `eventId`（`:2423`）——**重放事件的 id 与原始流对不上**。
      铸到 runtime 之后 `id` 恒等于 `seq`，`Last-Event-ID` 续传才构造成立
- [ ] 3.4 删 `multiLineBuffer` 的 JSON 累加 hack（`router.ts:1334-1386`，100 KB 上限）。
      它存在只因为 `sendEvent` 可能发多行 JSON；协议规定每行一次 `JSON.stringify`
- [ ] 3.5 router 停止维护自己的 event ring（`:2411`），退化为纯字节泵；
      重放移交 `Last-Event-ID` + runtime 的 ring
- [ ] 3.6 drift test 8, 9

**风险**：中。去掉 `seq` 重编号会改变重放行为。

**明确不做**：`CORS: Access-Control-Allow-Origin: *`（`router.ts:1319`、`:2914`）
**不得**存活到 cloud host，但这是 Bot/Cloud consumer 的阻塞项，本轮范围外（07 §5.1）。

---

### PP-4 — RunManifest + AgentRuntimeApi（**只有接口，无实现**）

- [ ] 4.1 `manifest.ts`：`RunManifest`（全字段 `readonly`）+ `manifestFingerprint()`
- [ ] 4.2 `run.ts` / `resume.ts` / `capabilities.ts` / `transport.ts` 的接口定义
- [ ] 4.3 `assertSatisfies()` 落地
- [ ] 4.4 probe 落地：`POST /sessions` 响应与 `GET /sessions/{id}/status`
      （`router.ts:2705-2735`）新增 `protocol` + `replayWindow`
- [ ] 4.5 drift test 11, 14

**三个现有代码支撑不了的字段**（07 §3.1，实现时不要假装它们已存在）

| 字段 | 问题 |
|---|---|
| `permissionPolicy.rules` | 不能是 `ToolPermissionRulesBySource`——含 `ReadonlyMap`，过不了 JSON。协议边界必须 `Record` |
| `env: { ref, hash }` | 与今天的 wire 矛盾：密钥内联在 `worker-protocol.ts:7`、`types.ts:141,152,158`。**Control Plane 必须先有 secret resolver**，否则只是愿景（阻塞 PP-6） |
| `budget` | 无对应物。最接近的是 `maxTurns`（`types.ts:289`）+ `agent.max_turns` |

另：**chat 路径没有 `runId` 先例**——worker 事件只带 `sessionId`（`worker-protocol.ts:258`）。
`WorkflowRunCommand.runId`（`:218`）是**另一个概念**（workflow run ≠ agent run），绝不能混。

**风险**：无，纯增量。

---

### PP-5 — permission 词汇统一

今天有三套互不兼容的词汇（07 §0.3）：

| 位置 | 动作集合 |
|---|---|
| 回调返回（`packages/agent/src/types.ts:337`） | `'allow' \| 'deny' \| 'paused'` |
| HTTP 接收（`router.ts:1785`） | `allow \| deny \| allow_once \| allow_for_session` |
| worker 接收（`agent-process-entry.ts:4413`） | 同上四种 |

- [ ] 5.1 单一 `PERMISSION_ACTIONS = ['allow','allow_always','deny','defer']`
- [ ] 5.2 **唯一权威时钟**：`expiresAt = startedAt + manifest.permissionPolicy.defaultTimeoutMs`
      （默认 `300_000`，对齐 `agent-process-entry.ts:2240`）。
      legacy 的 `expiresAt` 由 agent 铸造、计时器由 worker 设置——**两个会打架的时钟**
- [ ] 5.3 legacy 映射（07 §7.3）：`allow_once → allow`；
      `allow_for_session → allow_always{scope:{kind:'session'}}`；
      `paused → deny + source:'timeout'`；未知串 → `defer` + `diagnostic`
- [ ] 5.4 drift test **7**（扫描那三个文件里任何竞争性的字符串字面量 union）

**host 永不回答时的语义**（07 §7.2，这是本 plan 语义密度最高的一段，逐条实现）
1. 到 `expiresAt` 先发 `permission.expired`，**再**发 `permission.resolved{action:'deny',source:'timeout'}`
   —— 决策被持久记录，离线 host 重连后能看到发生了什么
2. 工具调用以 `tool.call_completed{ isError: **false** }` 收束。
   **超时拒绝是策略结果，不是失败**；标成 `isError: true` 会污染 transcript 和所有成本指标
3. 之后到达的 `permission:resolve` **不是异常路径**——resolve `{accepted:false, reason:'permission_expired'}`，
   runtime 不发任何东西
4. 带未决 permission 被 cancel 时：每个未决请求以 `deny` + `source:'cancelled'` 收束并各自发
   `permission.resolved`，保证审计链完整
5. 重复 `requestId` 是 runtime bug：发 `diagnostic{level:'error'}` 并**丢弃**，绝不覆盖

**风险**：中。触及 `types.ts:337`、`router.ts:1785`、`agent-process-entry.ts:4413`。

---

### PP-6 — manifest 成为唯一 run-start 路径（**被一个未决决策阻塞**）

- [ ] 6.1 `InitCommand`（`worker-protocol.ts:3-35`）+ `ChatStartCommand`（`:37-138`）
      改写为 `{ manifest, input }`
- [ ] 6.2 `agent-process-entry.ts` 保留**一个 release 的翻译 shim**
- [ ] 6.3 **密钥离开 wire**——需要 Control Plane 的 secret resolver（见 §6 D1）
- [ ] 6.4 drift test 12（构造 manifest 遍历查找
      `/api[-_]?key|secret|token|password|credential|bearer/i`，命中即失败）

> 这是 12 个阶段里**唯一需要「没人做过的决策」**的阶段（07 §16.1）。
> 决策未落前，PP-6 不能开工；`RunManifest.env = {ref, hash}` 只是愿景。

**风险**：高。

---

### PP-7 — ControlChannel 的 cancel / pause / resume

- [ ] 7.1 `interruptWorker`（`worker-manager.ts:304`）变成带 `reason` + `graceMs`
      （取自 capabilities，今天是 `2000`）的 `cancel`
- [ ] 7.2 终态 CAS 语义（07 §8）：`pending → running → completing → terminal`，
      一次性执行。推论：
  - 任何终态之后调 `cancel()` 返回 `{applied:false}` 且**无任何效果**——不抛错、不重发
  - `run.completed` / `run.failed` 中**恰好一个**是流的最后一个 envelope
  - **取消不是失败**，发 `run.completed` 而非 `run.failed`
  - 预算耗尽 / 工具错误 / 自然完成 / 取消**争夺同一个 CAS**，只有到达顺序，没有优先级。
    这是刻意的：任何优先级方案都需要一个 host 可能尚未观察到的全序
  - `graceMs` 到点若 transport 不得不硬杀，该 run 是
    `run.failed{code:'runtime_crash', details:{escalated:true}}`——
    **硬杀意味着干净取消路径没被遵守，报 `cancelled` 就是撒谎**
- [ ] 7.3 drift test 8

> `applied` 是相对 `handleDeleteChat`（`router.ts:1697`）的改进：后者在 worker ack
> **之前**就在 DB 里硬迁移 `STREAMING → COMPLETED`（`:1681-1683`），
> **host 今天无法区分「是我取消的」和「它本来就已经结束了」**。

---

### PP-8 / PP-9 / PP-10 — 三种 transport adapter

协议定义 **port**，不定义 socket。`EventSink` / `EventSource` / `ControlChannel`
在三种 transport 下完全相同，adapter 只在 framing、背压、错误映射上不同（07 §12）。

| 阶段 | 内容 | drift test |
|---|---|---|
| **PP-8** | subprocess adapter。`chat:interrupt` / `permission:resolve` 按 `ControlMethod` 重新定型 | 8, 13 |
| **PP-9** | HTTP+SSE adapter → envelope。`Last-Event-ID` 续传；500 事件 ring（`server/types.ts:39`）成为 capabilities 里的 `replayWindow` | 8, 13 |
| **PP-10** | CLI + harness 的 in-process adapter。**到这一步，边界才真正对第 4 个 consumer 成立** | 13 |

**背压**（三种 transport 共用的策略）
- 有界队列 `maxBufferedBytes`（默认 8 MB）
- 溢出时**只丢 ephemeral**，发 `diagnostic{level:'warn', data:{dropped:n}}`
- 若 **durable** 事件排不进去，**runtime 暂停模型循环，绝不丢**
- SSE 没有流控信号，所以 HTTP adapter 是背压唯一可能存在的地方

**Resume 拒绝规则**（07 §9）
- `event_seq` 超出 `replayWindow` → `replay_unavailable`
- **seq 严格落在 `tool.call_started` 与其终态事件之间的恢复一律拒绝** → `invalid_resume_point`。
  工具副作用**不是事务性的**，mid-tool 恢复会静默重复执行。
  今天的 500 事件 ring 有损且无类型（`SessionEventRecord.data: unknown`），
  **没有任何机制阻止这件事**——协议必须阻止
- `message_index` 是**新 run**，带新 `runId` + `parentRunId`
- 被恢复的 run **重新校验 `manifestFingerprint`**；变了就是 `invalid_manifest`，
  而不是一次静默的行为漂移

**`trace` 只含 durable + volatile 子集**；ephemeral 事件只在 metrics 里计数、不保留。
否则一次 `text_delta` 风暴就会吃掉整个内存。

---

### PP-11 — 重定那 17 个 import（**最后做**）

**拆开目标**（07 §0.1 / §16 M11）

| 符号 | 去向 |
|---|---|
| `Message` / `MessageContent` | `@duya/agent-protocol` |
| `MessageEntry` / `CompactionEntry` / `AgentMessage` / `ingestMessage` / `THREAD_METADATA_KEY` / `ROOM_HISTORY_SOURCES` | **新的 storage 模块**（不是 protocol） |

- [ ] 11.1 改写 17 个文件 / 18 个 specifier
- [ ] 11.2 修 2 处**相对路径穿透**到 `packages/agent/src/message/message-source`：
      `electron/wake/group-turn-dispatcher.ts:35`、`electron/ipc/group-handlers.ts:29`
- [ ] 11.3 drift test 1, 2

> **放最后**，因为 diff 最大（17 文件），且依赖 protocol 已被信任。

---

## 6. 阻塞与未决决策

| # | 决策 / 未知 | 阻塞 | 状态 |
|---|---|---|---|
| **D1** | **Control Plane 的 secret resolver**：如何把 `ref → credential` 解出来，且**永不跨越协议边界** | **PP-6** | ⛔ 未决。需一个设计决策，不只是实现 |
| **D2** | **electron 门禁基线的行号漂移**：CI 报 `router.ts:1570:47` / `2876:80`，本地报 `1567:47` / `2873:80`（与基线一致）。同 commit、同文件内容（已与 GitHub blob 逐行核对），但 CI 报的 `1570:47` 落在一行仅 34 字符的代码上，物理上讲不通 | **G3 → PP-0** | ⏸ 用户 2026-10-01 决定挂起。候选方案见 §6.1 |
| **D3** | **junction 式 worktree 无法复现干净检出**：`@duya/voice` / `@duya/computer-use` 解析到**主检出**的 dist，本地构建天然带热产物 | 污染 PP-1 之后的每一次本地验收 | ⚠️ 见 §7 T1 |
| **D4** | **500 事件 replay ring 的诚实性**：`event_seq` 续传只有在 ring 有持久化支撑、或其窗口被诚实通告时才算诚实。**未核实长 run 中 durable 事件密度超过 500 的频率** | PP-9 | ❓ 待测 |
| **D5** | ~~`normalizeWorkerEvent` 在 `:569` 之后的 ~120 行未完整枚举~~ **已关闭（第三轮审计）**：router 实际发出 25 个事件，全部行号见 `docs/architecture/11-protocol-forward-review.md`。其中 `chat:research_updated` 被 router 拆成 **3 个** SSE 事件（`research_continue` :564 / `research_evidence` :567 / `research_report` :570），比 G-4 原记录更严重 | ~~PP-3~~ | ✅ 已关闭 |
| **D6** | **`allow_for_session` 在实践中是进程作用域**（`agent-process-entry.ts:4414-4416`），**只是因为一个 worker 今天恰好服务一个 session**。协议的 `allow_always{scope:{kind:'session'}}` **不得继承这个巧合** | PP-5 | ⚠️ 记入测试 |
| **D7** | **`EventMeta.since` 是装饰性的**：30 个事件全是 `'1.0'`，唯一消费者是断言**格式**的快照测试，没有任何门禁读它。缺这条轴，G-1/G-2/G-3/G-4/G-6 全部无解——它们都是「类型里声明了，生产者没有」的同一形状 | PP-3 / PP-7 | ⛔ 未决。G-9 |

### 6.1 D2 的候选处置

| 方案 | 做法 | 代价 | 评价 |
|---|---|---|---|
| **A** | 门禁失败分支 dump 原始 tsc 输出，再跑一次 | ~5 分钟拿到确定答案 | ✅ **推荐**，最稳 |
| **B** | 基线键从 `path:line:col code` 改成 `path + code + message`，去掉行号 | 一次性消除脆性；以后挪行不再误报 | ✅ 治本，但要动门禁契约，PR #96 也在动门禁，需协调 |
| **C** | 本地 `--write` 重录基线 | ❌ **无效**：本地编号本就与基线一致，录出来 CI 照样红 | ⛔ 不要做 |
| **D** | 放着不管 | #86 不合并 → G1/G2/G3 全部不落地 → 17 个 PR 继续阻塞 | ⛔ 见下 |

> **D 的真实代价**（用户已知悉并接受挂起，此处留档）：
> PP-0 的验收标准就是「基线数字没变」，而基线需要一道可信的门来读。
> **在没有 G1–G3 的情况下启动 electron 逻辑重写，等于在没有类型网的情况下重写 electron。**
> esbuild 不做类型检查——这是 `AGENTS.md` 第一条 Footgun。

---

## 7. 已知陷阱

### T1 — junction 式 worktree 会让干净检出的失败**无法复现**（本轮实测）

`AGENTS.md` 的 Worktree setup 第 2 步要求把 `node_modules` 从主检出 junction 过来。
这会让 `@duya/*` 解析到**主检出的 `dist`**，于是：

- 本地 `npm run build:agent` **永远绿**，哪怕干净检出会挂在 `TS2307`
- 本轮第一次「干净状态」验证就是这样**无效**的：worktree 里 5 个 `dist` 全都不存在，
  但 `@duya/computer-use` 解析到了主检出的 `dist/index.js`，构建照样 exit 0

> **每个需要构建的阶段，验收前必须先确认解析路径**：
> `node -e "console.log(require.resolve('@duya/<pkg>'))"` —— 打印出的路径必须在本 worktree 内。
> 若指向主检出，则该次验证**不算数**。

缺失 junction 还会产生假的 `TS2307`（AGENTS.md 已记）。仓库根 + 每个自带
`node_modules` 的 workspace 包都要 junction：`packages/{agent,conductor,gateway,
plugin-core,voice,cli,computer-use}`。

### T2 — 同一 commit 下 CI 与本地的 tsc 输出可能不一致

见 D2。在 D2 解决前，**任何「本地绿 = CI 绿」的推断都不成立**。

### T3 — `@/` 是歧义别名

`tsconfig.json:17` 把 `@/*` 指向 `./src/*`，而 `electron/tsconfig.json:15` 指向 `./*`。
任何同时被 main 和 renderer 触及的文件，在其中一个 tsconfig 下必然解析失败。
本轮实测这贡献了 `electron/` 898 个错误里的 384 个（43%），集中在
`src/lib/stream-session-manager.ts` 一个文件（276 个）。
**这正是 06 的 M3（`packages/shared`）要消灭的东西**——不要在 PP 阶段逐文件修它。

### T4 — 门禁用行号做键

`scripts/typecheck-electron-gate.mjs` 的基线键是 `<path>:<line>:<col> <TScode>`。
只要有人改动一个含已知错误的文件、哪怕只挪几行，基线就失效，老债会被报成「新引入」。
若采纳 §6.1 方案 B，一并修掉。

### T5 — `typecheck:cli` 在默认堆下 OOM

`AGENTS.md` 已知：`typecheck:cli` 在默认 heap 下会 OOM 崩 tsc。
本地验证需 `NODE_OPTIONS=--max-old-space-size=6144`。
**注意 CI 的 `typecheck:all` 没有设这个变量**——若 G3 修好后 CI 在这里红，
这是已知候选原因。

---

## 8. 完成定义（DoD）

`@duya/agent-protocol` 落地完成的判定：

- [ ] 14 条 drift test 全部存在且通过（07 §15）
- [ ] `architecture-check.mjs` 在 CI 里是 **required check**，`agent-protocol` 为 `managed: true`
- [ ] `packages/agent` 的 SCC 数 ≤ 18 且 protocol 贡献 0
- [ ] 17 个 `@duya/agent/message` deep import 全部改指（protocol 或 storage），0 条残留
- [ ] 2 处相对路径穿透清零
- [ ] 三种 transport 的 `EventType` 序列与终态 `RunResult` 一致（drift test #13）
- [ ] `SSEEvent` 只从 `@duya/agent-protocol/legacy` 导出，且**带删除期限**
- [ ] `typecheck:all` 在 CI 绿，`electron/` 被覆盖
- [ ] `ARCHITECTURE.md` 已更新（AGENTS.md 要求：重大变更后更新）

---

## 9. 复现命令

```bash
# 现状基线（本轮实测，master @ 3ff58a3f，工作区有未提交文档改动）
node scripts/architecture/audit-imports.mjs     # 568 cross / 161 escape / 117 deep
node scripts/architecture/audit-modules.mjs     # 18 cyclic groups / largest 42
npx tsc --noEmit                                # 0 errors
npx tsc -p electron/tsconfig.json --noEmit      # 898 errors ← 无门禁覆盖

# 门禁现状
gh pr checks 86                                # 3 platforms，红在 Run typecheck
gh run view 36833837786 --job 110276373440 --log
```

**可复现的数据全部由 `scripts/architecture/` 下的解析器生成。**
本 plan 引用的所有数字要么来自这些脚本，要么来自本轮实测的 CI 日志，
没有估算。

---

## 10. 与既有计划的关系

| 计划 | 关系 |
|---|---|
| **583 architecture-audit-remediation** | §3 的 G1–G3 归属它。本 plan 在其 G 绿之前不开工 |
| **0606 / 07 架构文档** | 本 plan 是 07 §16 的可执行化。**不修改** 07 的规格内容；若实现中发现规格错误，另开纯文档 PR 并在此记录 |
| **06 的 M2** | 其 M2.1 已被 07 §0.1 推翻（见 §1.2）。本 plan 的 PP-1/PP-2/PP-11 覆盖 06 M2 的真实范围 |
| **06 的 M5（切 agent-core/runtime）** | 不在本 plan。需先做 C1 解耦 42 文件 SCC |
| **conductor 相关（06 M4、09 评估）** | 不相干。`@duya/conductor` 在本 plan 中只是 `build:agent` 链上的一环 |

---

**下一步（唯一）**：等 Plan 583 的 G1–G3 全绿后，开 **PP-0**，
从 `architecture-policy.yaml`（全模块 `managed: false`）开始。
**不要跳过 PP-0 直接建包**——没有闸门，后面 11 个阶段的验收全部无法验证。

---

## 11. 第三轮审计记录（PP-1 交付后）

四轮评审里最贵的错误类型是**没读源码就断言事实**。本轮先立可信度分级
（已验证 / 推断 / UNVERIFIED），再逐条复核。结果：

### 11.1 推翻了四个自己写下的事实断言

| 原断言 | 实际 | 提交 |
|---|---|---|
| `tool_use` 合并了 start 和 finish，`is_error` 因此丢失 | **两者除判别符外逐字段相同**（`worker-protocol.ts:269-283`），是「临时播报 + 权威重发」，不是合并 | `924232ed` |
| 重放走 fresh counter，`Last-Event-ID` 不可信 | 重放**是对的**（`router.ts:2412-2423` 写回原始 `eventId`）。真实缺陷相反且更严重，见 G-8 | `924232ed` |
| router 的多行缓冲是 100 KB | 64 KB（`router.ts:676` / `:2838`） | `924232ed` |
| `SSE_EVENT_TO_PROTOCOL['tool_use']` 裂变成两个协议事件 | 映射表本身错了，**且有测试断言它**。legacy→protocol 几乎全是 1:1 改名 | `924232ed` |

第一条的连带后果是真设计洞 → **G-6**：`tool.call_started` 是 durable，
却会带着同一个 `toolCallId` 发两次不同 `input`，协议无字段能表达「这是更正」。

### 11.2 缺口登记从 5 条涨到 9 条

`packages/agent-protocol/GAPS.md`（本轮新建）：

| # | 一句话 | 严重度 |
|---|---|---|
| G-1 | 40 个 `ErrorCode` 里 32 个查无此串 | 高 |
| G-2 | `PermissionRequest` 的 `kind`/`mode`/`expiresAt` 无生产者 | 高 |
| G-3 | 承诺 `checkpointGeneration` 恢复却无 checkpoint 事件 | 中 |
| G-4 | 四个真实事件无 protocol 对应物（research 实际被拆成 3 个） | 中 |
| G-5 | `chat:done` 无字段但 `RunCompletedPayload` 有五个 | 低 |
| **G-6** | **durable 的 `tool.call_started` 双发，协议无法表达 supersede** | **高** |
| **G-7** | 失败位三名（`error` / `is_error` / `isError`），wire 上全可选 | 中 |
| **G-8** | **id 空间 per-session、计数器 per-turn → 第二轮重铸第一轮 id** | **高** |
| **G-9** | **`since` 是装饰性的：声明了版本轴，无任何门禁消费** | **高** |

### 11.3 与 Duya 源码 / clone harness 的对比

- **控制面无法枚举**：`router.ts` 3466 行**没有路由表**，是手写
  `parts[N] === 'lit' && method === 'V'` 条件链。两种正则交叉扫描得到
  **0 个路由注册 / 16 个路径字面量**。加上 180 个 IPC channel、6 个 MessagePort。
  后果：今天**写不出**针对 Duya 自身 API 的一致性测试。
- **clone 侧**：38 个目录中 **21 个**有 ≥120 行的协议模块。对**全部 20 个**
  机械提取 11 个设计维度后,结论是否定性的但有价值：
  **只有 `prime-agent` 同时具备「版本轴 + 逐消息门禁 + 双向能力协商 + 拒绝型握手」。**
  反直觉的数据点：**`codex` 的 `protocol.rs` 是全场最大（6043 行）却没有任何版本协商**——
  协议做得最大 ≠ 做得成熟。
  完整对照、方法边界、以及本轮踩到的 3 个假阳性见
  `docs/architecture/11-protocol-forward-review.md` §2.3–2.5。
- 完整对比与前瞻结论：`docs/architecture/11-protocol-forward-review.md`。

### 11.4 顺带清理

- 清掉最后 **5 处**文档反向引用(`framing.ts` / `capabilities.ts` / `index.ts` /
  `payloads.ts` / `registry.ts`),并修复早前清理时**丢失主语**的两处无头句。
- 关闭 **D5**(router 事件已全量枚举)。

### 11.4b 新增门禁:引用漂移(`test/13-citation-drift.test.ts`,6 断言)

上面 4 条假断言的**共同载体**是注释里没人验证过的 `file:line`。
把它变成门禁:

| 级别 | 断言 | 本轮抓出 |
|---|---|---|
| 1 | 引用能解析到**唯一**文件 | **5 处歧义**(`types.ts` 匹配 63 个文件) |
| 2 | 行号范围在文件内 | 0 |
| 3 | **锚点必须出现在所引范围内** | **2 处** |
| 4 | 外部仓库引用须写明 `external` | 1 处未标注 |

外加**覆盖率地板**(>20 处可检引用、>5 处可跑锚点)——
防止「什么都没匹配到」的空提取器让门禁永远绿。

最典型的一处:`run.ts` 引用 `router.ts:1697` 说 `handleDeleteChat` 在那,
实际在 **1670**。**这句话支撑的结论并没有因此变错**,所以人读代码发现不了。
已用注入假引用的方式验证两级都会红。

> **这是本轮唯一能防止同类错误复发的机制。** 前三轮评审全靠人读代码,
> 而 4 条假断言里有 3 条是人读不出来的。

**新规则**：本包注释里引用其他文件时,**必须写够路径让它唯一可解析**;
能加反引号锚点就加——那是唯一有牙齿的那一级。

### 11.5 新增经验（写进 §5 的教训）

> 收紧 union 之前必须先问「这个值在代码里的真实取值集合是什么」。
> 答不上来只能保持 `string` 加转换点——**编一个集合比没有集合更糟**，
> 因为那是个 host 会去分支的集合。
>
> 推论（本轮最贵的一条）：**编造因果链比编造取值集合更糟**，
> 因为前者会顺带编出设计结论。`tool_use` 那条错误断言不只是命名错，
> 它推出「`is_error` 因合并而丢失」，据此又把 `tool.call_started` 定成 durable，
> 最终造出 G-6 这个洞——**一个假前提，污染了三层下游**。
