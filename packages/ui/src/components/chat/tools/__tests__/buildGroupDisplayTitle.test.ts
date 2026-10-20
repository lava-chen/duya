import { describe, expect, it } from 'vitest';
import { buildGroupDisplayTitle, resolveGroupDisplayTitle, sanitizeProgressTitleForDisplay } from '../group/buildGroupDisplayTitle';
import type { ToolAction } from '../types';

const t = (key: string, params?: Record<string, string | number>) => {
  if (key.endsWith('.one') && params?.count != null) return `one ${params.count}`;
  if (key.endsWith('.other') && params?.count != null) return `other ${params.count}`;
  return 'Working';
};

function tool(name: string, input: unknown, progressTitle?: string, progressSource?: ToolAction['progressSource']): ToolAction {
  return { name, input, progressTitle, progressSource };
}

describe('buildGroupDisplayTitle', () => {
  it('uses a trimmed explicit title as plain text', () => {
    expect(buildGroupDisplayTitle([tool('bash', {}, '  Inspect recent changes  ', 'provider_commentary')], t, 'en'))
      .toBe('Inspect recent changes');
    expect(resolveGroupDisplayTitle([tool('bash', {}, 'Inspect recent changes', 'provider_commentary')], t, 'en'))
      .toEqual({ title: 'Inspect recent changes', source: 'provider_commentary' });
  });

  it('falls back to a localized tool summary and an allowlisted file basename', () => {
    expect(buildGroupDisplayTitle([tool('read', { path: 'C:/repo/src/index.ts' })], t, 'en'))
      .toBe('one 1 · index.ts');
  });

  it('does not copy arbitrary inputs into a fallback title', () => {
    const title = buildGroupDisplayTitle([tool('unknown_tool', { prompt: 'secret command text' })], t, 'en');
    expect(title).toBe('one 1');
    expect(title).not.toContain('secret command text');
    expect(resolveGroupDisplayTitle([tool('unknown_tool', { prompt: 'secret command text' })], t, 'en').source)
      .toBe('tool_fallback');
  });

  it('rejects control characters and bounds displayed titles', () => {
    expect(sanitizeProgressTitleForDisplay('line one\nline two')).toBeUndefined();
    expect(sanitizeProgressTitleForDisplay(` ${'x'.repeat(140)} `)).toHaveLength(120);
  });
});
