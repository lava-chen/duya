/**
 * gui-runner.test.ts — plan 552 Phase 3 gate: a fake backend + fake
 * decide channel cover ALL EIGHT decide statuses, the deterministic
 * step loop, the suspected_noop ladder, the approval gate, and the
 * externalized screenshot artifacts.
 */

import { describe, it, expect } from 'vitest';
import {
  runGuiNode,
  MemoryArtifactStore,
  Journal,
  MemoryJournalSink,
  type GuiBackendPort,
  type GuiDecidePort,
  type GuiDecideStatus,
  type GuiStep,
  type GuiRunOptions,
} from '../index.js';

function baseOptions(overrides?: Partial<GuiRunOptions>): GuiRunOptions {
  return {
    nodeId: 'fill-erp-form',
    gui: {
      target_app: 'ERP*',
      steps: [{ do: 'capture' }],
      max_actions: 10,
      on_stuck: 'agent',
    },
    scope: { resolve: () => undefined },
    host: {
      runAgent: async () => ({ ok: true }),
      runTool: async () => ({ ok: true }),
      requestApproval: async () => ({ decision: 'approve' as const }),
    },
    journal: new Journal(new MemoryJournalSink()),
    budget: {
      countHostCall: () => {},
      reserveAgent: () => ({ id: 't', kind: 'agent' as const }),
      commit: () => {},
      release: () => {},
    } as never,
    ports: {
      backend: { step: async () => ({ ok: true, effect: 'confirmed' }), capture: async () => ({ base64: 'PNG' }) },
      artifacts: new MemoryArtifactStore(),
    },
    approvalMode: 'await',
    runId: 'r1',
    ...overrides,
  };
}

/** Backend whose verified clicks never change the screen (noop ladder). */
function noopBackend(): GuiBackendPort {
  return {
    step: async () => ({ ok: true, effect: 'suspected_noop' }),
    capture: async () => ({ base64: 'PNG' }),
  };
}

function decidePort(statuses: GuiDecideStatus[]): GuiDecidePort & { calls: number } {
  let i = 0;
  return {
    calls: 0,
    async run() {
      const status = statuses[Math.min(i, statuses.length - 1)];
      i++;
      (this as { calls: number }).calls++;
      return {
        status,
        ...(status === 'ambiguous'
          ? { reason: 'no confident target', candidates: [{ option: '#1 ok', p: 0.4 }, { option: '#2 cancel', p: 0.35 }] }
          : { reason: status }),
      };
    },
  } as never;
}

