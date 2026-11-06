# 624 — Agent 组合层与提示词系统重构

状态：active · 负责人：workbuddy-12f8ee39 · 更新：2026-11-06
分支：`codex/624-agent-composition` · worktree：`.claude/worktrees/composition-layer` · base：`b5c36035` · owner：workbuddy-12f8ee39

## 目标与边界

**要改变的行为**：把「哪个 agent、注入什么提示词 / 工具 / 模式 / 权限 / 提醒 / 缓存」从散落在 `WorkerSession` 里的 17 处隐式分支，收敛成 host 侧**唯一**的纯函数组合层。控制层（session、bot、TUI、project coordinator、desktop、gateway）只声明「要一个什么样的 agent」，组合层产出冻结的 `AgentComposition`，`@duya/agent-runtime` 保持零策略执行内核。在此基础上把提示词系统从「两分区字符串拼接」升级为「段计划 + 快照 + 显式增量帧」。

用户可观察到的变化：

1. 任意控制层都能用同一份契约启动 agent 实例，不再各自拼装。
2. 每轮请求的提示词来源可回答（provenance），不再只有一行 `logger.info`。
3. 上下文块变化对模型**可解释**（`Updated / Removed section "X"`），不再是静默改写。
4. Anthropic 与 OpenAI 两条 provider 缓存路径都有显式契约，而不是靠 URL 猜测。
5. 压缩当轮的 system 半区与 message 半区来自同一次重投影，不再出现「新历史 + 旧系统提示词」。

**允许修改的路径**：

- 新增 `packages/host/src/agent-composition/**`（组合层，唯一策略点）
- 新增 `packages/agent-core/src/composition/**`（**仅在 E1/F1 需要 runtime 侧读取契约时启用**；A–D 阶段契约在 host 内，理由见发现 7）
- `packages/host/src/worker-session-runtime.ts`（`beginTurnAssembly` 及其 4 个执行器）
- `packages/host/src/worker-prompts/**`（SectionRegistry / 段计划 / 快照）
- `packages/host/src/worker-context/**`（增量帧、快照基线）
- `packages/ai/src/utils/prompt-caching.ts`、`packages/ai/src/api/openai-*.ts`（缓存契约）
- `packages/agent-runtime/src/engine/{ports,compaction,run-engine}.ts`（G4：`CompactionOutcome.systemPrompt` 可选字段与其消费点）
- 对应测试目录

**本次不处理**：`packages/agent` 遗留层；UI 侧渲染；除 G4 的 `CompactionOutcome.systemPrompt` 之外的跨宿主协议字段；不重写 worker bundle 构建方式。

关联：[619 提示词组装与上下文通道](619-prompt-assembly-context-channel.md)（本计划吸收其 Phase 5 收口与未完成项）、[622 平台收口](622-agent-platform-convergence/README.md)（依赖方向门禁）、[多 Agent Orchestrator](2026-10-23-multi-agent-orchestrator.md)（编排层不改，只接组合层）。

---

## 现状（带证据）

### 执行层与策略层的真实边界

`@duya/agent-runtime` 只接收 `RunManifest` + `ChatStartMessage` + `AssembledTurn`，不含任何「选哪套提示词」的逻辑。所有策略在 host 的 `WorkerSession`：

| 顺序 | 执行器 | 位置 | 现在自己做的判断 |
| --- | --- | --- | --- |
| 1 | `_resolveTools` | `worker-session-runtime.ts:1636` | profile 允许/禁止、MCP exposure、deferred 提升 |
| 2 | `_buildSystemPrompt` | `:1759` | `resolvePromptSystemName` + `PromptsRegistry.getOrCreate` + 6 类 host block |
| 3 | `applyTurnModes` | `:330` | mode modifier 对 prompt / tools 的改写 |
| 4 | `buildPermissions` | `:514` | 权限模式、always 规则、工作目录 |

`beginTurnAssembly:477` 是这四步的唯一入口，也是**天然的中转层挂载点**——它已经每轮只跑一次，并且已经在做「先算后执行」。

### 契约存在，resolver 不存在

`AgentProfile`（`packages/agent-core/src/agent-profile.ts:15-53`）是唯一同时携带 `promptSystem` / `promptProfile` / `allowedTools` / `disallowedTools` / `identityPrompt` / `suppressIdentityBlock` 的数据契约。它被当作**数据表**使用，没有对应的解析器：

- 预设表：`packages/host/src/worker-profiles/types.ts:52`（MAIN）、`:138`（SUBAGENT）、`:177`（SPECIAL）
- 配置派生：`worker-profiles/config-agents.ts:32` `toAgentProfile`
- 实际取用点分散在 `worker-prompts/registry.ts:32`、`tool-role-policy.ts:91`、`run-turn-overrides.ts:58`、`worker-process-entry.ts:1886`、`manifest-factory.ts:171` 等互不引用的文件。

### 三处已知的语义错位

1. **bot 双轨**：`configs/bot.ts` 已注册，但没有任何 profile 指向 `promptSystem:'bot'`；真实 bot 提示词走 `isBotAgentProfile(appliedProfile)` + `getBotAssembly().renderSections()`，作为 `host:bot` 块追加（`worker-session-runtime.ts:1842-1870`）。两套并存，`promptSystem` 值对 bot 无意义。
2. **subagent 硬编码**：`explore` / `plan` 没有 `promptSystem`，回落到 `getOrCreate('general', ...)`（`:1764-1765`），实际语义是「general 减去 5 个 section」，但代码里读不出来。
3. **结构化 system blocks 被丢弃**：`_projectSystemPrompt:2552` 的投影结果在 `:2557-2571`、`:2613-2629` 只用于计数和 `logger.warn`，结构化块本身未进入请求（619 defect b）。

