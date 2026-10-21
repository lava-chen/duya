import { describe, expect, it } from 'vitest';
import {
  MAX_PROGRESS_TITLE_LENGTH,
  PROGRESS_UPDATE_TOOL,
  readProgressUpdateCall,
  sanitizeProgressTitle,
  ToolGroupProgressTracker,
} from '../tool-group-progress.js';

describe('private tool-group progress title', () => {
  it('trims plain text and caps its length', () => {
    expect(sanitizeProgressTitle('  Inspect the changed files  ')).toBe('Inspect the changed files');
    expect(sanitizeProgressTitle('x'.repeat(MAX_PROGRESS_TITLE_LENGTH + 30)))
      .toHaveLength(MAX_PROGRESS_TITLE_LENGTH);
  });

  it('rejects non-text, empty, and control-character values', () => {
    expect(sanitizeProgressTitle(null)).toBeUndefined();
    expect(sanitizeProgressTitle('   ')).toBeUndefined();
    expect(sanitizeProgressTitle('first line\nsecond line')).toBeUndefined();
  });

  it('declares a private title-only control tool', () => {
    expect(PROGRESS_UPDATE_TOOL.name).toBe('progress_update');
    expect(PROGRESS_UPDATE_TOOL.input_schema.required).toEqual(['title']);
    expect(PROGRESS_UPDATE_TOOL.input_schema.additionalProperties).toBe(false);
  });

  it('starts a new stable group for each title without moving earlier calls', () => {
    const tracker = new ToolGroupProgressTracker();
    tracker.queue('Read the matching files', 'provider_commentary');
    const first = tracker.assign('call-1');
    const parallel = tracker.assign('call-2');

    expect(first.groupId).toBe(parallel.groupId);
    expect(first.progressTitle).toBe('Read the matching files');
    expect(first.progressEvent).toMatchObject({
      title: 'Read the matching files',
      source: 'provider_commentary',
    });

    tracker.queue('Summarize the results', 'model_progress_tool');
    const next = tracker.assign('call-3');
    expect(next.groupId).not.toBe(first.groupId);
    expect(next.progressTitle).toBe('Summarize the results');
    expect(next.progressEvent?.source).toBe('model_progress_tool');
    expect(tracker.assign('call-1').groupId).toBe(first.groupId);
    expect(tracker.assign('call-2').progressTitle).toBe('Read the matching files');
  });

  it('keeps fallback grouping across requests and closes it at a text boundary', () => {
    const tracker = new ToolGroupProgressTracker();
    const first = tracker.assign('call-1');
    expect(tracker.assign('call-2').groupId).toBe(first.groupId);
    expect(first.progressSource).toBe('tool_fallback');
    tracker.closeActiveGroup();
    expect(tracker.assign('call-3').groupId).not.toBe(first.groupId);
  });

  it('restores only the pending title when a provider request retries', () => {
    const tracker = new ToolGroupProgressTracker();
    tracker.queue('Retry this batch', 'provider_commentary');
    const pending = tracker.pendingSnapshot();
    tracker.queue('Failed-attempt title', 'provider_commentary');
    tracker.restorePending(pending);
    expect(tracker.assign('call-1').progressTitle).toBe('Retry this batch');
  });

  it('recognizes only the private progress control call before tool dispatch', () => {
    expect(readProgressUpdateCall('read_file', 'progress_update', { title: 'ignored' })).toBeNull();
    expect(readProgressUpdateCall('progress_update', 'progress_update', { title: '  Search the docs  ' }))
      .toEqual({ title: 'Search the docs' });
    expect(readProgressUpdateCall('progress_update', 'progress_update', { title: 'unsafe\nvalue' }))
      .toEqual({ title: undefined });
  });
});
