import { describe, expect, it } from 'vitest';
import {
  MEMORY_SUMMARY_MAX_CHARS,
  renderMemorySummaryFile,
  renderUnifiedMemoryFile,
  type MemoryEntryRow,
  type ProjectRow,
} from '../projectionContent';

const PROJECT_ID = '11111111-1111-4111-8111-111111111111';

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

function project(overrides: Partial<ProjectRow> = {}): ProjectRow {
  return {
    project_id: PROJECT_ID,
    canonical_root: 'E:\\Projects\\duya',
    created_at: 1,
    last_seen_at: 2,
    ...overrides,
  };
}

describe('Memory v2 unified projections', () => {
  it('uses semantic project headings without leaking UUID file identities', () => {
    const entries = [
      entry(),
      entry({
        memory_id: 'memory-2',
        scope: 'project',
        project_id: PROJECT_ID,
        kind: 'procedure',
        canonical_key: 'procedure:verification-gate',
        content: 'Run typecheck before committing.',
      }),
    ];

    const memory = renderUnifiedMemoryFile(entries, [project()]);
    const summary = renderMemorySummaryFile(entries, [project()]);

    expect(memory).toContain('### duya');
    expect(memory).toContain('Project root: `E:\\Projects\\duya`');
    expect(memory).toContain('Run typecheck before committing.');
    expect(memory).not.toContain(PROJECT_ID);
    expect(summary).toContain('duya');
    expect(summary).toContain('`E:\\Projects\\duya` (1 memories)');
    expect(summary).not.toContain(PROJECT_ID);
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
    const projects: ProjectRow[] = Array.from({ length: 100 }, (_, index) =>
      project({
        project_id: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        canonical_root: `E:\\Projects\\semantic-project-${index}`,
        last_seen_at: index + 1,
      })
    );
    entries.push(
      ...projects.map((item, index) =>
        entry({
          memory_id: `project-memory-${index}`,
          scope: 'project',
          project_id: item.project_id,
          kind: 'fact',
          canonical_key: `fact:project-${index}`,
          content: `Project fact ${index}`,
        })
      )
    );

    const summary = renderMemorySummaryFile(entries, projects);

    expect(summary.length).toBeLessThanOrEqual(MEMORY_SUMMARY_MAX_CHARS);
    expect(summary).toContain('Search `MEMORY.md` for full details.');
    expect(summary).toContain('older projects omitted');
    expect(summary).not.toContain('preference:item-0');
  });
});