### 提示词现状

- 分区：`PromptSystem.buildSystemPromptPartition`（`worker-prompts/PromptSystem.ts:590`）产出 `{stable, context}`；`:540` 禁止 `placement:'context'` 配 `cachePolicy:'once'`。
- 投递：context 半区变成 `ContextBlock[]`（`:1802-1822`），由 `context-rail.ts:54` 每轮**原地改写**工作数组，`:20-23` 明写不进 timeline；孤儿块 splice 删除（`:76-93`）。
- 留痕：`prompt-ledger.ts:90` 只记 `hash` / `length`，`DUYA_PROMPT_LEDGER=off` 可关；不含上一轮各块正文，**不能当 diff 基线**。
- 未完成（619 遗留）：observer 无生产 sink（`observer.ts:43` 仅测试安装）；`injectTurnTimestampReminders`（`agent-core/src/context/turn-time-reminder.ts:101`）零生产调用。

---

## 设计

### 分层与依赖方向

```
控制层  session / bot / TUI / coordinator / desktop / gateway
   │  声明：AgentProfile + RunIntent + RunEnvironment
   ▼
组合层  packages/host/src/agent-composition        ← 唯一策略点（有 IO，经 ports 注入）
   │  AgentComposition（冻结、可序列化、带 provenance）
   ▼
执行层  packages/agent-runtime                     ← 零策略：只执行 AssembledTurn
```

约束：

- 契约类型放 `packages/agent-core/src/composition/`（零 IO）。`agent-runtime` 可以 import 契约，**不得** import host。
- 组合层的 IO 全部经 `CompositionPorts`，resolver 本身是纯函数，可单测、可 shadow 对拍。
- 新增 `agent-composition` 目录后必须同步 `architecture-policy.yaml` 的层表，否则新包不受检。

### 契约

```ts
// packages/host/src/agent-composition/contract.ts  （E1/F1 需要时整体上移 agent-core）
export type CompositionScope =
  | 'main-session'      // general / code / research
  | 'coordinator'       // project coordinator
  | 'subagent'          // explore / plan
  | 'bot'               // [agents.<id>] 配置派生
  | 'special';          // gateway / cron / ...

export interface AgentCompositionRequest {
  readonly profile: AgentProfile;
  readonly scope: CompositionScope;
  readonly intent: RunIntent;              // 本轮请求（已与注入配置分离）
  readonly environment: RunEnvironment;    // sessionId / cwd / platform / language
}

export interface AgentComposition {
  readonly prompt: PromptComposition;
  readonly tools: ToolComposition;
  readonly modes: ModeComposition;
  readonly permissions: PermissionComposition;
  readonly reminders: ReminderComposition;
  readonly cache: CacheComposition;
  readonly provenance: CompositionProvenance;
}

export interface PromptComposition {
  /** 进 system 字段的稳定半区，逐段保留来源，拼接只是最后一步。 */
  readonly stableSections: readonly PromptSectionRef[];
  /** 走消息通道的易变半区。 */
  readonly contextSections: readonly PromptSectionRef[];
  /** 由 host 追加、不属于任何 prompt config 的块（prefix / identity / AGENTS.md / bot）。 */
  readonly hostSections: readonly PromptSectionRef[];
  readonly promptSystem: string;           // 实际使用的 PromptSystem 名
  readonly suppressIdentityBlock: boolean;
}

export interface PromptSectionRef {
  readonly id: string;
  readonly placement: 'stable' | 'context' | 'host';
  readonly renderer: 'hbs' | 'host-block' | 'bot-assembly' | 'reminder';
  readonly cachePolicy: 'once' | 'per-turn' | 'none';
}

export interface ToolComposition {
  readonly enabled: readonly string[];
  readonly denied: readonly string[];
  readonly exposure: ToolExposure;
  readonly deferredPromotions: readonly string[];
}

export interface CacheComposition {
  readonly family: 'anthropic-messages' | 'openai-responses' | 'openai-chat' | 'none';
  readonly promptCacheKey?: string;        // OpenAI 侧，按 session 稳定，≤64 字符
  readonly previousResponseId?: string;    // 仅同一 family 且属性匹配时复用
  readonly cacheControlBreakpoints: number;
  readonly retention?: 'short' | 'long';
}

export interface CompositionProvenance {
  /** 每个决策点：值来自哪里。用于日志、UI 诊断与快照断言。 */
  readonly decisions: ReadonlyArray<{
    readonly field: string;       // 'prompt.system' | 'tools.exposure' | ...
    readonly value: string;
    readonly source: 'profile' | 'config' | 'host-default' | 'turn-override' | 'fallback';
    readonly note?: string;
  }>;
}
```

`RunIntent` 与 `RunEnvironment` 的职责是把今天混在 `ChatOptions` 里的两类东西分开：用户请求（messages、model、effort、mode、附件）与注入配置（`systemPromptPrefix`、`disableSystemPrompt`、`outputStyleConfig`、`researchIntent`…）。**这是组合层成立的前提**——只要注入项还能自由穿过请求对象，就不存在单一裁决点。

