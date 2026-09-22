---
name: workflow
title: workflow — duya dwf 脚本工作流
description: "用于编写、校验、调试和重新提交 duya dwf 工作流：把流程写成 <name>.dwf.ts 脚本——frontmatter 元数据 + TypeScript 本体，在沙箱里调用 wf.tool/wf.decide/wf.approve/wf.agent/wf.map/wf.publish 宿主原语——选择原语、处理确定性、把不可逆副作用关进 wf.approve、设计 args 以获得可复跑缓存、保存前做编译级校验。当用户提到 workflow/工作流/自动化流程编排、或要求把\"按步干活的流程固化\"时使用。"
when-to-use: "仅用于编写/修改 duya dwf 工作流(.dwf.ts)。单一委托或几个独立查询属于普通 Agent 调用，不应套 workflow。"
---

# 编写 duya dwf 工作流

duya 的 dwf 工作流把「人一步步干活的流程」固化成**可审计、可复跑、可修正**的 TypeScript 脚本资产。
一个 workflow 就是一个 `.dwf.ts` 文件：块注释 frontmatter 声明元数据，脚本本体是普通 TS——
引擎负责沙箱执行、journal 记账、缓存与断点续跑。

> 心智模型：**命令式脚本，不是声明式节点图**。你写的是一段按顺序执行的代码，
> 用普通变量传递中间结果；没有 phases/nodes/模板插值——那些是旧 YAML 引擎的概念。

权威规格在源码里，**以代码为准**：
- 文件契约/名字规则/args schema：`packages/agent/src/modes/workflow/dwf/contracts.ts`
- frontmatter 编解码：`packages/agent/src/modes/workflow/dwf/frontmatter.ts`
- 沙箱运行时/原语实现：`packages/agent/src/modes/workflow/dwf/runtime.ts`
- 存储与双 scope：`packages/agent/src/modes/workflow/dwf/store.ts`
- 生成侧权威 system prompt：`dwf/planner-dwf.ts` 的 `PLANNER_DWF_SYSTEM_PROMPT`(模型生成时应严格照此)

## 分流原则(一页答案)

**能用代码决定的绝不问模型；能用决策模型分类的绝不劳 LLM；只有开放式任务才进 agent；有不可逆副作用的一律先过 wf.approve。**

| 原语 | 干什么 | 成本/审计 |
| --- | --- | --- |
| `wf.tool(name, input)` | 确定性指令，零 LLM，直调 ToolRegistry | 便宜、可重放 |
| `wf.decide(questions, opts)` | 结构化分类/打分/是非，System One 决策 | ~0.1s，比 LLM 便宜 2-3 个量级 |
| `wf.approve(prompt, opts)` | 人在环——**不可逆副作用(付钱/发消息/删除)的唯一闸门** | 审批卡，拒绝即抛错 |
| `wf.agent(type, prompt, opts?)` | 开放式子任务(SubagentTool) | 贵但能干 |
| `wf.map(items, fn, opts?)` | 对一组元素扇出并行处理 | 并发上限 16 |
| `wf.publish(name, content)` | 用户可见的交付物 artifact | 产出侧 |

## 文件骨架

```ts
/* duya-workflow
description: 核对发票并按部门路由          # 必填,一行
whenToUse: 需要按金额/部门分派并走审批时     # 可选
args:
  invoice_id: { type: string, required: true }
  amount_limit: { type: number, default: 10000 }
*/
export default async function (wf) {
  wf.log("开始核对 " + args.invoice_id);

  // 1. 确定性读取(零 LLM)
  const invoice = await wf.tool("excel.read", { file: args.invoice_id + ".xlsx" });

  // 2. 结构化决策(~0.1s,结果带置信度)
  const route = await wf.decide(
    {
      department: { type: "choice", criteria: { billing: "费用相关", ops: "运维相关" } },
      over_limit: { type: "noul", instructions: "金额超过阈值吗" },
    },
    { state: { output: invoice } },
  );

  // 3. 不可逆副作用前必须过审批闸门;拒绝会抛错终止
  if (route.over_limit.p > 0.65) {
    await wf.approve("放行该笔付款(" + args.invoice_id + ")?", {
      timeoutHours: 24,
      onTimeout: "escalate",          // fail | skip | escalate
    });
  }

  // 4. 中间结果用普通变量;交付物走 publish
  await wf.publish("invoice-report", "核对结论: " + route.department.p);
}
```

frontmatter 是**块注释**——整个文件仍是合法 TS，编辑器高亮/格式化照常；YAML body 里
`args` 是 record(不是数组)，`type: string|number|boolean`，`required`/`default` 可选。

## 沙箱与确定性铁律

- 脚本在 node:vm 沙箱执行，**唯一外联通道是 `wf`**：没有 fetch/fs/process/require/定时器，
  控制流里禁止 Math.random——否则断点续跑必 divergence。
