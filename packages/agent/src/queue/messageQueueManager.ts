import { createSignal } from './signal.js'

export type QueuePriority = 'now' | 'next' | 'later'

const PRIORITY_ORDER: Record<QueuePriority, number> = {
  now: 0,
  next: 1,
  later: 2,
}

export interface QueuedCommand<T = unknown> {
  id: string
  value: string
  mode: 'prompt' | 'task-notification'
  priority: QueuePriority
  agentId: string | undefined
  rawMessage: T
  /**
   * Marks commands that contain raw protocol XML (e.g. <task-notification>)
   * which must not leak into the user's editable input buffer via UP/ESC
   * recall. Mirrors claude-code's `isMeta` flag.
   */
  isMeta?: boolean
}

function comparePriority(a: QueuePriority, b: QueuePriority): number {
  return PRIORITY_ORDER[a] - PRIORITY_ORDER[b]
}

const commandQueue: QueuedCommand[] = []
const signal = createSignal()

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
  signal.emit()
}

export function enqueuePendingNotification<T = unknown>(
  value: string,
  rawMessage: T,
  agentId?: string,
): void {
  commandQueue.push({
    id: crypto.randomUUID(),
    value,
    mode: 'task-notification',
    priority: 'later',
    agentId,
    rawMessage,
    isMeta: true,
  })
  signal.emit()
}

export function dequeue<T = unknown>(
  filter?: (cmd: QueuedCommand<T>) => boolean
): QueuedCommand<T> | undefined {
  const idx = findHighestPriorityIndex(filter)
  if (idx === -1) return undefined
  const [removed] = commandQueue.splice(idx, 1)
  signal.emit()
  return removed as QueuedCommand<T>
}

export function peek<T = unknown>(
  filter?: (cmd: QueuedCommand<T>) => boolean
): QueuedCommand<T> | undefined {
  const idx = findHighestPriorityIndex(filter)
  if (idx === -1) return undefined
  return commandQueue[idx] as QueuedCommand<T>
}

export function dequeueAllMatching<T = unknown>(
  predicate: (cmd: QueuedCommand<T>) => boolean
): QueuedCommand<T>[] {
  const matches: { idx: number; cmd: QueuedCommand<T> }[] = []
  for (let i = 0; i < commandQueue.length; i++) {
    if (predicate(commandQueue[i] as QueuedCommand<T>)) {
      matches.push({ idx: i, cmd: commandQueue[i] as QueuedCommand<T> })
    }
  }
  if (matches.length === 0) return []

  matches.sort((a, b) => comparePriority(a.cmd.priority, b.cmd.priority))

  const sorted = matches.map(m => m.cmd)
  const idxSet = new Set(matches.map(m => m.idx))
  for (let i = commandQueue.length - 1; i >= 0; i--) {
    if (idxSet.has(i)) {
      commandQueue.splice(i, 1)
    }
  }
  signal.emit()
  return sorted
}

export function hasCommandsInQueue(): boolean {
  return commandQueue.length > 0
}

export function clearCommandQueue(): void {
  commandQueue.length = 0
  signal.emit()
}

export function getCommandQueueSnapshot(): readonly QueuedCommand[] {
  return Object.freeze([...commandQueue])
}

export function getCommandQueueLength(): number {
  return commandQueue.length
}

export function subscribeToCommandQueue(callback: () => void): () => void {
  return signal.subscribe(callback)
}

function findHighestPriorityIndex<T = unknown>(
  filter?: (cmd: QueuedCommand<T>) => boolean
): number {
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
  return bestIdx
}

// Editable mode helpers — distinguish user-editable input (prompts) from
// system-generated protocol messages (task-notification) that must never
// leak into the user's input buffer. Mirrors claude-code's split between
// `isPromptInputModeEditable` and `isQueuedCommandEditable`.
const NON_EDITABLE_MODES = new Set<QueuedCommand['mode']>(['task-notification'])

export function isPromptInputModeEditable(mode: QueuedCommand['mode']): boolean {
  return !NON_EDITABLE_MODES.has(mode)
}

/**
 * Whether this queued command can be pulled into the input buffer via UP/ESC.
 * System-generated commands (task-notifications) contain raw XML and must
 * not leak into the user's input.
 */
export function isQueuedCommandEditable(cmd: QueuedCommand): boolean {
  return isPromptInputModeEditable(cmd.mode) && !cmd.isMeta
}
