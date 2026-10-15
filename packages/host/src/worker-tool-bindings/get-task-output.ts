import type { Tool, ToolResult, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolExecutor } from '@duya/host/worker-tool-registry';
import {
  GetTaskOutputTool as CapabilityGetTaskOutputTool,
  DEFAULT_TOOL_OUTPUT_BYTES,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_MULTI_TASK_IDS,
  formatAgentTaskOutput,
  formatShellTaskOutput,
  isTerminalStatus,
  mapShellTaskStatus,
  type BackgroundAgentTaskSnapshot,
  type BackgroundShellTaskSnapshot,
  type BackgroundShellTaskStatus,
  type BackgroundTaskStatus,
} from '@duya/capabilities/background-task-tool';
import { GET_TASK_OUTPUT_TOOL_NAME } from '@duya/agent-core/task-notifications/tool-names';
import { createWorkerBackgroundTaskPort } from '@duya/host/worker-tool-services/background-task';

export {
  DEFAULT_TOOL_OUTPUT_BYTES,
  DEFAULT_WAIT_TIMEOUT_MS,
  MAX_MULTI_TASK_IDS,
  isTerminalStatus,
};
export { GET_TASK_OUTPUT_TOOL_NAME };
export type { BackgroundTaskStatus as TaskStatus };

/** Compatibility formatting helper for older Agent consumers. */
export function formatTaskOutput(task: BackgroundAgentTaskSnapshot): string {
  return formatAgentTaskOutput(task);
}

/** Compatibility status mapper retained while legacy callers are removed. */
export function mapBashTaskStatus(status: BackgroundShellTaskStatus): BackgroundTaskStatus {
  return mapShellTaskStatus(status);
}

/** Compatibility helper binds the shell output read to the Host registry. */
export function formatBashTaskOutput(
  task: BackgroundShellTaskSnapshot,
  maxBytes: number = DEFAULT_TOOL_OUTPUT_BYTES,
): string {
  return formatShellTaskOutput(task, createWorkerBackgroundTaskPort().readShellOutput, maxBytes);
}

export class GetTaskOutputTool implements Tool, ToolExecutor {
  private readonly delegate = new CapabilityGetTaskOutputTool(createWorkerBackgroundTaskPort());

  readonly name = GET_TASK_OUTPUT_TOOL_NAME;
  readonly description = this.delegate.description;
  readonly input_schema: Record<string, unknown> = this.delegate.input_schema;

  toTool(): Tool {
    return { name: this.name, description: this.description, input_schema: this.input_schema };
  }

  execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    void workingDirectory;
    void context;
    return this.delegate.execute(input);
  }
}

export const getTaskOutputTool = new GetTaskOutputTool();
