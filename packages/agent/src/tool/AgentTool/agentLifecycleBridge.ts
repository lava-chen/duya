import { ProgressTracker } from '../../lifecycle/ProgressTracker.js'
import { OutputFileWriter } from '../../lifecycle/OutputFileWriter.js'
import { logger } from '../../utils/logger.js'
import type { AgentProgressEvent } from './runAgent.js'
import type { Message } from '../../types.js'
import type { TaskRecord } from '../../lifecycle/TaskState.js'

export interface BridgeDeps {
  record: TaskRecord
  onProgress?: (event: AgentProgressEvent) => void
}

export async function applyProgressEvent(deps: BridgeDeps, event: AgentProgressEvent): Promise<void> {
  const { record, onProgress } = deps
  // Always forward to the in-process onProgress hook
  try { onProgress?.(event) } catch (err) { logger.warn('bridge onProgress threw', { err }) }

  // Update progress snapshot
  if (event.type === 'tool_use' && event.toolName) {
    record.progress = ProgressTracker.recordToolUse(
      record.progress, event.toolName, String(event.toolInput?.description ?? event.toolName), Date.now()
    )
  }

  // Append to file (best-effort, never break the stream)
  try {
    await OutputFileWriter.append(record.outputFilePath, { at: Date.now(), type: event.type, payload: event })
  } catch (err) {
    logger.warn('OutputFileWriter.append failed', { taskId: record.taskId, err })
  }
}

export function extractResultFromLastMessage(lastMessage: Message | undefined): NonNullable<TaskRecord['result']> {
  if (!lastMessage) {
    return { content: [{ type: 'text', text: '[Agent completed with no output.]' }], totalDurationMs: 0, totalToolUseCount: 0 }
  }
  let content: Array<{ type: 'text'; text: string }> = []
  if (Array.isArray(lastMessage.content)) {
    content = lastMessage.content.filter(
      (b): b is { type: 'text'; text: string } => b.type === 'text' && typeof (b as { text: string }).text === 'string'
    )
  } else if (typeof lastMessage.content === 'string') {
    content = [{ type: 'text', text: lastMessage.content }]
  }
  const metadata = (lastMessage as { metadata?: Record<string, unknown> }).metadata ?? {}
  return {
    content,
    totalDurationMs: (metadata.agentDurationMs as number) ?? 0,
    totalToolUseCount: (metadata.agentToolCallCount as number) ?? 0,
  }
}