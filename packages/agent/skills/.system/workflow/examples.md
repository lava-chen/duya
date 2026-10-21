# 完整 dwf 脚本工作流样例

三个可用作起点的完整 workflow。每个都过了 `validateSource` 双门(frontmatter schema + 编译)：
幂等重入、可审计、确定性。
保存位置：项目 `<项目>/.duya/workflows/<name>.dwf.ts` 或全局 `~/.duya/workflows/<name>.dwf.ts`。

## 例 1：发票核对 → 路由 → 人工放行(tool + decide + approve)

一个完整流程，示范 tool/decide/approve 的组合，以及 decide answers 驱动控制流。

```ts
/* duya-workflow
description: 核对发票金额，按部门路由，超阈值放行需人工审批
whenToUse: 需要按发票金额/部门分派并走审批的时候
args:
  invoice_id: { type: string, required: true }
  amount_limit: { type: number, default: 10000 }
*/
export default async function (wf) {
  wf.log("读取发票 " + args.invoice_id);

  // 确定性读取与汇总(零 LLM)
  const invoice = await wf.tool("excel.read", { file: args.invoice_id + ".xlsx" });
  const total = await wf.tool("calc.sum", { rows: invoice.rows });

  // 结构化决策(~0.1s/问);state 是决策面可见的上下文
  const route = await wf.decide(
    {
      department: {
        type: "choice",
        criteria: { billing: "费用相关", ops: "运维相关" },
      },
      over_limit: { type: "noul", instructions: "金额超过阈值吗" },
    },
    { state: { output: invoice, total } },
  );

  // 不可逆副作用唯一闸门;拒绝(或 escalate/fail 超时)抛错终止。onTimeout 必填。
  // decide 返回 Record<string, string|number>:choice 问 → label 字符串,noul/score 问 → 置信数值。
  if (route.over_limit > 0.65 || total > args.amount_limit) {
    await wf.approve(
      "放行 " + total + " 元付款(" + args.invoice_id + ")?",
      { timeoutHours: 24, onTimeout: "escalate" },
    );
  }

  // 中间结果用普通变量;交付物走 publish
  if (route.department === "billing") {
    await wf.tool("excel.write", {
      out: args.invoice_id + ".done.xlsx",
      rows: invoice.rows,
    });
  }
  await wf.publish("invoice-report", "核对完成: " + route.department);
}
```

## 例 2：批量审计(map 扇出 + decide 收口)

扇形 + 收紧：先枚举，再逐文件审计，最后用机器可检查的决策收口。

```ts
/* duya-workflow
description: 对给定 glob 命中的 TS 文件做正确性审计
whenToUse: 要检查一批文件里是否有真问题的时候
args:
  pattern: { type: string, default: "src/**/*.ts" }
*/
export default async function (wf) {
  // 确定性枚举
  const files = await wf.tool("glob.list", { pattern: args.pattern });

  // 扇出:wf.map 保序返回,concurrency 上限 16
  const findings = await wf.map(
    files,
    async (f) => {
      const r = await wf.agent(
        "general-purpose",
        "审计 " + f.path + " 的正确性,只报可复现的真问题",
      );
      return { path: f.path, findings: r };
    },
    { concurrency: 4 },
  );

  // 收口用 decide 而非额外 agent 自证
  const verdict = await wf.decide(
    { has_issues: { type: "noul", instructions: "本轮是否发现高危问题需要人工介入" } },
    { state: { output: findings } },
  );

  if (verdict.has_issues > 0.5) {
    await wf.approve("发现高危问题,是否生成升级报告?", {
      timeoutHours: 12,
      onTimeout: "skip",
    });
    await wf.publish("audit-escalation", findings);
  }
  return { audited: findings.length, riskScore: verdict.has_issues };
}
```

`wf.map` 的回调里每个元素独立调 agent；返回值**保序**；空数组自然零跑，不需要额外兜底。

## 例 3：研究 → 起草 → 审批 → 发布(agent 主导 + 人在环)

开放式任务为主体的流程：agent 干活，机器算验收，人管出口。

```ts
/* duya-workflow
description: 调研主题并起草报告，人工审核后发布
whenToUse: 用户要一份基于代码库/资料的结构化报告时
args:
  topic: { type: string, required: true }
  audience: { type: string, default: "engineering" }
*/
export default async function (wf) {
  wf.log("调研: " + args.topic);

  const draft = await wf.agent("general-purpose",
    "调研「" + args.topic + "」并起草一份面向 " + args.audience + " 的报告," +
    "只引用可验证的来源");

  // 机器可算的验收:结构/长度/引用数,别让 agent 自证
  const check = await wf.tool("report.lint", { content: draft });

  if (!check.ok) {
    // 修订一轮(缓存让上一轮的调研零成本复用)
    const revised = await wf.agent("general-purpose",
      "按以下问题修订报告:\n" + check.issues.join("\n"));
    await wf.publish("report-draft", revised);
    await wf.approve("报告已修订,是否发布?", { timeoutHours: 48, onTimeout: "skip" });
    await wf.publish("report-final", revised);
    return;
  }

  await wf.publish("report-draft", draft);
  // approve 不抛即通过(拒绝/escalate 抛错,onTimeout:skip 超时返回 null 且后续照走)
  await wf.approve("报告通过草检,是否直接发布?", {
    timeoutHours: 48,
    onTimeout: "skip",
  });
  await wf.publish("report-final", draft);
}
```

---

改动任何一篇后：**重跑 `validateSource`**(frontmatter schema + 编译双门)，坏文件 fail loud——不会静默执行旧版本。
