# Grok SyntheticReason 体系与工作目录切换对齐 Implementation Plan

> **状态：** Phase 1–4（Task 1–9）已完成实现并通过聚焦测试 + `npm run typecheck:all`（2026-08-13，多 subagent 并行推进）。Task 10 全量校验待最后执行。更改已随当日同级工作一并提交。

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 duya 的 `RuntimeContextMessage` 框架内落地设计文档《2026-08-13-grok-synthetic-reason-and-working-directory-design.md》第 5 节的三个要点（工作目录切换框架支持、`starts_prompt_turn()` turn 边界语义、`ProjectInstructions` 结构化注入），外加 grok 压缩分类下的 **AutoContinue**（压缩后继续工作）机制。

**Architecture:** 全部改动复用现有 `RuntimeContextMessage` 框架（`message-framework.ts` 定义 source 联合类型 + `runtime-context-adapters.ts` 提供纯适配器 + `message-projectors.ts` 负责投影），不触碰持久化 schema。工作目录切换通过 `cwdGeneration` 元数据实现幂等去重；turn 边界通过一个纯分类函数表达；AGENTS.md 保持系统提示注入（KV-cache 友好），仅增加结构化 `<project_instructions_spec>` 包裹。

**Tech Stack:** TypeScript (strict), Vitest, @duya/agent workspace package。

**前置事实（避免回归）：** AGENTS.md 已在 Plan 408 Phase 5 移入**系统提示**（`DuyaAgent.ts:2217`、`agent-shell.ts:202`），用 `buildAgentsMdSection()` 输出、外层 `<system-reminder>` 包裹，KV-cache 友好。因此本计划**不把 AGENTS.md 移回消息数组**，只在系统提示内对齐 grok 的 `<project_instructions_spec>` 结构化包裹。

**运行命令：**

```bash
# 聚焦测试（cwd = packages/agent）
npx vitest run tests/unit/runtime-context-adapters.test.ts
npx vitest run tests/unit/message-projectors.test.ts
npm run -w @duya/agent build      # 清增量编译缓存 / 校验 tsc
npm run typecheck:all             # 提交前必须通过
```

---

## Phase 1: 工作目录切换框架支持

### Task 1: 新增 `working_directory_switch` source 与 `cwdGeneration` 元数据键

**Files:**
- Modify: `packages/agent/src/message/message-framework.ts:7-16`
- Modify: `packages/agent/src/message/runtime-context-adapters.ts:45-64`

- [x] **Step 1: 在 `RuntimeContextSource` 联合类型加入变体**

`packages/agent/src/message/message-framework.ts` 的 `RuntimeContextSource` 增加 `'working_directory_switch'`：

```ts
export type RuntimeContextSource =
  | 'agents_md'
  | 'attachment'
  | 'background_notification'
  | 'mailbox'
  | 'memory'
  | 'mode'
  | 'system'
  | 'todo_gate'
  | 'working_directory_switch'  // 新增
  | 'custom';
```

- [x] **Step 2: 在 `RUNTIME_CONTEXT_METADATA_KEYS` 增加 `cwdGeneration` 键**

`packages/agent/src/message/runtime-context-adapters.ts` 的 `RUNTIME_CONTEXT_METADATA_KEYS` 增加一条：

```ts
  /** string[] — attachment names that contributed to the context. */
  attachmentNames: 'attachmentNames',
  /** number — monotonic cwd "generation" identifying a working-directory switch. */
  cwdGeneration: 'cwdGeneration',
} as const;
```

- [x] **Step 3: 类型检查**

Run: `npm run -w @duya/agent build`
Expected: PASS（无类型错误）。

- [x] **Step 4: 提交**

```bash
git add packages/agent/src/message/message-framework.ts packages/agent/src/message/runtime-context-adapters.ts
git commit -m "feat(agent): add working_directory_switch source and cwdGeneration metadata key"
```

---

