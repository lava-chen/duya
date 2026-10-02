// @vitest-environment jsdom
import { describe, it, expect } from 'vitest';
import {
  composeReplyContent,
  splitReplyContent,
  isReplyContent,
} from './reply';

describe('bot reply compose/split', () => {
  it('composes the sentinel block around the text', () => {
    const content = composeReplyContent('hello', {
      id: 'm-1',
      text: 'quoted message',
    });
    expect(content).toBe(
      '[Replying to m-1]\n> quoted message\n\nhello',
    );
  });

  it('round-trips compose → split', () => {
    const reply = { id: 'abc-123', text: 'earlier message text' };
    const text = 'my reply';
    const split = splitReplyContent(composeReplyContent(text, reply));
    expect(split.reply).toEqual(reply);
    expect(split.text).toBe(text);
  });

  it('is the identity without a reply (or with an empty id)', () => {
    expect(composeReplyContent('plain')).toBe('plain');
    expect(composeReplyContent('plain', { id: '', text: 'x' })).toBe('plain');
    expect(splitReplyContent('plain')).toEqual({ reply: null, text: 'plain' });
  });

  it('collapses whitespace and caps the quote preview at 400 chars', () => {
    const long = 'a'.repeat(500) + '  b'.repeat(50);
    const content = composeReplyContent('r', { id: 'm', text: long });
    const split = splitReplyContent(content);
    expect(split.reply!.text.length).toBeLessThanOrEqual(401); // 400 + ellipsis
    expect(split.reply!.text.endsWith('…')).toBe(true);
    expect(split.reply!.text).not.toContain('\n');
  });

  it('tolerates an empty quote text (bare > line)', () => {
    const split = splitReplyContent('[Replying to m-9]\n>\n\nbody');
    expect(split.reply).toEqual({ id: 'm-9', text: '' });
    expect(split.text).toBe('body');
  });

  it('returns content unchanged for non-reply shapes', () => {
    const notReply = '[Replying without id]\n> nope\n\nbody';
    expect(isReplyContent(notReply)).toBe(false);
    const split = splitReplyContent(notReply);
    expect(split.reply).toBeNull();
    expect(split.text).toBe(notReply);
  });

  it('guards non-string input', () => {
    expect(isReplyContent(undefined)).toBe(false);
    expect(splitReplyContent(undefined as unknown as string)).toEqual({
      reply: null,
      text: '',
    });
  });
});
