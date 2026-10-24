# Agent Harness 正确性审计

> **Status**: Active · **Owner**: mavis ·
> **落地分支**: `codex/harness-correctness-to-master`（base `master`）·
> **检出**: `.claude/worktrees/harness-to-master`
> **审计分支**: `codex/harness-correctness-audit`（PR #413，base 指向特性分支、CI 不跑，
> 已由 master 落地分支取代）
> **立项**: 2026-10-24 — 用户要求对「模块边界清楚、语义边界不清」这一判断做实证审计，
> 并建立一个可信的 Model Request 权威边界。

## 0. 结论

**缺陷是真的,但不是"没人负责"——是负责的那份契约还没落地,而它落地后仍有两处洞。**

`request-assembly.ts` 把「请求以问题收尾」从注释变成了契约,这是正确的方向;但它在
**两个分支上并行、均未合入 master**,且**契约本身有两个可证的例外**。

审计另外发现一个契约覆盖不到的真缺陷:**compaction 之后 volatile context 整个消失**。

| # | 结论 | 证据 |
| --- | --- | --- |
| A | 缺陷曾连续被修坏 3 次,同一处 | `01344cd3` / `b8dda429` / `10db8786`,全在同一个数组表达式上 |
| B | 契约已存在但**未进 master** | `master` 无 `packages/agent-runtime/src/engine/request-assembly.ts` |
| C | 两套并行实现,只有一套有 provider 边界测试 | `codex/fix-prompt-last` 有 `packages/ai/test/prompt-last-provider-payload.test.ts`;`codex/alt-prompt-absolute-last` 无 |
| D | **compaction 后 volatile context 消失**（P0,本次新发现） | 见 H-2 |
| E | 规则 5 有一个**未命名的例外**:inbound（P1） | 见 H-1 |
| F | provider 边界只覆盖 2/5 | 见 H-3 |

---

## 1. 事实基础

三份代码,两种修法,一个基线:

