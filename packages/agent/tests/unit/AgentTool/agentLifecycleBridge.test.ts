import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  applyProgressEvent,
  extractResultFromLastMessage,
  buildChatAgentProgressPayload,
  type AgentProgressPayloadMeta,
} from '../../../src/tool/AgentTool/agentLifecycleBridge.js'
import { BackgroundAgentLifecycle } from '../../../src/lifecycle/BackgroundAgentLifecycle.js'
import type { AgentProgressEvent } from '../../../src/tool/AgentTool/runAgent.js'
import type { TaskRecord } from '../../../src/lifecycle/TaskState.js'
import * as fs from 'node:fs/promises'

let lc: BackgroundAgentLifecycle
let record: TaskRecord
beforeEach(() => {
  lc = new BackgroundAgentLifecycle()
  record = lc.register({
    taskId: 't-1',
    parentSessionId: 'p',
    subAgentSessionId: 's',
    agentType: 'Explore',
    agentName: 'Explore',
    description: 'd',
    abortController: new AbortController(),
  })
})

describe('applyProgressEvent', () => {
  it('forwards every event to onProgress', async () => {
    const cb = vi.fn()
    const ev: AgentProgressEvent = { type: 'text', data: 'hi', agentId: 't-1' }
    await applyProgressEvent({ record, onProgress: cb }, ev)
    expect(cb).toHaveBeenCalledWith(ev)
  })

  it('tool_use updates progress snapshot', async () => {
    const ev: AgentProgressEvent = { type: 'tool_use', toolName: 'Read', toolInput: { description: 'foo.ts' }, agentId: 't-1' }
    await applyProgressEvent({ record }, ev)
    expect(record.progress.toolUseCount).toBe(1)
    expect(record.progress.lastActivity?.tool).toBe('Read')
    expect(record.progress.lastActivity?.description).toBe('foo.ts')
  })

  it('appends to output file (best-effort)', async () => {
    const ev: AgentProgressEvent = { type: 'text', data: 'hi', agentId: 't-1' }
    await applyProgressEvent({ record }, ev)
    const content = await fs.readFile(record.outputFilePath, 'utf8')
    expect(content).toContain('"type":"text"')
  })

  it('does not throw if OutputFileWriter.append fails', async () => {
    // Force a write failure by making the path read-only
    await fs.chmod(record.outputFilePath, 0o444)
    const ev: AgentProgressEvent = { type: 'text', data: 'x', agentId: 't-1' }
    await expect(applyProgressEvent({ record }, ev)).resolves.toBeUndefined()
    await fs.chmod(record.outputFilePath, 0o644) // restore for cleanup
  })
})

describe('extractResultFromLastMessage', () => {
  it('returns the "no output" message when lastMessage is undefined', () => {
    const r = extractResultFromLastMessage(undefined)
    expect(r.content[0].text).toMatch(/no output/)
  })

  it('extracts text content from an array message', () => {
    const r = extractResultFromLastMessage({
      role: 'assistant',
      content: [
        { type: 'text', text: 'hello' },
        { type: 'tool_use', id: 'x', name: 'Bash', input: {} },
        { type: 'text', text: 'world' },
      ],
    } as never)
    expect(r.content).toEqual([{ type: 'text', text: 'hello' }, { type: 'text', text: 'world' }])
  })

  it('reads totalDurationMs and totalToolUseCount from metadata', () => {
    const r = extractResultFromLastMessage({
      role: 'assistant',
      content: 'ok',
      metadata: { agentDurationMs: 1234, agentToolCallCount: 7 },
    } as never)
    expect(r.totalDurationMs).toBe(1234)
    expect(r.totalToolUseCount).toBe(7)
  })
})

/**
 * Regression coverage for the multi-agent fan-out bug that left the UI
 * stuck on "initializing agent":
 *
 *   - the wire format MUST place the sub-agent's session in
 *     `agentSessionId` (NOT in the top-level `sessionId`, which is the
 *     parent session — that field is used by the renderer to route
 *     `agent_progress` events to the right chat session)
 *   - the event type MUST be encoded as `agentEventType` (not as the
 *     SSE envelope's `type` field, which is reserved for the wrapper
 *     message type and is set to `chat:agent_progress` by the worker)
 *   - optional fields (data, toolName, duration, error, …) are only
 *     included when defined, so the renderer can rely on `in` checks
 *     rather than nullish-fallback logic
 *
 * If any of these drift, the renderer's `handleAgentProgressEvent`
 * remap will silently produce empty agent progress arrays and the
 * user will see the "initializing agent" card forever.
 */
describe('buildChatAgentProgressPayload', () => {
  const baseMeta: AgentProgressPayloadMeta = {
    parentSessionId: 'parent-1',
    subAgentSessionId: 'sub-1',
    agentId: 'task-42',
    agentType: 'Explore',
    agentName: 'Explore repo',
    agentDescription: 'Reads the repo structure',
  }

  it('wraps text events with the chat:agent_progress envelope', () => {
    const out = buildChatAgentProgressPayload({ type: 'text', data: 'hello', agentId: 'task-42' }, baseMeta)
    expect(out.type).toBe('chat:agent_progress')
    expect(out.sessionId).toBe('parent-1')
    expect(out.agentSessionId).toBe('sub-1')
    expect(out.agentId).toBe('task-42')
    expect(out.agentType).toBe('Explore')
    expect(out.agentName).toBe('Explore repo')
    expect(out.agentDescription).toBe('Reads the repo structure')
    expect(out.agentEventType).toBe('text')
    expect(out.data).toBe('hello')
  })

  it('forwards tool_use metadata (name, input) but drops it for text events', () => {
    const tool = buildChatAgentProgressPayload(
      { type: 'tool_use', toolName: 'Read', toolInput: { path: '/a/b.ts' }, agentId: 'task-42' },
      baseMeta,
    )
    expect(tool.agentEventType).toBe('tool_use')
    expect(tool.toolName).toBe('Read')
    expect(tool.toolInput).toEqual({ path: '/a/b.ts' })
    expect('data' in tool).toBe(false)
  })

  it('passes the duration and data fields through for terminal events', () => {
    const done = buildChatAgentProgressPayload(
      { type: 'done', duration: 1234, agentId: 'task-42' },
      baseMeta,
    )
    expect(done.agentEventType).toBe('done')
    expect(done.duration).toBe(1234)
    expect('data' in done).toBe(false)
  })

  it('includes the error message in the data field for error events', () => {
    // runAgent emits error events as { type: 'error', data: <message>, agentId }
    // — the message is carried in `data`, not a separate `error` field.
    const err = buildChatAgentProgressPayload(
      { type: 'error', data: 'boom', agentId: 'task-42' },
      baseMeta,
    )
    expect(err.agentEventType).toBe('error')
    expect(err.data).toBe('boom')
  })

  it('falls back to meta.agentId when the event has no agentId', () => {
    const out = buildChatAgentProgressPayload({ type: 'started' }, baseMeta)
    expect(out.agentId).toBe('task-42')
    expect(out.agentEventType).toBe('started')
  })

  it('uses the parent session id for the top-level sessionId (not the sub-agent id)', () => {
    // CRITICAL: this is the field the renderer uses to route the event
    // to the right chat session. Getting it wrong means the event is
    // dropped on the floor.
    const out = buildChatAgentProgressPayload({ type: 'started' }, baseMeta)
    expect(out.sessionId).toBe('parent-1')
    expect(out.sessionId).not.toBe(out.agentSessionId)
  })
})