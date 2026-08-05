/**
 * DB row -> Agent -> legacy persistence round-trip tests (Plan 315).
 *
 * Verifies the Legacy type boundary contract enforced by
 * `projectDurableMessages` in agent-process-entry.ts:
 *
 *   DB MessageRow
 *     -> messageRowToMessage (session/db.ts)        -> legacy Message[]
 *     -> normalizeLegacyHistory (message-ingress)    -> AgentMessage[]
 *     -> projectPersistenceMessages (projectors)     -> durable Message[]
 *
 * The durable projection is what reaches `messageDb.add/append/replace`.
 * Transient/hidden runtime context must never appear in the durable output,
 * and provider state, thinking signatures, attachments, token usage, and
 * seq_index must survive the round-trip losslessly.
 */

import { describe, expect, it } from 'vitest';
import type { Message } from '../../src/types.js';
import { messageRowToMessage, type MessageRow } from '../../src/session/db.js';
import {
  legacyMessageToAgentMessage,
  legacyMessagesToAgentMessages,
} from '../../src/message/legacy-message-adapter.js';
import {
  getLegacyCompactionCheckpoint,
  projectPersistenceMessages,
  projectTimelinePersistenceMessages,
} from '../../src/message/message-projectors.js';

// Mirrors the durable projection exercised by the Agent's persistence
// boundary: legacy Message[] -> AgentMessage[] (via the lossless adapter)
// -> durable Message[] (via the persistence projector). The same pipeline
// runs inside `DuyaAgent.getMessages()` through
// `projectTimelinePersistenceMessages`.
function projectDurableMessages(messages: readonly Message[]): Message[] {
  const agentMessages = legacyMessagesToAgentMessages(messages);
  return projectPersistenceMessages(agentMessages);
}

// ─── DB row builders ────────────────────────────────────────────────────

function makeRow(overrides: Partial<MessageRow> & Pick<MessageRow, 'id' | 'role' | 'content'>): MessageRow {
  return {
    session_id: 'session-1',
    display_content: null,
    name: null,
    tool_call_id: null,
    token_usage: null,
    msg_type: '',
    thinking: null,
    tool_name: null,
    tool_input: null,
    parent_tool_call_id: null,
    viz_spec: null,
    status: '',
    seq_index: null,
    duration_ms: null,
    sub_agent_id: null,
    attachments: null,
    provider_state: null,
    thinking_signature: null,
    tool_signature: null,
    text_signature: null,
    created_at: 1_700_000_000_000,
    ...overrides,
  };
}

// ─── Round-trip tests ───────────────────────────────────────────────────

