import { describe, it, expect, beforeEach } from 'vitest'
import { killTaskTool } from '../../../src/tool/BackgroundTaskTool/KillTaskTool.js'
import { getBackgroundAgentLifecycle } from '../../../src/lifecycle/BackgroundAgentLifecycle.js'

/**
 * kill_task must actually stop the background sub-agent, not just flip the
 * lifecycle record to 'killed'. The per-task abort controller is wired into
 * runAgent's execution channel, so killing must abort it.
 */
describe('KillTaskTool', () => {
  beforeEach(() => {
    const lc = getBackgroundAgentLifecycle()
    lc.markDrained(lc.getAll().map((r) => r.taskId))
  })

  it('aborts the underlying sub-agent when killing a running task', async () => {
    const lc = getBackgroundAgentLifecycle()
    const taskId = `kill-abort-${Date.now()}`
    const ac = new AbortController()
    lc.register({
      taskId,
      parentSessionId: 'parent',
      subAgentSessionId: 'sub',
      agentType: 'Explore',
      agentName: 'Explorer',
      description: 'desc',
      abortController: ac,
    })
    lc.getSnapshot(taskId)!.status = 'running'

    const res = await killTaskTool.execute({ task_id: taskId })

    expect(res.error).toBeFalsy()
    const parsed = JSON.parse(res.result)
    expect(parsed.outcome).toBe('killed')
    const rec = lc.getSnapshot(taskId)!
    expect(rec.status).toBe('killed')
    expect(rec.error).toBe('killed: user_kill')
    // The sub-agent must be aborted so the running work actually stops.
    expect(ac.signal.aborted).toBe(true)
  })

  it('returns already_exited for a task that already finished', async () => {
    const lc = getBackgroundAgentLifecycle()
    const taskId = `kill-done-${Date.now()}`
    lc.register({
      taskId,
      parentSessionId: 'parent',
      subAgentSessionId: 'sub',
      agentType: 'Explore',
      agentName: 'Explorer',
      description: 'desc',
      abortController: new AbortController(),
    })
    lc.getSnapshot(taskId)!.status = 'running'
    lc.complete(taskId, { content: [{ type: 'text', text: 'ok' }], totalDurationMs: 1, totalToolUseCount: 0 })

    const res = await killTaskTool.execute({ task_id: taskId })

    const parsed = JSON.parse(res.result)
    expect(parsed.outcome).toBe('already_exited')
  })

  it('returns not_found with a hint for unknown ids', async () => {
    const res = await killTaskTool.execute({ task_id: 'nope' })
    const parsed = JSON.parse(res.result)
    expect(parsed.outcome).toBe('not_found')
  })
})
