/**
 * Plan 624 D2 — explicit update frames on the context rail.
 *
 * The rail rewrites the same message slot every turn, so without a frame the
 * model cannot tell "the environment changed" from "the text was always like
 * this". These cases pin the frame rules:
 *   - first appearance is not an update,
 *   - identical text is not an update,
 *   - changed text says which section changed,
 *   - a dropped slot is reported so the caller can log it.
 */

import { describe, expect, it } from 'vitest';

import { applyContextRail, renderContextUpdateFrame, type ContextBlock } from '@duya/host/worker-context/context-rail';
import type { InjectableMessage } from '@duya/host/worker-hooks/injection';

const NOW = 1_700_000_000_000;

function block(id: string, content: string): ContextBlock {
  return { id, source: 'volatile_context', content };
}

function railOf(messages: InjectableMessage[]): InjectableMessage[] {
  return messages.filter((message) => typeof message.metadata?.contextRailKey === 'string');
}

describe('plan 624 — context rail update frames', () => {
  it('does not frame the first appearance', () => {
    const messages: InjectableMessage[] = [];
    const report = applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });

    expect(report.added).toEqual(['environment']);
    expect(report.changed).toEqual([]);
    expect(railOf(messages)[0]?.content).not.toContain('Updated system context section');
  });

  it('frames a block whose text changed', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });

    const report = applyContextRail(messages, [block('environment', 'cwd=/b')], {
      now: NOW,
      previous: new Map([['environment', 'cwd=/a']]),
    });

    expect(report.changed).toEqual(['environment']);
    const content = String(railOf(messages)[0]?.content);
    expect(content).toContain('Updated system context section "environment".');
    expect(content).toContain('cwd=/b');
    expect(content).not.toContain('cwd=/a');
  });

  it('keeps one message per slot after an update', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a')], { now: NOW });
    applyContextRail(messages, [block('environment', 'cwd=/b')], {
      now: NOW,
      previous: new Map([['environment', 'cwd=/a']]),
    });

    expect(railOf(messages)).toHaveLength(1);
  });

  it('does not frame identical text', () => {
    const messages: InjectableMessage[] = [];
    const report = applyContextRail(messages, [block('environment', 'cwd=/a')], {
      now: NOW,
      previous: new Map([['environment', 'cwd=/a']]),
    });

    expect(report.unchanged).toEqual(['environment']);
    expect(report.changed).toEqual([]);
    expect(railOf(messages)[0]?.content).not.toContain('Updated system context section');
  });

  it('reports a dropped slot and removes its message', () => {
    const messages: InjectableMessage[] = [];
    applyContextRail(messages, [block('environment', 'cwd=/a'), block('apps', 'apps')], { now: NOW });

    const report = applyContextRail(messages, [block('environment', 'cwd=/a')], {
      now: NOW,
      previous: new Map([['environment', 'cwd=/a'], ['apps', 'apps']]),
    });

    expect(report.removed).toEqual(['apps']);
    expect(railOf(messages)).toHaveLength(1);
    expect(railOf(messages)[0]?.metadata?.contextRailKey).toBe('environment');
  });

  it('renders the frame as a single readable sentence', () => {
    expect(renderContextUpdateFrame('mcp', 'servers: none')).toBe(
      'Updated system context section "mcp".\n\nservers: none',
    );
  });
});
