# duya workflow 节点编排模式

一套「节点拓扑目录」。每条说明何时选这种形状，然后用正确的 YAML 展示。
片段是**碎片**，不是完整可跑的 workflow——完整样例在 `examples.md`。

## 1. RPA 骨架：抓→填→交(全部 gui，零 LLM)

**何时**：对固定桌面应用做确定性的「截图定位→点击→输入」，例如填 ERP 表单。

```yaml
phases:
  - phase: fill-form
    title: 填写 ERP 表单
    nodes:
      - id: open-app
        gui:
          target_app: "ERP*"
          steps: [{ do: capture }]
          on_stuck: agent
      - id: fill-fields
        gui:
          target_app: "ERP*"
          steps:
            - { do: click, element: "som:2" }
            - { do: type_text, text: "${params.invoice_id}", verify: true }
            - { do: click, element: "som:4" }
            - { do: type_text, text: "${extract.amount}", verify: true }
            - { do: key, key: "enter" }
          max_actions: 20
```

关键点：**第一步永远是 `capture`**(截图拿 SOM)，之后所有 `click`/`type_text` 用 `som:<1-based>` 引用屏幕元素。`verify: true` 走 verdict 阶梯。**不写 wait**(落定时机归宿主)。无 LLM。

## 2. 路由 / 分类(decision 先行，别用 agent)

**何时**：把流程按**结构化**标准(部门、优先级、是否紧急)分派。这是 decision 的主场。

```yaml
# 前置:一个 tool 已产出 Read。state/output 来自它的输出。
- id: route-ticket
  decision:
    state: { output: "${read.output}" }
    questions:
      department:
        type: choice
        criteria:
          billing: "与费用/账单/发票相关"
          tech: "与故障/报错/技术相关"
      urgent:
        type: noul
        instructions: "工单是否表达紧迫/时限压力"
    thresholds: { urgent: 0.65 }
    on_low_confidence: ask           # 低置信 → 交人类，绝不静默猜

- id: billing-path
  when: "route-ticket.department == 'billing'"
  agent: general-purpose
  prompt: "推进计费工单，依据:${read.output}"

- id: tech-path
  when: "route-ticket.department == 'tech' && route-ticket.urgent > 0.65"
  agent: general-purpose
  prompt: "紧急处理技术工单"
```

decision 的 typed answers(`route-ticket.department`)可**直接进 `when` 求值**。灰区由 `thresholds` 与 `on_low_confidence` 决定。

## 3. 人在环门控(不可逆副作用唯一去处)

**何时**：付钱、发消息、删除、发布——有不可逆副作用。这是 `human` 节点唯一合法去所。

```yaml
- id: approve-payment
  when: "calculate.total > 0"
  human:
    via: approval_card
    prompt: "放行 ${calculate.total} 元付款给 ${extract.vendor}？"
    timeout: { hours: 24, on_timeout: escalate }   # 必填,防挂起泄漏
```

`timeout.on_timeout` 三选一(`escalate|skip|fail`)，schema 强制必填。审批结果作为 `approval` journal 独立记录，由后续 decision/agent 节点读取；**不给暂停节点回传载荷**。

## 4. 条件扇出(map)：逐元素 agent 或 tool

**何时**：同一问题作用在一组元素上(一批文件、一批记录)，想并行处理。

```yaml
- id: extract-files
  tool: glob.list
  input: { pattern: "src/**/*.ts" }

- id: audit-each
  when: "count(extract-files.files) > 0"
  map:
    over: "${extract-files.files}"   # 取其实在的数组字段
    as: f
    parallel: true
    concurrency: 4
  agent: general-purpose
  prompt: "审计 ${f.path} 的正确性问题;只报真问题"
```

`map.over` 必须是一个数组表达式。用 `${as}` / `${as.field}` 引用元素。带 `when`/`count()` 兜底，避免空数组空跑或超大扇出失控。`map` **只包一个 agent 或 tool**。

## 5. 两档校验(机器能算的归代码，别让 agent 自证)

**何时**：流程的验收是可机器检查的(构建过、测试绿、字段值对)，就该由 `tool`/`decision` 决定，而不是 agent 一句"通过了"。

```yaml
- id: build-check
  tool: shell.build
  input: { target: "release" }
  on_error: retry
  max_retries: 2

- id: report-result
  decision:
    state: { output: "${build-check.output}" }
    questions:
      ok: { type: noul, instructions: "构建产物是否成功产出且可分发" }
    on_low_confidence: ask
```

退出码/产物存在性就是确认本身——做了就没必要再塞一个验证 agent。真无解才升级。

## 6. 阶段化叙事(把流程呈现给用户)

**何时**：任何有多个阶段、且用户要看进度的 workflow。阶段数 ≤8，每个阶段一个 `title`(用户读)，节点归组进阶段。分支不入新阶段，`when` 就是分支。

```yaml
phases:               # ≤8
  - phase: ingest
    title: 抓取对账单
  - phase: transform
    title: 核对并清洗
  - phase: deliver
    title: 生成并交付报表
```

阶段好比故事的章节：用户看到的进度 = 阶段序列 + 每阶段内的节点，别一次铺满二十个无组织的卡片。