import { describe, it, expect } from 'vitest';
import { TranscriptModel } from '../blocks.js';
import { renderTranscript, DEFAULT_RENDER_OPTIONS } from '../transcript-view.js';
import { TranscriptRenderer } from '../transcript-cache.js';

/**
 * The cache must be invisible: every frame it produces must be byte-identical
 * to what the uncached `renderTranscript` produces, or the scroll arithmetic
 * in `TUIApp` — which reads heights from the cache and windows from the paint
 * path — would drift apart line by line.
 */

const OPTIONS = { ...DEFAULT_RENDER_OPTIONS, expanded: false, showToolResults: true, toolResultLines: 5 };

function seedModel(): TranscriptModel {
  const model = new TranscriptModel();
  model.addUser('summarize the repo');
  model.appendThinkingDelta('considering layout…');
  model.appendTextDelta('# Title\n\nSome *emphasis* and `code`.\n\n');
  model.appendTextDelta('| a | b |\n|---|---|\n| 1 | 2 |\n\n');
  model.appendTextDelta('```ts\nconst x = 1;\n```\n\ndone.');
  model.upsertTool('c1', 'read_file', { path: 'a.ts' });
  model.upsertTool('c2', 'read_file', { path: 'b.ts' });
  model.completeTool('c1', 'contents of a', false);
  model.completeTool('c2', 'contents of b\nmore lines', false);
  model.addError('boom');
  model.addNotice('all settled');
  return model;
}

describe('TranscriptRenderer', () => {
  it('produces byte-identical output to the uncached renderTranscript', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    expect(renderer.lines(model, OPTIONS).join('\n')).toBe(renderTranscript(model, OPTIONS));
  });

  it('keeps heights and totalLines equal to the flattened render', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    const heights = renderer.heights(model, OPTIONS);
    const total = renderer.totalLines(model, OPTIONS);
    expect(total).toBe(heights.reduce((sum, lines) => sum + lines, 0));
    expect(total).toBe(renderTranscript(model, OPTIONS).split('\n').length);
  });

  it('serves unchanged blocks from cache on the second frame', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    renderer.lines(model, OPTIONS);
    const missesAfterFirst = renderer.stats.misses;

    renderer.lines(model, OPTIONS);
    expect(renderer.stats.misses).toBe(missesAfterFirst);
    expect(renderer.stats.hits).toBe(model.blocks.length);
  });

  it('re-renders only the block that a stream mutation touched', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    renderer.lines(model, OPTIONS);
    const missesBefore = renderer.stats.misses;

    const assistant = model.activeAssistant;
    expect(assistant).not.toBeNull();
    model.appendTextDelta(' appended');
    renderer.lines(model, OPTIONS);

    expect(renderer.stats.misses).toBe(missesBefore + 1);
    const rendered = renderer.lines(model, OPTIONS).join('\n');
    expect(rendered).toContain('appended');
    expect(rendered).toBe(renderTranscript(model, OPTIONS));
  });

  it('invalidates a tool block on status transition', () => {
    const model = new TranscriptModel();
    model.upsertTool('c9', 'terminal', { command: 'ls' });
    const renderer = new TranscriptRenderer();
    const running = renderer.lines(model, OPTIONS).join('\n');
    expect(running).toContain('⏺');

    model.completeTool('c9', 'file list', false);
    const done = renderer.lines(model, OPTIONS).join('\n');
    expect(done).toContain('✔');
    expect(done).toContain('file list');
    expect(done).toBe(renderTranscript(model, OPTIONS));
  });

  it('moves the selection prefix without re-rendering anything', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    renderer.lines(model, OPTIONS);
    const missesBefore = renderer.stats.misses;

    const target = model.blocks[3];
    expect(target).toBeDefined();
    const selected = renderer.lines(model, { ...OPTIONS, selectedBlockId: target?.id }).join('\n');
    expect(renderer.stats.misses).toBe(missesBefore);

    // The selection shows up as a prefix on the block's first line only.
    const unselected = renderer.lines(model, OPTIONS).join('\n').split('\n');
    const selectedLines = selected.split('\n');
    expect(selectedLines.length).toBe(unselected.length);
    // And the cached form is still the uncached form's selection variant.
    const golden = renderTranscript(model, { ...OPTIONS, selectedBlockId: target?.id });
    expect(selected).toBe(golden);
  });

  it('re-renders when per-block expansion flips', () => {
    const model = new TranscriptModel();
    model.appendThinkingDelta('deep thought');
    const renderer = new TranscriptRenderer();
    const collapsed = renderer.lines(model, OPTIONS).join('\n');
    expect(collapsed).toContain('thinking… (12 chars)');

    const expanded = renderer.lines(model, { ...OPTIONS, expandedBlockIds: new Set([model.activeThinking?.id]) });
    expect(expanded.join('\n')).toContain('deep thought');
    expect(expanded.join('\n')).toBe(
      renderTranscript(model, { ...OPTIONS, expandedBlockIds: new Set([model.activeThinking?.id]) }),
    );
  });

  it('survives clear and keeps producing correct output for new blocks', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    renderer.lines(model, OPTIONS);

    model.clear();
    model.addUser('fresh start');
    const lines = renderer.lines(model, OPTIONS).join('\n');
    expect(lines).toBe(renderTranscript(model, OPTIONS));
    expect(lines).toContain('fresh start');
    expect(lines).not.toContain('boom');
  });

  it('keeps group continuation rendering identical to the uncached path', () => {
    const model = seedModel();
    const renderer = new TranscriptRenderer();
    const cached = renderer.lines(model, OPTIONS).join('\n');
    // The second read_file renders as a └ continuation in both paths.
    expect(cached).toContain('└ b.ts');
    expect(cached).toBe(renderTranscript(model, OPTIONS));
  });
});
