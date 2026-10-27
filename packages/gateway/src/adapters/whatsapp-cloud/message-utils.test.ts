import { describe, expect, it } from 'vitest';

import {
  buildInteractivePayload,
  callbackDataOf,
  formatForWhatsApp,
  inboundTextOf,
  mediaRefOf,
  splitForWhatsApp,
  truncateTitle,
} from './message-utils.js';
import type { WAMessage } from './types.js';

describe('formatForWhatsApp', () => {
  it('converts markdown emphasis to WhatsApp markup', () => {
    expect(formatForWhatsApp('**bold** and *italic* and ~~gone~~')).toBe('*bold* and *italic* and ~gone~');
  });

  it('converts __bold__ but keeps snake_case identifiers intact', () => {
    expect(formatForWhatsApp('__strong__ text')).toBe('*strong* text');
    expect(formatForWhatsApp('call `get_user_name` now')).toBe('call `get_user_name` now');
  });

  it('rewrites markdown links because WhatsApp has no link syntax', () => {
    expect(formatForWhatsApp('see [docs](https://example.com/a)')).toBe('see docs (https://example.com/a)');
  });

  it('turns headings into bold lines and bullets into dots', () => {
    expect(formatForWhatsApp('## Title\n- one\n- two')).toBe('*Title*\n• one\n• two');
  });

  it('preserves fenced code blocks verbatim', () => {
    const input = 'run:\n```js\nconst a = **not bold**;\n```';
    const output = formatForWhatsApp(input);
    expect(output).toContain('**not bold**');
  });

  it('is idempotent for already-formatted text', () => {
    const once = formatForWhatsApp('**hi**');
    expect(formatForWhatsApp(once)).toBe(once);
  });
});

describe('splitForWhatsApp', () => {
  it('keeps short text in one chunk', () => {
    expect(splitForWhatsApp('short')).toEqual(['short']);
  });

  it('never exceeds the 4096 limit', () => {
    const chunks = splitForWhatsApp('a'.repeat(9000));
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(4096);
  });
});

describe('truncateTitle', () => {
  it('collapses whitespace and caps at 20 characters', () => {
    const result = truncateTitle('  allow   once  ');
    expect(result).toBe('allow once');
    expect(truncateTitle('x'.repeat(40)).length).toBeLessThanOrEqual(20);
  });
});

describe('buildInteractivePayload', () => {
  const buttons = [
    { id: 'allow', title: 'Allow' },
    { id: 'deny', title: 'Deny' },
  ];

  it('uses quick-reply buttons for up to three choices', () => {
    const payload = buildInteractivePayload('pick one', buttons) as {
      type: string;
      action: { buttons: Array<{ reply: { id: string; title: string } }> };
    };
    expect(payload.type).toBe('button');
    expect(payload.action.buttons).toHaveLength(2);
    expect(payload.action.buttons[0].reply.id).toBe('allow');
  });

  it('downgrades to a list beyond three choices', () => {
    const many = [...buttons, { id: 'a', title: 'A' }, { id: 'b', title: 'B' }];
    const payload = buildInteractivePayload('pick one', many) as {
      type: string;
      action: { sections: Array<{ rows: Array<{ id: string }> }> };
    };
    expect(payload.type).toBe('list');
    expect(payload.action.sections[0].rows).toHaveLength(4);
  });

  it('caps list rows at ten', () => {
    const many = Array.from({ length: 14 }, (_, i) => ({ id: `id-${i}`, title: `T${i}` }));
    const payload = buildInteractivePayload('pick', many) as {
      action: { sections: Array<{ rows: unknown[] }> };
    };
    expect(payload.action.sections[0].rows).toHaveLength(10);
  });

  it('truncates the body to the interactive limit', () => {
    const payload = buildInteractivePayload('b'.repeat(2000), buttons) as { body: { text: string } };
    expect(payload.body.text.length).toBe(1024);
  });
});

describe('inbound message helpers', () => {
  const textMessage: WAMessage = {
    from: '8613800000000',
    id: 'wamid.1',
    timestamp: '1700000000',
    type: 'text',
    text: { body: 'hello' },
    context: { id: 'wamid.0' },
  };

  it('reads text bodies', () => {
    expect(inboundTextOf(textMessage)).toBe('hello');
  });

  it('maps interactive replies to their id so buttons route like callbacks', () => {
    const reply: WAMessage = {
      from: 'u',
      id: 'wamid.2',
      timestamp: '1',
      type: 'interactive',
      interactive: { type: 'button_reply', button_reply: { id: 'perm:p1:allow', title: 'Allow' } },
    };
    expect(callbackDataOf(reply)).toBe('perm:p1:allow');
    expect(inboundTextOf(reply)).toBe('perm:p1:allow');
  });

  it('renders locations as text', () => {
    const location: WAMessage = {
      from: 'u',
      id: 'wamid.3',
      timestamp: '1',
      type: 'location',
      location: { latitude: 31.2, longitude: 121.5, name: 'Office' },
    };
    expect(inboundTextOf(location)).toContain('31.2,121.5');
    expect(inboundTextOf(location)).toContain('Office');
  });

  it('picks the media reference out of any media message', () => {
    const image: WAMessage = {
      from: 'u',
      id: 'wamid.4',
      timestamp: '1',
      type: 'image',
      image: { id: 'media-1', mime_type: 'image/jpeg', caption: 'hi' },
    };
    expect(mediaRefOf(image)?.id).toBe('media-1');
    expect(mediaRefOf(textMessage)).toBeNull();
  });

  it('returns undefined for unsupported message types', () => {
    const sticker: WAMessage = { from: 'u', id: 'wamid.5', timestamp: '1', type: 'sticker' };
    expect(inboundTextOf(sticker)).toBeUndefined();
  });
});
