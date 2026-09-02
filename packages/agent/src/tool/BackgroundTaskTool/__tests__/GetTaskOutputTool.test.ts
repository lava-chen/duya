/**
 * GetTaskOutputTool — snapshot-only semantics.
 *
 * Regression guard against the removed blocking behavior: the tool must
 * never wait/poll on a running task (completion arrives via async
 * <task-notification>), so these tests assert non-blocking snapshots,
 * terminal-output inlining, and the id cap.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { GetTaskOutputTool, MAX_MULTI_TASK_IDS, GET_TASK_OUTPUT_TOOL_NAME } from '../GetTaskOutputTool.js'
import { getBackgroundAgentLifecycle, type BackgroundAgentLifecycle } from '../../../lifecycle/BackgroundAgentLifecycle.js'
import type { ToolResult } from '../../../types.js'

// Route the lifecycle singleton through a per-test instance so each case
// starts with an empty task map (register rejects duplicate ids).
const state = vi.hoisted(() => ({ lc: null as BackgroundAgentLifecycle | null, Lifecycle: null as unknown }))
vi.mock('../../../lifecycle/BackgroundAgentLifecycle.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../lifecycle/BackgroundAgentLifecycle.js')>()
  state.Lifecycle = actual.BackgroundAgentLifecycle
  state.lc = new actual.BackgroundAgentLifecycle()
  return {
    ...actual,
    getBackgroundAgentLifecycle: () => state.lc,
  }
})

function makeInput(overrides: Partial<Parameters<BackgroundAgentLifecycle['register']>[0]> = {}) {
  return {
    taskId: 't-1',
    parentSessionId: 'parent',
    subAgentSessionId: 'sub',
    agentType: 'Explore',
    agentName: 'Explorer',
    description: 'desc',
    abortController: new AbortController(),
    ...overrides,
  }
}

function registerRunning(taskId: string) {
  const lc = getBackgroundAgentLifecycle()!
  lc.register(makeInput({ taskId }))
  // pending -> running (as BackgroundAgentLifecycle.run() would do)
  const snap = lc.getSnapshot(taskId)!
  snap.status = 'running'
  return lc
}

function parseResult(result: ToolResult): { mode: string; summary: string; results: Array<{ task_id: string; status: string; output: string }> } {
  return JSON.parse(result.result)
}

describe('GetTaskOutputTool', () => {
  const tool = new GetTaskOutputTool()

  beforeEach(() => {
    // Reset to a fresh lifecycle instance per test.
    state.lc = new (state.Lifecycle as new () => BackgroundAgentLifecycle)()
  })

  it('exposes the expected wire name and a snapshot-only input schema (no timeout_ms)', () => {
    expect(tool.name).toBe(GET_TASK_OUTPUT_TOOL_NAME)
    const schema = tool.input_schema as { properties: Record<string, unknown> }
    expect(schema.properties.task_ids).toBeDefined()
    expect(schema.properties.timeout_ms).toBeUndefined()
    expect(tool.description).toMatch(/NEVER waits|never waits|never blocks/i)
  })

  it('returns not_found for unknown ids without throwing', async () => {
    const result = parseResult(await tool.execute({ task_ids: ['nope'] }))
    expect(result.mode).toBe('snapshot')
    expect(result.results[0]).toMatchObject({ task_id: 'nope', status: 'not_found' })
  })

  it('is non-blocking on a running task and tells the model not to poll', async () => {
    registerRunning('t-1')
    const started = Date.now()
    const result = parseResult(await tool.execute({ task_ids: ['t-1'] }))
    expect(Date.now() - started).toBeLessThan(100) // no sleep/wait loop
    expect(result.mode).toBe('snapshot')
    expect(result.results[0].status).toBe('running')
    expect(result.results[0].output).toMatch(/will be notified automatically|do not poll/i)
  })

  it('inlines terminal output for a completed task', async () => {
    const lc = registerRunning('t-1')
    lc.complete('t-1', { content: [{ type: 'text', text: 'all done' }], totalDurationMs: 5, totalToolUseCount: 0 })
    const result = parseResult(await tool.execute({ task_ids: ['t-1'] }))
    expect(result.results[0].status).toBe('completed')
    expect(result.results[0].output).toContain('all done')
    expect(result.summary).toContain('1/1')
  })

  it('rejects an empty or oversized task_ids list', async () => {
    const empty = await tool.execute({ task_ids: [] })
    expect(empty.error).toBe(true)
    const big = await tool.execute({ task_ids: Array.from({ length: MAX_MULTI_TASK_IDS + 1 }, (_, i) => `t-${i}`) })
    expect(big.error).toBe(true)
    expect(big.result).toMatch(/exceeds maximum/)
  })
})
