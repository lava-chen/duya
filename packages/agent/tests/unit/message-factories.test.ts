import { describe, expect, it } from 'vitest';
import type { MessageContent, TokenUsage } from '../../src/types.js';
import {
  AGENT_MESSAGE_METADATA_KEYS,
  AgentMessageFactory,
  type AgentMessageIdGenerator,
} from '../../src/message/message-factories.js';

const FIXED_NOW = 1_700_000_000_000;

function createDeterministicFactory(
  idSequence: readonly string[] = ['m1', 'm2', 'm3', 'm4'],
  now: number = FIXED_NOW,
): AgentMessageFactory {
  let index = 0;
  const idGenerator: AgentMessageIdGenerator = () =>
    idSequence[index++] ?? `fallback-${index}`;
  return new AgentMessageFactory({ idGenerator, clock: () => now });
}

describe('AgentMessageFactory', () => {
  describe('injectable dependencies', () => {
    it('uses the injected id generator and clock for every creator', () => {
      const factory = createDeterministicFactory(['u1', 'a1', 't1'], 12345);
      const user = factory.createUserMessage({ content: 'hi' });
      const assistant = factory.createAssistantMessage({ content: 'hello' });
      const tool = factory.createToolResultMessage({
        toolCallId: 'tu1',
        toolName: 'read',
        content: 'ok',
        isError: false,
      });

      expect(user.id).toBe('u1');
      expect(assistant.id).toBe('a1');
      expect(tool.id).toBe('t1');
      expect([user, assistant, tool].map((m) => m.timestamp)).toEqual([
        12345, 12345, 12345,
      ]);
    });

    it('falls back to crypto.randomUUID / Date.now when no overrides given', () => {
      const before = Date.now();
      const factory = new AgentMessageFactory();
      const message = factory.createUserMessage({ content: 'hi' });
      const after = Date.now();

      expect(message.id).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
      );
      expect(message.timestamp).toBeGreaterThanOrEqual(before);
      expect(message.timestamp).toBeLessThanOrEqual(after);
    });
  });

  describe('createUserMessage', () => {
    it('builds a minimal visible user message', () => {
      const factory = createDeterministicFactory(['u1']);
      const message = factory.createUserMessage({ content: 'hello' });

      expect(message).toEqual({
        role: 'user',
        id: 'u1',
        timestamp: FIXED_NOW,
        visibility: 'visible',
        content: 'hello',
      });
    });

    it('preserves displayContent and attachments without copying them into a new user message', () => {
      const factory = createDeterministicFactory(['u1']);
      const attachments = [
        { id: 'att1', name: 'doc.pdf', type: 'application/pdf' },
      ];
      const message = factory.createUserMessage({
        content: 'summarize this',
        displayContent: 'summarize doc.pdf',
        attachments,
      });

      expect(message.displayContent).toBe('summarize doc.pdf');
      expect(message.attachments).toEqual(attachments);
    });

    it('records seqIndex in metadata under the stable key', () => {
      const factory = createDeterministicFactory(['u1']);
      const message = factory.createUserMessage({
        content: 'hi',
        seqIndex: 42,
      });

      expect(message.metadata).toEqual({
        [AGENT_MESSAGE_METADATA_KEYS.seqIndex]: 42,
      });
    });

    it('omits metadata entirely when no runtime fields are provided', () => {
      const factory = createDeterministicFactory(['u1']);
      const message = factory.createUserMessage({ content: 'hi' });
      expect(message.metadata).toBeUndefined();
    });

    it('merges caller metadata with runtime fields', () => {
      const factory = createDeterministicFactory(['u1']);
      const message = factory.createUserMessage({
        content: 'hi',
        seqIndex: 7,
        metadata: { source: 'test' },
      });

      expect(message.metadata).toEqual({
        source: 'test',
        [AGENT_MESSAGE_METADATA_KEYS.seqIndex]: 7,
      });
    });
  });

  describe('createAssistantMessage', () => {
    it('preserves thinking signature and tool_use id inside content blocks', () => {
      const factory = createDeterministicFactory(['a1']);
      const content: MessageContent[] = [
        { type: 'thinking', thinking: 'reasoning', thinkingSignature: 'sig-abc' },
        { type: 'tool_use', id: 'tu_1', name: 'read', input: { path: '/a' } },
        { type: 'text', text: 'done' },
      ];
      const message = factory.createAssistantMessage({ content });

      expect(message.content).toBe(content);
      expect((message.content as MessageContent[])[0]).toMatchObject({
        type: 'thinking',
        thinkingSignature: 'sig-abc',
      });
      expect((message.content as MessageContent[])[1]).toMatchObject({
        type: 'tool_use',
        id: 'tu_1',
      });
    });

    it('stores providerId, model, tokenUsage first-class and stopReason in metadata', () => {
      const factory = createDeterministicFactory(['a1']);
      const usage: TokenUsage = {
        input_tokens: 10,
        output_tokens: 5,
        total_tokens: 15,
      };
      const message = factory.createAssistantMessage({
        content: 'reply',
        providerId: 'anthropic',
        model: 'claude-3',
        tokenUsage: usage,
        stopReason: 'end_turn',
      });

      expect(message.providerId).toBe('anthropic');
      expect(message.model).toBe('claude-3');
      expect(message.tokenUsage).toBe(usage);
      expect(message.metadata).toMatchObject({
        [AGENT_MESSAGE_METADATA_KEYS.stopReason]: 'end_turn',
      });
    });

    it('preserves duration, status, and seqIndex in metadata', () => {
      const factory = createDeterministicFactory(['a1']);
      const message = factory.createAssistantMessage({
        content: 'reply',
        durationMs: 1500,
        status: 'complete',
        seqIndex: 9,
      });

      expect(message.metadata).toEqual({
        [AGENT_MESSAGE_METADATA_KEYS.durationMs]: 1500,
        [AGENT_MESSAGE_METADATA_KEYS.status]: 'complete',
        [AGENT_MESSAGE_METADATA_KEYS.seqIndex]: 9,
      });
    });
  });

  describe('createToolResultMessage', () => {
    it('builds a non-error tool result with toolCallId and toolName', () => {
      const factory = createDeterministicFactory(['t1']);
      const message = factory.createToolResultMessage({
        toolCallId: 'tu_1',
        toolName: 'read',
        content: 'file contents',
        isError: false,
      });

      expect(message).toMatchObject({
        role: 'tool',
        name: 'read',
        tool_call_id: 'tu_1',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_1',
            content: 'file contents',
            is_error: false,
          },
        ],
      });
    });

    it('marks error results (including tool execution failures)', () => {
      const factory = createDeterministicFactory(['t1']);
      const message = factory.createToolResultMessage({
        toolCallId: 'tu_err',
        toolName: 'bash',
        content: 'command failed with exit code 1',
        isError: true,
        status: 'error',
      });

      expect(message).toMatchObject({
        role: 'tool',
        tool_call_id: 'tu_err',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_err',
            content: 'command failed with exit code 1',
            is_error: true,
          },
        ],
      });
      expect(message.metadata).toMatchObject({
        [AGENT_MESSAGE_METADATA_KEYS.status]: 'error',
      });
    });

    it('builds a synthetic tool_result for an interrupted generation', () => {
      const factory = createDeterministicFactory(['t1']);
      const message = factory.createToolResultMessage({
        toolCallId: 'tu_interrupted',
        toolName: 'Bash',
        content: 'Interrupted by user',
        isError: true,
      });

      expect(message).toMatchObject({
        role: 'tool',
        tool_call_id: 'tu_interrupted',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 'tu_interrupted',
            content: 'Interrupted by user',
            is_error: true,
          },
        ],
      });
    });
  });

  describe('createRuntimeContextMessage', () => {
    it('defaults to visible visibility', () => {
      const factory = createDeterministicFactory(['r1']);
      const message = factory.createRuntimeContextMessage({
        source: 'agents_md',
        content: 'AGENTS.md contents',
      });

      expect(message).toMatchObject({
        role: 'runtime_context',
        source: 'agents_md',
        visibility: 'visible',
      });
    });

    it('supports mailbox, background_notification, and attachment sources', () => {
      const factory = createDeterministicFactory(['r1', 'r2', 'r3']);
      const mailbox = factory.createRuntimeContextMessage({
        source: 'mailbox',
        content: '<runtime-user-guidance>do x</runtime-user-guidance>',
      });
      const notification = factory.createRuntimeContextMessage({
        source: 'background_notification',
        content: '<task-notification>done</task-notification>',
      });
      const attachment = factory.createRuntimeContextMessage({
        source: 'attachment',
        content: 'parsed attachment text',
      });

      expect(mailbox.source).toBe('mailbox');
      expect(notification.source).toBe('background_notification');
      expect(attachment.source).toBe('attachment');
    });
  });

  describe('createCompactionSummaryMessage', () => {
    it('builds a summary referencing a compaction entry', () => {
      const factory = createDeterministicFactory(['c1']);
      const message = factory.createCompactionSummaryMessage({
        summary: 'prior work summarized',
        compactionEntryId: 'compaction-1',
        tokensBefore: 90_000,
        tokensAfter: 20_000,
      });

      expect(message).toMatchObject({
        role: 'compaction_summary',
        summary: 'prior work summarized',
        compactionEntryId: 'compaction-1',
        tokensBefore: 90_000,
        tokensAfter: 20_000,
      });
    });

    it('omits tokensAfter when not provided', () => {
      const factory = createDeterministicFactory(['c1']);
      const message = factory.createCompactionSummaryMessage({
        summary: 'sum',
        compactionEntryId: 'c1',
        tokensBefore: 100,
      });

      expect(message.tokensAfter).toBeUndefined();
    });
  });
});
