/**
 * XML tag names used to mark subagent completion notifications in chat
 * message bodies. Mirrors claude-code's task-notification protocol — when
 * a background subagent finishes, the lifecycle layer wraps the result in
 * a <task-notification>...</task-notification> envelope and enqueues it
 * onto the command queue with mode='task-notification'. The main LLM sees
 * a structured system message instead of free-form text that could be
 * mistaken for a user prompt.
 *
 * The renderer also reads these tags to decide whether to display the
 * entry as a regular chat bubble or as a system notification row in
 * TaskDrawer. See src/lib/stream-session-manager.ts and
 * src/components/layout/TaskDrawer.tsx for the consumers.
 */

export const TASK_NOTIFICATION_TAG = 'task-notification'
export const TASK_ID_TAG = 'task-id'
export const TOOL_USE_ID_TAG = 'tool-use-id'
export const TASK_TYPE_TAG = 'task-type'
export const OUTPUT_FILE_TAG = 'output-file'
export const STATUS_TAG = 'status'
export const SUMMARY_TAG = 'summary'
export const REASON_TAG = 'reason'
export const WORKTREE_TAG = 'worktree'
export const WORKTREE_PATH_TAG = 'worktreePath'
export const WORKTREE_BRANCH_TAG = 'worktreeBranch'

/** Status values reported inside <status>...</status>. */
export const TASK_NOTIFICATION_STATUS = {
  completed: 'completed',
  failed: 'failed',
  killed: 'killed',
} as const

export type TaskNotificationStatus =
  (typeof TASK_NOTIFICATION_STATUS)[keyof typeof TASK_NOTIFICATION_STATUS]