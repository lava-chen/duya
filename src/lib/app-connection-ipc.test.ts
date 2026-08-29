import { describe, it, expect } from 'vitest';
import { rewriteAppMentionTokens } from './app-connection-ipc';

describe('rewriteAppMentionTokens (Plan 450 Phase G)', () => {
  const connected = [
    { id: 'notion', label: 'Notion' },
    { id: 'github', label: 'GitHub' },
    { id: 'figma', label: 'Figma' },
  ];

  it('returns content unchanged when there is no @ in it', () => {
    const result = rewriteAppMentionTokens('hello world', connected);
    expect(result.content).toBe('hello world');
    expect(result.mentionedProviders).toEqual([]);
  });

  it('rewrites a bare @<id> token into a codex-style app:// link', () => {
    const result = rewriteAppMentionTokens('@notion search docs', connected);
    expect(result.content).toBe('[@Notion](app://notion) search docs');
    expect(result.mentionedProviders).toEqual(['notion']);
  });

  it('matches tokens case-insensitively', () => {
    expect(rewriteAppMentionTokens('@Notion search docs', connected).mentionedProviders)
      .toEqual(['notion']);
    expect(rewriteAppMentionTokens('@GITHUB list prs', connected).content)
      .toBe('[@GitHub](app://github) list prs');
  });

  it('matches by display label when the token is the label', () => {
    const onlyLabel = [{ id: 'figma', label: 'FigmaDesigns' }];
    const result = rewriteAppMentionTokens('@figmadesigns open file', onlyLabel);
    expect(result.content).toBe('[@FigmaDesigns](app://figma) open file');
    expect(result.mentionedProviders).toEqual(['figma']);
  });

  it('preserves first-seen order across multiple providers', () => {
    const result = rewriteAppMentionTokens(
      '@figma review and @github commit and @notion log',
      connected,
    );
    expect(result.mentionedProviders).toEqual(['figma', 'github', 'notion']);
    expect(result.content).toBe(
      '[@Figma](app://figma) review and [@GitHub](app://github) commit and [@Notion](app://notion) log',
    );
  });

  it('deduplicates repeated mentions of the same provider', () => {
    const result = rewriteAppMentionTokens('@notion search then @notion update', connected);
    expect(result.mentionedProviders).toEqual(['notion']);
    expect(result.content).toBe('[@Notion](app://notion) search then [@Notion](app://notion) update');
  });

  it('leaves unknown @-tokens untouched', () => {
    const result = rewriteAppMentionTokens('@random and @unknown greet', connected);
    expect(result.content).toBe('@random and @unknown greet');
    expect(result.mentionedProviders).toEqual([]);
  });

  it('respects word boundaries: @notionX and email@notion.com do not match', () => {
    expect(rewriteAppMentionTokens('@notionX fail', connected).mentionedProviders).toEqual([]);
    const result = rewriteAppMentionTokens('email@notion.com', connected);
    expect(result.mentionedProviders).toEqual([]);
    expect(result.content).toBe('email@notion.com');
  });

  it('allows internal dots in a token but never swallows a trailing dot', () => {
    // Email-like tokens only match when the full dotted id resolves exactly.
    const sub = [{ id: 'sample.com', label: 'Sample' }];
    const dotted = rewriteAppMentionTokens('try @sample.com now', sub);
    expect(dotted.mentionedProviders).toEqual(['sample.com']);
    expect(dotted.content).toBe('try [@Sample](app://sample.com) now');
    // '@notion.' — sentence-final dot stays in the text.
    const result = rewriteAppMentionTokens('看看我的@notion。', connected);
    expect(result.content).toBe('看看我的[@Notion](app://notion)。');
  });

  it('treats CJK characters as boundaries (codex ASCII name charset)', () => {
    const result = rewriteAppMentionTokens('看看我的@notion内容', connected);
    expect(result.content).toBe('看看我的[@Notion](app://notion)内容');
    expect(result.mentionedProviders).toEqual(['notion']);
  });

  it('handles a leading @ at the start of content', () => {
    const result = rewriteAppMentionTokens('@figma open', connected);
    expect(result.content).toBe('[@Figma](app://figma) open');
    expect(result.mentionedProviders).toEqual(['figma']);
  });

  it('is idempotent: already-linked mentions are counted but never rewritten', () => {
    const once = rewriteAppMentionTokens('@notion search', connected);
    const twice = rewriteAppMentionTokens(once.content, connected);
    expect(twice.content).toBe(once.content);
    expect(twice.mentionedProviders).toEqual(['notion']);
  });

  it('counts a link whose id resolves but whose label differs', () => {
    const result = rewriteAppMentionTokens('[@whatever](app://notion) hi', connected);
    expect(result.content).toBe('[@whatever](app://notion) hi');
    expect(result.mentionedProviders).toEqual(['notion']);
  });

  it('ignores links pointing at unknown providers', () => {
    const result = rewriteAppMentionTokens('[@Fake](app://fake-app) hi', connected);
    expect(result.content).toBe('[@Fake](app://fake-app) hi');
    expect(result.mentionedProviders).toEqual([]);
  });

  it('returns unchanged content when no providers are available', () => {
    const result = rewriteAppMentionTokens('@notion search', []);
    expect(result.content).toBe('@notion search');
    expect(result.mentionedProviders).toEqual([]);
  });

  it('accepts entries without label (label falls back to the id)', () => {
    const result = rewriteAppMentionTokens('@github x', [{ id: 'github' }]);
    expect(result.content).toBe('[@github](app://github) x');
    expect(result.mentionedProviders).toEqual(['github']);
  });
});
