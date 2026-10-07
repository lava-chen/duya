# 02 — Tooling 与扩展契约

> 参考实现:`E:\cloned-projects\codex\codex-rs` 的 `ext/extension-api` + `ext/*`。
> **用户明确指示:tooling 不是一个"所有功能都在这里注册"的万能注册表。**

---

## 1. codex-rs 的实际形态

`codex-rs` 有 **170+ crate**。其中 `ext/` 下 14 个扩展 crate:

```
ext/extension-api/     扩展契约(只有 6 个文件)
ext/agent/             agent 扩展
ext/connectors/        connectors 扩展
ext/goal/              goal 扩展
ext/guardian-v2/
ext/history-notes/
ext/image-generation/
ext/items/
ext/mcp/
ext/memories/          memory 扩展
ext/queue/
ext/skills/
ext/web-search/
ext/git-attribution/
```

### 1.1 `ext/extension-api` 只有 6 个文件

```
src/capabilities.rs        AgentSpawner / EventSink / ResponseItemInjector ...
src/contributors.rs        各个 contributor trait 定义
src/registry.rs            ExtensionRegistry + Builder
src/state.rs               ExtensionData
src/user_instructions.rs   UserInstructionsProvider
src/lib.rs                 纯 re-export(93 行)
```

**`lib.rs` 是 93 行纯 re-export** —— 这个包的全部内容就是"扩展点契约"。它不实现任何功能。

### 1.2 关键:注册的是十几个窄接口,不是一个 `register()`

`registry.rs:23-47` 的 `ExtensionRegistryBuilder` 持有 13 个独立的 `Vec`:

```rust
pub struct ExtensionRegistry<C: Sync> {
    event_sink: Arc<dyn ExtensionEventSink>,
    thread_lifecycle_contributors: Vec<Arc<dyn ThreadLifecycleContributor<C>>>,
    turn_lifecycle_contributors: Vec<Arc<dyn TurnLifecycleContributor>>,
    config_contributors: Vec<Arc<dyn ConfigContributor<C>>>,
    token_usage_contributors: Vec<Arc<dyn TokenUsageContributor>>,
    skill_invocation_contributors: Vec<Arc<dyn SkillInvocationContributor>>,
    approval_review_contributors: Vec<Arc<dyn ApprovalReviewContributor>>,
    context_contributors: Vec<Arc<dyn ContextContributor>>,
    mcp_server_contributors: Vec<Arc<dyn McpServerContributor>>,
    turn_input_contributors: Vec<Arc<dyn TurnInputContributor>>,
    tool_contributors: Vec<Arc<dyn ToolContributor>>,
    tool_lifecycle_contributors: Vec<Arc<dyn ToolLifecycleContributor>>,
    turn_item_contributors: Vec<Arc<dyn TurnItemContributor>>,
}
```

**每个 `Vec` 是一个独立的贡献点。** Builder 上有 13 个各自的方法(`approval_review_contributor()`、`thread_lifecycle_contributor()` ...),不是一个 `register(plugin)`。

### 1.3 contributor 的粒度

从 `lib.rs` 的 93 行 re-export 可见 contributor 的粒度 —— 全部是"一件事":

| 类别 | contributor |
| --- | --- |
| 线程生命周期 | `ThreadLifecycleContributor`(`ThreadStartInput` / `ThreadResumeInput` / `ThreadReadyInput` / `ThreadStopInput` / `ThreadIdleCause`) |
| turn 生命周期 | `TurnLifecycleContributor`(`TurnStartInput` / `TurnStopInput` / `TurnAbortInput` / `TurnErrorInput`) |
| 工具 | `ToolContributor`(提供工具)/ `ToolLifecycleContributor`(`ToolStartInput` / `ToolFinishInput` / `ToolCallOutcome`) |
| 上下文 | `ContextContributor` / `PromptFragment` / `PromptSlot` / `WorldStateSectionContribution` |
| 输入产出 | `TurnInputContributor` / `TurnItemContributor` |
| 审批 | `ApprovalReviewContributor` |
| 配置 | `ConfigContributor` |
| MCP | `McpServerContributor`(`McpServerContributionContext`) |
| 计量 | `TokenUsageContributor` |
| 技能 | `SkillInvocationContributor`(`SkillInvocationKind`) |

### 1.4 依赖方向

- `ext/*` → `ext/extension-api` → `codex-protocol` / `codex-tools` / `codex-context-fragments`
- 扩展 crate **不反向依赖** core

### 1.5 明确不抄的一点

`core/Cargo.toml` 显示 `codex-core` 依赖:`codex-mcp`、`codex-file-system`、`codex-login`、`codex-client`、`codex-secrets`... —— **一个有 IO 的 crate 直接依赖 core**。

**本系列的 Core 不允许这样**(00 合同 §A.3)。Core 零 IO 是硬约束,不是可以靠"大家都这么写"让步的约定。

---

## 2. `@duya/tooling` 的设计

### 2.1 包的职责

`packages/tooling` = **扩展契约 + 装配**。三件事:

1. 定义 contributor 接口(窄,一个一件事)
2. 提供 `ExtensionRegistry` + builder(13 个独立槽位,不是一个 register)
3. 提供装配期校验(见 §2.4)

