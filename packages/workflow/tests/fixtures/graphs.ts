import type { WorkflowDef } from '../../src/schema.js';

export const concurrencyRetuneGraph: WorkflowDef = {
  name: 'scheduler-fixture',
  description: 'Two ready roots followed by a dependent node',
  phases: [{
    phase: 'main',
    title: 'Main',
    nodes: [
      { id: 'node-a', tool: 'a' },
      { id: 'node-b', tool: 'b' },
      { id: 'node-c', tool: 'c', when: 'node-a.succeeded == true' },
    ],
  }],
};

export const failureIsolationGraph: WorkflowDef = {
  name: 'failure-branches',
  description: 'Keep successful branches when a separate branch fails',
  phases: [
    {
      phase: 'main',
      title: 'Main',
      nodes: [
        { id: 'fragile', tool: 'fragile', on_error: 'fail' },
        { id: 'fragile-child', tool: 'must-not-run', input: { value: '${fragile.output}' } },
        { id: 'fragile-grandchild', noop: true, when: 'fragile-child.succeeded == true' },
        { id: 'steady', tool: 'steady' },
        { id: 'steady-child', tool: 'steady-child', input: { value: '${steady.output}' } },
      ],
    },
    {
      phase: 'later',
      title: 'Later',
      nodes: [
        { id: 'later-dependent', tool: 'must-not-run-later', input: { value: '${fragile.output}' } },
        { id: 'later-steady', tool: 'later-steady', input: { value: '${steady-child.output}' } },
      ],
    },
  ],
};

export const stoppedRecoveryGraph: WorkflowDef = {
  name: 'stopped-recovery',
  description: 'Reuse completed work and retry an orphaned node',
  phases: [{
    phase: 'main',
    title: 'Main',
    nodes: [
      { id: 'cached', tool: 'cached-tool' },
      { id: 'fresh', tool: 'fresh-tool' },
      { id: 'tail', tool: 'tail-tool', input: { value: '${fresh.output}' } },
    ],
  }],
};
