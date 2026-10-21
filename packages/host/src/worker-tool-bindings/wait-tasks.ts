import type { Tool, ToolResult, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolExecutor } from '@duya/host/worker-tool-registry';
import {
  WaitTasksTool as CapabilityWaitTasksTool,
  WAIT_TASKS_TOOL_NAME,
} from '@duya/capabilities/background-task-tool';
import { createWorkerBackgroundTaskPort } from '@duya/host/worker-tool-services/background-task';
import { DEFAULT_WAIT_TIMEOUT_MS } from '@duya/host/worker-tool-bindings/get-task-output';

export { WAIT_TASKS_TOOL_NAME, DEFAULT_WAIT_TIMEOUT_MS };

export class WaitTasksTool implements Tool, ToolExecutor {
  private readonly delegate = new CapabilityWaitTasksTool(createWorkerBackgroundTaskPort());

  readonly name = WAIT_TASKS_TOOL_NAME;
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

export const waitTasksTool = new WaitTasksTool();
