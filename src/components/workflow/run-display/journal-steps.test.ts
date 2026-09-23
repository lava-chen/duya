// journal-steps.test.ts — journal → stage-rail adapter (run history cards).
import { describe, expect, it } from 'vitest';
import {
  artifactRefToName,
  journalStatusToStepStatus,
  journalToArtifacts,
  journalToSteps,
  type JournalRecordLike,
} from './journal-steps';

const JOURNAL: JournalRecordLike[] = [
  { seq: 0, kind: 'phase', nodeId: 'collect', status: 'running', action: '并行盘点变更' },
  {
    seq: 1, kind: 'node_result', nodeId: 'fetch-tags', status: 'succeeded',
    nodeKind: 'tool', action: 'tool:Bash',
  },
  {
    seq: 2, kind: 'node_result', nodeId: 'review', status: 'failed',
    nodeKind: 'agent', action: 'agent:差异审阅员',
  },
  { seq: 3, kind: 'phase', nodeId: 'collect', status: 'succeeded', action: '并行盘点变更' },
  {
    seq: 4, kind: 'artifact', nodeId: 'shot', status: 'succeeded',
    action: 'capture', result: { ref: 'r1/capture-0.png' },
  },
  {
    seq: 5, kind: 'decision', nodeId: 'route', status: 'succeeded',
    nodeKind: 'decision', action: 'decide',
  },
  {
    seq: 6, kind: 'approval', nodeId: 'confirm', status: 'running', action: 'approve',
  },
  { seq: 7, kind: 'phase', nodeId: 'publish', status: 'running', action: '发布' },
  { seq: 8, kind: 'node_result', nodeId: 'tag', status: 'skipped', nodeKind: 'gui', action: 'tag' },
];

describe('journalStatusToStepStatus', () => {
  it('maps succeeded/skipped to success and every terminal non-success to failed', () => {
    expect(journalStatusToStepStatus('succeeded')).toBe('success');
    expect(journalStatusToStepStatus('skipped')).toBe('success');
    expect(journalStatusToStepStatus('failed')).toBe('failed');
    expect(journalStatusToStepStatus('interrupted')).toBe('failed');
    expect(journalStatusToStepStatus('stopped')).toBe('failed');
    expect(journalStatusToStepStatus('cancelled')).toBe('failed');
    expect(journalStatusToStepStatus('running')).toBe('running');
    expect(journalStatusToStepStatus('mystery')).toBe('running');
  });
});

describe('journalToSteps', () => {
  it('cuts phase dividers (start/end pairs dedupe) and maps the work steps', () => {
    const steps = journalToSteps(JOURNAL);
    // 2 dividers (collect deduped) + 5 work steps; artifact record excluded.
    expect(steps).toHaveLength(7);

    const dividers = steps.filter((s) => s.nodeKind === 'phase');
    expect(dividers.map((d) => d.label)).toEqual(['并行盘点变更', '发布']);

    expect(steps[1]).toMatchObject({
      id: 'fetch-tags', nodeKind: 'tool', status: 'success', label: 'tool:Bash',
    });
    expect(steps[2]).toMatchObject({
      id: 'review', nodeKind: 'agent', status: 'failed', label: 'agent:差异审阅员',
    });
    // decision/approval kinds without an explicit nodeKind still map.
    expect(steps[3]).toMatchObject({ id: 'route', nodeKind: 'decision' });
    expect(steps[4]).toMatchObject({ id: 'confirm', nodeKind: 'human', status: 'running' });
    expect(steps[6]).toMatchObject({ id: 'tag', nodeKind: 'gui', status: 'success' });
  });

  it('returns an empty list for an empty journal', () => {
    expect(journalToSteps([])).toEqual([]);
  });

  it('falls back to nodeId for the label when action is absent', () => {
    const steps = journalToSteps([
      { seq: 0, kind: 'node_result', nodeId: 'n1', status: 'succeeded' },
    ]);
    expect(steps[0]).toMatchObject({ label: 'n1', nodeKind: 'noop' });
  });
});

describe('journalToArtifacts', () => {
  it('basenames the ref, dedupes, and skips non-artifact records', () => {
    const artifacts = journalToArtifacts(JOURNAL);
    expect(artifacts).toEqual([{ name: 'capture-0.png' }]);
  });

  it('falls back to action then nodeId when no ref is present', () => {
    expect(
      journalToArtifacts([{ seq: 0, kind: 'artifact', nodeId: 'a', status: 'succeeded', action: '导出报告' }]),
    ).toEqual([{ name: '导出报告' }]);
    expect(
      journalToArtifacts([{ seq: 0, kind: 'artifact', nodeId: 'a2', status: 'succeeded' }]),
    ).toEqual([{ name: 'a2' }]);
  });
});

describe('artifactRefToName', () => {
  it('strips both separator flavours', () => {
    expect(artifactRefToName('r1/capture-0.png')).toBe('capture-0.png');
    expect(artifactRefToName('r1\\capture-0.png')).toBe('capture-0.png');
    expect(artifactRefToName('report.md')).toBe('report.md');
  });
});
