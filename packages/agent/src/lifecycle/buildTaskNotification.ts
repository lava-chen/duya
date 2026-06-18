/**
 * Build a <task-notification>...</task-notification> XML envelope for a
 * completed/failed/killed background subagent. Mirrors claude-code's
 * protocol so the main LLM (and renderer) can recognize a system
 * notification distinct from a user prompt.
 *
 * Caller is responsible for enqueueing the result via
 * enqueuePendingNotification() (mode='task-notification', priority='later').
 * BackgroundAgentLifecycle.run() does both.
 *
 * Token frugality: when `maxResultChars` is set and `finalMessage`
 * exceeds it, the inlined <result> is replaced with a pointer to
 * `<output-file>` so the LLM can Read the full transcript on demand
 * instead of consuming context on every notification.
 */
import {
  OUTPUT_FILE_TAG,
  STATUS_TAG,
  SUMMARY_TAG,
  TASK_ID_TAG,
  TASK_NOTIFICATION_TAG,
  TASK_TYPE_TAG,
  TOOL_USE_ID_TAG,
  WORKTREE_BRANCH_TAG,
  WORKTREE_PATH_TAG,
  WORKTREE_TAG,
  type TaskNotificationStatus,
} from '../constants/taskNotificationXml.js'

/** Default inlined budget for <result>. ~4 KB keeps a 200K-context
 * conversation safe even with a dozen concurrent subagent completions. */
export const DEFAULT_MAX_RESULT_CHARS = 4000

export interface BuildTaskNotificationInput {
  taskId: string
  status: TaskNotificationStatus
  agentType: string
  /** Human-readable name (e.g. "general-purpose" or user-supplied). */
  agentName?: string
  /** Short description for the <summary> line, e.g. "research task". */
  description?: string
  /** Path to the on-disk transcript the LLM can read for full output. */
  outputFilePath: string
  /** The assistant tool_use_id that originally spawned this subagent. */
  toolUseId?: string
  /** Final assistant text. Long values are replaced by an output-file
   * pointer when `maxResultChars` is exceeded. */
  finalMessage?: string
  totalToolUseCount?: number
  totalDurationMs?: number
  /** Total token usage. duya's TaskRecord doesn't track this yet — leave
   * undefined to omit <usage>. */
  totalTokens?: number
  worktreePath?: string
  worktreeBranch?: string
  /** Error message for status='failed' / status='killed'. */
  error?: string
  /** Inline cap for the <result> tag. Set to `0` to always truncate.
   * Defaults to DEFAULT_MAX_RESULT_CHARS. */
  maxResultChars?: number
}

export function buildTaskNotificationXml(input: BuildTaskNotificationInput): string {
  const summaryText = buildSummary(input)
  const sections: string[] = [
    `<${TASK_ID_TAG}>${escape(input.taskId)}</${TASK_ID_TAG}>`,
  ]
  if (input.toolUseId) {
    sections.push(`<${TOOL_USE_ID_TAG}>${escape(input.toolUseId)}</${TOOL_USE_ID_TAG}>`)
  }
  sections.push(`<${TASK_TYPE_TAG}>${escape(input.agentType)}</${TASK_TYPE_TAG}>`)
  sections.push(`<${OUTPUT_FILE_TAG}>${escape(input.outputFilePath)}</${OUTPUT_FILE_TAG}>`)
  sections.push(`<${STATUS_TAG}>${input.status}</${STATUS_TAG}>`)
  sections.push(`<${SUMMARY_TAG}>${escape(summaryText)}</${SUMMARY_TAG}>`)
  const resultXml = buildResultXml(input)
  if (resultXml) {
    sections.push(resultXml)
  }
  const usageXml = buildUsageXml(input)
  if (usageXml) {
    sections.push(usageXml)
  }
  const worktreeXml = buildWorktreeXml(input)
  if (worktreeXml) {
    sections.push(worktreeXml)
  }
  return `<${TASK_NOTIFICATION_TAG}>\n${sections.join('\n')}\n</${TASK_NOTIFICATION_TAG}>`
}

function buildSummary(input: BuildTaskNotificationInput): string {
  const desc = input.description || input.agentName || input.agentType || input.taskId
  if (input.status === 'completed') {
    return `Agent "${desc}" completed`
  }
  if (input.status === 'failed') {
    return `Agent "${desc}" failed: ${input.error || 'Unknown error'}`
  }
  return `Agent "${desc}" was stopped`
}

/**
 * Build the <result>...</result> section. When `finalMessage` exceeds
 * `maxResultChars`, replace it with a pointer to the output file so
 * the LLM can Read the full transcript on demand instead of bloating
 * context. Returns `undefined` when there's no finalMessage at all.
 */
export function buildResultXml(input: BuildTaskNotificationInput): string | undefined {
  const raw = input.finalMessage
  if (!raw) return undefined
  const cap = input.maxResultChars ?? DEFAULT_MAX_RESULT_CHARS
  if (cap <= 0 || raw.length <= cap) {
    return `<result>${escape(raw)}</result>`
  }
  const pointer = `Output is ${raw.length} chars; see <${OUTPUT_FILE_TAG}>${escape(input.outputFilePath)}</${OUTPUT_FILE_TAG}> for full transcript. Use the Read tool to load specific sections as needed.`
  return `<result>${escape(pointer)}</result>`
}

function buildUsageXml(input: BuildTaskNotificationInput): string | undefined {
  const parts: string[] = []
  if (input.totalTokens !== undefined) {
    parts.push(`<total_tokens>${input.totalTokens}</total_tokens>`)
  }
  if (input.totalToolUseCount !== undefined) {
    parts.push(`<tool_uses>${input.totalToolUseCount}</tool_uses>`)
  }
  if (input.totalDurationMs !== undefined) {
    parts.push(`<duration_ms>${input.totalDurationMs}</duration_ms>`)
  }
  if (parts.length === 0) return undefined
  return `<usage>${parts.join('')}</usage>`
}

function buildWorktreeXml(input: BuildTaskNotificationInput): string | undefined {
  if (!input.worktreePath) return undefined
  const inner = [`<${WORKTREE_PATH_TAG}>${escape(input.worktreePath)}</${WORKTREE_PATH_TAG}>`]
  if (input.worktreeBranch) {
    inner.push(`<${WORKTREE_BRANCH_TAG}>${escape(input.worktreeBranch)}</${WORKTREE_BRANCH_TAG}>`)
  }
  return `<${WORKTREE_TAG}>${inner.join('')}</${WORKTREE_TAG}>`
}

/** Minimal XML escape — covers the cases that actually appear in agent
 * output (newlines and angle brackets). Full attribute escaping isn't
 * needed because none of our values come from untrusted attribute inputs. */
function escape(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}