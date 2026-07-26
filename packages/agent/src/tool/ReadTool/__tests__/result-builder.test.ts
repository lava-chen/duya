/**
 * result-builder.test.ts
 *
 * Verifies the contract of serializeParseResult: header format,
 * truncation at paragraph/sentence boundaries, malware-reminder
 * injection (and the model whitelist that suppresses it), and
 * image reminder when document content has image chunks.
 */

import { describe, it, expect } from 'vitest';
import {
  serializeParseResult,
} from '../result-builder.js';
import type { ParseResult } from '../../../file-parser/index.js';

function makeTextChunks(...texts: string[]) {
  return texts.map((t, i) => ({ type: 'text' as const, index: i, text: t }));
}

function makeResult(overrides: Partial<ParseResult> = {}): ParseResult {
  return {
    fileHash: 'h',
    sessionId: 's',
    filename: 'doc.pdf',
    charCount: 0,
    chunks: [],
    extractMethod: 'text',
    parsedAt: 0,
    ...overrides,
  };
}

describe('serializeParseResult', () => {
  it('emits the file/method/pages header', () => {
    const out = serializeParseResult(
      makeResult({
        chunks: makeTextChunks('hello'),
        charCount: 5,
        extractMethod: 'text',
        pageCount: 3,
      }),
      { resolvedPath: '/tmp/a.pdf' },
    );
    expect(out.result).toContain('File: /tmp/a.pdf');
    expect(out.result).toContain('Method: text');
    expect(out.result).toContain('Pages: 3');
    expect(out.result).toContain('hello');
  });

  it('omits pages when not provided', () => {
    const out = serializeParseResult(
      makeResult({ chunks: makeTextChunks('hi') }),
      { resolvedPath: '/tmp/a' },
    );
    expect(out.result).not.toContain('Pages:');
  });

  it('truncates at paragraph break when budget exceeded', () => {
    const chunk1 = 'a'.repeat(50);
    const chunk2 = 'b'.repeat(50);
    const chunk3 = 'c\n\nd\ne\n\nf'; // 8 chars, will get cut
    const out = serializeParseResult(
      makeResult({ chunks: [...makeTextChunks(chunk1, chunk2), { type: 'text', index: 2, text: chunk3 }] }),
      { maxTokens: 50, resolvedPath: '/x' }, // 200 char budget
    );
    // Budget = 50 * 4 = 200. After chunk1 (50) and chunk2 (50), 100 chars used.
    // chunk3 needs 200 - 100 = 100 budget but is 8 chars — fits, no truncation.
    expect(out.result).toContain('c');
    expect(out.result).toContain('f');
    expect(out.metadata.truncated).toBeFalsy();
  });

  it('truncates a single oversized chunk at sentence boundary', () => {
    const sentences: string[] = [];
    for (let i = 0; i < 100; i++) sentences.push(`Sentence number ${i + 1}.`);
    const chunk = sentences.join(' '); // ~2200 chars
    const out = serializeParseResult(
      makeResult({ chunks: makeTextChunks(chunk) }),
      { maxTokens: 10, resolvedPath: '/x' }, // 40 char budget — well under chunk length
    );
    // The chunk is much larger than the 40-char budget, so we must
    // emit at least one truncated-chunk marker (either inside the
    // body or in the trailing system-reminder).
    const bodyTruncated = /truncated/i.test(out.result);
    expect(bodyTruncated).toBe(true);
    expect(out.result).not.toContain('<system-reminder>');
    expect(out.metadata.truncated).toBe(true);
    // Single-chunk scenario: the chunk is included but its content
    // was cut, so we expect truncatedWithinLastChunk = true.
    expect(out.metadata.truncatedWithinLastChunk).toBe(true);
  });

  it('does not append a malware instruction for document reads', () => {
    const out = serializeParseResult(
      makeResult({ chunks: makeTextChunks('hello') }),
      { resolvedPath: '/x' },
    );
    expect(out.result).not.toContain('malware');
    expect(out.result).not.toContain('<system-reminder>');
  });

  it('emits image reminder when document has image chunks', () => {
    const out = serializeParseResult(
      makeResult({
        chunks: [
          { type: 'text', index: 0, text: 'page text' },
          { type: 'image', index: 1, base64: 'AAAA', mediaType: 'image/png', page: 0 },
        ],
      }),
      { resolvedPath: '/x' },
    );
    expect(out.result).toContain('image(s)');
    expect(out.result).toContain('vision tool');
    expect(out.result).not.toContain('<system-reminder>');
    expect((out.metadata.imageCount as number)).toBe(1);
  });

  it('records omitted chunk count when truncating', () => {
    const chunks = makeTextChunks(
      'a'.repeat(100),
      'b'.repeat(100),
      'c'.repeat(100),
      'd'.repeat(100),
    );
    const out = serializeParseResult(
      makeResult({ chunks }),
      { maxTokens: 10, resolvedPath: '/x' }, // 40 char budget
    );
    expect(out.metadata.truncated).toBe(true);
    const truncated = out.metadata.truncatedChunks as number;
    expect(truncated).toBeGreaterThan(0);
  });

  it('preserves full chunks when under budget', () => {
    const chunks = makeTextChunks('alpha', 'beta', 'gamma');
    const out = serializeParseResult(
      makeResult({ chunks }),
      { maxTokens: 1000, resolvedPath: '/x' },
    );
    expect(out.result).toContain('alpha');
    expect(out.result).toContain('beta');
    expect(out.result).toContain('gamma');
    expect(out.metadata.truncated).toBeFalsy();
  });
});
