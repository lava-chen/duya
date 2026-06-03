import { describe, it, expect } from 'vitest';
import { getBuiltInAgents } from '../../../src/tool/AgentTool/builtInAgents.js';
import { GENERAL_PURPOSE_AGENT } from '../../../src/tool/AgentTool/built-in/generalPurposeAgent.js';
import { EXPLORE_AGENT } from '../../../src/tool/AgentTool/built-in/exploreAgent.js';
import { PLAN_AGENT } from '../../../src/tool/AgentTool/built-in/planAgent.js';
import { VERIFICATION_AGENT } from '../../../src/tool/AgentTool/built-in/verificationAgent.js';

describe('builtInAgents', () => {
  describe('getBuiltInAgents', () => {
    it('should return 4 built-in agents', () => {
      const agents = getBuiltInAgents();
      expect(agents).toHaveLength(4);
    });

    it('should return agents in correct order', () => {
      const agents = getBuiltInAgents();
      const types = agents.map(a => a.agentType);

      expect(types).toEqual(['general-purpose', 'Explore', 'Plan', 'verification']);
    });
  });
});

describe('GENERAL_PURPOSE_AGENT', () => {
  it('should have correct agentType', () => {
    expect(GENERAL_PURPOSE_AGENT.agentType).toBe('general-purpose');
  });

  it('should have access to all tools', () => {
    expect(GENERAL_PURPOSE_AGENT.tools).toEqual(['*']);
  });

  it('should be a built-in agent', () => {
    expect(GENERAL_PURPOSE_AGENT.source).toBe('built-in');
  });

  it('should have valid system prompt', () => {
    const prompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({} as any);

    expect(prompt).toBeDefined();
    expect(prompt.length).toBeGreaterThan(0);
    expect(prompt).toContain('duya');
  });

  it('should mention guidelines in system prompt', () => {
    const prompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({} as any);

    expect(prompt).toContain('Your strengths');
    expect(prompt).toContain('Guidelines');
  });

  it('should prohibit creating documentation files proactively', () => {
    const prompt = GENERAL_PURPOSE_AGENT.getSystemPrompt({} as any);

    expect(prompt).toContain('NEVER proactively create documentation files');
  });
});

describe('EXPLORE_AGENT', () => {
  it('should have correct agentType', () => {
    expect(EXPLORE_AGENT.agentType).toBe('Explore');
  });

  it('should be read-only (disallow Write and Edit)', () => {
    expect(EXPLORE_AGENT.disallowedTools).toContain('Write');
    expect(EXPLORE_AGENT.disallowedTools).toContain('Edit');
  });

  it('should not be able to spawn other agents', () => {
    expect(EXPLORE_AGENT.disallowedTools).toContain('Agent');
  });

  it('should omit CLAUDE.md from context', () => {
    expect(EXPLORE_AGENT.omitClaudeMd).toBe(true);
  });

  it('should have valid system prompt', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt();

    expect(prompt).toBeDefined();
    expect(prompt).toContain('READ-ONLY');
    expect(prompt).toContain('file search specialist');
  });

  it('should explicitly prohibit file modifications in prompt', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt();

    expect(prompt).toContain('STRICTLY PROHIBITED');
    expect(prompt).toContain('Creating new files');
    expect(prompt).toContain('Modifying existing files');
  });

  it('should recommend parallel tool calls for speed', () => {
    const prompt = EXPLORE_AGENT.getSystemPrompt();

    expect(prompt).toContain('parallel tool calls');
  });
});

