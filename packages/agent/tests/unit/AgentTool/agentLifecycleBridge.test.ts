import { describe, it, expect, beforeEach, vi } from 'vitest'
import { applyProgressEvent, extractResultFromLastMessage } from '../../../src/tool/AgentTool/agentLifecycleBridge.js'
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