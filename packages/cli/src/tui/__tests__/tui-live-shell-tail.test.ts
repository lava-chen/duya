/**
 * The live shell tail: what a running command printed, while it is running.
 *
 * Two halves, and the split is the whole design.
 *
 *  - `blocks.ts` accumulates `outputText` from `tool_output` frames. It owns the
 *    MEMORY bound (`OUTPUT_TAIL_MAX_CHARS`) and the lifetime rule: the tail is
 *    what a poller happened to sample, so `tool_result` supersedes it rather
 *    than appending to it.
 *  - `transcript-view.ts` owns the ROW bound. A row above `#liveStart` is
 *    already in the terminal's scrollback and cannot be taken back, so the body
 *    has to fit inside the live area — the same invariant
 *    `tui-file-diff-stream.test.ts` pins for the argument-stream preview, for
 *    the same reason, from a different source.
 *
 * `strip` removes blessed tags so assertions quote what the reader sees.
 */

import { describe, expect, it } from 'vitest';
import { OUTPUT_TAIL_MAX_CHARS, TranscriptModel } from '../blocks.js';
import { renderTranscript } from '../transcript-view.js';
import { projectHostEvent } from '../host-event-stream.js';

function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

const OPTIONS = { expanded: false, showToolResults: true, toolResultLines: 5, width: 60 };

/** A running `bash` call that announced itself and then printed `slices`. */
function runningShell(name: string, slices: readonly string[]): TranscriptModel {
  const model = new TranscriptModel();
  model.apply({ type: 'tool_use_started', data: { id: 'call-1', name, input: { command: 'npm test' } } });
  for (const delta of slices) {
    model.apply({ type: 'tool_output', data: { toolUseId: 'call-1', delta } });
  }
  return model;
}

function tailOf(model: TranscriptModel): string | undefined {
  return model.blocks.map((block) => ('outputText' in block ? block.outputText : undefined))[0];
}

describe('tool_output accumulation', () => {
  it('appends each slice to the call that is printing it', () => {
    const model = runningShell('bash', ['run 1/4 ok\n', 'run 2/4 ok\n']);
    expect(tailOf(model)).toBe('run 1/4 ok\nrun 2/4 ok\n');
  });

  it('keeps the END when the tail exceeds the cap', () => {
    // A build log's head was written minutes ago; a row that kept it would show
    // lines from a stage the command has long since left.
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use_started', data: { id: 'call-1', name: 'bash', input: {} } });
    const slice = 'x'.repeat(1000);
    for (let n = 0; n < 20; n++) {
      model.apply({ type: 'tool_output', data: { toolUseId: 'call-1', delta: `${slice}${n}\n` } });
    }
    const tail = tailOf(model) ?? '';
    expect(tail.length).toBe(OUTPUT_TAIL_MAX_CHARS);
    expect(tail.endsWith('19\n')).toBe(true);
    expect(tail.includes('x'.repeat(1000) + '0\n')).toBe(false);
  });

  it('ignores output for a call that never announced itself', () => {
    const model = new TranscriptModel();
    const result = model.apply({ type: 'tool_output', data: { toolUseId: 'ghost', delta: 'hello\n' } });
    expect(result.kind).toBe('none');
    expect(model.blocks).toHaveLength(0);
  });

  it('ignores an empty slice', () => {
    const model = runningShell('bash', ['first\n']);
    const before = model.revisionOf(model.blocks[0]!);
    expect(model.apply({ type: 'tool_output', data: { toolUseId: 'call-1', delta: '' } }).kind).toBe('none');
    expect(model.revisionOf(model.blocks[0]!)).toBe(before);
  });

  it('accepts the legacy `data` field and `id` as the call key', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use_started', data: { id: 'call-1', name: 'bash', input: {} } });
    model.apply({ type: 'tool_output', data: { id: 'call-1', data: 'via legacy keys\n' } });
    expect(tailOf(model)).toBe('via legacy keys\n');
  });

  it('is superseded by the result, not supplemented', () => {
    const model = runningShell('bash', ['partial tail\n']);
    model.apply({
      type: 'tool_result',
      data: { id: 'call-1', result: '42 tests passed', duration_ms: 1200 },
    });
    // A live tail kept past settle is an 8 KiB build-log buffer on a row that no
    // longer reads it — and a renderer that preferred it would show the sampled
    // tail instead of what the tool actually returned.
    expect(tailOf(model)).toBeUndefined();
    expect(strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }))).toContain('42 tests passed');
  });

  it('bumps the content revision so the render cache goes stale', () => {
    const model = runningShell('bash', []);
    const block = model.blocks[0]!;
    const before = model.revisionOf(block);
    model.apply({ type: 'tool_output', data: { toolUseId: 'call-1', delta: 'newest line\n' } });
    expect(model.revisionOf(block)).toBeGreaterThan(before);
  });
});

