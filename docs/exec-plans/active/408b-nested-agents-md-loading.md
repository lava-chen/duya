# Plan 408b: 嵌套目录 AGENTS.md 按需加载（nested memory）

> Plan 408 Phase 6 的正式立项。前置条件 plan 87（hook 体系）已落地，阻塞解除。

**Goal:** 对齐 claude-code-haha 的 `nested_memory` 机制——当工具触碰 cwd 以下子树的文件时，按需发现并注入该子树上的 AGENTS.md / `.duya/rules/*.md`，以及祖先链上带 `paths:` frontmatter 的条件规则（激活当前死掉的 `globs` 字段）。会话内按绝对路径去重，每份文件只注入一次。

**Architecture:** 复用三块现有设施，不新建注入通道：
1. **触发**：DuyaAgent streamChat 循环的 PostToolUse 派发点（`turnToolCalls` 已携带本轮全部工具调用）；
2. **发现**：新模块 `agentsmd/nested-loader.ts`（纯函数，镜像 cc-haha `getNestedMemoryAttachmentsForFile` 的四阶段顺序）；
3. **投递**：`hooks/injection.ts` 的 `applyHookInjection`（hash 去重 + replace-last + runtimeContext 元数据），内容用 `<system-reminder><project_instructions_spec>` 包裹。

**Tech Stack:** TypeScript / Vitest / 现有 agentsmd loader 基元（`parseAgentsFileContent` / `stripHtmlComments` / frontmatter globs）

---

## 背景与现状差距

### 现状（plan 408 Phase 1-5 完成后）

- 加载范围：Managed → User → Project（**cwd→root 祖先链**）→ Local。cwd 以下子树的 AGENTS.md **永远不会被加载**，连 system prompt 里的文件索引都进不去。
- `globs`（frontmatter `paths:`）只用于索引里的一行 "; applies to xxx" 标注，无任何匹配逻辑。
- 注入位置：system prompt 尾部（Phase 5），随 system-prefix cache 断点命中。
- PostToolUse 派发点已有：`packages/agent/src/agent/DuyaAgent.ts:1857` 附近，`loopHooks.dispatch('PostToolUse', ...)`，本轮工具调用记录在 `turnToolCalls: Array<{ name: string; input: unknown }>`（:1011/:1554）。
- 中途注入通道已有：`applyHookInjection(messages, dedupKey, content, source, opts)`（`packages/agent/src/hooks/injection.ts`）——user 角色消息、hash 全局去重、同 key replace-last、`metadata.runtimeContext: true`。

### 参考实现（claude-code-haha）

`src/utils/attachments.ts:1792` `getNestedMemoryAttachmentsForFile`，四阶段处理顺序（必须保持）：

1. Managed/User **条件规则**（globs 匹配目标文件路径）；
2. **嵌套目录**（CWD → 目标文件的目录链）：每个目录取 CLAUDE.md + 无条件 rules + 条件 rules；
3. CWD 层目录（root → CWD）：**只有条件规则**（无条件规则已在启动时 eager 加载过）；
4. 去重：`loadedNestedMemoryPaths` 非驱逐 Set（session 级）；注入后同时写入 `readFileState` 防止 LRU 驱逐导致重复注入。

触发方式：Read/Glob/Grep 等工具把触碰路径塞进 `toolUseContext.nestedMemoryAttachmentTriggers`，每次模型调用前统一消费并清空。

### 本计划的处理

| 维度 | cc-haha | duya 本计划 |
|------|---------|------------|
| 触发时机 | 工具写 trigger set，下轮模型调用前消费 | PostToolUse 派发点同步消费（同一时点，语义等价） |
| 发现逻辑 | 四阶段 | 同四阶段，复用 `loadAgentsMdFiles` 的解析基元 |
| 投递 | attachment 拼 user 消息 | `applyHookInjection`（dedupKey=`nested-agents-md`，append-only） |
| 去重 | session 级 Set | manager 上加 session 级 `loadedNestedPaths` Set |
| 安全边界 | `pathInAllowedWorkingPath` | 只接受 project root 内路径；复用 `checkPathReadPermission` 语义 |
| 条件规则 glob 匹配 | picomatch | `picomatch`（已是依赖，见 `src/types/picomatch.d.ts`） |
| 开关 | `tengu_paper_halyard` | feature flag `duya_nested_agents_md`（默认 true） |

---

## 文件结构

