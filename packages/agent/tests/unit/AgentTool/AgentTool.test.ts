import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  SubagentTool,
  getAgentDefinitions,
  formatAgentLineForPrompt,
  SUBAGENT_TOOL_NAME,
  type SubagentToolInput,
} from '../../../src/tool/SubagentTool/SubagentTool.js';
import { runAgentSync, type RunAgentParams, type SubagentRunDeps } from '../../../src/tool/SubagentTool/runAgent.js';
import { duyaAgent } from '../../../src/agent/DuyaAgent.js';
import { createBuiltinRegistry } from '../../../src/tool/builtin.js';
import type { ToolUseContext, Tool, Message } from '../../../src/types.js';
import type { AgentDefinition } from '../../../src/tool/SubagentTool/loadAgentsDir.js';

// Plan 610 A5: `SubagentTool` is no longer a module singleton and `runAgent`
// no longer resolves its composition deps from module scope, so this suite
// supplies the same REAL factories the removed imports provided.
//
// A first attempt used throwing stubs on the theory that both cases bail out
// early. Measurement said otherwise: both reach `createToolRegistry`, so stubs
// turned the cases into "stub called" failures -- and masked the known
// pre-existing `no API key` failure (this environment has a key in the
// environment, so that case no longer short-circuits where the test assumes).
const subagentDeps: SubagentRunDeps = {
  createSubAgent: (options) => new duyaAgent(options),
  // Argument-less, matching what `runAgent` did before the cut.
  createToolRegistry: () => createBuiltinRegistry(subagentDeps),
};

// 99556ea4 deleted the exported `getSubagentToolDefinition()` helper, which
// was a one-line `return subagentTool.toTool()` and added nothing. The
// definition it returned is still the contract this suite pins, so read it
// off an instance built exactly the way `createBuiltinRegistry` builds one,
// that is the object the tool registry actually advertises, which is a
// strictly tighter assertion than the deleted wrapper was.
const getSubagentToolDefinition = () => new SubagentTool(subagentDeps).toTool();

describe('AgentTool', () => {
  describe('getSubagentToolDefinition', () => {
    it('should return valid tool definition', () => {
      const tool = getSubagentToolDefinition();

      expect(tool.name).toBe(SUBAGENT_TOOL_NAME);
      expect(tool.description).toBeDefined();
      expect(tool.input_schema.type).toBe('object');
    });

    it('should have prompt as required field', () => {
      const tool = getSubagentToolDefinition();
      const schema = tool.input_schema as { required?: string[] };

      expect(schema.required).toContain('prompt');
    });

    it('should have optional subagent_type field', () => {
      const tool = getSubagentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string; description?: string }> };

      expect(schema.properties.subagent_type).toBeDefined();
      expect(schema.properties.subagent_type.type).toBe('string');
    });

    it('should have run_in_background field defaulting to true', () => {
      const tool = getSubagentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string; default?: boolean }> };

      expect(schema.properties.run_in_background).toBeDefined();
      expect(schema.properties.run_in_background.type).toBe('boolean');
      // Subagents run detached unless the caller explicitly opts out. The
      // implementation reads this as `run_in_background !== false`.
      expect(schema.properties.run_in_background.default).toBe(true);
    });

    it('should have isolation field with worktree enum', () => {
      const tool = getSubagentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string; enum?: string[] }> };

      expect(schema.properties.isolation).toBeDefined();
      expect(schema.properties.isolation.enum).toContain('worktree');
    });

    it('should have model field for overriding model', () => {
      const tool = getSubagentToolDefinition();
      const schema = tool.input_schema as { properties: Record<string, { type: string }> };

      expect(schema.properties.model).toBeDefined();
      expect(schema.properties.model.type).toBe('string');
    });
  });

  describe('getAgentDefinitions', () => {
    it('should expose every built-in agent', () => {
      const agents = getAgentDefinitions();

      // Pinned by identity rather than by count: adding a built-in agent is a
      // routine change that must not require touching this suite.
      expect(agents.map(a => a.agentType).sort()).toEqual(
        [
          'general-purpose',
          'Explore',
          'Plan',
          'verification',
          'CodeReview',
          'Research',
          'Canvas',
          'ComputerUse',
        ].sort()
      );
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

describe('SubagentToolInput validation', () => {
  it('should accept minimal input with only prompt', () => {
    const input: SubagentToolInput = {
      prompt: 'Test task',
    };

    expect(input.prompt).toBe('Test task');
    expect(input.subagent_type).toBeUndefined();
    expect(input.run_in_background).toBeUndefined();
  });

  it('should accept full input with all fields', () => {
    const input: SubagentToolInput = {
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
        createSubAgent: subagentDeps.createSubAgent,
        createToolRegistry: subagentDeps.createToolRegistry,
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
        createSubAgent: subagentDeps.createSubAgent,
        createToolRegistry: subagentDeps.createToolRegistry,
      };

      const result = await runAgentSync(params);

      expect(result.role).toBe('assistant');
    });
  });
});
