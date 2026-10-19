/**
 * The two pieces plan 615 Phase 6 pulled out of `TUIApp`.
 *
 * Both are unit-testable precisely because they no longer need a terminal: the
 * activity tracker takes frames and returns a label, and the pane takes props
 * and returns lines. Everything that remains coupled to a TTY stayed behind.
 */

import { describe, expect, it } from 'vitest';
import { ActivityTracker } from '../activity.js';
import { TranscriptPane } from '../transcript-pane.js';
import { TranscriptRenderer } from '../../transcript-cache.js';
import { TranscriptModel } from '../../blocks.js';
import { DEFAULT_RENDER_OPTIONS } from '../../transcript-view.js';

/** A frame as the projector emits it. */
function frame(type: string, data: Record<string, unknown> = {}): {
  readonly type: string;
  readonly data: Record<string, unknown>;
} {
  return { type, data };
}

describe('ActivityTracker', () => {
  it('prefers the tool over the agent over the group over a bare phase', () => {
    const activity = new ActivityTracker();

    activity.apply(frame('tool_group_progress', { title: 'Reading 3 files' }), true);
    expect(activity.label(true)).toBe('Reading 3 files');

    activity.apply(frame('agent_progress', { agentEventType: 'subagent_started', subagentId: 'a1', agentName: 'explorer' }), true);
    expect(activity.label(true)).toBe('explorer working');

    activity.apply(frame('tool_use', { id: 't1', name: 'read_file' }), true);
    // The tool is the most specific fact available, and the agent it belongs to
    // rides along rather than being dropped.
    expect(activity.label(true)).toBe('read_file / explorer');
  });

  it('does not repaint for a sub-second progress tick', () => {
    // The label prints whole seconds, so a change below one second cannot change
    // a pixel. Returning `true` here is what makes a chatty tool cost a repaint
    // per event.
    const activity = new ActivityTracker();
    activity.apply(frame('tool_use', { id: 't1', name: 'bash' }), true);
    expect(activity.apply(frame('tool_progress', { toolName: 't1', elapsedSeconds: 1.2 }), true)).toBe(true);
    expect(activity.apply(frame('tool_progress', { toolName: 't1', elapsedSeconds: 1.7 }), true)).toBe(false);
    expect(activity.apply(frame('tool_progress', { toolName: 't1', elapsedSeconds: 2.0 }), true)).toBe(true);
  });

  it('drops back to the phase the run is actually in when the last tool finishes', () => {
    const activity = new ActivityTracker();
    activity.apply(frame('tool_use', { id: 't1', name: 'bash' }), true);
    activity.apply(frame('tool_result', { id: 't1' }), true);
    expect(activity.label(true)).toBe('Working');
    expect(activity.tools.size).toBe(0);

    activity.apply(frame('tool_use', { id: 't2', name: 'bash' }), false);
    activity.apply(frame('tool_result', { id: 't2' }), false);
    // Same frame, idle run: `ready`, not `working`. The tracker takes `busy`
    // because it cannot know whether a turn is still in flight.
    expect(activity.label(false)).toBe('Ready');
  });

  it('lets a permission ask outrank every other fact', () => {
    const activity = new ActivityTracker();
    activity.apply(frame('tool_use', { id: 't1', name: 'bash' }), true);
    activity.apply(frame('permission'), true);
    expect(activity.label(true)).toBe('Waiting for approval');
    expect(activity.waitingForPermission).toBe(true);
  });

  it('reports a completed or failed run and forgets the tools that led to it', () => {
    const activity = new ActivityTracker();
    activity.apply(frame('tool_use', { id: 't1', name: 'bash' }), true);
    activity.apply(frame('done'), false);
    expect(activity.label(false)).toBe('Completed');
    expect(activity.tools.size).toBe(0);

    activity.apply(frame('error'), false);
    expect(activity.label(false)).toBe('Failed');
  });

  it('reports whether a frame changed the chrome at all', () => {
    const activity = new ActivityTracker();
    // Unknown frame kinds are other subsystems' business.
    expect(activity.apply(frame('token_usage', {}), true)).toBe(false);
    // A second identical status message is not a change.
    expect(activity.apply(frame('status', { message: 'Indexing' }), true)).toBe(true);
    expect(activity.apply(frame('status', { message: 'Indexing' }), true)).toBe(false);
  });
});

describe('TranscriptPane document cache', () => {
  function makeModel(count: number): TranscriptModel {
    const model = new TranscriptModel();
    model.addUser('hello');
    for (let index = 0; index < count; index += 1) {
      model.apply({ type: 'text_delta', data: { id: `m${index}`, index, text: `line ${index}` } });
      model.apply({ type: 'text', data: { id: `m${index}`, index } });
    }
    return model;
  }

  const OPTIONS = { ...DEFAULT_RENDER_OPTIONS, renderer: 'own' as const };

  it('assembles the document once until the revision or the options change', () => {
    const renderer = new TranscriptRenderer();
    const model = makeModel(20);
    const pane = new TranscriptPane({ renderer, model, options: OPTIONS, scrollLines: 0, revision: 0 });

    const first = pane.lines(80);
    // Same revision, same width: the SAME array comes back, so a streaming frame
    // that changed nothing costs no concatenation at all. Comparing by identity
    // is the point — an equal-but-new array would still be O(document) work per
    // frame, which is what the cache exists to avoid.
    expect(pane.lines(80)).toBe(first);

    // The per-block cache is untouched by a revision bump: the blocks are
    // unchanged, only the owner's claim about them is. Re-assembly reuses them.
    const missesBefore = renderer.stats.misses;
    pane.props = { ...pane.props, revision: 1 };
    const second = pane.lines(80);
    expect(second).not.toBe(first);
    expect(second).toEqual(first);
    expect(renderer.stats.misses).toBe(missesBefore);
  });

  it('re-assembles when the width changes, because wrapping changes lines', () => {
    const renderer = new TranscriptRenderer();
    const pane = new TranscriptPane({ renderer, model: makeModel(4), options: OPTIONS, scrollLines: 0 });
    pane.lines(80);
    const wide = renderer.stats.misses;
    pane.lines(40);
    expect(renderer.stats.misses).toBeGreaterThan(wide);
  });

  it('windows the same lines it assembled, newest-first when following', () => {
    const renderer = new TranscriptRenderer();
    const model = makeModel(30);
    const pane = new TranscriptPane({ renderer, model, options: OPTIONS, scrollLines: 0 });
    const lines = pane.lines(80);
    const visible = pane.visibleLines(80, 10);
    expect(visible).toHaveLength(Math.min(10, lines.length));
    expect(visible[visible.length - 1]).toBe(lines[lines.length - 1]);

    pane.props = { ...pane.props, scrollLines: 5 };
    const scrolled = pane.visibleLines(80, 10);
    const window = pane.window(80, 10);
    expect(scrolled[0]).toBe(lines[window.lineStart]);
  });
});
