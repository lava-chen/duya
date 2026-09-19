# Plan 552 — duya 原生 Workflow：RPA × Agent 融合设计与节点体系

> **Status**: 实施中(Phase 0-7 代码+单测已落地,2026-09-20;Electron 运行时验证与生产 host 接线待办,见文末进度注记)
> **Priority**: P0
> **Created**: 2026-09-20
> **定位**: plan [415](./415-workflow-mode-design.md)（引擎/run/expr/journal 基础架构底稿）的 **RPA 化修订 companion**，
> plan [551](./551-jev-system-one-integration.md)（Jev/System One 决策基础设施）的**终极承接方**（551 Phase 4 的实施归宿）。
> **调研底稿**: [`docs/references/duya-workflow-jev-integration.md`](../../references/duya-workflow-jev-integration.md)（Jev API + duya 内部两条调研线 + 4 仓库对标）、
> [`jev-model-research.md`](../../references/jev-model-research.md)（551 技术底稿）、
> [`rpa-landscape-research.md`](../../references/rpa-landscape-research.md)（开源格局 + 影刀对标）。
> **设计哲学参照**: ZCode dynamic workflow（first-hand 实战总结，见 §2）——"模型生成，代码裁决，独立复核，透明交付"。
> **源码核证**: `xai-org/grok-build`（26.9k★，已浅克隆 `../duya-refs/grok-build`，2026-09-20 深读
> `crates/codegen/xai-workflow/` + `xai-grok-shell/src/session/workflow/`）——§12 开放问题已按源码裁决，
> 新增确定性铁律见 §6.5。
> **对标产品**: 影刀控制台/指令库（企业形态）、Skyvern（确定性优先 + 块级 journal）、n8n（执行快照/挂起恢复/触发幂等）、Agent TARS（GUI agent 事件流）。
> **背景**: 415 定义了"独立后台 run 管理系统"的引擎骨架（YAML + map/when + RunTracker + journal），
> 551 落了决策基础设施（`DecisionClient`/`DecisionService` + computer-use decide 通道）。
> 本 plan 回答最后一块：**RPA 和 agent 怎么在同一个 workflow 里结合**——节点类型体系（权威规格）、
> run 管理工程形态、触发层、控制台最小集，以及执行层的前置修复。

---

## 1. 定位：RPA × Agent 融合的一页答案

**产品承诺**（对齐 ZCode workflow 的本质）：duya 的每个 workflow run 都是
**可审计**（journal 逐节点重放）、**可复跑**（req_hash 缓存，成功节点不重付）、**可修正**
（改 YAML 重跑，已成功节点零成本命中）的后台自动化——"把人一步步干活的过程固化成可编排、
可复核的自动化资产"。

**四类角色节点 = 融合公式**：

```
RPA 骨架（确定性，快/便宜/可审计）      → tool / gui 节点
程序化常识（结构化决策，~0.1s/万分位成本）→ decision 节点（551 DecisionService）
智能肌肉（开放式任务，贵但能干）        → agent 节点（SubagentTool）
人在环（权责边界）                     → human 节点（498 审批卡）
```

分流原则一句话：**能用代码决定的绝不问模型；能用决策模型分类的绝不劳 LLM；只有开放式任务
才进 agent；有不可逆副作用的一律过人。** 这同时是成本模型（决策档比 LLM 便宜 2-3 个数量级）
和审计模型（确定性步骤可重放、可 diff）。

## 2. 设计哲学：ZCode workflow 四原则的 duya 化

ZCode dynamic workflow 实战周期沉淀的四原则与机制，逐条映射为 duya 的设计约束：

| # | ZCode 原则 | duya 552 落地 |
|---|-----------|---------------|
| 1 | **模型生成**：模型只做生成与判断，不做事实层 | LLM 只出现在三处：规划器生成 YAML（415 §7）、agent 节点开放式子任务、decision 降级链末档。tool/gui 节点零 LLM |
| 2 | **代码裁决**：能用代码决定的绝不问模型 | 确定性指令节点直调 ToolRegistry/DesktopBackend；decision 三档降级 `rule → system-one → llm`（551 既有）；`expr.ts` 受限表达式求值 `when`；机器能算的摘要（counts/metrics/页面 state）代码算好再进决策（551 describe 层） |
| 3 | **独立复核（fresh eyes）**：没见过过程的复核者才看得见坑；复核者审计规程本身 | verify 节点独立于 work 节点（verification agent 不继承 work 的上下文，只拿结果与验收标准）；decision 低置信返回 `uncertain` 上交，**绝不静默猜**（551 规则 6/9）；不一致信号（如 done 高置信但有动作提议）追加严格确认（551 规则 8） |
| 4 | **透明交付**：随做随报 + verified/unconfirmed 标注 + 权责边界 | journal 事件**一次写入三用**（持久化记录 = SSE 进度 = 审计轨迹，ZCode `report()` 教训：攒到最后会随 run 失败丢失）；每个结果带 `verified / unconfirmed` 标注，Synthesize 强制区分呈现；破坏性动作（写库/发消息/支付类）只有 human 节点一条路，引擎无自动放行终态副作用的能力 |

