/**
 * Group turn mechanics tests (Plan 478 P1.3) — grok-alignment cases.
 * The pure core must behave exactly like grok-bot 0.18 group-chat.ts +
 * group-chat-orchestrator.ts.
 */

import { describe, expect, it, vi } from 'vitest';
import {
  GROUP_MAX_MESSAGES_PER_TURN,
  GroupChatOrchestrator,
  buildGroupMemberWakePrompt,
  isPassContent,
  memberMentionHandles,
  messagesSinceMemberLastSpoke,
  orderRoundSpeakers,
  parseGroupMentions,
  resolveResponders,
  type GroupMember,
  type GroupMessage,
  type GroupOrchestratorDeps,
} from '../groupTurn.js';

const MEMBERS: GroupMember[] = [
  { id: 'ada', name: 'Ada Lovelace', description: 'math' },
  { id: 'bob', name: 'Bob', description: 'ops' },
  { id: 'carol', name: 'Carol', description: 'review' },
];

describe('memberMentionHandles', () => {
  it('derives full, no-space, and first-word handles', () => {
    expect(memberMentionHandles('Ada Lovelace')).toEqual(['ada lovelace', 'adalovelace', 'ada']);
  });

  it('handles empty names', () => {
    expect(memberMentionHandles('   ')).toEqual([]);
  });
});

describe('parseGroupMentions', () => {
  it('matches word-bounded @Name', () => {
    const result = parseGroupMentions('hey @Bob can you look', MEMBERS);
    expect(result).toEqual({ isEveryone: false, memberIds: ['bob'] });
  });

  it('ignores matches inside ASCII words', () => {
    expect(parseGroupMentions('email bob@example.com', MEMBERS).memberIds).toEqual([]);
  });

  it('matches the first-word handle', () => {
    expect(parseGroupMentions('@ada please', MEMBERS).memberIds).toEqual(['ada']);
  });

  it('supports @everyone and @all', () => {
    expect(parseGroupMentions('@everyone ship it', MEMBERS).isEveryone).toBe(true);
    expect(parseGroupMentions('shipped @all', MEMBERS).isEveryone).toBe(true);
    expect(parseGroupMentions('someone@allthings', MEMBERS).isEveryone).toBe(false);
  });

  it('deduplicates multiple mentions of the same member', () => {
    expect(parseGroupMentions('@Bob @Bob @Bob', MEMBERS).memberIds).toEqual(['bob']);
  });
});

describe('resolveResponders', () => {
  it('returns all members when nobody is mentioned', () => {
    const history: GroupMessage[] = [{ speaker: { kind: 'user' }, content: 'hello room' }];
    expect(resolveResponders(MEMBERS, history).map((m) => m.id)).toEqual(['ada', 'bob', 'carol']);
  });

  it('narrows to mentioned members only', () => {
    const history: GroupMessage[] = [
      { speaker: { kind: 'user' }, content: 'please look @Carol and @Bob' },
    ];
    expect(resolveResponders(MEMBERS, history).map((m) => m.id)).toEqual(['bob', 'carol']);
  });

  it('only considers messages since the last user message', () => {
    const history: GroupMessage[] = [
      { speaker: { kind: 'user' }, content: 'first round' },
      { speaker: { kind: 'member', id: 'ada', name: 'Ada Lovelace' }, content: 'ping @Bob from earlier' },
      { speaker: { kind: 'user' }, content: 'ok new topic' },
    ];
    expect(resolveResponders(MEMBERS, history).map((m) => m.id)).toEqual(['ada', 'bob', 'carol']);
  });

  it('@everyone widens back to all members', () => {
    const history: GroupMessage[] = [
      { speaker: { kind: 'user' }, content: '@Carol thoughts? @everyone weigh in' },
    ];
    expect(resolveResponders(MEMBERS, history).map((m) => m.id)).toEqual(['ada', 'bob', 'carol']);
  });
});

describe('orderRoundSpeakers', () => {
  it('rotates the start index by round', () => {
    const ids = ['a', 'b', 'c'];
    expect(orderRoundSpeakers(ids, 0)).toEqual(['a', 'b', 'c']);
    expect(orderRoundSpeakers(ids, 1)).toEqual(['b', 'c', 'a']);
    expect(orderRoundSpeakers(ids, 2)).toEqual(['c', 'a', 'b']);
    expect(orderRoundSpeakers(ids, 3)).toEqual(['a', 'b', 'c']);
  });
});

describe('isPassContent', () => {
  it('accepts the (pass) variants and empty text', () => {
    expect(isPassContent('(pass)')).toBe(true);
    expect(isPassContent('pass')).toBe(true);
    expect(isPassContent('( PASS ).')).toBe(true);
    expect(isPassContent('  ')).toBe(true);
    expect(isPassContent('I will pass on this')).toBe(false);
  });
});

describe('messagesSinceMemberLastSpoke', () => {
  it('returns messages after the member last spoke', () => {
    const history: GroupMessage[] = [
      { speaker: { kind: 'user' }, content: 'go' },
      { speaker: { kind: 'member', id: 'ada', name: 'Ada' }, content: 'done' },
      { speaker: { kind: 'user' }, content: 'more' },
    ];
    expect(messagesSinceMemberLastSpoke(history, 'ada')).toHaveLength(1);
  });

  it('returns the full history when the member never spoke', () => {
    const history: GroupMessage[] = [{ speaker: { kind: 'user' }, content: 'go' }];
    expect(messagesSinceMemberLastSpoke(history, 'bob')).toHaveLength(1);
  });
});