### Task 2: 新增 `adaptWorkingDirectorySwitch` 纯适配器

**Files:**
- Modify: `packages/agent/src/message/runtime-context-adapters.ts`
- Test: `packages/agent/tests/unit/runtime-context-adapters.test.ts`

- [x] **Step 1: 写失败测试**

在 `runtime-context-adapters.test.ts` 末尾新增 describe。沿用文件内已有的 `deterministicIds` / `options` / `FIXED_NOW` 辅助：

```ts
// ─── Working directory switch ────────────────────────────────────────────

describe('adaptWorkingDirectorySwitch', () => {
  it('produces a hidden runtime_context carrying cwdGeneration', () => {
    const ids = deterministicIds('cwd');
    const msg = adaptWorkingDirectorySwitch(
      'Working directory changed to /repo/sub',
      3,
      options(ids.next),
    );

    expect(msg.role).toBe('runtime_context');
    expect(msg.source).toBe('working_directory_switch');
    expect(msg.visibility).toBe('hidden');
    expect(msg.content).toBe('Working directory changed to /repo/sub');
    expect(msg.metadata).toMatchObject({
      [RUNTIME_CONTEXT_METADATA_KEYS.cwdGeneration]: 3,
    });
  });

  it('projects to a user-role provider message with runtimeContext mark', () => {
    const ids = deterministicIds('cwd');
    const msg = adaptWorkingDirectorySwitch('cwd -> /x', 1, options(ids.next));

    const projected = projectRuntimeContextToProviderMessage(msg);

    expect(projected.role).toBe('user');
    expect(projected.metadata).toEqual({
      runtimeContext: true,
      source: 'working_directory_switch',
    });
  });

  it('records seqIndex in metadata', () => {
    const ids = deterministicIds('cwd');
    const msg = adaptWorkingDirectorySwitch('cwd -> /y', 2, options(ids.next, { seqIndex: 7 }));

    expect(msg.metadata).toMatchObject({ seqIndex: 7 });
  });
});
```

同时在文件顶部 import 中追加 `adaptWorkingDirectorySwitch`：

```ts
import {
  RUNTIME_CONTEXT_METADATA_KEYS,
  adaptAttachmentContext,
  adaptCustomRuntimeContext,
  adaptMailboxRows,
  adaptTaskNotificationXml,
  adaptWorkingDirectorySwitch,   // 新增
  dedupeRuntimeContextMessages,
  projectRuntimeContextToProviderMessage,
  type RuntimeContextAdapterOptions,
} from '../../src/message/runtime-context-adapters.js';
```

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/runtime-context-adapters.test.ts`
Expected: FAIL with `adaptWorkingDirectorySwitch is not a function`。

- [x] **Step 3: 实现适配器**

在 `runtime-context-adapters.ts` 的 `adaptTodoGateContext` 之后新增：

```ts
// ─── 7. Working-directory switch -> source='working_directory_switch' ────

/**
 * Adapts a working-directory switch notice into a runtime_context message.
 * The monotonic `cwdGeneration` is carried on metadata so consumers can dedupe
 * and correlate switches without parsing content (mirrors grok's
 * `cwd_generation`). Defaults to visibility='hidden': a harness directive, not
 * a user turn.
 */
