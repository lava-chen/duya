# 624 — Agent 组合层与提示词系统重构

状态：active · 负责人：workbuddy-12f8ee39 · 更新：2026-11-04
分支：`codex/624-agent-composition` · worktree：`.claude/worktrees/composition-layer` · base：`b5c36035` · owner：workbuddy-12f8ee39

## 目标与边界

**要改变的行为**：把「哪个 agent、注入什么提示词 / 工具 / 模式 / 权限 / 提醒 / 缓存」从散落在 `WorkerSession` 里的 17 处隐式分支，收敛成 host 侧**唯一**的纯函数组合层。控制层（session、bot、TUI、project coordinator、desktop、gateway）只声明「要一个什么样的 agent」，组合层产出冻结的 `AgentComposition`，`@duya/agent-runtime` 保持零策略执行内核。在此基础上把提示词系统从「两分区字符串拼接」升级为「段计划 + 快照 + 显式增量帧」。

用户可观察到的变化：

1. 任意控制层都能用同一份契约启动 agent 实例，不再各自拼装。
2. 每轮请求的提示词来源可回答（provenance），不再只有一行 `logger.info`。
3. 上下文块变化对模型**可解释**（`Updated / Removed section "X"`），不再是静默改写。
4. Anthropic 与 OpenAI 两条 provider 缓存路径都有显式契约，而不是靠 URL 猜测。

**允许修改的路径**：

- 新增 `packages/host/src/agent-composition/**`（组合层，唯一策略点）
- 新增 `packages/agent-core/src/composition/**`（**仅在 E1/F1 需要 runtime 侧读取契约时启用**；A–D 阶段契约在 host 内，理由见发现 7）
- `packages/host/src/worker-session-runtime.ts`（`beginTurnAssembly` 及其 4 个执行器）
- `packages/host/src/worker-prompts/**`（SectionRegistry / 段计划 / 快照）
- `packages/host/src/worker-context/**`（增量帧、快照基线）
- `packages/ai/src/utils/prompt-caching.ts`、`packages/ai/src/api/openai-*.ts`（缓存契约）
- 对应测试目录

**本次不处理**：`packages/agent` 遗留层；UI 侧渲染；跨宿主协议字段（除 F2 需要的可选字段）；不重写 worker bundle 构建方式。

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
- [x] A1a 契约类型 + 无 IO 的 scope / prompt 选择 resolver（9 用例）
- [ ] A1b `CompositionPorts` + 其余 4 个 resolver 骨架
- [ ] A2 shadow 对拍
- [ ] B1 prompt 维度切换
- [ ] B2 修 defect b
- [ ] C1 tools / modes / permissions 切换
- [ ] D1 SectionRegistry
- [ ] D2 增量帧
- [ ] E1 缓存双支持
- [ ] F1 时间提醒 fragment
- [ ] F2 压缩一致性
- [ ] 计划入口与 catalog 登记

## 发现与决策

