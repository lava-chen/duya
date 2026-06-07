# Plan 105: Code Agent Profile Runtime Wiring & Tool Diagnostics

> P0 | Status: **Complete** (2026-06-07)

## 决策日志

### 修复的 bug

1. **`PromptsRegistry.get()` 单例缓存吞掉 profile** — 改为按 `(name, profile-key)` 实例化,新增 `getOrCreate(name, profile)` 显式语义。Phase 1.1。
2. **`CodePromptSystem` / `GeneralPromptSystem` / `ResearchPromptSystem` / `ConductorPromptSystem` 的 `getStaticSections/getDynamicSections` 硬编码全量 section** — 接入 `isSectionEnabled(this.profile, name)` 过滤。Phase 1.2-1.4。
3. **`streamChat` 路径未把 profile 传给 prompt system** — 在 `index.ts:1066-1097` 用 `getPromptProfileForAgentProfile(appliedProfile)` + `PromptsRegistry.getOrCreate` 把 profile 真正注入。Phase 1.5。
4. **Code prompt 静态硬编码 Claude Code 风格能力**(hooks/permission mode/context compression/settings 自管) — 抽出 `codeSystemSection.ts`,基于 `context.enabledTools` 条件注入,未启用对应工具时整段不输出。Phase 3。
5. **ToolFilter 无诊断** — 扩展 `ToolFilterResult.diagnostics` 为 `{ matchedPatterns, unmatchedPatterns, layerBreakdown }`,`index.ts` 输出结构化日志。Phase 2。

### 关键决策

- **Decision A**: `WikiAgentPromptSystem` **不**接入 `isSectionEnabled`。其 section 名 (`wiki-intro`, `wiki-task` 等) 跟通用 section registry 完全不重叠,接入是 no-op。
- **Decision B**: `ResearchPromptSystem` 只对 `toneAndStyle` 通用名应用 gate;research-specific sections 保持原样。
- **Decision C**: `ConductorPromptSystem` 同样只对通用 section 名 (`intro`/`system`/`toolUsage`/`environment`) 应用 gate,conductor-specific (`canvasTools`/`conductorCanvas`/`vizSpec`) 保留。
- **Decision D**: `CodePromptSystem.getDynamicSections` 顺手补齐了 `platform` section(原本缺失)。这是 plan 1.2 改造的副作用。
- **Decision E**: Plan 105 阶段 1.6 决策点结论:`streamChat` 走 `promptSystem.buildSystemPrompt`(`index.ts:1096`),`PromptManager` 仅用于 sub-agent 路径(`runAgent.ts:181`)。两条路径独立,Phase 1.5 只改 `streamChat`。

### 测试结果

- 新增 23 个 test case,全过(`ToolFilter.test.ts`: 23/23;`subagentProfilePrompt.test.ts`: 6/6;`conditionalSections.test.ts`: 13/13)。
- 跑全量测试有 153 个 failed,经 `git stash` 对比验证:pre-existing 156 failed,**没有引入新的 regression**。Pre-existing 失败集中在 `electron/` 目录的 native module DLOPEN 错误和 `prompts/modes/index.test.ts` 与定义的 section 集合不同步。
- `npm run typecheck:all` 通过。

### 副产品 / 已知的 follow-up

- **Preset 工具命名 drift**: `code-expert` 的 `disallowedTools: ['show_widget', 'cron', 'duya:*', 'canvas:*', 'memory', 'SessionSearch']` 跟实际 builtin 工具命名是否一致仍未验证。建议下个 plan 用 Phase 2 的 diagnostic 输出来对一次。
- **Code profile 拆三档 (Read/Edit/Autonomous)**: 留到 Plan 106,等 UI 侧呈现方式确定后再做。
- **`PromptManager` sub-agent 路径**: `runAgent.ts:181` 用 subagent type 映射的 profile,不经过 `getPromptProfileForAgentProfile`。两条路径分开,符合 sub-agent 边界设计,无需在 plan 105 改动。

### 改动文件清单