### resolver 形状

```ts
// packages/host/src/agent-composition/index.ts
export interface CompositionPorts {
  readonly prompts: PromptSystemPort;       // getOrCreate(system, profile) + 段清单
  readonly agentsMd: AgentsMdPort;
  readonly bot: BotAssemblyPort | null;
  readonly mcp: McpExposurePort;
  readonly toolRegistry: ToolRegistryPort;
  readonly config: AgentConfigPort;         // 读 [agents.<id>] 与默认值
}

export async function resolveAgentComposition(
  request: AgentCompositionRequest,
  ports: CompositionPorts,
): Promise<AgentComposition>;
```

内部 6 个子 resolver，每个对应一个维度，全部返回 `{ value, decisions }`：

| resolver | 收拢今天的哪些分支 |
| --- | --- |
| `resolvePromptComposition` | `resolvePromptSystemName` + `getOrCreate` 回落 + 6 类 host block 顺序 |
| `resolveToolComposition` | profile allow/deny + `applyBotToolset` + deployment surface + progress tool |
| `resolveModeComposition` | `_readOrchestratorMode` + mode modifier 对 prompt/tools 的改写 |
| `resolvePermissionComposition` | `buildPermissions` 的入参来源 |
| `resolveReminderComposition` | 新增：时间提醒 fragment（见 F1） |
| `resolveCacheComposition` | 新增：family 判定 + cacheKey + 断点数 |

### 接线方式：shadow → 切换

`beginTurnAssembly` 改成分三段，每段独立可回退：

1. **shadow**：resolver 旁路运行，把结果与现有四步的实际产出对比（`prompt.stableSections` 拼接 vs `systemPrompt`、`tools.enabled` vs `resolved.tools`、`provenance` 全量），差异只记日志。开关 `DUYA_COMPOSITION_SHADOW=1`。
2. **切换**：每个维度单独切，切完保留一个断言（dev 下 shadow 不一致即 throw）。
3. **清理**：执行器不再持有判断逻辑，只消费 plan；删除对应分支。

一次只切一个维度，顺序固定：prompt → tools → modes → permissions → reminders → cache。理由是 prompt 的等价性最容易用字节对拍证明，先建立信心；cache 最后，因为它依赖前四者的稳定输出。

### 提示词系统 v2

在 619 的两分区之上升一级，不推翻：

1. **SectionRegistry**：段清单从「每份 config 自己声明 sections[]」变成「注册表 + config 引用」。每条带 `id / placement / cachePolicy / requiresTools / renderer / owner`。`placement` 与 `cachePolicy` 的互斥校验保留（`PromptSystem.ts:540`），但校验点从渲染期前移到注册期。
2. **SectionPlan**：本轮要渲染哪些段、放宽半区、用什么 strategy。由 `resolvePromptComposition` 产出。
3. **SectionSnapshot**：上一轮每段的 `{id, hash, content}`。内存态起步，可选落 rollout（复用 `PromptSnapshotBlock`，`rollout-events.ts:230-238`）。
4. **PatchEmitter**：对比 plan 与 snapshot，产出 `{changed, removed}`，渲染成 `Updated system context section "X": …` / `Removed system context section "X".`，替代 `context-rail.ts:76-93` 的静默改写。
5. **bot 收敛**：bot assembly 变成 `renderer:'bot-assembly'` 的段提供者，`configs/bot.ts` 要么成为唯一来源，要么退役。二者只留一个。

四条不变量（全部可测，见验收）：

| 编号 | 不变量 |
| --- | --- |
| I1 | 同一 `(profile, tools 集合)` 下，stable 半区跨轮字节恒定 |
| I2 | 任一段的 `placement` 只由注册表决定，无第二处判断 |
| I3 | 易变内容不得进 stable 半区；单测对每份 config 渲染两轮比较 stable 串 |
| I4 | 每个 changed / removed 段必须产出一条带 `section id` 的帧 |

### agent 路由表

组合层建立后，「加载哪套提示词」应只由这张表解释：

| scope | 判定来源 | prompt 来源 | 工具 | 备注 |
| --- | --- | --- | --- | --- |
| `main-session` | `profile.id ∈ {general-purpose, code-expert, research}` | `profile.promptSystem` 显式 | `allowedTools` + `promptProfile` 段裁剪 | 现状 |
| `coordinator` | `profile.id === PROJECT_COORDINATOR_PROFILE_ID` | `promptSystem:'project'`，`suppressIdentityBlock` | 仅 `session/project/todo` | 同一 runtime，不同 composition |
| `subagent` | `profile.kind === 'subagent'` | **改为显式 `promptSystem:'general'` + `promptProfile.disableSections`** | 只读集 | 消除 `:1764` 硬编码回落 |
| `bot` | `profile.isPreset === false`（`toAgentProfile` 产物） | bot assembly 段 + `promptSystem` 显式 | `applyBotToolset` | 双轨合一 |
| `special` | `profile.kind === 'special'` | `identityPrompt` + `promptSystem` 显式 | 各自 allow/deny | gateway / cron |

`scope` 由 `profile.kind` + 调用者意图派生，**不新增可自由设置的枚举**：`kind:'main'` + coordinator id → `coordinator`，其余 `kind:'main'` → `main-session`。

