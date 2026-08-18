import type { TaskRecord, TaskStatus } from './TaskState.js'
import { ProgressTracker } from './ProgressTracker.js'
import { OutputFileWriter } from './OutputFileWriter.js'
import { CleanupRegistry } from './CleanupRegistry.js'
import { applyProgressEvent, extractResultFromLastMessage } from '../tool/SubagentTool/subagentLifecycleBridge.js'
import { sendEvent } from '../process/worker-protocol.js'
import { logger } from '../utils/logger.js'
import type { AgentProgressEvent } from '../tool/SubagentTool/runAgent.js'
import type { Message } from '../types.js'
import { buildTaskNotificationXml, DEFAULT_MAX_RESULT_CHARS, type BuildTaskNotificationInput } from './buildTaskNotification.js'
import { sendBackgroundNotification } from './mailboxBackgroundNotification.js'

export interface RegisterInput {
  taskId: string
  parentSessionId: string
  subAgentSessionId: string
  agentType: string
  agentName: string
  description: string
  abortController: AbortController
}

/** Default window (ms) a drained terminal record stays queryable via
 * get_task_output after its completion notification was enqueued. */
export const DEFAULT_DRAINED_RETENTION_MS = 5 * 60 * 1000

/**
 * Callback fired whenever the number of in-flight (pending/running) tasks
 * changes. The agent process wires this to an IPC `background_tasks:update`
 * message so the Agent Server can exempt the parent session's worker from
 * idle reaping while background sub-agents are still running inside it.
 */
export type InFlightChangeListener = (inFlight: number) => void

export class BackgroundAgentLifecycle {
  private tasks = new Map<string, TaskRecord>()
  private drained = new Set<string>()
  /** Timestamp (ms) at which each task was marked drained, so completed
   * records can be pruned after `drainedRetentionMs` instead of being
   * deleted immediately (which made get_task_output return not_found
   * right after a completion notification pointed the model at it). */
  private drainedAt = new Map<string, number>()
  private drainsByReason: ('completed' | 'killed' | 'failed')[] = ['completed', 'killed', 'failed']

  constructor(private readonly drainedRetentionMs: number = DEFAULT_DRAINED_RETENTION_MS) {}

  /** Set by the agent process to report in-flight count changes to the server. */
  onInFlightChange: InFlightChangeListener | null = null

  private lastReportedInFlight: number | null = null

  /** Number of tasks still pending or running (not yet terminal). */
  inFlightCount(): number {
    let count = 0
    for (const r of this.tasks.values()) {
      if (r.status === 'pending' || r.status === 'running') count++
    }
    return count
  }

