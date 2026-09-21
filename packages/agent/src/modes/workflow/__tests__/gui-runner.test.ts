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

// ─── plan 556 Phase 4: recorded som refs through the element-matcher ───

/** Recorder annotation for one `som:1` click on a "Submit" button. */
function recorderAnnotation(overrides?: { name?: string; point?: { x: number; y: number } }) {
  return {
    source: 'recorder' as const,
    app: 'chrome',
    windowTitle: 'Invoice portal',
    som: {
      'som:1': {
        ts: 1,
        element: {
          source: 'uia-probe' as const,
          name: overrides?.name ?? 'Submit',
          controlType: 'Button',
        },
        point: overrides?.point ?? { x: 105, y: 105 },
      },
    },
  };
}

/** Backend whose capture publishes a fixed fresh SOM index space. */
function somBackend(elements: unknown, seen: GuiStep[] = []): GuiBackendPort {
  return {
    step: async (s) => {
      seen.push(s);
      return { ok: true, effect: 'confirmed' };
    },
    capture: async () => ({ base64: 'PNG', width: 1000, height: 1000, elements }),
  };
}

describe('recorded element matching (plan 556 phase 4)', () => {
  it('L1 rewrites the recorded ref to the fresh SOM index and stays verified', async () => {
    const seen: GuiStep[] = [];
    const journal = new Journal(new MemoryJournalSink());
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'capture' }, { do: 'click', element: 'som:1' }], on_stuck: 'agent' },
        annotation: recorderAnnotation(),
        journal,
        ports: {
          backend: somBackend(
            [
              { index: 1, bbox: { x: 0, y: 0, w: 30, h: 30 }, label: 'Cancel' },
              { index: 5, bbox: { x: 95, y: 98, w: 40, h: 20 }, label: 'Submit', axSource: 'uia' },
            ],
            seen,
          ),
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification).toBe('verified');
    expect(seen[1]).toMatchObject({ do: 'click', element: 'som:5' });

    const evidence = journal.all().filter((r) => r.kind === 'node_result' && r.action === 'match');
    expect(evidence).toHaveLength(1);
    expect(evidence[0]!.verification).toBe('verified');
    expect(evidence[0]!.result).toMatchObject({ match: { ref: 'som:1', somIndex: 5, confidence: 'exact', layer: 'L1' } });
  });

  it('L3 routes the step through on_stuck: agent and downgrades to unconfirmed', async () => {
    const decide = decidePort(['done']);
    const journal = new Journal(new MemoryJournalSink());
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'capture' }, { do: 'click', element: 'som:1' }], on_stuck: 'agent' },
        annotation: recorderAnnotation({ name: 'Renamed by hand' }),
        journal,
        ports: {
          backend: somBackend([{ index: 5, bbox: { x: 900, y: 900, w: 10, h: 10 }, label: 'Something else' }]),
          artifacts: new MemoryArtifactStore(),
          decide,
        },
      }),
    );
    expect(decide.calls).toBe(1);
    expect(outcome.status).toBe('succeeded');
    // The agent recovered the step, but not exactly as recorded.
    expect(outcome.verification).toBe('unconfirmed');
    const evidence = journal.all().find((r) => r.action === 'match');
    expect(evidence?.result).toMatchObject({ match: { confidence: 'agent-fallback', layer: 'none', somIndex: null } });
  });

  it('L3 with on_stuck: fail fails the node instead of guessing', async () => {
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'click', element: 'som:1' }], on_stuck: 'fail' },
        annotation: recorderAnnotation({ name: 'Renamed by hand' }),
        ports: {
          backend: somBackend([{ index: 5, bbox: { x: 900, y: 900, w: 10, h: 10 }, label: 'Something else' }]),
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('failed');
    expect(outcome.error).toContain('element-matcher');
  });

  it('L2 accepts a positional match but marks the node unconfirmed', async () => {
    const seen: GuiStep[] = [];
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'capture' }, { do: 'click', element: 'som:1' }], on_stuck: 'agent' },
        annotation: recorderAnnotation({ name: 'Label changed' }),
        ports: {
          // Point (105,105) lands inside this bbox — L2 "contains".
          backend: somBackend([{ index: 4, bbox: { x: 95, y: 95, w: 40, h: 40 }, label: 'Whatever' }], seen),
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification).toBe('unconfirmed');
    expect(seen[1]).toMatchObject({ element: 'som:4' });
  });

  it('a fresh capture re-publishes the index space between steps', async () => {
    const seen: GuiStep[] = [];
    let call = 0;
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'capture' }, { do: 'click', element: 'som:1' }], on_stuck: 'agent' },
        annotation: recorderAnnotation(),
        ports: {
          backend: {
            step: async (s) => {
              seen.push(s);
              return { ok: true, effect: 'confirmed' };
            },
            capture: async () => {
              call++;
              // First capture has the button at index 2 — irrelevant; by
              // the time the click runs the SECOND capture owns index 9.
              return {
                base64: 'PNG',
                width: 1000,
                height: 1000,
                elements: [
                  { index: call === 1 ? 2 : 9, bbox: { x: 100, y: 100, w: 30, h: 30 }, label: 'Submit', axSource: 'uia' },
                ],
              };
            },
          },
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(seen[1]).toMatchObject({ element: 'som:9' });
  });

  it('refs without recorder provenance keep their legacy meaning', async () => {
    const seen: GuiStep[] = [];
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'capture' }, { do: 'click', element: 'som:3' }], on_stuck: 'agent' },
        ports: {
          backend: somBackend([{ index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'Submit' }], seen),
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(outcome.verification).toBe('verified');
    expect(seen[1]).toMatchObject({ element: 'som:3' });
  });

  it('a foreign annotation shape never runs the matcher', async () => {
    const seen: GuiStep[] = [];
    const outcome = await runGuiNode(
      baseOptions({
        gui: { target_app: 'chrome', steps: [{ do: 'capture' }, { do: 'click', element: 'som:3' }], on_stuck: 'agent' },
        annotation: { something: 'else' },
        ports: {
          backend: somBackend([{ index: 1, bbox: { x: 0, y: 0, w: 10, h: 10 }, label: 'Submit' }], seen),
          artifacts: new MemoryArtifactStore(),
        },
      }),
    );
    expect(outcome.status).toBe('succeeded');
    expect(seen[1]).toMatchObject({ element: 'som:3' });
  });
});