describe('DB row -> Agent -> legacy persistence round-trip', () => {
  it('round-trips a compaction checkpoint through msg_type and tool_input', () => {
    const retained = legacyMessageToAgentMessage({
      id: 'retained-user',
      role: 'user',
      content: 'continue from here',
      timestamp: 20,
    });
    const persisted = projectTimelinePersistenceMessages([
      {
        type: 'message',
        id: 'retained-entry',
        parentId: null,
        createdAt: retained.createdAt,
        message: retained,
      },
      {
        type: 'compaction',
        id: 'checkpoint-1',
        parentId: null,
        createdAt: 10,
        summary: 'earlier work summary',
        firstKeptMessageId: 'retained-user',
        compactedMessageIds: ['old-user', 'old-assistant'],
        tokensBefore: 100,
        tokensAfter: 30,
        strategy: 'test',
        reinjectedSystemMessages: ['reinject files'],
      },
    ]);
    const marker = persisted[0]!;
    expect(marker).toMatchObject({
      msg_type: 'compact_checkpoint',
      tool_input: expect.any(String),
    });
    expect(marker.metadata).toBeUndefined();

    const loaded = messageRowToMessage(makeRow({
      id: marker.id!,
      role: 'system',
      content: marker.content as string,
      msg_type: marker.msg_type!,
      tool_input: marker.tool_input!,
      created_at: marker.timestamp!,
    }));
    expect(getLegacyCompactionCheckpoint(loaded)).toMatchObject({
      id: 'checkpoint-1',
      firstKeptMessageId: 'retained-user',
      reinjectedSystemMessages: ['reinject files'],
    });
  });

  it('preserves provider state, signatures, token usage, attachments, and seq_index for an assistant tool round', () => {
    const rows: MessageRow[] = [
      makeRow({
        id: 'user-1',
        role: 'user',
        content: 'Read the README',
        seq_index: 0,
        attachments: JSON.stringify([{ name: 'README.md', type: 'text/plain' }]),
      }),
      // Assistant thinking + text response (msg_type empty → content parsed as array).
      makeRow({
        id: 'assistant-1',
        role: 'assistant',
        content: JSON.stringify([
          { type: 'thinking', thinking: 'I should read the file first.' },
          { type: 'text', text: 'Let me read it.' },
        ]),
        seq_index: 1,
        token_usage: JSON.stringify({ input_tokens: 120, output_tokens: 30 }),
        provider_state: JSON.stringify({ api: 'anthropic', providerId: 'anthropic', model: 'claude-3-sonnet' }),
        thinking_signature: 'thinking-sig',
        text_signature: 'text-sig',
        status: 'completed',
        duration_ms: 42,
      }),
      // Assistant tool_use (msg_type='tool_use' → content is single tool_use block).
      makeRow({
        id: 'assistant-2',
        role: 'assistant',
        content: JSON.stringify([
          { type: 'tool_use', id: 'call-1', name: 'read', input: { path: 'README.md' } },
        ]),
        msg_type: 'tool_use',
        tool_name: 'read',
        tool_input: JSON.stringify({ path: 'README.md' }),
        tool_call_id: 'call-1',
        seq_index: 2,
        tool_signature: 'tool-sig',
      }),
      makeRow({
        id: 'tool-1',
        role: 'tool',
        content: 'File contents here',
        tool_call_id: 'call-1',
        name: 'read',
        msg_type: 'tool_result',
        seq_index: 3,
      }),
    ];

    // Step 1: DB rows -> legacy Messages (as agent-process-entry does on load).
    const legacyMessages = rows.map((row) => messageRowToMessage(row));

    // Step 2: legacy Messages -> Agent domain -> durable persistence projection.
    const durable = projectDurableMessages(legacyMessages);

    expect(durable).toHaveLength(4);
    expect(durable.map((m) => m.id)).toEqual([
      'user-1', 'assistant-1', 'assistant-2', 'tool-1',
    ]);

    // User message: attachments and seq_index preserved.
    expect(durable[0]).toMatchObject({
      role: 'user',
      content: 'Read the README',
      seq_index: 0,
    });
    expect(durable[0].attachments).toEqual([{ name: 'README.md', type: 'text/plain' }]);

    // Assistant text+thinking: provider state, signatures, token usage, seq_index preserved.
    const assistant = durable[1];
    expect(assistant.role).toBe('assistant');
    expect(assistant.seq_index).toBe(1);
    expect(assistant.tokenUsage).toEqual({ input_tokens: 120, output_tokens: 30 });
    expect(assistant.api).toBe('anthropic');
    expect(assistant.providerId).toBe('anthropic');
    expect(assistant.model).toBe('claude-3-sonnet');
    expect(assistant.status).toBe('completed');
    expect(assistant.duration_ms).toBe(42);

    // Signatures restored into content blocks.
    const blocks = assistant.content as unknown as Array<{ type: string; [key: string]: unknown }>;
    const thinkingBlock = blocks.find((b) => b.type === 'thinking');
    const textBlock = blocks.find((b) => b.type === 'text');
    expect(thinkingBlock?.thinkingSignature).toBe('thinking-sig');
    expect(textBlock?.textSignature).toBe('text-sig');

    // Tool_use row: tool_signature preserved on the tool_use block.
    const toolUseMsg = durable[2];
    expect(toolUseMsg.seq_index).toBe(2);
    const toolUseBlocks = toolUseMsg.content as unknown as Array<{ type: string; [key: string]: unknown }>;
    expect(toolUseBlocks.find((b) => b.type === 'tool_use')?.thoughtSignature).toBe('tool-sig');

    // Tool result: tool_call_id pairing preserved.
    expect(durable[3]).toMatchObject({
      role: 'tool',
      tool_call_id: 'call-1',
      name: 'read',
      seq_index: 3,
    });
  });

  it('filters out transient runtime context (mailbox, task notifications) from the durable projection', () => {
    const rows: MessageRow[] = [
      makeRow({
        id: 'user-1',
        role: 'user',
        content: 'Do the task',
        seq_index: 0,
      }),
      // Mailbox instruction — transient, must not reach messageDb.
      makeRow({
        id: 'mailbox-1',
        role: 'user',
        content: 'Continue with this instruction',
        msg_type: 'mailbox',
        seq_index: 1,
      }),
      // Background task notification — transient, must not reach messageDb.
      makeRow({
        id: 'task-1',
        role: 'user',
        content: '<task-notification>done</task-notification>',
        msg_type: 'task_notification',
        seq_index: 2,
      }),
      makeRow({
        id: 'assistant-1',
        role: 'assistant',
        content: 'Done',
        seq_index: 3,
      }),
    ];

    const legacyMessages = rows.map((row) => messageRowToMessage(row));
    const durable = projectDurableMessages(legacyMessages);

    // Only durable messages survive: user-1 and assistant-1.
    expect(durable.map((m) => m.id)).toEqual(['user-1', 'assistant-1']);
    expect(durable.map((m) => m.id)).not.toContain('mailbox-1');
    expect(durable.map((m) => m.id)).not.toContain('task-1');
  });

  it('preserves compaction summaries and boundaries as durable legacy messages', () => {
    const rows: MessageRow[] = [
      makeRow({
        id: 'summary-1',
        role: 'user',
        content: 'Earlier work summary',
        msg_type: 'compact_summary',
        seq_index: 0,
        // Compaction fields stored as extra columns or in metadata.
        // The adapter preserves unknown fields via the legacy envelope.
      }),
      makeRow({
        id: 'boundary-1',
        role: 'user',
        content: '',
        msg_type: 'compact_boundary',
        seq_index: 1,
      }),
      makeRow({
        id: 'user-1',
        role: 'user',
        content: 'After compaction',
        seq_index: 2,
      }),
    ];

    const legacyMessages = rows.map((row) => messageRowToMessage(row));

    // Mark compaction fields on the legacy messages (as the runtime would).
    const withCompaction: Message[] = legacyMessages.map((m, i) => {
      if (i === 0) {
        return {
          ...m,
          isCompactSummary: true,
          compactBoundaryId: 'boundary-1',
          compactedMessageCount: 12,
          compactedMessageIds: ['u0', 'a0'],
        };
      }
      if (i === 1) {
        return { ...m, isCompactBoundary: true };
      }
      return m;
    });

    const durable = projectDurableMessages(withCompaction);

    expect(durable).toHaveLength(3);
    expect(durable[0]).toMatchObject({
      isCompactSummary: true,
      compactBoundaryId: 'boundary-1',
      compactedMessageCount: 12,
    });
    expect(durable[1]).toMatchObject({ isCompactBoundary: true });
    expect(durable[2]).toMatchObject({ role: 'user', content: 'After compaction' });
  });

  it('keeps complete tool rounds intact through the round-trip', () => {
    const rows: MessageRow[] = [
      makeRow({ id: 'user-1', role: 'user', content: 'Run two tools', seq_index: 0 }),
      // First tool round (tool_use block must be first for msg_type='tool_use').
      makeRow({
        id: 'asst-1',
        role: 'assistant',
        content: JSON.stringify([
          { type: 'tool_use', id: 'call-A', name: 'Bash', input: { command: 'echo A' } },
        ]),
        msg_type: 'tool_use',
        tool_name: 'Bash',
        tool_input: JSON.stringify({ command: 'echo A' }),
        tool_call_id: 'call-A',
        seq_index: 1,
      }),
      makeRow({
        id: 'tool-A',
        role: 'tool',
        content: 'A',
        tool_call_id: 'call-A',
        name: 'Bash',
        seq_index: 2,
      }),
      // Second tool round (tool_use block must be first for msg_type='tool_use').
      makeRow({
        id: 'asst-2',
        role: 'assistant',
        content: JSON.stringify([
          { type: 'tool_use', id: 'call-B', name: 'Bash', input: { command: 'echo B' } },
        ]),
        msg_type: 'tool_use',
        tool_name: 'Bash',
        tool_input: JSON.stringify({ command: 'echo B' }),
        tool_call_id: 'call-B',
        seq_index: 3,
      }),
      makeRow({
        id: 'tool-B',
        role: 'tool',
        content: 'B',
        tool_call_id: 'call-B',
        name: 'Bash',
        seq_index: 4,
      }),
      // Final assistant text.
      makeRow({
        id: 'asst-3',
        role: 'assistant',
        content: 'Both tools done',
        seq_index: 5,
      }),
    ];

    const legacyMessages = rows.map((row) => messageRowToMessage(row));
    const durable = projectDurableMessages(legacyMessages);

    // All 6 messages are durable; none should be dropped.
    expect(durable).toHaveLength(6);
    expect(durable.map((m) => m.id)).toEqual([
      'user-1',
      'asst-1',
      'tool-A',
      'asst-2',
      'tool-B',
      'asst-3',
    ]);

    // Tool pairing preserved: each tool_use id has a matching tool_result.
    const toolUseIds = new Set<string>();
    const toolResultIds = new Set<string>();
    for (const msg of durable) {
      if (msg.msg_type === 'tool_use' && msg.tool_call_id) {
        toolUseIds.add(msg.tool_call_id);
      } else if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id);
      }
    }
    expect(toolUseIds).toEqual(new Set(['call-A', 'call-B']));
    expect(toolResultIds).toEqual(new Set(['call-A', 'call-B']));
  });

  it('round-trips a full conversation with mixed content types losslessly', () => {
    const rows: MessageRow[] = [
      // User with image attachment.
      makeRow({
        id: 'user-img',
        role: 'user',
        content: JSON.stringify([
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'iVBOR...' } },
        ]),
        seq_index: 0,
        attachments: JSON.stringify([{ name: 'chart.png', type: 'image/png' }]),
      }),
      // Assistant with thinking + text + signatures.
      makeRow({
        id: 'asst-1',
        role: 'assistant',
        content: JSON.stringify([
          { type: 'thinking', thinking: 'Analyzing the image.' },
          { type: 'text', text: 'It is a bar chart.' },
        ]),
        seq_index: 1,
        thinking_signature: 'think-sig-1',
        text_signature: 'text-sig-1',
        provider_state: JSON.stringify({ api: 'anthropic', providerId: 'anthropic', model: 'claude-3-opus' }),
        token_usage: JSON.stringify({ input_tokens: 500, output_tokens: 80 }),
        status: 'completed',
        duration_ms: 1500,
      }),
    ];

    const legacyMessages = rows.map((row) => messageRowToMessage(row));
    const original = structuredClone(legacyMessages);
    const durable = projectDurableMessages(legacyMessages);

    // Both messages are durable.
    expect(durable).toHaveLength(2);

    // The legacy envelope round-trips losslessly: the durable projection
    // equals the original legacy Message for each row.
    expect(durable).toEqual(original);

    // Verify key fields explicitly.
    expect(durable[0].attachments).toEqual([{ name: 'chart.png', type: 'image/png' }]);
    expect(durable[0].seq_index).toBe(0);

    expect(durable[1].api).toBe('anthropic');
    expect(durable[1].providerId).toBe('anthropic');
    expect(durable[1].model).toBe('claude-3-opus');
    expect(durable[1].tokenUsage).toEqual({ input_tokens: 500, output_tokens: 80 });
    expect(durable[1].seq_index).toBe(1);
    expect(durable[1].status).toBe('completed');
    expect(durable[1].duration_ms).toBe(1500);

    const blocks = durable[1].content as unknown as Array<{ type: string; [key: string]: unknown }>;
    expect(blocks.find((b) => b.type === 'thinking')?.thinkingSignature).toBe('think-sig-1');
    expect(blocks.find((b) => b.type === 'text')?.textSignature).toBe('text-sig-1');
  });

  it('does not mutate the input legacy Messages array (purity)', () => {
    const rows: MessageRow[] = [
      makeRow({ id: 'user-1', role: 'user', content: 'hello', seq_index: 0 }),
      makeRow({
        id: 'mailbox-1',
        role: 'user',
        content: 'transient instruction',
        msg_type: 'mailbox',
        seq_index: 1,
      }),
      makeRow({ id: 'asst-1', role: 'assistant', content: 'hi', seq_index: 2 }),
    ];

    const legacyMessages = rows.map((row) => messageRowToMessage(row));
    const before = structuredClone(legacyMessages);

    projectDurableMessages(legacyMessages);

    expect(legacyMessages).toEqual(before);
  });

  it('produces deterministic output across repeated calls', () => {
    const rows: MessageRow[] = [
      makeRow({ id: 'user-1', role: 'user', content: 'hello', seq_index: 0 }),
      makeRow({
        id: 'asst-1',
        role: 'assistant',
        content: JSON.stringify([{ type: 'text', text: 'hi' }]),
        seq_index: 1,
        provider_state: JSON.stringify({ api: 'anthropic', providerId: 'anthropic', model: 'claude-3' }),
      }),
    ];

    const legacyMessages = rows.map((row) => messageRowToMessage(row));

    const first = projectDurableMessages(legacyMessages);
    const second = projectDurableMessages(legacyMessages);

    expect(first).toEqual(second);
  });
});
