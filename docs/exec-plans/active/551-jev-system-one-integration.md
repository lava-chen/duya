# Plan 551: Jev / System One 决策模型基础设施 — AI 包接入 + computer-use 感知决策通道

> **Status**: ✅ Phase 1–3 实现完成（2026-09-19，代码+单测全绿）；Phase 4 设计增补已并入 415 §7.2；Electron 手动冒烟与 fixture token 基线实测待办
> **Priority**: P0
> **Created**: 2026-09-19
> **技术底稿**: [`docs/references/jev-model-research.md`](../../references/jev-model-research.md)（Jev API 契约、能力边界、jev-browser 25 条设计规则）
> **参考实现**: [Ying-Kai-Liao/jev-browser](https://github.com/Ying-Kai-Liao/jev-browser)（"LLM plans, Jev decides" 浏览器自动化，40/42 正确 / 0 false-done）、[typesafe-ai/skills](https://github.com/typesafe-ai/skills)（官方编程模型）、[LangChain: Building a Harness with Jev](https://www.langchain.com/blog/building-a-harness-with-jev)
> **相关 plan**: [454-computer-use-mode](./454-computer-use-mode.md)、[419-permission-decision-bus](./419-permission-decision-bus.md)、[415-workflow-mode-design](./415-workflow-mode-design.md)（终极承接方）、[552-workflow-rpa-agent-design](./552-workflow-rpa-agent-design.md)（415 companion，本 plan Phase 4 的实施归宿）、[519-computer-use-harness-gaps](./519-computer-use-harness-gaps.md)
> **背景**: duya 的 agent loop / computer-use / workflow（415）里有大量"小判断"（元素选择、状态判断、风险门控、verdict 佐证），目前要么靠 LLM 全量调用（秒级延迟、按生成计费、烧上下文），要么靠硬编码规则（脆）。Jev（TypeSafe，2026-09-16 发布）是首个商用的 "System One 模型"：state + 多问题一次并行请求 → typed 决策 + 校准概率，70–500ms、$0.042/MTok、输出免费。**终端目标：为 415 workflow RPA 的"确定性骨架"补上"感知不确定"缺口——tool 节点内循环由 Jev 做感知/门控，agent 只做规划。本 plan 负责其基础设施。**

---

## 1. Problem & Goal

**问题**：duya 三层（agent loop / computer-use / workflow）都缺一个廉价的"程序化常识"通道：

| 场景 | 现状 | System One 形态 |
|------|------|-----------------|
| computer-use 每轮选元素/判断完成 | LLM 每轮全量读屏（截图/AX tree 进上下文，秒级、贵） | Jev ~300ms 从结构化页面 state 里并行选 target/value/done/error |
| 工具风险门控（419 权限总线） | 规则 + LLM 审批（用户等待） | 执行前一个 noul（"这个动作不可逆吗"），jev-browser 实测 ~200 轮 0 误报 |
| workflow 高风险判定（415 §7） | 规划器 LLM 自评 | 节点级 noul 预筛 |
| verify verdict（454 verdict/） | verification subagent 全量推理 | score/noul 佐证 + 低置信升级 |

**Goal（本 plan 只做基础设施，不改变默认行为）**：
1. **@duya/ai 一等公民接入 System One API**——决策形态 ≠ chat 形态，独立 client 模块，不塞进 `providers/` chat 抽象。
2. **@duya/agent 决策层 `DecisionService`**——问题模板、阈值策略、(p, outcome) 校准日志、降级链（Jev → LLM structured-output → 规则）。
3. **computer-use 感知决策通道**——落地 "LLM plans, Jev decides"（jev-browser 模式），LLM 只定 outcome，Jev 做每轮感知决策，status 契约回传。
4. **为 415 铺路**（设计稿，不实施）——decision 原语进 workflow 节点类型表。

**用户决策（2026-09-19）**：尽快落地；终极目标是继承到 workflow 的 RPA（415）。

---

## 2. 设计原则（jev-browser 25 条设计规则中约束本 plan 的子集）

1. **Jev decides, never generates** — 一切自由文本作为候选（`values`/`options`）由调用方提供；模型只 choice/score/noul。
2. **One request per round, many questions** — 同一 state 的独立问题（含投机问题）全部放进一次请求；fan-out 便宜，分开调用才贵。
3. **选项用索引，对象放 state** — 候选列表按稳定顺序编号进 state，问题只引用索引。
4. **代码能算的摘要进 state**（counts/metrics/diff/sorted）— 不让模型比较原始列表。
5. **Code owns timing + loop safety** — settle 等待、(page, action) 环检测、动作上限，全部在代码层。
6. **返回分布，不返回猜测** — 低置信 → `ambiguous` + top-3 候选上交规划者，绝不静默猜。
7. **风险问题进同一 fan-out，代码里做门** — `irreversible` 是同一请求里多带的一个 noul；门限判断在代码（419 语义不变，Jev 只产出"建议"）。
8. **答案间不一致 = 不确定性信号** — 如 done 中置信且仍有动作提议 → 追加严格 confirmation 问题。
9. **灰区不上交判断** — 阈值带（如 0.45–0.65）返回 `likely_done` 类状态让上层复核；阈值可配置。
10. **降级优先** — 无 key / 超时 / API 失败 → 回退现有路径，**零行为破坏**；Jev 永远是可选加速器。

---

## 3. Phase 划分

### Phase 1 — `@duya/ai` System One client（AI 包接入）

新建 `packages/ai/src/system-one/`：

- [x] `types.ts` — `Question`（`choice`/`score`/`noul`，instructions/criteria/levels）、`DecisionResponse`（typed 值 + 概率分布 + confidence）、基数 255 上限校验
- [x] `client.ts` — `SystemOneClient`：单请求多问题（服务端并行）、`timeoutMs` 预算（默认 2000ms，Jev P99 ~500ms）、重试（复用 `utils/retry.ts` `retryOperation`，错误挂 `status` 让既有分类器自然判定 429/5xx 可重试）、`model` 可配（默认 `jev-latest`）
- [x] `config.ts` — `SystemOneConfig` 形状 + `resolveSystemOneConfig`（env `TYPESAFE_API_KEY`/`TYPESAFE_BASE_URL`/`TYPESAFE_MODEL`/`TYPESAFE_TIMEOUT_MS`）；`config.toml [system_one]` 的文件读取归 `@duya/agent/src/decisions/config.ts`（config root 与 TOML 解析本属 agent 层，避免 ai 包引入 fs/toml 依赖）
- [x] `index.ts` — 导出 **`DecisionClient` 接口**（薄抽象，Jev 是首个实现；LLM structured-output / 本地 SemIf 类后端是未来实现）
- [x] 单测 — `packages/ai/test/system-one.test.ts`（12 用例）fake transport 全契约：并行问题映射、部分失败、超时、非法响应、基数超限、瞬态重试 / 4xx 不重试
- **Gate**: ✅ `npx vitest run packages/ai`（含 551 用例全绿）+ typecheck 通过

> 明确不做：不进 `providers/` chat 抽象、不做流式、不做 prompt 模板（决策问题由上层构造）。

### Phase 2 — `@duya/agent` DecisionService（决策层）

新建 `packages/agent/src/decisions/`：

- [x] `service.ts` — `DecisionService`：封装 `DecisionClient`；问题模板库（route/risk/verify/done/error/blocked）；`ask(state, questions)` helper（链式降级 + 逐概率校准打点）
- [x] `policy.ts` — 阈值策略（`doneAt` 0.85 / `rejectAt` 0.45 / `irreversibleAt` 0.6 / `minTargetConfidence` 0.8，取 jev-browser 实测工作点作起点），全部可配置；灰区语义 = `evaluateNoul` 返回 `uncertain` 而非猜测
- [x] `calibration.ts` — (kind, question, probability, outcome) 记录 → agent 结构化 logger（component `decisions`，DEBUG 落文件），`CalibrationSink` 可注入测试
- [x] `fallback.ts` — `LlmDecisionFallback implements DecisionClient`（最小 `chat` 面 + JSON schema 提示 + 宽进严出解析，解析失败抛错交上层规则）；降级事件 DEBUG 打点
- [x] `config.ts` — `config.toml [system_one]`（enabled/api_key/model/base_url/timeout_ms/policy/prescreen）读取（`resolveConfigRoot` + `@iarna/toml`，缺省静默）
- [x] 接入点（infra 通道，默认关闭）：
  - [x] 419 permission bus 预筛通道：`createPermissionPrescreener` + 权限 gate 步骤 4.75（仅在即将 auto-allow 的路径触发；产出 `jev:suggest_gate p=…` decisionReason 注记 + WARN 日志，**不改 419 决策语义**）
  - [x] ~~模型路由实验位~~（P2，按 plan 预设砍掉；`DecisionClient` 抽象已为其留位）
- **Gate**: ✅ 单测 16 用例含"无 key 时 `available=false` 零差异"回归；typecheck 通过

### Phase 3 — computer-use 感知决策通道（RPA 基础设施核心）

`packages/computer-use` 新增 `src/decide/`（对齐 454/519 的既有模块边界；包新增 `@duya/ai` 依赖，单向无环）：

- [x] `describe.ts` — **状态构造器**：SOM elements（索引+label+kind+中心坐标）、`metrics`（元素数/label 字符数/kind 计数/255 截断标记）、`repeated_elements` 计数、`last_change`（appeared/disappeared/moved 代码 diff）——代码可算的全部算好；AX tree / dialog 列表随 519 AX 通道落地接入
- [x] `questions.ts` — 每轮固定 fan-out 模板：`target`(choice, 索引) / `value`(choice, 来自调用方 values) / `done`(noul) / `done_change`(noul，第 2 轮起) / `error`(noul) / `blocked`(noul) / `irreversible`(noul)——**一次请求**；另含 `done_confirm` 严格复核问题（设计规则 #8）
- [x] `controller.ts` — 内循环：settle → describe → ask → act（ports 注入）→ (kind,target) 环检测（>2 → stuck）/ 动作上限 / 灰区 strict re-ask；status 契约 `done | likely_done | needs_confirmation | error | stuck | ambiguous | blocked | max_actions`；ambiguous 携带 top-3 候选分布
- [x] `confirm-gate.ts` — `createExecutorConfirmGate`（Electron 执行器自带审批弹卡 → confirm=执行即审批）+ `createBridgeConfirmGate`（执行器不弹卡时先问 `approval/` ApprovalBridge）——复用 498/419 审批管线，不建新通道
- [x] `verdict-bridge.ts` — 454 verdict 的可选佐证：`assessVerdict` 一次 noul 佐证 read-back，低置信/灰区 → escalate（后端失败返回 null，不改变现有 verdict 行为）
- [x] agent 侧接线（"LLM 定 outcome + decide 通道内循环 + status≠done 时 LLM 才接管"）：`OSTool/ComputerUseDecideTool.ts`（`computer_use_decide`：task+values+maxActions → 内循环经既有 `computer-use:execute` IPC 执行，不新增主进程 action；无后端时结构化 `DECIDE_UNAVAILABLE`）+ computer-use-mode 函数式 inject 条件注入（`getComputerUseToolsWithDecide`）+ 条件 prompt 小节（无后端不注入也不提及）
- **Gate**: ✅ 离线 fixture 测试 21 用例（no network、假 backend，jev-browser bench 思路）；typecheck 通过；Electron 手动冒烟待办

### Phase 4 — Workflow 桥（设计稿，实施归 415）

- [x] 415 文档新增 §7.2：tool 节点内循环 = Phase 3 decide 通道（status 契约映射节点成功/失败/`awaiting_confirm`）；新增可选 `decide` 节点原语（noul/score 直接进 `when` 表达式求值，灰区走 `on_uncertain`）
- [x] 415 §7 规划器高风险判定：节点级 risk noul 预筛（`awaiting_confirm` 触发依据之一，现有规则标记仍是第一道）
- [x] 本 phase 只产出设计增补到 415 文档（已落地），不写引擎代码

---

## 4. Non-Goals

- **不替换 LLM / 不做聊天**：Jev 无生成能力，open-ended 推理仍归 LLM。
- **不改变默认行为**：无 key / 未启用时所有路径与现状逐字节一致；Jev 是可选加速器。
- **不做 419 权限语义变更**：Jev 风险预筛只产"建议"，准入决策仍在权限总线与用户。
- **不押注单一后端**：`DecisionClient` 是抽象；权重不开放、定价变更、服务下线时，LLM structured-output fallback（官方 adapter 同款思路）与本地开源复刻（SemIf 路线）可接管。
- **Phase 4 实施不在本 plan**（归 415 执行时合入）。

---

## 5. 风险与对策

| 风险 | 依据 | 对策 |
|------|------|------|
| schema-valid ≠ correct（"自信地错"） | HN 共识，CEO 本人确认 | 灰区 `uncertain` 状态 + 上层复核；(p, outcome) 校准日志持续调阈值；不把单点 noul 当许可证 |
| 外部依赖（闭源 hosted API、初创、waitlist） | 无公开权重/benchmark，定价可持续性未证明 | `DecisionClient` 抽象 + 降级链（Phase 2 fallback）+ timeout 预算 |
| describe 层工程量被低估 | jev-browser 11 个修复里 8 个是 describe 缺口（非模型问题） | Phase 3 describe 单列 + fixture 测试先行；代码可算摘要全部代码算 |
| 灰区不可调（0.51–0.57 曾 3 错 2 对） | jev-browser 设计笔记 #13 | 灰区不硬判，直接上交；阈值按域配置，不用官方 demo 数字 |
| 无序子目标/开放式目标失败 | jev-browser 实证：规划必须归 LLM | 契约里 status ≠ done 即 LLM 接管；decide 通道永不自行拆步 |

---

## 6. 验收口径

1. Phase 1–2 合入后：无 `TYPESAFE_API_KEY` 的环境下，`npm run test` / `typecheck:all` 全绿，现有 e2e 零差异。
2. Phase 3 后：computer-use-mode 在 fixture 集上，启用 Jev 时 LLM 上下文 token 消耗对比基线有实测记录（目标中位数 ≥3×↓），0 次 false-done（`done` 高置信但任务未完成的终态上报）。
3. 校准日志可用：能从日志重建 (probability, outcome) 散点并调 `doneAt`/`irreversibleAt`。
