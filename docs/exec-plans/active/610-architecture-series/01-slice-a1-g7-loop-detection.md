# 01 — A1 切片:G7 的循环识别

> **状态:进行中,未完成,未合并。** 唯一 next action 见 [README §2](README.md#2-唯一-next-action)。

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
`agent-runtime/src/engine/ports.ts` 是已知的过读:它**声明**循环的端口,
所以它带 (a)(c) 又点了缝的名字。**选择报出而不是藏起来** —— 与本文件下方
"report more, never less"的规则一致。

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
