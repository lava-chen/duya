# Grok Task/Todo 工具对齐计划 (2026-08-13)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 Duya 的 `task` 工具（todo 清单管理）改名为 `todo` 并对齐 Grok `todo_write`；将 Duya 的 `subagent` 工具（wire `Agent`）改名为 `task` 并对齐 Grok `task` 工具（spawn/resume + 返回提示词）；补齐 polling 工具（get_task_output/kill_task/wait_tasks）。

**Architecture:** Grok 用 `task` 工具做子代理调度（`subagent_type` 参数），配套 `get_task_output`/`kill_task`/`wait_tasks` 管理工具；用 `todo_write` 工具做进度清单（`todos` 数组 + `merge` 语义 + `summary_for_prompt`）。Duya 目前命名错位：`task` 是 todo 清单、`Agent` 才是子代理。本次对齐做 wire-name 迁移（保留 legacy alias 兼容）+ 返回格式对齐。

**Tech Stack:** TypeScript, `packages/agent/src/tool/`, `BackgroundAgentLifecycle`, `TaskRecord`, task-store (SQLite via IPC).

---

## 现状梳理（已调查）

### 命名错位
| 工具 | wire name | 真实职责 | 对应 Grok |
|---|---|---|---|
| `TaskTool` (`tool/TaskTool/TaskTool.ts`) | `task` | todo 清单管理，但用 action 枚举（create/get/list/update/output/stop）混入子代理输出跟踪，臃肿 | `todo_write`（**重写为精简接口**） |
| `SubagentTool` (`tool/SubagentTool/SubagentTool.ts`) | `Agent` | 子代理 spawn/run_in_background/resume | `task` |
| —（缺失） | — | polling/终止/等待 | `get_task_output`/`kill_task`/`wait_tasks` |

### 关键引用面（改名必须同步更新）
- `tool/builtin.ts:25,131,290` — TaskTool 导入/注册/导出；`:22,121,286-287` — SubagentTool
- `tool/index.ts:30` — TaskTool 导出
- `prompts/types.ts:28,30-31` — `TOOL_NAMES.SUBAGENT='Agent'`, `TASK='Task'`, `TODO_WRITE='TodoWrite'`
- `prompts/general/sections/tools.ts:16,26,52` — `hasTaskTool` / `TOOL_NAMES.TASK`
- `prompts/code/sections/rules.ts:6-26` — `hasTaskTool` / `TOOL_NAMES.TASK`
- `permissions/permissions.ts:75-76` — `'task'`, `'Agent'`
- `permissions/rules.ts:31` — `Task: 'Agent'`
- `agent-profile/types.ts:223,324` — `'task'`, `'Agent'`
- `agent-profile/__tests__/types.test.ts:19,42` — `'Agent'`, `'task'`
- `tool/types.ts:181` — `ToolName` union `'task'`
- `tool/StreamingToolExecutor.ts:319-322,1336-1484` — `isSubagentToolCall` 识别 `'Agent'` / `'task'`
- `tool/SwitchModeTool/modes.ts:26` — `'Agent'`
- `process/worker-protocol.ts:199-224` — `SubagentToolUse*Event`（事件名可保留）
- `modes/research-mode/research-fanout.ts:27,161` — `subagentTool.execute`
- `lifecycle/BackgroundAgentLifecycle.ts` — 子代理生命周期
- `lifecycle/buildTaskNotification.ts` — 异步通知 XML
- `subagentTool/constants.ts:13,17` — `SUBAGENT_TOOL_NAME='Agent'`, `LEGACY_SUBAGENT_TOOL_NAME='Task'`

---

## 兼容策略（关键决策）

wire-name 变更会破坏 session history / 权限规则 / claude-code 对齐契约。参考 Grok `synthetic_reason` 保留旧语义的做法，**保留 legacy alias**：

- `todo` 工具也接受旧 `task` / `Task` wire name 的历史消息（投影时归一化）。
- `task`（原子代理）工具也接受旧 `Agent` wire name 的历史消息。
- 权限规则、profile 工具列表更新为新 wire name，但历史 session 解析时对旧名做 alias 归一化。

归一化实现点：`agent-profile/types.ts` 的工具名集合、`permissions` 校验、`StreamingToolExecutor.isSubagentToolCall`、消息投影(`message-projectors.ts`)处统一做 alias → canonical 映射。

---

## 计划结构