- `packages/agent/src/agent-profile/ToolFilter.ts` — diagnostic 字段
- `packages/agent/src/prompts/PromptsRegistry.ts` — profile-aware 缓存
- `packages/agent/src/prompts/code/CodePromptSystem.ts` — `isSectionEnabled` + 补齐 `platform` section
- `packages/agent/src/prompts/code/sections/static/codeSystemSection.ts` — 新增,条件 capability 段落
- `packages/agent/src/prompts/code/sections/static/intro.ts` — self-management 句子条件化
- `packages/agent/src/prompts/code/sections/static/system.ts` — 改为调用 `codeSystemSection`
- `packages/agent/src/prompts/conductor/ConductorPromptSystem.ts` — `isSectionEnabled`(仅通用 section)
- `packages/agent/src/prompts/general/GeneralPromptSystem.ts` — `isSectionEnabled`
- `packages/agent/src/prompts/research/ResearchPromptSystem.ts` — `isSectionEnabled`(仅 `toneAndStyle`)
- `packages/agent/src/index.ts` — `streamChat` 注入 profile,tool filter diagnostic 结构化日志
- `packages/agent/tests/unit/agent-profile/ToolFilter.test.ts` — 4 个 diagnostic test
- `packages/agent/tests/unit/agent-profile/subagentProfilePrompt.test.ts` — 新增,6 个 preset → section 集成 test
- `packages/agent/tests/unit/prompts/code/conditionalSections.test.ts` — 新增,13 个条件 section test

---

## 原始 Plan 内容(供参考)

## 背景与动机

duya 的 `AgentProfile` 系统抽象方向正确:profile 同时定义 tool 范围、prompt section 覆盖、promptSystem 选择。`code-expert` preset 也确实配置了 `allowedTools: ['*']` + `disallowedTools` + `promptSystem: 'code'`。

但 runtime 端存在 **3 个 P0 bug** 让 profile 形同虚设,以及 1 个结构性缺陷需要观察起来。

### Bug 1 (P0): `promptProfile` 在 CodePromptSystem 中完全未生效

`packages/agent/src/prompts/code/CodePromptSystem.ts:76-118` 的 `getStaticSections` / `getDynamicSections` 硬编码全量 section,**没有** 调用 `isSectionEnabled(this.profile, name)`。结果是:

- `explore` / `plan` 预设里 `disableSections: ['memory', 'skills', 'sessionGuidance', 'widgetGuidelines']` 失效
- `general-purpose` 的 `disableSections: ['taskHandling']` 失效
- `research` 的 `disableSections: ['taskHandling', 'actions']` 失效
- `gateway` 的 `disableSections: ['taskHandling', 'widgetGuidelines']` 失效

`getPromptProfileForAgentProfile()` 在 `prompts/modes/index.ts:135` 已实现,但 `index.ts:1068-1097` 的 `streamChat` 路径上从未调用。

### Bug 2 (P0): `PromptsRegistry.get()` 是单例缓存,profile 完全被吞

`packages/agent/src/prompts/PromptsRegistry.ts:41-49`:

```ts
static get(name: string, profile?: PromptProfile): PromptSystem | undefined {
  if (!this.instances.has(name)) {
    const factory = this.systems.get(name)
    if (factory) {
      this.instances.set(name, factory.create(profile))  // ← 只在第一次用 profile
    }
  }
  return this.instances.get(name)
}
```

第一次 `get('code')` 之后,所有后续 `get('code', newProfile)` 都返回 **首次创建的实例**,profile 形参被忽略。这意味着即使修复了 Bug 1,在 `Agent` 类长生命周期里切换 profile 也无效。

### Bug 3 (P0): Code prompt 静态硬编码 Claude Code 风格能力

`code/sections/static/intro.ts:14` 写死"proactively use these tools. You can read and manage your own settings",`code/sections/static/system.ts:12,15,16` 提到 permission mode / hooks / context compression。这些是 Claude Code 现有能力,不是 duya 静态事实。当对应工具不在 `enabledTools` 里时,这段 prompt 会让 agent 误以为有这些能力,产生幻觉。

### 缺陷 4 (P1): Tool filter 没有 diagnostic

`ToolFilter.ts:123-223` 的 `filterTools` 正确实现了 5 层过滤 + deny 优先,但 **不输出** 任何诊断信息:`unmatched patterns`、`partial matches`、`denial reason 分布`。目前唯一日志是 `index.ts:1051` 一行 `denied.join(', ')`。对 wildcard 模式(`duya:*`、`canvas:*`)、MCP 工具名混用大小写下划线,无法验证"UI 禁用 vs runtime 禁用"是否一致。

