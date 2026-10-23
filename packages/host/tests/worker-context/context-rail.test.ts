/**
 * Plan 619 Phase 3 — the volatile-context rail.
 *
 * The rail carries the prompt content that changes every turn into the
 * message channel, so the system prefix stays byte-identical. The rules
 * it has to honour:
 *   - exactly one copy per block per request, with the current text,
 *   - a block that stopped rendering leaves no stale text behind, and
 *   - the rail never enters the session timeline.
 */

import { describe, expect, it } from 'vitest';

import { applyContextRail, type ContextBlock } from '@duya/host/worker-context/context-rail';
import type { InjectableMessage } from '@duya/host/worker-hooks/injection';

const NOW = 1_700_000_000_000;

function block(id: string, content: string): ContextBlock {
  return { id, source: 'volatile_context', content };
}

function railMessages(messages: InjectableMessage[]): InjectableMessage[] {
  return messages.filter(
    (message) => typeof message.metadata?.contextRailKey === 'string',
  );
}

describe('plan 619 phase 3 — the context rail', () => {
  it('delivers one block per slot, with the current text', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a'), block('memory', 'mem')], {
      now: NOW,
    });

    const rail = railMessages(messages);
    expect(rail).toHaveLength(2);
    expect(rail[0]?.content).toContain('cwd=/a');
    expect(rail[0]?.role).toBe('user');
  });

  it('replaces a block instead of stacking a second copy', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });
    applyContextRail(messages, [block('environment', 'cwd=/b')], { now: NOW });

    const rail = railMessages(messages);
    expect(rail).toHaveLength(1);
    expect(rail[0]?.content).toContain('cwd=/b');
    expect(rail[0]?.content).not.toContain('cwd=/a');
  });

  it('removes a block that stopped rendering', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a'), block('apps', 'apps')], {
      now: NOW,
    });
    expect(railMessages(messages)).toHaveLength(2);

    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });
    const rail = railMessages(messages);
    expect(rail).toHaveLength(1);
    expect(rail[0]?.content).toContain('cwd=/a');
  });

  it('clears the rail when there is nothing volatile left', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });
    applyContextRail(messages, [], { now: NOW });
    expect(railMessages(messages)).toHaveLength(0);
  });

  it('marks the block as system information, not as something the user typed', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });

    const content = railMessages(messages)[0]?.content ?? '';
    expect(content.startsWith('<system-reminder>')).toBe(true);
    expect(content).toContain('not part of the user');
  });

  it('leaves other messages alone', () => {
    const messages: InjectableMessage[] = [
      { id: 'm1', role: 'user', content: 'hello', timestamp: NOW },
    ];
    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });

    expect(messages[0]?.content).toBe('hello');
    expect(messages).toHaveLength(2);
  });
});