计划拆为 4 个独立可交付的 Phase，每个 Phase 可独立测试、独立提交。

### Phase 1: 重写 TodoTool（丢弃 action 式接口，对齐 Grok `todo_write`）

> **决策**：原 `TaskTool` 用 `action` 枚举（create/get/list/update/output/stop）把**清单管理**和**子代理输出跟踪**两件事混在一个工具里，实现臃肿。Grok 的 `todo_write` 只有一个 `todos[] + merge` 接口，返回 `summary_for_prompt + todos`，简洁得多。本次**彻底重写**：新建精简的 `TodoTool`，删除旧 action 逻辑；原 `output`/`stop`（子代理输出跟踪）职责移交 Phase 2 的 `task` 工具 + Phase 3 的 `get_task_output`/`kill_task`。

**Files:**
- Create: `packages/agent/src/tool/TodoTool/TodoTool.ts`（全新精简实现，非 rename）
- Modify: `packages/agent/src/tool/builtin.ts:25,131,290`（导入/注册/导出 `taskTool` → `todoTool`）
- Modify: `packages/agent/src/tool/index.ts:30`
- Modify: `packages/agent/src/prompts/types.ts:30-31`（`TASK` 保留为 legacy alias，新增 `TODO='todo'`）
- Modify: `packages/agent/src/prompts/general/sections/tools.ts`, `prompts/code/sections/rules.ts`（`hasTaskTool` → `hasTodoTool`）
- Modify: `packages/agent/src/permissions/permissions.ts`, `agent-profile/types.ts`, `tool/types.ts:181`（`'task'` → `'todo'`）
- Delete: `packages/agent/src/tool/TaskTool/TaskTool.ts`
- Test: `packages/agent/src/tool/TodoTool/__tests__/TodoTool.test.ts`

**精简接口**（对齐 Grok `TodoWriteInput` / `TodoWriteOutput`，仅 `id`/`content`/`status` 三字段，无 owner/blocks/blockedBy/metadata/activeForm）：

```typescript
// TodoTool.ts —— 全量替换旧文件
import type { Tool, ToolResult, ToolUseContext } from '../../types.js'
import type { ToolExecutor } from '../registry.js'
import { getDatabaseTaskStore, type TaskStatus } from '../../session/task-store.js'

export const TODO_TOOL_NAME = 'todo'
/** Legacy wire names accepted during projection (normalized to 'todo'). */
export const LEGACY_TODO_WIRE_NAMES = ['task', 'Task'] as const

export interface TodoUpdate {
  id: string
  content?: string
  status?: TaskStatus
}

export interface TodoItem {
  id: string
  content: string
  status: TaskStatus
}

export interface TodoWriteSuccess {
  summary_for_prompt: string
  todos: TodoItem[]
}

export class TodoTool implements Tool, ToolExecutor {
  readonly name = TODO_TOOL_NAME
  readonly description = `Create and manage a structured task list. Use for any task with 3+ steps; skip for trivial single-step work.

- Send the full list up front with merge=false to replace any existing list.
- To update, send only the items you are changing with merge=true (default). To flip a status without changing content, send just id + status.
- Do not use this tool for subagent scheduling — use the \`task\` tool for that.`

  readonly input_schema = {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'Array of todo items to write.',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: 'Unique identifier for the todo item.' },
            content: { type: 'string', description: 'The description/content of the todo item.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'pending, in_progress, or completed.' },
          },
          required: ['id'],
        },
      },
      merge: {
        type: 'boolean',
        description: "When true (default), merge into the existing list by id — send only items you are changing. When false, replace the whole list.",
      },
    },
    required: ['todos'],
  }

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema }
  }

  async execute(input: Record<string, unknown>, _wd?: string, context?: ToolUseContext): Promise<ToolResult> {
    const { todos, merge } = input as { todos: TodoUpdate[]; merge?: boolean }
    const sessionId = context?.options?.sessionId
    if (!sessionId) return err('No session context available')
    if (!Array.isArray(todos)) return err('todos must be an array')
    if (hasDuplicateIds(todos)) return err('Each todo item must have a unique id.')

    const store = getDatabaseTaskStore(sessionId)
    const existing = await store.listTasks()
    // Auto-upgrade to merge when the model forgot merge:true but clearly
    // intended a partial update (all updates target existing ids, no content).
    const effectiveMerge = merge
      ?? (existing.length > 0 && todos.every(t => t.content === undefined && existing.some(e => e.id === t.id)))
    if (effectiveMerge) {
      await applyMerge(store, todos)
    } else {
      await applyReplace(store, todos)
    }
    const all = (await store.listTasks()).filter(t => !t.id.startsWith('_'))
    const items: TodoItem[] = all.map(t => ({ id: t.id, content: t.subject, status: t.status }))
    return ok(this, { summary_for_prompt: summarize(items), todos: items })
  }
}

