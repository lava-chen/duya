/**
 * queue/index.ts — process-local FIFO priority queue for the Agent subprocess.
 *
 * Serialises `chat:start` commands that arrive while the subprocess is still
 * initialising or another chat is in flight. The entry point enqueues here and
 * replays the next queued command once the current turn finishes. This is a
 * pure in-memory gate for whole turns that have not started yet — distinct from
 * the DB-persisted mailbox, which injects mid-run followup guidance.
 */

export type QueuePriority = 'now' | 'next' | 'later'

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

export interface QueuedCommand<T = unknown> {
  id: string
  value: string
  mode: 'prompt'
  priority: QueuePriority
  agentId: string | undefined
  rawMessage: T
}

const commandQueue: QueuedCommand[] = []

export function enqueue<T = unknown>(
  command: Omit<QueuedCommand<T>, 'id' | 'priority' | 'agentId'> & { priority?: QueuePriority; agentId?: string }
): void {
  commandQueue.push({
    id: crypto.randomUUID(),
    value: command.value,
    mode: command.mode,
    priority: command.priority ?? 'next',
    agentId: command.agentId ?? undefined,
    rawMessage: command.rawMessage,
  })
}

/**
 * Remove and return the highest-priority command matching `filter` (or any
 * command when no filter is given). Returns undefined when the queue is empty.
 */
export function dequeue<T = unknown>(
  filter?: (cmd: QueuedCommand<T>) => boolean
): QueuedCommand<T> | undefined {
  let bestIdx = -1
  let bestPriority = Infinity
  for (let i = 0; i < commandQueue.length; i++) {
    const cmd = commandQueue[i] as QueuedCommand<T>
    if (filter && !filter(cmd)) continue
    const p = PRIORITY_ORDER[cmd.priority]
    if (p < bestPriority) {
      bestPriority = p
      bestIdx = i
    }
  }
  if (bestIdx === -1) return undefined
  const [removed] = commandQueue.splice(bestIdx, 1)
  return removed as QueuedCommand<T>
}

export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

export function clearCommandQueue(): void {
  commandQueue.length = 0
}

export function getCommandQueueLength(): number {
  return commandQueue.length
}