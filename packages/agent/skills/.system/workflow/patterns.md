# duya dwf 脚本编排模式

一套「脚本形状目录」。每条说明何时选这种形状，然后用正确的 dwf.ts 片段展示。
片段是**碎片**，不是完整可跑的 workflow——完整样例在 `examples.md`。
原语面只有七个：`wf.tool / decide / approve / agent / map / publish / log`(以 `runtime.ts` 的 `DwfApi` 为准)。

## 1. 确定性优先骨架：先 tool 后判断

**何时**：流程的主体是确定性操作(读文件、算数、调 API 工具)，只有分支点需要判断。

```ts
export default async function (wf) {
  const data = await wf.tool("excel.read", { file: args.file });   // 零 LLM
  const sum = await wf.tool("calc.sum", { rows: data.rows });      // 零 LLM
  wf.log("汇总完成: " + sum);
  return sum;
}
```

关键点：**能串成普通变量的绝不问模型**。`wf.tool` 结果直接 `await` 接住，
类型由你自己的代码约定；每一步都进 journal，resume 时零成本命中。

## 2. 路由 / 分类(decide 先行，别用 agent)

**何时**：把流程按**结构化**标准(部门、优先级、是否紧急)分派。这是 `wf.decide` 的主场。

```ts
// 前置:一个 tool 已产出 read。state 是决策面可见的上下文。
const route = await wf.decide(
  {
    department: {
      type: "choice",
      criteria: { billing: "与费用/账单/发票相关", tech: "与故障/报错/技术相关" },
    },
    urgent: { type: "noul", instructions: "工单是否表达紧迫/时限压力" },
  },
  { state: { output: read }, thresholds: { urgent: 0.65 } },
);

// decide 返回 Record<string, string|number>:choice 问 → label,noul/score 问 → 置信数值。
if (route.department === "billing") {
  await wf.agent("general-purpose", "推进计费工单,依据:" + read);
} else if (route.department === "tech" && route.urgent > 0.65) {
  await wf.agent("general-purpose", "紧急处理技术工单");
}
```

灰区由 `thresholds` 与 `onLowConfidenceDefault` 决定——**低置信绝不静默猜**，
不传 `onLowConfidenceDefault` 时低置信走 uncertain 路径交人类。

## 3. 人在环门控(不可逆副作用唯一闸门)

**何时**：付钱、发消息、删除、发布——有不可逆副作用，`wf.approve` 是唯一合法闸门。

```ts
if (total > 0) {
  // 拒绝(deny)或 onTimeout: fail/escalate 的超时 → 抛 DwfApprovalDeniedError 终止。
  // onTimeout: skip 的超时 → 返回 null,脚本继续(语义 = 放行但没等到人)。
  await wf.approve("放行 " + total + " 元付款给 " + vendor + "?", {
    timeoutHours: 24,
    onTimeout: "escalate",        // fail | skip | escalate,必填
  });
  await wf.tool("pay.send", { amount: total, to: vendor });
}
```

`onTimeout` 三选一必填。审批结果作为独立 journal 记录，resume 时宿主用既有决定
直接放行(不重问)。**approve 之后才发真正的副作用调用**——闸门在调用之前。

## 4. 扇出(map)：逐元素并行处理

**何时**：同一问题作用在一组元素上(一批文件、一批记录)，想并行处理。

```ts
const files = await wf.tool("glob.list", { pattern: "src/**/*.ts" });

const findings = await wf.map(
  files,
  async (f) => {
    const r = await wf.agent("general-purpose",
      "审计 " + f.path + " 的正确性问题;只报真问题");
    return { path: f.path, r };
  },
  { concurrency: 4 },             // 上限 16;缺省取宿主配置
);
// findings 保序,与 files 一一对应
```

`wf.map` 的回调可以是 tool/decide/agent 的任意组合；空数组自然零跑。
返回值**保序**，不需要额外索引对账。

## 5. 两档校验(机器能算的归代码，别让 agent 自证)

**何时**：流程的验收是可机器检查的(构建过、测试绿、字段值对)，就该由 `wf.tool`/`wf.decide` 决定。

```ts
const build = await wf.tool("shell.build", { target: "release" });

const verdict = await wf.decide(
  { ok: { type: "noul", instructions: "构建产物是否成功产出且可分发" } },
  { state: { output: build } },
);

if (verdict.ok > 0.5) {
  await wf.publish("release-notes", build.summary);
} else {
  // 真无解才升级 agent
  await wf.agent("general-purpose", "诊断构建失败:" + build.output);
}
```

退出码/产物存在性就是确认本身——做了就没必要再塞一个验证 agent。

## 6. 进度叙事(log + publish 把流程呈现给用户)

**何时**：任何多步骤、且用户要看进度的 workflow。`wf.log` 随做随报(进 SSE/journal)，
阶段性交付物用 `wf.publish` 落成 artifact。

```ts
export default async function (wf) {
  wf.log("阶段 1/3: 抓取对账单");
  const raw = await wf.tool("excel.read", { file: args.src });

  wf.log("阶段 2/3: 核对并清洗");
  const clean = await wf.tool("calc.normalize", { rows: raw.rows });

  wf.log("阶段 3/3: 生成报表");
  await wf.publish("monthly-report", clean, "text/csv");
}
```

用户看到的进度 = log 序列 + publish 的 artifact。长流程**每个阶段至少一条 log**，
别让 run 静默跑十分钟毫无输出。