function hasDuplicateIds(updates: TodoUpdate[]): boolean {
  const seen = new Set<string>()
  return updates.some(u => seen.has(u.id) ? true : (seen.add(u.id), false))
}

async function applyReplace(store, updates: TodoUpdate[]) {
  for (const e of await store.listTasks()) if (!e.id.startsWith('_')) await store.deleteTask(e.id)
  for (const u of updates) {
    await store.createTask({
      subject: u.content || u.id, description: '',
      status: u.status || 'pending', blocks: [], blockedBy: [],
    })
  }
}

async function applyMerge(store, updates: TodoUpdate[]) {
  for (const u of updates) {
    const cur = await store.getTask(u.id)
    if (cur) {
      await store.updateTask(u.id, {
        ...(u.content ? { subject: u.content } : {}),
        ...(u.status ? { status: u.status } : {}),
      })
    } else {
      await store.createTask({
        subject: u.content || u.id, description: '',
        status: u.status || 'pending', blocks: [], blockedBy: [],
      })
    }
  }
}

function summarize(items: TodoItem[]): string {
  if (items.length === 0) return 'No tasks currently tracked.'
  return items.map(t => `- [${t.status}] ${t.id}: ${t.content}`).join('\n')
}
```

> **持久化说明**：Grok 把 todo 存在内存 `State<TodoState>`；Duya 复用现有 DB `task-store`（`task-store.ts`）实现跨轮持久化，保持 `todo_gate` 续接机制和 renderer 不变。工具表面只暴露 `merge/todos`，隐藏 store 的复杂度。

- [ ] **Step 1**: 新建 `TodoTool/TodoTool.ts`（全新精简实现，删除旧 action 逻辑；复用 `getDatabaseTaskStore` 的 `createTask/updateTask/deleteTask/listTasks`）。
- [ ] **Step 2**: 写 `TodoTool/__tests__/TodoTool.test.ts`（mock task-store）。用 `vi.hoisted` 共享 mock 状态（见 AGENTS.md IPC 测试模式）：测 replace 建表、merge 更新已有项（只发 status 不丢 content）、merge 新增项、duplicate-id 拒绝、空 list 返回 `"No tasks currently tracked."`、`summary_for_prompt` 格式。
- [ ] **Step 3**: 删除 `tool/TaskTool/TaskTool.ts`；更新 `builtin.ts`（导入/注册/导出 `todoTool`）、`index.ts`、`prompts/types.ts`（新增 `TODO='todo'`，`TASK` 留作 legacy）、tools/rules sections、permissions、agent-profile、`tool/types.ts` 的 `'task'`→`'todo'` 引用。
- [ ] **Step 4**: 在 `message-projectors.ts` 投影时把 legacy wire `task`/`Task` 归一化为 `todo`（`LEGACY_TODO_WIRE_NAMES`）。
- [ ] **Step 5**: `npm run -w @duya/agent build` + `npx vitest run TodoTool` + `npm run typecheck:all`。
- [ ] **Step 6**: Commit `refactor(agent): rewrite todo tool to align Grok todo_write (drop action interface)`.

---

### Phase 2: SubagentTool → TaskTool（wire `Agent` → `task`，对齐 Grok `task`）

**Files:**
- Modify: `packages/agent/src/tool/SubagentTool/constants.ts`（`SUBAGENT_TOOL_NAME` → `'task'`，保留 `LEGACY_SUBAGENT_TOOL_NAME='Agent'`）
- Modify: `packages/agent/src/tool/SubagentTool/SubagentTool.ts`（name 用新常量；输入 schema 增加 `resume_from`、`auto_wake`；返回对齐 Grok）
- Modify: `packages/agent/src/prompts/types.ts:28`（`SUBAGENT` → `'task'`）
- Modify: `packages/agent/src/permissions/rules.ts:31`, `permissions.ts:76`, `SwitchModeTool/modes.ts:26`, `agent-profile/types.ts`
- Modify: `packages/agent/src/tool/StreamingToolExecutor.ts:322`（`isSubagentToolCall` 识别 `'task'` + legacy `'Agent'`）
- Test: `packages/agent/src/tool/SubagentTool/__tests__/`

**对齐 Grok `task` 输入**（对齐 Grok `TaskToolInput`）：

```typescript
export interface SubagentToolInput {
  prompt: string
  description?: string
  subagent_type?: string
  run_in_background?: boolean
  auto_wake?: boolean
  resume_from?: string  // subagent_id to resume
  isolation?: 'worktree'
  model?: string
}
```

- [ ] **Step 1**: 更新 `SubagentTool/constants.ts`：`SUBAGENT_TOOL_NAME='task'`, `LEGACY_SUBAGENT_TOOL_NAME='Agent'`。
- [ ] **Step 2**: `SubagentTool.ts` 的 `name` 使用新常量；`input_schema` 增加 `auto_wake`/`resume_from`；`isSubagentToolCall` 同步。
- [ ] **Step 3**: 更新 prompts/types、permissions、SwitchMode、agent-profile、StreamingToolExecutor 的 `'Agent'`→`'task'`（保留 legacy alias 归一化）。
- [ ] **Step 4**: 写/更新测试：断言 wire name 为 `task`、legacy `Agent` 仍可解析。
- [ ] **Step 5**: `npm run -w @duya/agent build` + 相关 vitest + `npm run typecheck:all`。
- [ ] **Step 6**: Commit `refactor(agent): rename subagent wire Agent to task, align Grok task tool`.

---

### Phase 3: 新增 polling 工具 `get_task_output` / `kill_task` / `wait_tasks`

> **Grok 真实设计（已核对 `grok_build/task_output`、`grok_build/kill_task`、`grok_build/task_output/wait_tasks.rs`）**：
> - `get_task_output` 是**统一入口**：入参 `task_ids[]` + `timeout_ms`（**0/省略 = 立即快照，>0 = 阻塞等待全部完成**）。一次调用同时覆盖"取结果"和"等结果"两种诉求。
> - `wait_tasks` 只是**瘦别名**：内部转调 get_task_output 的 wait-all 路径，仅保留给老 prompt 仍发 `wait_tasks`/`wait_commands_or_subagents` 的场景。`mode: wait_any` 仅老路径支持，新代码不做。
> - `kill_task` 返回**类型化 outcome**：`killed` / `already_exited` / `not_found`；bash 任务找不到时**回退取消 subagent**（统一 kill）；not-found 消息会**枚举已知 task_id** 便于 LLM 纠错。
> - 三个工具的**读写域**：`get_task_output`/`wait_tasks` 是 `is_read_only: true`（tool_scope Read）；`kill_task` 是 Write。
> - 输出有**截断预算**（`DEFAULT_TOOL_OUTPUT_BYTES`），多 id 有 `MAX_MULTI_WAIT_IDS` 上限（超限报错）。
> - **等待上限与自动通知耦合**：`DEFAULT_WAIT_TIMEOUT`=30s，`max_wait_block()`=10min 硬上限（`capped_wait_timeout` 钳制，保证单次等待不卡死 turn）。**关键行为**：wait-all 超时仍 running 时，返回追加 `"You will be notified automatically when the task completes."`——告诉模型任务完成后会走 Phase 4 的异步完成通知，**无需继续轮询**。这把 polling 工具和异步通知绑在一起，是 Duya 原实现缺失的闭环。

**Files:**
- Create: `packages/agent/src/tool/BackgroundTaskTool/GetTaskOutputTool.ts`
- Create: `packages/agent/src/tool/BackgroundTaskTool/KillTaskTool.ts`
- Create: `packages/agent/src/tool/BackgroundTaskTool/WaitTasksTool.ts`
- Create: `packages/agent/src/tool/BackgroundTaskTool/index.ts`
- Modify: `packages/agent/src/tool/builtin.ts`（注册三个工具；`get_task_output`/`wait_tasks` 标 read-only，`kill_task` 标 write）
- Modify: `packages/agent/src/tool/types.ts:181`（`ToolName` 增加 `get_task_output`/`kill_task`/`wait_tasks`）
- Modify: `packages/agent/src/permissions/permissions.ts`, `agent-profile/types.ts`
- Test: `packages/agent/src/tool/BackgroundTaskTool/__tests__/`

**数据源**：`getBackgroundAgentLifecycle()`（`lifecycle/BackgroundAgentLifecycle.ts`）提供 `getSnapshot(taskId): TaskRecord|undefined` 和 `kill(taskId, reason)`。**schema 层用 Grok 的 `task_id`（snake_case），内部映射到 `TaskRecord.taskId`（camelCase）。**

```typescript
// GetTaskOutputTool.ts —— 统一入口（快照 + wait-all）
export const GET_TASK_OUTPUT_TOOL_NAME = 'get_task_output'
export const DEFAULT_WAIT_TIMEOUT_MS = 60_000
export const MAX_MULTI_WAIT_IDS = 10
export const DEFAULT_TOOL_OUTPUT_BYTES = 40_000

