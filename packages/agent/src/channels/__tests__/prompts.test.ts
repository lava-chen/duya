/**
 * prompts.test.ts — inbound wake prompt rendering with attachments
 * (plan 507 P2.1).
 *
 * Covers: text-only envelopes (unchanged output), single/multiple
 * attachment lines, media-only (empty text) messages, human-readable size
 * formatting, reaction envelopes (attachments ignored), and the
 * MAX_INBOUND_TEXT_CHARS truncation interaction.
 */
import { describe, expect, it } from 'vitest';
import {
  buildChannelInboundWakePrompt,
  CHANNEL_INBOUND_REPLY_HINT,
  CHANNEL_INBOUND_WAKE_CUE,
  MAX_INBOUND_TEXT_CHARS,
} from '../prompts';
import type {
  ChannelInboundAttachment,
  ChannelInboundEnvelope,
} from '../types';

/** Expected prefix of every inbound prompt: cue + reply hint. */
const PREFIX = `${CHANNEL_INBOUND_WAKE_CUE}\n${CHANNEL_INBOUND_REPLY_HINT}`;

function makeEnvelope(
  overrides: Partial<ChannelInboundEnvelope> = {},
): ChannelInboundEnvelope {
  return {
    address: { platform: 'telegram', chat: '12345' },
    sender: 'alice',
    text: 'hello',
    reaction: null,
    ...overrides,
  };
}

function makeAttachment(
  overrides: Partial<ChannelInboundAttachment> = {},
): ChannelInboundAttachment {
  return {
    name: 'report.xlsx',
    path: '/userData/agents/bot1/attachments/inbound/telegram/20260907_120000_000_report.xlsx',
    mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    size: 12595,
    kind: 'document',
    ...overrides,
  };
}