**机制对应**（ZCode 已验证机制 → duya 实现）：

| ZCode 机制 | duya 对应 | 出处 |
|-----------|-----------|------|
| journal 重放（world.run/files.read 记录后恢复时重放，不再执行） | `journal.jsonl` + 快照 blob；resume 按 `req_hash` 命中即用缓存结果（415 §5.3 既有，本 plan 补工程形态） | §6 |
| 缓存经济学（actor 名稳定 + ask 字节一致才命中；**常量放控制流不放 ask 文本**） | 重跑/修正时按 `nodeId + req_hash` 跳过 succeeded 节点；规划器把可变参数渲染进 YAML `params` 而非改 prompt 模板——保证"改参数重跑"命中节点缓存 | §6.4 |
| escalation question（单点阻塞提问，run 其余部分继续） | human / 低置信 decision 挂起**只 park 所在分支**，map 兄弟分支继续跑；恢复经签名 resumeToken | §6.3 |
| phase() 阶段图（用户看得到的进度故事） | run 阶段卡：phase 进入/退出/节点完成经 `chat:agent_progress` SSE 推渲染端，控制台按阶段图呈现 | §7 |
| EvalWorkflowSnippet（先测纯逻辑拿 ground truth 再上线） | workflow **dry-run 模式**：validate + rule 档决策 + mock host + 假 backend，fixture 上先拿基线 | §10 |
| AmendWorkflow（修订脚本，已完成步骤缓存导入） | "可修正"语义：YAML 更新 → 新 workflow_version_id → resume 只重跑受影响节点（req_hash 变化检测） | §6.4 |

## 3. 与 415 / 551 的分工边界

| 归属 | 内容 |
|------|------|
| **415 保持权威** | 五层架构、YAML 骨架（§3.1 顶层）、`RunLifecycleTracker` 基类规格（§6.2）、journal req_hash 语义（§5.3）、规划器框架（§7）、不进 popover/不套 413 检查点的红线（§6.4） |
| **551 保持权威** | `@duya/ai` SystemOneClient、`DecisionService`/policy/fallback、computer-use decide 通道（describe/questions/controller/confirm-gate/verdict-bridge）、25 条设计规则约束 |
| **552 新增权威** | 节点类型体系（§4，修订 415 §3.2）、DecisionProvider 在 workflow 的接线（§5，即 551 Phase 4 的实施）、run 管理工程形态（§6，落地 415 §5/§6 的 store/journal/waiting）、触发层（§7，415 原稿缺失）、控制台最小集（§9 Phase 7）、执行层前置修复（§8） |

> 本 plan 评审通过后，415 §3.2 节点 schema、§8 落地步骤以 552 为准；415 其余章节继续有效。

## 4. 节点类型体系（权威规格，修订 415 §3.2）

### 4.1 顶层 schema（在 415 §3.1 基础上扩展）

```yaml
name: string                  # ≤64 kebab-case（415 既有）
description: string           # ≤1024（415 既有）
when_to_use: string           # ≤2048（415 既有）
params:                       # 新增：参数化（Skyvern 简化版，作 resume 缓存键的一部分）
  - name: invoice_id
    type: string              # string | number | boolean | json
    required: true
    default?: unknown
triggers:                     # 新增：持久化触发（§7；缺省 = 仅手动/Slash 启动）
  - cron: "0 9 * * 1-5"       # 复用 405/409 CronStore
  - bot: { mention: true }    # 复用 476 wake bus / 488 inbound
  - http: { path: "/wf/invoice-sync" }   # Agent Server 端点，dedup_key 幂等
phases:                       # ≤8 阶段（415 既有）
  - phase / title / detail / nodes
```

### 4.2 六类节点 + 两原语

