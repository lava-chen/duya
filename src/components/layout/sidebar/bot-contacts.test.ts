import { describe, it, expect } from 'vitest';
import type { Thread } from '@/stores/conversation-store';
import type { Message } from '@/types/message';
import {
  buildBotContacts,
  buildRoomContacts,
  deriveBotAvatarLabel,
  deriveBotContactHue,
  deriveBotIdFromName,
  deriveBotPlaceholderThreadId,
  partitionBotContacts,
  peekBotMessagePreview,
  previewTextFromContent,
  resolveBotOpenThreadId,
  type BotSource,
} from './bot-contacts';

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

describe('buildBotContacts (plan 483 P1.2)', () => {
  it('builds contacts from the merged bot read side with name fallback to id', () => {
    const contacts = buildBotContacts(
      [
        { id: 'frontend-expert', name: 'Frontend Expert', title: '', description: 'UI work', model: 'gpt-5' },
        { id: 'reviewer', name: '', title: '', description: '' },
      ],
      [],
    );
    expect(contacts).toHaveLength(2);
    const fe = contacts.find((c) => c.agentId === 'frontend-expert');
    expect(fe?.name).toBe('Frontend Expert');
    expect(fe?.description).toBe('UI work');
    expect(fe?.model).toBe('gpt-5');
    const reviewer = contacts.find((c) => c.agentId === 'reviewer');
    expect(reviewer?.name).toBe('reviewer');
    expect(reviewer?.boundThreadId).toBeNull();
  });

  it('carries avatar color and image url through', () => {
    const contacts = buildBotContacts(
      [{ id: 'fe', name: 'FE', title: 'UI', description: '', avatarColor: 'blue', avatarUrl: 'duya-file:///a/avatar.png?v=1' }],
      [],
    );
    expect(contacts[0].avatarColor).toBe('blue');
    expect(contacts[0].avatarUrl).toBe('duya-file:///a/avatar.png?v=1');
    expect(contacts[0].title).toBe('UI');
  });

  it('merges the 477 binding: picks the most recently updated bot: session', () => {
    const threads: Thread[] = [
      makeThread({ id: 'bot:fe:session-old', updatedAt: 100 }),
      makeThread({ id: 'bot:fe:session-new', updatedAt: 300 }),
      makeThread({ id: 'bot:other:s-1', updatedAt: 200 }),
    ];
    const contacts = buildBotContacts([{ id: 'fe', name: 'FE', title: '', description: '' }], threads);
    expect(contacts).toHaveLength(1);
    expect(contacts[0].boundThreadId).toBe('bot:fe:session-new');
    expect(contacts[0].lastActivity).toBe(300);
  });

  it('binds the bare 2-part persistent session (plan 477 P3.1 `bot:<agentId>`)', () => {
    const threads: Thread[] = [
      makeThread({ id: 'bot:fe', updatedAt: 500 }),
      makeThread({ id: 'bot:other', updatedAt: 900 }),
    ];
    const contacts = buildBotContacts([{ id: 'fe', name: 'FE', title: '', description: '' }], threads);
    expect(contacts[0].boundThreadId).toBe('bot:fe');
    expect(contacts[0].lastActivity).toBe(500);
  });

  it('sorts contacts by display name case-insensitively', () => {
    const contacts = buildBotContacts(
      [
        { id: 'b', name: 'Beta', title: '', description: '' },
        { id: 'a', name: 'alpha', title: '', description: '' },
        { id: 'c', name: '', title: '', description: '' },
      ],
      [],
    );
    expect(contacts.map((c) => c.name)).toEqual(['alpha', 'Beta', 'c']);
  });

  it('skips entries without an id', () => {
    expect(
      buildBotContacts([{ id: '', name: 'x', title: '', description: '' }], []),
    ).toHaveLength(0);
  });
});

