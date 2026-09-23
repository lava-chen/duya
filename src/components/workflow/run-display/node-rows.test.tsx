// @vitest-environment jsdom

/**
 * node-rows.test.tsx — plan 560 §7.2: one row component per node kind.
 *
 * The point under test is not the markup, it is the ROUTING plus the fact that
 * each kind surfaces the facts only it produces: a bash step shows its exit
 * code, an agent step its token spend, a human step that it is still waiting.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useTranslation', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import {
  NODE_KINDS,
  NODE_KIND_TILE,
  NodeStepRow,
  formatStepDuration,
  formatStepSize,
  nodeKindOf,
  type WorkflowNodeKind,
} from './node-rows';
import type { WorkflowJournalRecord } from '@/components/layout/panels/WorkflowPanel';

function rec(overrides: Partial<WorkflowJournalRecord> = {}): WorkflowJournalRecord {
  return {
    seq: 1,
    kind: 'node_result',
    nodeId: 'n1',
    status: 'succeeded',
    nodeKind: 'tool',
    action: 'Bash',
    inputSummary: 'git status --porcelain',
    ...overrides,
  };
}

describe('step formatting helpers', () => {
  it('formats durations as ms then seconds', () => {
    expect(formatStepDuration(undefined)).toBeNull();
    expect(formatStepDuration(-1)).toBeNull();
    expect(formatStepDuration(0)).toBe('0ms');
    expect(formatStepDuration(940)).toBe('940ms');
    expect(formatStepDuration(1250)).toBe('1.25s');
    expect(formatStepDuration(125_000)).toBe('125.0s');
  });

  it('formats output sizes in bytes / KB / MB and hides zero', () => {
    expect(formatStepSize(undefined)).toBeNull();
    expect(formatStepSize(0)).toBeNull();
    expect(formatStepSize(371)).toBe('371 B');
    expect(formatStepSize(2048)).toBe('2.0 KB');
    expect(formatStepSize(5 * 1024 * 1024)).toBe('5.0 MB');
  });
});

describe('node kind routing', () => {
  it('knows all seven kinds and gives each a tile', () => {
    expect(NODE_KINDS).toHaveLength(7);
    for (const kind of NODE_KINDS) {
      expect(NODE_KIND_TILE[kind].Icon).toBeTruthy();
      expect(NODE_KIND_TILE[kind].labelKey).toContain(kind);
    }
  });

  it('falls back to the tool row for an unknown or missing kind', () => {
    expect(nodeKindOf({ nodeKind: 'mystery', kind: 'node_result' })).toBe('tool');
    expect(nodeKindOf({ kind: 'node_result' })).toBe('tool');
  });

  it.each(NODE_KINDS)('renders kind `%s` with its own component', (kind: WorkflowNodeKind) => {
    render(<NodeStepRow record={rec({ nodeKind: kind })} />);
    const row = document.querySelector(`[data-node-kind="${kind}"]`);
    expect(row).not.toBeNull();
  });

  it('a tool step shows its exit code, duration and size', () => {
    render(
      <NodeStepRow
        record={rec({ nodeKind: 'tool', exitCode: 0, durationMs: 12, outputSize: 371 })}
      />,
    );
    const row = document.querySelector('[data-node-kind="tool"]')!;
    expect(row.textContent).toContain('workflow.step.exitCode');
    expect(row.textContent).toContain('0');
    expect(row.textContent).toContain('12ms');
    expect(row.textContent).toContain('371 B');
  });

  it('an agent step shows its token spend instead of an exit code', () => {
    render(
      <NodeStepRow
        record={rec({ nodeKind: 'agent', usage: { inputTokens: 30, outputTokens: 12 }, exitCode: 0 })}
      />,
    );
    const row = document.querySelector('[data-node-kind="agent"]')!;
    expect(row.textContent).toContain('42');
    expect(row.textContent).toContain('workflow.step.tokens');
  });

  it('a waiting human step says so, instead of looking finished', () => {
    render(<NodeStepRow record={rec({ nodeKind: 'human', status: 'waiting' })} />);
    const row = document.querySelector('[data-node-kind="human"]')!;
    expect(row.textContent).toContain('workflow.step.awaitingHuman');
  });

  it('a browser step shows where it landed and its screenshot count', () => {
    render(
      <NodeStepRow
        record={rec({
          nodeKind: 'browser',
          inputSummary: 'https://example.com: click #login',
          result: { url: 'https://example.com/inbox', title: 'Inbox', steps: 3, screenshots: ['r/shot-1.png'] },
          durationMs: 2400,
        })}
      />,
    );
    const row = document.querySelector('[data-node-kind="browser"]')!;
    expect(row.textContent).toContain('workflow.step.browserLanded');
    expect(row.textContent).toContain('https://example.com/inbox');
    expect(row.textContent).toContain('workflow.step.screenshot');
    expect(row.textContent).toContain('2.40s');
  });

  it('a browser step without url/screenshot output stays quiet about them', () => {
    render(<NodeStepRow record={rec({ nodeKind: 'browser', inputSummary: 'browser: no steps' })} />);
    const row = document.querySelector('[data-node-kind="browser"]')!;
    expect(row.textContent).not.toContain('workflow.step.browserLanded');
    expect(row.textContent).not.toContain('workflow.step.screenshot');
  });

  it('a replayed step carries the replay badge — not a rerun button', () => {
    render(<NodeStepRow record={rec({ replayed: true })} />);
    const row = document.querySelector('[data-node-kind="tool"]')!;
    expect(row.textContent).toContain('workflow.step.replayed');
  });

  it('uses the readable input summary as the title, not the node id', () => {
    render(<NodeStepRow record={rec({ inputSummary: 'git tag --list v*' })} />);
    expect(screen.getByTitle('git tag --list v*')).toBeTruthy();
  });
});