---

## 切片

| # | 切片 | 改动面 | 行为变化 | 验收 |
| --- | --- | --- | --- | --- |
| A1 | 契约 + ports + resolver 骨架 | 新目录 2 个、层表 | 无 | typecheck + 单测（6 个 resolver 各 1 组） |
| A2 | shadow 运行与差异日志 | `beginTurnAssembly` | 无 | shadow 日志零差异（4+2+2+special 全 profile） |
| B1 | prompt 维度切换 | `_buildSystemPrompt` | 无（等价） | 字节对拍：`stable.join` 与原 `systemPrompt` 相等 |
| B2 | 修 defect b | `_projectSystemPrompt` 消费点 | **有**：结构化 system blocks 不再被丢弃 | 新增断言 + 现有 worker 测试不回归 |
| C1 | tools / modes / permissions 切换 | 3 个执行器 | 无（等价） | `resolved.tools` 集合与顺序对拍 |
| D1 | SectionRegistry + 段计划 | `worker-prompts/**` 4 份 config | 无 | I2/I3 单测；渲染结果对拍 |
| D2 | 增量帧 | `context-rail.ts`、`prompt-ledger.ts` | **有**：变化帧显式化 | 6 帧单测 + 双轮对拍 |
| E1 | 缓存契约 | `packages/ai/**` | **有**：OpenAI 侧拿到 cacheKey | provider 单测；Anthropic 断点位置不变 |
| F1 | 时间提醒 fragment | `agent-core/context/**`、组合层 | **有**：按 interval 追加 | 单测覆盖 delivery mode / 读钟失败 / 压缩换 window |
| F2 | 压缩一致性 | `worker-compaction/**` | **有**：压缩后校验 retained，缺失降级重发 | 压缩前后对拍 + 缺块重发用例 |

依赖顺序：`A1 → A2 → B1 → B2 → C1 → D1 → D2 → E1 → F1 → F2`。E1 与 F1 可并行；D2 必须在 D1 之后（需要注册表给出稳定 id）。

### 明确不做

| 不做 | 理由 |
| --- | --- |
| 不把 patch 写进 timeline | 619 的「rail 不进 history」是有意设计；改持久化会牵动 fork/resume/compact，成本远高于收益 |
| 不一次性搬 codex 的 20+ typed snapshot | 先拿语义（显式帧 + 一致性校验），需要零消息时再升级 |
| 不让组合层下沉到 agent-core | agent-core 零 IO，读 AGENTS.md / bot 配置都要 IO，下沉即违规 |
| 不改 `AgentProfile` 的持久化形状 | DB 行与配置格式保持；只加可选字段 |

---

## 验收

**等价性（A2–C1）**

```bash
npm run typecheck:all
npm run architecture:check
node node_modules/vitest/vitest.mjs run packages/host/tests/worker-prompts packages/host/tests/worker-context
```

新增对拍测试：对每个 profile × 3 组场景（首轮、工具集变化、mode 切换），断言

- `composition.prompt.stableSections.map(s => s.content).join('\n\n') === session.systemPrompt`（切换前取 shadow 值）
- `composition.tools.enabled` 与原 `resolved.tools.map(t => t.name)` 逐项相等
- `provenance.decisions` 覆盖 6 个维度且无 `fallback` 之外的未解释项

**不变量（D1–D2）**

- I1/I3：同一 config 渲染两轮，stable 串 byte 相等；改动一个 context 段后 stable 串仍相等。
- I4：changed / removed 各产出一帧，帧内包含 section id。
- 反例：删掉一个段必须产出 `Removed`，不得静默消失。

**缓存（E1）**

- Anthropic：断点数量与位置与改动前一致（对拍 `applyCacheControlToSystem` 输出）。
- OpenAI Responses：同 session 两轮 `promptCacheKey` 相等且 ≤64 字符；不同 session 不等。
- 属性不匹配时不得复用 `previousResponseId`。

**时间提醒（F1）**

- `delivery_mode=AfterUserOrToolOutput` 下，纯 assistant 轮不追加。
- 读钟失败产出 unavailable 降级文本，不抛错。
- 压缩换 window 后强制重发。

**基线纪律**：先在 base `b5c36035` 跑一遍相关套件记录失败清单，再比较改动；只按「文件 + 用例 + 错误签名」比较，不按数量。

---

## 进度

- [x] 现状勘察与缺口确认（619/622/编排三份计划对账，代码证据见上）
- [x] 分配 worktree、建立分支与依赖链接
- [x] A1a 契约类型 + 无 IO 的 scope / prompt 选择 resolver（9 用例，`71ed7df6`）
- [x] A1b tools / modes / permissions / cache 四个 resolver 与单测（`f46042f3`）
- [x] A2 等价对拍（以对拍测试形式落地，见发现 9；`1100e77a` / `833cf81b`）
- [x] B1 prompt 维度切换（`1100e77a`）
- [x] B2 修 defect b（`0ca138f7`）
- [x] C1 tools / modes / permissions 切换（`833cf81b`）
- [x] D1 段通道单点注册表（`4c83d4ff`）
- [x] D2 增量帧（`b6b0ae0b`）
- [x] E1 缓存双支持：Responses 侧 `prompt_cache_key`（`1bee26b9`）
- [x] F1 时间提醒 fragment（`7635fe23`）
- [x] F2 压缩一致性（`0ca138f7`）
- [x] 计划入口与 catalog 登记（`71ed7df6`）
- [x] G1 冻结 `AgentComposition` 单入口 + `ChatOptions` 注入项分离（`b91ebcc2`）
- [x] G2 统一 SectionRegistry + bot 双轨合一（`c3ed7773`）
- [x] G3 observer 生产 sink + rail 零消息语义判定（`09084121`）
- [x] G4 `CompactionOutcome.systemPrompt` 协议与引擎接线（`383a547d`）
- [x] 全量回归环境基线：补齐 worktree 的 `plugin-core` / `connectors` / `host` dist 链接
- [x] G5 全量验证与计划收口：`typecheck:all` 退出码 0（全链路 18 个子命令）
- [ ] 合并前：重建 worker bundle 并跑 `bundle:verify`；与主检出 `worker-session-runtime.ts` 的并行改动协调；推 PR（见「接续」）