describe('PLAN_AGENT', () => {
  it('should have correct agentType', () => {
    expect(PLAN_AGENT.agentType).toBe('Plan');
  });

  it('should be read-only (disallow Write and Edit)', () => {
    expect(PLAN_AGENT.disallowedTools).toContain('Write');
    expect(PLAN_AGENT.disallowedTools).toContain('Edit');
  });

  it('should not be able to spawn other agents', () => {
    expect(PLAN_AGENT.disallowedTools).toContain('Agent');
  });

  it('should omit CLAUDE.md from context', () => {
    expect(PLAN_AGENT.omitClaudeMd).toBe(true);
  });

  it('should have valid system prompt', () => {
    const prompt = PLAN_AGENT.getSystemPrompt();

    expect(prompt).toBeDefined();
    expect(prompt).toContain('software architect');
    expect(prompt).toContain('planning');
  });

  it('should require critical files output', () => {
    const prompt = PLAN_AGENT.getSystemPrompt();

    expect(prompt).toContain('Critical Files for Implementation');
  });

  it('should define planning process steps', () => {
    const prompt = PLAN_AGENT.getSystemPrompt();

    expect(prompt).toContain('Understand Requirements');
    expect(prompt).toContain('Explore Thoroughly');
    expect(prompt).toContain('Design Solution');
    expect(prompt).toContain('Detail the Plan');
  });
});

describe('VERIFICATION_AGENT', () => {
  it('should have correct agentType', () => {
    expect(VERIFICATION_AGENT.agentType).toBe('verification');
  });

  it('should run in background by default', () => {
    expect(VERIFICATION_AGENT.background).toBe(true);
  });

  it('should be read-only for project files', () => {
    expect(VERIFICATION_AGENT.disallowedTools).toContain('Write');
    expect(VERIFICATION_AGENT.disallowedTools).toContain('Edit');
  });

  it('should not be able to spawn other agents', () => {
    expect(VERIFICATION_AGENT.disallowedTools).toContain('Agent');
  });

  it('should inherit model from parent', () => {
    expect(VERIFICATION_AGENT.model).toBe('inherit');
  });

  it('should have valid system prompt', () => {
    const prompt = VERIFICATION_AGENT.getSystemPrompt();

    expect(prompt).toBeDefined();
    expect(prompt).toContain('verification specialist');
  });

  it('should require VERDICT output', () => {
    const prompt = VERIFICATION_AGENT.getSystemPrompt();

    expect(prompt).toContain('VERDICT: PASS');
    expect(prompt).toContain('VERDICT: FAIL');
    expect(prompt).toContain('VERDICT: PARTIAL');
  });

  it('should require command evidence for checks', () => {
    const prompt = VERIFICATION_AGENT.getSystemPrompt();

    expect(prompt).toContain('Command run:');
    expect(prompt).toContain('Output observed:');
  });

  it('should warn against verification avoidance', () => {
    const prompt = VERIFICATION_AGENT.getSystemPrompt();

    expect(prompt).toContain('verification avoidance');
    expect(prompt).toContain('first 80%');
  });

  it('should define verification strategies by change type', () => {
    const prompt = VERIFICATION_AGENT.getSystemPrompt();

    expect(prompt).toContain('Frontend changes');
    expect(prompt).toContain('Backend/API changes');
    expect(prompt).toContain('CLI/script changes');
    expect(prompt).toContain('Bug fixes');
    expect(prompt).toContain('Refactoring');
  });

  it('should require adversarial probes', () => {
    const prompt = VERIFICATION_AGENT.getSystemPrompt();

    expect(prompt).toContain('ADVERSARIAL PROBES');
    expect(prompt).toContain('Concurrency');
    expect(prompt).toContain('Boundary values');
    expect(prompt).toContain('Idempotency');
  });
});

describe('Agent isolation and tool restrictions', () => {
  it('Explore and Plan should have same tool restrictions', () => {
    expect(EXPLORE_AGENT.disallowedTools).toEqual(PLAN_AGENT.disallowedTools);
  });

  it('Verification should have same tool restrictions as Explore', () => {
    expect(VERIFICATION_AGENT.disallowedTools).toEqual(EXPLORE_AGENT.disallowedTools);
  });

  it('General-purpose should have no tool restrictions', () => {
    expect(GENERAL_PURPOSE_AGENT.disallowedTools).toBeUndefined();
  });
});
