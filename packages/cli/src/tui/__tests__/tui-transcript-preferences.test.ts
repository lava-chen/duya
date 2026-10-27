/**
 * The transcript preferences `/settings` moves: hidden thinking, expanded
 * blocks, tool results, tool groups.
 *
 * These are renderer-level on purpose. The menu can paint `Hidden` on a row all
 * day; what matters is that the thinking block is not in the plan afterwards,
 * and that the blocks around it keep their own shape — a filter that shifted
 * every later connector would be a worse bug than the one it fixes.
 */

import { describe, expect, it } from 'vitest';

import { TranscriptModel } from '../blocks.js';
import { renderTranscript, visibleBlocks, type RenderOptions } from '../transcript-view.js';

function model(): TranscriptModel {
  const model = new TranscriptModel();
  model.addUser('what is in this file?');
  model.apply({ type: 'thinking_delta', data: { content: 'The file is small, so one read is enough.' } });
  model.apply({ type: 'tool_use', data: { id: 'c1', name: 'read_file', input: { path: 'a.txt' } } });
  model.apply({ type: 'tool_result', data: { id: 'c1', result: 'hello' } });
  return model;
}

/** A batch of three reads, the second still running. */
function batchModel(running: 'none' | 'middle' | 'last'): TranscriptModel {
  const model = new TranscriptModel();
  model.addUser('read them all');
  const ids = ['a.txt', 'b.txt', 'c.txt'];
  ids.forEach((path, index) => {
    const id = `call-${index}`;
    model.apply({ type: 'tool_use', data: { id, name: 'read_file', input: { path } } });
    const settled = index !== (running === 'none' ? -1 : running === 'middle' ? 1 : 2);
    if (settled) model.apply({ type: 'tool_result', data: { id, result: `body of ${path}` } });
  });
  return model;
}

describe('transcript preferences', () => {
  it('keeps thinking by default', () => {
    const rendered = renderTranscript(model());
    expect(rendered).toContain('The file is small');
  });

  it('drops thinking blocks entirely when they are hidden', () => {
    const rendered = renderTranscript(model(), {
      expanded: false,
      showToolResults: false,
      toolResultLines: 5,
      showThinking: false,
    });
    expect(rendered).not.toContain('The file is small');
    // The blocks either side survive, unchanged in kind.
    expect(rendered).toContain('what is in this file?');
    expect(rendered).toContain('read_file');
  });

  it('filters by kind and leaves every other block in place', () => {
    const blocks = visibleBlocks(model().blocks, {
      expanded: false,
      showToolResults: false,
      toolResultLines: 5,
      showThinking: false,
    });
    expect(blocks.map((block) => block.kind)).not.toContain('thinking');
    expect(blocks.length).toBe(model().blocks.filter((block) => block.kind !== 'thinking').length);
  });

  it('shows tool results on demand without expanding anything else', () => {
    const base = { expanded: false, toolResultLines: 5 };
    expect(renderTranscript(model(), { ...base, showToolResults: false })).not.toContain('hello');
    expect(renderTranscript(model(), { ...base, showToolResults: true })).toContain('hello');
  });
});

/** Strip blessed tags, leaving the text a reader sees. */
function strip(text: string): string {
  return text.replace(/\{[^}]*\}/gu, '');
}

const PLAIN: RenderOptions = { expanded: false, showToolResults: true, toolResultLines: 5 };

describe('toolGroupMode', () => {
  it('lists every call of a batch under its header when full', () => {
    const rendered = strip(renderTranscript(batchModel('middle'), { ...PLAIN, toolGroupMode: 'full' }));
    expect(rendered).toContain('Reading 3 files');
    for (const path of ['a.txt', 'b.txt', 'c.txt']) expect(rendered).toContain(path);
    expect(rendered).toContain('body of a.txt');
  });

  it('keeps every row and drops only the bodies under names', () => {
    const rendered = strip(renderTranscript(batchModel('none'), { ...PLAIN, toolGroupMode: 'names' }));
    for (const path of ['a.txt', 'b.txt', 'c.txt']) expect(rendered).toContain(path);
    expect(rendered).not.toContain('body of a.txt');
    // The `[+ N lines]` hint would advertise a body the mode refuses to draw.
    expect(rendered).not.toContain('[+ ');
  });

  it('lets an explicit expansion win over names', () => {
    const withResults = strip(renderTranscript(model(), { ...PLAIN, toolGroupMode: 'names', expanded: true }));
    expect(withResults).toContain('hello');
  });

  it('folds a settled batch to its header when running', () => {
    const rendered = strip(renderTranscript(batchModel('none'), { ...PLAIN, toolGroupMode: 'running' }));
    expect(rendered).toContain('Read 3 files');
    for (const path of ['a.txt', 'b.txt', 'c.txt']) expect(rendered).not.toContain(path);
  });

  it('shows the in-flight call and keeps the header count truthful', () => {
    const rendered = strip(renderTranscript(batchModel('last'), { ...PLAIN, toolGroupMode: 'running' }));
    expect(rendered).toContain('c.txt');
    expect(rendered).not.toContain('a.txt');
    // Three calls ran, so three is what the header says — the folded rows are
    // hidden, not absent.
    expect(rendered).toContain('Reading 3 files');
  });

  it('folds the head call but not the batch it summarises', () => {
    const rendered = strip(renderTranscript(batchModel('middle'), { ...PLAIN, toolGroupMode: 'running' }));
    expect(rendered).toContain('b.txt');
    expect(rendered).not.toContain('a.txt');
    expect(rendered).not.toContain('c.txt');
  });

  it('leaves a thinking block out of the fold', () => {
    const rendered = strip(renderTranscript(model(), { ...PLAIN, toolGroupMode: 'running', showThinking: true }));
    // The read here is a node of one and is settled, so it folds; the thought
    // is not a tool call and stays.
    expect(rendered).toContain('Thought');
    expect(rendered).not.toContain('a.txt');
  });

  it('marks nothing when the selected block folded away', () => {
    const withSelection = new TranscriptModel();
    withSelection.addUser('hi');
    withSelection.apply({ type: 'tool_use', data: { id: 's1', name: 'read_file', input: { path: 'a.txt' } } });
    withSelection.apply({ type: 'tool_result', data: { id: 's1', result: 'hello' } });
    const settledId = withSelection.blocks[1].id;
    const rendered = strip(renderTranscript(withSelection, {
      ...PLAIN,
      toolGroupMode: 'running',
      selectedBlockId: settledId,
    }));
    // A caret with no row under it used to mint `❯ undefined`.
    expect(rendered).not.toContain('❯');
    expect(rendered).not.toContain('undefined');
  });
});
