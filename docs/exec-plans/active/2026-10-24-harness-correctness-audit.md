# Agent Harness 正确性审计

> **Status**: Active · **Owner**: mavis · **分支**: `codex/harness-correctness-audit` ·
> **基线**: `10db8786`（`codex/fix-prompt-last`）· **检出**: `.claude/worktrees/harness-audit`
> **立项**: 2026-10-24 — 用户要求对「模块边界清楚、语义边界不清」这一判断做实证审计，
> 并建立一个可信的 Model Request 权威边界。

## 0. 结论

**缺陷是真的,但不是"没人负责"——是负责的那份契约还没落地,而它落地后仍有两处洞。**

`request-assembly.ts` 把「请求以问题收尾」从注释变成了契约,这是正确的方向;但它在
**两个分支上并行、均未合入 master**,且**契约本身有两个可证的例外**。

审计另外发现一个契约覆盖不到的真缺陷:**compaction 之后 volatile context 整个消失**。

**修复状态:H-1 / H-2 / H-3 / H-4 / H-5 已全部修复**(见 §3.5),剩余 H-6 一个新发现待决。

| # | 结论 | 证据 |
| --- | --- | --- |
| A | 缺陷曾连续被修坏 3 次,同一处 | `01344cd3` / `b8dda429` / `10db8786`,全在同一个数组表达式上 |
| B | 契约已存在但**未进 master** | `master` 无 `packages/agent-runtime/src/engine/request-assembly.ts` |
| C | 两套并行实现,只有一套有 provider 边界测试 | `codex/fix-prompt-last` 有 `packages/ai/test/prompt-last-provider-payload.test.ts`;`codex/alt-prompt-absolute-last` 无 |
| D | **compaction 后 volatile context 消失**（P0,本次新发现） | 见 H-2 → **已修**（PR #416） |
| E | 规则 5 有一个**未命名的例外**:inbound（P1） | 见 H-1 → **已修**（PR #414） |
| F | provider 边界只覆盖 2/5 | 见 H-3 → **已修**（PR #413） |

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
| 用户请求不被自动上下文掩盖 | ✅ rule 5 | ✅ | 引擎层 + provider 边界层 + 五个场景 | ✅ **已成立**（H-1 已修，规则 5 现在无条件） |
| Prompt 不重复、不遗漏 | ✅ rule 1/3 | ✅ | 引擎层 + provider 边界层 | ✅ |
| 工具调用/结果因果顺序 | 明确不管（rule 4） | ✅ | adapter 层 + 工具续轮场景 | ✅ |
| Compaction 不丢关键指令、不重注过期 | ✅ 补齐（H-2/H-5） | ✅ | 引擎层 | ✅ **已成立** |
| 多 Provider 转换不提升权限、不丢内容 | ✅ 补齐（H-3） | ✅ | provider 边界层，5/5 | ✅ **已成立** |

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

### H-6（P2，本次修复过程中新发现）compaction 探针少算 context 行

`#transcriptFor`（compaction 的探针输入）在 compaction 之后只量 **replacement**，不含 context 行。
H-2 修复后 context 行会重新挂回请求，于是探针**少算**了 rail 的体积 → compaction 的触发点**偏晚**。

这是修复带来的口径不一致，不是原缺陷。归属：compaction owner。**未修**，因为改它要动探针的计量口径，
而那属于另一个决策（探针该不该计入 per-request 的 context）。

### 观察项（P3）两套并行的提醒分类法

`STARTS_PROMPT_TURN`（`agent-core/src/message/message-framework.ts:64`）按 `RuntimeContextSource` 穷尽，
而 rail 块用的是 `ReminderSourceId`（`agent-core/src/context/reminder-sources.ts:43`）。
两套不相交，`runtimeContextStartsPromptTurn` 目前**只有测试在调用**，生产无调用点，
所以今天不是 bug——但它是下一个「加一种 source 忘了加另一张表」的坑。

