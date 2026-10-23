import { describe, expect, it } from 'vitest';
import { buildToolSummary } from '../group/buildToolSummary';
import type { ToolAction } from '../types';

// Mock translator that keeps the category key inside the rendered
// text, so the assertions can tell the categories apart (the real
// catalog renders "Edited 2 files", "Ran 13 commands", …).
const t = (key: string, params?: Record<string, string | number>) => {
  if (key === 'streaming.toolAction.groupSummary.andMore') {
    return `+${params?.count ?? 0} more`;
  }
  const category = key
    .replace('streaming.toolAction.groupSummary.', '')
    .replace(/\.(one|other)$/, '');
  return `${category}:${params?.count ?? 0}`;
};

function tool(name: string, input: unknown = {}, result?: string): ToolAction {
  return { name, input, result };
}

describe('buildToolSummary', () => {
  it('lists the file categories before the commands, like the reference transcripts', () => {
    const out = buildToolSummary([
      tool('bash', { command: 'ls' }),
      tool('read', { file_path: 'a.ts' }),
      tool('edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
      tool('write', { file_path: 'b.ts', content: 'x' }),
    ], t, 'en');

    expect(out.text).toBe('editFiles:1, createFiles:1, readFiles:1, commands:1');
  });

  it('sums the diff stats of every file tool in the round', () => {
    const out = buildToolSummary([
      tool('edit', { file_path: 'a.ts', old_string: 'a\nb', new_string: 'a\nc' }),
      tool('edit', { file_path: 'b.ts', old_string: 'x', new_string: 'y\nz' }),
      tool('bash', { command: 'ls' }),
    ], t, 'en');

    expect(out.additions).toBe(3);
    expect(out.removals).toBe(2);
    expect(out.hasDiff).toBe(true);
  });

  it('reports no diff stat when the round only read files and ran commands', () => {
    const out = buildToolSummary([
      tool('read', { file_path: 'a.ts' }),
      tool('bash', { command: 'ls' }),
    ], t, 'en');

    expect(out.additions).toBe(0);
    expect(out.removals).toBe(0);
    expect(out.hasDiff).toBe(false);
  });

  it('keeps more categories than the group header before folding the tail', () => {
    const out = buildToolSummary([
      tool('edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
      tool('write', { file_path: 'b.ts', content: 'x' }),
      tool('read', { file_path: 'c.ts' }),
      tool('bash', { command: 'ls' }),
      tool('grep', { pattern: 'x' }),
      tool('agent', { name: 'sub' }),
    ], t, 'en');

    // 6 categories > the round budget (5) → 5 parts + a "+1 more" tail.
    expect(out.text).toBe(
      'editFiles:1, createFiles:1, readFiles:1, commands:1, search:1, +1 more',
    );
  });

  it('honours an explicit part budget', () => {
    const tools = [
      tool('edit', { file_path: 'a.ts', old_string: 'a', new_string: 'b' }),
      tool('read', { file_path: 'c.ts' }),
      tool('bash', { command: 'ls' }),
      tool('grep', { pattern: 'x' }),
    ];

    expect(buildToolSummary(tools, t, 'en', 2).text).toBe(
      'editFiles:1, readFiles:1, +2 more',
    );
  });
});