describe('deterministic step loop', () => {
  it('declared steps run, verify confirmed, screenshots externalized', async () => {
    const journal = new Journal(new MemoryJournalSink());
    const steps: GuiStep[] = [
      { do: 'capture' },
      { do: 'click', element: 'som:3' },
      { do: 'type_text', text: '${params.inv}', element: 'som:4', verify: true },
    ];
    const seen: GuiStep[] = [];
    const options = baseOptions({
      gui: { target_app: 'ERP*', steps, max_actions: 10, on_stuck: 'agent' },
      scope: { resolve: (path) => (path[0] === 'params' && path[1] === 'inv' ? 'INV-7' : undefined) },
      journal,
      ports: {
        backend: {
          step: async (s) => {
            seen.push(s);
            return { ok: true, effect: 'confirmed' };
          },
          capture: async () => ({ base64: 'PNGDATA' }),
        },
        artifacts: new MemoryArtifactStore(),
      },
    });
    const outcome = await runGuiNode(options);
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification).toBe('verified');
    expect(seen).toHaveLength(3);
    expect(seen[2]).toMatchObject({ do: 'type_text', text: 'INV-7', element: 'som:4' });

    const artifactRecords = journal.all().filter((r) => r.kind === 'artifact');
    expect(artifactRecords.length).toBe(3); // capture before each step
    expect(artifactRecords[0].result).toMatchObject({ kind: 'screenshot', step: 0 });
    const ref = (artifactRecords[0].result as { ref: string }).ref;
    const bytes = await (options.ports.artifacts as MemoryArtifactStore).get(ref);
    expect(bytes?.toString()).toBe('PNGDATA');
  });

  it('step failure fails the node with a classified error', async () => {
    const outcome = await runGuiNode(
      baseOptions({
        ports: {
          backend: { step: async () => ({ ok: false, error: 'APP_BLOCKED' }), capture: async () => ({ base64: null }) },
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.errorClass).toBe('approval_denied'); // refusals-as-policy
  });

  it('suspected_noop twice trips the ladder → on_stuck: agent → decide done', async () => {
    const decide = decidePort(['done']);
    const outcome = await runGuiNode(
      baseOptions({
        gui: {
          target_app: 'ERP*',
          steps: [{ do: 'click', element: 'som:1', verify: true }, { do: 'click', element: 'som:1', verify: true }],
          on_stuck: 'agent',
        },
        ports: { backend: noopBackend(), artifacts: new MemoryArtifactStore(), decide },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(decide.calls).toBe(1);
  });

  it('on_stuck: fail ends locally without a decide call', async () => {
    const decide = decidePort(['done']);
    const outcome = await runGuiNode(
      baseOptions({
        gui: {
          target_app: 'ERP*',
          steps: [{ do: 'click', element: 'som:1', verify: true }, { do: 'click', element: 'som:1', verify: true }],
          on_stuck: 'fail',
        },
        ports: { backend: noopBackend(), artifacts: new MemoryArtifactStore(), decide },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(decide.calls).toBe(0);
  });
});

// ─── the eight decide statuses (551 controller contract) ───

describe('decide status contract — all eight states', () => {
  async function runWith(status: GuiDecideStatus, approvalMode: 'await' | 'suspend' = 'await') {
    const decide = decidePort([status]);
    const options = baseOptions({
      gui: {
        target_app: 'ERP*',
        steps: [{ do: 'click', element: 'som:1', verify: true }, { do: 'click', element: 'som:1', verify: true }],
        on_stuck: 'agent',
      },
      ports: { backend: noopBackend(), artifacts: new MemoryArtifactStore(), decide },
      approvalMode,
    });
    const outcome = await runGuiNode(options);
    return { outcome, decide };
  }

  it('done → succeeded (verified)', async () => {
    const { outcome } = await runWith('done');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification).toBe('verified');
  });

  it('likely_done → succeeded but unconfirmed (fresh-eyes annotation)', async () => {
    const { outcome } = await runWith('likely_done');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification).toBe('unconfirmed');
  });

  it('needs_confirmation → approval gate (await approve)', async () => {
    const { outcome } = await runWith('needs_confirmation');
    expect(outcome.status).toBe('succeeded');
    expect(outcome.output).toMatchObject({ approved: true, gated: true });
  });

  it('needs_confirmation → suspend mode throws SuspensionSignal', async () => {
    const decide = decidePort(['needs_confirmation']);
    const options = baseOptions({
      gui: {
        target_app: 'ERP*',
        steps: [{ do: 'click', element: 'som:1', verify: true }, { do: 'click', element: 'som:1', verify: true }],
        on_stuck: 'agent',
      },
      ports: { backend: noopBackend(), artifacts: new MemoryArtifactStore(), decide },
      approvalMode: 'suspend',
    });
    await expect(runGuiNode(options)).rejects.toMatchObject({ name: 'SuspensionSignal' });
  });

  it('error → failed', async () => {
    const { outcome } = await runWith('error');
    expect(outcome.status).toBe('failed');
    expect(outcome.errorClass).toBe('tool_error');
  });

  it('stuck → failed via ladder (agent already tried)', async () => {
    const { outcome } = await runWith('stuck');
    expect(outcome.status).toBe('failed');
  });

  it('ambiguous → failed with candidates (distribution, not a guess)', async () => {
    const { outcome } = await runWith('ambiguous');
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('#2 cancel@0.35');
  });

  it('blocked → failed (approval_denied class)', async () => {
    const { outcome } = await runWith('blocked');
    expect(outcome.status).toBe('failed');
    expect(outcome.errorClass).toBe('approval_denied');
  });

  it('max_actions → failed', async () => {
    const { outcome } = await runWith('max_actions');
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('action cap');
  });

  it('decide results are journaled as decisions (never re-asked on resume)', async () => {
    const journal = new Journal(new MemoryJournalSink());
    const decide = decidePort(['done']);
    const options = baseOptions({
      gui: {
        target_app: 'ERP*',
        steps: [{ do: 'click', element: 'som:1', verify: true }, { do: 'click', element: 'som:1', verify: true }],
        on_stuck: 'agent',
      },
      ports: { backend: noopBackend(), artifacts: new MemoryArtifactStore(), decide },
      journal,
    });
    await runGuiNode(options);
    await runGuiNode(options); // same journal → cache hit, decide NOT re-asked
    expect(decide.calls).toBe(1);
  });
});

describe('dry-run', () => {
  it('plans the gui node without touching the backend', async () => {
    let stepped = 0;
    const outcome = await runGuiNode(
      baseOptions({
        dryRun: true,
        ports: {
          backend: {
            step: async () => {
              stepped++;
              return { ok: true };
            },
            capture: async () => ({ base64: 'X' }),
          },
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(stepped).toBe(0);
    expect(outcome.output).toMatchObject({ dryRun: true, steps: 1 });
  });
});
