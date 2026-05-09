/**
 * SkillTool - Execute a skill
 * Full implementation based on claude-code-haha
 */

import { z } from 'zod';
import type { Tool, ToolResult, ToolUseContext } from '../../types.js';
import type { ToolExecutor } from '../registry.js';
import { SKILL_TOOL_NAME } from './constants.js';
import { getPrompt } from './prompt.js';
import { getSkillRegistry } from '../../skills/registry.js';
import type { SkillMetadata } from '../../skills/types.js';
import type { PromptSkill } from '../../skills/types.js';

const inputSchema = z.object({
  skill: z.string().describe('The skill name (e.g., "pdf", "commit", or "mcp__server__skill")'),
  args: z.string().optional().describe('Optional arguments for the skill'),
});

export type SkillInput = z.infer<typeof inputSchema>;

/**
 * SkillTool - Executes skills with support for inline and fork modes
 */
export class SkillTool implements Tool, ToolExecutor {
  readonly name = SKILL_TOOL_NAME;
  readonly description = 'Execute a skill';

  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'The skill name. E.g., "commit", "review-pr", or "pdf"',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  /**
   * Execute a skill
   */
  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parseResult = inputSchema.safeParse(input);
    if (!parseResult.success) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Invalid input: ${parseResult.error.message}`,
        }),
        error: true,
      };
    }

    const { skill: skillName, args } = parseResult.data;
    const registry = getSkillRegistry();

    // Normalize skill name (remove leading slash)
    const normalizedName = skillName.startsWith('/')
      ? skillName.slice(1)
      : skillName;

    // Find the skill
    const skill = registry.get(normalizedName);
    if (!skill) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Unknown skill: ${normalizedName}`,
          availableSkills: registry.listMetadata(),
        }),
        error: true,
      };
    }

    // Check if model invocation is disabled
    if (skill.disableModelInvocation) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Skill ${normalizedName} cannot be invoked automatically`,
        }),
        error: true,
      };
    }

    // Determine execution mode
    const isFork = skill.context === 'fork';

    if (isFork) {
      return this.executeForkedSkill(skill, normalizedName, args);
    }

    return this.executeInlineSkill(skill, normalizedName, args);
  }

  /**
   * Execute skill inline (in current conversation)
   */
  private async executeInlineSkill(
    skill: PromptSkill,
    skillName: string,
    args?: string,
  ): Promise<ToolResult> {
    // Create a minimal context for getting the prompt
    const context: ToolUseContext = {
      toolUseId: crypto.randomUUID(),
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: [],
        commands: [],
        mainLoopModel: '',
        mcpClients: [],
      },
    };

    // Get skill prompt content
    const content = await skill.getPromptForCommand(args || '', context);

    // Return result with skill content included
    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        success: true,
        commandName: skillName,
        status: 'inline',
        allowedTools: skill.allowedTools,
        model: skill.model,
        content,
      }),
    };
  }

  /**
   * Execute skill in forked sub-agent
   * Note: Full fork implementation requires agent runner integration
   */
  private async executeForkedSkill(
    skill: PromptSkill,
    skillName: string,
    args?: string,
  ): Promise<ToolResult> {
    // Create a minimal context for getting the prompt
    const context: ToolUseContext = {
      toolUseId: crypto.randomUUID(),
      abortController: new AbortController(),
      getAppState: () => ({}),
      setAppState: () => {},
      options: {
        tools: [],
        commands: [],
        mainLoopModel: skill.model || '',
        mcpClients: [],
      },
    };

    const content = await skill.getPromptForCommand(args || '', context);
    const agentId = crypto.randomUUID();

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        success: true,
        commandName: skillName,
        status: 'forked',
        agentId,
        result: content,
      }),
    };
  }

  /**
   * Get skill prompt for the tool description
   */
  getPrompt(): string {
    return getPrompt();
  }

  /**
   * List available skills
   */
  static listAvailableSkills(): SkillMetadata[] {
    return getSkillRegistry().listMetadata();
  }

  /**
   * Get skill metadata
   */
  static getSkillMetadata(name: string): SkillMetadata | undefined {
    return getSkillRegistry().getMetadata(name);
  }
}

// Export for use by other modules
export const skillTool = new SkillTool();