export function adaptWorkingDirectorySwitch(
  content: string,
  cwdGeneration: number,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'working_directory_switch',
    content,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: {
      ...options.metadata,
      [RUNTIME_CONTEXT_METADATA_KEYS.cwdGeneration]: cwdGeneration,
    },
  });
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/runtime-context-adapters.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add packages/agent/src/message/runtime-context-adapters.ts packages/agent/tests/unit/runtime-context-adapters.test.ts
git commit -m "feat(agent): add adaptWorkingDirectorySwitch runtime adapter"
```

---

### Task 3: `dedupeRuntimeContextMessages` 按 `cwdGeneration` 幂等去重

**Files:**
- Modify: `packages/agent/src/message/runtime-context-adapters.ts:294-341`
- Test: `packages/agent/tests/unit/runtime-context-adapters.test.ts`

- [x] **Step 1: 写失败测试**

在 `describe('dedupeRuntimeContextMessages')` 内新增用例：

```ts
  it('drops a working-directory switch with a repeated cwdGeneration', () => {
    const ids = deterministicIds('cwd');
    const first = adaptWorkingDirectorySwitch('cwd -> /a', 5, options(ids.next));
    const second = adaptWorkingDirectorySwitch('cwd -> /a', 5, options(ids.next));

    const result = dedupeRuntimeContextMessages([first, second]);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('cwd-1');
  });

  it('keeps distinct cwdGenerations', () => {
    const ids = deterministicIds('cwd');
    const g1 = adaptWorkingDirectorySwitch('cwd -> /a', 1, options(ids.next));
    const g2 = adaptWorkingDirectorySwitch('cwd -> /b', 2, options(ids.next));
    const g1again = adaptWorkingDirectorySwitch('cwd -> /a', 1, options(ids.next));

    const result = dedupeRuntimeContextMessages([g1, g2, g1again]);

    expect(result.map((m) => m.id)).toEqual(['cwd-1', 'cwd-2']);
  });
```

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/runtime-context-adapters.test.ts`
Expected: 新用例 FAIL（当前实现把两个 switch 都保留）。

- [x] **Step 3: 实现去重**

在 `dedupeRuntimeContextMessages` 内新增分支（在 `background_notification` 分支之后、`result.push` 之前），并新增 `readNumber` 辅助：

```ts
    if (message.source === 'working_directory_switch') {
      const gen = readNumber(
        message.metadata,
        RUNTIME_CONTEXT_METADATA_KEYS.cwdGeneration,
      );
      if (gen !== undefined) {
        if (seenCwdGenerations.has(gen)) {
          continue;
        }
        seenCwdGenerations.add(gen);
      }
      result.push(message);
      continue;
    }
```

在函数开头声明 `const seenCwdGenerations = new Set<number>();`，并在文件底部新增：

```ts
function readNumber(
  metadata: Readonly<Record<string, unknown>> | undefined,
  key: string,
): number | undefined {
  const value = metadata?.[key];
  return typeof value === 'number' ? value : undefined;
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/runtime-context-adapters.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add packages/agent/src/message/runtime-context-adapters.ts packages/agent/tests/unit/runtime-context-adapters.test.ts
git commit -m "feat(agent): dedupe working-directory switches by cwdGeneration"
```

---

### Task 4: 持久化/投影往返保留 `cwdGeneration`

**Files:**
- Test: `packages/agent/tests/unit/runtime-context-adapters.test.ts`

验证 `projectPersistenceMessages` 与 `projectRuntimeContextToProviderMessage` 在往返中不丢 `cwdGeneration`（现有 `nativeRuntimeContextToLegacy` 已通过 `metadata.source` + `msg_type` 保留，无需改实现，仅补测试锁定行为）。

- [x] **Step 1: 写测试**

在 `runtime-context-adapters.test.ts` 的 `describe('runtime context is persisted')` 内新增：

```ts
  it('preserves cwdGeneration through the persistence projection', () => {
    const ids = deterministicIds('cwd');
    const msg = adaptWorkingDirectorySwitch('cwd -> /z', 9, options(ids.next));

    const persisted = projectPersistenceMessages([msg]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe('user');
    expect(persisted[0].metadata).toMatchObject({
      runtimeContext: true,
      source: 'working_directory_switch',
      [RUNTIME_CONTEXT_METADATA_KEYS.cwdGeneration]: 9,
    });
  });
```

- [x] **Step 2: 运行测试确认通过**

Run: `npx vitest run tests/unit/runtime-context-adapters.test.ts`
Expected: PASS（现有投影路径已保留 metadata）。

- [x] **Step 3: 提交**