export class GetTaskOutputTool implements Tool, ToolExecutor {
  readonly name = GET_TASK_OUTPUT_TOOL_NAME
  readonly input_schema = {
    type: 'object',
    properties: {
      task_ids: { type: 'array', items: { type: 'string' }, description: 'One or more subagent task ids.' },
      timeout_ms: { type: 'integer', description: '0 or omitted = snapshot now; >0 = block up to N ms waiting for all to finish.' },
    },
    required: ['task_ids'],
  }
  async execute(input, _wd, ctx) {
    const { task_ids, timeout_ms } = input as { task_ids: string[]; timeout_ms?: number }
    if (!Array.isArray(task_ids) || task_ids.length === 0) return err('task_ids must be a non-empty array.')
    if (task_ids.length > MAX_MULTI_WAIT_IDS) return err(`task_ids exceeds maximum of ${MAX_MULTI_WAIT_IDS} entries.`)
    const lifecycle = getBackgroundAgentLifecycle()
    const waitMs = (timeout_ms ?? 0) > 0 ? (timeout_ms as number) : 0
    const results = await Promise.all(task_ids.map(async (id) => {
      const started = Date.now()
      let rec = lifecycle.getSnapshot(id)
      while (waitMs > 0 && rec && !isTerminal(rec.status) && Date.now() - started < waitMs) {
        await sleep(250)
        rec = lifecycle.getSnapshot(id)
      }
      if (!rec) return { task_id: id, status: 'not_found', output: '' }
      return { task_id: id, status: rec.status, output: formatOutput(rec, waitMs > 0) }
    }))
    const completed = results.filter(r => clipStatus(r.status)).length
    return ok(this, { mode: waitMs > 0 ? 'wait_all' : 'snapshot', results, summary: `${completed}/${results.length} tasks completed` })
  }
}