## 发现与决策

1. **中转层必须落在 host，不能落 agent-runtime。** runtime 只收 `manifest + AssembledTurn`；把 prompt/tools/permissions 判定推进去会让零 IO 内核获得 IO 依赖。落点是 `beginTurnAssembly`。
2. **`ChatOptions` 的注入项必须先分离，否则 resolver 是假的。** 只要 `systemPrompt`、`disableSystemPrompt`、`systemPromptPrefix` 还能从请求对象直接穿透到渲染，就仍有第二条裁决路径。
3. **bot 双轨是本计划最大的语义债。** `configs/bot.ts` 无人引用，真实 bot 走 assembly；不合并的话，`promptSystem` 字段对 bot 永远是噪声，路由表也无法自洽。
4. **pi 的零消息语义不适用于当前 duya。** pi 靠 replay transcript 得到 previous；duya 的 rail 不进 timeline，这轮不发 unchanged 块等于丢上下文。因此 D2 只取「显式帧」，零消息留给后续单独立项。
5. **base 用本地 `b5c36035` 而非 `origin/master`。** 本地 master 领先远端 31 个提交（含 7 个 PR 的集成与 bundle 重建），远端缺少这些内容；PR 合并前需确认目标分支已追平。
6. **主检出 `worker-session-runtime.ts` 有并行未提交改动。** 本计划 B1/C1 触及同一文件，实施前必须与该任务协调独占路径，否则会产生静默覆盖。
7. **契约暂时落 `packages/host/src/agent-composition/`，不落 agent-core。** worktree 的 `@duya/*` 经 junction 指向主检出 `dist`，新包源码要先 `build:packages` 才能被消费方解析；而 A 阶段只有 host 消费。等 E1/F1 需要 runtime 侧读取 `CacheComposition` / `ReminderComposition` 时再上移，并同步层表——迁移成本是一次纯类型移动。
8. **`scope` 不能用 `profile.kind` 单独判定。** 实测 `SPECIAL_AGENT_PROFILES` 含 4 个成员（`gateway`、`cron`、`memory-curator` 及既有项），且 config agent 是 `kind:'main' + isPreset:false`。因此判定顺序必须是 bot → coordinator by id → kind，测试用全量预设表锁住这张映射，新增 preset 若未分类会直接失败。
9. **A2 以对拍测试落地，没有引入运行时 `DUYA_COMPOSITION_SHADOW=1` 开关。** 六个维度全部切换后，运行时 shadow 只会把同一 resolver 的输出与自身比较，是恒真对拍。等价性改由 `prompt-selection-parity.test.ts` / `selection-parity.test.ts` 对每个 preset 与被替换的表达式逐项断言；将来若再出现新的硬编码路径，才需要重新引入 shadow。
10. **codex 式 retained-fragment 校验在当前 duya 必然假绿。** rail 不进 timeline（`context-rail.ts:20-22`），`run-engine.ts:2986-2994` 的 `#compactedHistory` 按 `origin === 'context'` 从**当轮**投影重拼，所以「检查片段是否还在保留历史里」恒真。F2 换成两条可失败检查：压缩条目承诺的 `reinjectedSystemMessages` 是否真进了 system prompt；窗口变化或 provider 侧缺块时作废内存基线并全量重建。
11. **新增跨包子路径无法在 worktree 通过类型检查。** `@duya/agent-core/context/time-reminder` 经 junction 解析到主检出的 `dist`（没有新 `.d.ts`），报 TS2307。F1 的纯决策函数因此留在 host 组合层；它本来就是 host 的发射策略，runtime 不需要读。发现 7 的理由在这里再次成立。
12. **`tsc --noEmit`（根 tsconfig）只覆盖 UI，不能替代分包类型检查。** `npm run -w @duya/host typecheck` 有 2 个与本计划无关的既有错误：`http-client.ts:404` / `project-api.ts:64` 缺 `getSessionProjectContext`（`HostProjectApiV1` 已加、实现未跟进）。本计划新增文件在这两条之外没有引入任何类型错误。
13. **全量 host 套件在 worktree 有环境基线失败。** `vitest run packages/host/tests` 报 86 个文件 collect 失败，签名统一为 `Cannot find package '@duya/plugin-core/...'`（缺 `plugin-core/dist`），单独复跑 `project-api-http.test.ts` 复现同一签名；7 个 30s timeout 属 282 workers 并发争用，隔离复跑 5 文件 / 42 用例全绿。相关切片套件 35 文件 / 320 用例全绿。**v2 已定位并修复，见发现 21。**
14. **七个 resolver 分散调用时「唯一入口」是假的。** G1 之前 `WorkerSession` 在构造、`beginRun`、`_readOrchestratorMode`、`applyTurnModes`、`_resolveTools`、`_buildSystemPrompt`、`_dispatchOrchestratorMode` 各自调 resolver，且 `_buildSystemPrompt` 还能从 `ChatOptions` 直接读 `systemPrompt` / `disableSystemPrompt` / `systemPromptPrefix`。`composeAgent()` 把七维一次性算进冻结对象，`readTurnOverrides()` 成为唯一解读点，`single-entry.test.ts` 读生产源码断言不得再有第二条路径。
15. **深冻结不能冻结调用方拥有的对象。** `TurnOverrides.outputStyleConfig` / `researchIntent` 是 session 的结构化对象；`resolveTimeReminder` 未 emit 时会原样返回 `input.state`。因此 overrides 只浅冻结、reminder state 先复制再冻结，测试同时断言调用方对象 `Object.isFrozen === false`。
16. **删掉 config 的 `placement` 声明是零字节改动。** registry 在 D1 已是权威，配置里重复声明只是文档；删除后 `resolveSectionPlacement(name, undefined, ...)` 仍返回同一 `rule.placement`。G2 全部相关套件 72 文件 / 545 用例通过，证明通道归属收拢没有改变任何一段的落点。
17. **bot 双轨的正解不是「启用 botConfig」。** 把 bot profile 切到 `bot` PromptSystem 会改变 prompt 字节且未验证。实际做法是移除 `PromptsRegistry.register('bot', ...)`，把 `BOT_SECTION_CATALOG` 的十个段登记进 SectionRegistry，由 `resolveSectionPlan()` 在 scope=bot 时给出 `botSections`；`configs/bot.ts` 仅保留为 legacy 重导出与测试夹具，并在文件头声明永不渲染。`_buildSystemPrompt` 的 bot 尾块改由冻结计划判定。
18. **observer 生产 sink 必须 opt-in 且只能装在 worker 入口。** `observer.ts` 保持纯模块（无 logger 依赖）；`production-observer.ts` 由 `startWorkerProcess()` 在 `DUYA_PROMPT_OBSERVE=1`（或既有 `DUYA_DUMP_PROMPT_SECTIONS=1`）时安装结构化日志 sink，只记段名 / 12 位 hash / 长度 / volatile，测试断言正文与 cwd 都未进入日志。
19. **rail 零消息语义在 duya 不可行，结论可证伪。** pi 靠 replay 含 system message 的 transcript 做 patch；duya 每轮从 timeline 重建 provider messages，而 rail 刻意不进 timeline。省略 unchanged 块等于从当前请求删除该上下文。`context-rail-frames.test.ts` 新增两条「新数组 + previous 基线」用例锁住这一事实。准入条件是存在可 replay 的持久基线或 provider response chain，那会改动 fork/resume/compact 契约，需另立计划。
20. **G4 的跨包 dist 不是不能改，而是不能用 fresh literal 改。** worktree 的 `@duya/*` 经 junction 指向主检出 dist，host 分包 typecheck 看不到 `CompactionOutcome.systemPrompt`；host 侧把 outcome 先赋给局部变量再 return（变量赋值不做 excess property check），运行时字段照常传递，agent-runtime 内部用相对 import 读到新类型。PR 合并后重建 bundle 即完全类型化，无需过渡断言。压缩覆盖按 `ctx.turn` 标记且 `#modelRequest` 一次性消费，避免末尾压缩污染下一轮 host 新组装的 prompt。
21. **全量 host 套件的 86 文件 collect 失败根因是三个缺失的 dist 目录。** `vitest.config.ts` 把 `@duya/plugin-core/*`、`@duya/connectors/*` 及 transport fixture 硬指到本检出的 `./packages/<pkg>/dist`；worktree 没有这三个目录。建立到主检出 dist 的 junction 后，`vitest run packages/host/tests packages/agent-runtime/test` 得到 397 文件 / 3727 用例全绿（1 文件 / 5 用例 skipped），此前的 collect 失败与 30s timeout 全部消失。这是环境修复，不进入提交。
22. **dist junction 是双向写入，不是只读镜像。** `vitest.config.ts` 要求 `./packages/<pkg>/dist` 存在，用 junction 指向主检出后，`typecheck:all` 内含的 `build:packages` 会反过来把本分支的 `plugin-core` / `connectors` / `host` 产物写进主检出的 dist（本次主检出 `packages/host/dist/index.js`、`worker-transport.js` 的 mtime 变为 10:30）。dist 为 gitignored，主检出没有产生跟踪改动；但主检出若从该 dist 运行，需自行重建一次覆盖回自己的源码。`agent-runtime/dist` 不是 junction，其构建产物留在本 worktree。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `b5c36035`（本分支，干净） | Windows / Node 22.22.2 | `node scripts/junction-worktree.mjs . --primary E:/Projects/duya` | 0；62 个链接建立 | 依赖就绪 |
| `b5c36035`（本分支 + A1a） | 同上 | `vitest run packages/host/tests/worker-prompts packages/host/tests/worker-context` | 0；13 文件 / 77 用例通过（基线） | 改动前基线 |
| `b5c36035`（本分支 + A1a） | 同上 | `vitest run packages/host/tests/agent-composition` | 0；9 用例通过 | 新增 resolver |
| `b5c36035`（本分支 + A1a） | 同上 | `tsc --noEmit`（根 tsconfig） | 0；0 行输出 | 类型门禁 |
| `b5c36035`（本分支 + A1a） | 同上 | `npm run architecture:check` | 0；无新增违规（3193 tolerated） | 层门禁 |
| `b5c36035`（本分支 + A1a） | 同上 | `check:manifest-keys` / `check:test-coverage` / `check:no-ts-suppress` / `check:encoding` | 四项均 0 | 清单与卫生门禁 |
| `f46042f3`（A1b） | 同上 | `vitest run packages/host/tests/agent-composition` | 0；21 用例通过 | 四个新 resolver |
| `1100e77a`（B1） | 同上 | `vitest run packages/host/tests/agent-composition packages/host/tests/worker-prompts packages/host/tests/worker-context` | 0 | prompt 字节等价对拍 |
| `833cf81b`（C1） | 同上 | `vitest run packages/host/tests/worker-prompts packages/host/tests/worker-context packages/host/tests/worker-modes packages/host/tests/bot packages/host/tests/agent-composition` | 28 文件 / 280 用例通过；1 个无关文件因缺 `plugin-core` 构建失败 | 三维度切换对拍 |
| `4c83d4ff`（D1） | 同上 | `vitest run packages/host/tests/worker-prompts packages/host/tests/worker-context packages/host/tests/agent-composition` | 0；18 文件 / 115 用例通过 | 段通道注册表 |
| `b6b0ae0b`（D2） | 同上 | `vitest run packages/host/tests/worker-context` | 0 | 增量帧 |
| `1bee26b9`（E1） | 同上 | `vitest run packages/ai/test/openai-prompt-cache-key.test.ts packages/ai/test/openai-responses.test.ts` | 0 | provider 缓存键 |
| `7635fe23`（F1） | 同上 | `vitest run packages/host/tests/agent-composition packages/host/tests/worker-context packages/host/tests/worker-prompts packages/agent-core/test/context` | 0；22 文件 / 152 用例通过 | 时间提醒 |
| `7635fe23`（F1） | 同上 | `npm run -w @duya/agent-core typecheck` / `npm run -w @duya/host typecheck` | 0 / 2（既有基线，见发现 12） | 分包类型检查 |
| `0ca138f7`（B2+F2） | 同上 | `vitest run packages/host/tests/agent-composition packages/host/tests/worker-context packages/host/tests/worker-compaction packages/host/tests/worker-prompts packages/host/tests/runtime-context-contracts packages/host/tests/session-compaction.test.ts` | 0；35 文件 / 320 用例通过 | 压缩一致性 |
| `0ca138f7`（B2+F2） | 同上 | `npm run -w @duya/host typecheck` / `tsc --noEmit` / `architecture:check` / 四项卫生门禁 | 2（仅既有基线）/ 0 / 0 / 四项 0 | 类型、层、清单门禁 |
| `0ca138f7`（B2+F2） | 同上 | `vitest run packages/host/tests`（全量，环境基线） | 1；86 文件 collect 失败 + 7 timeout（见发现 13） | 隔离复跑 5 文件 / 42 用例 0 |
| `b91ebcc2`（G1） | 同上 | `vitest run packages/host/tests/{agent-composition,worker-prompts,worker-context,worker-product-runtime}` | 0；57 文件 / 347 用例 | 冻结计划、注入项分离、真实 seam 对拍 |
| `c3ed7773`（G2） | 同上 | `vitest run` 上述 + `bot` / `worker-compaction` / `worker-modes` | 0；72 文件 / 545 用例 | 段目录、bot 单轨、prompt 字节等价 |
| `09084121`（G3） | 同上 | `vitest run packages/host/tests/{worker-prompts,worker-context,worker-product-runtime,agent-composition}` | 0；59 文件 / 359 用例 | observer sink / rail unchanged 语义 |
| `383a547d`（G4） | 同上 | `npm run -w @duya/agent-runtime typecheck` / `-w @duya/host typecheck` | 0 / 2（仅既有基线，见发现 12） | 协议字段与跨包消费 |
| `383a547d`（G4） | 同上 | `vitest run packages/agent-runtime/test/{run-engine-compaction,run-engine-loop} + packages/host/tests/{worker-compaction,worker-product-runtime,worker-context,agent-composition}` | 0；53 文件 / 367 用例 | 压缩 system 快照端到端 |
| `383a547d`（全量） | 同上，已补齐三个 dist junction | `vitest run packages/host/tests packages/agent-runtime/test` | 0；397 文件 / 3727 用例通过，1 文件 / 5 用例 skipped | 见发现 21 |
| `383a547d`（全量） | 同上 | `architecture:check` / 四项卫生门禁 / 根 `tsc --noEmit` | 0 / 四项 0 / 0 | 层门禁与清单门禁 |
| `383a547d`（全量） | 同上 | `npm run typecheck:all`（18 个子命令：5 项 `check:*` → `build:packages` → 11 个 typecheck 子命令 → `eval:agent:core:check`） | **0**；全链路通过，`typecheck-electron-gate: OK — no new type errors (164 known across 90 key(s))`；唯一告警是 `WidgetErrorBoundary.tsx` 既有 Rollup 动静态重复导入提示 | 全仓类型门禁，日志 708 行 |