---

## 目标

1. **修复** CodePromptSystem / streamChat 路径,让 `promptProfile` 真的生效
2. **修复** PromptsRegistry 缓存,让 profile 切换真正影响 prompt system 实例
3. **改造** code prompt 的 settings / hooks / permission mode 段落,从静态硬编码改为基于 `enabledTools` 的条件注入
4. **添加** profile tool resolver diagnostic,输出可观测日志,后续可以接上 unit test
5. **添加** unit test 覆盖核心 4 个修复点

不在本 plan 范围:
- Code profile 拆 Read/Edit/Autonomous 三档(放到 Plan 106,等 P0 修完后再设计 UI)
- 改 `code-expert` 的 `allowedTools`/`disallowedTools` 列表(本次只加诊断和测试,不动 preset 语义)

---

## Phase 1: Profile → PromptSystem 真正的 wire (核心 P0)

### 1.1 `PromptsRegistry` 引入 profile-aware get + 迁移到 instance-cache by profile

文件: `packages/agent/src/prompts/PromptsRegistry.ts`

问题: 当前是按 `name` 单例。改成 **按 (name, profile-key) 实例化**,profile 不同时给不同实例。

实现:
- 引入 `profileKey(profile: PromptProfile): string` — 把 profile 序列化成稳定 key(`base` + `overlays` + `overrides`)
- `instances: Map<string, PromptSystem>` 的 key 从 `name` 改成 `${name}::${profileKey}`
- `get(name, profile)` 第一次按 (name, profile) 创建,后续命中返回同实例
- 新增 `getOrCreate(name, profile)` 显式语义,让调用方意图清晰
- 保留 `get(name)` 重载 — 内部用 `DEFAULT_PROMPT_PROFILE` 作 key,行为兼容
- 新增 `reset(name?)` 支持按 name 清缓存(供配置变更时调用)
- 文档注释明确: `get()` 不再保证 name 维度单例;agent 长生命周期里如果切换 profile,要么用 `reset()` 要么用 `getOrCreate()`

测试点:
- 相同 name + 不同 profile 返回不同实例
- 相同 name + 相同 profile 返回同实例
- 默认 profile 兼容旧调用

### 1.2 `CodePromptSystem.getStaticSections / getDynamicSections` 应用 `isSectionEnabled`

文件: `packages/agent/src/prompts/code/CodePromptSystem.ts:76-118`

- 顶部 import `isSectionEnabled, resolveEnabledSections` from `'../modes/index.js'`
- `getStaticSections` 里在构建 sections 数组前,先算 `enabledSections = resolveEnabledSections(this.profile)`
- 把硬编码的 section 改成 `enabledSections.has('intro') ? cachedPromptSection(...) : null`,或提取一个本地 helper `m(name, compute)` 减少重复
- `getDynamicSections` 同样改造
- **保留** `keepCodingInstructions` 检查(它在 `outputStyle` 上,跟 `this.profile` 正交,逻辑不变)
- Section name 列表需要与 `DEFAULT_BASE_SECTION_SETS.full` 对齐:`intro, system, taskHandling, actions, toolUsage, toneAndStyle, outputEfficiency, memory, memoryContent, agentsMd, platform, environment, mcp, sessionGuidance, skills, language, outputStyle, scratchpad, widgetGuidelines, visionGuidelines, conductorCanvas`

### 1.3 `GeneralPromptSystem` 同样改造

文件: `packages/agent/src/prompts/general/GeneralPromptSystem.ts`(需先读,但行为应该跟 Code 类似 — `getStaticSections` 也是硬编码)

- 同样按 `this.profile` 过滤 sections
- 改完后,`general-purpose` preset 的 `disableSections: ['taskHandling']` 才能生效

### 1.4 `ResearchPromptSystem` / `ConductorPromptSystem` / `WikiAgentPromptSystem` 同样改造

文件: `packages/agent/src/prompts/{research,conductor,wiki-agent/prompts}/*PromptSystem.ts`

- 同样按 `this.profile` 过滤
- 这些系统的 `disableSections` 预设(`research.disableSections: ['taskHandling', 'actions']`、`gateway.disableSections: ['taskHandling', 'widgetGuidelines']`)才能生效

