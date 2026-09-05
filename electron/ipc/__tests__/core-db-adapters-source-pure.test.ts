/**
 * core-db-adapters-source-pure.test.ts — Plan 489 P0.1
 *
 * Pure-function coverage of `inferMessageSource` — does not require
 * better-sqlite3 to load, so it runs even when the electron ABI is locked.
 *
 * The integration tests (round-trip through MessageLog + StoredEvent)
 * live in `core-db-adapters-source.test.ts` and need native sqlite.
 */
import { describe, expect, it } from 'vitest';
import { __test__inferMessageSource as inferMessageSource } from '../core-db-adapters';

describe('Plan 489 P0.1 — inferMessageSource (pure function)', () => {
  describe('explicit source wins', () => {
    it.each([
      'user',
      'send_message',
      'tool_use',
      'thinking',
      'scratchpad',
      'system',
      'channel_mirror',
    ] as const)('honors explicit source=%s', (source) => {
      const dto = { role: 'assistant', msg_type: 'text', source } as never;
      expect(inferMessageSource(dto)).toBe(source);
    });

    it('ignores unknown explicit source strings and falls back to inferred default', () => {
      const dto = {
        role: 'assistant',
        msg_type: 'text',
        source: 'this_is_made_up',
      } as never;
      expect(inferMessageSource(dto)).toBe('scratchpad');
    });
  });

  describe('role-based classification', () => {
    it('role=user → user', () => {
      expect(inferMessageSource({ role: 'user' } as never)).toBe('user');
    });

    it('role=system → system', () => {
      expect(inferMessageSource({ role: 'system' } as never)).toBe('system');
    });

    it('role=tool → tool_use (tool_result block)', () => {
      expect(inferMessageSource({ role: 'tool' } as never)).toBe('tool_use');
    });

    it('role=assistant + no msg_type → scratchpad (plain text default)', () => {
      expect(inferMessageSource({ role: 'assistant' } as never)).toBe('scratchpad');
    });
  });

  describe('msg_type classification', () => {
    it('msg_type=thinking → thinking', () => {
      expect(
        inferMessageSource({ role: 'assistant', msg_type: 'thinking' } as never),
      ).toBe('thinking');
    });

    it('msg_type=tool_use → tool_use', () => {
      expect(
        inferMessageSource({ role: 'assistant', msg_type: 'tool_use' } as never),
      ).toBe('tool_use');
    });

    it('msg_type=tool_result → tool_use', () => {
      expect(
        inferMessageSource({ role: 'assistant', msg_type: 'tool_result' } as never),
      ).toBe('tool_use');
    });

    it('msg_type is case-insensitive', () => {
      expect(
        inferMessageSource({ role: 'assistant', msg_type: 'THINKING' } as never),
      ).toBe('thinking');
      expect(
        inferMessageSource({ role: 'assistant', msg_type: 'Tool_Use' } as never),
      ).toBe('tool_use');
    });
  });

  describe('runtime-context cue classification', () => {
    it.each([
      'mailbox',
      'task-notification',
      'task_notification',
      'mode',
      'mode_changed',
      'memory',
      'goal_summary',
      'research_continuation',
      'attachment',
      'runtime_context',
    ])('msg_type=%s → system', (msgType) => {
      expect(
        inferMessageSource({ role: 'system', msg_type: msgType } as never),
      ).toBe('system');
    });
  });

  describe('precedence (role > msg_type > runtime cues > default)', () => {
    it('role=tool wins over msg_type=mailbox (tool result IS tool_use, not system)', () => {
      // tool result rows are role='tool' regardless of any msg_type hint
      expect(
        inferMessageSource({ role: 'tool', msg_type: 'mailbox' } as never),
      ).toBe('tool_use');
    });

    it('explicit source wins over everything else', () => {
      expect(
        inferMessageSource({
          role: 'user',
          msg_type: 'thinking',
          source: 'send_message',
        } as never),
      ).toBe('send_message');
    });
  });

  describe('bot-direct filter composition (P0.3 contract)', () => {
    // Simulates the projection BotDirectChatView will run after P0.3 lands.
    // Verifies that the inference rules produce values that the filter
    // accepts/rejects correctly.
    const visible = new Set(['user', 'send_message']);
    const isBotDirectVisible = (s: string | undefined) =>
      typeof s === 'string' && visible.has(s);

    it.each([
      ['user', true],
      ['send_message', true],
      ['scratchpad', false],
      ['tool_use', false],
      ['thinking', false],
      ['system', false],
    ] as const)('source=%s → botDirectVisible=%s', (source, expected) => {
      const dto = { role: 'assistant', msg_type: 'text', source } as never;
      expect(isBotDirectVisible(inferMessageSource(dto))).toBe(expected);
    });
  });
});
