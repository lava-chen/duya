import { describe, it, expect } from 'vitest';
import {
  detectThreadKind,
  bucketThreadsByKind,
  SYSTEM_SECTIONS,
  SESSION_KIND_PREFIXES,
  isPlaceholderThreadId,
} from './section-system';
import type { Thread } from '@/stores/conversation-store';

function makeThread(overrides: Partial<Thread> & { id: string }): Thread {
  return {
    title: overrides.id,
    workingDirectory: null,
    projectName: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...overrides,
  };
}

describe('section-system bot/room prefixes (plan 483 P1.1)', () => {
  it('declares bot: and room: kind prefixes', () => {
    expect(SESSION_KIND_PREFIXES.bot).toBe('bot:');
    expect(SESSION_KIND_PREFIXES.room).toBe('room:');
  });

  it('registers a __system__:bots section descriptor', () => {
    const bots = SYSTEM_SECTIONS.find((s) => s.id === '__system__:bots');
    expect(bots).toBeDefined();
    expect(bots?.kind).toBe('bot');
    expect(bots?.labelKey).toBe('sidebar.section.bots');
    expect(bots?.builtin).toBe(true);
  });

  it('detects bot-bound persistent sessions (bot:<agentId>:<sessionId>)', () => {
    const thread = makeThread({ id: 'bot:frontend-expert:s-123' });
    expect(detectThreadKind(thread)).toBe('bot');
  });

  it('detects room sessions (room:<roomId>)', () => {
    const thread = makeThread({ id: 'room:product-discussion' });
    expect(detectThreadKind(thread)).toBe('room');
  });

  it('detects bare bot placeholder ids (bot:<agentId>)', () => {
    const thread = makeThread({ id: 'bot:frontend-expert' });
    expect(detectThreadKind(thread)).toBe('bot');
  });

  it('still detects the pre-existing kinds', () => {
    expect(detectThreadKind(makeThread({ id: 'cron:daily-1' }))).toBe('cron');
    expect(detectThreadKind(makeThread({ id: 'gw-abc' }))).toBe('gateway');
    expect(detectThreadKind(makeThread({ id: 'wakeless-x' }))).toBe('wakeup');
    expect(detectThreadKind(makeThread({ id: 't1', pinned: 1 }))).toBe('pinned');
  });

  it('excludes sub-agents from bot routing', () => {
    const thread = makeThread({ id: 'bot:frontend-expert:s-1', parentId: 'parent-1' });
    expect(detectThreadKind(thread)).toBeNull();
  });

  it('buckets bot and room threads separately from project threads', () => {
    const buckets = bucketThreadsByKind([
      makeThread({ id: 'bot:frontend-expert:s-1' }),
      makeThread({ id: 'room:product-discussion' }),
      makeThread({ id: 'normal-thread' }),
    ]);
    expect(buckets.bot).toHaveLength(1);
    expect(buckets.room).toHaveLength(1);
    expect(buckets.project_ungrouped).toHaveLength(1);
  });
});

describe('isPlaceholderThreadId (plan 505)', () => {
  it('returns true for a bot placeholder bot:<agentId>', () => {
    expect(isPlaceholderThreadId('bot:frontend-expert', 'bot')).toBe(true);
  });

  it('returns false for a bound bot session bot:<agentId>:<sessionId>', () => {
    expect(isPlaceholderThreadId('bot:frontend-expert:abc-123', 'bot')).toBe(false);
  });

  it('returns true for a room placeholder room:<roomId> (defensive)', () => {
    expect(isPlaceholderThreadId('room:product-discussion', 'room')).toBe(true);
  });

  it('returns false when the id does not use the requested kind prefix', () => {
    expect(isPlaceholderThreadId('cron:daily-1', 'bot')).toBe(false);
    expect(isPlaceholderThreadId('550e8400-e29b-41d4-a716-446655440000', 'bot')).toBe(false);
  });

  it('returns false for null / undefined', () => {
    expect(isPlaceholderThreadId(null, 'bot')).toBe(false);
    expect(isPlaceholderThreadId(undefined, 'bot')).toBe(false);
  });
});
