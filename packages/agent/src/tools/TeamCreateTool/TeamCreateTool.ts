/**
 * TeamCreateTool - Creates a team of agents
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';
import { TEAM_LEAD_NAME } from '../../swarm/constants.js';
import {
  getTeamFilePath,
  readTeamFile,
  registerTeamForSessionCleanup,
  writeTeamFileAsync,
  type TeamFile,
} from '../../swarm/teamHelpers.js';
import { TEAM_CREATE_TOOL_NAME } from './constants.js';

export interface TeamCreateInput {
  team_name: string;
  description?: string;
  agent_type?: string;
}

export type Output = {
  team_name: string;
  team_file_path: string;
  lead_agent_id: string;
};

/**
 * Generates a unique team name by checking if the provided name already exists.
 * If the name already exists, generates a new word slug.
 */
function generateUniqueTeamName(providedName: string): string {
  if (!readTeamFile(providedName)) {
    return providedName;
  }
  return generateWordSlug();
}

/**
 * Format agent ID for the team lead
 */
function formatAgentId(name: string, teamName: string): string {
  return `${name}@${teamName}`;
}

/**
 * Simple word slug generator for unique names
 */
function generateWordSlug(): string {
  const adjectives = ['quick', 'bold', 'smart', 'bright', 'swift', 'keen', 'agile', 'steady'];
  const nouns = ['fox', 'eagle', 'lion', 'wolf', 'bear', 'hawk', 'deer', 'owl'];
  const adj = adjectives[Math.floor(Math.random() * adjectives.length)]!;
  const noun = nouns[Math.floor(Math.random() * nouns.length)]!;
  const num = Math.floor(Math.random() * 1000);
  return `${adj}-${noun}-${num}`;
}

/**
 * Get current working directory
 */
function getCwd(): string {
  return process.cwd();
}

/**
 * Get session ID (stub for duya)
 */
function getSessionId(): string {
  return `session-${Date.now()}`;
}

export class TeamCreateTool implements Tool, ToolExecutor {
  readonly name = TEAM_CREATE_TOOL_NAME;
  readonly description = 'Create a new team for coordinating multiple agents';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {
      team_name: {
        type: 'string',
        description: 'Name for the new team to create.',
      },
      description: {
        type: 'string',
        description: 'Team description/purpose.',
      },
      agent_type: {
        type: 'string',
        description:
          'Type/role of the team lead (e.g., "researcher", "test-runner"). ' +
          'Used for team file and inter-agent coordination.',
      },
    },
    required: ['team_name'],
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(input: Record<string, unknown>): Promise<ToolResult> {
    const { team_name, description, agent_type } = input as unknown as TeamCreateInput;

    if (!team_name || team_name.trim().length === 0) {
      return {
        id: crypto.randomUUID(),
        name: this.name,
        result: JSON.stringify({ error: 'team_name is required for TeamCreate' }),
        error: true,
      };
    }

    const finalTeamName = generateUniqueTeamName(team_name);
    const leadAgentId = formatAgentId(TEAM_LEAD_NAME, finalTeamName);
    const leadAgentType = agent_type || TEAM_LEAD_NAME;
    const teamFilePath = getTeamFilePath(finalTeamName);

    const teamFile: TeamFile = {
      name: finalTeamName,
      description,
      createdAt: Date.now(),
      leadAgentId,
      leadSessionId: getSessionId(),
      members: [
        {
          agentId: leadAgentId,
          name: TEAM_LEAD_NAME,
          agentType: leadAgentType,
          model: 'claude',
          joinedAt: Date.now(),
          tmuxPaneId: '',
          cwd: getCwd(),
          subscriptions: [],
        },
      ],
    };

    await writeTeamFileAsync(finalTeamName, teamFile);
    registerTeamForSessionCleanup(finalTeamName);

    const output: Output = {
      team_name: finalTeamName,
      team_file_path: teamFilePath,
      lead_agent_id: leadAgentId,
    };

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify(output),
    };
  }
}

// Export for use by other modules
export const teamCreateTool = new TeamCreateTool();
