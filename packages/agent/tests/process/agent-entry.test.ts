/**
 * Agent Process Entry - Unit Tests
 *
 * Tests the agent process entry point logic:
 * - TokenBucket rate limiting
 * - MessageRow to Message conversion (messageRowToMessage)
 * - Message history validation (validateMessageHistory)
 * - SSE event to Agent message conversion (convertSSEToAgentMessage)
 *
 * These functions are internal to agent-process-entry.ts and are tested
 * by reproducing the logic patterns from the source.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// =============================================================================
// TokenBucket (reproduced from agent-process-entry.ts for testing)
// =============================================================================

class TokenBucket {
  private tokens: number;
  private refillTimer: ReturnType<typeof setInterval>;

  constructor(
    private capacity: number,
    private refillRate: number
  ) {
    this.tokens = capacity;
    this.refillTimer = setInterval(() => {
      this.tokens = Math.min(this.capacity, this.tokens + this.refillRate);
    }, 1000);
  }

  async consume(cost = 1): Promise<void> {
    while (this.tokens < cost) {
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    this.tokens -= cost;
  }

  getTokens(): number {
    return this.tokens;
  }

  destroy(): void {
    if (this.refillTimer) {
      clearInterval(this.refillTimer);
    }
  }
}

// =============================================================================
// Message Types (simplified from agent source)
// =============================================================================

interface MessageRow {
  id: string;
  role: string;
  content: string;
  name?: string | null;
  tool_call_id?: string | null;
  created_at: number;
  msg_type?: string | null;
  thinking?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  parent_tool_call_id?: string | null;
  viz_spec?: string | null;
  status?: string | null;
  seq_index?: number | null;
  duration_ms?: number | null;
  sub_agent_id?: string | null;
}

interface Message {
  id: string;
  role: string;
  content: string | Array<{ type: string; [key: string]: unknown }>;
  name?: string;
  tool_call_id?: string;
  timestamp: number;
  msg_type?: string;
  thinking?: string | null;
  tool_name?: string | null;
  tool_input?: string | null;
  parent_tool_call_id?: string | null;
  viz_spec?: string | null;
  status?: string | null;
  seq_index?: number | null;
  duration_ms?: number | null;
  sub_agent_id?: string | null;
}

// =============================================================================
// messageRowToMessage (reproduced from agent-process-entry.ts)
// =============================================================================

function messageRowToMessage(row: MessageRow): Message {
  let content: string | Array<{ type: string; [key: string]: unknown }>;
  let toolCallId = row.tool_call_id || undefined;

  if (row.msg_type === 'thinking' && row.thinking) {
    content = [{ type: 'thinking', thinking: row.thinking }];
  } else if (row.msg_type === 'tool_use' && row.tool_name) {
    let input: Record<string, unknown> = {};
    let toolId = row.id;
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const block = parsed[0];
        if (block.id) toolId = block.id;
        if (block.input) input = block.input;
      }
    } catch {
      try {
        input = row.tool_input ? JSON.parse(row.tool_input) : {};
      } catch {
        input = {};
      }
    }
    content = [{ type: 'tool_use', id: toolId, name: row.tool_name, input }];
    toolCallId = toolId;
  } else {
    try {
      const parsed = JSON.parse(row.content);
      if (Array.isArray(parsed)) {
        content = parsed as Array<{ type: string; [key: string]: unknown }>;
      } else {
        content = row.content;
      }
    } catch {
      content = row.content;
    }
  }

  return {
    id: row.id,
    role: row.role,
    content,
    name: row.name || undefined,
    tool_call_id: toolCallId,
    timestamp: row.created_at,
    msg_type: row.msg_type || undefined,
    thinking: row.thinking || undefined,
    tool_name: row.tool_name || undefined,
    tool_input: row.tool_input || undefined,
    parent_tool_call_id: row.parent_tool_call_id || undefined,
    viz_spec: row.viz_spec || undefined,
    status: row.status || undefined,
    seq_index: row.seq_index ?? undefined,
    duration_ms: row.duration_ms ?? undefined,
    sub_agent_id: row.sub_agent_id || undefined,
  };
}

// =============================================================================
// validateMessageHistory (reproduced from agent-process-entry.ts)
// =============================================================================

function validateMessageHistory(messages: Message[]): Message[] {
  if (messages.length === 0) return messages;

  const toolUseIds = new Set<string>();
  const toolResultIds = new Set<string>();

  for (const msg of messages) {
    if (msg.msg_type === 'tool_use' && msg.tool_call_id) {
      toolUseIds.add(msg.tool_call_id);
    } else if (msg.role === 'tool' && msg.tool_call_id) {
      toolResultIds.add(msg.tool_call_id);
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          toolUseIds.add(block.id);
        } else if (block.type === 'tool_result' && 'tool_use_id' in block && typeof block.tool_use_id === 'string') {
          toolResultIds.add(block.tool_use_id);
        }
      }
    }
  }

  const unmatchedToolUseIds = new Set<string>();
  for (const id of toolUseIds) {
    if (!toolResultIds.has(id)) {
      unmatchedToolUseIds.add(id);
    }
  }

  if (unmatchedToolUseIds.size === 0) {
    return messages;
  }

  const cleanedMessages: Message[] = [];
  for (const msg of messages) {
    if (msg.role === 'tool' && msg.tool_call_id && !toolUseIds.has(msg.tool_call_id)) {
      continue;
    }

    if (msg.msg_type === 'tool_use' && msg.tool_call_id && unmatchedToolUseIds.has(msg.tool_call_id)) {
      continue;
    }

    if (Array.isArray(msg.content)) {
      const filteredContent = msg.content.filter((block) => {
        if (block.type === 'tool_use' && 'id' in block && typeof block.id === 'string') {
          if (unmatchedToolUseIds.has(block.id)) {
            return false;
          }
        }
        return true;
      });

      cleanedMessages.push({
        ...msg,
        content: filteredContent.length > 0 ? filteredContent : '',
      });
    } else {
      cleanedMessages.push(msg);
    }
  }

  return cleanedMessages;
}

// =============================================================================
// convertSSEToAgentMessage (reproduced from agent-process-entry.ts)
// =============================================================================

function convertSSEToAgentMessage(event: { type: string; data?: unknown }): Record<string, unknown> | null {
  switch (event.type) {
    case 'text':
      return { type: 'chat:text', content: event.data as string };
    case 'thinking':
      return { type: 'chat:thinking', content: event.data as string };
    case 'tool_use':
      return { type: 'chat:tool_use', id: (event.data as { id: string }).id, name: (event.data as { name: string }).name, input: (event.data as { input?: unknown }).input };
    case 'tool_result':
      return { type: 'chat:tool_result', id: (event.data as { id: string }).id, result: (event.data as { result: string }).result, error: (event.data as { error?: boolean }).error };
    case 'tool_progress':
      return { type: 'chat:tool_progress', toolUseId: (event.data as { toolName: string }).toolName, percent: 0, stage: `${event.data}` };
    case 'done':
      return { type: 'chat:done' };
    case 'error':
      return { type: 'chat:error', message: event.data as string };
    case 'result':
      return { type: 'chat:token_usage', ...(event.data as object) };
    default:
      return null;
  }
}

// =============================================================================
// Tests
// =============================================================================

describe('Agent Process Entry', () => {
  // =========================================================================
  // TokenBucket
  // =========================================================================

  describe('TokenBucket', () => {
    let bucket: TokenBucket;

    afterEach(() => {
      if (bucket) bucket.destroy();
    });

    it('initializes with full capacity', () => {
      bucket = new TokenBucket(5, 2);
      expect(bucket.getTokens()).toBe(5);
    });

    it('consumes tokens', async () => {
      bucket = new TokenBucket(5, 2);
      await bucket.consume(1);
      expect(bucket.getTokens()).toBe(4);
    });

    it('consumes multiple tokens', async () => {
      bucket = new TokenBucket(5, 2);
      await bucket.consume(3);
      expect(bucket.getTokens()).toBe(2);
    });

    it('prevents consumption beyond available tokens', async () => {
      bucket = new TokenBucket(2, 2);
      // Fill then drain
      await bucket.consume(2);
      expect(bucket.getTokens()).toBe(0);

      // Now try to consume more - should wait, but we can check tokens are 0
      const consumePromise = bucket.consume(1);
      // Give a tick
      await new Promise(r => setTimeout(r, 50));
      expect(bucket.getTokens()).toBe(0);
    });

    it('refills tokens over time', async () => {
      bucket = new TokenBucket(5, 2);
      await bucket.consume(5);
      expect(bucket.getTokens()).toBe(0);

      // Wait for refill (1 second + some buffer)
      await new Promise(r => setTimeout(r, 1100));
      expect(bucket.getTokens()).toBeGreaterThanOrEqual(2);
    }, 5000);

    it('caps at capacity', async () => {
      bucket = new TokenBucket(3, 5); // refill higher than capacity
      await bucket.consume(3);
      // Wait for refill
      await new Promise(r => setTimeout(r, 1100));
      expect(bucket.getTokens()).toBe(3); // Capped at capacity
    }, 5000);

    it('destroys the timer', () => {
      bucket = new TokenBucket(5, 2);
      bucket.destroy();
      // Should not throw
    });
  });

  // =========================================================================
  // messageRowToMessage
  // =========================================================================

  describe('messageRowToMessage', () => {
    it('converts a simple text message row', () => {
      const row: MessageRow = {
        id: 'msg-1',
        role: 'user',
        content: 'Hello world',
        created_at: 1700000000000,
      };

      const result = messageRowToMessage(row);
      expect(result.id).toBe('msg-1');
      expect(result.role).toBe('user');
      expect(result.content).toBe('Hello world');
      expect(result.timestamp).toBe(1700000000000);
    });

    it('converts a thinking message row', () => {
      const row: MessageRow = {
        id: 'think-1',
        role: 'assistant',
        content: '',
        msg_type: 'thinking',
        thinking: 'Let me think...',
        created_at: 1700000000000,
      };

      const result = messageRowToMessage(row);
      expect(result.msg_type).toBe('thinking');
      expect(result.thinking).toBe('Let me think...');
      expect(Array.isArray(result.content)).toBe(true);
      const blocks = result.content as Array<{ type: string; thinking: string }>;
      expect(blocks[0].type).toBe('thinking');
      expect(blocks[0].thinking).toBe('Let me think...');
    });

    it('converts a tool_use message row', () => {
      const toolInput = { file_path: '/test.ts', content: 'test' };
      const content = JSON.stringify([{ type: 'tool_use', id: 'tool-1', name: 'Write', input: toolInput }]);
      const row: MessageRow = {
        id: 'tool-1',
        role: 'assistant',
        content,
        msg_type: 'tool_use',
        tool_name: 'Write',
        tool_input: JSON.stringify(toolInput),
        created_at: 1700000000000,
      };

      const result = messageRowToMessage(row);
      expect(result.msg_type).toBe('tool_use');
      expect(result.tool_name).toBe('Write');
      expect(result.tool_call_id).toBe('tool-1');
      expect(Array.isArray(result.content)).toBe(true);
    });

    it('converts a message with JSON array content', () => {
      const contentBlocks = [
        { type: 'text', text: 'Paragraph 1' },
        { type: 'text', text: 'Paragraph 2' },
      ];
      const row: MessageRow = {
        id: 'msg-2',
        role: 'assistant',
        content: JSON.stringify(contentBlocks),
        created_at: 1700000000000,
      };

      const result = messageRowToMessage(row);
      expect(Array.isArray(result.content)).toBe(true);
      const blocks = result.content as Array<{ type: string; text: string }>;
      expect(blocks).toHaveLength(2);
    });

    it('falls back to raw content on JSON parse error', () => {
      const row: MessageRow = {
        id: 'msg-3',
        role: 'user',
        content: 'Just plain text',
        created_at: 1700000000000,
      };

      const result = messageRowToMessage(row);
      expect(result.content).toBe('Just plain text');
    });

    it('preserves tool_input and parent_tool_call_id', () => {
      const row: MessageRow = {
        id: 'tr-1',
        role: 'tool',
        content: '{"result": "ok"}',
        tool_call_id: 'parent-tool-1',
        parent_tool_call_id: 'parent-tool-1',
        msg_type: 'tool_result',
        created_at: 1700000000000,
      };

      const result = messageRowToMessage(row);
      expect(result.role).toBe('tool');
      expect(result.tool_call_id).toBe('parent-tool-1');
      expect(result.parent_tool_call_id).toBe('parent-tool-1');
    });
  });

  // =========================================================================
  // validateMessageHistory
  // =========================================================================

  describe('validateMessageHistory', () => {
    it('returns unchanged for empty array', () => {
      const result = validateMessageHistory([]);
      expect(result).toEqual([]);
    });

    it('returns unchanged when all tool_use have matching tool_result', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
        {
          id: 'a1', role: 'assistant', content: [{ type: 'tool_use', id: 'tool-1', name: 'Bash', input: { command: 'ls' } }],
          timestamp: 2, tool_call_id: 'tool-1',
        },
        { id: 'tr1', role: 'tool', content: 'OK', timestamp: 3, tool_call_id: 'tool-1' },
      ];

      const result = validateMessageHistory(messages);
      expect(result).toHaveLength(3);
    });

    it('removes tool_use without matching tool_result', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
        {
          id: 'a1', role: 'assistant', content: 'Text', timestamp: 2,
          msg_type: 'tool_use', tool_call_id: 'orphan-tool',
        },
      ];

      const result = validateMessageHistory(messages);
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('u1');
    });

    it('removes orphan tool_result only when there are also unmatched tool_uses', () => {
      // validateMessageHistory only enters the cleanup pass when
      // there are unmatched tool_uses. Orphan tool_results alone
      // won't trigger cleanup - the function returns early.
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
        { id: 'tr1', role: 'tool', content: 'result', timestamp: 2, tool_call_id: 'orphan-result' },
      ];

      const result = validateMessageHistory(messages);
      // Orphan results are only removed in second pass when there are unmatched tool_uses
      expect(result).toHaveLength(2);
    });

    it('removes orphan tool_result when also has unmatched tool_use', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
        {
          id: 'a1', role: 'assistant',
          content: 'Text',
          msg_type: 'tool_use', tool_call_id: 'orphan-tool', timestamp: 2,
        },
        { id: 'tr1', role: 'tool', content: 'result', timestamp: 3, tool_call_id: 'orphan-result' },
      ];

      const result = validateMessageHistory(messages);
      // orphan-tool (tool_use without result) is removed, and orphan-result (result without tool_use) is also removed
      expect(result).toHaveLength(1);
      expect(result[0].id).toBe('u1');
    });

    it('removes tool_use blocks from assistant content with array', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
        {
          id: 'a1', role: 'assistant',
          content: [
            { type: 'text', text: 'Before' },
            { type: 'tool_use', id: 'orphan', name: 'Write', input: {} },
            { type: 'text', text: 'After' },
          ],
          timestamp: 2,
        },
      ];

      const result = validateMessageHistory(messages);
      expect(result).toHaveLength(2);
      const asstContent = result[1].content as Array<{ type: string; text?: string }>;
      expect(asstContent).toHaveLength(2);
      expect(asstContent[0].text).toBe('Before');
      expect(asstContent[1].text).toBe('After');
    });

    it('keeps message with empty content if all blocks removed', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Hello', timestamp: 1 },
        {
          id: 'a1', role: 'assistant',
          content: [{ type: 'tool_use', id: 'orphan', name: 'Write', input: {} }],
          timestamp: 2,
        },
      ];

      const result = validateMessageHistory(messages);
      expect(result).toHaveLength(2);
      expect(result[1].content).toBe('');
    });

    it('handles complete round trip: user -> asst with tools -> tool results', () => {
      const messages: Message[] = [
        { id: 'u1', role: 'user', content: 'Write a file', timestamp: 1 },
        {
          id: 'a1', role: 'assistant',
          content: [
            { type: 'text', text: 'I will write the file' },
            { type: 'tool_use', id: 'tool-1', name: 'Write', input: { file_path: '/test.txt' } },
          ],
          timestamp: 2,
        },
        { id: 'tr1', role: 'tool', content: 'Success', timestamp: 3, tool_call_id: 'tool-1' },
        {
          id: 'a2', role: 'assistant',
          content: [{ type: 'text', text: 'File written successfully' }],
          timestamp: 4,
        },
      ];

      const result = validateMessageHistory(messages);
      expect(result).toHaveLength(4);
    });
  });

  // =========================================================================
  // convertSSEToAgentMessage
  // =========================================================================

  describe('convertSSEToAgentMessage', () => {
    it('converts text event', () => {
      const result = convertSSEToAgentMessage({ type: 'text', data: 'Hello' });
      expect(result).toEqual({ type: 'chat:text', content: 'Hello' });
    });

    it('converts thinking event', () => {
      const result = convertSSEToAgentMessage({ type: 'thinking', data: 'Hmm...' });
      expect(result).toEqual({ type: 'chat:thinking', content: 'Hmm...' });
    });

    it('converts tool_use event', () => {
      const result = convertSSEToAgentMessage({
        type: 'tool_use',
        data: { id: 'tool-1', name: 'Bash', input: { command: 'ls' } },
      });
      expect(result).toEqual({
        type: 'chat:tool_use',
        id: 'tool-1',
        name: 'Bash',
        input: { command: 'ls' },
      });
    });

    it('converts tool_result event', () => {
      const result = convertSSEToAgentMessage({
        type: 'tool_result',
        data: { id: 'tool-1', result: 'file list...', error: false },
      });
      expect(result).toEqual({
        type: 'chat:tool_result',
        id: 'tool-1',
        result: 'file list...',
        error: false,
      });
    });

    it('converts done event', () => {
      const result = convertSSEToAgentMessage({ type: 'done' });
      expect(result).toEqual({ type: 'chat:done' });
    });

    it('converts error event', () => {
      const result = convertSSEToAgentMessage({ type: 'error', data: 'Failed' });
      expect(result).toEqual({ type: 'chat:error', message: 'Failed' });
    });

    it('converts result (token usage) event', () => {
      const usage = { input_tokens: 100, output_tokens: 50 };
      const result = convertSSEToAgentMessage({ type: 'result', data: usage });
      expect(result?.type).toBe('chat:token_usage');
      expect((result as { input_tokens: number }).input_tokens).toBe(100);
    });

    it('returns null for unknown event type', () => {
      const result = convertSSEToAgentMessage({ type: 'unknown_event' });
      expect(result).toBeNull();
    });
  });
});