```bash
git add packages/agent/tests/unit/runtime-context-adapters.test.ts
git commit -m "test(agent): lock cwdGeneration preservation through persistence projection"
```

---

## Phase 2: `starts_prompt_turn()` turn 边界语义

### Task 5: 新增 `runtimeContextStartsPromptTurn` 纯分类函数

**Files:**
- Modify: `packages/agent/src/message/message-framework.ts`
- Test: `packages/agent/tests/unit/message-framework.test.ts`

语义对齐 grok：只有"服务端/后台唤醒"类合成消息（duya 中即 `background_notification`，对应 grok 的 `TaskCompleted`/`SubagentCompleted`/`NotificationDrain`）启动新 turn；其余均为 mid-turn 注入（不消费 turn 边界、不改变与相邻消息的 turn 关系）。

- [x] **Step 1: 写失败测试**

在 `message-framework.test.ts` 新增 describe：

```ts
import {
  runtimeContextStartsPromptTurn,
  type RuntimeContextSource,
} from '../../src/message/message-framework.js';

describe('runtimeContextStartsPromptTurn', () => {
  it('returns true only for background wake-ups', () => {
    expect(runtimeContextStartsPromptTurn('background_notification')).toBe(true);
  });

  it.each<[RuntimeContextSource, boolean]>([
    ['working_directory_switch', false],
    ['todo_gate', false],
    ['mailbox', false],
    ['attachment', false],
    ['memory', false],
    ['mode', false],
    ['system', false],
    ['agents_md', false],
    ['custom', false],
  ])('returns false for mid-turn injection source %s', (source, expected) => {
    expect(runtimeContextStartsPromptTurn(source)).toBe(expected);
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/message-framework.test.ts`
Expected: FAIL with `runtimeContextStartsPromptTurn is not defined`。

- [x] **Step 3: 实现分类函数**

在 `message-framework.ts` 的 `isVisibleAgentMessage` 附近新增：

```ts
/**
 * Whether a synthetic {@link RuntimeContextMessage} starts a new prompt turn
 * or is a mid-turn injection. Aligns with grok's `starts_prompt_turn()`:
 * only server/background wake-ups (task/subagent completed, notification
 * drain) consume a turn boundary; steering directives (system reminders,
 * todo gate, working-directory switch, project instructions) are mid-turn and
 * must not change the turn relationship with neighbouring real user turns.
 */
export function runtimeContextStartsPromptTurn(source: RuntimeContextSource): boolean {
  switch (source) {
    case 'background_notification':
      return true;
    default:
      return false;
  }
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/message-framework.test.ts`
Expected: PASS。

- [x] **Step 5: 提交**

```bash
git add packages/agent/src/message/message-framework.ts packages/agent/tests/unit/message-framework.test.ts
git commit -m "feat(agent): add runtimeContextStartsPromptTurn turn-boundary classification"
```

---

## Phase 3: ProjectInstructions 结构化注入

### Task 6: AGENTS.md 系统提示加 `<project_instructions_spec>` 结构化包裹

**Files:**
- Modify: `packages/agent/src/agentsmd/loader.ts:640-646`
- Test: `packages/agent/tests/unit/agentsmd/loader.test.ts`（若不存在则见 Step 1 定位）

对齐 grok 的 `subagent_prompt.md` 用 `<project_instructions_spec>...</project_instructions_spec>` 包裹 AGENTS.md。AGENTS.md 保持留在**系统提示**（KV-cache 友好、不可替换），仅把内层正文包进结构化标签，外层 `<system-reminder>` 保留以维持 strip 守卫与模型训练槽位。

- [x] **Step 1: 定位现有 loader 测试**

Run: `node -e "console.log(require('fs').existsSync('packages/agent/tests/unit/agentsmd/loader.test.ts'))"`
若已存在则在其中新增用例；若不存在，`buildAgentsMdPrompt` 的单元测试可放在 `packages/agent/tests/unit/agentsmd/loader.test.ts`（新建）。

