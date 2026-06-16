import { describe, it, expect } from 'vitest'
import { NotificationQueue } from '../../../src/lifecycle/NotificationQueue.js'
import type { TaskRecord } from '../../../src/lifecycle/TaskState.js'

function makeRecord(taskId: string): TaskRecord {
  return {
    taskId,
    parentSessionId: 'p',
    subAgentSessionId: 's',
    agentType: 'Explore',
    agentName: 'Explore',
    description: 'd',
    status: 'completed',
    abortController: new AbortController(),
    startedAt: 0,
    progress: {
      toolUseCount: 0,
      cumulativeOutputTokens: 0,
      cumulativeInputTokens: 0,
      lastActivity: null,
      recentActivities: [],
      startedAt: 0,
      lastUpdateAt: 0,
    },
    outputFilePath: '/tmp/x.jsonl',
    subscribers: new Set(),
  }
}

describe('NotificationQueue', () => {
  it('enqueue then drain returns the record', () => {
    const q = new NotificationQueue()
    const r = makeRecord('t1')
    q.enqueue(r)
    expect(q.drain()).toEqual([r])
  })

  it('drain clears the buffer (no re-delivery)', () => {
    const q = new NotificationQueue()
    q.enqueue(makeRecord('t1'))
    q.drain()
    expect(q.drain()).toEqual([])
  })

  it('preserves insertion order', () => {
    const q = new NotificationQueue()
    const a = makeRecord('a')
    const b = makeRecord('b')
    q.enqueue(a)
    q.enqueue(b)
    expect(q.drain().map((r) => r.taskId)).toEqual(['a', 'b'])
  })
})