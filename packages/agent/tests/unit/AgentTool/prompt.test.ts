import { describe, it, expect, beforeEach } from 'vitest';
import { getPrompt, formatAgentLine } from '../../../src/tool/AgentTool/prompt.js';
import { getBuiltInAgents } from '../../../src/tool/AgentTool/builtInAgents.js';

describe('prompt', () => {
  let agents: ReturnType<typeof getBuiltInAgents>;

  beforeEach(() => {
    agents = getBuiltInAgents();
  });

  describe('getPrompt', () => {
    it('should return a non-empty string', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toBeDefined();
      expect(prompt.length).toBeGreaterThan(0);
    });

    it('should contain Agent tool name', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('Agent');
    });

    it('should list all agent types', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('general-purpose');
      expect(prompt).toContain('Explore');
      expect(prompt).toContain('Plan');
      expect(prompt).toContain('verification');
    });

    it('should include writing the prompt section', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('Writing the prompt');
      expect(prompt).toContain('Never delegate understanding');
    });

    it('should include when NOT to use section', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('When NOT to use');
    });

    it('should include usage notes', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('Usage notes');
      expect(prompt).toContain('run_in_background');
    });

    it('should include examples', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('Example usage');
    });

    it('should return slim prompt for coordinator mode', async () => {
      const fullPrompt = await getPrompt(agents, false);
      const slimPrompt = await getPrompt(agents, true);

      expect(slimPrompt.length).toBeLessThan(fullPrompt.length);
      expect(slimPrompt).not.toContain('When NOT to use');
    });

    it('should filter agents by allowedAgentTypes', async () => {
      const filteredPrompt = await getPrompt(agents, false, ['Explore', 'Plan']);
      const fullPrompt = await getPrompt(agents, false);

      expect(filteredPrompt).toContain('Explore');
      expect(filteredPrompt).toContain('Plan');
      expect(filteredPrompt).not.toContain('verification');
    });

    it('should mention isolation worktree option', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('worktree');
    });

    it('should mention parallel agent execution', async () => {
      const prompt = await getPrompt(agents);

      expect(prompt).toContain('parallel');
    });
  });

  describe('formatAgentLine', () => {
    it('should format agent with type and description', () => {
      const agent = agents.find(a => a.agentType === 'Explore')!;
      const line = formatAgentLine(agent);

      expect(line).toContain('Explore');
      expect(line).toContain('Tools:');
    });

    it('should format agent with disallowed tools', () => {
      const agent = agents.find(a => a.agentType === 'Explore')!;
      const line = formatAgentLine(agent);

      expect(line).toContain('All tools except');
    });

    it('should format agent with wildcard tools', () => {
      const agent = agents.find(a => a.agentType === 'general-purpose')!;
      const line = formatAgentLine(agent);

      expect(line).toContain('Tools: *');
    });
  });
});