function isTerminal(s: TaskStatus): boolean {
  return s === 'completed' || s === 'failed' || s === 'killed'
}
// formatOutput: 完成时取 rec.result.content 拼接；wait-all 因占用上下文，超 DEFAULT_TOOL_OUTPUT_BYTES 时截断并追加 '...<truncated>'
```

```typescript
// KillTaskTool.ts —— 类型化 outcome + 可发现性
export const KILL_TASK_TOOL_NAME = 'kill_task'
export class KillTaskTool implements Tool, ToolExecutor {
  readonly name = KILL_TASK_TOOL_NAME
  readonly input_schema = { type: 'object', properties: { task_id: { type: 'string' } }, required: ['task_id'] }
  async execute(input, _wd, ctx) {
    const { task_id } = input as { task_id: string }
    const lifecycle = getBackgroundAgentLifecycle()
    const rec = lifecycle.getSnapshot(task_id)
    if (!rec) {
      const known = lifecycle.listTaskIds()
      const hint = known.length
        ? `Known task ids: [${known.join(', ')}].`
        : 'No background subagents exist in this session.'
      return ok(this, { task_id, outcome: 'not_found', message: `Task or subagent ${task_id} not found. ${hint}` })
    }
    if (isTerminal(rec.status)) {
      return ok(this, { task_id, outcome: 'already_exited', message: `Task had already ${rec.status}` })
    }
    lifecycle.kill(task_id, 'user_kill')
    return ok(this, { task_id, outcome: 'killed', message: 'Task was terminated successfully' })
  }
}
```

```typescript
// WaitTasksTool.ts —— 瘦别名
export const WAIT_TASKS_TOOL_NAME = 'wait_tasks'
export class WaitTasksTool implements Tool, ToolExecutor {
  readonly name = WAIT_TASKS_TOOL_NAME
  // input_schema = { task_ids: string[], timeout_ms?: number }
  // execute: 直接委托 GetTaskOutputTool 的 wait-all（task_ids, timeout_ms 默认 DEFAULT_WAIT_TIMEOUT_MS）
}
```

- [ ] **Step 1**: 实现 `GetTaskOutputTool.ts`（快照 + wait-all 双模式；`task_ids[]` + `timeout_ms`；`MAX_MULTI_WAIT_IDS` 上限；输出截断 `DEFAULT_TOOL_OUTPUT_BYTES`；返回 `{ mode, results, summary }`）。
- [ ] **Step 2**: 实现 `KillTaskTool.ts`（类型化 outcome `killed`/`already_exited`/`not_found`；not-found 枚举已知 `task_id`；终态返回 `already_exited`）。
- [ ] **Step 3**: 实现 `WaitTasksTool.ts`（瘦别名，委托 GetTaskOutputTool 的 wait-all，不重复实现）。
- [ ] **Step 4**: `index.ts` 汇总导出；`builtin.ts` 注册三个工具（`get_task_output`/`wait_tasks` 标 read-only，`kill_task` 标 write）。
- [ ] **Step 5**: 更新 `tool/types.ts`、permissions、agent-profile 工具清单。
- [ ] **Step 6**: 写测试（mock lifecycle）：快照取回完整输出、未完成返回非终态、wait-all 阻塞到终态、超时返回、`task_id` not-found 枚举、kill 的三种 outcome、`task_ids` 超限报错。
- [ ] **Step 7**: `npm run -w @duya/agent build` + vitest + `npm run typecheck:all`。
- [ ] **Step 8**: Commit `feat(agent): add get_task_output, kill_task, wait_tasks polling tools aligned to Grok`.

---

### Phase 4: 返回提示词对齐（同步 + 异步）

**Files:**
- Modify: `packages/agent/src/tool/SubagentTool/SubagentTool.ts`（`renderToolResultMessage` 同步返回）
- Modify: `packages/agent/src/lifecycle/buildTaskNotification.ts`（异步通知指针）
- Modify: `packages/agent/src/constants/taskNotificationXml.ts`（新标签）
- Modify: `packages/agent/src/agent/utils/agent-helpers.ts`（`lastRealUserQuery` 等）
- Test: `packages/agent/src/lifecycle/__tests__/buildTaskNotification.test.ts`

**同步返回对齐 Grok `to_model_text()`** — 完整内联 output + meta + resume footer：

```typescript
// renderToolResultMessage 成功分支 —— 对齐 Grok SubagentCompletedOutput.to_model_text()
const agentType = parsed.resolvedAgentType || parsed.agentType || 'task'
const description = parsed.description || ''
const content = parsed.content || ''
const sessionId = parsed.sessionId || ''
const meta = `<subagent_meta>id=${sessionId}, type=${agentType}, turns=1<${''}/subagent_meta>`
const footer = `<subagent_result>\nsubagent_id: ${sessionId}\nsubagent_type: ${agentType}\nTo continue this subagent's conversation, use resume_from="${sessionId}"\n<${''}/subagent_result>`
const output = `${content}\n\n${meta}\n\n${footer}`
return { type: 'markdown', content: output, metadata: { ...result.metadata, agentType, sessionId, lineCount: content.split('\n').length } }
```

**异步通知对齐 Grok `format_subagent_completion`** — 用 `get_task_output` 指针替代 `<output-file>`+Read：

```typescript
// buildResultXml 超限分支 —— 对齐 Grok 指针
const pointer = `Background subagent completed. Use ${GET_TASK_OUTPUT_TOOL_NAME}("${input.taskId}") to see the full output.`
return `<result>${escape(pointer)}</result>`
```

- [x] **Step 1**: 更新 `renderToolResultMessage` 为 Grok 完整格式（完整内联，不再截断成 preview）。
- [x] **Step 2**: 更新 `buildTaskNotificationXml` 的 `buildResultXml` 超限指针为 `get_task_output` 指针。
- [x] **Step 3**: 更新 `buildTaskNotification.test.ts` 断言新格式。
- [x] **Step 4**: `npm run -w @duya/agent build` + vitest + `npm run typecheck:all`。
- [ ] **Step 5**: Commit `feat(agent): align subagent return prompt to Grok (sync inline + async get_task_output pointer)`.

---

## 测试与验证

- 每 Phase 结束跑对应 vitest + `npm run -w @duya/agent build`。
- 全部完成后 `npm run typecheck:all`（esbuild 不做类型检查，必须跑）。
- UI 变更若涉及：用 Playwright MCP 验证（本计划无 UI 变更，仅当改名影响前端引用时补验）。

## Self-Review

- **Spec 覆盖**：Phase 1 重写 todo 工具（丢弃 action 接口，对齐 Grok `todo_write`）；Phase 2 覆盖 subagent→task；Phase 3 覆盖 polling 工具；Phase 4 覆盖返回提示词。4 项诉求全覆盖。
- **简洁性**：TodoTool 仅 `todos[] + merge` 一个接口，返回 `summary_for_prompt + todos`，剔除 owner/blocks/blockedBy/metadata/activeForm/action；原 `output`/`stop` 职责移交 `get_task_output`/`kill_task`。
- **Grok 对齐深度（Phase 3）**：`get_task_output` 统一"快照 + wait-all"双模式（`timeout_ms`），`wait_tasks` 瘦别名委托；`kill_task` 类型化 outcome + not-found 枚举已知 id；读写域划分；`MAX_MULTI_WAIT_IDS`/`DEFAULT_TOOL_OUTPUT_BYTES`/`max_wait_block` 上限；wait 超时追加"将自动通知"提示，与 Phase 4 异步完成通知闭环。
- **Placeholder 扫描**：无 TBD/TODO 占位；每步含代码或明确动作。
- **类型一致性**：`TODO_TOOL_NAME`/`SUBAGENT_TOOL_NAME`/`GET_TASK_OUTPUT_TOOL_NAME` 等常量命名统一，跨 Phase 引用一致。

---

## 2026-09-02 修订：`wait_tasks` 与 wait 语义回退（决策记录）

**结论**：Phase 3 原样对齐 grok_build（旧版 Rust）引入的 `wait_tasks` 瘦别名 + `get_task_output` 的 `timeout_ms>0` 阻塞 wait-all 模式，在 auto_wake + `<task-notification>` 异步完成通知已闭环的 harness 下是**负资产**，予以回退。

**依据**（对照 grok-bot 0.18 harness，非 grok_build 旧版）：

- Grok 0.18 已不存在 `get_task_output`/`wait_tasks`/`kill_task` 家族，管理工具演进为 `CheckSubagent`/`MessageSubagent`/`StopSubagent`——语义是"查卡住/纠正/终止"，**没有"等完成"**；子代理完成只走 end-of-turn 自动唤醒（`you're revived automatically when a subagent finishes`）。
- Grok 的 `Await` 工具对 subagent 只允许 `block_until_ms: 0` 状态检查，schema 带 `waiting_for_subagent` 标志——设为 true 直接报错 "You should NOT wait for subagents to complete. End your turn instead; completions are queued, or do parallel work."（`tools/core/await.ts`）。
- 系统提示词层：multitask mode reminder 明确 "After starting a background subagent… you MUST end your response IMMEDIATELY… DO NOT WAIT FOR THE ASYNC SUBAGENT TO COMPLETE!"（`prompts/multitask-mode-user-reminder.ts`）。