describe('resolveBotOpenThreadId (plan 483 P1.3)', () => {
  it('prefers the boundThreadId already merged onto the contact', () => {
    const contacts = buildBotContacts(
      [{ id: 'fe', name: 'FE', title: '', description: '' }],
      [makeThread({ id: 'bot:fe:session-1', updatedAt: 100 })],
    );
    expect(resolveBotOpenThreadId(contacts[0], [])).toBe('bot:fe:session-1');
  });

  it('falls back to scanning threads for the binding prefix', () => {
    const contact = { agentId: 'fe', name: 'FE', title: '', description: '', model: '', boundThreadId: null, lastActivity: 0 };
    const threads = [makeThread({ id: 'bot:fe:session-9' })];
    expect(resolveBotOpenThreadId(contact, threads)).toBe('bot:fe:session-9');
  });

  it('falls back to the placeholder id when no session exists', () => {
    const contact = { agentId: 'fe', name: 'FE', title: '', description: '', model: '', boundThreadId: null, lastActivity: 0 };
    expect(resolveBotOpenThreadId(contact, [])).toBe('bot:fe');
  });
});

describe('deriveBotIdFromName (grok-style create flow)', () => {
  it('slugifies ASCII names', () => {
    expect(deriveBotIdFromName('Frontend Expert', [])).toBe('frontend-expert');
    expect(deriveBotIdFromName('  Researcher! ', [])).toBe('researcher');
  });

  it('generic fallback (non-ASCII) ALWAYS carries a random suffix, even when free', () => {
    // a bare `bot` would be shared by every Chinese bot generation across
    // delete/recreate cycles — never emitted anymore
    expect(deriveBotIdFromName('研究员', [])).toMatch(/^bot-[a-f0-9]{6}$/);
    expect(deriveBotIdFromName('助手 2号', [])).toMatch(/^bot-[a-f0-9]{6}$/);
    // retries while the suffixed id is also taken
    let calls = 0;
    const seq = () => (calls++ === 0 ? 'a1b2c3' : 'fff000');
    expect(deriveBotIdFromName('研究员', ['bot-a1b2c3'], seq)).toBe('bot-fff000');
  });

  it('resolves collisions with a random hex suffix (never the old predictable bot-2 slot)', () => {
    expect(deriveBotIdFromName('bot', ['bot'], () => 'a1b2c3')).toBe('bot-a1b2c3');
    // retries while the suffixed id is also taken
    let calls = 0;
    const seq = () => (calls++ === 0 ? 'a1b2c3' : 'fff000');
    expect(deriveBotIdFromName('bot', ['bot', 'bot-a1b2c3'], seq)).toBe('bot-fff000');
    // default maker yields 6 lowercase hex chars
    expect(deriveBotIdFromName('bot', ['bot'])).toMatch(/^bot-[a-f0-9]{6}$/);
  });

  it('never produces an id longer than the 48-char base + suffix', () => {
    const id = deriveBotIdFromName('a'.repeat(80), []);
    expect(id.length).toBeLessThanOrEqual(48);
  });

  it('a colliding 48-char base + suffix stays inside the 63-char id limit', () => {
    const longBase = 'a'.repeat(80);
    const id = deriveBotIdFromName(longBase, ['a'.repeat(48)], () => 'a1b2c3');
    expect(id.length).toBeLessThanOrEqual(63);
    expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,62}$/);
  });
});

describe('partitionBotContacts (plan 483 P2)', () => {
  const contacts = buildBotContacts(
    [
      { id: 'alpha', name: 'Alpha', title: '', description: '' },
      { id: 'beta', name: 'Beta', title: '', description: '' },
      { id: 'gamma', name: 'Gamma', title: '', description: '' },
    ],
    [],
  );

  it('keeps everything unpinned with no pinned ids', () => {
    const { pinned, unpinned, hidden } = partitionBotContacts(contacts, []);
    expect(pinned).toHaveLength(0);
    expect(unpinned.map((c) => c.agentId)).toEqual(['alpha', 'beta', 'gamma']);
    expect(hidden).toHaveLength(0);
  });

  it('orders the pinned rail by pinnedIds, rest stay unpinned', () => {
    const { pinned, unpinned } = partitionBotContacts(contacts, ['gamma', 'alpha']);
    expect(pinned.map((c) => c.agentId)).toEqual(['gamma', 'alpha']);
    expect(pinned.every((c) => c.isPinned === true)).toBe(true);
    expect(unpinned.map((c) => c.agentId)).toEqual(['beta']);
    expect(unpinned.every((c) => c.isPinned === false)).toBe(true);
  });

  it('drops pinned ids that have no matching contact', () => {
    const { pinned } = partitionBotContacts(contacts, ['missing', 'alpha']);
    expect(pinned.map((c) => c.agentId)).toEqual(['alpha']);
  });

  it('separates hidden bots and stamps isHidden', () => {
    const { pinned, unpinned, hidden } = partitionBotContacts(
      contacts,
      ['alpha'],
      ['gamma'],
    );
    expect(hidden.map((c) => c.agentId)).toEqual(['gamma']);
    expect(hidden.every((c) => c.isHidden === true)).toBe(true);
    expect(pinned.map((c) => c.agentId)).toEqual(['alpha']);
    expect(unpinned.map((c) => c.agentId)).toEqual(['beta']);
    // A hidden bot never leaks into pinned even if its id is pinned.
    const { pinned: pinned2, hidden: hidden2 } = partitionBotContacts(
      contacts,
      ['gamma'],
      ['gamma'],
    );
    expect(pinned2).toHaveLength(0);
    expect(hidden2.map((c) => c.agentId)).toEqual(['gamma']);
  });

  it('does not mutate the input contacts array', () => {
    partitionBotContacts(contacts, ['alpha'], ['gamma']);
    expect(contacts.every((c) => c.isPinned === undefined && c.isHidden === undefined)).toBe(true);
  });
});

