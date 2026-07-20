import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import {
  enqueue,
  enqueuePendingNotification,
  dequeueAllMatching,
  clearCommandQueue,
  isQueuedCommandEditable,
  isPromptInputModeEditable,
  getCommandQueueLength,
} from '../../../src/queue/index.js'

describe('messageQueueManager task-notification mode', () => {
  beforeEach(() => clearCommandQueue())
  afterEach(() => clearCommandQueue())

  it('enqueuePendingNotification tags the command with isMeta: true', () => {
    enqueuePendingNotification('<task-notification><status>completed</status></task-notification>', { taskId: 't1' }, 'parent-1')
    const drained = dequeueAllMatching((cmd) => cmd.mode === 'task-notification')
    expect(drained).toHaveLength(1)
    expect(drained[0]?.isMeta).toBe(true)
    expect(drained[0]?.priority).toBe('later')
    expect(drained[0]?.agentId).toBe('parent-1')
  })

  it('keeps notifications scoped to their parent session', () => {
    enqueuePendingNotification('<task-notification>a</task-notification>', { taskId: 'a' }, 'parent-a')
    enqueuePendingNotification('<task-notification>b</task-notification>', { taskId: 'b' }, 'parent-b')

    const parentA = dequeueAllMatching(
      (cmd) => cmd.mode === 'task-notification' && cmd.agentId === 'parent-a',
    )
    expect(parentA.map((cmd) => cmd.rawMessage)).toEqual([{ taskId: 'a' }])

    const remaining = dequeueAllMatching((cmd) => cmd.mode === 'task-notification')
    expect(remaining.map((cmd) => cmd.agentId)).toEqual(['parent-b'])
  })

  it('task-notification commands are not editable (filtered from UP/ESC recall)', () => {
    enqueuePendingNotification('<task-notification>x</task-notification>', { taskId: 't1' })
    const drained = dequeueAllMatching((cmd) => cmd.mode === 'task-notification')
    expect(drained[0]).toBeDefined()
    expect(isQueuedCommandEditable(drained[0]!)).toBe(false)
    expect(isPromptInputModeEditable(drained[0]!.mode)).toBe(false)
  })

  it('prompt commands are editable', () => {
    enqueue({
      value: 'hello',
      mode: 'prompt',
      priority: 'next',
      rawMessage: { x: 1 },
    } as Parameters<typeof enqueue>[0])

    const drained = dequeueAllMatching((cmd) => cmd.mode === 'prompt')
    expect(drained[0]).toBeDefined()
    expect(isQueuedCommandEditable(drained[0]!)).toBe(true)
    expect(isPromptInputModeEditable(drained[0]!.mode)).toBe(true)
  })

  it('task-notification priority is "later" so it never starves user prompts', () => {
    enqueuePendingNotification('<task-notification>x</task-notification>', { taskId: 't1' })
    enqueue({
      value: 'urgent',
      mode: 'prompt',
      priority: 'now',
      rawMessage: null,
    } as Parameters<typeof enqueue>[0])
    expect(getCommandQueueLength()).toBe(2)
  })
})