describe('buildGroupMemberWakePrompt', () => {
  it('carries the group tag, history, and the post_to_room contract', () => {
    const prompt = buildGroupMemberWakePrompt({
      member: MEMBERS[0],
      group: { name: '产品讨论组' },
      peers: MEMBERS.slice(1),
      newMessages: [{ speaker: { kind: 'user' }, content: '开工' }],
    });
    expect(prompt).toContain('[Group chat: "产品讨论组" - with Bob, Carol]');
    expect(prompt).toContain('User: 开工');
    expect(prompt).toContain('post_to_room');
    expect(prompt).toContain('(pass)');
  });
});

describe('GroupChatOrchestrator', () => {
  const GROUP = { name: 'Test Room' };

  function makeDeps(overrides: Partial<GroupOrchestratorDeps> = {}): GroupOrchestratorDeps & {
    posts: Array<{ member: GroupMember; content: string }>;
  } {
    const posts: Array<{ member: GroupMember; content: string }> = [];
    const deps: GroupOrchestratorDeps & { posts: Array<{ member: GroupMember; content: string }> } = {
      posts,
      resolveMembers: async (ids) => MEMBERS.filter((m) => ids.includes(m.id)),
      readHistory: () => [],
      isCurrent: () => true,
      runMemberTurn: async () => [],
      postMemberMessage: (member, content) => {
        posts.push({ member, content });
      },
      ...overrides,
    };
    return deps;
  }

  it('runs one round-robin pass and posts member output', async () => {
    const deps = makeDeps({
      runMemberTurn: async ({ member }) => [`${member.name} speaking`],
    });
    await new GroupChatOrchestrator(deps).run({ group: GROUP, memberIds: ['ada', 'bob'] });
    // Round 0: ada + bob spoke, round 1: ada speaks again (rotation)…
    // The run only stops when a round produces zero messages, so stub a
    // history that makes resolveResponders go quiet instead: simpler —
    // cap via maxRounds.
    expect(deps.posts.length).toBeGreaterThanOrEqual(2);
  });

  it('stops when every member passes (no idle rounds)', async () => {
    const deps = makeDeps({
      runMemberTurn: async () => ['(pass)'],
    });
    await new GroupChatOrchestrator(deps).run({ group: GROUP, memberIds: ['ada', 'bob'] });
    expect(deps.posts).toHaveLength(0);
  });

  it('honors max_rounds override', async () => {
    let turns = 0;
    const deps = makeDeps({
      runMemberTurn: async ({ member }) => {
        turns += 1;
        return [`${member.name} #${turns}`];
      },
    });
    await new GroupChatOrchestrator(deps).run({
      group: GROUP,
      memberIds: ['ada', 'bob'],
      maxRounds: 2,
      maxMemberTurns: 99,
    });
    // 2 rounds × 2 members.
    expect(turns).toBe(4);
  });

  it('caps messages per member turn at GROUP_MAX_MESSAGES_PER_TURN', async () => {
    const seen: string[][] = [];
    const deps = makeDeps({
      readHistory: () => [{ speaker: { kind: 'user' }, content: 'go' }],
      runMemberTurn: async ({ member }) => {
        const batch = [`${member.name} 1`, `${member.name} 2`, `${member.name} 3`];
        seen.push(batch);
        return batch;
      },
      // Immediately go stale after the first member turn so the run ends
      // and we only assert the per-turn cap.
      isCurrent: vi.fn().mockReturnValueOnce(true).mockReturnValueOnce(true).mockReturnValue(false),
    });
    await new GroupChatOrchestrator(deps).run({ group: GROUP, memberIds: ['ada'] });
    expect(deps.posts.map((p) => p.content)).toEqual(['Ada Lovelace 1', 'Ada Lovelace 2']);
    expect(GROUP_MAX_MESSAGES_PER_TURN).toBe(2);
  });

  it('stops at max_member_turns', async () => {
    let turns = 0;
    const deps = makeDeps({
      runMemberTurn: async () => {
        turns += 1;
        return [`msg ${turns}`];
      },
    });
    await new GroupChatOrchestrator(deps).run({
      group: GROUP,
      memberIds: ['ada', 'bob'],
      maxRounds: 10,
      maxMemberTurns: 3,
    });
    expect(turns).toBe(3);
  });

  it('unwinds when the epoch goes stale mid-run', async () => {
    let current = true;
    let memberTurns = 0;
    const deps = makeDeps({
      isCurrent: () => current,
      runMemberTurn: async () => {
        memberTurns += 1;
        current = false; // a newer room post supersedes the turn mid-flight
        return [`msg ${memberTurns}`];
      },
    });
    await new GroupChatOrchestrator(deps).run({ group: GROUP, memberIds: ['ada', 'bob', 'carol'] });
    expect(memberTurns).toBe(1);
  });

  it('treats a failed member turn as a pass, not a room failure', async () => {
    let turns = 0;
    const deps = makeDeps({
      readHistory: () => [{ speaker: { kind: 'user' }, content: 'go' }],
      runMemberTurn: async ({ member }) => {
        turns += 1;
        if (member.id === 'ada') throw new Error('LLM down');
        return [`${member.name} ok`];
      },
    });
    await new GroupChatOrchestrator(deps).run({
      group: GROUP,
      memberIds: ['ada', 'bob'],
      maxRounds: 1,
    });
    expect(turns).toBe(2);
    expect(deps.posts.map((p) => p.member.id)).toEqual(['bob']);
  });
});