describe('avatar helpers', () => {
  it('deriveBotContactHue is deterministic and within [0, 360)', () => {
    const a = deriveBotContactHue('frontend-expert');
    const b = deriveBotContactHue('frontend-expert');
    expect(a).toBe(b);
    expect(a).toBeGreaterThanOrEqual(0);
    expect(a).toBeLessThan(360);
  });

  it('deriveBotPlaceholderThreadId uses the bot: prefix', () => {
    expect(deriveBotPlaceholderThreadId('fe')).toBe('bot:fe');
  });

  it('deriveBotAvatarLabel takes the first grapheme, uppercased', () => {
    expect(deriveBotAvatarLabel('Frontend')).toBe('F');
    expect(deriveBotAvatarLabel('  前端专家')).toBe('前');
    expect(deriveBotAvatarLabel('   ')).toBe('·');
    expect(deriveBotAvatarLabel('')).toBe('·');
  });
});

describe('previewTextFromContent (plan 483 P1.4)', () => {
  it('returns plain string content unchanged', () => {
    expect(previewTextFromContent('Hello, world!')).toBe('Hello, world!');
  });

  it('joins text blocks from a ContentBlock[] array', () => {
    const content = [
      { type: 'image', url: 'https://example.com/x.png' },
      { type: 'text', text: 'first line' },
      { type: 'text', text: 'second line' },
    ];
    expect(previewTextFromContent(content)).toBe('first line\nsecond line');
  });

  it('returns empty string for nullish / non-array / non-string input', () => {
    expect(previewTextFromContent(undefined)).toBe('');
    expect(previewTextFromContent(42 as unknown as string)).toBe('');
    expect(previewTextFromContent({ not: 'a string or array' } as unknown as string)).toBe('');
  });
});

