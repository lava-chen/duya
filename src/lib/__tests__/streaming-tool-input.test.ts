import { describe, it, expect } from 'vitest';
import { extractPartialToolFields, countContentLines } from '../streaming-tool-input';

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
