/** Compatibility adapter for Agent's existing BashTool registration path. */
import {
  startManagedShell,
  MANAGED_BASH_NOTIFICATION_TAIL_CHARS,
  MANAGED_BASH_RESULT_READ_BYTES,
  type ManagedBashCompletion,
  type ManagedBashHandle,
  type ManagedBashStatus,
  type StartManagedBashParams,
  type ShellTaskNotification,
} from '@duya/host/managed-shell';
import { getBashTaskRegistry } from '@duya/host/managed-shell';
import { getManagedShellOutputDirectory } from '@duya/host/managed-shell/paths';
import { killProcessTree } from '@duya/host/managed-shell';
import { buildTaskNotificationXml } from '@duya/agent-core/task-notifications/buildTaskNotification';
import { sendBackgroundNotification } from '@duya/host/worker-context/background-notification';

export {
  MANAGED_BASH_NOTIFICATION_TAIL_CHARS,
  MANAGED_BASH_RESULT_READ_BYTES,
  readOutputTail,
} from '@duya/host/managed-shell';
export type {
  ManagedBashCompletion,
  ManagedBashHandle,
  ManagedBashStatus,
  StartManagedBashParams,
} from '@duya/host/managed-shell';

/**
 * Run Host-owned process lifecycle with the existing Agent mailbox transport
 * until the Agent worker is retired from production composition.
 */
export function startManagedBash(params: StartManagedBashParams): Promise<ManagedBashHandle> {
  return startManagedShell(params, {
    outputDirectory: getManagedShellOutputDirectory,
    registry: getBashTaskRegistry(),
    killTree: async (pid) => {
      await killProcessTree(pid);
    },
    notifyCompletion: (input: ShellTaskNotification) => {
      notifyLegacyAgentMailbox(input);
    },
  });
}

function notifyLegacyAgentMailbox(input: ShellTaskNotification): void {
  const status = input.status === 'completed' ? 'completed' : 'failed';
  const head = input.status === 'completed'
    ? `Background command completed with exit code ${input.exitCode}.`
    : input.status === 'timeout'
      ? `Background command timed out (exit code ${input.exitCode}).`
      : input.status === 'canceled'
        ? 'Background command was cancelled.'
        : `Background command failed with exit code ${input.exitCode}.`;
  const detail = input.spawnError ? `\n${input.spawnError}` : '';
  const tail = input.text.length > MANAGED_BASH_NOTIFICATION_TAIL_CHARS
    ? `…${input.text.slice(-MANAGED_BASH_NOTIFICATION_TAIL_CHARS)}`
    : input.text;
  const xml = buildTaskNotificationXml({
    taskId: input.taskId,
    status,
    agentType: 'bash',
    agentName: input.command.slice(0, 200),
    description: input.command.slice(0, 200),
    outputFilePath: input.outputFile,
    finalMessage: `${head}${detail}${tail ? `\n\n${tail}` : ''}`,
  });
  void sendBackgroundNotification({ sessionId: input.sessionId, xml, taskId: input.taskId });
}
