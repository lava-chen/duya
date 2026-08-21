/**
 * electron/memory/__tests__/rag_snippet.test.ts — unit tests for the pure
 * term-windowed snippet builder (electron/memory/rag_snippet.ts).
 *
 * Mirrors the JS-core buildSnippet cases in scripts/__tests__/memory-rag-lib.test.ts
 * so the CLI and the hook produce identical previews.
 */
import { describe, it, expect } from 'vitest';
import { buildSnippet, stripFrontmatter, extractTerms, SNIPPET_MAX_LEN } from '../rag_snippet';

const filler = Array.from({ length: 40 }, (_, i) => `filler sentence ${i + 1} padding words`).join(' ');

describe('rag_snippet.buildSnippet', () => {
  it('windows around a mid-document term with truncation markers', () => {
    const content = `${filler} STALE_STATE lock protocol rule ${filler}`;
    const snippet = buildSnippet(content, ['STALE_STATE']);
    expect(snippet).toContain('STALE_STATE');
    expect(snippet.startsWith('…')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SNIPPET_MAX_LEN + 2);
  });

  it('skips YAML frontmatter so the preview starts at the real body', () => {
    const content = `---\ntags: [protocol]\ntitle: Fallback\n---\n## Summary\n\n${filler} STALE_STATE rule ${filler}`;
    const snippet = buildSnippet(content, ['STALE_STATE']);
    expect(snippet).toContain('STALE_STATE');
    expect(snippet).not.toContain('tags:');
    expect(snippet).not.toContain('Fallback');
  });

  it('falls back to the body head for vector-only hits (no literal term)', () => {
    const content = `${filler} no query term present here ${filler}`;
    const snippet = buildSnippet(content, undefined);
    expect(snippet.startsWith('filler sentence 1')).toBe(true);
    expect(snippet.endsWith('…')).toBe(true);
  });

  it('handles CJK terms in a CJK document', () => {
    const cjkFiller = '五强溪水库调度手册内容反复出现的铺垫句子 '.repeat(30);
    const content = `${cjkFiller}死水位试算结果落在这里。${cjkFiller}`;
    const snippet = buildSnippet(content, extractTerms('死水位'));
    expect(snippet).toContain('死水位');
    expect(snippet.startsWith('…')).toBe(true);
  });

  it('returns the full normalized body when it fits the window', () => {
    const content = '# Title\n\nshort body with STALE_STATE here';
    expect(buildSnippet(content, ['STALE_STATE'])).toBe('# Title short body with STALE_STATE here');
    expect(buildSnippet(content, ['STALE_STATE']).includes('…')).toBe(false);
  });

  it('returns empty for empty content and honors maxLen', () => {
    expect(buildSnippet('', ['term'])).toBe('');
    expect(buildSnippet('   \n  ', ['term'])).toBe('');
    const content = `${filler} STALE_STATE rule ${filler}`;
    const snippet = buildSnippet(content, ['STALE_STATE'], { maxLen: 120 });
    expect(snippet.length).toBeLessThanOrEqual(122);
    expect(snippet).toContain('STALE_STATE');
  });
});

describe('rag_snippet.stripFrontmatter / extractTerms', () => {
  it('strips only a real leading YAML block', () => {
    expect(stripFrontmatter('---\na: 1\n---\nBody')).toBe('Body');
    expect(stripFrontmatter('# Plain')).toBe('# Plain');
  });

  it('extracts the same usable terms as the hook core', () => {
    expect(extractTerms('STALE_STATE lock')).toEqual(['STALE_STATE', 'lock']);
    expect(extractTerms('五强溪 调度')).toEqual(['五强溪', '调度']);
    expect(extractTerms('go sandbox')).toEqual(['sandbox']);
    expect(extractTerms('ok')).toEqual([]);
  });
});
