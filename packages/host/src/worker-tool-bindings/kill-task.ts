import type { Tool, ToolResult, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolExecutor } from '@duya/host/worker-tool-registry';
import { KillTaskTool as CapabilityKillTaskTool } from '@duya/capabilities/background-task-tool';
import { KILL_TASK_TOOL_NAME } from '@duya/capabilities/background-task-tool';
import { createWorkerBackgroundTaskPort } from '@duya/host/worker-tool-services/background-task';

export { KILL_TASK_TOOL_NAME };

export class KillTaskTool implements Tool, ToolExecutor {
  private readonly delegate = new CapabilityKillTaskTool(createWorkerBackgroundTaskPort());

  readonly name = KILL_TASK_TOOL_NAME;
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

export const killTaskTool = new KillTaskTool();
