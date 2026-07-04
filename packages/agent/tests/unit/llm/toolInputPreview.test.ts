import { describe, expect, it } from 'vitest';
import { extractToolInputPreview } from '../../../src/llm/tool-input-preview.js';

describe('extractToolInputPreview', () => {
  it('extracts the file path before the streamed JSON object is complete', () => {
    const preview = extractToolInputPreview('{"file_path":"tank-battle.html","content":"<html>');

    expect(preview).toMatchObject({
      file_path: 'tank-battle.html',
      content: '<html>',
    });
  });

  it('decodes partial content escapes so live line counts can update', () => {
    const preview = extractToolInputPreview('{"path":"index.html","content":"line 1\\nline 2\\nline 3');

    expect(preview).toMatchObject({
      path: 'index.html',
      content: 'line 1\nline 2\nline 3',
    });
  });

  it('extracts edit previews from incomplete JSON', () => {
    const preview = extractToolInputPreview(
      '{"file_path":"src/App.tsx","old_string":"const a = 1;","new_string":"const a = 2;',
    );

    expect(preview).toMatchObject({
      file_path: 'src/App.tsx',
      old_string: 'const a = 1;',
      new_string: 'const a = 2;',
    });
  });
});
