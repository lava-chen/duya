---
name: workflow
title: workflow — duya 原生 Workflow 编排
description: "用于编写、校验、调试和重新提交 duya 原生 workflow：把 RPA(gui 节点)与 tool/decision/human/agent 节点组合成声明式 YAML，并用 map/when 原语编排——选择节点类型、设计 when 表达式、处理确定性 RPA、把不可逆副作用关进 human 节点、设计 params 以获得可复跑缓存、在保存前做 dry-run 校验。当用户提到 workflow/工作流/自动化流程编排、或要求把"按步干活的流程固化"时使用。"
when-to-use: "仅用于编写/修改 duya workflow 定义(YAML)。单一委托或几个独立查询属于普通 Agent 调用，不应套 workflow。"
---

# 编写 duya 原生 workflow

duya 的 Workflow 引擎把「人一步步干活的流程」固化成**可审计、可复跑、可修正**的声明式 YAML 资产(plan 552)。
作者写的是一份 YAML 定义，不是脚本——引擎负责解析、校验、调度、缓存和重放。

> 与 ZCode/Codex 的 `CreateWorkflow`(TS 命令式脚本,subagent()/world.run())是**两套不同的心智模型**。
> 本 skill 是 duya YAML 版的判断层。两套名字在 duya 内部不同：duya 引擎叫 workflow(声明式 YAML)，
> 不要套用 Codex 的 TS 脚本 API。

权威规格在源码里，**以代码为准**：
- 顶层/节点 schema：`packages/agent/src/modes/workflow/schema.ts`
- 静态校验规则：`packages/agent/src/modes/workflow/validate.ts`
- 受限 `when` 表达式：`packages/agent/src/modes/workflow/expr.ts`
- 生成侧权威 system prompt：`planner.ts` 的 `PLANNER_SYSTEM_PROMPT`(模型生成 YAML 时应严格照此)
- 定义库/双 scope：`packages/agent/src/modes/workflow/workflow-files.ts`
- 设计文档：`docs/exec-plans/active/552-workflow-rpa-agent-design.md`

## 分流原则(一页答案)

四种角色节点 = 融合公式。**能用代码决定的绝不问模型；能用决策模型分类的绝不劳 LLM；只有开放式任务才进 agent；有不可逆副作用的一律过人。**

| 节点 | 干什么 | 成本/审计 |
| --- | --- | --- |
| `tool` | 确定性指令，零 LLM，直调 ToolRegistry | 便宜、可重放 |
| `gui` | RPA：computer-use 确定性步骤序列(桌面自动化) | 确定性步不占 LLM 预算 |
| `decision` | 结构化分类/打分/是非，System One 决策 | ~0.1s，比 LLM 便宜 2-3 个量级 |
| `human` | 人在环——**不可逆副作用(付钱/发消息/删除)的唯一通道** | 审批卡，权责边界 |
| `agent` | 开放式子任务(SubagentTool) | 贵但能干 |

原语：`map`(对一组元素扇出，必须是 agent 或 tool) / `when`(条件边，按节点求值)。

## 顶层与节点骨架

```yaml
name: invoice-sync          # kebab-case, <=64, 必填
description: "..."          # <=1024, 必填
when_to_use: "..."          # 可选, <=2048
params:                     # 可变参数(是 resume 缓存键的一部分)
  - name: invoice_id
    type: string            # string | number | boolean | json
    required: true
triggers:                   # 可选;缺省 = 仅手动/Slash 启动
  - cron: "0 9 * * 1-5"
phases:                     # 1..8
  - phase: ingest          # kebab-case
    title: 抓取对账单        # <=128, 展示给用户
    detail: "..."          # 可选
    nodes:
      - id: fetch          # kebab-case;同一个 phase 内唯一,且全流程唯一
        tool: excel.read
        input: { file: "${params.invoice_id}.xlsx" }
```

每个节点**恰好声明一种类型**(`tool` / `gui` / `decision` / `human` / `agent` / `noop`);
`map` 只允许包一个 agent 或 tool。公共字段：`when`、`on_error`(`skip|fail|retry`)、`max_retries`(0..3)。

## 六类节点怎么写

```yaml
# tool —— 确定性指令(零 LLM)
- id: write-rows
  tool: excel.write
  input: { rows: "${extract.output.rows}" }

# gui —— RPA 确定性步骤序列 + 兜底
- id: fill-erp
  gui:
    target_app: "ERP*"            # app 策略白名单
    steps:
      - { do: capture }                            # 先截图拿 SOM
      - { do: click, element: "som:3" }            # SOM 索引 1-based
      - { do: type_text, text: "${params.invoice_id}", verify: true }
    max_actions: 20
    on_stuck: agent               # stuck/ambiguous → 升级 GUI agent 兜底

# decision —— 结构化决策(默认绝不静默猜)
- id: route
  decision:
    state: { output: "${read.output}" }
    questions:
      department:
        type: choice
        criteria: { billing: "...", tech: "..." }
      urgent:
        type: noul                 # 表达紧迫/时限压力吗
        instructions: "..."
    thresholds: { urgent: 0.65 }
    on_low_confidence: ask         # ask(转 human) | skip | default:<label>

# human —— 不可逆副作用唯一通道;timeout.on_timeout 必填
- id: approve
  human:
    via: approval_card
    prompt: "放行 ${params.amount} 元付款？"
    timeout: { hours: 24, on_timeout: escalate }   # escalate|skip|fail

# agent —— 开放式子任务
- id: investigate
  agent: general-purpose
  prompt: "调查 ${read.output.path} 的根因"
  output_schema: { }              # 可选的 JSON schema;宿主校验 + 1 次重试

# noop —— 占位/汇合
- id: join
  when: "route.department == 'billing'"
  noop: true

# map —— 对数组扇出(包 agent 或 tool);用 ${as} / ${as.field} 引用元素
- id: audit-files
  when: "count(extract.files) > 0"
  map:
    over: "${extract.files}"
    as: f
    parallel: true
    concurrency: 4
  agent: general-purpose
  prompt: "审计 ${f.path} 的安全问题"
```

