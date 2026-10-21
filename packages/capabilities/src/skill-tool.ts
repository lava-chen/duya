import { z } from 'zod';
import { BaseTool } from './BaseTool.js';
import type { ToolResult } from './contracts/tool.js';

export const SKILL_TOOL_NAME = 'Skill';
export const COMMAND_NAME_TAG = 'command-name';

export function getSkillToolPrompt(): string {
  return `Load instructions for one skill listed in the current Skills catalog.

Use an exact catalog name and optional arguments. The result contains the skill's full instructions; follow them only after it is returned. Do not invoke a skill merely because its name is adjacent to the task, and do not claim to have used one unless this tool was called.

If a <${COMMAND_NAME_TAG}> tag is already present in the current turn, that skill is loaded; follow its instructions rather than loading it again.`;
}

export interface SkillToolPromptContext {
  toolUseId: string;
  abortController: AbortController;
  getAppState: () => Record<string, never>;
  setAppState: () => void;
  options: {
    tools: never[];
    commands: never[];
    mainLoopModel: string;
    mcpClients: never[];
  };
}

export interface SkillToolPromptSource {
  name: string;
  disableModelInvocation?: boolean;
  isConditional?: boolean;
  context?: 'inline' | 'fork';
  allowedTools?: string[];
  model?: string;
  getPromptForCommand(args: string, context: unknown): Promise<string>;
}

/** Skill catalog and prompt loading stay in Host; the executor sees only this port. */
export interface SkillToolPort {
  getSkill(name: string): SkillToolPromptSource | undefined;
  listModelInvocable(): readonly { name: string }[];
}

const inputSchema = z.object({
  skill: z.string().describe('The skill name (e.g., "pdf", "commit", or "mcp__server__skill")'),
  args: z.string().optional().describe('Optional arguments for the skill'),
});

export type SkillToolInput = z.infer<typeof inputSchema>;

function makePromptContext(mainLoopModel: string): SkillToolPromptContext {
  return {
    toolUseId: crypto.randomUUID(),
    abortController: new AbortController(),
    getAppState: () => ({}),
    setAppState: () => {},
    options: {
      tools: [],
      commands: [],
      mainLoopModel,
      mcpClients: [],
    },
  };
}

export class SkillTool extends BaseTool {
  readonly name = SKILL_TOOL_NAME;
  readonly description = 'Load the instructions for an available skill.';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      skill: {
        type: 'string',
        description: 'An exact name from the current Skills catalog.',
      },
      args: {
        type: 'string',
        description: 'Optional arguments for the skill',
      },
    },
    required: ['skill'],
  };

  constructor(private readonly port: SkillToolPort) {
    super();
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const parsed = inputSchema.safeParse(input);
    if (!parsed.success) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Invalid input: ${parsed.error.message}` }),
        error: true,
      };
    }

    const { skill: skillName, args } = parsed.data;
    const normalizedName = skillName.startsWith('/') ? skillName.slice(1) : skillName;
    const skill = this.port.getSkill(normalizedName);
    if (!skill) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Unknown skill: ${normalizedName}`,
          availableSkills: this.port.listModelInvocable().map((available) => available.name),
        }),
        error: true,
      };
    }

    if (skill.disableModelInvocation) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: `Skill ${normalizedName} cannot be invoked automatically` }),
        error: true,
      };
    }

    if (skill.isConditional) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          error: `Skill ${normalizedName} is conditionally available and not yet activated (no matching file was operated on)`,
          availableSkills: this.port.listModelInvocable().map((available) => available.name),
        }),
        error: true,
      };
    }

    const content = await skill.getPromptForCommand(
      args || '',
      makePromptContext(skill.context === 'fork' ? skill.model || '' : ''),
    );
    if (skill.context === 'fork') {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({
          success: true,
          commandName: normalizedName,
          status: 'forked',
          agentId: crypto.randomUUID(),
          result: content,
        }),
      };
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        success: true,
        commandName: normalizedName,
        status: 'inline',
        allowedTools: skill.allowedTools,
        model: skill.model,
        content,
      }),
    };
  }
}