describe('peekBotMessagePreview (plan 483 P1.4, rakazo parity)', () => {
  function userMessage(overrides: Partial<Message>): Message {
    return {
      id: 'm',
      role: 'user',
      content: 'fallback',
      timestamp: 1000,
      ...overrides,
    };
  }
  function assistantMessage(overrides: Partial<Message>): Message {
    return {
      id: 'm',
      role: 'assistant',
      content: 'fallback',
      timestamp: 1000,
      ...overrides,
    };
  }

  it('returns null for empty / missing transcripts', () => {
    expect(peekBotMessagePreview(undefined)).toBeNull();
    expect(peekBotMessagePreview([])).toBeNull();
  });

  it('returns the latest user message text', () => {
    const messages: Message[] = [
      userMessage({ id: '1', content: 'first', timestamp: 100 }),
      userMessage({ id: '2', content: 'second', timestamp: 200 }),
    ];
    expect(peekBotMessagePreview(messages)).toEqual({
      text: 'second',
      timestamp: 200,
    });
  });

  it('prefers displayContent over content for user rows', () => {
    const messages: Message[] = [
      userMessage({
        id: '1',
        content: 'system-prefix hidden context body',
        displayContent: 'show this',
        timestamp: 100,
      }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('show this');
  });

  it('hides optimistic / failed rows (status sending/failed) and falls through to next', () => {
    const messages: Message[] = [
      userMessage({ id: '1', content: 'persisted', timestamp: 100 }),
      userMessage({ id: '2', content: 'in flight', timestamp: 200, status: 'sending' }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('persisted');
  });

  it('only includes assistant messages when source === "send_message"', () => {
    const messages: Message[] = [
      assistantMessage({ id: '1', content: 'scratchpad text', source: 'scratchpad', timestamp: 100 }),
      assistantMessage({ id: '2', content: 'tool_use text', source: 'tool_use', timestamp: 200 }),
      assistantMessage({ id: '3', content: 'voice', source: 'send_message', timestamp: 300 }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('voice');
  });

  it('falls back to the legacy assistant + text convention when source is absent', () => {
    const messages: Message[] = [
      assistantMessage({ id: '1', content: 'thinking', msgType: 'thinking', timestamp: 100 }),
      assistantMessage({ id: '2', content: 'plain', msgType: 'text', timestamp: 200 }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('plain');
  });

  it('skips compact boundaries, task notifications, and tool/system rows', () => {
    const messages: Message[] = [
      {
        id: 'b',
        role: 'assistant',
        content: 'boundary',
        timestamp: 50,
        isCompactBoundary: true,
      },
      {
        id: 't',
        role: 'tool',
        content: 'tool result',
        timestamp: 60,
        msgType: 'tool_result',
      },
      {
        id: 's',
        role: 'system',
        content: 'task notification',
        timestamp: 70,
        isTaskNotification: true,
      },
      userMessage({ id: 'u', content: 'user prompt', timestamp: 80 }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('user prompt');
  });

  it('trims and collapses internal whitespace in the preview', () => {
    const messages: Message[] = [
      userMessage({
        id: '1',
        content: '  hello\n\nworld  \n\n  again  ',
        timestamp: 100,
      }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('hello world again');
  });

  it('caps long text at 240 chars and appends an ellipsis', () => {
    const long = 'a'.repeat(500);
    const messages: Message[] = [
      userMessage({ id: '1', content: long, timestamp: 100 }),
    ];
    const snap = peekBotMessagePreview(messages);
    expect(snap).not.toBeNull();
    expect(snap!.text.length).toBeLessThanOrEqual(240);
    expect(snap!.text.endsWith('…')).toBe(true);
  });

  it('skips bot→bot DM marker cards (source=agent_dm) so intent text does not leak', () => {
    const messages: Message[] = [
      assistantMessage({
        id: '1',
        content: 'intent: ask the user about deadlines',
        source: 'agent_dm',
        agentDmMeta: { direction: 'sent', peerId: 'b2', peerName: 'bot-2' },
        timestamp: 100,
      }),
      userMessage({ id: '2', content: 'real user prompt', timestamp: 200 }),
    ];
    expect(peekBotMessagePreview(messages)?.text).toBe('real user prompt');
  });
});

describe('buildRoomContacts (plan 478 P3.1)', () => {
  it('derives room:<id> thread ids and joins activity from the thread list', () => {
    const threads = [makeThread({ id: 'room:group-abc', updatedAt: 5000 })];
    const contacts = buildRoomContacts(
      [{ id: 'group-abc', name: '产品讨论组', memberIds: ['ada', 'bob'], memberNames: ['Ada', 'Bob'] }],
      threads,
    );
    expect(contacts).toHaveLength(1);
    expect(contacts[0]!.threadId).toBe('room:group-abc');
    expect(contacts[0]!.name).toBe('产品讨论组');
    expect(contacts[0]!.lastActivity).toBe(5000);
    expect(contacts[0]!.memberNames).toEqual(['Ada', 'Bob']);
  });

  it('sorts recently-active rooms first, then by name', () => {
    const threads = [makeThread({ id: 'room:b', updatedAt: 9000 })];
    const contacts = buildRoomContacts(
      [
        { id: 'a', name: 'Alpha', memberIds: ['ada'], memberNames: [] },
        { id: 'c', name: 'Charlie', memberIds: [], memberNames: [] },
        { id: 'b', name: 'Beta', memberIds: ['ada'], memberNames: [] },
      ],
      threads,
    );
    expect(contacts.map((c) => c.name)).toEqual(['Beta', 'Alpha', 'Charlie']);
  });

  it('falls back to the id when the name is blank and tolerates empty threads', () => {
    const contacts = buildRoomContacts([{ id: 'x', name: '  ', memberIds: [], memberNames: [] }], []);
    expect(contacts[0]!.name).toBe('x');
    expect(contacts[0]!.lastActivity).toBe(0);
  });
});