```yaml
# ① tool —— 确定性指令（零 LLM，ToolRegistry 直调）
- id: export-excel
  tool: excel.write
  input: { rows: "${extract.output.rows}" }

# ② gui —— computer-use 确定性步骤序列 + verdict + agent 兜底（§4.3）
- id: fill-erp-form
  gui:
    target_app: "ERP*"            # access.ts app 策略白名单
    steps:
      - { do: capture }
      - { do: click, element: "som:3" }
      - { do: type_text, text: "${params.invoice_id}", verify: true }
    max_actions: 20
    on_stuck: agent               # stuck/ambiguous → 升级 GUI agent 循环（LLM 接管）
                                  # status 契约对齐 551 controller 八态：
                                  # done|likely_done|needs_confirmation|error|stuck|ambiguous|blocked|max_actions

# ③ decision —— System One 决策（消费 551 DecisionService，§5）
- id: route-ticket
  decision:
    state: { output: "${read-mail.output}" }
    questions:
      department: { type: choice, criteria: { billing: "...", tech: "..." } }
      urgent:     { type: noul, instructions: "表达紧迫/时限压力吗" }
    thresholds: { urgent: 0.65 }  # 灰区带语义来自 551 policy
    on_low_confidence: ask        # ask（转 human）| default:<label> | skip

# ④ human —— 人在环（权责边界：不可逆副作用唯一通道）
- id: approve-payment
  human:
    via: approval_card            # 498 卡族 + 419 总线
    prompt: "放行 ${context.amount} 元付款？"
    timeout: { hours: 24, on_timeout: escalate }   # escalate | skip | fail（必填，防挂起泄漏）

# ⑤ agent —— 开放式子任务（415 既有，补两条约束）
- id: investigate
  agent: general-purpose
  prompt: "..."
  output_schema?: { }             # 结构化输出（供 decision/gui/when 引用）
  # 约束 a：agent 循环采纳 browser-use 规范——单次调用结构化输出
  #   （评估上一步 + 计划 + ≤N 动作合并一次），重规划用 prompt 注入 nudge 而非额外调用
  # 约束 b：agent 不承担机器能证的验收——验收归 verify/decision（fresh eyes）
  # 约束 c：output_schema 由宿主校验 + 1 次续聊重试（grok host_service 契约，host_service.rs:507-689）；
  #         仍不合格按 on_error 处理

# ⑥ noop —— 占位/汇合（415 既有）
# 原语 map / when —— 415 既有；when 表达式作用域扩展：decision 节点的
# typed answers 进入作用域（551 Phase 4 "decide 原语直接进 when 求值"），如：
- id: billing-path
  when: "route-ticket.department == 'billing' && route-ticket.urgent > 0.65"
```

### 4.3 gui 节点执行语义（RPA 核心，消费 551 Phase 3 通道）

1. **步骤循环在代码层**（ZCode 原则 2）：`describe → ask(decide 通道一次 fan-out) → act → verify`
   由 `packages/computer-use/src/decide/controller.ts` 驱动，LLM 不在环内；
2. **确定性步骤优先**：YAML `steps` 声明的动作直调 `DesktopBackend`（capture/click/type/…），
   `verify: true` 走 verdict 阶梯（454 三态）+ decide 通道佐证（551 verdict-bridge）；
3. **升级阶梯**：verdict `suspected_noop` 连续 N 次 / status `stuck|ambiguous` → 按 `on_stuck`
   升级 GUI agent 循环（LLM 看屏决策，Agent TARS LOOK→ZOOM→ACT→VERIFY 形态）；
4. **审批门**：`needs_confirmation` / irreversible noul → 498 审批卡（551 confirm-gate），
   挂起语义同 §6.3；
5. **事件**：每步 capture（截图引用外置）与动作结果作为 journal 事件落盘（Agent TARS
   environment_input 形态），控制台可逐步重放。

### 4.4 节点执行结果契约（journal 记录，全类型统一）

```ts
interface JournalRecord {
  seq: number;
  kind: 'node_result' | 'decision' | 'approval' | 'artifact' | 'phase';
  nodeId: string;
  attempt: number;                    // Skyvern 块级 attempt 落库语义
  reqHash?: string;                   // 415 §5.3：sha256(kind+canonical payload) 前 16 字节
  result?: unknown;                   // 重放缓存值
  status: 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped' | 'waiting';
  verification?: 'verified' | 'unconfirmed';  // ZCode fresh-eyes 标注；verify 节点产出
  errorClass?: string;                // Skyvern 17 类分类学（regex 先行，Jev choice 归因兜底）
  atMs: number;
}
```