  /** Fire onInFlightChange only when the in-flight count actually changed. */
  private reportInFlight(): void {
    if (!this.onInFlightChange) return
    const count = this.inFlightCount()
    if (count === this.lastReportedInFlight) return
    this.lastReportedInFlight = count
    try {
      this.onInFlightChange(count)
    } catch (err) {
      logger.warn('[SubAgent] onInFlightChange threw', { err })
    }
  }
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
    // Prune expired drained records here too: if the last task drained and no
    // new task is ever drained again, lazy pruning in markDrained would leave
    // a single terminal record resident for the process life.
    this.pruneDrained(Date.now())
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
    this.reportInFlight()
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
    // A task leaving pending/running lowers the in-flight count; the server
    // must learn about it so it can drop the worker keep-alive once drained.
    if (next === 'completed' || next === 'killed' || next === 'failed') {
      this.reportInFlight()
    }
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
    const now = Date.now()
    for (const id of taskIds) {
      this.drained.add(id)
      // Record the drain time but KEEP the task record: the completion
      // notification already told the model to call get_task_output, and
      // deleting the record here made that call return `not_found` even for
      // successfully completed tasks. Retention is bounded by
      // pruneDrained(), so memory stays capped across a long session.
      this.drainedAt.set(id, now)
    }
    this.pruneDrained(now)
  }

  /**
   * Delete drained records whose retention window has elapsed. Runs lazily
   * from markDrained/register so no timer thread is needed.
   */
  private pruneDrained(now: number): void {
    for (const [id, at] of this.drainedAt) {
      if (now - at > this.drainedRetentionMs) {
        this.drainedAt.delete(id)
        this.drained.delete(id)
        this.tasks.delete(id)
        this.notified.delete(id)
      }
    }
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
    let terminalProgress: 'done' | 'error' | undefined
    let progressError: string | undefined

    try {
      for await (const ev of source) {
        if (isAgentProgressEvent(ev)) {
          if (ev.type === 'done') {
            terminalProgress = 'done'
          } else if (ev.type === 'error') {
            terminalProgress = 'error'
            progressError = typeof ev.data === 'string' && ev.data.trim()
              ? ev.data
              : 'Sub-agent reported an error'
          }
          logger.debug('[SubAgent] lifecycle progress event', {
            taskId,
            eventType: ev.type,
            hasData: ev.data !== undefined,
            toolName: ev.toolName,
          }, 'SubAgent')
          // applyProgressEvent calls `onProgress` (which the SubagentTool wires
          // to emitLiveProgress → sendEvent) and updates the progress snapshot.
          // We must NOT send a second chat:agent_progress event here — that
          // duplicates the SSE payload and the renderer's agent surfaces
          // showed every progress event twice (manifesting as 6 rows
          // for 3 spawned sub-agents, one per emit path).
          await applyProgressEvent({ record: r, onProgress }, ev)
        } else {
          lastMessage = ev as Message
        }
      }
      const result = extractResultFromLastMessage(lastMessage)
      const taskError = progressError ?? extractAgentError(lastMessage)
      if (taskError) {
        this.fail(taskId, taskError)
        await this.enqueueTaskNotification(taskId, 'failed', { error: taskError })
      } else {
        this.complete(taskId, result)
        await this.enqueueTaskNotification(taskId, 'completed', {
          finalMessage: extractFinalText(result),
          totalToolUseCount: result.totalToolUseCount,
          totalDurationMs: result.totalDurationMs,
        })
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.warn('[SubAgent] lifecycle aborted', { taskId, err }, 'SubAgent')
        this.kill(taskId, 'parent_abort')
        await this.enqueueTaskNotification(taskId, 'killed', { error: 'parent_abort' })
      } else {
        const message = (err as Error).message ?? 'Unknown error'
        logger.error('[SubAgent] lifecycle failed', err as Error, { taskId }, 'SubAgent')
        this.fail(taskId, message)
        if (terminalProgress !== 'error') {
          onProgress?.({ type: 'error', data: message, agentId: taskId })
        }
        await this.enqueueTaskNotification(taskId, 'failed', { error: message })
      }
    } finally {
      try { await OutputFileWriter.close(r.outputFilePath) } catch { /* ignore */ }
      for (const cb of r.subscribers) cb(r)
    }
  }

  /**
   * Build a <task-notification> envelope and write it to the parent session's
   * mailbox as a `background_notification` row. Idempotent per taskId — repeat
   * calls after the first are dropped. Mirrors claude-code's `notified` flag
   * in LocalAgentTask.tsx:227-240.
   */
  private async enqueueTaskNotification(
    taskId: string,
    status: 'completed' | 'failed' | 'killed',
    extras: { finalMessage?: string; error?: string; totalToolUseCount?: number; totalDurationMs?: number }
  ): Promise<void> {
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
    const xml = buildTaskNotificationXml(input)
    await sendBackgroundNotification({
      sessionId: r.parentSessionId,
      xml,
      taskId,
    })
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

function extractAgentError(message: Message | undefined): string | undefined {
  const value = message?.metadata?.agentError
  return typeof value === 'string' && value.trim() ? value : undefined
}
