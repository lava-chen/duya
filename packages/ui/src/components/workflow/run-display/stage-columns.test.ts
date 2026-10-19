// stage-columns.test.ts — the pure stage-cut model behind the run card's
// 阶段轨. The runner folds wf.phase records into the step list as
// nodeKind:'phase' dividers; these tests pin the segmentation, the chip
// aggregation vocabulary and the honest n/m counting (plan 560 §6.2/§7.2).

import { describe, expect, it } from 'vitest';
import { agentChipName, buildStageColumns, type RunChipView } from './stage-columns';
import type { RunStepView } from '@/types/stream';

function step(id: string, label: string, status: RunStepView['status'], nodeKind?: RunStepView['nodeKind']): RunStepView {
  return { id, label, status, ...(nodeKind !== undefined ? { nodeKind } : {}) };
}

describe('agentChipName', () => {
  it('strips the agent: prefix', () => {
    expect(agentChipName('agent:项目解读员')).toBe('项目解读员');
  });

  it('passes labels without the prefix through', () => {
    expect(agentChipName('Reviewer')).toBe('Reviewer');
    expect(agentChipName(undefined)).toBe('');
  });
});

describe('buildStageColumns', () => {
  it('puts steps before any divider into the implicit column', () => {
    const columns = buildStageColumns([
      step('a', 'tool:Bash', 'success', 'tool'),
      step('b', 'agent:Scout', 'success', 'agent'),
    ]);
    expect(columns).toHaveLength(1);
    const [implicit] = columns;
    expect(implicit!.implicit).toBe(true);
    expect(implicit!.name).toBe('');
    expect(implicit!.done).toBe(2);
    expect(implicit!.total).toBe(2);
    expect(implicit!.chips.map((c) => c.kind)).toEqual(['script', 'agent']);
  });

  it('cuts columns at phase dividers in step order', () => {
    const columns = buildStageColumns([
      step('p0', 'prepare', 'running', 'phase'),
      step('a', 'tool:Bash', 'success', 'tool'),
      step('p1', '并行摸底', 'running', 'phase'),
      step('b1', 'agent:项目解读员', 'failed', 'agent'),
      step('b2', 'agent:结构分析员', 'success', 'agent'),
      step('p2', '汇总', 'running', 'phase'),
      step('c', 'agent:报告撰写员', 'success', 'agent'),
    ]);
    expect(columns.map((c) => c.name)).toEqual(['prepare', '并行摸底', '汇总']);
    // The run opened with a divider, so nothing is implicit here.
    expect(columns[0]!.implicit).toBe(false);
    expect(columns[1]!.chips.map((c) => c.name)).toEqual(['项目解读员', '结构分析员']);
    // Failed step marks the column, and the divider's own fake 'running'
    // status must not leak into counts.
    expect(columns[1]!.status).toBe('failed');
    expect(columns[1]!.done).toBe(1);
    expect(columns[1]!.total).toBe(2);
    expect(columns[2]!.status).toBe('success');
  });

  it('aggregates all tool/gui/noop work into one script chip per column', () => {
    const columns = buildStageColumns([
      step('t1', 'tool:Bash', 'success', 'tool'),
      step('g1', 'gui:app', 'success', 'gui'),
      step('n1', 'log', 'success', 'noop'),
      step('a', 'agent:Scout', 'success', 'agent'),
    ]);
    const [implicit] = columns;
    const scriptChips = implicit!.chips.filter((c) => c.kind === 'script');
    expect(scriptChips).toHaveLength(1);
    expect(implicit!.chips).toHaveLength(2);
    // Counts stay step-accurate even though the chips aggregate.
    expect(implicit!.total).toBe(4);
  });

  it('a failed tool step surfaces through the aggregated script chip', () => {
    const columns = buildStageColumns([
      step('t1', 'tool:Bash', 'success', 'tool'),
      step('t2', 'tool:Bash', 'failed', 'tool'),
    ]);
    const [implicit] = columns;
    const chip = implicit!.chips.find((c) => c.kind === 'script') as RunChipView;
    expect(chip.status).toBe('failed');
    expect(implicit!.status).toBe('failed');
    expect(implicit!.done).toBe(1);
  });

  it('returns no columns for an empty step list', () => {
    expect(buildStageColumns([])).toEqual([]);
  });

  it('keeps a divider-only run renderable as an empty stage', () => {
    const columns = buildStageColumns([step('p', 'Stage A', 'running', 'phase')]);
    expect(columns).toHaveLength(1);
    expect(columns[0]!.name).toBe('Stage A');
    expect(columns[0]!.total).toBe(0);
    expect(columns[0]!.chips).toEqual([]);
  });
});
