import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  isForkSubagentEnabled,
  FORK_SUBAGENT_TYPE,
  FORK_AGENT,
  buildForkedMessages,
  buildChildMessage,
  buildWorktreeNotice,
} from '../../../src/tool/AgentTool/forkSubagent.js';
import type { AssistantMessage, ToolUseContentBlock } from '../../../src/types.js';

describe('forkSubagent', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isForkSubagentEnabled', () => {
    it('should return false by default', () => {
      delete process.env.duya_FORK_SUBAGENT_ENABLED;
      expect(isForkSubagentEnabled()).toBe(false);
    });

    it('should return true when environment variable is set to true', () => {
      process.env.duya_FORK_SUBAGENT_ENABLED = 'true';
      expect(isForkSubagentEnabled()).toBe(true);
    });

    it('should return false for other values', () => {
      process.env.duya_FORK_SUBAGENT_ENABLED = 'false';
      expect(isForkSubagentEnabled()).toBe(false);

      process.env.duya_FORK_SUBAGENT_ENABLED = '1';
      expect(isForkSubagentEnabled()).toBe(false);
    });
  });

  describe('FORK_SUBAGENT_TYPE', () => {
    it('should be "fork"', () => {
      expect(FORK_SUBAGENT_TYPE).toBe('fork');
    });
  });

  describe('FORK_AGENT', () => {
    it('should have correct agentType', () => {
      expect(FORK_AGENT.agentType).toBe('fork');
    });

    it('should have tools set to all', () => {
      expect(FORK_AGENT.tools).toEqual(['*']);
    });

    it('should have maxTurns set', () => {
      expect(FORK_AGENT.maxTurns).toBe(200);
    });

    it('should have model set to inherit', () => {
      expect(FORK_AGENT.model).toBe('inherit');
    });

    it('should have empty system prompt', () => {
      expect(FORK_AGENT.getSystemPrompt()).toBe('');
    });
  });

  describe('buildForkedMessages', () => {
    it('should return single message when no tool_use blocks', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        timestamp: Date.now(),
      };

      const messages = buildForkedMessages('Do something', assistantMessage);

      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe('user');
    });

    it('should return two messages when tool_use blocks exist', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'text', text: 'I will help you' },
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: { file_path: '/test' } },
        ],
        timestamp: Date.now(),
      };

      const messages = buildForkedMessages('Do something', assistantMessage);

      expect(messages).toHaveLength(2);
      expect(messages[0].role).toBe('assistant');
      expect(messages[1].role).toBe('user');
    });

    it('should include placeholder for all tool_use blocks', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tool-2', name: 'Write', input: {} },
        ],
        timestamp: Date.now(),
      };

      const messages = buildForkedMessages('Test directive', assistantMessage);
      const userMessage = messages[1];

      const toolResults = userMessage.content.filter(
        (block): block is { type: 'tool_result'; tool_use_id: string; content: Array<{ type: 'text'; text: string }> } =>
          block.type === 'tool_result'
      );

      expect(toolResults).toHaveLength(2);
      expect(toolResults[0].tool_use_id).toBe('tool-1');
      expect(toolResults[1].tool_use_id).toBe('tool-2');
    });

    it('should use identical placeholder text for all tool_results', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: 'tool-1', name: 'Read', input: {} },
          { type: 'tool_use', id: 'tool-2', name: 'Write', input: {} },
        ],
        timestamp: Date.now(),
      };

      const messages = buildForkedMessages('Test', assistantMessage);
      const userMessage = messages[1];

      const toolResults = userMessage.content.filter(
        (block): block is { type: 'tool_result'; content: Array<{ type: 'text'; text: string }> } =>
          block.type === 'tool_result'
      );

      const placeholderText = 'Fork started — processing in background';
      expect(toolResults[0].content[0].text).toBe(placeholderText);
      expect(toolResults[1].content[0].text).toBe(placeholderText);
    });

    it('should include directive in the user message', () => {
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello' }],
        timestamp: Date.now(),
      };

      const messages = buildForkedMessages('My custom directive', assistantMessage);
      const textBlock = messages[0].content.find(b => b.type === 'text');

      expect(textBlock).toBeDefined();
      expect((textBlock as { type: 'text'; text: string }).text).toContain('My custom directive');
    });

    it('should clone assistant message without mutating original', () => {
      const originalContent = [{ type: 'text' as const, text: 'Original' }];
      const assistantMessage: AssistantMessage = {
        id: 'msg-1',
        role: 'assistant',
        content: originalContent,
        timestamp: Date.now(),
      };

      buildForkedMessages('Test', assistantMessage);

      expect(assistantMessage.content).toBe(originalContent);
      expect(assistantMessage.content).toHaveLength(1);
    });
  });

  describe('buildChildMessage', () => {
    it('should contain FORK_BOILERPLATE tag', () => {
      const message = buildChildMessage('Test directive');

      expect(message).toContain('<FORK_BOILERPLATE>');
      expect(message).toContain('</FORK_BOILERPLATE>');
    });

    it('should include all rules', () => {
      const message = buildChildMessage('Test');

      expect(message).toContain('You are a forked worker process');
      expect(message).toContain('Do NOT spawn sub-agents');
      expect(message).toContain('Do NOT converse, ask questions');
    });

    it('should include output format requirements', () => {
      const message = buildChildMessage('Test');

      expect(message).toContain('Scope:');
      expect(message).toContain('Result:');
      expect(message).toContain('Key files:');
      expect(message).toContain('Files changed:');
      expect(message).toContain('Issues:');
    });

    it('should append directive with DIRECTIVE prefix', () => {
      const message = buildChildMessage('My specific task');

      expect(message).toContain('DIRECTIVE: My specific task');
    });

    it('should be consistent for same directive', () => {
      const message1 = buildChildMessage('Same task');
      const message2 = buildChildMessage('Same task');

      expect(message1).toBe(message2);
    });
  });

  describe('buildWorktreeNotice', () => {
    it('should mention parent working directory', () => {
      const notice = buildWorktreeNotice('/home/user/project', '/home/user/project/.worktree/feature');

      expect(notice).toContain('/home/user/project');
    });

    it('should mention worktree working directory', () => {
      const notice = buildWorktreeNotice('/home/user/project', '/home/user/project/.worktree/feature');

      expect(notice).toContain('/home/user/project/.worktree/feature');
    });

    it('should explain isolation concept', () => {
      const notice = buildWorktreeNotice('/parent', '/worktree');

      expect(notice).toContain('isolated git worktree');
      expect(notice).toContain('separate working copy');
    });

    it('should advise to translate paths', () => {
      const notice = buildWorktreeNotice('/parent', '/worktree');

      expect(notice).toContain('translate them to your worktree root');
    });

    it('should advise to re-read files', () => {
      const notice = buildWorktreeNotice('/parent', '/worktree');

      expect(notice).toContain('Re-read files before editing');
    });
  });
});
