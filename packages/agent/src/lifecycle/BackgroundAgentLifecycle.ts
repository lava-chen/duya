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
import { parseModelVerdict } from '../tool/task-verification.js'
import { sendBackgroundNotification } from './mailboxBackgroundNotification.js'

export interface RegisterInput {
  taskId: string
  parentSessionId: string
  subAgentSessionId: string
  agentType: string
  agentName: string
  description: string
  abortController: AbortController
  /**
   * Plan 571 (`task` tool's `auto_wake`): when false, the terminal
   * `<task-notification>` is NOT written to the parent session's mailbox.
   * The spawn receipt already handed the model the output-file path, so it
   * can pull the result with `get_task_output` on its own schedule — a
   * suppressed wake means the parent turn is never resurrected behind the
   * user's back. Defaults to true (unchanged pre-571 behavior).
   */
  autoWake?: boolean
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

/** See {@link BackgroundAgentLifecycle.tryKill}. */
export type KillOutcome = 'killed' | 'not_found' | 'already_terminal'

function isKillableStatus(status: TaskStatus): boolean {
  return status === 'pending' || status === 'running'
}

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
      autoWake: input.autoWake !== false,
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
    // Plan 571: a just-registered task is still `pending` when the user hits
    // stop (the panel renders `running` from the `started` progress event,
    // which is emitted before `run()` drains the generator). Without this
    // edge, stopping a sub-agent in its first milliseconds was impossible.
    if (from === 'pending' && to === 'killed') return true
    if (from === 'running' && (to === 'completed' || to === 'killed' || to === 'failed')) return true
    return false
  }

  complete(taskId: string, result: NonNullable<TaskRecord['result']>): void {
    this.transition(taskId, 'completed', (r) => { r.result = result })
  }

  fail(taskId: string, error: string): void {
    this.transition(taskId, 'failed', (r) => { r.error = error })
  }

  /**
   * `complete` / `fail` variants that tolerate an out-of-band kill.
   *
   * The generator `run()` drains can be terminated by {@link tryKill} between
   * its last event and its final message, so the natural `complete`/`fail`
   * call then hits an illegal transition and rejects the `run()` promise —
   * which the caller fires with `void`, i.e. an unhandled rejection. These
   * variants keep the existing throwing API for every other caller.
   */
  tryComplete(taskId: string, result: NonNullable<TaskRecord['result']>): void {
    this.applyTerminal(taskId, 'completed', (r) => { r.result = result })
  }

  tryFail(taskId: string, error: string): void {
    this.applyTerminal(taskId, 'failed', (r) => { r.error = error })
  }

  kill(taskId: string, reason: 'user_kill' | 'parent_abort' | 'app_exit'): void {
    this.transition(taskId, 'killed', (r) => { r.error = `killed: ${reason}` })
  }

  /**
   * Outcome of {@link BackgroundAgentLifecycle.tryKill}.
   *
   * - `killed`: the task was pending/running and is now terminal.
   * - `not_found`: no such taskId in this worker (wrong parent session, or
   *   the record was already pruned by the retention window).
   * - `already_terminal`: the task finished before the kill arrived — the
   *   common race when a user clicks stop on a sub-agent that just landed.
   */
  tryKill(taskId: string, reason: 'user_kill' | 'parent_abort' | 'app_exit' = 'user_kill'): KillOutcome {
    const record = this.tasks.get(taskId)
    if (!record) return 'not_found'
    if (!isKillableStatus(record.status)) return 'already_terminal'
    try {
      this.kill(taskId, reason)
    } catch (err) {
      // `transition` throws on an illegal transition. Reaching here means the
      // record changed status between the check above and the call, so the
      // task is already terminal — not an error worth propagating.
      logger.warn('[SubAgent] tryKill lost a transition race', { taskId, err }, 'SubAgent')
      return 'already_terminal'
    }
    // Abort only after the transition succeeded: a lost race means somebody
    // else already finished the task and aborting would be a lie. The
    // controller is the sub-agent's cancel handle (SubagentTool hands
    // `runAgent` this exact instance), so this is what actually stops the
    // in-flight LLM request instead of only relabelling the status.
    try {
      record.abortController.abort()
    } catch (err) {
      logger.warn('[SubAgent] tryKill abort threw', { taskId, err }, 'SubAgent')
    }
    return 'killed'
  }

  /**
   * `transition` with the throw removed: a record that is already terminal
   * (or already gone) simply does not change. Subscribers still fire.
   */
  private applyTerminal(
    taskId: string,
    next: TaskStatus,
    mutate: (r: TaskRecord) => void,
  ): void {
    try {
      this.transition(taskId, next, mutate)
    } catch (err) {
      logger.warn('[SubAgent] terminal transition skipped', { taskId, next, err }, 'SubAgent')
    }
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
        this.tryFail(taskId, taskError)
        await this.enqueueTaskNotification(taskId, 'failed', { error: taskError })
      } else {
        this.tryComplete(taskId, result)
        await this.enqueueTaskNotification(taskId, 'completed', {
          finalMessage: extractFinalText(result),
          // Plan 554: mechanical verdict parsed from the child's final reply
          // (undefined when the child did not end with a well-formed line).
          modelVerdict: parseModelVerdict(extractFinalText(result)),
          totalToolUseCount: result.totalToolUseCount,
          totalDurationMs: result.totalDurationMs,
        })
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        logger.warn('[SubAgent] lifecycle aborted', { taskId, err }, 'SubAgent')
        // An out-of-band kill (sub-agent panel stop button → `subagent:kill`)
        // already moved the record to `killed`; `tryKill` is a no-op then
        // instead of throwing an illegal-transition out of this promise.
        this.tryKill(taskId, 'parent_abort')
        // The record's own error carries the real cause (`killed: user_kill`
        // for a panel stop); fall back to the local reason only when this
        // abort was not already accounted for.
        const recorded = this.tasks.get(taskId)?.error
        const reason = recorded?.startsWith('killed:') ? recorded.slice('killed:'.length).trim() : 'parent_abort'
        await this.enqueueTaskNotification(taskId, 'killed', { error: reason })
      } else {
        const message = (err as Error).message ?? 'Unknown error'
        logger.error('[SubAgent] lifecycle failed', err as Error, { taskId }, 'SubAgent')
        this.tryFail(taskId, message)
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
   *
   * Plan 571 (`auto_wake: false`): the mailbox write is skipped entirely. The
   * spawn receipt already carried `outputFilePath`, so the model can fetch
   * the result with `get_task_output` whenever it is ready instead of having
   * the parent session resumed behind its back.
   */
  private async enqueueTaskNotification(
    taskId: string,
    status: 'completed' | 'failed' | 'killed',
    extras: { finalMessage?: string; error?: string; totalToolUseCount?: number; totalDurationMs?: number; modelVerdict?: string }
  ): Promise<void> {
    if (this.notified.has(taskId)) {
      logger.debug('[SubAgent] task notification already enqueued, skipping', { taskId, status }, 'SubAgent')
      return
    }
    const r = this.tasks.get(taskId)
    if (!r) return
    // Mark notified either way: a suppressed wake must not leave the door open
    // for a later terminal path to write the same task's notification.
    this.notified.add(taskId)
    if (!r.autoWake) {
      logger.info('[SubAgent] auto_wake=false, suppressing mailbox notification', {
        taskId,
        status,
        parentSessionId: r.parentSessionId,
        outputFilePath: r.outputFilePath,
      }, 'SubAgent')
      return
    }
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