> journal 事件即 SSE 进度事件（同一记录双写：文件 + `chat:agent_progress`）——"随做随报"，
> run 中断时已报条目不丢。

## 5. DecisionProvider 在 workflow 的接线（= 551 Phase 4 实施）

- **不新建决策模块**：`packages/agent/src/decisions/`（551 Phase 2）是唯一通道；本 plan 只做
  workflow 侧适配器 `packages/agent/src/modes/workflow/decision-adapter.ts`。
- 六落点（对应 551 问题模板库 route/risk/verify/done）：

| 落点 | 问题形态 | 替代现状 |
|------|----------|----------|
| ① `when` 非结构化路由 | decision 节点 typed answers 进表达式作用域 | 415 受限表达式只能引用结构化 output |
| ② map 结果聚合 | 一次请求 N 问（551 原则 2 fan-out 红利） | Synthesize 阶段 LLM 全量读 |
| ③ verify 分档 | 确定性 verdict（gui/454）→ decision score/noul → verification agent | 单一 LLM verification |
| ④ 失败归因与 on_error 动态策略 | Skyvern 17 类 regex 为 rule 档，Jev choice 归因为决策档 → retry/skip/修复分支 | 静态 on_error 配置 |
| ⑤ 规划器高风险判定 | 节点级 risk noul 预筛（551 Phase 4 既有项） | 规划器 LLM 自评 |
| ⑥ 无人值守审批路由 | 放行 noul + confidence 阈值：阈值内自动放行并审计，否则 human 挂起 | 全阻塞等 renderer 或全放行 |

- **降级链不变**（551 §2 规则 10）：无 key / 超时 / 失败 → rule → llm structured-output，
  workflow 行为零破坏；decision 节点在无 Jev 环境下等价于"rule + llm 档"。
- **阈值即审批语义**：`on_low_confidence: ask` 与 415 tracker `awaiting_confirm`、498 审批卡
  共用同一 CAS resolver——Jev 官方"阈值决定自动 vs review"的 duya 化。

## 6. Run 管理层（n8n/ZCode 形态落地 415 §5/§6）

### 6.1 Store（core-db 新表，键控对齐 413c 风格）

```
workflow_runs            id, workflow_name, workflow_version_id,
                         status(RunLifecycleState), trigger_kind, dedup_key UNIQUE,
                         params_json, wait_till(INDEX), retry_of, created_at, ...
workflow_run_snapshots   run_id 1:1 → blob（冻结 YAML + 节点栈 + journal 事件序列）
                         # 大 payload（截图）外置文件路径引用，不进 blob
```

- 执行 = 元数据行 + 1:1 快照 blob（n8n `execution-entity` + `execution-data` 形态）；
  `workflow_version_id` 保证断点续跑行为可复现（"可修正"：改 YAML = 新版本，旧 run 不变）。
- `dedup_key` 唯一索引做触发器幂等（n8n 语义：规范化触发时刻/路径）。

### 6.2 崩溃对账（不盲目重跑）

启动/心跳时比对 `workflow_runs.status ∈ {running}` vs 引擎在途 run，悬空 → 标 `interrupted`
（415 tracker 既有状态，resume 回 active 且取消 ghost agent）——**绝不自动重跑副作用重的 run**，
由用户或 journal 重放决定（n8n `maxStalledCount:0` + 对账标 crashed 的对应物）。

### 6.3 挂起-恢复（human / 低置信 decision / timeout）

- 挂起 = status `waiting` + `wait_till` 落库，**零内存占用**；所在分支 park，
  map 兄弟分支继续（escalation 语义）。
- 恢复两通道：(a) 审批卡回调携带**签名 resumeToken**（timing-safe 比较，防重入
  AlreadyResuming 守卫）；(b) wait-tracker 定时扫描（60s 级，复用 cron tick 进程）。
- **marker 模式**（grok `await_user` 语义，E:754-773）：挂起前先写 journal marker（null 结果），
  resume 命中 marker 即放行；**不向暂停节点回传载荷**——审批结果（approve/deny）作为
  `approval` journal 记录落盘，由后续 decision/agent 节点读取。需要用户补充输入时，
  输入进入"世界"（会话/文件），不注入暂停点。

### 6.4 缓存经济学（"可复跑/可修正"的实现细则）

