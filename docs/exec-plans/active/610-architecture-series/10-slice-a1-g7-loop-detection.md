# 01 — A1 切片:G7 的循环识别

> **状态:已完成并合并。** PR #219,commit `908b5baf`,合并为 `205a4cd4`。
> ~~状态:进行中,未完成,未合并。~~ 每片的当前 next action 见 [README §5.1](README.md#51-每片的唯一-next-action)。
>
> ⚠️ **§4 那个「在这个问题回答之前,本切片不提交、不合并」的未决问题,已有答案:真违规。**
> 现测证据见本文件末尾的 [2026-10-06 收尾更正](#2026-10-06--收尾更正本文件的状态与未决问题均已过时)。
> **本片不再持有任何未决项;红色留给 A3。**

## 1. 缺陷

`TURN_LOOP_SHAPE.modelStream` 曾硬编码为 `/\.streamChat\s*\(/`,而它上方的注释
声称该判据"选中真循环、worker 入口、一个集成测试"。**重测发现只选中 worker 入口。**

原因:切片 S2 把模型请求移进了 `model-leg` 缝(`buildTurnModelLeg` / `createTurnLegModelPort`),
`DuyaAgent.ts` 里不再有字面 `.streamChat(` 调用,而 `agent-process-entry.ts` 还在调它。
**判据从"按职责"漂移成了"按拼写",于是指错了文件。**

实况(直接调用检测器,合成 fixture + live tree):

```
可达闭包: 含有 packages/agent/src/agent/DuyaAgent.ts   (确实可达)
findings:  packages/agent/src/process/agent-process-entry.ts   <- 入口自己
```

**一个认不出循环、却把入口报成违规的门禁,比没有门禁更糟**:它会把下一片指向错误的文件。

## 2. 候选子句的选择性(实测,非估计)

扫 `packages/`、`apps/desktop/src`、`electron/`、`scripts/` 下 2194 个非测试源文件,
要求三条子句同时成立:

| (b) 变体 | 命中 | 认出 `DuyaAgent` | 多余命中 |
| --- | --- | --- | --- |
| `streamChat(` only(原) | 1 | **✗** | — |
| **`+ model-leg 缝`** | **3** | **✓** | `agent-runtime/src/engine/ports.ts` |
| `+ llmClient` / `AIClient` | 5 | ✓ | 多出 `agent-shell.ts`、一个脚本 |
| 极宽(`Leg|Port|Client`) | 3 | ✓ | 多出 `agent-shell.ts` |

**采用 `+ model-leg 缝`。** 命中数仍是 3,真实循环被认出。

> ⚠️ **「`ports.ts` 是已知过读、会被报出来」这句话是错的(2026-10-06 实测)。**
> 原判据 `+ model-leg 缝` 命中 3 个文件是在**未去注释**的源码上数的;
> 门禁实际对**去注释后的代码**求值(`stripComments`),实测结果完全不同:
>
> | 文件 | `repetition` | `modelStream` | `toolExecution` | `isTurnLoopModule` |
> | --- | --- | --- | --- | --- |
> | `packages/agent-runtime/src/engine/ports.ts` | ✗ | ✓ | ✗ | **1/3 → false** |
> | `packages/agent/src/agent/DuyaAgent.ts` | ✓ | ✓ | ✓ | **3/3 → true** |
>
> `ports.ts` 的 `repetition` 与 `toolExecution` 在去注释后**都不成立** —— 它的原始正则命中
> 全部落在注释里(例如 `:453` 的 `StreamingToolExecutor.getRemainingResults` 就在 JSDoc 中,
> 另有一处注释命中 `modelStream`)。
> **所以 `ports.ts` 今天不发出任何 finding,这条过读是休眠的。**
> 怎么测的:对两个文件分别做「去注释 → 逐子句 `RegExp.test`」。
>
> **同一句话也写在代码注释里,而那里同样已知是错的:**
> `scripts/architecture/boundary-gates.mjs:265-268` 声称 `ports.ts`「带 (a)(c) 又点了缝的名字,
> 因此被报出来」。**本切片不拥有该文件,故只在此记录,不修改代码。**
> 下一位若触碰 `boundary-gates.mjs`,应把这段注释改成「休眠过读:去注释后 1/3,不报」。

## 3. 已改(工作树,未提交)

`scripts/architecture/boundary-gates.mjs`:

- `TURN_LOOP_SHAPE.modelStream` 改为 `/\.streamChat\s*\(|\b(?:buildTurnModelLeg|createTurnLegModelPort|TurnModelLeg|ModelPort)\b/`
- 注释里那条"3270 文件选 3 个"的旧测量换成上表的实测量

## 4. 为什么还没算完成

改后 `boundary-gates.test.ts` 从 **4 红变 2 红**,但**新冒出一条**:

```
baseline — a known defect must not block, a new one must fail
  > the live tree is fully baselined, so the gate exits clean
```

判据变准之后,live findings 变了,于是与 baseline 不一致。这不是"再跑一次就好"的事:

- `architecture-check.mjs --write` 会把新出现的 finding 吞进 baseline,让门禁转绿 ——
  **那正是"为了让门禁变绿而加豁免"**,本系列 §4 第 5 条禁止。
- 正确做法是先看清:新增的 finding 是**真的**新违规(G7 现在能指出以前指不出的东西),
  还是**误报**(比如 `ports.ts` 那个已知过读进了 live tree)。两者的处置完全不同。

**在这个问题回答之前,本切片不提交、不合并。**

## 5. 完成标志

```bash
npx vitest run scripts/architecture/          # 4+1 现有红全部转绿
npm run architecture:check                   # 无新增未基线化的违规
npm run architecture:self-test               # OK
```

**变异证明(必做):** 造一个"真循环藏在三层 adapter 后面"的 fixture,确认 G7 变红;
撤掉后确认恢复绿。**只证明"当前 fixture 变绿"不算数** —— 那是恒等式。

---

## 2026-10-06 — 收尾更正(本文件的状态与未决问题均已过时)

> 本节记录本切片合并后的实测结果。**上文 §1–§5 是合并前的判断,保留作为依据。**

### 已达成

| 项 | 实测 | scope |
| --- | --- | --- |
| 合并状态 | PR #219,`908b5baf` → `205a4cd4` | git log |
| 变异证明 | **5/5**,含反向(撤掉链 → 门禁不报) | `node scripts/architecture/mutation-proof-a1.mjs`,`205a4cd4` |
| 门禁输出 | `G7 NEW` —— known **0** / new **1** / stale 0 | `node scripts/architecture/boundary-gates.mjs`,`205a4cd4` |

变异证明脚本同时记录了一个已知缺口(**记录在案,未修**):
`modelStream` / `toolExecution` 两个子句**匹配的是名字,不是职责**;
放宽的实测代价是选择性 5 → 6(多认出 `agent-shell.ts`)。

### §4 未决问题的答案:真违规

新增的 finding 是 `packages/agent/src/agent/DuyaAgent.ts` 被
`packages/agent/src/process/agent-process-entry.ts` **直连可达**,baseline 里 G7 条目数为 **0**。

**这不是 `ports.ts` 的已知过读** —— 那个过读经实测是休眠的(见 §2 更正)。它是真正的轮次循环:

```
DuyaAgent.ts 去注释后逐子句:  repetition ✓ / modelStream ✓ / toolExecution ✓  = 3/3
  repetition     37 处
  modelStream    :95(import buildTurnModelLeg)、:2454
  toolExecution  :76、:2067、:2762、:2764、:2902、:4427
```

**因此这条 finding 归 A3,不归 A1。** A1 的工作已完成;红的是 A3 的待办,
门禁把它如实报出来 —— 这正是「门禁是事实报告,不是待办清单」的预期行为。
**绝不能用 `architecture-check.mjs --write` 把它吞进 baseline**(本系列 §4 第 4、5 条)。

### 与本次相关的两条现存红(属别的片,别记到 A1 头上)

1. **`boundary-gates.test.ts:294` 的行号钉死失效** —— 它断言 worker 入口里
   `DuyaAgent` 的 import 在第 **75** 行,现测在第 **76** 行。
   怎么测的:`Select-String 'ToolExecutionPipeline' DuyaAgent.ts` → `:76`;
   对照 `agent-process-entry.ts` 的该 import 行号。这是 `be766fde` 之后的行号漂移,**与 A1 无关**。
2. **`the live tree is fully baselined` 这条红,正是因为 G7 有了新 finding 才红的。**
   **它转绿就是 A3 成功的信号,不是 A1 的欠账。**

> ⚠️ **本次未执行 vitest。** 该工作检出没有 `node_modules`,而本次是纯文档改动、
> 明确不安装依赖。上述两条红的**成因**是用读测试源码 + 直接跑门禁确定的,
> **不是靠跑出来的**,引用时请保留这个区别。
