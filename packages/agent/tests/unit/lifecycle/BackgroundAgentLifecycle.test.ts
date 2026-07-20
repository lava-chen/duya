import { describe, it, expect, beforeEach } from 'vitest'
import { BackgroundAgentLifecycle } from '../../../src/lifecycle/BackgroundAgentLifecycle.js'
import type { TaskRecord } from '../../../src/lifecycle/TaskState.js'
import type { AgentProgressEvent } from '../../../src/tool/AgentTool/runAgent.js'
import type { Message } from '../../../src/types.js'

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

describe('BackgroundAgentLifecycle', () => {
  let lc: BackgroundAgentLifecycle
  beforeEach(() => { lc = new BackgroundAgentLifecycle() })

  it('register creates a pending record and allocates outputFilePath', () => {
    const r = lc.register(makeInput())
    expect(r.status).toBe('pending')
    expect(r.outputFilePath).toMatch(/t-1\.jsonl$/)
    expect(r.subscribers.size).toBe(0)
  })

  it('register rejects duplicate taskId', () => {
    lc.register(makeInput())
    expect(() => lc.register(makeInput())).toThrow(/duplicate/)
  })

  it('completes via pending -> running (manual) -> completed', () => {
    lc.register(makeInput())
    const snap = lc.getSnapshot('t-1')!
    snap.status = 'running' // simulate transition done by run() in Phase 3
    lc.complete('t-1', { content: [{ type: 'text', text: 'ok' }], totalDurationMs: 100, totalToolUseCount: 0 })
    expect(lc.getSnapshot('t-1')!.status).toBe('completed')
    expect(lc.getSnapshot('t-1')!.result?.content[0].text).toBe('ok')
  })

  it('rejects illegal transition pending -> completed', () => {
    lc.register(makeInput())
    expect(() => lc.complete('t-1', { content: [], totalDurationMs: 0, totalToolUseCount: 0 }))
      .toThrow(/illegal transition pending -> completed/)
  })

  it('fail and kill set error field', () => {
    lc.register(makeInput())
    const snap = lc.getSnapshot('t-1')!
    snap.status = 'running'
    lc.fail('t-1', 'API timeout')
    expect(lc.getSnapshot('t-1')!.status).toBe('failed')
    expect(lc.getSnapshot('t-1')!.error).toBe('API timeout')

    const lc2 = new BackgroundAgentLifecycle()
    lc2.register(makeInput({ taskId: 't-2' }))
    lc2.getSnapshot('t-2')!.status = 'running'
    lc2.kill('t-2', 'user_kill')
    expect(lc2.getSnapshot('t-2')!.status).toBe('killed')
    expect(lc2.getSnapshot('t-2')!.error).toBe('killed: user_kill')
  })
})

describe('BackgroundAgentLifecycle.getCompleted + markDrained', () => {
  it('returns terminal tasks and markDrained prevents re-delivery', () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput({ taskId: 'a' }))
    lc.register(makeInput({ taskId: 'b' }))
    lc.getSnapshot('a')!.status = 'running'
    lc.getSnapshot('b')!.status = 'running'
    lc.complete('a', { content: [], totalDurationMs: 0, totalToolUseCount: 0 })
    lc.fail('b', 'oops')

    const first = lc.getCompleted().map((r) => r.taskId).sort()
    expect(first).toEqual(['a', 'b'])

    lc.markDrained(first)
    const second = lc.getCompleted().map((r) => r.taskId)
    expect(second).toEqual([])
  })

  it('does NOT return pending or running tasks', () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput({ taskId: 'a' }))
    lc.getSnapshot('a')!.status = 'running'
    expect(lc.getCompleted()).toEqual([])
  })
})

describe('BackgroundAgentLifecycle.subscribe', () => {
  it('subscriber fires on every terminal transition', () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput())
    const received: string[] = []
    const unsub = lc.subscribe('t-1', (snap) => received.push(snap.status))
    lc.getSnapshot('t-1')!.status = 'running'
    lc.complete('t-1', { content: [], totalDurationMs: 0, totalToolUseCount: 0 })
    expect(received).toEqual(['completed'])
    unsub()
    // fail after completed is an illegal transition, so it throws
    expect(() => lc.fail('t-1', 'late')).toThrow(/illegal transition/)
    expect(received).toEqual(['completed']) // unsubscribed, no more calls
  })

  it('subscribe to unknown taskId throws', () => {
    const lc = new BackgroundAgentLifecycle()
    expect(() => lc.subscribe('nope', () => {})).toThrow(/unknown taskId/)
  })
})

describe('BackgroundAgentLifecycle.killAll', () => {
  it('aborts every running task and applies hard timeout', async () => {
    const lc = new BackgroundAgentLifecycle()
    const a = new AbortController()
    const b = new AbortController()
    lc.register(makeInput({ taskId: 'a', abortController: a }))
    lc.register(makeInput({ taskId: 'b', abortController: b }))
    lc.getSnapshot('a')!.status = 'running'
    lc.getSnapshot('b')!.status = 'running'
    const start = Date.now()
    await lc.killAll('app_exit')
    expect(a.signal.aborted).toBe(true)
    expect(b.signal.aborted).toBe(true)
    expect(Date.now() - start).toBeLessThan(5500)
  })
})

describe('BackgroundAgentLifecycle.run', () => {
  it('happy path: source yields progress then completes', async () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput())
    async function* gen() {
      yield { type: 'text', data: 'hello', agentId: 't-1' } as AgentProgressEvent
      yield { role: 'assistant', content: [{ type: 'text', text: 'final' }] } as unknown as Message
    }
    await lc.run('t-1', gen())
    const r = lc.getSnapshot('t-1')!
    expect(r.status).toBe('completed')
    expect(r.result?.content[0].text).toBe('final')
  })

  it('reads an error marker from the final agent message metadata', async () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput())
    async function* gen() {
      yield {
        role: 'assistant',
        content: [{ type: 'text', text: 'partial output' }],
        metadata: { agentError: 'provider failed' },
      } as unknown as Message
    }

    await lc.run('t-1', gen())

    expect(lc.getSnapshot('t-1')?.status).toBe('failed')
    expect(lc.getSnapshot('t-1')?.error).toBe('provider failed')
  })

  it('treats an error progress event as task failure even if the source returns normally', async () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput())
    async function* gen() {
      yield { type: 'error', data: 'provider failed', agentId: 't-1' } as AgentProgressEvent
      yield { role: 'assistant', content: [{ type: 'text', text: 'partial output' }] } as unknown as Message
    }

    await lc.run('t-1', gen())

    const task = lc.getSnapshot('t-1')!
    expect(task.status).toBe('failed')
    expect(task.error).toBe('provider failed')
  })

  it('kill path: source throws AbortError -> status=killed', async () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput())
    async function* gen() {
      yield { type: 'text', data: 'hi' } as AgentProgressEvent
      throw Object.assign(new Error('aborted'), { name: 'AbortError' })
    }
    await lc.run('t-1', gen())
    expect(lc.getSnapshot('t-1')!.status).toBe('killed')
  })

  it('fail path: source throws non-Abort -> status=failed with error message', async () => {
    const lc = new BackgroundAgentLifecycle()
    lc.register(makeInput())
    async function* gen() {
      throw new Error('LLM API down')
    }
    await lc.run('t-1', gen())
    const r = lc.getSnapshot('t-1')!
    expect(r.status).toBe('failed')
    expect(r.error).toBe('LLM API down')
  })
})