- 重跑/修正：按 `nodeId + reqHash` 命中 journal 缓存即跳过（415 §5.3）；`params` 变化只影响
  引用它的节点 reqHash——**改参数重跑时未受影响节点零成本命中**（ZCode AmendWorkflow 对应物）。
- 规划器约束：YAML 模板与可变参数分离（`params` 渲染进节点 input/prompt），保证模板级缓存键
  稳定（ZCode 教训：常量放 ask 文本会废掉整条缓存链）。
- `BudgetExceeded`/`Cancelled` 不写 journal（可重放终止）；`Failed` 尾部 host 错误哨兵
  resume 前剪除（415 §5.3 既有）。

### 6.5 确定性铁律与预算（grok-build 源码核证新增）

- **节点定义禁时间与随机源**：YAML 表达式/steps 里禁止 timestamp/随机/sleep 类求值
  （grok Rhai 解释器直接禁用，engine.rs:128-150）；超时、重试等待全部住在 host 代码
  （node-runner）——否则断点续跑必 divergence。
- **decision 是 host-call**：decision 节点结果必须入 journal（`kind:'decision'` + reqHash），
  resume 回放缓存值，**绝不重问**（分类器有随机性，重问破坏确定性重放）。
- **预算与并发分离**（grok host_service/tracker 形态）：LLM 调用计数预算走
  reserve→spawn→release 三步记账（防 resume 双计费，E:381-475），独立于并发 semaphore；
  **gui 确定性步骤不占 LLM 预算**（只占并发与 host-call 上限）。
- 预算默认值建议：agent 调用预算默认 128、上限 1024；并发默认 `min(32, cores)`；
  host-call 总上限 10 000（全部对齐 grok lib.rs:16-19，可配置）。

## 7. 触发层（415 原稿缺失，接线为主）

| 通道 | 复用 | 幂等 |
|------|------|------|
| 手动 | `/workflow <name>` Slash Command + save-as（415 §7.1） | — |
| 定时 | 405/409 CronStore（`cron.jobs` TOML 唯一权威源） | dedup_key = 规范化触发时刻 |
| 事件 | 476 wake bus + 488 bot inbound（企微/飞书/Telegram 消息触发） | dedup_key = inbound 消息 id |
| HTTP | Agent Server 新端点 `POST /workflow/<name>/trigger`（影刀 OpenAPI 对标；鉴权走既有 gateway 分组） | dedup_key = header 或 body 幂等键 |

触发统一入口 `WorkflowManager.launchFromTrigger(trigger, params)`：先查 `dedup_key` 唯一索引，
命中即返回既有 run（at-least-once 投递下不重复执行）。

## 8. 执行层前置修复（workflow 依赖 computer-use 前，可与 551 Phase 3 合并执行）

- [x] daemon spawn 路径去硬编码（`DUYA_COMPUTER_USE_DEMO_ENTRY` env + 兄弟目录发现，
      `E:/Projects` 硬编码已移除）
- [x] `computer_use` / `computer_use_context` / `computer_use_decide` 注册进 builtin ToolRegistry
      （`exposeMode: 'hidden'`——workflow 枚举直调可用，LLM 表面零变化）
- [x] 无人值守审批通道：`createUnattendedConfirmGate`（deny-by-default kind 策略 + 安全预算 +
      审计 sink，5 单测）；gui-runner 的确认门与 decision 升级门接同一 498 通道
- [x] 补写 plan 519 文档本体（`./519-computer-use-harness-gaps.md`）
- [x] macOS 权限引导文档 + cua-driver 分发方案（`docs/product-specs/computer-use-macos-permissions.md`；
      二进制随包分发本体为后续基建项,方案已定）

## 9. 落地步骤

### Phase 0 — 前置修复（§8 五项）
- [x] 五项全落地（见 §8）
- **Gate**: ✅ 仓库内无硬编码外部路径；`computer_use` 可经 ToolRegistry 枚举；typecheck:all 0 错

### Phase 1 — 地基（= 415 原 Phase 1 + 本 plan 扩展）
- [x] `packages/agent/src/modes/workflow/schema.ts`（zod：§4.1 顶层 + §4.2 六类节点）
- [x] `validate.ts`（命名/阶段/引用存在/表达式合法/无环/跨阶段前向引用拦截/decision 阈值与默认值/human timeout 必填）
- [x] `expr.ts`（415 §4.1 四类表达式 + decision answers 作用域 + `${...}` 插值与引用提取）
- [x] `engine/run-lifecycle-tracker.ts`（裁决 #4 小内核：纯转移矩阵 + paused/terminal 判定 +
      history cap 64 + 折叠语义;`tracker.ts` WorkflowRunTracker 挂 workflow 专属字段）