## when 表达式(受限)

`when` 求值结果 false → 该节点被跳过(记录，不阻塞)。表达式**只能**用：
引用 `node.output` / `node.succeeded` / `params.x` / `nodeId.<decisionQuestion>`、
比较 `== != > < >= <=`、逻辑 `&& || !`、聚合 `any() all() count()`。
**没有函数、没有时钟、没有随机源**。examples.md 里有路由写法，patterns.md 有 `map`+`when` 组合。

## 确定性铁律

- YAML 里**禁止 timestamp / 随机 / sleep / Date.now()**——否则断点续跑必 divergence。
- gui 步骤**没有 `wait`**：落定时机由宿主循环掌握，不写进 YAML。
- decision 是 host-call，结果**必须入 journal 且绝不重问**(分类器有随机性，重问破坏确定性重放)。
- tool/decision 节点零 LLM；gui 确定性步骤也不占 LLM 预算(只占并发与 host-call 上限)。

## 保存前必须做

1. **文件放对位置**(`workflow-files.ts` 双 scope，项目 shadow 全局)：
   - 项目(随 git 走)：`<项目>/.duya/workflows/<name>.yaml`
   - 全局：`~/.duya/workflows/<name>.yaml`
   - 文件名 = kebab-case 的 `name`，必须以 `.yaml` 结尾。
2. **重校验**(validate.ts)：命名/阶段数/引用存在/when 表达式合法/无环/跨阶段前向引用/decision 阈值/human `timeout.on_timeout` 必填。加载时每读必校验，坏文件**fail loud**，不静默执行。
3. **节点输出引用(模板插值 `\${...}`)**：只能引用**前面**(同 phase 或更早)节点的 output；表达式越界就不得引用。把可变值放进 `params`，由 `${params.x}` 引用——不要把它们揉进 description/prompt 字面量(否则改参数会打废整条缓存链)。
4. **先烤验再上线**：拿一小段(YAML 片段)先跑 `validateWorkflow` 的 rule 档得基线，再接真实断言。改动流程前先过校验，别靠跑真实 run 试错。

## 风险预筛与权责

- planner 先用**规则正则**预筛高风险 tool 名：`pay|payment|send|post|publish|delete|drop|truncate|write|push|deploy|purchase|transfer|email|message` → 命中即 `awaiting_confirm`；`gui` 节点默认保守也先停一停确认(Jev 兜底)。
- **human 节点就是那道闸，不标记为风险**——设计时把不可逆副作用**主动放进去**，不要靠工具本身放假。
- 低置信 decision 返回 `uncertain` **上交给人类，绝不静默猜测**；不一致信号(如 judged done 高置信但有动作提议)追加严格确认。

## 生成与重提(用 code 裁决，别全文重贴)

- 生成：把目标 + 可用 agent 列表 + 权威 schema(见 `PLANNER_SYSTEM_PROMPT`)交给 LLM 产一份 YAML，再让 `validateWorkflow` 裁决；**错一次带整个错误列表回喂一次，二次仍失真就停**，绝不产半吊子的 plan。
- 校验失败时，**按 `path: message` 定位改那一个字段**再重提——不要整段重写。
- 修订重跑：改动会让部分节点 `reqHash` 变化；保持 `params` 分离、名称稳定，未受影响节点零成本命中缓存(改参数重跑只重付受影响节点)。

## 运行语义(透明交付)

- 每个结果带 `verified / unconfirmed` 标注；机器能算的(计数/指标/页面 state)由代码算好再进 decision/验证，不靠 agent 自证。
- 挂起(human/低置信 decision)只 park 所在分支，`map` 兄弟分支继续；崩溃对账把孤儿 `running` 标 `interrupted`，**绝不自动重跑副作用重的 run**。
- journal 事件一次写入三用(持久化记录 = SSE 进度 = 审计轨迹)，「随做随报」，run 断了已报的也不丢。

## 反模式

| 你写了 | 代价 |
| --- | --- |
| 该用 `decision` 却塞了个 `agent` 去分类 | 为 0.1s 能搞定的分类付一整个 LLM 会话 |
| 不可逆副作用用了 `tool` 而不是 `human` | 越过了引擎唯一的人权通道，无审批就执行 |
| gui 步骤里写 `wait` / sleep | 违反确定性铁律，断点续跑 divergence |
| 把可变值揉进 description/prompt 字面量而非 params | 改那一个参数重写所有提及它的文本→缓存全废 |
| `when` 里用了函数/时钟/随机 | 校验/replay 直接失败 |
| 写了带 star 的泛化 `map`(无 `when`/`count` 兜底) | 空数组扇出空跑，或超大扇出失控 |
| 靠跑真实 run 试一个解析函数/表达式的正误 | 校验器与 dry-run 本来能同步回答 |
| 低置信 decision 处静默猜一个默认 | 违反"绝不静默猜"，结果进 journal 无法重放 |

## 参考

- `packages/agent/src/modes/workflow/patterns.md`(本 skill 同目录)——节点拓扑目录：RPA 骨架、路由/分类、条件扇出、人在环门控、两档校验。
- `packages/agent/src/modes/workflow/examples.md`(本 skill 同目录)——完整可跑的 YAML 工作流。