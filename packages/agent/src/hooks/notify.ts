/**
 * notify.ts — Deliver a settled background hook task into the session.
 *
 * `asyncRewake: true` hook tasks deliver their result the same way
 * background bash commands / sub-agents do: a durable
 * `<task-notification>` mailbox row (sendBackgroundNotification). The
 * running agent claims it at the next `before_model_turn` /
 * `before_final_answer` checkpoint, injects it into the model context, and
 * wakes the renderer — the hook result "arrives" in the session message
 * stream like a follow-up or a steering nudge, without the agent ever
 * having waited for it.
 *
 * Fail-open: a broken notification is logged and the result remains
 * readable from the task's output file.
 */

import { buildTaskNotificationXml, DEFAULT_MAX_RESULT_CHARS } from '../lifecycle/buildTaskNotification.js';
import { sendBackgroundNotification } from '../lifecycle/mailboxBackgroundNotification.js';
import type { HookBackgroundTask } from './task-registry.js';
import { logger } from '../utils/logger.js';

/**
 * Emit the completion notification for a settled background hook task.
 * No-op when the task did not opt into rewaking.
 *
 * Only COMPLETED (exit 0) tasks deliver a `<task-notification>` to the
 * agent. A failed / killed background hook is logged and stays visible in
 * the task registry + Settings → Hooks, but its raw crash text is NEVER
 * injected into the model context — otherwise a broken hook (e.g. a
 * missing script) spams a fresh failure notification into every turn
 * (bug report 2026-08-19 #8).
 *
 * @param task      The settled task (status completed/error/killed).
 * @param context   additionalContext to inline (stdout-derived), optional.
 */
export async function notifyHookTaskSettled(
  task: HookBackgroundTask,
  context?: string,
): Promise<void> {
  if (!task.rewake) return;

  if (task.status !== 'completed') {
    logger.warn(
      `[Hooks] background ${task.event} hook failed (task ${task.id}) — not delivered to the agent: ` +
        `${task.error ?? 'unknown error'}`,
    );
    return;
  }

  const xml = buildTaskNotificationXml({
    taskId: task.id,
    status: 'completed',
    agentType: 'hook',
    agentName: task.hookType,
    description: task.event,
    outputFilePath: task.outputFile,
    finalMessage: context,
    error: undefined,
    maxResultChars: DEFAULT_MAX_RESULT_CHARS,
  });

  try {
    await sendBackgroundNotification({
      sessionId: task.sessionId,
      taskId: task.id, // idempotent (unique index on session_id + client_msg_id)
      xml,
    });
    logger.debug(
      `[Hooks] background notification delivered for task ${task.id} (status=${task.status})`,
    );
  } catch (err) {
    logger.warn(
      `[Hooks] background notification failed for task ${task.id}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }
}