- [x] **Step 2: 写失败测试**

```ts
import { describe, expect, it } from 'vitest';
import { buildAgentsMdPrompt, type AgentsFileInfo } from '../../../src/agentsmd/loader.js';

describe('buildAgentsMdPrompt (project instructions spec)', () => {
  it('wraps project instructions in a project_instructions_spec block', () => {
    const files: AgentsFileInfo[] = [
      {
        path: '/repo/AGENTS.md',
        type: 'Project',
        content: 'Use Conventional Commits.',
      },
    ];

    const prompt = buildAgentsMdPrompt(files);

    expect(prompt).toContain('<project_instructions_spec>');
    expect(prompt).toContain('Use Conventional Commits.');
    expect(prompt).toContain('</project_instructions_spec>');
    // Outer <system-reminder> wrapper is preserved for the strip guard.
    expect(prompt.startsWith('<system-reminder>')).toBe(true);
  });
});
```

> 注：`AgentsFileInfo` 的字段名以 `loader.ts` 实际定义为准（`path`/`type`/`content`）。若字段为 `filePath` 或 `content` 可选，请先 Read `loader.ts` 的类型定义再调整 fixture。

- [x] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/unit/agentsmd/loader.test.ts`
Expected: FAIL（当前输出不含 `<project_instructions_spec>`）。

- [x] **Step 4: 实现结构化包裹**

修改 `buildAgentsMdPrompt` 的返回（`loader.ts:645-646`）：

```ts
  const inner = `${MEMORY_INSTRUCTION_PROMPT}\n\n${memories.join('\n\n')}`
  // Align with grok's subagent_prompt.md: project instructions are wrapped in
  // a <project_instructions_spec> block. The outer <system-reminder> wrapper is
  // kept so the outgoing strip guard and the model training slot stay intact.
  return `<system-reminder>\n<project_instructions_spec>\n${inner}\n</project_instructions_spec>\n</system-reminder>`
```

- [x] **Step 5: 运行测试确认通过**

Run: `npx vitest run tests/unit/agentsmd/loader.test.ts`
Expected: PASS。

- [x] **Step 6: 提交**

```bash
git add packages/agent/src/agentsmd/loader.ts packages/agent/tests/unit/agentsmd/loader.test.ts
git commit -m "feat(agent): wrap AGENTS.md in project_instructions_spec block"
```

---

## Phase 4: AutoContinue（压缩后继续工作）

> 对齐 grok 压缩分类下的 `AutoContinue`：压缩把历史收成一页摘要后，注入一条合成消息让 agent **继续**工作，而不是把摘要当作可停止/可复述的边界。与 `todo_gate` 同属 transient mid-turn 指令：投影为 user 角色、不落库、不启动新 turn。

### Task 8: AutoContinue 框架基础（source + 适配器 + 分类 + 持久化排除）

**Files:**
- Modify: `packages/agent/src/message/message-framework.ts:7-16`
- Modify: `packages/agent/src/message/runtime-context-adapters.ts:45-64`
- Modify: `packages/agent/src/agent/utils/agent-helpers.ts:110-130`
- Test: `packages/agent/tests/unit/runtime-context-adapters.test.ts`
- Test: `packages/agent/tests/unit/message-framework.test.ts`

- [x] **Step 1: 在 `RuntimeContextSource` 加入 `auto_continue`**

`packages/agent/src/message/message-framework.ts` 的 `RuntimeContextSource` 增加 `'auto_continue'`：

```ts
export type RuntimeContextSource =
  | 'agents_md'
  | 'attachment'
  | 'background_notification'
  | 'mailbox'
  | 'memory'
  | 'mode'
  | 'system'
  | 'todo_gate'
  | 'working_directory_switch'
  | 'auto_continue'  // 新增
  | 'custom';
