import { describe, expect, it } from 'vitest';
import {
  filterAgentsByMcpRequirements,
  getActiveAgentsFromList,
  hasRequiredMcpServers,
  isBuiltInAgent,
  isCustomAgent,
  type AgentDefinition,
} from '@duya/agent-core/subagents/agent-definition';

function builtIn(agentType: string): AgentDefinition {
  return {
    agentType,
    whenToUse: `built-in ${agentType}`,
    source: 'built-in',
    baseDir: 'built-in',
    getSystemPrompt: () => `built-in prompt for ${agentType}`,
  };
}

function custom(
  agentType: string,
  source: 'userSettings' | 'projectSettings',
  whenToUse: string,
  requiredMcpServers?: string[],
): AgentDefinition {
  return {
    agentType,
    whenToUse,
    source,
    getSystemPrompt: () => `${source} prompt for ${agentType}`,
    ...(requiredMcpServers ? { requiredMcpServers } : {}),
  };
}

describe('canonical AgentDefinition helpers', () => {
  it('classifies built-in and custom definitions from their source', () => {
    const builtin = builtIn('Explore');
    const user = custom('Review', 'userSettings', 'Review a change');

    expect(isBuiltInAgent(builtin)).toBe(true);
    expect(isCustomAgent(builtin)).toBe(false);
    expect(isBuiltInAgent(user)).toBe(false);
    expect(isCustomAgent(user)).toBe(true);
  });

  it('applies project-over-user-over-builtin precedence while preserving type order', () => {
    const builtinExplore = builtIn('Explore');
    const builtinPlan = builtIn('Plan');
    const userExplore = custom('Explore', 'userSettings', 'user override');
    const userReview = custom('Review', 'userSettings', 'user review');
    const projectExplore = custom('Explore', 'projectSettings', 'project override');
    const projectAudit = custom('Audit', 'projectSettings', 'project audit');

    const active = getActiveAgentsFromList([
      userReview,
      projectAudit,
      projectExplore,
      builtinPlan,
      userExplore,
      builtinExplore,
    ]);

    expect(active).toEqual([builtinPlan, projectExplore, userReview, projectAudit]);
  });

  it('requires each configured MCP pattern to match some server case-insensitively', () => {
    const agent = custom('Research', 'userSettings', 'Research with MCP', ['github', 'search']);

    expect(hasRequiredMcpServers(agent, ['GitHub Enterprise', 'web-search'])).toBe(true);
    expect(hasRequiredMcpServers(agent, ['GitHub Enterprise'])).toBe(false);
    expect(hasRequiredMcpServers(builtIn('Explore'), [])).toBe(true);
  });

  it('filters unmet MCP requirements and keeps the original definition objects', () => {
    const ready = custom('Research', 'userSettings', 'ready', ['search']);
    const missing = custom('Issue triage', 'projectSettings', 'missing', ['tickets']);

    const filtered = filterAgentsByMcpRequirements([ready, missing], ['web-search']);

    expect(filtered).toEqual([ready]);
    expect(filtered[0]).toBe(ready);
  });
});