| 位置 | 状态 | 关键内容 |
| --- | --- | --- |
| `master` (`915c82a0`) | **无契约** | 缺陷仍在 |
| `codex/fix-prompt-last` (`10db8786`) | 契约 + 引擎层矩阵 + 引擎层证明 + provider 层测试 | PR 未开;base 指向 `codex/tui-perf-benchmark`(PR #381,open) |
| `codex/alt-prompt-absolute-last` (`0f2d39ee`) | 同名契约的另一版 | **落后 master 6 提交以外的大量改动,且无 provider 层测试**;建议不再推进 |

> `codex/alt-prompt-absolute-last` 的 `request-assembly.ts` 只有 120 行（`fix-prompt-last` 为 200 行）,
> 且**没有** `packages/ai` 的 provider 边界测试。它是被 `fix-prompt-last` 取代的早期版本。

---

## 2. 不变量核对（用户列的 5 条）

| 不变量 | 契约里 | 有测试 | 测在哪层 | 判定 |
| --- | --- | --- | --- | --- |
| 用户请求不被自动上下文掩盖 | ✅ rule 5 | ✅ | 引擎层 + 本次补的 provider 边界层 | ⚠️ **成立但有例外**（H-1） |
| Prompt 不重复、不遗漏 | ✅ rule 1/3 | ✅ | 引擎层 | ✅ |
| 工具调用/结果因果顺序 | 明确不管（rule 4） | ✅ | adapter 层 | ⚠️ 未与契约联测 |
| Compaction 不丢关键指令、不重注过期 | ❌ 无 | ❌ 无 | — | ❌ **违反**（H-2） |
| 多 Provider 转换不提升权限、不丢内容 | ❌ 无 | 仅 2/5 | adapter 层 | ⚠️ **缺口**（H-3） |

---

## 3. 发现清单

### H-1（P1）规则 5 有一个未命名的例外：`inbound`

契约说「请求以问题收尾」，但装配顺序把 `inbound` 放在 prompt **之后**：

- `packages/agent-runtime/src/engine/request-assembly.ts:157-164` — `[...context, promptRow, ...parts.inbound]`
- `packages/agent-runtime/test/request-assembly.test.ts:162` — 把 `in-1` 钉在 `p1` 之后
- `packages/agent-runtime/src/engine/run-engine.ts:2680` — inbound「rides EVERY request」

`inbound` 来自 `ports.interTurn.sweep()`（mailbox 领取的行，`run-engine-ports.ts:466`），
**在第 1 轮也会跑**（`run-engine.ts:725`）。所以：**只要 sweep 领到了东西，第 1 轮的请求就不是以问题收尾。**

这与 rail 是同一类东西——系统注入的 `user` 行——却被区别对待。契约的表格把它当成正常行为固定住了，
没有把它写成例外。这就是「错误的假设被写成测试契约」的第二个实例。

### H-2（P0）compaction 之后 volatile context 整个消失 ← 本次新发现

rail 是**工作数组状态**，不进 timeline（plan 619 Phase 3）。compaction 的替换转写来自 timeline，
于是 rail 不在替换里；引擎又优先用替换：

| 步骤 | 位置 |
| --- | --- |
| compaction 源绑定到 timeline | `packages/host/src/worker-engine-driver.ts:240` — `messages: () => agent.getMessages()` |
| 替换 = timeline 的重投影 | `packages/host/src/worker-compaction/engine-sources.ts:429` — `replacement: run.messages.map(toRuntimeMessage)` |
| 引擎优先用替换 | `packages/agent-runtime/src/engine/run-engine.ts:2662-2664` — `history = ctx.compacted.current ?? ...` |
| rail 从不进 timeline | `packages/host/src/worker-context/context-rail.ts:81` — `messages.push(...)`，作用在投影副本上 |

**后果**:compaction 之后,本轮剩余每一次请求都**没有** environment / memory / skills / hook block。

**与计划冲突**:619 Phase 3 明写「compaction 后自动重建」——这句是错的。

**实证**:`packages/agent-runtime/test/request-assembly-context-survives-compaction.test.ts`
（本次新增的缺陷探针）——不压缩时 rail 在请求里（`['rail-1']`），压缩后为 `[]`，而问题仍在末尾。

### H-3（P1）provider 边界只覆盖 2/5，且两个 adapter 无法断言

`packages/ai/src/api/` 有 5 个 payload 构造器，provider 边界测试只碰了 2 个：

| adapter | 构造器 | 已导出 | 被 provider 边界测试覆盖 |
| --- | --- | --- | --- |
| Anthropic | `toAnthropicMessages` | ✅ | ✅ |
| OpenAI Responses | `toResponsesInput` | ✅ | ✅ |
| OpenAI Chat Completions | `toOpenAIMessages` | ✅ | ❌ |
| Gemini | `toGeminiContents` | ❌ **本次已导出** | ❌ **本次已覆盖** |
| Bedrock | `toBedrockMessages` | ❌ **本次已导出** | ❌ **本次已覆盖** |

后两个此前**无法从测试断言**——payload 构造器是模块私有的。

### H-4（P1）没有任何测试跑完 Host → Runtime → adapter

缺陷发生前的覆盖是两个半截：

| 测试 | 覆盖到 | 止步于 |
| --- | --- | --- |
| `engine-prompt-order-proof.test.ts` | Host → Runtime → 引擎 | mock `createAIClient`，读引擎交出的行 |
| `prompt-last-provider-payload.test.ts` | adapter | 手工构造 4 条消息，**不引用契约模块** |

两者之间的接缝——adapter 自己的变换（`mergeConsecutiveRoles` / `normalizeToolResultOrdering` /
`repairToolPairing` / `stripOrphan*`）——没有任何测试覆盖，而那正是缺陷会换一身衣服回来的地方。

### H-5（P2）`toRuntimeMessage` 丢掉 `origin`

`packages/agent-runtime/src/adapters/run-engine-ports.ts:522` 的映射只产出 `{role, id, content}`。
compaction 的替换转写全走这条路 → 替换里的行**没有**「这是系统注入行」的标记，
rule 5 的分类依据在 compaction 之后失效。这是 H-2 的同源问题。

### H-6（P1）compaction 探针量的是替换，不是请求 ← 修复 H-2 时才发现

探针量的是「替换转写」本身。volatile context 从不进 timeline，替换里**不可能**有它，
于是探针**少算整个 rail**——而 rail 恰恰是每轮都在变的部分。触发因此比应有时晚了 rail 的体积。

修法不是给探针补一份 rail，而是让探针量**请求实际携带的行集**：替换的对话行 + 宿主当前的 context 行。
划分规则因此必须只有一份派生——抽成 `#compactedHistory`，请求与探针都调它；
两处各自推导的话，漂移会一直藏着，直到触发在错误的时刻开火。

未动任何阈值与触发门控（`turnWork.drained > 0`、cooldown、`soft_stop`），
emergency / preflight 仍按原样把 `ctx.deferred.current` 并入基线。

**遗留**：`inline history` 形态下探针与请求的行集仍不一致，且方向相反（探针**多**算）。
该行为早于 H-2，被既有断言 `run-engine-compaction.test.ts` 钉住；生产 host 走 `by_ref`
（`packages/host/src/worker-run-composition.ts:403`），该形态下两者一致，故未改。

### 观察项（P3）两套并行的提醒分类法

`STARTS_PROMPT_TURN`（`agent-core/src/message/message-framework.ts:64`）按 `RuntimeContextSource` 穷尽，
而 rail 块用的是 `ReminderSourceId`（`agent-core/src/context/reminder-sources.ts:43`）。
两套不相交，`runtimeContextStartsPromptTurn` 目前**只有测试在调用**，生产无调用点，
所以今天不是 bug——但它是下一个「加一种 source 忘了加另一张表」的坑。

---

## 4. 本次交付

| 文件 | 作用 |
| --- | --- |
| `packages/ai/src/model-request-invariants.ts` | **Model Request 权威边界**：不变量定义 + 检查器 + 5 个 adapter 的归约器 |
| `packages/ai/test/model-request-invariants.test.ts` | provider 矩阵：5 个 adapter × (正常 / 回归反例) |
| `packages/host/tests/worker-product-runtime/engine-payload-invariants.test.ts` | **端到端**：真实 Host → Runtime → 真实 Anthropic adapter → 检查器，含反例臂 |
| `packages/agent-runtime/test/request-assembly-context-survives-compaction.test.ts` | H-2 缺陷探针（characterization，修复后断言翻转） |
| `packages/agent-runtime/test/compaction-probe-context.test.ts` | H-6：探针量的行集 == 请求携带的行集（压缩后 / 压缩前对照 + 反例臂） |
| `packages/ai/src/api/{google-generative-ai,bedrock-converse}.ts` | 导出 `toGeminiContents` / `toBedrockMessages`，让边界可断言 |
| `packages/ai/src/index.ts` | 导出边界模块与 5 个 payload 构造器 |
| `packages/agent-runtime/src/engine/request-assembly.ts` | **契约本体**：规则 1–5 |
| `packages/agent-runtime/test/request-assembly.test.ts` | 契约矩阵（装配顺序 + 例外） |
| `packages/agent-runtime/test/to-runtime-message-origin.test.ts` | H-5：`origin` 标记随替换转写存活 |
| `packages/agent-runtime/test/compaction-context-reattachment.test.ts` | H-2：压缩后 context 重新挂载 |
| `packages/host/tests/worker-product-runtime/harness-scenario-*.test.ts` | 五个真实场景回归：长对话 / 工具续轮 / 运行中 steering / 中断与续话 / 多 provider |

检查器**报告而不抛异常**（`checkModelRequest` 返回 violation 列表）——
一个默认抛异常的边界无法用来证明「缺陷仍然可被检测」。

---

## 5. 后续动作（按优先级）

| # | 动作 | 归属 | 状态 | 备注 |
| --- | --- | --- | --- | --- |
| 1 | 决定 **inbound 的语义**（H-1） | 契约 owner | ✅ 已裁定并修复 | 裁定：mailbox 每一行都过 `projectRuntimeContextToProviderMessage`，**没有一行是人打的** → 与 rail 同类，移到 prompt 前；后续轮按规则 4 不动 |
| 2 | 修 **H-2**：compaction 替换要重新投影 rail | compaction owner | ✅ 已修复 | 划分而非合并：替换贡献非 context 行，宿主当前投影贡献 context 行；宿主在 context 上胜出 |
| 3 | `toRuntimeMessage` 带上 `origin`（H-5） | runtime owner | ✅ 已修复 | 与 2 同批做，两侧用同一标记分类，不可能数两次 |
| 4 | 让契约进 master | PR owner | ✅ 本分支落地 | 原分支 base 指向 `codex/tui-perf-benchmark`（PR #381，已 CONFLICTING 且无 checks）→ 改为把整条链移植到 `master` 基线，独立 PR，CI 正常跑 |
| 5 | 停用 `codex/alt-prompt-absolute-last` | 分支 owner | ⏳ 待 owner 处理 | 已被 `fix-prompt-last` 取代；该分支从未推远端 |
| 6 | 把 provider 矩阵挂进 CI | 审计 owner | ✅ 已就位 | base=master 的 PR 会跑 CI，需确认 CI 实际跑到 |
| 7 | 修 **H-6**：探针量请求携带的行集 | runtime owner | ✅ 已修复 | 划分规则抽成唯一方法 `#compactedHistory`，请求与探针共用；未动阈值与触发门控 |

## 6. 验证记录

见本文件末尾的「验证记录」表（随提交更新）。
