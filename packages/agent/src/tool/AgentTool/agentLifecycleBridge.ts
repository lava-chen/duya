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

export interface AgentProgressPayloadMeta {
  /** Parent (calling) session id — goes into the top-level `sessionId` */
  parentSessionId: string
  /** Sub-agent's own session id — goes into `agentSessionId` */
  subAgentSessionId: string
  /** Stable per-task identifier the UI uses to key the card */
  agentId: string
  agentType: string
  agentName?: string
  agentDescription?: string
}

/**
 * Build the wire-format payload for a `chat:agent_progress` SSE event.
 *
 * The worker emits this shape (flat, with `agentEventType` / `agentSessionId`),
 * the agent server's router unwraps it into `{ type: 'agent_progress', data }`
 * over SSE, and the renderer's `handleAgentProgressEvent` remaps the fields
 * back to the canonical `AgentProgressEvent` shape. Keep this function as the
 * single source of truth so the contract is testable in isolation.
 */
export function buildChatAgentProgressPayload(
  event: AgentProgressEvent,
  meta: AgentProgressPayloadMeta,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {
    type: 'chat:agent_progress',
    sessionId: meta.parentSessionId,
    agentEventType: event.type,
    agentId: event.agentId ?? meta.agentId,
    agentType: meta.agentType,
    agentName: meta.agentName,
    agentDescription: meta.agentDescription,
    agentSessionId: meta.subAgentSessionId,
  }
  if (event.duration !== undefined) payload.duration = event.duration
  if (event.data !== undefined) payload.data = event.data
  if (event.toolName !== undefined) payload.toolName = event.toolName
  if (event.toolInput !== undefined) payload.toolInput = event.toolInput
  if (event.toolResult !== undefined) payload.toolResult = event.toolResult
  return payload
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