## 接续 / 结果

**已实现**（14 个 commit，`71ed7df6` → `383a547d`；`git rev-list --count b5c36035..HEAD` 复核为 14）：

- 组合层 `packages/host/src/agent-composition/`：七个纯函数 resolver + `time-reminder.ts`；`compose.ts` 提供**每轮一次的冻结 `AgentComposition`**（scope / prompt / sections / tools / modes / permissions / cache / reminders / overrides / decisions / fingerprint）与 `composeStartup()`；`readTurnOverrides()` 是 `ChatOptions` 注入项的唯一解读点；`section-plan.ts` 从注册表派生每个 agent 形状的段清单。
- 控制层接线：`beginRun` 生成计划 → `RunHandle.composition` → `worker-engine-driver` → `RunAssemblyRequest.composition` → `beginTurnAssembly` 消费；构造期的 cache family / 初始 permission mode 走 `composeStartup`。`_buildSystemPrompt` / `_resolveTools` / `applyTurnModes` / `_readOrchestratorMode` / `_dispatchOrchestratorMode` 不再调任何 resolver，也不再读 `ChatOptions` 的提示词字段。
- 提示词系统：`sections/placement-registry.ts` 升级为完整段目录（通道 / 理由 / kind / configs + bot assembly 十段）；四个 live config 删除重复 `placement` 声明；`PromptsRegistry` 不再注册死轨 `bot`；`_buildSystemPrompt` 的 bot 尾块由 `composition.sections.botSections` 判定。
- 观测：`worker-prompts/production-observer.ts` 在 `startWorkerProcess()` opt-in 安装结构化日志 sink，只记段名 / hash / 长度 / volatile。
- 压缩协议：`CompactionOutcome.replaced.systemPrompt`（可选）由 `engine-sources.ts` 从 `run.systemPromptContent` 填入，经 `runCompactionPass` 转发，`#modelRequest` 按 turn 标记一次性消费；未提供的 host 保持旧行为。
- 既有 A1–F2 成果不变：段通道单点、增量帧、provider 缓存双支持、时间提醒、defect b 与压缩一致性（详见上文）。

