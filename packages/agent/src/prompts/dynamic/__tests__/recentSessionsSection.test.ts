/**
 * Recent-sessions utilities — Plan 560.
 *
 * The section body is fully rendered by `assets/dynamic/recent-sessions.hbs`;
 * this file covers the per-entry JSON serialization + ` - ${entry}\n`
 * join the .hbs mapper consumes.
 */

import { describe, expect, it } from 'vitest';
import type { RecentSessionDirectoryEntry } from '../../../session/recent-session-directory.js';
import {
  serializeEntry,
  serializeSerializedGroup,
} from '../recentSessionsSection.js';

function makeEntry(overrides: Partial<RecentSessionDirectoryEntry> = {}): RecentSessionDirectoryEntry {
  return {
    sessionId: 'sess-1',
    title: 'T',
    projectName: 'duya',
    updatedAt: Date.UTC(2026, 0, 10, 12, 0, 0),
    childCount: 0,
    agentType: 'general',
    ...overrides,
  };
}

describe('recent-sessions utilities', () => {
  it('serializeEntry emits the legacy JSON shape the .hbs iterates over', () => {
    const json = serializeEntry(makeEntry({
      sessionId: 'abc',
      title: 'Hello',
      projectName: 'duya',
      updatedAt: Date.UTC(2026, 0, 10, 12, 0, 0),
      childCount: 2,
    }));
    const parsed = JSON.parse(json);
    expect(parsed).toEqual({
      sessionId: 'abc',
      title: 'Hello',
      project: 'duya',
      updatedAt: '2026-01-10T12:00:00.000Z',
      childSessions: 2,
    });
  });

  describe('serializeSerializedGroup (the body block join)', () => {
    it('returns "- none" for an empty list', () => {
      expect(serializeSerializedGroup([])).toBe('- none');
    });

    it('joins already-serialised JSON strings with ` - ` prefix + newline', () => {
      const out = serializeSerializedGroup(['{"a":1}', '{"b":2}']);
      expect(out).toBe('- {"a":1}\n- {"b":2}');
    });

    it('does not re-serialise (operates on string[] — mapper caller serialises)', () => {
      const already = '{"x":"y"}';
      expect(serializeSerializedGroup([already])).toBe(`- ${already}`);
    });
  });
});