- **Gate**: ✅ 63 单测全绿 + `npm run typecheck:all`

### Phase 2 — 执行器（tool / agent / decision / human 先通）
- [x] `node-runner.ts`（四类 × on_error 动态策略：errorClass 分类 → retryable 消耗 max_retries → skip/fail）
- [x] `decision-adapter.ts`（§5：消费 551 DecisionService,per-question 阈值覆盖,typed answers 进 when 作用域,无后端零破坏）
- [x] `human-runner.ts`（§6.3 marker 语义：挂起前写 waiting marker,审批结果独立落 approval 记录,await/suspend 双模式,on_timeout skip/fail/escalate）
- [x] `map-runner.ts` + `engine.ts` + `host.ts`（BudgetLedger reserve→commit/release 与并发 semaphore 分离;阶段循环 + 相位内拓扑排序;SuspensionSignal → 签名 resumeToken waiting outcome）
- [x] `journal.ts`（reqHash 缓存经济学 + trailing failure 剪除 + live listener 三用通道）+ `resume-token.ts`（HMAC + timingSafeEqual）
- **Gate**: ✅ fixture 级 e2e（mock host）全类型节点跑通（68 测试）;dry-run 模式产出基线报告

### Phase 3 — gui 节点（依赖 551 Phase 3 controller + Phase 0 修复）
- [x] `gui-runner.ts`（§4.3 五点语义:确定性步骤 → suspected_noop 阶梯 → on_stuck agent 兜底
      → 八态 status 契约映射 → needs_confirmation 审批门;decision 记录绝不重问）
- [x] `gui-artifacts.ts` journal 截图事件外置存储（Memory/Fs store,日志只存引用）+ 重放读取
- **Gate**: ✅ 假 backend fixture 全八态 status 覆盖（15 测试）;⏳ Electron 手动冒烟（真实记事本/表单场景）待办

### Phase 4 — Run 管理
- [x] core-db `workflow_runs` / `workflow_run_snapshots`（迁移 26/27,dedup_key UNIQUE,wait_till 索引）
- [x] `manager.ts`（WorkflowManager over store port:launch 校验+dedup+blob 先建,journal 双写 blob+listener,onRunFinished 唤醒钩子）+ db-bridge `workflowRun:*` + agent `workflowRunDb` IPC client
- [x] 崩溃对账（§6.2 reconcileStaleRuns:孤儿 running 类 → interrupted,parked 不动）+ 缓存重放（§6.4 nodeId+reqHash）+ resumeToken 校验/timeout 应用
- **Gate**: ✅ kill -9 恢复测试（对账 → interrupted → resume 缓存命中零重付）单测 6 个;⏳ 手动 e2e 待办

### Phase 5 — 规划器 + Verify
- [x] `planner.ts` LLM 生成 YAML（415 §7：一次带错重试,二次失败即停）+ risk 预筛（规则 regex
      先行 + Jev risk noul 兜底）+ `launchFromPlan`/`confirmLaunch` 高风险必停（awaiting_confirm）
- [x] `verify.ts` verify 分档编排（确定性 journal 标注 → decision noul over 机器算好的 summary →
      verification agent fresh-eyes；failed 节点封顶 unconfirmed;`verified/unconfirmed` 标注落 journal）
- [x] 完成自动唤醒（裁决 3:`onRunFinished` 钩子,Phase 6 触发层接 mailbox/wake）
- **Gate**: ✅ 规划-校验-执行-验证全链 fixture（20 测试）；高风险样例必停

### Phase 6 — 入口与触发层（§7 四通道 + dedup 幂等 + save-as）
- [x] `trigger.ts` 统一入口 `launchFromTrigger`:四通道 dedup 键规范化（cron 触发分钟 ISO 取整 /
      bot 入站消息 id / http 幂等键 / manual 无）+ 通道门控（def 未声明即拒绝）
- [x] `workflow-files.ts` save-as 注册表（`~/.duya/workflows/`,load 全量重校验,路径安全）
- [x] ⏳→落地剩余:Electron 侧接线（Agent Server `POST /workflow/<name>/trigger` 路由、cron tick
      调用 tickWaitTracker/launchFromTrigger、slash command、生产 WorkflowHost 绑定
      ToolRegistry/SubagentTool/审批管线）归入生产 host 接线 pass