**不提供:** 功能实现、万能注册表、行为接管机制。

### 2.2 候选 contributor 清单

从 `packages/agent` 现有扩展点反推(这些是**已存在的**扩展位置,不是新造的):

| contributor | 现有扩展点 | 目标位置 |
| --- | --- | --- |
| `ModeContributor` | `modes/index.ts` 的 `ModeModifier` 注册(plan 224) | tooling |
| `ToolContributor` | `tool/builtin.ts` 的工具注册 | tooling |
| `PromptSectionContributor` | `prompts/modules/registry.ts` 的模块注册 | tooling |
| `HookContributor` | `hooks/builtin.ts` 的 hook 注册 | tooling |
| `ContextContributor` | `agentsmd/manager.ts` 的指令加载 | tooling |
| `SkillContributor` | `skills/index.ts` 的 skill 注册 | tooling |
| `ApprovalPolicyContributor` | `permissions/policy.ts` 的 `PERMISSION_MODE_CONFIG` | tooling |
| `ProfileContributor` | `agent-profile/` 的 profile 组合 | tooling |
| `McpServerContributor` | `mcp/index.ts` 的 MCP manager | tooling → capabilities |
| `AppConnectorContributor` | `AppConnectionTool` / `AppConnectorManageTool` | tooling → connectors |
| `MemoryPolicyContributor` | `memory-rollout/stage1_policy_editor.ts` | tooling → memory |
| `DecisionContributor` | `decisions/` 的 `DecisionService` 降级链 | tooling |
| `LifecycleContributor` | `lifecycle/` 的 background agent | tooling → runtime |
| `TokenUsageContributor` | `observability/cache-monitor.ts` | tooling |

**注意 `ModeContributor` / `PromptSectionContributor` 这类已经是"注入片段"而非"接管行为"的形状** —— 它们是本系列要保留的正面例子。

### 2.3 与 runtime 的关系

```
Runtime 拥有循环
    ↓ 在固定位置询问 registry
ExtensionRegistry 收集贡献
    ↓
Contributor 返回数据/决策
    ↓
Runtime 决定是否采纳
```

**扩展不能自己实现循环。** 这是与 codex-rs 一致的关键纪律,也是 `modes/` 里 `applyModes` 已经在做的形状。

### 2.4 装配期校验(必须有,否则会重复实现)

`ExtensionRegistry` 提供 `validate()`,在装配期(**不是运行期**)拒绝:

- 重复的 `tool_id` / `mode_id` / `sectionName`
- contributor 声明的 capability 超出 runtime 授予的
- 环状的 lifecycle hook(turn-start 里的 contributor 再注册 turn-start)
- prompt slot 冲突

**理由:** 587 的 F08 指出 HostMap "按容量直接踢最旧 binding",capacity=1 时第二个 live run 踢掉第一个。**没有装配期校验的注册表,就是下一个 HostMap。**

### 2.5 迁移源

| 迁入 | 从 |
| --- | --- |
| contributor 接口 | `packages/agent/src/modes/index.ts`(`ModeModifier` 形状已是正例) |
| registry | `packages/agent/src/tool/registry.ts` 的 `ToolRegistry`(只取 registry 机制,工具实现去 capabilities) |
| 装配 | `packages/agent/src/tool/builtin.ts` 的注册调用点 |

**不搬:** `ToolRegistry` 里的 `catalogRevision` / `replaceByOwner` 等**运行期状态** —— 那属于 runtime 的 catalog 快照,不是扩展契约。

---

## 3. 与其他包的关系

```
protocol  ←──── tooling  ←──── runtime
                        ←──── capabilities
                        ←──── connectors
                        ←──── memory
```

**tooling 不 import capabilities / connectors / memory。** 它只定义接口,由 host 在装配时把具体实现注进来。

否则 tooling 会变成"所有功能都在这里注册"的注册表 —— 正是要避免的。

---

## 4. 门禁

**编号用 `T` 前缀,不是 `G`。** `G` 前缀已经属于 `scripts/architecture/boundary-gates.mjs`
的真实门禁(截至 2026-10-07 已实装到 G10),其中 **G7 = 「worker entry 不得到达轮次循环实现」**、
**G8 = 「轮次循环归运行时执行包所有」**。本文原先把这三条也写成 G7/G8/G9,于是同一个号有两套含义 ——
本项目已经因此在会话里被引用错过不止一次(「G7 转绿」说的是轮次循环那一条,与这里的 G7 无关)。
**未实装的门禁不得占用已实装门禁的号。**

| 门禁 | 检查 | 变异证明 |
| --- | --- | --- |
| T1 | `tooling` 不 import capabilities/connectors/memory | 在 tooling 加一条 `import from '@duya/capabilities'` |
| T2 | registry 有装配期 `validate()` 且被真实装配路径调用 | 绕过 validate 直接装配 |
| T3 | 没有单一 `register(plugin)` 万能方法 | 加一个 `register(any)` 方法 |

**T3 的检查方式**:统计 `ExtensionRegistry` 的 public 方法,若存在参数类型为 `any`/`unknown` 的注册方法则红。