describe('live shell preview', () => {
  it('draws the newest lines under a running shell row', () => {
    const model = runningShell('bash', ['compiling\n', 'linking\n']);
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }));
    expect(rendered).toContain('compiling');
    expect(rendered).toContain('linking');
  });

  it('keeps the whole block inside the live area', () => {
    const model = runningShell('bash', [
      ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'].join('\n') + '\n',
    ]);
    for (const liveRows of [3, 4, 6, 9, 20]) {
      const rendered = renderTranscript(model, { ...OPTIONS, liveRows });
      expect(rendered.split('\n').length, `liveRows=${liveRows}`).toBeLessThanOrEqual(liveRows);
    }
  });

  it('shows nothing when the live area cannot hold a preview', () => {
    const model = runningShell('bash', ['alpha\n']);
    for (const liveRows of [1, 2]) {
      const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows }));
      expect(rendered, `liveRows=${liveRows}`).not.toContain('alpha');
    }
  });

  it('shows nothing when the live height is unknown', () => {
    // Without a known live area the preview cannot bound itself, so it stays off
    // the screen rather than freezing tail rows into scrollback.
    const model = runningShell('bash', ['alpha\n']);
    expect(strip(renderTranscript(model, OPTIONS))).not.toContain('alpha');
  });

  it('tails, so the newest line is present and the oldest is not', () => {
    const model = runningShell('bash', ['oldest line\n', 'middle\n', 'newest line\n']);
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 4 }));
    expect(rendered).toContain('newest line');
    expect(rendered).not.toContain('oldest line');
  });

  it('draws for a shell call only', () => {
    // `outputText` is filled by whatever the process printed; a non-shell tool
    // that somehow got a tail has no preview contract, so its row stays clean.
    const model = runningShell('read', ['alpha\n']);
    expect(tailOf(model)).toBe('alpha\n');
    expect(strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }))).not.toContain('alpha');
  });

  it('does not outlive the call', () => {
    const model = runningShell('bash', ['alpha\n']);
    model.apply({ type: 'tool_result', data: { id: 'call-1', result: 'done', duration_ms: 1 } });
    const rows = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 })).split('\n');
    expect(rows.filter((line) => line.includes('alpha'))).toHaveLength(0);
  });

  it('clips a tail line to the pane width', () => {
    const model = runningShell('bash', [`${'y'.repeat(400)}\n`]);
    const rows = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 })).split('\n');
    const tail = rows.find((line) => line.includes('yyyy'));
    expect(tail).toBeDefined();
    expect(tail!.length).toBeLessThanOrEqual(OPTIONS.width);
    // One line must mean ONE row: a tail that wrapped would make the cheapest
    // preview in the transcript the dearest.
    expect(rows.filter((line) => line.includes('yyyy'))).toHaveLength(1);
  });

  it('collapses CRLF and blank lines', () => {
    const model = runningShell('bash', ['one\r\n\r\ntwo\r\n']);
    const rendered = strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }));
    expect(rendered).toContain('one');
    expect(rendered).toContain('two');
    expect(rendered.split('\n').filter((line) => line.trim() === '')).toHaveLength(0);
  });
});

describe('host event projection', () => {
  it('projects tool.output_delta onto the tool_output frame', () => {
    const frame = projectHostEvent({
      type: 'tool.output_delta',
      toolCallId: 'call-1',
      delta: 'linking\n',
    } as never);
    expect(frame).toEqual({ type: 'tool_output', data: { toolUseId: 'call-1', delta: 'linking\n' } });
  });

  it('reaches the block through the projector and the model together', () => {
    const model = new TranscriptModel();
    model.apply({ type: 'tool_use_started', data: { id: 'call-1', name: 'bash', input: {} } });
    const frame = projectHostEvent({
      type: 'tool.output_delta',
      toolCallId: 'call-1',
      delta: 'the end is near\n',
    } as never);
    expect(frame).not.toBeNull();
    model.apply(frame!);
    expect(strip(renderTranscript(model, { ...OPTIONS, liveRows: 20 }))).toContain('the end is near');
  });
});
