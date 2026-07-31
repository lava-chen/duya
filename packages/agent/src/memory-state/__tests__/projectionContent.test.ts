import { describe, expect, it } from 'vitest';
import {
  MEMORY_SUMMARY_MAX_CHARS,
  renderMemorySummaryFile,
  renderUnifiedMemoryFile,
  type MemoryEntryRow,
} from '../projectionContent';

function entry(overrides: Partial<MemoryEntryRow> = {}): MemoryEntryRow {
  return {
    memory_id: 'memory-1',
    scope: 'global',
    project_id: null,
    kind: 'preference',
    canonical_key: 'preference:response-language',
    content: 'Reply in Chinese unless the user asks for another language.',
    version: 1,
    status: 'active',
    created_at: 1,
    updated_at: 1,
    ...overrides,
  };
}

describe('Memory unified projections', () => {
  it('renders all active entries under global sections', () => {
    const entries = [
      entry(),
      entry({
        memory_id: 'memory-2',
        kind: 'procedure',
        canonical_key: 'procedure:verification-gate',
        content: 'Run typecheck before committing.',
      }),
    ];

    const memory = renderUnifiedMemoryFile(entries);
    const summary = renderMemorySummaryFile(entries);

    expect(memory).toContain('# Durable Memory');
    expect(memory).toContain('## User preferences');
    expect(memory).toContain('## Reusable knowledge');
    expect(memory).toContain('Run typecheck before committing.');
    expect(summary).toContain('# Memory Summary');
    expect(summary).toContain('## Essentials');
    expect(summary).toContain('Run typecheck before committing.');
  });

  it('keeps summary size bounded as memory history grows', () => {
    const entries: MemoryEntryRow[] = Array.from({ length: 200 }, (_, index) =>
      entry({
        memory_id: `memory-${index}`,
        canonical_key: `preference:item-${index}`,
        content: `Durable preference ${index}: ${'detail '.repeat(40)}`,
        updated_at: index + 1,
      })
    );

    const summary = renderMemorySummaryFile(entries);

    expect(summary.length).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_CHARS);
    expect(summary).toContain('Search `MEMORY.md` for full details.');
    expect(summary).not.toContain('preference:item-0');
  });
});