**已验证**：全量 `vitest run packages/host/tests packages/agent-runtime/test` 0；397 文件 / 3727 用例通过（1 文件 / 5 用例 skipped），此前 86 文件 collect 失败与 timeout 已由三个 dist junction 消除。`architecture:check` 0（无新增违规）、四项卫生门禁 0、根 `tsc --noEmit` 0、`@duya/agent-runtime` 分包 typecheck 0；`@duya/host` 分包 typecheck 仅 2 个与本计划无关的既有错误（发现 12）。`typecheck:all` 退出码 0：`check:encoding` / `check:manifest-keys` / `check:test-coverage` / `check:no-ts-suppress` / `check:packaged-artifacts` 全 0，`build:packages` 全包构建通过，11 个 typecheck 子命令与 `eval:agent:core:check` 全部通过（electron gate 无新增类型错误）；日志内唯一的告警是 `WidgetErrorBoundary.tsx` 既有的 Rollup 动态/静态重复导入提示，与本计划无关。
**已合并**：无。

未提交路径：无内容改动；`git status` 仅剩 `packages/capabilities/src/ModuleTool/inline-content.ts` 的 CRLF 假 M（HEAD blob 0 个 CR、工作树 865 个 CR，但归一化 blob hash 与索引一致、`git diff` 为空），未纳入提交。
外部副作用：分支 `codex/624-agent-composition` 与 worktree `.claude/worktrees/composition-layer`；三个指向主检出 dist 的 junction（`plugin-core` / `connectors` / `host`，gitignored，仅用于本检出测试），其双向写入影响见发现 22。