- **Gate**: ✅ 四通道触发单测（幂等键命中不重跑,8 测试）；⏳ cron 实触发手动验证待办

### Phase 7 — 控制台 UI 最小集（对标影刀控制台最小集,裁决 3 收缩版）
- [x] `WorkflowPanel` run 列表 + 状态族着色 + 触发徽标 + 耗时 + pauseMessage;展开 journal
      视图（phase trail chips + verified/unconfirmed 标注 + errorClass）;完成态删除;
      `workflow:*` IPC + preload surface + registry/侧栏入口 + en/zh i18n
- [x] journal 逐步重放视图（含截图事件引用——截图外置存储 §4.3 落 Phase 3）
- [x] 审批待办:复用既有 498 审批卡体系（审批入口不经 console,见 498）;触发器配置/重跑入口
      依赖生产 host 接线,归入 Electron 集成 pass
- **Gate**: ✅ 5 组件测试 + 2 handler 测试;⏳ Playwright MCP 冒烟 + 手动 Electron 验证待办

## 10. 测试策略

1. **纯函数单测**：tracker 转移矩阵（415 §6.2.7）/ expr / validate / policy 阈值。
2. **fake transport fixture**（551 风格）：SystemOneClient 契约、decision-adapter 降级链、
   八态 gui controller（假 backend + 假页面 state）。
3. **dry-run 基线**（ZCode EvalWorkflowSnippet 对应物）：validate + rule 档 + mock host
   全链跑通先拿 ground truth，再接真实 host——防"错误的统计无声混过"。
4. **e2e**：kill -9 恢复、四通道触发幂等、审批挂起-恢复；Vitest + Playwright `_electron`。

## 11. Non-Goals

- **不做可视化画布编辑器**（影刀式拖拽）——控制台先做列表/YAML/重放，画布另立 plan。
- **不做多机机器人舰队、移动端自动化**（企业版后期）。
- **不改变 419 权限语义**（decision 风险预筛只产建议，551 既有红线）。
- **不做脚本语言节点**（Rhai/JS）——保持 map/when 受限表达 + decision，表达力缺口由
  agent 节点补（415 §1.3 论证继续有效）。
- **无 Jev key 时行为零变化**（551 §4 既有红线）。

## 12. 风险、已裁决与遗留问题

| 风险 | 对策 |
|------|------|
| 范围爆炸（6 类节点 runner + store + 触发 + UI） | Phase 切分严格 gate；Phase 2/3/6 可独立交付价值（decision/tool 先行即可用） |
| 551 排期依赖（decision-adapter/gui-runner 依赖 551 Phase 2/3） | 551 P0 在前；本 plan Phase 2 起逐项对齐；551 未落地前 Phase 2 用 llm 档占位 |
| Jev 外部依赖（闭源/定价/SLA） | 551 降级链 + DecisionClient 抽象；workflow 层零硬依赖 |
| GUI 节点跨平台不一致 | Phase 0 修复前置；macOS 先走 MCP cua-driver 路线 |
| 审批挂起泄漏（无 timeout 的 human 节点） | schema 强制 `timeout.on_timeout`；validate 拦截 |

**已裁决（2026-09-20，grok-build 官方源码核证，`../duya-refs/grok-build`）**：

1. **gui 步骤失败后不允许 decide 通道热改动作序列**。grok 引擎绝不重规划：单 agent 失败 =
   可 catch 的 runtime error（E:325-329），parallel 软失败 = 该项 null、兄弟继续（E:643-647）；
   重规划只有两条正路——脚本内预写分支（= duya 的 decision 节点分支）或**编辑计划 + 新 run**
   （resume 检测脚本/args 变更即 divergence fail-loud，manager.rs:178-186）。
   → §4.3 `on_stuck: agent` 语义维持；decision 分支必须预定义；"resume 与改计划互斥"写入引擎契约。
2. **params 保持四基本类型，不引入 zod schema 引用**。grok 全动态、四层运行时防线：
   meta 首语句静态抽取（meta.rs:51）/ `validate_only` canned-host 干跑整条路径（validate.rs:63-170）/
   args 存在性脚本内守卫 / agent 输出 JSON Schema 契约宿主校验 + 1 次续聊重试（H:507-689）。
   → duya 补齐后两防线：output_schema 宿主校验（§4.2 约束 c）+ dry-run 即 validate_only（§10.3）。
