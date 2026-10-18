/**
 * The transcript preferences `/settings` moves: hidden thinking, expanded
 * blocks, tool results.
 *
 * These are renderer-level on purpose. The menu can paint `Hidden` on a row all
 * day; what matters is that the thinking block is not in the plan afterwards,
 * and that the blocks around it keep their own shape — a filter that shifted
 * every later connector would be a worse bug than the one it fixes.
 */

import { describe, expect, it } from 'vitest';

import { TranscriptModel } from '../blocks.js';
import { renderTranscript, visibleBlocks } from '../transcript-view.js';

function model(): TranscriptModel {
  const model = new TranscriptModel();
  model.addUser('what is in this file?');
  model.apply({ type: 'thinking_delta', data: { content: 'The file is small, so one read is enough.' } });
  model.apply({ type: 'tool_use', data: { id: 'c1', name: 'read_file', input: { path: 'a.txt' } } });
  model.apply({ type: 'tool_result', data: { id: 'c1', result: 'hello' } });
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
