import { describe, it, expect } from 'vitest';
import {
  extractPartialToolFields,
  countContentLines,
  computeLineChangeStat,
  createStreamingToolInputGateState,
  shouldMaterializeStreamingToolInput,
  markStreamingToolInputMaterialized,
} from '../streaming-tool-input';

describe('extractPartialToolFields (Plan 461)', () => {
  it('extracts complete top-level string fields from a complete object', () => {
    const raw = '{"file_path":"E:\\\\a\\\\b.txt","content":"hello\\nworld"}';
    expect(extractPartialToolFields(raw)).toEqual({
      file_path: 'E:\\a\\b.txt',
      content: 'hello\nworld',
    });
  });

  it('returns an unterminated trailing string value as the live prefix', () => {
    const raw = '{"file_path":"E:\\\\a\\\\b.txt","content":"line1\\nline2\\nli';
    const fields = extractPartialToolFields(raw);
    expect(fields.file_path).toBe('E:\\a\\b.txt');
    expect(fields.content).toBe('line1\nline2\nli');
  });

  it('holds back a dangling escape so the next chunk completes it', () => {
    // chunk ends mid-escape: `\n` split as backslash
    const raw = '{"content":"line1\\';
    expect(extractPartialToolFields(raw).content).toBe('line1');
    const raw2 = '{"content":"line1\\n';
    expect(extractPartialToolFields(raw2).content).toBe('line1\n');
  });

  it('handles a partial \\uXXXX escape', () => {
    // incomplete escape (3 hex digits) — hold back until the next chunk
    const raw = '{"content":"caf\\u00e';
    expect(extractPartialToolFields(raw).content).toBe('caf');
    // complete escape in a terminated string — decoded
    const raw2 = '{"content":"caf\\u00e9"}';
    expect(extractPartialToolFields(raw2).content).toBe('café');
    // complete escape in an unterminated string — decoded too (all 4 hex
    // digits are present, so there is nothing left to wait for)
    const raw3 = '{"content":"caf\\u00e9';
    expect(extractPartialToolFields(raw3).content).toBe('café');
  });

  it('decodes escaped quotes and backslashes inside values', () => {
    const raw = '{"new_string":"a \\"quoted\\" \\\\ path","file_path":"x.ts"}';
    expect(extractPartialToolFields(raw)).toEqual({
      new_string: 'a "quoted" \\ path',
      file_path: 'x.ts',
    });
  });

  it('ignores incomplete keys until a full key:value pair appears', () => {
    const raw = '{"file_pa';
    expect(extractPartialToolFields(raw)).toEqual({});
    const raw2 = '{"file_path":"a.ts"';
    expect(extractPartialToolFields(raw2)).toEqual({ file_path: 'a.ts' });
  });

  it('skips nested objects/arrays without truncating them', () => {
    const raw = '{"file_path":"a.ts","edits":[{"old_string":"x","new_string":"y"}],"content":"z"}';
    expect(extractPartialToolFields(raw)).toEqual({
      file_path: 'a.ts',
      content: 'z',
    });
  });

  it('skips scalar values', () => {
    const raw = '{"file_path":"a.ts","preserve":true,"count":3}';
    expect(extractPartialToolFields(raw)).toEqual({ file_path: 'a.ts' });
  });

  it('extracts old_string/new_string while an edit is streaming', () => {
    const raw = '{"file_path":"src/x.ts","old_string":"const a = 1;","new_string":"const a = 2';
    const fields = extractPartialToolFields(raw);
    expect(fields.file_path).toBe('src/x.ts');
    expect(fields.old_string).toBe('const a = 1;');
    expect(fields.new_string).toBe('const a = 2');
  });

  it('tolerates whitespace between tokens', () => {
    const raw = '{ "file_path" : "a.ts" , "content" : "x" }';
    expect(extractPartialToolFields(raw)).toEqual({ file_path: 'a.ts', content: 'x' });
  });

  it('returns {} for empty / non-object input', () => {
    expect(extractPartialToolFields('')).toEqual({});
    expect(extractPartialToolFields('[]')).toEqual({});
    expect(extractPartialToolFields('42')).toEqual({});
    expect(extractPartialToolFields('null')).toEqual({});
  });
});

describe('countContentLines (Plan 461)', () => {
  it('counts non-empty lines', () => {
    expect(countContentLines('a\nb\n\nc')).toBe(3);
    expect(countContentLines('  \na\n')).toBe(1);
    expect(countContentLines('')).toBe(0);
    expect(countContentLines(undefined)).toBe(0);
  });
});