describe('buildChannelInboundWakePrompt — attachments (plan 507 P2.1)', () => {
  it('renders a text-only envelope exactly as before (no attachments field)', () => {
    const prompt = buildChannelInboundWakePrompt([makeEnvelope()]);
    expect(prompt).toBe(
      `${PREFIX}\nOn telegram, from telegram:12345: alice: hello`,
    );
  });

  it('renders an empty attachments array identically to no attachments', () => {
    const prompt = buildChannelInboundWakePrompt([makeEnvelope({ attachments: [] })]);
    expect(prompt).toBe(
      `${PREFIX}\nOn telegram, from telegram:12345: alice: hello`,
    );
  });

  it('renders one attachment as an indented line after the text line', () => {
    const prompt = buildChannelInboundWakePrompt([
      makeEnvelope({ text: 'check this report', attachments: [makeAttachment()] }),
    ]);
    expect(prompt).toBe(
      `${PREFIX}\n` +
        'On telegram, from telegram:12345: alice: check this report\n' +
        '  [attachment saved to: ' +
        '/userData/agents/bot1/attachments/inbound/telegram/20260907_120000_000_report.xlsx ' +
        '(report.xlsx, application/vnd.openxmlformats-officedocument.spreadsheetml.sheet, 12.3 KB)]',
    );
  });

  it('renders multiple attachments in order, one indented line each', () => {
    const prompt = buildChannelInboundWakePrompt([
      makeEnvelope({
        text: 'two files',
        attachments: [
          makeAttachment({
            name: 'a.png',
            path: '/userData/agents/bot1/attachments/inbound/telegram/a.png',
            mimeType: 'image/png',
            size: 800,
            kind: 'image',
          }),
          makeAttachment({
            name: 'notes.pdf',
            path: '/userData/agents/bot1/attachments/inbound/telegram/notes.pdf',
            mimeType: 'application/pdf',
            size: 2202009,
            kind: 'document',
          }),
        ],
      }),
    ]);
    const lines = prompt.split('\n');
    expect(lines).toHaveLength(5);
    expect(lines[0]).toBe(CHANNEL_INBOUND_WAKE_CUE);
    expect(lines[1]).toBe(CHANNEL_INBOUND_REPLY_HINT);
    expect(lines[2]).toBe('On telegram, from telegram:12345: alice: two files');
    expect(lines[3]).toBe(
      '  [attachment saved to: /userData/agents/bot1/attachments/inbound/telegram/a.png (a.png, image/png, 800 B)]',
    );
    expect(lines[4]).toBe(
      '  [attachment saved to: /userData/agents/bot1/attachments/inbound/telegram/notes.pdf (notes.pdf, application/pdf, 2.1 MB)]',
    );
  });

  it('renders the header line with empty text for media-only messages', () => {
    const prompt = buildChannelInboundWakePrompt([
      makeEnvelope({
        text: '',
        attachments: [
          makeAttachment({
            name: 'photo.jpg',
            path: '/userData/agents/bot1/attachments/inbound/telegram/photo.jpg',
            mimeType: 'image/jpeg',
            size: 2048,
            kind: 'image',
          }),
        ],
      }),
    ]);
    const lines = prompt.split('\n');
    expect(lines).toHaveLength(4);
    expect(lines[2]).toBe('On telegram, from telegram:12345: alice: ');
    expect(lines[3]).toBe(
      '  [attachment saved to: /userData/agents/bot1/attachments/inbound/telegram/photo.jpg (photo.jpg, image/jpeg, 2.0 KB)]',
    );
  });

  it('formats sizes as plain bytes under 1 KB and one decimal for KB/MB', () => {
    const prompt = buildChannelInboundWakePrompt([
      makeEnvelope({
        attachments: [
          makeAttachment({ name: 'a.bin', path: '/tmp/a.bin', mimeType: 'application/octet-stream', size: 800, kind: 'document' }),
          makeAttachment({ name: 'b.bin', path: '/tmp/b.bin', mimeType: 'application/octet-stream', size: 1023, kind: 'document' }),
          makeAttachment({ name: 'c.bin', path: '/tmp/c.bin', mimeType: 'application/octet-stream', size: 1024, kind: 'document' }),
          makeAttachment({ name: 'd.bin', path: '/tmp/d.bin', mimeType: 'application/octet-stream', size: 1048575, kind: 'document' }),
          makeAttachment({ name: 'e.bin', path: '/tmp/e.bin', mimeType: 'application/octet-stream', size: 1048576, kind: 'document' }),
        ],
      }),
    ]);
    const lines = prompt.split('\n').slice(3);
    expect(lines[0]).toContain('(a.bin, application/octet-stream, 800 B)');
    expect(lines[1]).toContain('(b.bin, application/octet-stream, 1023 B)');
    expect(lines[2]).toContain('(c.bin, application/octet-stream, 1.0 KB)');
    expect(lines[3]).toContain('(d.bin, application/octet-stream, 1024.0 KB)');
    expect(lines[4]).toContain('(e.bin, application/octet-stream, 1.0 MB)');
  });

  it('leaves reaction envelopes untouched (attachments not rendered)', () => {
    const prompt = buildChannelInboundWakePrompt([
      makeEnvelope({
        text: '',
        reaction: { emoji: '👍', messageQuote: 'nice' },
        attachments: [makeAttachment()],
      }),
    ]);
    expect(prompt).toBe(
      `${PREFIX}\n` +
        "On telegram, from telegram:12345: alice reacted 👍 to your message: 'nice'",
    );
  });

  it('counts attachment lines toward the MAX_INBOUND_TEXT_CHARS budget', () => {
    const longText = 'x'.repeat(2000);
    const envelopes: ChannelInboundEnvelope[] = [
      makeEnvelope({ text: longText }),
      makeEnvelope({ text: longText }),
      makeEnvelope({ text: longText }),
      // Short text that would fit on its own; the long attachment path
      // pushes the combined block over budget, so the whole envelope is
      // dropped and the truncation marker is appended.
      makeEnvelope({
        text: 'final message',
        attachments: [
          makeAttachment({
            name: 'f.bin',
            path: `/${'p'.repeat(3000)}/f.bin`,
            mimeType: 'application/octet-stream',
            size: 1,
            kind: 'document',
          }),
        ],
      }),
    ];
    const prompt = buildChannelInboundWakePrompt(envelopes);
    const lines = prompt.split('\n');
    // cue + reply hint + 3 long text lines + truncation marker
    expect(lines).toHaveLength(6);
    expect(prompt).not.toContain('final message');
    expect(prompt).not.toContain('attachment saved to');
    expect(lines[5]).toBe(
      `<${MAX_INBOUND_TEXT_CHARS} character limit reached — earlier messages truncated>`,
    );
  });

  it('includes attachment lines when the budget allows', () => {
    const longText = 'x'.repeat(2000);
    const prompt = buildChannelInboundWakePrompt([
      makeEnvelope({ text: longText }),
      makeEnvelope({
        text: longText,
        attachments: [makeAttachment({ name: 'g.bin', path: '/tmp/g.bin', mimeType: 'application/octet-stream', size: 5, kind: 'document' })],
      }),
    ]);
    // Both envelopes fit: the second renders its text line AND attachment line.
    expect(prompt).toContain('x'.repeat(2000));
    expect(prompt).toContain(
      '  [attachment saved to: /tmp/g.bin (g.bin, application/octet-stream, 5 B)]',
    );
    expect(prompt).not.toContain('truncated');
  });
});
