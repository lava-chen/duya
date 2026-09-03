import { describe, it, expect } from 'vitest';
import type { Thread } from '@/stores/conversation-store';
import {
  buildBotContacts,
  deriveBotAvatarLabel,
  deriveBotContactHue,
  deriveBotIdFromName,
  deriveBotPlaceholderThreadId,
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

  it('carries avatar character tokens through', () => {
    const contacts = buildBotContacts(
      [{ id: 'fe', name: 'FE', title: 'UI', description: '', avatarShape: 'hex', avatarColor: 'blue' }],
      [],
    );
    expect(contacts[0].avatarShape).toBe('hex');
    expect(contacts[0].avatarColor).toBe('blue');
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

  it('collapses non-ASCII names to the "bot" base', () => {
    expect(deriveBotIdFromName('研究员', [])).toBe('bot');
    expect(deriveBotIdFromName('助手 2号', [])).toBe('bot');
  });

  it('resolves collisions with numeric suffixes', () => {
    expect(deriveBotIdFromName('bot', ['bot'])).toBe('bot-2');
    expect(deriveBotIdFromName('bot', ['bot', 'bot-2'])).toBe('bot-3');
  });

  it('never produces an id longer than the 48-char base + suffix', () => {
    const id = deriveBotIdFromName('a'.repeat(80), []);
    expect(id.length).toBeLessThanOrEqual(48);
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
