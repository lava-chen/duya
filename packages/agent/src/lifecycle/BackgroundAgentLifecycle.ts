import type { TaskRecord, TaskStatus } from './TaskState.js'
import { ProgressTracker } from './ProgressTracker.js'
import { OutputFileWriter } from './OutputFileWriter.js'
import { NotificationQueue } from './NotificationQueue.js'
import { CleanupRegistry } from './CleanupRegistry.js'
import { applyProgressEvent, extractResultFromLastMessage } from '../tool/AgentTool/agentLifecycleBridge.js'
import { sendEvent } from '../process/worker-protocol.js'
import { logger } from '../utils/logger.js'
import type { AgentProgressEvent } from '../tool/AgentTool/runAgent.js'
import type { Message } from '../types.js'

export interface RegisterInput {
  taskId: string
  parentSessionId: string
  subAgentSessionId: string
  agentType: string
  agentName: string
  description: string
  abortController: AbortController
}

export class BackgroundAgentLifecycle {
  private tasks = new Map<string, TaskRecord>()
  private drained = new Set<string>()
  private drainsByReason: ('completed' | 'killed' | 'failed')[] = ['completed', 'killed', 'failed']

  register(input: RegisterInput): TaskRecord {
    if (this.tasks.has(input.taskId)) {
      throw new Error(`BackgroundAgentLifecycle: duplicate taskId ${input.taskId}`)
    }
    const now = Date.now()
    const record: TaskRecord = {
      taskId: input.taskId,
      parentSessionId: input.parentSessionId,
      subAgentSessionId: input.subAgentSessionId,
      agentType: input.agentType,
      agentName: input.agentName,
      description: input.description,
      status: 'pending',
      abortController: input.abortController,
      startedAt: now,
      progress: ProgressTracker.initial(now),
      outputFilePath: OutputFileWriter.allocate(input.taskId),
      subscribers: new Set(),
    }
    this.tasks.set(input.taskId, record)
    return record
  }

  private transition(taskId: string, next: TaskStatus, mutate: (r: TaskRecord) => void): void {
    const r = this.tasks.get(taskId)
    if (!r) throw new Error(`unknown taskId ${taskId}`)
    if (!this.isLegalTransition(r.status, next)) {
      throw new Error(`illegal transition ${r.status} -> ${next} for ${taskId}`)
    }
    r.status = next
    r.completedAt = Date.now()
    mutate(r)
    for (const cb of r.subscribers) cb(r)
  }

  private isLegalTransition(from: TaskStatus, to: TaskStatus): boolean {
    if (from === to) return false
    if (from === 'pending' && to === 'running') return true
    if (from === 'running' && (to === 'completed' || to === 'killed' || to === 'failed')) return true
    return false
  }

  complete(taskId: string, result: NonNullable<TaskRecord['result']>): void {
    this.transition(taskId, 'completed', (r) => { r.result = result })
  }

  fail(taskId: string, error: string): void {
    this.transition(taskId, 'failed', (r) => { r.error = error })
  }

  kill(taskId: string, reason: 'user_kill' | 'parent_abort' | 'app_exit'): void {
    this.transition(taskId, 'killed', (r) => { r.error = `killed: ${reason}` })
  }

  getCompleted(): TaskRecord[] {
    const out: TaskRecord[] = []
    for (const r of this.tasks.values()) {
      if (this.drainsByReason.includes(r.status as 'completed' | 'killed' | 'failed') && !this.drained.has(r.taskId)) {
        out.push(r)
      }
    }
    return out
  }

  markDrained(taskIds: string[]): void {
    for (const id of taskIds) this.drained.add(id)
  }

  subscribe(taskId: string, cb: (snapshot: TaskRecord) => void): () => void {
    const r = this.tasks.get(taskId)
    if (!r) throw new Error(`unknown taskId ${taskId}`)
    r.subscribers.add(cb)
    return () => { r.subscribers.delete(cb) }
  }

  getSnapshot(taskId: string): TaskRecord | undefined {
    return this.tasks.get(taskId)
  }

  getAll(): TaskRecord[] {
    return [...this.tasks.values()]
  }

  async run(
    taskId: string,
    source: AsyncGenerator<unknown, void>,
    onProgress?: (event: AgentProgressEvent) => void
  ): Promise<void> {
    const r = this.tasks.get(taskId)
    if (!r) throw new Error(`unknown taskId ${taskId}`)

    // pending -> running
    if (r.status === 'pending') r.status = 'running'
    let lastMessage: Message | undefined

    try {
      for await (const ev of source) {
        if (isAgentProgressEvent(ev)) {
          await applyProgressEvent({ record: r, onProgress }, ev)
          // Forward as SSE chat:agent_progress (canonical schema)
          try {
            sendEvent({
              type: 'chat:agent_progress',
              sessionId: r.parentSessionId,
              agentEventType: ev.type,
              agentId: r.taskId,
              agentType: r.agentType,
              agentName: r.agentName,
              agentDescription: r.description,
              agentSessionId: r.subAgentSessionId,
              ...(ev.duration !== undefined ? { duration: ev.duration } : {}),
              ...(ev.data !== undefined ? { data: ev.data } : {}),
            })
          } catch (err) {
            logger.warn('sendEvent chat:agent_progress failed', { taskId, err })
          }
        } else {
          lastMessage = ev as Message
        }
      }
      this.complete(taskId, extractResultFromLastMessage(lastMessage))
      notificationQueue.enqueue(this.tasks.get(taskId)!)
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        this.kill(taskId, 'parent_abort')
        notificationQueue.enqueue(this.tasks.get(taskId)!)
      } else {
        this.fail(taskId, (err as Error).message ?? 'Unknown error')
        notificationQueue.enqueue(this.tasks.get(taskId)!)
      }
    } finally {
      try { await OutputFileWriter.close(r.outputFilePath) } catch { /* ignore */ }
      for (const cb of r.subscribers) cb(r)
    }
  }

  async killAll(reason: 'app_exit'): Promise<void> {
    const inFlight = [...this.tasks.values()].filter((t) => t.status === 'running' || t.status === 'pending')
    for (const r of inFlight) {
      try { r.abortController.abort() } catch { /* ignore */ }
    }
    // give in-flight .run() promises 5s to finalize via the kill transition
    await new Promise((resolve) => setTimeout(resolve, 5000))
  }
}

function isAgentProgressEvent(x: unknown): x is AgentProgressEvent {
  return !!x && typeof x === 'object' && 'type' in x && typeof (x as { type: unknown }).type === 'string'
}

let _singleton: BackgroundAgentLifecycle | null = null
export function getBackgroundAgentLifecycle(): BackgroundAgentLifecycle {
  if (!_singleton) {
    _singleton = new BackgroundAgentLifecycle()
  }
  return _singleton
}

export const backgroundAgentLifecycle = getBackgroundAgentLifecycle()
export const notificationQueue = new NotificationQueue()
export const cleanupRegistry = CleanupRegistry.install()