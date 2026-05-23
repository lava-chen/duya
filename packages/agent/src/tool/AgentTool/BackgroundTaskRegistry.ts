import type { MessageContent, AgentProgressEvent } from '../../types.js'

export interface BackgroundTaskResult {
  content: MessageContent[]
  totalTokens: number
  totalDurationMs: number
  totalToolUseCount: number
}

export interface BackgroundTask {
  taskId: string
  sessionId: string
  agentType: string
  agentName?: string
  status: 'running' | 'completed' | 'failed'
  result?: BackgroundTaskResult
  error?: string
  startedAt: number
  completedAt?: number
  onProgress?: (event: AgentProgressEvent) => void
}

export class BackgroundTaskRegistry {
  private tasks = new Map<string, BackgroundTask>()

  register(task: BackgroundTask): void {
    this.tasks.set(task.taskId, task)
  }

  complete(taskId: string, result: BackgroundTaskResult): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.status = 'completed'
      task.result = result
      task.completedAt = Date.now()
    }
  }

  fail(taskId: string, error: string): void {
    const task = this.tasks.get(taskId)
    if (task) {
      task.status = 'failed'
      task.error = error
      task.completedAt = Date.now()
    }
  }

  /**
   * Returns completed or failed tasks and removes them from the registry.
   * This implements the "drain" pattern — once consumed, tasks are gone.
   */
  getCompleted(): BackgroundTask[] {
    const completed: BackgroundTask[] = []
    for (const [id, task] of this.tasks) {
      if (task.status === 'completed' || task.status === 'failed') {
        completed.push(task)
        this.tasks.delete(id)
      }
    }
    return completed
  }

  get(taskId: string): BackgroundTask | undefined {
    return this.tasks.get(taskId)
  }

  getAll(): BackgroundTask[] {
    return [...this.tasks.values()]
  }

  isRunning(taskId: string): boolean {
    return this.tasks.get(taskId)?.status === 'running'
  }

  hasRunning(): boolean {
    for (const task of this.tasks.values()) {
      if (task.status === 'running') return true
    }
    return false
  }
}

export const backgroundTaskRegistry = new BackgroundTaskRegistry()