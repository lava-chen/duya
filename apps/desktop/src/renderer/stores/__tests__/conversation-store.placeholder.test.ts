// Plan 491 P2.5 — regression tests for the "click on a brand-new bot
// looks like a no-op" bug.
//
// Root cause: `setActiveThread('bot:<agentId>')` set the placeholder id
// as the active thread, then `loadFromDatabase`'s orphan-cleanup branch
// cleared it back to null because no `chat_sessions` row matches the
// placeholder. The user briefly saw the bot's empty chat shell, then
// the view snapped back to the welcome screen — looking like nothing
// happened.
//
// Fix:
//   - `isPlaceholderBotThreadId` recognizes the placeholder shape
//     (`bot:<agentId>`, exactly one colon) so two consumers can branch
//     on it: persist partialize drops the placeholder (D1), and
//     loadFromDatabase's cleanup skips clearing it (D2).
//   - The sidebar's post-create fast-path (`handleOpenBotById` in
//     app-sidebar.tsx) navigates by agent id without waiting for the
//     `botContacts` closure to refresh.
//
// This file only tests the pure helper. Partialize / loadFromDatabase
// behaviour is exercised through the rest of the app's smoke tests;
// unit-testing those requires a full ipc-client mock and is left for
// the integration layer.

import { describe, expect, it } from 'vitest';
import {
  isPlaceholderBotThreadId,
  partializeConversationState,
} from '../conversation-store';

describe('isPlaceholderBotThreadId (plan 491 P2.5)', () => {
  it('returns false for null / undefined / empty string', () => {
    expect(isPlaceholderBotThreadId(null)).toBe(false);
    expect(isPlaceholderBotThreadId(undefined)).toBe(false);
    expect(isPlaceholderBotThreadId('')).toBe(false);
  });

  it('returns true for the bare placeholder `bot:<agentId>` (one colon)', () => {
    // Exactly the shape produced by `deriveBotPlaceholderThreadId` in
    // sidebar/bot-contacts.ts. Examples taken from real bot ids in the
    // project so a future "rebrand" of the prefix would also break
    // this test and force a sync update.
    expect(isPlaceholderBotThreadId('bot:frontend-expert')).toBe(true);
    expect(isPlaceholderBotThreadId('bot:reviewer')).toBe(true);
    expect(isPlaceholderBotThreadId('bot:fe')).toBe(true);
  });

  it('returns false for a real bound bot session (two colons)', () => {
    // Real session shape per plan 477: `bot:<agentId>:<sessionId>`.
    // The second colon distinguishes it from the placeholder and the
    // helper MUST NOT confuse the two — otherwise the persist path
    // would drop real sessions too.
    expect(isPlaceholderBotThreadId('bot:frontend-expert:abc-123')).toBe(false);
    expect(isPlaceholderBotThreadId('bot:fe:550e8400-e29b-41d4-a716-446655440000')).toBe(
      false,
    );
  });

  it('returns false for non-bot thread kinds (room, cron, gw-, wakeless-)', () => {
    // Sanity check the prefix is `bot:`-specific. The helper is named
    // `isPlaceholderBotThreadId`; room / cron / gateway threads should
    // never enter this branch even if someone passes a stale id.
    expect(isPlaceholderBotThreadId('room:general')).toBe(false);
    expect(isPlaceholderBotThreadId('cron:cleanup')).toBe(false);
    expect(isPlaceholderBotThreadId('gw-abc-123')).toBe(false);
    expect(isPlaceholderBotThreadId('wakeless-evening')).toBe(false);
  });

  it('returns false for main-agent session ids (UUID without bot prefix)', () => {
    // Plan 477 main-agent threads are random UUIDs. They share the
    // `length === 2` split-count by accident only when they happen to
    // contain no colons — but they lack the `bot:` prefix so the
    // startsWith check rejects them. This guards against a future
    // refactor that moves the placeholder shape away from bot:.
    expect(isPlaceholderBotThreadId('550e8400-e29b-41d4-a716-446655440000')).toBe(false);
  });

  it('treats a stray `bot:` with empty agent id as placeholder', () => {
    // `bot:` alone is not a valid id (we never produce it), but if it
    // somehow shows up the function must not misclassify. `split(':').length`
    // for `bot:` is 2 (one trailing empty string), so it returns true.
    // We do not depend on this — the check is intentionally permissive
    // because the function's job is "is this NOT a real session we
    // expect in chat_sessions?", and `bot:` is not a real session.
    expect(isPlaceholderBotThreadId('bot:')).toBe(true);
  });
});

// Plan 491 P2.5 — partialize branch (D1).
// The persist middleware delegates to the pure
// `partializeConversationState` helper, so we can test the
// placeholder-round-trip directly without spinning up localStorage /
// jsdom. The persisted shape mirrors what the middleware passes in.
describe('partialize drops placeholder bot activeThreadId (plan 491 P2.5)', () => {
  function stateWith(activeThreadId: string | null) {
    return {
      currentView: 'chat' as const,
      settingsTab: 'general' as const,
      activeThreadId,
      collapsedProjects: [],
      expandedThreads: [],
      projectSortBy: 'lastActivity' as const,
      projectGroupBy: 'byProject' as const,
      lastSyncAt: 0,
      newChatDraft: { text: '', attachments: [], hasContent: false },
    };
  }

  it('writes placeholder `bot:<agentId>` as null (regression: re-clear loop)', () => {
    const out = partializeConversationState(stateWith('bot:frontend-expert'));
    expect(out.activeThreadId).toBeNull();
  });

  it('preserves a real bot session id (two colons)', () => {
    const out = partializeConversationState(stateWith('bot:frontend-expert:abc-123'));
    expect(out.activeThreadId).toBe('bot:frontend-expert:abc-123');
  });

  it('preserves a main-agent UUID session id', () => {
    const out = partializeConversationState(
      stateWith('550e8400-e29b-41d4-a716-446655440000'),
    );
    expect(out.activeThreadId).toBe('550e8400-e29b-41d4-a716-446655440000');
  });

  it('preserves null', () => {
    const out = partializeConversationState(stateWith(null));
    expect(out.activeThreadId).toBeNull();
  });

  it('preserves non-bot session kinds (room, cron, gw-, wakeless-)', () => {
    const ids = ['room:general', 'cron:cleanup', 'gw-abc-123', 'wakeless-evening'];
    for (const id of ids) {
      const out = partializeConversationState(stateWith(id));
      expect(out.activeThreadId).toBe(id);
    }
  });
});
