/**
 * mailboxBackgroundNotification.ts — Write a `background_notification` mailbox
 * row for a completed / failed / killed background task.
 *
 * Background sub-agents (BackgroundAgentLifecycle), background bash commands
 * (WorkerPool), and BashTool's background mode all deliver their terminal
 * <task-notification> envelope through the mailbox instead of the old
 * process-local queue. This gives them the same persistence and checkpoint
 * pickup as user followups: the row is durable, claimed by the running agent
 * at `before_model_turn` / `before_final_answer`, and wakes the renderer to
 * resume the parent session when idle.
 *
 * The `content` is the raw <task-notification> XML envelope so the renderer
 * and model parsing stay identical to before. `clientMsgId = taskId` makes the
 * write idempotent at the DB level (unique index on session_id + client_msg_id).
 */
import { randomUUID } from 'node:crypto';
import { mailboxDb } from '../ipc/db-client.js';
import { logger } from '../utils/logger.js';

export interface SendBackgroundNotificationInput {
  /** Parent session id that owns the background task (the session to wake). */
  sessionId: string;
  /** The <task-notification>...</task-notification> XML envelope. */
  xml: string;
  /** Stable task id — used as the idempotency key (client_msg_id). */
  taskId: string;
}

/**
 * Best-effort mailbox write. Never throws: a failed notification is logged and
 * the parent still gets its results via the sub-agent session / output file.
 */
export async function sendBackgroundNotification(input: SendBackgroundNotificationInput): Promise<void> {
  try {
    await mailboxDb.send({
      id: randomUUID(),
      sessionId: input.sessionId,
      submittedDuringRunId: '',
      content: input.xml,
      kind: 'background_notification',
      source: 'system',
      clientMsgId: input.taskId,
    });
  } catch (err) {
    logger.warn(
      `[AgentMailbox] background_notification write failed for task ${input.taskId}: ${
        err instanceof Error ? err.message : String(err)
      }`,
      undefined,
      'AgentMailbox',
    );
  }
}