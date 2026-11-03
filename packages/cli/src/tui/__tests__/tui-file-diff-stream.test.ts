import { describe, it, expect } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { renderTranscript } from '../transcript-view.js';
import { diffRowWidth } from '../file-diff-view.js';

/**
 * The streaming preview: a file-mutating call draws what is being written
 * while its arguments are still arriving.
 *
 * The preview exists because a write's text IS the arguments, so the reader can
 * watch the file appear instead of staring at an empty row. What it must never
 * do is outgrow the live area: a row that leaves the live area is committed to
 * the terminal's scrollback for good, so an oversized preview would freeze a
 * half-written file into the user's history. That bound is the invariant these
 * tests pin.
 */

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5, width: 60 };

/** Drop blessed tags so layout assertions read the text a user sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

function streamingModel(prefix: string, deltas: readonly string[]): TranscriptModel {
  const model = new TranscriptModel();
  model.apply({ type: 'tool_use_started', data: { id: 'call-1', name: 'write', input: {} } });
  if (prefix !== '') {
    model.apply({ type: 'tool_use_delta', data: { id: 'call-1', delta: prefix } });
  }
  for (const delta of deltas) {
    model.apply({ type: 'tool_use_delta', data: { id: 'call-1', delta } });
  }
  return model;
}

describe('streaming file preview', () => {
  it('grows the block as argument fragments arrive', () => {
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', ['beta\\n']);
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }));
    expect(rendered).toContain('~+2');
    expect(rendered).toContain('alpha');
    expect(rendered).toContain('beta');
  });

  it('paints the provisional rows with the add fill', () => {
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', []);
    const rendered = renderTranscript(model, { ...OPTIONS, liveRows: 20 });
    const row = rendered.split('\n').find((line) => line.includes('alpha'));
    expect(row).toContain('{22-bg}');
  });

  it('numbers the rows of a write, which knows its own line numbers', () => {
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', ['beta\\n']);
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }));
    expect(rendered).toContain('1 │ +alpha');
    expect(rendered).toContain('2 │ +beta');
  });

  it('keeps the whole block inside the live area', () => {
    const many = ['one\\n', 'two\\n', 'three\\n', 'four\\n', 'five\\n', 'six\\n', 'seven\\n', 'eight\\n'];
    const model = streamingModel('{"file_path":"src/new.ts","content":"', many);
    for (const liveRows of [3, 4, 6, 10]) {
      const rendered = renderTranscript(model, { ...OPTIONS, liveRows });
      expect(rendered.split('\n').length, `liveRows=${liveRows}`).toBeLessThanOrEqual(liveRows);
    }
  });

  it('shows only the summary when the live area height is unknown', () => {
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', ['beta\\n']);
    const rendered = strip(renderTranscript(model, OPTIONS));
    expect(rendered).toContain('~+2');
    // Without a known live area the preview cannot bound itself, so the rows
    // stay off screen and the count alone is the preview.
    expect(rendered).not.toContain('alpha');
  });

  it('shows nothing at all when the live area cannot hold a preview', () => {
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', []);
    for (const liveRows of [1, 2]) {
      const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows }));
      expect(rendered, `liveRows=${liveRows}`).not.toContain('~+');
      expect(rendered, `liveRows=${liveRows}`).not.toContain('alpha');
    }
  });

  it('keeps drawing through a hole the transport dropped', () => {
    // Deltas are dropped wholesale under backpressure, so the accumulator is a
    // prefix with pieces missing. What arrived is still what the file will say.
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', ['gamma\\n']);
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }));
    expect(rendered).toContain('alpha');
    expect(rendered).toContain('gamma');
  });

  it('replaces the preview with the real change once the call finishes', () => {
    const model = streamingModel('{"file_path":"src/new.ts","content":"alpha\\n', ['beta\\n']);
    model.apply({
      type: 'tool_result',
      data: {
        id: 'call-1',
        result: 'Wrote 2 lines to src/new.ts',
        metadata: {
          diff: [{
            path: 'src/new.ts',
            added: 2,
            removed: 0,
            hunks: [{
              oldStart: 0,
              oldLines: 0,
              newStart: 1,
              newLines: 2,
              lines: [
                { kind: 'add', text: 'alpha', oldLine: null, newLine: 1 },
                { kind: 'add', text: 'beta', oldLine: null, newLine: 2 },
              ],
            }],
          }],
        },
      },
    });
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 40 }));
    // The provisional marker is gone: these numbers are the change's final size.
    expect(rendered).not.toContain('~+');
    expect(rendered).toContain('+2');
    expect(rendered).toContain('alpha');
  });

  it('draws the preview on the block that is still running, after settled text', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'text', data: { content: 'Now writing the module.' } });
    model.apply({ type: 'tool_use_started', data: { id: 'call-1', name: 'write', input: {} } });
    model.apply({ type: 'tool_use_delta', data: { id: 'call-1', delta: '{"file_path":"src/new.ts","content":"alpha\\n' } });
    const lines = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 })).split('\n');
    const text = lines.findIndex((line) => line.includes('Now writing the module'));
    const preview = lines.findIndex((line) => line.includes('alpha'));
    expect(text).toBeGreaterThanOrEqual(0);
    // The preview belongs to the call that is still arriving, which is the
    // last thing in the transcript — that is what keeps it inside the live area.
    expect(preview).toBeGreaterThan(text);
    expect(lines.slice(preview + 1).filter((line) => line.trim() !== '')).toEqual([]);
  });

  it('never lets a preview row outgrow the pane', () => {
    const model = streamingModel(
      '{"file_path":"src/new.ts","content":"',
      ['const aVeryLongIdentifierThatWillCertainlyNeedTruncating = computeSomethingVeryLong();\\n'],
    );
    const rendered = renderTranscript(model, { ...OPTIONS, liveRows: 20 });
    for (const line of rendered.split('\n')) {
      expect(diffRowWidth(line)).toBeLessThanOrEqual(59);
    }
  });
});