describe('computeLineChangeStat (ZCode parity)', () => {
  it('counts all lines as additions when the old content is null (create)', () => {
    expect(computeLineChangeStat(null, 'a\nb\nc')).toEqual({ additions: 3, removals: 0 });
    expect(computeLineChangeStat(null, '')).toEqual({ additions: 0, removals: 0 });
  });

  it('trims the common prefix and suffix so a one-line change reads +1/-1', () => {
    const oldText = ['line1', 'line2', 'line3', 'line4', 'line5'].join('\n');
    const newText = ['line1', 'line2', 'CHANGED', 'line4', 'line5'].join('\n');
    expect(computeLineChangeStat(oldText, newText)).toEqual({ additions: 1, removals: 1 });
  });

  it('counts pure insertions and deletions', () => {
    expect(computeLineChangeStat('a\nb', 'a\nx\ny\nb')).toEqual({ additions: 2, removals: 0 });
    expect(computeLineChangeStat('a\nx\ny\nb', 'a\nb')).toEqual({ additions: 0, removals: 2 });
  });

  it('reports full counts when old and new share nothing', () => {
    expect(computeLineChangeStat('a\nb', 'x\ny')).toEqual({ additions: 2, removals: 2 });
    expect(computeLineChangeStat('a\nb', '')).toEqual({ additions: 0, removals: 2 });
    expect(computeLineChangeStat('', 'a\nb')).toEqual({ additions: 2, removals: 0 });
  });

  it('returns zero for identical contents', () => {
    expect(computeLineChangeStat('same\ntext', 'same\ntext')).toEqual({
      additions: 0,
      removals: 0,
    });
  });

  it('normalizes CRLF line endings', () => {
    expect(computeLineChangeStat('a\r\nb', 'a\nCHANGED')).toEqual({ additions: 1, removals: 1 });
  });
});

describe('shouldMaterializeStreamingToolInput (ZCode-parity gate)', () => {
  it('always materializes the eager first delta', () => {
    const state = createStreamingToolInputGateState();
    expect(state.deltaCount).toBe(0);
    expect(shouldMaterializeStreamingToolInput(state, '{"content":"a"', 'write', 1000)).toBe(true);
  });

  it('gates file-write tools to the 1s window regardless of raw growth', () => {
    const state = createStreamingToolInputGateState();
    state.deltaCount = 5; // past the eager window
    state.lastPreviewAt = 10_000;
    state.lastPreviewRawLength = 0;

    const bigRaw = 'x'.repeat(64 * 1024);
    // 500ms later — still inside the window even with huge growth
    expect(shouldMaterializeStreamingToolInput(state, bigRaw, 'write', 10_500)).toBe(false);
    // 1s later — passes
    expect(shouldMaterializeStreamingToolInput(state, bigRaw, 'write', 11_000)).toBe(true);
  });

  it('applies the file-write gate to every write/edit tool alias', () => {
    const state = createStreamingToolInputGateState();
    state.deltaCount = 5;
    state.lastPreviewAt = 10_000;
    for (const name of ['write', 'Write_File', 'create_file', 'edit', 'str_replace_editor']) {
      expect(shouldMaterializeStreamingToolInput(state, '{}', name, 10_500)).toBe(false);
    }
    // Non-file tools are not on the 1s-only policy
    expect(shouldMaterializeStreamingToolInput(state, '{}', 'browser', 10_500)).toBe(false);
  });

  it('materializes other tools on 8KB raw growth before the interval elapses', () => {
    const state = createStreamingToolInputGateState();
    state.deltaCount = 5;
    state.lastPreviewAt = 10_000;
    state.lastPreviewRawLength = 0;

    expect(
      shouldMaterializeStreamingToolInput(state, 'x'.repeat(8 * 1024), 'browser', 10_100),
    ).toBe(true);
  });

  it('gives small non-file inputs the 750ms time budget', () => {
    const state = createStreamingToolInputGateState();
    state.deltaCount = 5;
    state.lastPreviewAt = 10_000;
    state.lastPreviewRawLength = 0;

    // 500ms, small raw — denied
    expect(shouldMaterializeStreamingToolInput(state, 'x'.repeat(100), 'browser', 10_500)).toBe(
      false,
    );
    // 750ms, small raw — allowed
    expect(shouldMaterializeStreamingToolInput(state, 'x'.repeat(100), 'browser', 10_750)).toBe(
      true,
    );
    // 750ms, raw past the time budget but only 1KB of new growth since the
    // last materialization — denied until 8KB of growth accumulates
    state.lastPreviewRawLength = 8 * 1024;
    expect(
      shouldMaterializeStreamingToolInput(state, 'x'.repeat(9 * 1024), 'browser', 10_750),
    ).toBe(false);
    // ...and the next 8KB of growth lets it through immediately
    expect(
      shouldMaterializeStreamingToolInput(state, 'x'.repeat(17 * 1024), 'browser', 10_760),
    ).toBe(true);
  });

  it('records the new materialization time and raw length on mark', () => {
    const state = createStreamingToolInputGateState();
    state.deltaCount = 5;
    markStreamingToolInputMaterialized(state, 42_000, 1024);
    expect(state.lastPreviewAt).toBe(42_000);
    expect(state.lastPreviewRawLength).toBe(1024);
    // deltaCount is deliberately untouched: the eager window applies to
    // the very first delta overall, not to every materialization.
    expect(state.deltaCount).toBe(5);
  });
});
