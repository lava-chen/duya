# 完整 YAML 工作流样例

三个可用作起点的完整 workflow。每个都过了 `validateWorkflow` 语义：可复跑、可审计、确定性。
保存位置：项目 `<项目>/.duya/workflows/<name>.yaml` 或全局 `~/.duya/workflows/<name>.yaml`。

## 例 1：发票核对 → 路由 → 人工放行(tool + decision + human)

一个完整的三阶段流程，示范六类节点里的 tool/decision/human 组合，以及 decision answers 进 `when`。

```yaml
name: invoice-review
description: "核对发票金额，按部门路由，超阈值放行需人工审批"
when_to_use: "需要按发票金额/部门分派并走审批的时候"
params:
  - name: invoice_id
    type: string
    required: true
  - name: amount_limit
    type: number
    default: 10000
phases:
  - phase: ingest
    title: 读取发票
    nodes:
      - id: fetch
        tool: excel.read
        input: { file: "${params.invoice_id}.xlsx" }
  - phase: route
    title: 核对并路由
    nodes:
      - id: calculate
        tool: calc.sum
        input: { rows: "${fetch.output.rows}" }
      - id: route-ticket
        decision:
          state: { output: "${calculate.output}" }
          questions:
            department: { type: choice, criteria: { billing: "费用相关", ops: "运维相关" } }
            over_limit: { type: noul, instructions: "金额超过阈值吗" }
          on_low_confidence: ask
  - phase: deliver
    title: 审批并归档
    nodes:
      - id: approve
        when: "route-ticket.over_limit > 0.65 || params.amount_limit > 10000"
        human:
          via: approval_card
          prompt: "放行 ${calculate.total} 元付款(${params.invoice_id})？"
          timeout: { hours: 24, on_timeout: escalate }
      - id: archive
        tool: excel.write
        input: { out: "${params.invoice_id}.done.xlsx", rows: "${calculate.output.rows}" }
        when: "route-ticket.department == 'billing'"
```

## 例 2：RPA 填表单 + 兜底(gui)

确定性桌面自动化骨架：截图 → 逐字段填写 → stuck 时升级 agent 兜底。

```yaml
name: fill-erp-form
description: "把对账单数据填进 ERP 表单"
when_to_use: "需要自动化操作固定桌面应用(ERP/进销存等)"
params:
  - name: invoice_id
    type: string
    required: true
  - name: amount
    type: string
    required: true
phases:
  - phase: open
    title: 打开 ERP 表单
    nodes:
      - id: open-app
        gui:
          target_app: "ERP*"
          steps: [{ do: capture }, { do: click, element: "som:1" }]
          on_stuck: agent
  - phase: fill
    title: 填写并提交
    nodes:
      - id: fill-fields
        gui:
          target_app: "ERP*"
          steps:
            - { do: type_text, text: "${params.invoice_id}", element: "som:2", verify: true }
            - { do: type_text, text: "${params.amount}", element: "som:3", verify: true }
            - { do: key, key: "enter" }
          max_actions: 15
          on_stuck: agent
      - id: confirm
        tool: shell.alive
        input: { timeout: 3000 }
```

`on_stuck: agent` 是唯一让 LLM 进 RPA 的入口——只在 GUI agent 卡住时接管看屏决策，常规步骤纯确定性。

## 例 3：审计一批文件(map 扇出 + decision 校验)

扇形 + 收紧：先枚举，再逐文件审计，最后用机器可检查的决策收口。

```yaml
name: audit-ts-src
description: "对给定 glob 命中的 TS 文件做正确性审计"
when_to_use: "要检查一批文件里是否有真问题的时候"
params:
  - name: pattern
    type: string
    default: "src/**/*.ts"
phases:
  - phase: enumerate
    title: 找到要审计的文件
    nodes:
      - id: list-files
        tool: glob.list
        input: { pattern: "${params.pattern}" }
  - phase: audit
    title: 逐个审计并确认
    nodes:
      - id: audit-each
        when: "count(list-files.files) > 0"
        map:
          over: "${list-files.files}"
          as: f
          parallel: true
          concurrency: 4
        agent: general-purpose
        prompt: "审计 ${f.path} 的正确性,只报可复现的真问题"
  - phase: conclude
    title: 机器收口
    nodes:
      - id: classify
        decision:
          state: { output: "${audit-each.output}" }
          questions:
            has_issues: { type: noul, instructions: "本轮是否发现高危问题需要人工介入" }
          on_low_confidence: ask
      - id: done
        when: "classify.has_issues <= 0.5"
        noop: true
```

`map` 只用 agent 包一层；`count(...)` 兜底防空扇出；收口用 decision 而非额外 agent 自证。

---

改动任何一篇后：**重跑校验**(它会在每次加载时 revalidate)，坏文件会 fail loud——不会静默执行旧版本。