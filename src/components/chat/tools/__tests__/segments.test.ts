// Focus-mode segmenter tests — `computeSegments(actions, { focus: true })`
// suspends the usual group-breaking rules so the entire action list
// collapses into ONE run (one big Group) and text / widget / hook actions
// are skipped entirely.

import { describe, expect, it } from 'vitest';
import { computeSegments } from '../segments';
import type { ActionItem } from '../types';

function tool(id: string): ActionItem {
  return { kind: 'tool', tool: { id, name: 'Bash', input: {} } };
}

function text(content: string): ActionItem {
  return { kind: 'text', content };
}

function thinking(content: string): ActionItem {
  return { kind: 'thinking', content, isStreaming: false };
}

function hook(id: string): ActionItem {
  return {
    kind: 'hook',
    hook: {
      id,
      hookEventName: 'PreToolUse',
      hookType: 'command',
      hookName: 'guard',
      async: false,
      durationMs: 12,
      status: 'ok',
      seq: 1,
    },
  };
}

describe('computeSegments (default behavior)', () => {
  it('text breaks the run into separate segments', () => {
    const segments = computeSegments([tool('1'), text('hello'), tool('2')]);
    expect(segments).toHaveLength(2);
    expect(segments[0]).toEqual({ kind: 'single', entry: { kind: 'tool', tool: { id: '1', name: 'Bash', input: {} } } });
    expect(segments[1]).toEqual({ kind: 'single', entry: { kind: 'tool', tool: { id: '2', name: 'Bash', input: {} } } });
  });
});

describe('computeSegments focus mode', () => {
  it('merges everything across text boundaries into one big group', () => {
    const segments = computeSegments(
      [tool('1'), text('working…'), tool('2'), thinking('hmm'), tool('3')],
      { focus: true },
    );
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('group');
    if (segments[0].kind !== 'group') return;
    expect(segments[0].entries.map((e) => e.kind)).toEqual(['tool', 'tool', 'thinking', 'tool']);
    // The interleaved text never joins the entries.
    const hasTextEntry = segments[0].entries.some(
      (e) => e.kind === 'thinking' && e.content === 'working…',
    );
    expect(hasTextEntry).toBe(false);
  });

  it('keeps hooks inside the single run too', () => {
    const segments = computeSegments([tool('1'), hook('h1'), tool('2')], { focus: true });
    expect(segments).toHaveLength(1);
    expect(segments[0].kind).toBe('group');
    if (segments[0].kind !== 'group') return;
    expect(segments[0].entries.map((e) => e.kind)).toEqual(['tool', 'hook', 'tool']);
  });

  it('yields a single segment when only one work action exists', () => {
    const segments = computeSegments([text('intro'), tool('1')], { focus: true });
    expect(segments).toEqual([
      { kind: 'single', entry: { kind: 'tool', tool: { id: '1', name: 'Bash', input: {} } } },
    ]);
  });

  it('yields no segments for a text-only round', () => {
    const segments = computeSegments([text('a'), text('b')], { focus: true });
    expect(segments).toEqual([]);
  });

  it('does not mutate the default behavior when the flag is off', () => {
    const actions = [tool('1'), text('mid'), tool('2')];
    expect(computeSegments(actions)).toHaveLength(2);
    expect(computeSegments(actions, {})).toHaveLength(2);
  });
});
