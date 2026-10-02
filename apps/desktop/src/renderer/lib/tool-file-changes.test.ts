// Regression tests for the tool→file-change derivation.
//
// The bug these lock down: `computeToolFileChange` used to gate its
// input-based fallback behind `else if (tool.result)`. Any result shape the
// parser did not recognise therefore produced a silent `+0 -0` — which is how
// the turn-level change card and the TaskDrawer lost their line counts while
// FileEditToolRow (which used a separate `if`) kept working.

import { describe, expect, it } from 'vitest';
import {
  buildFileChangeSummaries,
  computeToolFileChange,
  extractToolFileDiff,
  parseToolDiffContent,
} from './tool-file-changes';
import type { ToolAction } from '@/components/chat/tools/types';

/** The shape EditTool emits today. */
const EDIT_RESULT = [
  'Successfully edited src/lib/a.ts: 1 block changed.',
  '',
  '-  1 const a = 1;',
  '-  2 const b = 2;',
  '+  1 const a = 10;',
  '+  2 const b = 20;',
  '+  3 const c = 30;',
].join('\n');

function editTool(overrides: Partial<ToolAction> = {}): ToolAction {
  return {
    id: 't1',
    name: 'edit',
    input: { file_path: '/repo/src/lib/a.ts', old_string: 'const a = 1;', new_string: 'const a = 10;' },
    ...overrides,
  };
}

describe('parseToolDiffContent', () => {
  it('parses the current EditTool format and strips the line-number column', () => {
    expect(parseToolDiffContent(EDIT_RESULT)).toEqual({
      oldContent: 'const a = 1;\nconst b = 2;',
      newContent: 'const a = 10;\nconst b = 20;\nconst c = 30;',
    });
  });

  it('keeps content intact when the diff carries no line-number column', () => {
    const result = ['Successfully edited a.ts: 1 block changed.', '', '-before', '+after'].join('\n');
    expect(parseToolDiffContent(result)).toEqual({ oldContent: 'before', newContent: 'after' });
  });

  it('does not eat a leading number that is part of the code', () => {
    const result = ['Successfully edited a.ts: 1 block changed.', '', '-  7 42 items', '+  7 43 items'].join('\n');
    expect(parseToolDiffContent(result)).toEqual({ oldContent: '42 items', newContent: '43 items' });
  });

  it('still parses the legacy Changed/To format', () => {
    const result = 'Changed:\nold line\n\nTo:\nnew line';
    expect(parseToolDiffContent(result)).toEqual({ oldContent: 'old line', newContent: 'new line' });
  });

  it('still parses JSON envelopes', () => {
    expect(parseToolDiffContent(JSON.stringify({ content: 'new', previous_content: 'old' }))).toEqual({
      oldContent: 'old',
      newContent: 'new',
    });
    expect(parseToolDiffContent(JSON.stringify({ old_string: 'a', new_string: 'b' }))).toEqual({
      oldContent: 'a',
      newContent: 'b',
    });
  });

  it('returns null for WriteTool, whose result carries no content', () => {
    expect(
      parseToolDiffContent("Successfully wrote 42 characters (3 lines) to '/repo/src/lib/a.ts'"),
    ).toBeNull();
  });
});

describe('computeToolFileChange', () => {
  it('counts additions and removals from the EditTool result', () => {
    const change = computeToolFileChange(editTool({ result: EDIT_RESULT }));
    expect(change).not.toBeNull();
    expect(change!.additions).toBeGreaterThan(0);
    expect(change!.removals).toBeGreaterThan(0);
  });

  it('falls back to the input when the result format is unrecognised', () => {
    // The regression: a result we cannot parse must NOT collapse to +0 -0.
    const change = computeToolFileChange(
      editTool({ result: 'some future result format we do not know yet' }),
    );
    expect(change).not.toBeNull();
    expect(change!.additions).toBeGreaterThan(0);
    expect(change!.removals).toBeGreaterThan(0);
  });

  it('counts a WriteTool body through the input when the result has no content', () => {
    const change = computeToolFileChange({
      id: 't2',
      name: 'write',
      input: { file_path: '/repo/src/lib/new.ts', content: 'line one\nline two\nline three' },
      result: "Successfully wrote 27 characters (3 lines) to '/repo/src/lib/new.ts'",
    });
    expect(change).toMatchObject({ additions: 3, removals: 0, kind: 'create' });
  });

  it('ignores errored tools', () => {
    expect(computeToolFileChange(editTool({ result: EDIT_RESULT, isError: true }))).toBeNull();
  });
});

describe('buildFileChangeSummaries', () => {
  it('collapses repeated edits to one file into a single summed row', () => {
    const summaries = buildFileChangeSummaries([
      editTool({ id: 'a', result: EDIT_RESULT }),
      editTool({ id: 'b', result: EDIT_RESULT }),
    ]);
    expect(summaries).toHaveLength(1);
    const single = buildFileChangeSummaries([editTool({ result: EDIT_RESULT })])[0];
    expect(summaries[0].additions).toBe(single.additions * 2);
    expect(summaries[0].removals).toBe(single.removals * 2);
  });

  it('skips non-file tools', () => {
    expect(buildFileChangeSummaries([{ id: 'x', name: 'bash', input: { command: 'ls' } }])).toEqual([]);
  });
});

describe('extractToolFileDiff', () => {
  it('agrees with the stats pipeline for the same tool action', () => {
    const tool = editTool({ result: EDIT_RESULT });
    const diff = extractToolFileDiff(tool);
    const change = computeToolFileChange(tool);
    expect(diff).not.toBeNull();
    expect(diff!.path).toBe('/repo/src/lib/a.ts');
    expect(diff!.oldContent.split('\n')).toHaveLength(change!.removals);
    expect(diff!.newContent.split('\n')).toHaveLength(change!.additions);
  });
});
