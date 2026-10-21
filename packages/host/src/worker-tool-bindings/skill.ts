import type { Tool, ToolResult, ToolUseContext } from '@duya/host/worker-run-contracts';
import type { ToolExecutor } from '@duya/host/worker-tool-registry';
import {
  SkillTool as CapabilitySkillTool,
  SKILL_TOOL_NAME,
  type SkillToolInput,
} from '@duya/capabilities/skill-tool';
import { createWorkerSkillToolPort, getWorkerSkillMetadata, listWorkerAvailableSkills } from '@duya/host/worker-tool-services/skill';
import { getSkillToolPrompt as getPrompt } from '@duya/capabilities/skill-tool';

export type SkillInput = SkillToolInput;

export class SkillTool implements Tool, ToolExecutor {
  private readonly delegate = new CapabilitySkillTool(createWorkerSkillToolPort());

  readonly name = SKILL_TOOL_NAME;
  readonly description = this.delegate.description;
  readonly input_schema: Record<string, unknown> = this.delegate.input_schema;

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  execute(input: Record<string, unknown>, workingDirectory?: string, context?: ToolUseContext): Promise<ToolResult> {
    void workingDirectory;
    void context;
    return this.delegate.execute(input);
  }

  getPrompt(): string {
    return getPrompt();
  }

  static listAvailableSkills(): ReturnType<typeof listWorkerAvailableSkills> {
    return listWorkerAvailableSkills();
  }

  static getSkillMetadata(name: string): ReturnType<typeof getWorkerSkillMetadata> {
    return getWorkerSkillMetadata(name);
  }
}

export const skillTool = new SkillTool();