```

- [x] **Step 2: 写失败测试（适配器）**

在 `runtime-context-adapters.test.ts` 新增 describe，并在文件顶部 import 追加 `adaptAutoContinueContext`：

```ts
// ─── AutoContinue (post-compaction continuation) ─────────────────────────

describe('adaptAutoContinueContext', () => {
  it('produces a hidden runtime_context with source=auto_continue', () => {
    const ids = deterministicIds('ac');
    const msg = adaptAutoContinueContext(
      'Compaction done. Keep working.',
      options(ids.next),
    );

    expect(msg.role).toBe('runtime_context');
    expect(msg.source).toBe('auto_continue');
    expect(msg.visibility).toBe('hidden');
    expect(msg.content).toBe('Compaction done. Keep working.');
  });

  it('projects to a user-role provider message with runtimeContext mark', () => {
    const ids = deterministicIds('ac');
    const msg = adaptAutoContinueContext('keep going', options(ids.next));

    const projected = projectRuntimeContextToProviderMessage(msg);

    expect(projected.role).toBe('user');
    expect(projected.metadata).toEqual({
      runtimeContext: true,
      source: 'auto_continue',
    });
  });
});
```

- [x] **Step 3: 运行测试确认失败**

Run: `npx vitest run tests/unit/runtime-context-adapters.test.ts`
Expected: FAIL with `adaptAutoContinueContext is not a function`。

- [x] **Step 4: 实现适配器**

在 `runtime-context-adapters.ts` 的 `adaptWorkingDirectorySwitch` 之后新增：

```ts
// ─── 8. Post-compaction continuation -> source='auto_continue' ───────────

/**
 * Adapts the post-compaction "keep working" directive into a runtime_context
 * message. Mirrors grok's `AutoContinue`: after history is collapsed to a
 * summary, this nudges the model to continue the active task off the summary
 * instead of stopping or re-acknowledging the compaction boundary. Transient
 * (excluded from persistence) and mid-turn (does not start a new turn).
 */
export function adaptAutoContinueContext(
  content: string,
  options: RuntimeContextAdapterOptions = {},
): RuntimeContextMessage {
  const factory = createFactory(options);
  return factory.createRuntimeContextMessage({
    source: 'auto_continue',
    content,
    visibility: options.visibility ?? 'hidden',
    seqIndex: options.seqIndex,
    metadata: options.metadata,
  });
}
```

- [x] **Step 5: 写失败测试（分类 + 持久化排除）**

在 `message-framework.test.ts` 的 `runtimeContextStartsPromptTurn` 用例数组中追加：

```ts
  ])('returns false for mid-turn injection source %s', (source, expected) => {
    expect(runtimeContextStartsPromptTurn(source)).toBe(expected);
  });
```

把 `it.each` 的数组改为包含 `['auto_continue', false]`：

```ts
  it.each<[RuntimeContextSource, boolean]>([
    ['auto_continue', false],
    ['working_directory_switch', false],
    ['todo_gate', false],
    ['mailbox', false],
    ['attachment', false],
    ['memory', false],
    ['mode', false],
    ['system', false],
    ['agents_md', false],
    ['custom', false],
  ])('returns false for mid-turn injection source %s', (source, expected) => {
    expect(runtimeContextStartsPromptTurn(source)).toBe(expected);
  });
```

在 `runtime-context-adapters.test.ts` 的 `describe('runtime context is persisted')` 内新增：

```ts
  it('persists auto_continue as a user-role transient runtime message', () => {
    const ids = deterministicIds('ac');
    const msg = adaptAutoContinueContext('keep working', options(ids.next));

    const persisted = projectPersistenceMessages([msg]);

    expect(persisted).toHaveLength(1);
    expect(persisted[0].role).toBe('user');
    expect(persisted[0].metadata).toMatchObject({
      runtimeContext: true,
      source: 'auto_continue',
    });
  });