### 1.5 `streamChat` 路径: 把 profile 真正传给 prompt system

文件: `packages/agent/src/index.ts:1066-1097`

当前:
```ts
const sysName = resolvePromptSystemName(appliedProfile?.promptSystem);
const promptSystem = PromptsRegistry.get(sysName) ?? PromptsRegistry.get('general')!;
// ...
const systemPromptResult = await promptSystem.buildSystemPrompt(context);
```

改为:
```ts
const sysName = resolvePromptSystemName(appliedProfile?.promptSystem);
const promptProfile = appliedProfile
  ? getPromptProfileForAgentProfile(appliedProfile)
  : DEFAULT_PROMPT_PROFILE;
const promptSystem = PromptsRegistry.getOrCreate(sysName, promptProfile)
  ?? PromptsRegistry.getOrCreate('general', promptProfile)!;
logger.info(`[Agent] Using prompt system '${sysName}'${appliedProfile ? ` for profile: ${appliedProfile.name}` : ' (default)'}`);
logger.info(`[Agent] Resolved prompt profile: base=${promptProfile.base}, overlays=${JSON.stringify(promptProfile.overlays || [])}, disabledSections=${JSON.stringify(promptProfile.overrides?.disableSections || [])}`);
```

如果 `appliedProfile` 是 undefined,沿用 `DEFAULT_PROMPT_PROFILE` — 与旧行为一致。

### 1.6 兼容点: `getDefaultPromptManager` / `PromptManager`

文件: `packages/agent/src/prompts/PromptManager.ts:65-91`

`PromptManager` 已经有 `setPromptProfile(profile)` 和 `this.profile` 字段(看 line 68, 73, 88-91),但 `buildSystemPrompt` 没有传 `profile` 给 `CodePromptSystem`(因为 `CodePromptSystem` 现在用 `this.profile` 自己的)。`PromptManager` 这一侧需要:

- 检查 `PromptManager.profile` 与实际使用的 `promptSystem.profile` 是否一致
- 如果 `promptManager` 是 `this.promptManager`(Agent 类成员),需要让它和 `promptSystem` 共用同一个 `PromptProfile`,或者在 `buildSystemPrompt` 完成后不再使用 `this.promptManager` —— 确认现状后决定方案(可能在 Agent 类层面用同一个 profile 实例)

这一步的具体修法取决于 PromptManager 与 CodePromptSystem 哪个被实际使用。**Phase 1.6 决策点**: 写一个最小调研子任务(2 个文件 Read + 1 个 Grep),确认 duya 实际跑的是 `this.promptManager.buildSystemPrompt` 还是 `promptSystem.buildSystemPrompt`。基于结果修。

### 1.7 验证

- `pnpm typecheck` 通过
- 手动跑 dev 模式,选 `code-expert` profile,`logger.info` 输出 disabled sections 为空(因为 `code-expert` 没设 `disableSections`)
- 手动跑 explore/plan sub-agent(如果有 UI 入口),确认 memory/skills sections 被 disable
- 跑 `npm run typecheck:all`

---

## Phase 2: Tool filter diagnostic (P1)

### 2.1 `filterTools` 输出可观测结构

文件: `packages/agent/src/agent-profile/ToolFilter.ts:104-223`

扩展 `ToolFilterResult`:
```ts
export interface ToolFilterResult {
  allowed: string[];
  denied: string[];
  denialReasons: Map<string, string>;
  isValid: boolean;
  // 新增
  diagnostics: {
    matchedPatterns: Array<{ pattern: string; matched: string[] }>;
    unmatchedPatterns: string[];     // 配置里有但 allTools 里没 match 的(如 MCP 工具未加载时)
    layerBreakdown: {
      layer1_allowlist: number;       // 被 allowlist 删掉的
      layer2_agentDenied: number;
      layer3_globalDenied: number;
      layer4_sandboxDenied: number;
      layer4_sandboxNotInAllowlist: number;
      layer5_subagentDenied: number;
      layer5_subagentNotInAllowlist: number;
    };
  };
}
```

实现: 在 `filterTools` 里收集每层命中的 pattern、对应被删的工具。`expandToolGroups` 已经有逻辑可复用,把"哪些 pattern 没有 match 任何 tool"也记下来。

