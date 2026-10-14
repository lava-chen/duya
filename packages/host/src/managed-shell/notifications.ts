import { randomUUID } from 'node:crypto';
import type { HostLocalMailboxApiV1 } from '@duya/agent-protocol/mailbox';

const TASK_NOTIFICATION_TAG = 'task-notification';
const TASK_ID_TAG = 'task-id';
const TASK_TYPE_TAG = 'task-type';
const OUTPUT_FILE_TAG = 'output-file';
const STATUS_TAG = 'status';
const SUMMARY_TAG = 'summary';

export interface ShellTaskNotification {
  readonly taskId: string;
  readonly sessionId: string;
  readonly command: string;
  readonly outputFile: string;
  readonly exitCode: number;
  readonly status: 'completed' | 'failed' | 'timeout' | 'canceled';
  readonly text: string;
  readonly spawnError?: string;
}

export interface ManagedShellNotificationLogger {
  warn(message: string, context?: Record<string, unknown>): void;
}

/** Build the same shell completion envelope consumed by the task drawer and run mailbox. */
export function buildShellTaskNotificationXml(input: ShellTaskNotification): string {
  const command = input.command.slice(0, 200);
  const completed = input.status === 'completed';
  const head = completed
    ? `Background command completed with exit code ${input.exitCode}.`
    : input.status === 'timeout'
      ? `Background command timed out (exit code ${input.exitCode}).`
      : input.status === 'canceled'
        ? 'Background command was cancelled.'
        : `Background command failed with exit code ${input.exitCode}.`;
  const detail = input.spawnError ? `\n${input.spawnError}` : '';
  const tail = input.text.length > 3_000 ? `…${input.text.slice(-3_000)}` : input.text;
  const finalMessage = `${head}${detail}${tail ? `\n\n${tail}` : ''}`;
  const status = completed ? 'completed' : 'failed';
  const sections = [
    `<${TASK_ID_TAG}>${escapeXml(input.taskId)}</${TASK_ID_TAG}>`,
    `<${TASK_TYPE_TAG}>bash</${TASK_TYPE_TAG}>`,
    `<${OUTPUT_FILE_TAG}>${escapeXml(input.outputFile)}</${OUTPUT_FILE_TAG}>`,
    `<${STATUS_TAG}>${status}</${STATUS_TAG}>`,
    `<${SUMMARY_TAG}>${escapeXml(completed
      ? `Agent "${command}" completed`
      : `Agent "${command}" failed: Unknown error`)}</${SUMMARY_TAG}>`,
    `<result>${escapeXml(finalMessage)}</result>`,
  ];
  return `<${TASK_NOTIFICATION_TAG}>\n${sections.join('\n')}\n</${TASK_NOTIFICATION_TAG}>`;
}

/** Best-effort, idempotent mailbox delivery for a shell completion. */
export async function sendHostShellNotification(
  mailbox: Pick<HostLocalMailboxApiV1, 'enqueue'>,
  input: ShellTaskNotification,
  logger?: ManagedShellNotificationLogger,
): Promise<void> {
  try {
    await mailbox.enqueue({
      id: randomUUID(),
      sessionId: input.sessionId,
      submittedRunId: '',
      content: buildShellTaskNotificationXml(input),
      kind: 'background_notification',
      source: 'system',
      clientMsgId: input.taskId,
    });
  } catch (error) {
    logger?.warn(`background notification write failed for task ${input.taskId}`, {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}