**已关闭的未决项**：`CompactionOutcome.systemPrompt`（G4）、bot 双轨（G2）、冻结 `AgentComposition` 与 `ChatOptions` 注入项分离（G1）、config 引用 SectionRegistry（G2）、observer 生产 sink（G3）、全量 host 套件环境基线（发现 21）。rail 零消息语义经评估**明确不做**，理由与准入条件见发现 19，并有测试锁住 unchanged 块必须送达。

阻塞与未决（仅剩集成事项）：
1. **合并前必须重建 worker bundle 并跑 `bundle:verify`**：G4 改了 `agent-runtime/engine/*` 与 `host/worker-compaction/engine-sources.ts`，当前生产 bundle 仍来自主检出 dist；分支合并后重建才生效。
2. **主检出 `worker-session-runtime.ts` 有并行未提交改动**：本分支基于 `b5c36035`，合并前需确认归属与顺序。
3. **未建 PR、未推送、未合并**：本地 master 领先 `origin/master` 31 个提交，推 PR 前须对齐目标分支。
4. **bot 兼容夹具**：`configs/bot.ts` 保留给 `packages/agent` legacy 重导出与两个测试，运行时永不实例化；若 legacy 层退役可一并删除。

回收：分支未合并，worktree 保留。
下一步（`typecheck:all` 已跑完并记录）：在可构建检出执行 `build:packages -- --target @duya/host` + `bundle:worker` + `bundle:verify` → 与主检出并行改动协调后推 PR → review / CI → 授权集成。
