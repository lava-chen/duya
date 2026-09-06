import { describe, it, expect } from 'vitest';
import type { Thread } from '@/stores/conversation-store';
import type { Message } from '@/types/message';
import {
  buildBotContacts,
  buildRoomContacts,
  createBotSection,
  deleteBotSection,
  deriveBotAvatarLabel,
  deriveBotContactHue,
  deriveBotPlaceholderThreadId,
  moveBotToSection,
  partitionBotContacts,
  peekBotMessagePreview,
  previewTextFromContent,
  renameBotSection,
  reorderSectionBots,
  reorderSections,
  resolveBotOpenThreadId,
  sectionOfBot,
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

describe('partitionBotContacts (plan 483 P2 + sections)', () => {
  const contacts = buildBotContacts(
    [
      { id: 'alpha', name: 'Alpha', title: '', description: '' },
      { id: 'beta', name: 'Beta', title: '', description: '' },
      { id: 'gamma', name: 'Gamma', title: '', description: '' },
      { id: 'delta', name: 'Delta', title: '', description: '' },
    ],
    [],
  );

  it('keeps everything unassigned with no pinned ids or sections', () => {
    const { pinned, sections, unassigned, hidden } = partitionBotContacts(contacts, []);
    expect(pinned).toHaveLength(0);
    expect(sections).toHaveLength(0);
    expect(unassigned.map((c) => c.agentId)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    expect(hidden).toHaveLength(0);
  });

  it('orders the pinned rail by pinnedIds, rest stay unassigned', () => {
    const { pinned, unassigned } = partitionBotContacts(contacts, ['gamma', 'alpha']);
    expect(pinned.map((c) => c.agentId)).toEqual(['gamma', 'alpha']);
    expect(pinned.every((c) => c.isPinned === true)).toBe(true);
    expect(unassigned.map((c) => c.agentId)).toEqual(['beta', 'delta']);
    expect(unassigned.every((c) => c.isPinned === false)).toBe(true);
  });

  it('drops pinned ids that have no matching contact', () => {
    const { pinned } = partitionBotContacts(contacts, ['missing', 'alpha']);
    expect(pinned.map((c) => c.agentId)).toEqual(['alpha']);
  });

  it('separates hidden bots and stamps isHidden', () => {
    const { pinned, unassigned, hidden } = partitionBotContacts(
      contacts,
      ['alpha'],
      ['gamma'],
    );
    expect(hidden.map((c) => c.agentId)).toEqual(['gamma']);
    expect(hidden.every((c) => c.isHidden === true)).toBe(true);
    expect(pinned.map((c) => c.agentId)).toEqual(['alpha']);
    expect(unassigned.map((c) => c.agentId)).toEqual(['beta', 'delta']);
    // A hidden bot never leaks into pinned even if its id is pinned.
    const { pinned: pinned2, hidden: hidden2 } = partitionBotContacts(
      contacts,
      ['gamma'],
      ['gamma'],
    );
    expect(pinned2).toHaveLength(0);
    expect(hidden2.map((c) => c.agentId)).toEqual(['gamma']);
  });

  it('groups section members in section order then member order', () => {
    const sections = [
      { id: 'work', name: 'Work' },
      { id: 'life', name: 'Life' },
    ];
    const members = { work: ['gamma', 'alpha'], life: ['delta'] };
    const { pinned, sections: partitions, unassigned } = partitionBotContacts(
      contacts,
      [],
      [],
      sections,
      members,
    );
    expect(pinned).toHaveLength(0);
    expect(partitions).toHaveLength(2);
    expect(partitions[0]!.section.name).toBe('Work');
    expect(partitions[0]!.contacts.map((c) => c.agentId)).toEqual(['gamma', 'alpha']);
    expect(partitions[0]!.contacts.every((c) => c.sectionId === 'work')).toBe(true);
    expect(partitions[1]!.section.name).toBe('Life');
    expect(partitions[1]!.contacts.map((c) => c.agentId)).toEqual(['delta']);
    expect(unassigned.map((c) => c.agentId)).toEqual(['beta']);
  });

  it('keeps empty sections in the partition list', () => {
    const sections = [{ id: 'empty', name: 'Empty' }];
    const { sections: partitions } = partitionBotContacts(contacts, [], [], sections, {});
    expect(partitions).toHaveLength(1);
    expect(partitions[0]!.contacts).toHaveLength(0);
    expect(partitions[0]!.section.id).toBe('empty');
  });

  it('hidden wins over section membership', () => {
    const sections = [{ id: 'work', name: 'Work' }];
    const members = { work: ['gamma'] };
    const { hidden, sections: partitions, unassigned } = partitionBotContacts(
      contacts,
      [],
      ['gamma'],
      sections,
      members,
    );
    expect(hidden.map((c) => c.agentId)).toEqual(['gamma']);
    expect(partitions[0]!.contacts).toHaveLength(0);
    expect(unassigned.some((c) => c.agentId === 'gamma')).toBe(false);
  });

  it('pinned wins over section membership; unpinning returns the bot to its section', () => {
    const sections = [{ id: 'work', name: 'Work' }];
    const members = { work: ['alpha', 'gamma'] };
    const { pinned, sections: partitions } = partitionBotContacts(
      contacts,
      ['alpha'],
      [],
      sections,
      members,
    );
    expect(pinned.map((c) => c.agentId)).toEqual(['alpha']);
    expect(partitions[0]!.contacts.map((c) => c.agentId)).toEqual(['gamma']);
    // With alpha no longer pinned it slots back into its section.
    const { pinned: pinned2, sections: partitions2 } = partitionBotContacts(
      contacts,
      [],
      [],
      sections,
      members,
    );
    expect(pinned2).toHaveLength(0);
    expect(partitions2[0]!.contacts.map((c) => c.agentId)).toEqual(['alpha', 'gamma']);
  });

  it('skips stale member ids that have no matching contact', () => {
    const sections = [{ id: 'work', name: 'Work' }];
    const members = { work: ['missing', 'alpha'] };
    const { sections: partitions, unassigned } = partitionBotContacts(
      contacts,
      [],
      [],
      sections,
      members,
    );
    expect(partitions[0]!.contacts.map((c) => c.agentId)).toEqual(['alpha']);
    expect(unassigned.map((c) => c.agentId)).toEqual(['beta', 'delta', 'gamma']);
  });

  it('does not mutate the input arrays', () => {
    const sections = [{ id: 'work', name: 'Work' }];
    const members = { work: ['alpha'] };
    partitionBotContacts(contacts, ['alpha'], ['gamma'], sections, members);
    expect(contacts.every((c) => c.isPinned === undefined && c.isHidden === undefined)).toBe(true);
    expect(contacts.some((c) => c.sectionId !== undefined)).toBe(false);
    expect(sections[0]!.name).toBe('Work');
    expect(members.work).toEqual(['alpha']);
  });
});

describe('bot section pure helpers', () => {
  it('createBotSection appends a new section and mints an id', () => {
    const input = [{ id: 'a', name: 'A' }];
    const { sections, section } = createBotSection(input, '  Work  ');
    expect(sections).toHaveLength(2);
    expect(sections[1]).toBe(section);
    expect(section.name).toBe('Work');
    expect(section.id).toBeTruthy();
    expect(input).toHaveLength(1);
  });

  it('renameBotSection updates only the target section', () => {
    const input = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const next = renameBotSection(input, 'a', 'Renamed');
    expect(next[0]!.name).toBe('Renamed');
    expect(next[1]!.name).toBe('B');
    expect(input[0]!.name).toBe('A');
  });

  it('deleteBotSection removes the section and its membership row only', () => {
    const sections = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const members = { a: ['x', 'y'], b: ['z'] };
    const result = deleteBotSection(sections, members, 'a');
    expect(result.sections.map((s) => s.id)).toEqual(['b']);
    expect(result.sectionMembers).toEqual({ b: ['z'] });
  });

  it('moveBotToSection assigns, moves between groups, and unassigns', () => {
    const members = { work: ['alpha', 'beta'], life: ['gamma'] };
    // Assign (append at end of an existing group).
    expect(moveBotToSection(members, 'delta', 'life')).toEqual({
      work: ['alpha', 'beta'],
      life: ['gamma', 'delta'],
    });
    // Move between groups (removed from the old group first).
    expect(moveBotToSection(members, 'alpha', 'life')).toEqual({
      work: ['beta'],
      life: ['gamma', 'alpha'],
    });
    // Unassign.
    expect(moveBotToSection(members, 'alpha', null)).toEqual({
      work: ['beta'],
      life: ['gamma'],
    });
    // Input untouched.
    expect(members.work).toEqual(['alpha', 'beta']);
  });

  it('reorderSectionBots reorders only the target section and tolerates stale ids', () => {
    const members = { work: ['alpha', 'beta', 'gamma'], life: ['delta'] };
    const next = reorderSectionBots(members, 'work', ['gamma', 'alpha']);
    expect(next.work).toEqual(['gamma', 'alpha', 'beta']);
    expect(next.life).toEqual(['delta']);
    // Unknown section id → a fresh entry with just the ordered ids.
    const fresh = reorderSectionBots(members, 'new', ['x']);
    expect(fresh.new).toEqual(['x']);
  });

  it('reorderSections honors the given order and keeps missing ids at the tail', () => {
    const input = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
      { id: 'c', name: 'C' },
    ];
    expect(reorderSections(input, ['c', 'a']).map((s) => s.id)).toEqual(['c', 'a', 'b']);
  });

  it('sectionOfBot returns the owning section id or null', () => {
    const members = { work: ['alpha'], life: ['gamma'] };
    expect(sectionOfBot(members, 'alpha')).toBe('work');
    expect(sectionOfBot(members, 'missing')).toBeNull();
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