**duya 差距与本次改动**：

1. 主提示词（`prompts/general/sections/tasks.ts`、`prompts/code/sections/rules.ts`）此前零规则 → 补系统级"后台任务自动通知、禁止 sleep/轮询/等待"条款（此前 anti-wait 只散落在工具描述与 spawn 返回文本，显著性不足且与 wait 工具描述自相矛盾）。
2. 删除 `WaitTasksTool.ts` 与 `wait_tasks` 注册/导出（`builtin.ts`/`BackgroundTaskTool/index.ts`/`SubagentTool/subagentToolUtils.ts`），wire name 不再暴露。
3. `GetTaskOutputTool` 移除 `timeout_ms` 与 wait-all 阻塞分支，降级为非阻塞快照（completed 内联输出、running 提示勿轮询、not_found 保持），语义对齐 CheckSubagent；常量 `MAX_MULTI_WAIT_IDS` → `MAX_MULTI_TASK_IDS`，删除 `DEFAULT_WAIT_TIMEOUT_MS`/`MAX_WAIT_BLOCK_MS`。
4. `kill_task` 保留（对齐 StopSubagent）。

**验证**：`GetTaskOutputTool.test.ts`（5 例：schema 无 timeout_ms/非阻塞/终态内联/not_found/id 上限）；`BackgroundAgentLifecycle`/`buildTaskNotification` 等 50 例回归绿；`npm run typecheck:all` 通过。