```

- [x] **Step 6: 实现分类与持久化排除**

`message-framework.ts` 的 `runtimeContextStartsPromptTurn` 无需改动（`default: false` 已覆盖 `auto_continue`）。

`agent-helpers.ts` 的 `persistableMessages` 排除列表追加 `auto_continue`：

```ts
      if (
        source === 'mailbox' ||
        source === 'background_notification' ||
        source === 'custom' ||
        source === 'todo_gate' ||
        source === 'auto_continue'   // 新增
      ) {
        return false;
      }
```

- [x] **Step 7: 运行测试确认通过**

Run:
```bash
npx vitest run tests/unit/runtime-context-adapters.test.ts tests/unit/message-framework.test.ts
```
Expected: PASS。

- [x] **Step 8: 提交**

```bash
git add packages/agent/src/message/message-framework.ts packages/agent/src/message/runtime-context-adapters.ts packages/agent/src/agent/utils/agent-helpers.ts packages/agent/tests/unit/runtime-context-adapters.test.ts packages/agent/tests/unit/message-framework.test.ts
git commit -m "feat(agent): add auto_continue runtime context for post-compaction continuation"
```

---

### Task 9: 压缩后注入 AutoContinue（agent-loop 接线）

**Files:**
- Modify: `packages/agent/src/agent/utils/agent-helpers.ts`
- Modify: `packages/agent/src/agent/agent-loop.ts:224-244` 与 `:486-508`
- Test: `packages/agent/tests/unit/agent-helpers.test.ts`（若不存在则新建；否则在现有关卡内追加）

在 `agent-loop.ts` 两处压缩成功点（pre-LLM 主动压缩、context-length 错误压缩）之后，向 `state.messages` 注入一条 AutoContinue 指令，让模型在读到摘要后继续工作而非停止。通过共享 helper 保持单一实现。

- [x] **Step 1: 写失败测试（helper）**

在 `agent-helpers.test.ts` 新增 describe（若文件不存在则新建，并在顶部 import `appendAutoContinueMessage`）：

```ts
import { appendAutoContinueMessage } from '../../src/agent/utils/agent-helpers.js';
import type { Message } from '../../src/types.js';

describe('appendAutoContinueMessage', () => {
  it('appends a hidden auto_continue runtime message to the array', () => {
    const messages: Message[] = [
      {
        id: 'u1',
        role: 'user',
        content: 'hello',
        timestamp: 1,
      },
    ];

    appendAutoContinueMessage(messages);

    expect(messages).toHaveLength(2);
    const last = messages[1];
    expect(last.role).toBe('user');
    expect(last.metadata).toMatchObject({
      runtimeContext: true,
      source: 'auto_continue',
    });
    expect(String(last.content)).toContain('continue');
  });
});
```

- [x] **Step 2: 运行测试确认失败**

Run: `npx vitest run tests/unit/agent-helpers.test.ts`
Expected: FAIL with `appendAutoContinueMessage is not defined`。

- [x] **Step 3: 实现 helper**

在 `agent-helpers.ts` 顶部 import 适配器与投影：

```ts
import { adaptAutoContinueContext } from '../../message/runtime-context-adapters.js';
import { projectRuntimeContextToProviderMessage } from '../../message/message-projectors.js';
```

在 `persistableMessages` 之后新增：

```ts
/**
 * Push a transient AutoContinue directive onto the working message array.
 * Called right after a successful compaction so the next LLM call reads the
 * summary and keeps working instead of stopping or re-summarising. Mirrors
 * grok's `AutoContinue`. The message is excluded from persistence by
 * {@link persistableMessages} (source='auto_continue').
 */
