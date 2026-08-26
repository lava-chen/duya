import { describe, it, expect } from 'vitest';
import { extractMentionedProviders } from './app-connection-ipc';

describe('extractMentionedProviders (Plan 450)', () => {
  const connected = [
    { id: 'notion', label: 'Notion' },
    { id: 'github', label: 'GitHub' },
    { id: 'figma', label: 'Figma' },
  ];

  it('returns an empty list when there is no @ in the content', () => {
    expect(extractMentionedProviders('hello world', connected)).toEqual([]);
  });

  it('matches @<id> tokens case-insensitively at word boundaries', () => {
    expect(extractMentionedProviders('@notion search docs', connected)).toEqual(['notion']);
    expect(extractMentionedProviders('@Notion search docs', connected)).toEqual(['notion']);
    expect(extractMentionedProviders('@GITHUB list prs', connected)).toEqual(['github']);
  });

  it('matches by display label when id is unavailable', () => {
    // Labels must be @-mentionable: no whitespace, ASCII identifier-like.
    const onlyLabel = [{ id: 'figma', label: 'FigmaDesigns' }];
    expect(extractMentionedProviders('@figmadesigns open file', onlyLabel)).toEqual(['figma']);
    // When both id and label match (different providers), id wins.
    const both = [
      { id: 'notion', label: 'Notion' },
      { id: 'gmail', label: 'NotionClone' },
    ];
    expect(extractMentionedProviders('@notion', both)).toEqual(['notion']);
  });

  it('does not match labels with spaces (mention token must be whitespace-free)', () => {
    const spaced = [{ id: 'figma', label: 'Figma Designs' }];
    // The id-only match path still works: '@figma' resolves via id even
    // when the display label is wider than the mention token.
    expect(extractMentionedProviders('@figma design', spaced)).toEqual(['figma']);
    // '@figma' inside a longer sentence still matches via id.
    expect(extractMentionedProviders('open @figma now', spaced)).toEqual(['figma']);
    // But a token containing a space (regex stops at space) won't resolve
    // the spaced display label — it falls back to nothing.
    expect(extractMentionedProviders('@figma-designs', spaced)).toEqual([]);
  });

  it('preserves first-seen order across multiple providers', () => {
    expect(
      extractMentionedProviders('@figma review and @github commit and @notion log', connected),
    ).toEqual(['figma', 'github', 'notion']);
  });

  it('deduplicates repeated mentions of the same provider', () => {
    expect(
      extractMentionedProviders('@notion search then @notion update', connected),
    ).toEqual(['notion']);
  });

  it('ignores @-tokens that do not resolve to any known provider', () => {
    expect(
      extractMentionedProviders('@random and @unknown greet', connected),
    ).toEqual([]);
  });

  it('respects word boundaries: @notionX does not match @notion', () => {
    expect(extractMentionedProviders('@notionX fail', connected)).toEqual([]);
    expect(extractMentionedProviders('email@notion.com', connected)).toEqual([]);
  });

  it('handles leading @ at start of content', () => {
    expect(extractMentionedProviders('@figma open', connected)).toEqual(['figma']);
  });

  it('returns empty when no providers are available', () => {
    expect(extractMentionedProviders('@notion search', [])).toEqual([]);
  });

  it('accepts entries without label (id-only)', () => {
    expect(extractMentionedProviders('@github x', [{ id: 'github' }])).toEqual(['github']);
  });
});