3. **控制台不拆 553**。grok TUI 最小集很小：scrollback 块（name/objective/状态符/phase trail/
   活跃 agent 数/耗时，`xai-grok-pager/.../workflow.rs:32-130`）+ `/workflow runs` 仪表盘 +
   pause/resume/stop/save + 完成自动唤醒注入（`run_loop.rs:2105-2150`，无需轮询）。
   → Phase 7 按此收缩；"journal 逐步重放视图"降为可选增强；**完成自动唤醒**（注入续写 prompt
   到宿主会话）补进 Phase 5——可复用 duya 既有 mailbox/wake 机制。
4. **RunLifecycleTracker 抽小内核，不抽抽象基类**（修订 415 §6.2，415 已同步修正注记）。
   grok 的 goal_tracker 与 workflow_tracker 是**复制式平行实现**：无共享 trait/基类，仅共享
   `PauseKind` 词汇枚举（xai-workflow/lib.rs:43），状态结构体互不引用。
   → duya 抽"小内核"：状态枚举 + paused 族判定 + revision + history cap(64) + elapsed 折叠 +
   快照消毒；goal/workflow 各自持有专属字段。415 §6.2 的抽象基类骨架降级为参考实现。

**遗留开放问题（评审时定）**：
1. 415 §9.1 高风险动作规则集是否可配置（grok 无对应物，保留开放）。
2. `dedup_key` 生成规范（cron 触发时刻的规范化格式）待 Phase 6 定。
3. map 兄弟分支并发上限与 host-call 总上限的配额分配（建议 gui 步占并发、agent 步占预算，
   两者都计入 host-call 总上限）。

---

## 13. 实施进度注记（2026-09-20,Phase 0-7 代码 + 单测落地）

**已交付**（commits 自 `96155a84` 起,分支 dev/mac）：

| 层 | 交付物 | 测试 |
|----|--------|------|
| Phase 0 | daemon 路径 env+兄弟目录发现;computer-use 三工具 hidden 注册;无人值守确认门;519/权限文档 | 5 |
| Phase 1 | `workflow/schema.ts` + `validate.ts` + `expr.ts` + 小内核 `run-lifecycle-tracker.ts` + `tracker.ts` | 63 |
| Phase 2 | `journal.ts`/`resume-token.ts`/`host.ts`/`decision-adapter.ts`/`human-runner.ts`/`node-runner.ts`/`map-runner.ts`/`engine.ts` | 68 |
| Phase 3 | `gui-runner.ts` + `gui-artifacts.ts`(八态全覆盖) | 15 |
| Phase 4 | core-db WorkflowRunStore(迁移 26/27) + `manager.ts` + db-bridge/db-client 接线 | 11 |
| Phase 5 | `planner.ts` + `verify.ts` + manager 高风险门/verify/唤醒钩子 | 20 |
| Phase 6 | `trigger.ts` + `workflow-files.ts` | 8 |
| Phase 7 | `WorkflowPanel` + `workflow:*` IPC + preload + registry/i18n | 7 |

合计 190+ 新单测全绿;`npm run typecheck:all` 0 错。

**待办（按依赖序）**：

1. **生产 WorkflowHost 绑定**（Electron/agent worker）：`host.runTool` → ToolRegistry
   executor 直调;`host.runAgent` → SubagentTool/runAgentSync;`host.requestApproval` → 498
   审批卡管线;`DecisionService`/`LlmDecisionFallback` 按 config 装配;gui port →
   `computer-use:execute` IPC。
2. **Electron 触发接线**：Agent Server `POST /workflow/<name>/trigger`(幂等键透传)、
   cron tick 绑定 `launchFromTrigger`(405/409 CronStore)、bot inbound(476/488)、
   `/workflow <name>` slash command、`onRunFinished` → mailbox/wake 注入。
3. **手动验证**（本 plan 各 Gate 明确要求 Electron 运行时的部分）：Phase 3 真实桌面冒烟、
   Phase 4 kill -9 手动 e2e、Phase 6 cron 实触发、Phase 7 Playwright MCP + Electron 验证。
4. 本机环境限制：better-sqlite3 v13 无 Node 20.20.2 darwin-x64 预编译(源码编译段错误),
   sqlite 依赖套件在本机跳过/失败——workflow-store/handler 测试在健康环境运行
   (与既有 core-db 套件同一 skipIf 守卫)。
