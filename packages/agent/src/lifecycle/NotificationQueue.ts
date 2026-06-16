import type { TaskRecord } from './TaskState.js'

export class NotificationQueue {
  private buffer: TaskRecord[] = []

  enqueue(record: TaskRecord): void {
    this.buffer.push(record)
  }

  drain(): TaskRecord[] {
    const out = this.buffer
    this.buffer = []
    return out
  }
}