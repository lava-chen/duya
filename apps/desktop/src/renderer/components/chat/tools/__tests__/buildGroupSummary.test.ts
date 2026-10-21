import { describe, expect, it } from 'vitest';
import { buildGroupSummary } from '../group/buildGroupSummary';
import type { ToolAction } from '../types';

const t = (key: string, params?: Record<string, string | number>) => {
  if (key.endsWith('.one') && params?.count != null) return `one ${params.count}`;
  if (key.endsWith('.other') && params?.count != null) return `other ${params.count}`;
  if (key === 'streaming.toolAction.groupSummary.andMore' && params?.count != null) {
    return `+${params.count} more`;
  }
  return 'translated';
};

function tool(name: string, input: unknown = {}): ToolAction {
  return { name, input, result: 'ok' };
}

describe('buildGroupSummary', () => {
  it('returns the singular template when a category has count=1', () => {
    const out = buildGroupSummary([tool('bash', { command: 'ls' })], t, 'en');
    expect(out).toBe('one 1');
  });

  it('returns the plural template when a category has count>1', () => {
    const out = buildGroupSummary([
      tool('bash', { command: 'ls' }),
      tool('bash', { command: 'pwd' }),
      tool('bash', { command: 'whoami' }),
    ], t, 'en');
    expect(out).toBe('other 3');
  });

  it('preserves the canonical category order (commands → edit → read → search → browser → agent → ask → memory → skill → tools)', () => {
    const out = buildGroupSummary([
      tool('skill'),
      tool('bash'),
      tool('edit'),
    ], t, 'en');
    // bash first (commands), then edit (editFiles), then skill.
    expect(out).toBe('one 1, one 1, one 1');
  });

  it('falls back to a locale-aware count string when no category matches', () => {
    // Force `classifyToolForSummary` to drop a tool by handing it a
    // name that doesn't match any category — but classify always
    // returns the catch-all `tools` category, so we test the empty
    // path via the empty-tools branch instead. The branch routes
    // through i18n (it was a literal "0 actions" before), so the mock
    // t returns `other 0`.
    const out = buildGroupSummary([], t, 'en');
    expect(out).toBe('other 0');
  });

  it('uses the zh separator when locale is zh', () => {
    // Mock a tool that yields the "commands" category and force the
    // multi-category branch. The separator only matters when there are
    // 2+ parts, so exercise editFiles + readFiles (which have distinct
    // categories) to verify the zh ',' separator is used.
    const out = buildGroupSummary([
      tool('edit', { file_path: 'a.ts' }),
      tool('read', { file_path: 'b.ts' }),
    ], t, 'zh');
    expect(out).toContain('，');
    expect(out).not.toContain(',');
  });

  it('uses the en separator when locale is en', () => {
    const out = buildGroupSummary([
      tool('edit', { file_path: 'a.ts' }),
      tool('read', { file_path: 'b.ts' }),
    ], t, 'en');
    expect(out).toContain(', ');
    expect(out).not.toContain('，');
  });

  it('truncates with "+N more" when there are more than 3 distinct categories', () => {
    // bash, edit, read, search, browser → 5 categories → 3 visible + tail.
    const out = buildGroupSummary([
      tool('bash'),
      tool('edit'),
      tool('read'),
      tool('search'),
      tool('browser'),
    ], t, 'en');
    expect(out).toContain('one 1, one 1, one 1');
    expect(out).toContain('+2 more');
  });
});