| 路径 | 职责 | 动作 |
|------|------|------|
| `packages/agent/src/agentsmd/nested-loader.ts` | 纯函数：trigger paths → 待注入 AgentsFileInfo[]（四阶段 + dedup set） | 新建（Phase A） |
| `packages/agent/src/agentsmd/manager.ts` | 加 session 级 `loadedNestedPaths` + `collectNestedMemory()` 门面 | 修改（Phase B） |
| `packages/agent/src/agent/DuyaAgent.ts` | PostToolUse 点接线：收集路径 → collect → applyHookInjection | 修改（Phase C） |
| `packages/agent/src/config/feature-flags.ts` | 注册 `duya_nested_agents_md` | 修改（Phase C） |
| `packages/agent/tests/unit/agentsmd/nested-loader.test.ts` | 发现顺序 / dedup / globs / 边界单测 | 新建（Phase A） |
| `packages/agent/tests/unit/agent/nestedInjection.test.ts` | loop 接线测试（read 触发一次注入、二次 read 不重复） | 新建（Phase C） |
| `docs/exec-plans/README.md` | 注册本 plan | 修改 |
| `ARCHITECTURE.md` | AGENTS.md 加载章节补嵌套加载段 | 修改（Phase D） |

---

## Phase A: nested-loader 纯函数模块 —— 0.5 天

- [x] **A1. 实现 `collectNestedMemoryFiles`**

签名：

```ts
export interface NestedLoadContext {
  /** Session cwd (= project root for eager loading). */
  cwd: string
  /** Absolute paths touched by tools this turn. */
  triggerPaths: readonly string[]
  /** Already-injected absolute paths (mutated by this call). */
  loadedPaths: Set<string>
}

/** Returns files to inject this turn, in deterministic four-phase order. */
export async function collectNestedMemoryFiles(
  ctx: NestedLoadContext,
): Promise<AgentsFileInfo[]>
```

处理顺序（对齐 cc-haha，勿打乱）：
1. 过滤 triggerPaths：绝对化、normalize、必须位于 `cwd` 内（前缀检查 + `path.relative` 不以 `..` 开头）；跳过 `.git` 与 `node_modules` 内路径；
2. 对每个存活 path：从 `dirname(path)` 向上走到 `cwd`（不含），逐目录探测 `AGENTS.md` / `.duya/AGENTS.md` / `.duya/rules/*.md`（rules 目录递归，复用 `processRulesDir` 思路）；
3. 祖先链（root→cwd）上已加载文件里 `globs` 非空者：用 `picomatch` 对 trigger path 的 repo 相对路径做匹配，命中且未注入过的加入结果；
4. 全程用共享 `processedPaths` + 入参 `loadedPaths` 双重去重；解析复用 `parseAgentsFileContent`（自带 stripHtmlComments + frontmatter globs）。

- [x] **A2. 单测**

覆盖：
- 子目录 AGENTS.md 被发现（cwd 下两层）；
- 同一文件第二次 trigger 不再返回（dedup）；
- 祖先链 `paths: src/**` 条件规则命中 `src/a/b.ts`、不命中 `docs/x.md`；
- cwd 外路径 / `.git` 内路径被拒绝；
- 目录链顺序为自浅至深（优先级语义：靠近触发文件者优先级最高，排序与 `buildAgentsMdPrompt` 一致即可，注入文案自带路径无需排序保证）。

---

## Phase B: Manager 门面 —— 0.3 天

- [x] **B1.** `AgentsMdManager` 增加：
  - 私有 `loadedNestedPaths = new Set<string>()`（`reset()` 时清空）;
  - `async collectNestedMemory(triggerPaths: string[]): Promise<AgentsFileInfo[]>` — 调 Phase A，返回增量并把路径并入 set；
  - `renderNestedMemoryBlock(files: AgentsFileInfo[]): string` — 每份文件一段 `` Contents of <path> (project instructions, nested directory):\n\n<content> ``，整体 `<system-reminder>\n<project_instructions_spec>\n…\n</project_instructions_spec>` 包裹（与 `buildAgentsMdPrompt` 同构；空数组返回 ''）。注意：不要复用 MEMORY_INSTRUCTION_PROMPT 开头句——那是首注入专用语，嵌套注入只需文件内容本身。

---

## Phase C: DuyaAgent 接线 + flag —— 1 天

- [x] **C1.** feature flag `duya_nested_agents_md`（默认 true）注册进 `feature-flags.ts`。
- [x] **C2.** PostToolUse 派发点（`DuyaAgent.ts:1857` 附近）之后追加：

