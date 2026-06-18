import type { TaskRecord, TaskStatus } from './TaskState.js'
import { ProgressTracker } from './ProgressTracker.js'
import { OutputFileWriter } from './OutputFileWriter.js'
import { CleanupRegistry } from './CleanupRegistry.js'
import { applyProgressEvent, extractResultFromLastMessage } from '../tool/AgentTool/agentLifecycleBridge.js'
import { sendEvent } from '../process/worker-protocol.js'
import { logger } from '../utils/logger.js'
import type { AgentProgressEvent } from '../tool/AgentTool/runAgent.js'
import type { Message } from '../types.js'
import { enqueuePendingNotification } from '../queue/index.js'
import { buildTaskNotificationXml, DEFAULT_MAX_RESULT_CHARS, type BuildTaskNotificationInput } from './buildTaskNotification.js'

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
  /**
   * Tasks whose terminal notification has already been emitted to the
   * message queue. Prevents the completed + AbortError catch branches in
   * run() from double-enqueueing the same task.
   */
  private notified = new Set<string>()
  /** Inline cap on the <result> body of task-notification envelopes. */
  private maxResultChars = DEFAULT_MAX_RESULT_CHARS

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
    logger.info('[SubAgent] lifecycle registered', {
      taskId: input.taskId,
      parentSessionId: input.parentSessionId,
      subAgentSessionId: input.subAgentSessionId,
      agentType: input.agentType,
      agentName: input.agentName,
      outputFilePath: record.outputFilePath,
    }, 'SubAgent')
    return record
  }

  private transition(taskId: string, next: TaskStatus, mutate: (r: TaskRecord) => void): void {
    const r = this.tasks.get(taskId)
    if (!r) throw new Error(`unknown taskId ${taskId}`)
    if (!this.isLegalTransition(r.status, next)) {
      throw new Error(`illegal transition ${r.status} -> ${next} for ${taskId}`)
    }
    const previousStatus = r.status
    r.status = next
    r.completedAt = Date.now()
    mutate(r)
    logger.info('[SubAgent] lifecycle transition', {
      taskId,
      from: previousStatus,
      to: next,
      parentSessionId: r.parentSessionId,
      subAgentSessionId: r.subAgentSessionId,
    }, 'SubAgent')
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
    if (r.status === 'pending') {
      r.status = 'running'
      logger.info('[SubAgent] lifecycle running', {
        taskId,
        parentSessionId: r.parentSessionId,
        subAgentSessionId: r.subAgentSessionId,
        agentType: r.agentType,
        agentName: r.agentName,
      }, 'SubAgent')
    }
    let lastMessage: Message | undefined

    try {
      for await (const ev of source) {
        if (isAgentProgressEvent(ev)) {
          logger.debug('[SubAgent] lifecycle progress event', {
            taskId,
            eventType: ev.type,
            hasData: ev.data !== undefined,
            toolName: ev.toolName,
          }, 'SubAgent')
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
      const result = extractResultFromLastMessage(lastMessage)
      this.complete(taskId, result)
      this.enqueueTaskNotification(taskId, 'completed', {
        finalMessage: extractFinalText(result),
        totalToolUseCount: result.totalToolUseCount,
        totalDurationMs: result.totalDurationMs,
      })
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.warn('[SubAgent] lifecycle aborted', { taskId, err }, 'SubAgent')
        this.kill(taskId, 'parent_abort')
        this.enqueueTaskNotification(taskId, 'killed', { error: 'parent_abort' })
      } else {
        const message = (err as Error).message ?? 'Unknown error'
        logger.error('[SubAgent] lifecycle failed', err as Error, { taskId }, 'SubAgent')
        this.fail(taskId, message)
        this.enqueueTaskNotification(taskId, 'failed', { error: message })
      }
    } finally {
      try { await OutputFileWriter.close(r.outputFilePath) } catch { /* ignore */ }
      for (const cb of r.subscribers) cb(r)
    }
  }

  /**
   * Build a <task-notification> envelope and enqueue it via
   * enqueuePendingNotification. Idempotent per taskId — repeat calls
   * after the first are dropped. Mirrors claude-code's `notified` flag
   * in LocalAgentTask.tsx:227-240.
   */
  private enqueueTaskNotification(
    taskId: string,
    status: 'completed' | 'failed' | 'killed',
    extras: { finalMessage?: string; error?: string; totalToolUseCount?: number; totalDurationMs?: number }
  ): void {
    if (this.notified.has(taskId)) {
      logger.debug('[SubAgent] task notification already enqueued, skipping', { taskId, status }, 'SubAgent')
      return
    }
    const r = this.tasks.get(taskId)
    if (!r) return
    this.notified.add(taskId)
    const input: BuildTaskNotificationInput = {
      taskId,
      status,
      agentType: r.agentType,
      agentName: r.agentName,
      description: r.description,
      outputFilePath: r.outputFilePath,
      finalMessage: extras.finalMessage,
      totalToolUseCount: extras.totalToolUseCount,
      totalDurationMs: extras.totalDurationMs,
      error: extras.error,
      maxResultChars: this.maxResultChars,
    }
    enqueuePendingNotification(buildTaskNotificationXml(input), { taskId, status })
  }

  /**
   * Override the inline cap on the <result> body of task-notification
   * envelopes. Set to `0` to always emit an output-file pointer.
   * Tests use this to make notifications deterministic.
   */
  setMaxResultChars(chars: number): void {
    this.maxResultChars = chars
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
export const cleanupRegistry = CleanupRegistry.install()

function extractFinalText(result: NonNullable<TaskRecord['result']>): string {
  return result.content
    .map((b) => (b.type === 'text' && typeof b.text === 'string' ? b.text : ''))
    .join('\n')
}