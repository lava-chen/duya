/**
 * MCP Skill Integration for duya Agent
 * Loads skills from MCP servers
 * Adapted from claude-code-haha/src/skills/mcpSkillBuilders.ts
 */

import type { ToolUseContext } from '../types.js';
import type { PromptSkill } from './types.js';
import { getSkillRegistry } from './registry.js';

/**
 * MCP skill command interface
 */
interface McpSkillCommand {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

/**
 * Register skills from an MCP server
 */
export function registerMcpSkills(
  serverName: string,
  commands: McpSkillCommand[],
): void {
  const registry = getSkillRegistry();

  for (const cmd of commands) {
    const skillName = `mcp__${serverName}__${cmd.name}`;

    const skill: PromptSkill = {
      type: 'prompt',
      name: skillName,
      description: cmd.description || `MCP skill from ${serverName}`,
      source: 'mcp',
      userInvocable: true,
      isHidden: false,
      allowedTools: undefined,
      async getPromptForCommand(args, _context): Promise<string> {
        // The actual prompt content is loaded dynamically
        // This is a placeholder that gets replaced with actual MCP content
        let prompt = `[Executing MCP skill: ${cmd.name}]\n`;
        if (args) {
          prompt += `\nArguments: ${args}\n`;
        }
        prompt += `\nNote: This skill requires the MCP server "${serverName}" to be connected.`;
        return prompt;
      },
    };

    registry.register(skill);
  }
}

/**
 * Unregister skills from an MCP server
 */
export function unregisterMcpSkills(serverName: string): void {
  const registry = getSkillRegistry();
  const prefix = `mcp__${serverName}__`;

  // Find and remove all skills with this prefix
  const skills = registry.list();
  for (const skill of skills) {
    if (skill.name.startsWith(prefix)) {
      registry.unregister(skill.name);
    }
  }
}

/**
 * Get all MCP skill names for a server
 */
export function getMcpSkillNames(serverName: string): string[] {
  const registry = getSkillRegistry();
  const prefix = `mcp__${serverName}__`;

  return registry
    .list()
    .filter(s => s.name.startsWith(prefix))
    .map(s => s.name);
}

/**
 * Create an MCP skill prompt handler
 * This is called by the MCP client when a skill is invoked
 */
export function createMcpSkillHandler(
  serverName: string,
  skillName: string,
  getContent: () => Promise<string>,
): void {
  const registry = getSkillRegistry();
  const fullName = `mcp__${serverName}__${skillName}`;

  const existing = registry.get(fullName);
  if (existing) {
    // Override the getPromptForCommand
    const originalSkill = existing;
    const updatedSkill: PromptSkill = {
      ...originalSkill,
      getPromptForCommand: async (args, context) => {
        const content = await getContent();
        let finalContent = content;

        // Substitute arguments
        if (args) {
          finalContent = finalContent.replace(/\$ARGUMENTS/g, args);
        }

        return finalContent;
      },
    };

    registry.unregister(fullName);
    registry.register(updatedSkill);
  }
}