```ts
// Plan 408b: nested AGENTS.md on-demand loading. Tools that touched files
// under the project root pull in subtree AGENTS.md / conditional rules as a
// one-shot user-role reminder (cc-haha nested_memory parity).
if (this.omitAgentsMd !== true && isFeatureEnabled('duya_nested_agents_md')) {
  const triggerPaths = extractTriggerPaths(turnToolCalls); // read/grep/glob/edit/write 的 file_path/path
  if (triggerPaths.length > 0) {
    const files = await getAgentsMdManager().collectNestedMemory(triggerPaths);
    if (files.length > 0) {
      applyHookInjection(
        messages as unknown as InjectableMessage[],
        undefined, // append-only; per-file dedup already done via loadedNestedPaths
        renderSystemReminder(getAgentsMdManager().renderNestedMemoryBlock(files)),
        'nested-agents-md',
        { now: Date.now() },
      );
    }
  }
}
```

`extractTriggerPaths`：小工具函数，从 `{name, input}` 提取 `file_path` / `path` 字段（read/edit/write/grep/glob），相对路径按 workingDirectory 绝对化；放 `nested-loader.ts` 导出以便单测。

- [x] **C3.** 日志：注入时 `logger.info('Nested AGENTS.md injected', { count, paths }, 'AgentsMd')`（遵守 Logging 规则：记路径计数即可，路径本身 DEBUG 级）。
- [x] **C4.** 接线测试：mock fs 场景下 read 子树文件 → messages 数组新增一条 `metadata.source === 'nested-agents-md'` 的 user 消息；再次 read 同目录 → 无新增。
- [x] **C5.** `npm run typecheck:all` + `npx vitest run packages/agent/tests/unit/agentsmd packages/agent/tests/unit/agent` 全绿。

---

## Phase D: 收尾 —— 0.2 天

- [ ] **D1.** ARCHITECTURE.md「Profile/Mode/Permission」附近或 AGENTS.md 加载相关章节补一段嵌套加载说明。
- [ ] **D2.** docs/exec-plans/README.md 注册本 plan；plan 408 的 Phase 6 占位改指本 plan。
- [ ] **D3.** 手动验证：在真实 Electron 会话中 read 一个含子目录 AGENTS.md 的仓库文件，确认下一轮模型上下文出现注入块（app.log 有 Nested AGENTS.md injected）。

---

## 缓存与成本分析

- 注入是**尾部附近的 user 消息**，不动 system prefix → Phase 5 建立的 system cache 断点不受影响；代价只是注入点之后的对话前缀一次性失效（与 cc-haha 完全相同的取舍）。
- token 成本可控：每份文件只在会话内注入一次；`maxFileSize`(40000 chars) 沿用，超限文件截断并在块内注明（后续如需可升级为 governHookContext 式 spill-to-disk）。

## 风险与回退

| 风险 | 回退 |
|------|------|
| 恶意仓库子目录 AGENTS.md 注入深度伪装指令 | stripHtmlComments 已在 parse 出口生效；`<system-reminder>` 包裹 + outgoing strip 兜底；flag 一键关闭 |
| 大量小 AGENTS.md 造成注入风暴 | loadedPaths 会话级去重天然限流；可选每 turn 注入上限（如 4 份，超出留待下轮）|
| sub-agent 上下文污染 | `omitAgentsMd === true` 直接短路（与 plan 408 Phase 2 语义一致）|

## 关键决策日志

| 决策 | 选定 | 理由 |
|------|------|------|
| 投递通道 | applyHookInjection（user 角色） | cc-haha 同位（user-message attachment）；机制现成，去重/元数据免费 |
| 触发点 | PostToolUse 同步消费 | 与"下轮调用前消费"同时点；避免新增跨 turn 可变状态 |
| 条件规则匹配库 | picomatch | 仓内已有类型定义与依赖 |
| 默认开关 | true | 行为即用户直觉（AGENTS.md 就该生效）；flag 仅作回退 |

## 参考文件

- 参考实现：`E:\cloned-projects\claude-code-haha\src\utils\attachments.ts:1709-1878`（memoryFilesToAttachments / getNestedMemoryAttachmentsForFile）、`src\QueryEngine.ts:198,370,518`
- duya 主路径：`packages/agent/src/agentsmd/{loader,manager,types}.ts`、`packages/agent/src/hooks/injection.ts`、`packages/agent/src/hooks/loop.ts`、`packages/agent/src/agent/DuyaAgent.ts:1011,1554,1857`
- 关联 plan：408（Phase 6 占位来源）、87（hook 体系，前置已满足）