export function appendAutoContinueMessage(messages: Message[]): void {
  messages.push(
    projectRuntimeContextToProviderMessage(
      adaptAutoContinueContext(
        'Context compaction completed. Continue working on the active task using the summary context above. Do not stop or summarize — keep making progress toward completing the request.',
      ),
    ),
  );
}
```

- [x] **Step 4: 运行测试确认通过**

Run: `npx vitest run tests/unit/agent-helpers.test.ts`
Expected: PASS。

- [x] **Step 5: 在 agent-loop.ts 两处压缩成功点接线**

在 `agent-loop.ts` 顶部 import `appendAutoContinueMessage`：

```ts
import { appendAutoContinueMessage } from './utils/agent-helpers.js';
```

**接线点 A（pre-LLM 主动压缩，约 `:235`）：**

```ts
        if (compactEntry) {
          logger.info(
            `[Agent] Turn ${state.turnCount}: Compacted with strategy=${compactEntry.strategy}, removed=${compactEntry.tokensBefore} tokens, retained=${compactEntry.tokensAfter ?? 0} tokens`,
          );
          state.messages = await config.convertToLlm(state.messages);
          appendAutoContinueMessage(state.messages);
        }
```

**接线点 B（context-length 错误压缩，约 `:492`）：**

```ts
          if (compactEntry) {
            logger.info(
              `[Agent] Turn ${state.turnCount}: Compaction succeeded, strategy=${compactEntry.strategy}, retained=${compactEntry.tokensAfter ?? 0} tokens`,
            );
            state.messages = await config.convertToLlm(state.messages);
            appendAutoContinueMessage(state.messages);
            executor.discard();
            state.turnCount--; // Retry with the same turn number.
            continue;
          }
```

> 注：`state.messages` 是 LLM 工作数组；`appendAutoContinueMessage` 注入的 transient 消息由 `persistableMessages` 在落库时排除，不会污染 append-only 历史。

- [x] **Step 6: 类型检查**

Run: `npm run -w @duya/agent build`
Expected: PASS。

- [x] **Step 7: 提交**

```bash
git add packages/agent/src/agent/utils/agent-helpers.ts packages/agent/src/agent/agent-loop.ts packages/agent/tests/unit/agent-helpers.test.ts
git commit -m "feat(agent): inject AutoContinue directive after compaction in agent loop"
```

---

## 收尾

### Task 10: 全量校验

- [x] **Step 1: 运行全部消息框架相关测试**

Run:
```bash
npx vitest run tests/unit/runtime-context-adapters.test.ts tests/unit/message-framework.test.ts tests/unit/message-projectors.test.ts tests/unit/agentsmd/loader.test.ts tests/unit/agent-helpers.test.ts
```
Expected: PASS。

- [x] **Step 2: 全量类型检查**

Run: `npm run typecheck:all`
Expected: PASS（esbuild 不查类型，此步必须跑）。

- [x] **Step 3: 更新设计文档状态**

将 `docs/design-docs/2026-08-13-grok-synthetic-reason-and-working-directory-design.md` 顶部 `状态：待办设计` 更新为 `状态：已落地（2026-08-13）`，并在第 5 节三个要点旁标注对应提交。

- [x] **Step 4: 提交**

```bash
git add docs/design-docs/2026-08-13-grok-synthetic-reason-and-working-directory-design.md
git commit -m "docs: mark grok synthetic-reason/working-directory design as landed"
```

---

## 后续待办（不在本计划范围，仅记录）

- 工作目录切换的**端到端接线**：把 `adaptWorkingDirectorySwitch` + 幂等去重接入实际 cwd 切换入口（CLI `/cwd`、会话重定位），实现 grok 的"严格追加 + ack"语义（先持久化成功再认可见效）。当前计划只交付框架层（source/adapter/dedup/投影保留）。
- 若后续需要 `mailbox`/`mode` 也启动新 turn，可扩展 `runtimeContextStartsPromptTurn` 的分类（当前保守地仅 `background_notification` 为 true）。
- AutoContinue 目前**每次压缩成功都注入一条**（无去重）。若连续压缩导致重复 nudge，可像 `working_directory_switch` 一样为其增加幂等键（例如按压缩 entry id 去重）。当前先保持简单，运行后观察是否产生重复提示。