- `args` 是注入的全局(如 `args.invoice_id`)；前面步骤的结果用**普通变量**接。
- `wf.decide` 是 host-call，结果**入 journal 且绝不重问**(分类器有随机性，重问破坏重放)。
- `wf.tool`/`wf.decide` 零 LLM；只有 `wf.agent` 占 LLM 预算。
- **RPA(桌面自动化)目前没有独立原语**：通过 `wf.tool` 调用已注册的 computer-use 工具链；
  原语面以 `runtime.ts` 的 `DwfApi` 为准，不要臆造 `wf.gui`。

## 断点续跑(缓存经济学)

每次成功的 `wf.*` 调用按 (runId, 调用参数哈希) 记入 journal。挂起(approve/低置信 decide)
或崩溃后 resume = **重跑整个脚本 + 已成功调用命中缓存**——已花的钱不重付，失败的调用
不进缓存，重跑会真正重试。所以：

- 脚本必须是**幂等重入**的：同样的 args + 缓存命中 ⇒ 同样的路径。
- 不要把可变值揉进 prompt 字面量——放进 frontmatter 的 `args`，改参数只影响受影响调用。
- `wf.approve` 拒绝会**抛错终止**(不是 skip)；想继续就 catch 后走替代路径。

## 保存前必须做

1. **文件放对位置**(`dwf/store.ts` 双 scope，项目 shadow 全局)：
   - 项目(随 git 走)：`<项目>/.duya/workflows/<name>.dwf.ts`
   - 全局：`~/.duya/workflows/<name>.dwf.ts`
   - 文件名 = kebab-case 的 `name`，必须以 `.dwf.ts` 结尾(名字规则本身就是路径穿越防线)。
2. **双门校验**(planner-dwf 的 `validateSource`)：frontmatter 过 `SavedWorkflowMetaSchema`
   (strict，拼错键成可见错误而非静默丢弃) + 脚本过 esbuild 编译。坏文件 fail loud，不静默执行。
3. **先烤验再上线**：改动后先跑 `validateSource`(纯确定性)，别靠跑真实 run 试错。
4. **风险预筛是自动的**：脚本里 `wf.tool("...")` 字面量命中不可逆词表
   (`pay|send|post|publish|delete|drop|...`) → run 从 `awaiting_confirm` 起步；
   有不可逆调用却没有任何 `wf.approve` 会出告警。**主动把 approve 放进脚本**，别靠预筛兜底。

## 生成与重提(用 code 裁决，别全文重贴)

- 生成：把目标 + 可用 agent/tool 列表交给 LLM 按 `PLANNER_DWF_SYSTEM_PROMPT` 产一份完整
  `.dwf.ts`，再让 frontmatter+compile 双门裁决；**错一次带整个错误列表回喂一次，二次仍失
  败就停**，绝不产半成品。
- 校验失败时，**按错误定位改那一处**再重提——不要整段重写。
- 修订重跑：改动会让部分调用的 reqHash 变化；保持 args 分离、命名稳定，未受影响调用零成
  本命中缓存(改参数重跑只重付受影响的调用)。

## 运行语义(透明交付)

- journal 事件一次写入三用(持久化记录 = SSE 进度 = 审计轨迹)，`wf.log` 随做随报，run 断了已报的也不丢。
- 挂起(approve/低置信 decide)只 park 当前 await 链，`wf.map` 的兄弟分支继续跑。
- **绝不自动重跑副作用重的 run**——崩溃对账把孤儿 run 标 `interrupted`，恢复要人确认。

## 反模式

| 你写了 | 代价 |
| --- | --- |
| 该用 `wf.decide` 却塞了个 `wf.agent` 去分类 | 为 0.1s 能搞定的分类付一整个 LLM 会话 |
| 不可逆副作用没包 `wf.approve` 直接 `wf.tool` | 越过了引擎唯一的人权通道，无审批就执行 |
| 脚本里用 fetch/fs/Date.now()/Math.random | 沙箱里根本没有；控制流里用会让 resume divergence |
| 把可变值揉进 prompt 字面量而非 frontmatter args | 改一个参数重写所有提及它的文本 → 缓存全废 |
| 把 `wf.approve` 的拒绝当 skip(不 catch 也不终止) | 拒绝即抛错；吞掉异常会让后续副作用失去闸门 |
| 脚本依赖执行顺序外的隐藏状态(模块级可变量) | 重跑 = 重新执行整个脚本，隐藏状态破坏幂等重入 |
| 臆造 `wf.gui`/`wf.wait` 等原语 | 原语面只有 runtime.ts 的 `DwfApi` 七个，多一个都不存在 |
| 靠跑真实 run 试语法/类型正误 | `validateSource` 双门本来能同步回答 |

## 参考

- `examples.md`(本 skill 同目录)——完整可跑的 dwf 脚本工作流。
- `patterns.md`(本 skill 同目录)——编排模式目录：RPA 骨架、路由/分类、人在环门控、扇出、两档校验。