1. **中转层必须落在 host，不能落 agent-runtime。** runtime 只收 `manifest + AssembledTurn`；把 prompt/tools/permissions 判定推进去会让零 IO 内核获得 IO 依赖。落点是 `beginTurnAssembly`。
2. **`ChatOptions` 的注入项必须先分离，否则 resolver 是假的。** 只要 `systemPrompt`、`disableSystemPrompt`、`systemPromptPrefix` 还能从请求对象直接穿透到渲染，就仍有第二条裁决路径。
3. **bot 双轨是本计划最大的语义债。** `configs/bot.ts` 无人引用，真实 bot 走 assembly；不合并的话，`promptSystem` 字段对 bot 永远是噪声，路由表也无法自洽。
4. **pi 的零消息语义不适用于当前 duya。** pi 靠 replay transcript 得到 previous；duya 的 rail 不进 timeline，这轮不发 unchanged 块等于丢上下文。因此 D2 只取「显式帧」，零消息留给后续单独立项。
5. **base 用本地 `b5c36035` 而非 `origin/master`。** 本地 master 领先远端 31 个提交（含 7 个 PR 的集成与 bundle 重建），远端缺少这些内容；PR 合并前需确认目标分支已追平。
6. **主检出 `worker-session-runtime.ts` 有并行未提交改动。** 本计划 B1/C1 触及同一文件，实施前必须与该任务协调独占路径，否则会产生静默覆盖。
7. **契约暂时落 `packages/host/src/agent-composition/`，不落 agent-core。** worktree 的 `@duya/*` 经 junction 指向主检出 `dist`，新包源码要先 `build:packages` 才能被消费方解析；而 A 阶段只有 host 消费。等 E1/F1 需要 runtime 侧读取 `CacheComposition` / `ReminderComposition` 时再上移，并同步层表——迁移成本是一次纯类型移动。
8. **`scope` 不能用 `profile.kind` 单独判定。** 实测 `SPECIAL_AGENT_PROFILES` 含 4 个成员（`gateway`、`cron`、`memory-curator` 及既有项），且 config agent 是 `kind:'main' + isPreset:false`。因此判定顺序必须是 bot → coordinator by id → kind，测试用全量预设表锁住这张映射，新增 preset 若未分类会直接失败。

## 验证记录

| SHA / dirty 范围 | 环境 | 命令或操作 | 退出码 / 结果 | 证据 |
| --- | --- | --- | --- | --- |
| `b5c36035`（本分支，干净） | Windows / Node 22.22.2 | `node scripts/junction-worktree.mjs . --primary E:/Projects/duya` | 0；62 个链接建立 | 依赖就绪 |
| `b5c36035`（本分支 + A1a） | 同上 | `vitest run packages/host/tests/worker-prompts packages/host/tests/worker-context` | 0；13 文件 / 77 用例通过（基线） | 改动前基线 |
| `b5c36035`（本分支 + A1a） | 同上 | `vitest run packages/host/tests/agent-composition` | 0；9 用例通过 | 新增 resolver |
| `b5c36035`（本分支 + A1a） | 同上 | `tsc --noEmit`（根 tsconfig） | 0；0 行输出 | 类型门禁 |
| `b5c36035`（本分支 + A1a） | 同上 | `npm run architecture:check` | 0；无新增违规（3193 tolerated） | 层门禁 |
| `b5c36035`（本分支 + A1a） | 同上 | `check:manifest-keys` / `check:test-coverage` / `check:no-ts-suppress` / `check:encoding` | 四项均 0 | 清单与卫生门禁 |

## 接续 / 结果

**已实现**：A1a——契约类型（`packages/host/src/agent-composition/contract.ts`）、`resolveCompositionScope`（`scope.ts`）、`resolvePromptSelection`（`prompt-selection.ts`）、导出面与 `package.json` 子路径。行为未改变，未接入 `beginTurnAssembly`。
**已验证**：基线 77 用例、新增 9 用例、`tsc --noEmit`、`architecture:check`、四项卫生门禁全部退出码 0。
**已合并**：无。

未提交路径：`packages/host/src/agent-composition/**`、`packages/host/tests/agent-composition/**`、`packages/host/package.json`、本文件、`docs/exec-plans/README.md`、`docs/exec-plans/catalog.md`。
外部副作用：新建分支 `codex/624-agent-composition` 与 worktree `.claude/worktrees/composition-layer`。
阻塞：B1/C1 与主检出中 `worker-session-runtime.ts` 的并行改动冲突，需先确认其归属与合并顺序。

回收：分支未合并，worktree 保留。
下一步：A1b——在 `packages/host/src/agent-composition/` 增加 `CompositionPorts` 与 tools / modes / permissions / cache 四个 resolver，完成判据是每个 resolver 各有 1 组单测且 `tsc --noEmit` 仍为 0。
