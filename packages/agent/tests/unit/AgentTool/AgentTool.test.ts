import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  getAgentToolDefinition,
  getAgentDefinitions,
  formatAgentLineForPrompt,
  AGENT_TOOL_NAME,
  type AgentToolInput,
} from '../../../src/tool/AgentTool/AgentTool.js';
import { runAgentSync, type RunAgentParams } from '../../../src/tool/AgentTool/runAgent.js';
import type { ToolUseContext, Tool, Message } from '../../../src/types.js';
import type { AgentDefinition } from '../../../src/tool/AgentTool/loadAgentsDir.js';

describe('AgentTool', () => {
  describe('getAgentToolDefinition', () => {
    it('should return valid tool definition', () => {
      const tool = getAgentToolDefinition();

      expect(tool.name).toBe(AGENT_TOOL_NAME);
      expect(tool.description).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    });

    it('should have prompt as required field', () => {
      const tool = getAgentToolDefinition();
      const schema = tool.input_schema as { required?: string[] };

      expect(schema.required).toContain('prompt');
    });

    it('should have optional subagent_type field', () => {
      const tool = getAgentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string; description?: string }> };

      expect(schema.properties.subagent_type).toBeDefined();
      expect(schema.properties.subagent_type.type).toBe('string');
    });

    it('should have run_in_background field with default false', () => {
      const tool = getAgentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string; default?: boolean }> };

      expect(schema.properties.run_in_background).toBeDefined();
      expect(schema.properties.run_in_background.type).toBe('boolean');
      expect(schema.properties.run_in_background.default).toBe(false);
    });

    it('should have isolation field with worktree enum', () => {
      const tool = getAgentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string; enum?: string[] }> };

      expect(schema.properties.isolation).toBeDefined();
      expect(schema.properties.isolation.enum).toContain('worktree');
    });

    it('should have model field for overriding model', () => {
      const tool = getAgentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string }> };

      expect(schema.properties.model).toBeDefined();
      expect(schema.properties.model.type).toBe('string');
    });
  });

  describe('getAgentDefinitions', () => {
    it('should return all built-in agents', () => {
      const agents = getAgentDefinitions();

      expect(agents.length).toBe(4);
    });

    it('should include general-purpose agent', () => {
      const agents = getAgentDefinitions();
      const generalPurpose = agents.find(a => a.agentType === 'general-purpose');

      expect(generalPurpose).toBeDefined();
      expect(generalPurpose?.whenToUse).toBeDefined();
    });

    it('should include Explore agent', () => {
      const agents = getAgentDefinitions();
      const explore = agents.find(a => a.agentType === 'Explore');

      expect(explore).toBeDefined();
      expect(explore?.disallowedTools).toContain('Write');
      expect(explore?.disallowedTools).toContain('Edit');
    });

    it('should include Plan agent', () => {
      const agents = getAgentDefinitions();
      const plan = agents.find(a => a.agentType === 'Plan');

      expect(plan).toBeDefined();
      expect(plan?.disallowedTools).toContain('Write');
    });

    it('should include verification agent', () => {
      const agents = getAgentDefinitions();
      const verification = agents.find(a => a.agentType === 'verification');

      expect(verification).toBeDefined();
      expect(verification?.background).toBe(true);
    });

    it('should have all required properties for each agent', () => {
      const agents = getAgentDefinitions();

      for (const agent of agents) {
        expect(agent.agentType).toBeDefined();
        expect(agent.whenToUse).toBeDefined();
        expect(agent.getSystemPrompt).toBeDefined();
        expect(typeof agent.getSystemPrompt).toBe('function');
      }
    });
  });

  describe('formatAgentLineForPrompt', () => {
    it('should format agent with wildcard tools', () => {
      const agents = getAgentDefinitions();
      const generalPurpose = agents.find(a => a.agentType === 'general-purpose')!;
      const line = formatAgentLineForPrompt(generalPurpose);

      expect(line).toContain('general-purpose');
      expect(line).toContain('Tools: *');
    });

    it('should format agent with disallowed tools', () => {
      const agents = getAgentDefinitions();
      const explore = agents.find(a => a.agentType === 'Explore')!;
      const line = formatAgentLineForPrompt(explore);

      expect(line).toContain('Explore');
      expect(line).toContain('All tools except');
    });

    it('should format agent with allowed tools list', () => {
      const agents = getAgentDefinitions();
      const agent = agents.find(a => a.agentType === 'general-purpose')!;

      const line = formatAgentLineForPrompt({
        ...agent,
        tools: ['Read', 'Write', 'Bash'],
      });

      expect(line).toContain('Tools: Read, Write, Bash');
    });
  });
});

describe('AgentToolInput validation', () => {
  it('should accept minimal input with only prompt', () => {
    const input: AgentToolInput = {
      prompt: 'Test task',
    };

    expect(input.prompt).toBe('Test task');
    expect(input.subagent_type).toBeUndefined();
    expect(input.run_in_background).toBeUndefined();
  });

  it('should accept full input with all fields', () => {
    const input: AgentToolInput = {
      name: 'Test Agent',
      description: 'A test agent task',
      subagent_type: 'Explore',
      prompt: 'Search for API routes',
      run_in_background: true,
      isolation: 'worktree',
      model: 'claude-3-opus',
    };

    expect(input.name).toBe('Test Agent');
    expect(input.subagent_type).toBe('Explore');
    expect(input.run_in_background).toBe(true);
    expect(input.isolation).toBe('worktree');
    expect(input.model).toBe('claude-3-opus');
  });
});

describe('runAgent', () => {
  describe('runAgentSync', () => {
    it('should return error when no API key is available', async () => {
      const agents = getAgentDefinitions();
      const agent = agents.find(a => a.agentType === 'general-purpose')!;

      const mockContext: ToolUseContext = {
        toolUseId: 'test-id',
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
        options: {
          tools: [],
          commands: [],
          mainLoopModel: 'test-model',
          mcpClients: [],
        },
      };

      const params: RunAgentParams = {
        agentDefinition: agent,
        promptMessages: [{ role: 'user', content: 'test prompt', timestamp: Date.now() }],
        toolUseContext: mockContext,
        isAsync: false,
        availableTools: [],
        agentId: 'test-agent-id',
      };

      const result = await runAgentSync(params);

      expect(result.role).toBe('assistant');
      const content = Array.isArray(result.content)
        ? result.content.find(b => b.type === 'text')?.text
        : result.content;
      expect(content).toContain('Error');
      expect(content).toContain('No API key available');
    });

    it('should return error when agent definition is not found', async () => {
      const mockAgent: AgentDefinition = {
        agentType: 'non-existent',
        whenToUse: 'Never',
        getSystemPrompt: () => 'Test prompt',
      };

      const mockContext: ToolUseContext = {
        toolUseId: 'test-id',
        abortController: new AbortController(),
        getAppState: () => ({}),
        setAppState: () => {},
        options: {
          tools: [],
          commands: [],
          mainLoopModel: 'test-model',
          mcpClients: [],
          apiKey: 'test-api-key',
        },
      };

      const params: RunAgentParams = {
        agentDefinition: mockAgent,
        promptMessages: [{ role: 'user', content: 'test prompt', timestamp: Date.now() }],
        toolUseContext: mockContext,
        isAsync: false,
        availableTools: [],
        agentId: 'test-agent-id',
      };

      const result = await runAgentSync(params);

      expect(result.role).toBe('assistant');
    });
  });
});