### 2.2 `index.ts` 把 diagnostic 输出到 logger

文件: `packages/agent/src/index.ts:1050-1055`

把 `logger.info` 替换为结构化输出:
```ts
logger.info(`[Agent] streamChat: Tool filter applied`, {
  profileId: appliedProfile.id,
  totalTools: allToolNames.length,
  allowedCount: filterResult.allowed.length,
  deniedCount: filterResult.denied.length,
  matchedPatternCount: filterResult.diagnostics.matchedPatterns.length,
  unmatchedPatterns: filterResult.diagnostics.unmatchedPatterns,
  layerBreakdown: filterResult.diagnostics.layerBreakdown,
});
```

### 2.3 加单元测试

文件: `packages/agent/test/tool/ToolFilter.diagnostic.test.ts` (新建)

测试场景:
- `allowedTools: ['*']` + `disallowedTools: ['duya:*']`,allTools 含 `duya:foo` 和 `file:read`,结果: `duya:foo` 拒绝(原因 agent_denied),`file:read` 允许。matchedPatterns 包含 `*` 和 `duya:*`
- `disallowedTools: ['canvas:*']`,allTools **没有** canvas 工具,unmatchedPatterns 包含 `canvas:*`
- `allowedTools: ['file:read*']` 实际只能 match `file:read_file` 之类 — 验证前缀 match
- `allowedTools: ['non-existent:*']` 应被记录在 unmatchedPatterns
- 5 层 cascade: 同时配 sandbox + subagent policy,验证 layerBreakdown 累加正确

---

## Phase 3: Code prompt 条件注入(去掉硬编码 Claude Code 能力)

### 3.1 抽出 `codeSystemSection.ts` 支持 context-based conditional

文件: 新建 `packages/agent/src/prompts/code/sections/static/codeSystemSection.ts`

- 接收 `context: PromptContext`
- 检查 `context.enabledTools` 是否包含以下 capability tool:
  - `settings` / `settings_*`(自管理配置)
  - `hooks` / `hooks_*`(配置 hooks)
  - `permission_mode` / `permission_*`(切换权限模式)
  - `compact` / `compact_context`(主动压缩)
- 对每个检测到的 tool,组装对应 guidance 段落;对未检测到的,不输出
- 接受一个 `getStaticContext()` fallback,用于 backward compat(允许上层注入静态 capability map,例如 read-only 模式下硬编码)

### 3.2 `code/sections/static/system.ts` 改为薄壳

文件: `packages/agent/src/prompts/code/sections/static/system.ts`

- 保留 Markdown 输出格式、`<system-reminder>` 注入说明
- 移除硬编码的 hooks/permission mode/context compression 段落
- 调用 `codeSystemSection.getCodeCapabilityGuidance(context)` 注入

### 3.3 `code/sections/static/intro.ts` 改写

文件: `packages/agent/src/prompts/code/sections/static/intro.ts:14`

- 把 "proactively use these tools. You can read and manage your own settings" 改为条件段落
- 如果 `enabledTools` 含 settings tool,输出 "you can read/manage your own settings"
- 如果不含,直接不输出该句(默认假设不暴露)
- 保留"interactive AI coding agent"这一身份描述(与 duya 品牌一致)

### 3.4 加单元测试

文件: `packages/agent/test/prompts/code/conditionalSections.test.ts` (新建)

- 给定 `enabledTools: new Set(['settings'])` → system section 含 settings guidance
- 给定 `enabledTools: new Set(['file:read'])` → system section 不含 settings/hooks/permission guidance
- intro section 在 `enabledTools` 不含 settings 时不输出 self-management 句

---

## Phase 4: Sub-agent profile 集成测试

### 4.1 验证 `explore` / `plan` 在 sub-agent 路径上的行为

文件: `packages/agent/test/agent-profile/subagentProfilePrompt.test.ts` (新建)

