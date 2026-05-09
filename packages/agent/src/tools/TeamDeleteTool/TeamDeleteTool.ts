/**
 * TeamDeleteTool - Deletes a team and cleans up resources
 * Adapted from claude-code-haha for duya
 */

import type { Tool, ToolResult } from '../../types.js';
import type { ToolExecutor } from '../../tool/registry.js';
import { TEAM_LEAD_NAME } from '../../swarm/constants.js';
import {
  cleanupTeamDirectories,
  readTeamFile,
  unregisterTeamForSessionCleanup,
} from '../../swarm/teamHelpers.js';
import { TEAM_DELETE_TOOL_NAME } from './constants.js';

export type Output = {
  success: boolean;
  message: string;
  team_name?: string;
};

export class TeamDeleteTool implements Tool, ToolExecutor {
  readonly name = TEAM_DELETE_TOOL_NAME;
  readonly description = 'Clean up team and task directories when the swarm is complete';
  readonly input_schema: Record<string, unknown> = {
    type: 'object',
    properties: {},
  };

  toTool(): Tool {
    return {
      name: this.name,
      description: this.description,
      input_schema: this.input_schema,
    };
  }

  async execute(): Promise<ToolResult> {
    // In duya, we don't have AppState/teamContext
    // so we need to determine the team name from the environment or state
    const teamName = process.env.duya_TEAM_NAME;

    if (teamName) {
      const teamFile = readTeamFile(teamName);
      if (teamFile) {
        // Filter out the team lead - only count non-lead members
        const nonLeadMembers = teamFile.members.filter(
          (m) => m.name !== TEAM_LEAD_NAME,
        );

        // Separate truly active members from idle/dead ones
        const activeMembers = nonLeadMembers.filter((m) => m.isActive !== false);

        if (activeMembers.length > 0) {
          const memberNames = activeMembers.map((m) => m.name).join(', ');
          return {
            id: crypto.randomUUID(),
            name: this.name,
            result: JSON.stringify({
              success: false,
              message: `Cannot cleanup team with ${activeMembers.length} active member(s): ${memberNames}. Use requestShutdown to gracefully terminate teammates first.`,
              team_name: teamName,
            }),
            error: true,
          };
        }
      }

      await cleanupTeamDirectories(teamName);
      unregisterTeamForSessionCleanup(teamName);
    }

    return {
      id: crypto.randomUUID(),
      name: this.name,
      result: JSON.stringify({
        success: true,
        message: teamName
          ? `Cleaned up directories and worktrees for team "${teamName}"`
          : 'No team name found, nothing to clean up',
        team_name: teamName,
      }),
    };
  }
}

// Export for use by other modules
export const teamDeleteTool = new TeamDeleteTool();
