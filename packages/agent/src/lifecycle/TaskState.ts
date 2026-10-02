export type TaskStatus = 'pending' | 'running' | 'completed' | 'killed' | 'failed'

export interface ProgressSnapshot {
  toolUseCount: number
  cumulativeOutputTokens: number
  cumulativeInputTokens: number
  lastActivity: { tool: string; description: string; at: number } | null
  recentActivities: Array<{ tool: string; description: string; at: number }>
  startedAt: number
  lastUpdateAt: number
}

export interface TaskRecord {
  taskId: string
  parentSessionId: string
  subAgentSessionId: string
  agentType: string
  agentName: string
  description: string
  status: TaskStatus
  abortController: AbortController
  startedAt: number
  completedAt?: number
  error?: string
  result?: {
    content: Array<{ type: 'text'; text: string }>
    totalDurationMs: number
    totalToolUseCount: number
  }
  progress: ProgressSnapshot
  outputFilePath: string
  /**
   * Plan 571: false when the spawn passed `auto_wake: false` — the terminal
   * notification is suppressed and the model reads the result from the
   * output file via `get_task_output` instead of being woken.
   */
  autoWake: boolean
  unregisterCleanup?: () => void
  subscribers: Set<(snapshot: TaskRecord) => void>
}