- 模拟构造一个 `AgentProfile = PRESET_AGENT_PROFILES.find(p => p.id === 'explore')`
- 调 `getPromptProfileForAgentProfile(profile)` → `applyProfileOverrides({ disableSections: [...] })`
- 验证 `resolveEnabledSections(profile)` 不含 `memory`/`skills`/`sessionGuidance`/`widgetGuidelines`
- 验证 `resolveEnabledSections(PROFILES.research)` 不含 `taskHandling`/`actions`
- 验证 `resolveEnabledSections(PROFILES.generalPurpose)` 不含 `taskHandling`
- 验证 `resolveEnabledSections(PROFILES.gateway)` 不含 `taskHandling`/`widgetGuidelines`

### 4.2 验证 `CodePromptSystem` 在收到 `explore` profile 时不会输出 disabled sections

- 构造 `CodePromptSystem(applyProfileOverrides({ disableSections: ['memory', 'skills', 'taskHandling'] }))`
- mock 必要的 `buildContext` 输入
- 调 `buildSystemPrompt`,断言输出不含 "memory" / "skills" / "taskHandling" 关键字
- 对 General / Research / Conductor 同样测试

---

## Phase 5: 收尾

### 5.1 更新 `docs/exec-plans/README.md`

- 把 plan 加到 Active Plans 表格
- Status: `Phases 1-4 ✅`

### 5.2 更新 `docs/wiki/modules/agent-profile.md`(如有)

- 描述 profile 链路:`streamChat` → `getPromptProfileForAgentProfile` → `PromptsRegistry.getOrCreate` → `CodePromptSystem(profile)` → `isSectionEnabled`
- 描述 diagnostic 输出格式

### 5.3 Tech debt

如果发现 `CodePromptSystem` / `GeneralPromptSystem` 之间有重复的 `getStaticSections` 模式(应该会有),记录在 `docs/exec-plans/tech-debt-tracker.md`,留作后续重构

### 5.4 Commit

按 repo 风格:`fix(agent): wire promptProfile into CodePromptSystem + PromptsRegistry`,单独一个 commit。Phase 2-3 可以追加或独立 commit。

---

## 风险与决策点

### 决策点 1.6: `PromptManager` vs `promptSystem.buildSystemPrompt` 谁主导

Phase 1.6 需要在动 `index.ts` 之前先确认 duya 实际调用哪条路径。如果是 `this.promptManager.buildSystemPrompt`,那 `this.promptManager` 也需要收到 `getPromptProfileForAgentProfile(appliedProfile)`。**这一段会在 Phase 1 开始时用 Explore 子任务确认**,不影响其他 Phase。

### 风险: 修复后某些 profile 的 prompt 显著变短

比如 `general-purpose` 禁了 `taskHandling`(本来就是为 chat 优化),修复后会变短。预期行为,但需要冒烟测试确认没有依赖该 section 的旧代码路径报错。

### 风险: `PromptsRegistry` 缓存改动可能影响并发

agent 长生命周期下,按 (name, profile) 缓存会创建多个 instance,占用更多内存。如果有 profile 在每次 streamChat 都不同,可能累积。需要 Phase 1 完成后监控内存。

### 不动: 现有 preset 的 `allowedTools` / `disallowedTools` 列表

`code-expert` 的 `disallowedTools: ['show_widget', 'cron', 'duya:*', 'canvas:*', 'memory', 'SessionSearch']` 含义是对的(读出 duya/canvas/memory 是 admin-only tool),只是名字风格跟实际工具命名是否一致需要 Phase 2 diagnostic 验证。**不**在本次改 preset 列表,先看 diagnostic 输出再决策。

---

## 完成定义 (Definition of Done)

- [ ] `pnpm typecheck:all` 通过
- [ ] `promptsRegistry.get('code', profileA)` 与 `promptsRegistry.get('code', profileB)` 在 `profileA !== profileB` 时返回不同实例
- [ ] `CodePromptSystem` 在 `applyProfileOverrides({ disableSections: ['memory'] })` 下的 `buildSystemPrompt` 输出不含 "Memory" 段
- [ ] `ToolFilter` 诊断输出在 dev 模式日志可见
- [ ] 新增 unit test 全部通过(目标 ≥ 8 个 test case)
- [ ] 手动跑 dev 模式,选 `code-expert` / `general` / `research` profile,system prompt 长度符合预期(参考 baseline: 修复前长度 ± 30%)
- [ ] Plan 移到 `docs/exec-plans/completed/`
- [ ] `docs/exec-plans/README.md` 更新
