import { describe, expect, it } from 'vitest';
import {
  DIFF_HIGHLIGHT_MAX_CHARS,
  highlightDiffSource,
} from '../../diff/diff-highlight';

describe('diff-highlight', () => {
  it('returns null when no language is given', () => {
    expect(highlightDiffSource('const a = 1;', undefined)).toBeNull();
    expect(highlightDiffSource('const a = 1;', '')).toBeNull();
  });

  it('returns null for the text pseudo language', () => {
    expect(highlightDiffSource('plain text', 'text')).toBeNull();
  });

  it('returns null for a language that is not registered', () => {
    expect(highlightDiffSource('whatever', 'not-a-real-language')).toBeNull();
  });

  it('returns null for a source above the size cap', () => {
    const chunk = 'const a = 1;\n';
    const huge = chunk.repeat(Math.ceil(DIFF_HIGHLIGHT_MAX_CHARS / chunk.length) + 1);
    expect(huge.length).toBeGreaterThan(DIFF_HIGHLIGHT_MAX_CHARS);
    expect(highlightDiffSource(huge, 'typescript')).toBeNull();
  });

  it('returns one line per source line', () => {
    const source = 'const a = 1;\nconst b = 2;\nconst c = 3;';
    const lines = highlightDiffSource(source, 'typescript');
    expect(lines).not.toBeNull();
    expect(lines).toHaveLength(source.split('\n').length);
  });

  it('keeps an empty source as a single empty line', () => {
    const lines = highlightDiffSource('', 'typescript');
    expect(lines).toHaveLength(1);
    expect(lines?.[0]).toHaveLength(0);
  });

  it('preserves the source text exactly', () => {
    const source = [
      '// a comment',
      'const greeting = "hello";',
      'function add(a: number, b: number) { return a + b; }',
      '',
      '  indented();',
    ].join('\n');
    const lines = highlightDiffSource(source, 'typescript');
    expect(lines).not.toBeNull();
    const restored = (lines ?? [])
      .map((line) => line.map((token) => token.text).join(''))
      .join('\n');
    expect(restored).toBe(source);
  });

  it('classifies comments, strings and keywords', () => {
    const lines = highlightDiffSource('const greeting = "hi"; // note', 'typescript');
    const kinds = (lines?.[0] ?? []).map((token) => token.kind);
    expect(kinds).toContain('keyword');
    expect(kinds).toContain('string');
    expect(kinds).toContain('comment');
  });

  it('colours a token that spans several lines on every line', () => {
    const source = '/* one\n   two */\nconst a = 1;';
    const lines = highlightDiffSource(source, 'typescript');
    expect(lines).toHaveLength(3);
    expect(lines?.[0].every((token) => token.kind === 'comment')).toBe(true);
    expect(lines?.[1].every((token) => token.kind === 'comment')).toBe(true);
    expect(lines?.[2].some((token) => token.kind === 'keyword')).toBe(true);
  });
});