---

## 3.5 修复状态

| # | 修法（一句话） | PR |
| --- | --- | --- |
| H-1 | `inbound` 是系统注入行（全部经 `projectRuntimeContextToProviderMessage`，无一条是人打的），**移到 prompt 前**；后续轮不动（rule 4 不管后续轮） | [#414](https://github.com/lava-chen/duya/pull/414) |
| H-2 | compaction 替换只贡献**非 context 行**，宿主当前投影贡献 **context 行**——**划分，不是合并**，两边用同一个 `origin` 标记分类，所以不可能数两次 | [#416](https://github.com/lava-chen/duya/pull/416) |
| H-5 | `toRuntimeMessage` 带上 `origin: 'context'`——这是 H-2 的**前提**：没有标记，replacement 的 context 行与「人说话」无法区分 | [#416](https://github.com/lava-chen/duya/pull/416) |
| H-3 | 导出 `toGeminiContents` / `toBedrockMessages`，provider 边界覆盖 2/5 → **5/5** | [#413](https://github.com/lava-chen/duya/pull/413) |
| H-4 | 补上跑完 Host → Runtime → **真实 adapter** 的端到端测试，含反例臂 | [#413](https://github.com/lava-chen/duya/pull/413) |
| 边界自身 | 重复检查改数**出现次数**（扛得住 Anthropic 的同角色合并）；新增 `mode: 'continuation'`——续轮本就不以问题收尾，rule 4 | 本 PR 末次提交 |
| 场景套件 | 五个真实场景（长对话 / 工具续轮 / 运行中 steering / 中断与续话 / 多 provider），每个都有反例臂 | [#417](https://github.com/lava-chen/duya/pull/417) |

**反例确实会红**：A 与 B 都用 mutation 验证过（移除标记 → 3 例失败；移除 context 重挂载 → 5 例失败；
把 `inbound` 放回 prompt 后 → 5 failed / 11 passed）。C 在续轮场景上跑了一次证伪探针，文件变红后还原。

---

## 4. 本次交付

| 文件 | 作用 |
| --- | --- |
| `packages/ai/src/model-request-invariants.ts` | **Model Request 权威边界**：不变量定义 + 检查器 + 5 个 adapter 的归约器 |
| `packages/ai/test/model-request-invariants.test.ts` | provider 矩阵：5 个 adapter × (正常 / 回归反例) |
| `packages/host/tests/worker-product-runtime/engine-payload-invariants.test.ts` | **端到端**：真实 Host → Runtime → 真实 Anthropic adapter → 检查器，含反例臂 |
| `packages/host/tests/worker-product-runtime/harness-scenario-*.test.ts` | 五个真实场景回归（长对话 / 工具续轮 / steering / 中断续话 / 多 provider） |
| `packages/agent-runtime/test/request-assembly-context-survives-compaction.test.ts` | H-2 探针，**已反转**为「修复后必须存在且恰好一次」 |
| `packages/agent-runtime/test/compaction-context-reattachment.test.ts` | H-2 的重挂载与不重复的证明 |
| `packages/agent-runtime/test/to-runtime-message-origin.test.ts` | H-5 的标记传播证明 |
| `packages/ai/src/api/{google-generative-ai,bedrock-converse}.ts` | 导出 `toGeminiContents` / `toBedrockMessages`，让边界可断言 |
| `packages/ai/src/index.ts` | 导出边界模块与 5 个 payload 构造器 |

检查器**报告而不抛异常**（`checkModelRequest` 返回 violation 列表）——
一个默认抛异常的边界无法用来证明「缺陷仍然可被检测」。

---

## 5. 后续动作（按优先级）

| # | 动作 | 归属 | 备注 |
| --- | --- | --- | --- |
| 1 | 让 `codex/fix-prompt-last` 进 master | PR owner | base 指向 `codex/tui-perf-benchmark`（PR #381,open），CI 不跑；需评估是否拆出独立 PR。**这是所有后续的前提** |
| 2 | 把本 PR 链（#413 → #414 / #416 / #417）按顺序集成到 master | 集成者 | 每个 PR 单独合，bundle 由集成者从合并后源码重建 |
| 3 | 决定 **H-6**：compaction 探针要不要计入 per-request 的 context | compaction owner | 现状是少算 → 触发点偏晚 |
| 4 | 停用 `codex/alt-prompt-absolute-last` | 分支 owner | 已被 `fix-prompt-last` 取代，且从未推远端 |
| 5 | 把 provider 矩阵与场景套件挂进 CI | 集成者 | 本 PR 已就位，需确认 CI 实际跑到 |
| 6 | 观察项：把 `ReminderSourceId` 与 `RuntimeContextSource` 合并或明确桥接 | 架构 owner | 今天不是 bug，是下一个「加一种 source 忘了加另一张表」的坑 |

## 6. 验证记录

环境：Windows / Node v24.16.0。检出：`.claude/worktrees/harness-audit`（分支 `codex/harness-correctness-audit`）。

| SHA | 命令 | 退出码 / 结果 |
| --- | --- | --- |
| `10db8786` + 本任务改动 | `npx vitest run packages/ai/test/model-request-invariants.test.ts` | 0 — 21 passed（5 adapter × 3 + 检查器 6） |
| `10db8786` + 本任务改动 | `npx vitest run packages/host/tests/worker-product-runtime/engine-payload-invariants.test.ts` | 0 — 2 passed（含回归反例臂） |
| `10db8786` + 本任务改动 | `npx vitest run packages/agent-runtime/test/request-assembly-context-survives-compaction.test.ts` | 0 — 3 passed（H-2 探针，**当时钉的是缺陷**） |
| `10db8786` + 本任务改动 | `npx vitest run packages/ai packages/agent-runtime` | 0 — 157 files / 1690 passed |
| `10db8786` + 本任务改动 | `npx vitest run packages/host/tests` | 0 — 178 files / 1637 passed, 1 skipped |
| `e797a7ee`（合并 base 后） | `npm run typecheck:all` | 0 |
| `e797a7ee` | `npm run architecture:check` | 0 — OK，no new boundary violations |
| `e797a7ee` | `npm run bundle:verify` | 0 — FRESH，0/923 |
| `e797a7ee` | `npx vitest run packages/ai packages/agent-runtime packages/host/tests/worker-product-runtime` | 0 — 181 files / 1822 passed |
| `08a5976e`（合入 H-1 + H-2/H-5 后） | `npm run typecheck:all` | 0 |
| `08a5976e` | `npm run architecture:check` | 0 — OK，no new boundary violations |
| `08a5976e` | `npm run bundle:verify` | 0 — FRESH，0/923 |
| `08a5976e` | `npx vitest run packages/agent-runtime packages/ai packages/host/tests/worker-product-runtime` | 0 — **183 files / 1837 passed** |
| `9bb97e21`（合入场景套件后） | `npx vitest run packages/host/tests/worker-product-runtime packages/ai packages/agent-runtime` | 0 — **188 files / 1863 passed** |
| `f999e072`（边界自身修复后） | `npx vitest run packages/ai/test/model-request-invariants.test.ts` | 0 — 26 passed |

**未覆盖 / 未验证**：

- 本 PR 链的 base 是 `codex/fix-prompt-last`（特性分支），**CI 矩阵不跑**（`.github/workflows/test.yml`
  的 `pull_request: branches: [master]`）。上表是全部证据。
- **H-6 未修**（compaction 探针少算 context 行）——归属 compaction owner。
- `codex/alt-prompt-absolute-last` 的对照结论基于代码阅读，未在它上面跑测试。
- 并行跑 `packages/host/tests` 时出现过跨用例干扰（单跑全绿、基线也绿），已由 A、B 各自核对为
  既有 flake，与本次改动无关。


