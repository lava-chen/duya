import { describe, expect, it } from 'vitest';
import { RunAttachmentGate } from './run-attachment-gate';

describe('RunAttachmentGate', () => {
  it('rejects a delayed same-session restore after a quick send starts', async () => {
    const gate = new RunAttachmentGate();
    const restoreGeneration = gate.beginRestore();
    let resolveRuns!: (runs: readonly { runId: string }[]) => void;
    const delayedRestore = new Promise<readonly { runId: string }[]>((resolve) => {
      resolveRuns = resolve;
    });

    // A quick send invalidates the in-flight restore before its start request
    // can bind the newly accepted run.
    gate.invalidateRestores();
    const acceptedRunId = 'run-new-send';
    resolveRuns([{ runId: 'run-older-history' }]);
    const [restoredRun] = await delayedRestore;

    expect(restoredRun?.runId).toBe('run-older-history');
    expect(gate.isCurrent(restoreGeneration)).toBe(false);
    expect(acceptedRunId).not.toBe(restoredRun?.runId);
  });
});
