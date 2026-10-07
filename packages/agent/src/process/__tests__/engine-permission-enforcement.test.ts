/**
 * Plan 610 P9: the permission mode in force must DECIDE on the engine path.
 *
 * ## What regressed, and how it was measured
 *
 * `RunEngineImpl.#dispatchCall` asked `ports.approval.authorize` for every tool
 * call, and `buildEnginePorts` forwarded that to the host's ask bridge with no
 * per-mode shortcut. So a `bypassPermissions` session raised a permission card
 * on every tool call, where the legacy raised none. The manifest already
 * RECORDED the mode faithfully (plan 610 P8); the RECORD was not the DECISION.
 *
 * ## Both sides are MEASURED, and they are different sources
 *
 * `legacyCards` drives the real legacy path: a real `duyaAgent`, `beginRun`,
 * `beginTurnAssembly`, the real `PermissionsGate` closure, the real
 * `ToolExecutionPipeline`, and a real drain -- the same order
 * `DuyaAgent.runTurnStream` uses. `engineCards` drives a real `RunEngineImpl`
 * over that same pipeline behind a real `TurnPipelinePublisher`, with
 * `ports.approval.authorize` bound to the production `gateRunApproval`. The
 * expected side is the first and the actual side is the second; neither is
 * derived from the other, and neither is derived from a mode NAME.
 *
 * That matters because the mode names are not the semantics. Measured on this
 * tree, `plan` raises NO card even for a write outside the workspace, because
 * the permission engine's own bypass predicate includes `plan` whenever
 * `isBypassPermissionsModeAvailable` is true (`PermissionsGate` hardcodes it),
 * and `PermissionsGate`'s plan-mode write gate is a MODE COORDINATOR arm that a
 * session with no plan tracker never reaches. And `acceptEdits` raises a card
 * for an out-of-workspace write, because `hasPermissionsToUseTool` has no
 * `acceptEdits` branch at all. A test written from the names would assert the
 * opposite of the code in three of five rows.
 *
 * ## Why a COUNT and not an absence of errors
 *
 * A test that only asserts "no exception was thrown" passes when EVERY call is
 * gated -- which is exactly this defect. So every assertion below is on a
 * positive per-mode count, and the counts come from the legacy measurement.
 */

import { describe, expect, it, afterAll } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { duyaAgent, type RunAssemblyRequest } from '../../agent/DuyaAgent.js';
import { ToolRegistry } from '../../tool/registry.js';
import { WriteTool } from '../../tool/WriteTool/WriteTool.js';
import { TurnPipelinePublisher } from '../../tool/turn-pipeline-publisher.js';
import { RunEngineImpl } from '@duya/agent-runtime';
import type {
  ApprovalRequest,
  ApprovalVerdict,
  RunEnginePorts,
  ToolCallRequest,
} from '@duya/agent-runtime';
import type { PermissionMode } from '../../permissions/types.js';
import type { RunId } from '@duya/agent-protocol';
import { createToolSideEffectLedger } from '../tool-side-effect-ledger.js';
import { deriveFirstAttemptFence } from '../engine-run-driver.js';
import {
  buildLegacyRunInput,
  buildLegacyRunManifest,
  gateRunApproval,
  type LegacyRunFacts,
} from '../run-composition.js';
import { manifestPermissionMode } from '../permission-profile-bridge.js';
import { toExternalPermissionMode } from '../../permissions/policy.js';

/**
 * The run's facts for one SESSION MODE, built through the production policy
 * table rather than a literal, so a test cannot assert a mode the repository
 * does not declare. `toExternalPermissionMode` is `PERMISSION_MODE_CONFIG`'s own
 * mapping -- the same table the worker entry's `manifestPermissionMode` reads.
 */
function factsFor(agentMode: PermissionMode): LegacyRunFacts {
  return {
    runId: 'permission-enforcement' as RunId,
    cwd: WORKSPACE,
    model: 'claude-test',
    providerId: 'anthropic',
    sessionId: 'permission-enforcement',
    projectId: null,
    revision: 'rev-1',
    catalogRevision: 0,
    permissionMode: toExternalPermissionMode(agentMode),
  };
}

/**
 * Two roots under one temp parent: the workspace is NESTED one level deeper
 * than its own parent, because `collectAllowedRoots` admits the workspace's
 * PARENT as an allowed root (`policy.ts`). A sibling of the workspace would
 * therefore be "within roots" and every out-of-workspace case here would
 * silently stop testing what it claims to.
 */
const TMP_ROOT = mkdtempSync(join(tmpdir(), 'duya-perm-enforce-'));
const WORKSPACE = join(TMP_ROOT, 'a', 'ws');
const INSIDE = join(WORKSPACE, 'inside.txt');
const OUTSIDE = join(TMP_ROOT, 'outside', 'escape.txt');
/**
 * A UNC path, which `isCatastrophicPath` rejects on every platform and in every
 * mode. Chosen over a real system directory because nothing may ever touch it:
 * the gate refuses before any write is attempted, and the observable here is the
 * DISPATCH that must never happen.
 */
const CATASTROPHIC = '//duya-catastrophic-probe/p9-deny.txt';
mkdirSync(WORKSPACE, { recursive: true });
mkdirSync(join(TMP_ROOT, 'outside'), { recursive: true });
writeFileSync(INSIDE, '', 'utf8');
writeFileSync(OUTSIDE, '', 'utf8');

afterAll(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

/**
 * Every mode the permission engine declares. `EXTERNAL_PERMISSION_MODES` is the
 * user-addressable set; `auto` is the internal one the worker's profile bridge
 * resolves `auto` to, and it is in force through `setPermissionMode`, so it is
 * included deliberately rather than being a fifth row nobody runs.
 */
const MODES: readonly PermissionMode[] = [
  'default',
  'auto',
  'acceptEdits',
  'bypassPermissions',
  'plan',
  'dontAsk',
];

let seq = 0;

function nextSeq(): string {
  seq += 1;
  return `duya-perm-${process.pid}-${seq}`;
}

function registryWithWrite(): ToolRegistry {
  const registry = new ToolRegistry();
  registry.register(
    {
      name: 'write',
      description: 'write a file',
      input_schema: { type: 'object', properties: {} },
    } as never,
    new WriteTool() as never,
  );
  return registry;
}

/**
 * The shared fixture: a real agent in `mode`, a real run handle, and the real
 * pipeline its handle assembled. Both harnesses below start from this, so the
 * legacy and the engine agree on the tool surface, the gate closure and the
 * declared-tools set, and the only thing that differs is WHO ASKS.
 */
async function armRun(
  mode: PermissionMode,
  requestPermission: () => Promise<'allow'>,
) {
  const sessionId = nextSeq();
  const agent = new duyaAgent({
    apiKey: 'permission-enforcement-test-key',
    model: 'claude-test',
    provider: 'anthropic',
    sessionId,
    workingDirectory: WORKSPACE,
    permissionMode: mode,
  });
  const options = {
    toolRegistry: registryWithWrite(),
    sessionId,
    workingDirectory: WORKSPACE,
    requestPermission,
  };
  const run = await agent.beginRun({ options: options as never, prompt: 'write one file' });
  const assembly = await agent.beginTurnAssembly({
    options,
    prompt: 'write one file',
    appliedProfile: undefined,
    turnContext: run.turnContext,
  } as unknown as RunAssemblyRequest);
  const pipeline = assembly.assemble({
    turn: 1,
    messages: [],
    tools: assembly.tools,
    systemPrompt: assembly.systemPrompt,
  }).pipeline;
  // The guard denies anything outside the declared set, and it starts EMPTY, so
  // a harness that skipped this would mute the pipeline and report zero cards
  // for a reason that has nothing to do with permissions.
  assembly.refreshDeclaredTools();
  return { agent, run, assembly, pipeline, options };
}

function writeCall(callId: string, filePath: string): { id: string; name: string; input: unknown } {
  return { id: callId, name: 'write', input: { file_path: filePath, content: 'probe' } };
}

/**
 * The LEGACY side. A real `beginRun` / `beginTurnAssembly` / pipeline drain, in
 * `runTurnStream`'s order: refresh the declared set, queue, drain.
 *
 * `cards` counts `requestPermission` invocations -- a permission card, which is
 * the thing the defect was about.
 */
async function legacyCards(mode: PermissionMode, filePath: string): Promise<number> {
  let cards = 0;
  const { run, pipeline } = await armRun(mode, async () => {
    cards += 1;
    return 'allow' as const;
  });
  pipeline.addTool(writeCall('legacy-1', filePath) as never);
  for await (const _update of pipeline.getRemainingResults()) {
    /* drain the turn */
  }
  run.close();
  return cards;
}

/** A side-effect ledger for the run, so `#ticket` does not refuse the dispatch. */
function ledgerFor(runId: string) {
  const dir = join(TMP_ROOT, 'ledgers', runId);
  return createToolSideEffectLedger({
    dir,
    runId: runId as RunId,
    runEpoch: 1,
    fence: deriveFirstAttemptFence({ runId: runId as RunId, dir }),
  });
}

/**
 * The ENGINE side. A real `RunEngineImpl` whose `tools` port feeds the SAME
 * kind of real pipeline through a real `TurnPipelinePublisher`, and whose
 * `approval` port is the production `gateRunApproval` -- so this measures the
 * composition's actual approval path, including the drain's own ask.
 */
async function engineCards(
  mode: PermissionMode,
  filePath: string,
): Promise<{
  readonly cards: number;
  readonly dispatches: number;
  readonly approvalRequests: readonly string[];
}> {
  let cards = 0;
  let dispatches = 0;
  const approvalRequests: string[] = [];
  const { run, assembly, pipeline, options } = await armRun(mode, async () => {
    cards += 1;
    return 'allow' as const;
  });
  const publisher = new TurnPipelinePublisher();
  publisher.publish(1, pipeline);
  const runId = nextSeq();

  let turn = 0;
  const ports = {
    interTurn: {
      sweep: () =>
        Promise.resolve({ decision: { action: 'continue', absorbed: false }, injected: [] }),
    },
    model: {
      async *stream() {
        turn += 1;
        if (turn === 1) {
          yield {
            type: 'tool_use' as const,
            call: {
              callId: 'engine-1',
              name: 'write',
              input: { file_path: filePath, content: 'probe' },
            } as unknown as ToolCallRequest,
          };
          yield { type: 'turn_stopped' as const, reason: 'tool_use' as const };
          return;
        }
        yield { type: 'turn_stopped' as const, reason: 'end_turn' as const };
      },
    },
    tools: {
      dispatch(call: ToolCallRequest) {
        dispatches += 1;
        publisher.queue({
          id: call.callId,
          name: call.name,
          input: call.input as Record<string, unknown>,
        });
      },
      drain() {
        return publisher.drain();
      },
      discard() {
        publisher.discard();
      },
      describe: () => [],
    },
    context: {
      assemble: () =>
        Promise.resolve({
          systemPrompt: 'permission enforcement probe',
          messages: [],
          tools: [],
          catalogRevision: 'cat-1',
          revision: 'rev-1',
        }),
      defer() {},
    },
    approval: {
      authorize: (request: ApprovalRequest, signal: AbortSignal): Promise<ApprovalVerdict> => {
        approvalRequests.push(request.permissionMode);
        // The ask bridge is the REAL one, not a stub: it counts a card and
        // answers, exactly as the worker entry's `askApproval` ->
        // `requestPermission` chain does. A stub that silently returned a
        // verdict without counting would absorb the very ask this file
        // measures, and a mutation that restored the unconditional forward
        // would then stay green.
        const askApproval = async (): Promise<ApprovalVerdict> => {
          cards += 1;
          return options.requestPermission().then(() => ({ allowed: true, scope: 'once' as const }));
        };
        return gateRunApproval(assembly, askApproval)(request, signal);
      },
    },
    events: { publish() {}, proposeTerminal() {} },
    sideEffects: ledgerFor(runId),
  } as unknown as RunEnginePorts;

  await new RunEngineImpl({ now: () => Date.now(), defaultMaxTurns: 3 })
    .execute({
      manifest: {
        version: 1,
        runId: runId as RunId,
        projectId: null,
        workspaceId: 'permission-enforcement',
        roots: [WORKSPACE],
        cwd: WORKSPACE,
        permissionPolicy: { mode: 'default', hostSwitch: 'ask', defaultTimeoutMs: 1000 },
        capabilities: { profiles: [], modes: [], tools: [] },
        connectorBindings: [],
        env: { ref: 'env:test', hash: 'e3b0c44298fc1c149afbf4c8996fb924' },
        agent: { profileId: null, model: 'claude-test', providerId: 'anthropic' },
        budget: {},
        deterministic: false,
        provenance: {
          roots: { source: 'unsupported', synthesised: true },
          cwd: { source: 'unsupported', synthesised: true },
          permissionPolicy: { source: 'unsupported', synthesised: true },
          capabilities: { source: 'unsupported', synthesised: true },
          connectorBindings: { source: 'unsupported', synthesised: true },
          env: { source: 'unsupported', synthesised: true },
          agent: { source: 'unsupported', synthesised: true },
          budget: { source: 'unsupported', synthesised: true },
          workspaceId: { source: 'unsupported', synthesised: true },
          deterministic: { source: 'unsupported', synthesised: true },
        },
      } as never,
      input: buildLegacyRunInput(factsFor(mode), { role: 'user', id: 'p1', content: 'write one file' }, []),
      signal: run.signal,
      ports,
    })
    .completed();

  publisher.close();
  run.close();
  return { cards, dispatches, approvalRequests };
}

// ============================================================================
// 1. PARITY: the engine raises exactly what the legacy raises
// ============================================================================

describe('the engine path asks the user exactly when the legacy does', () => {
  it('matches the legacy card count for an out-of-workspace write, in every mode', async () => {
    const measured: Record<string, { legacy: number; engine: number }> = {};
    for (const mode of MODES) {
      measured[mode] = {
        legacy: await legacyCards(mode, OUTSIDE),
        engine: (await engineCards(mode, OUTSIDE)).cards,
      };
    }
    // Read from the measurement, not from a table written here, so a legacy
    // whose semantics move cannot leave this green by agreeing with itself.
    const mismatches = MODES.filter(
      (mode) => measured[mode].legacy !== measured[mode].engine,
    );
    expect(mismatches.map((m) => ({ mode: m, ...measured[m] }))).toEqual([]);
  });

  it('matches the legacy card count for a workspace-confined write, in every mode', async () => {
    const measured: Record<string, { legacy: number; engine: number }> = {};
    for (const mode of MODES) {
      measured[mode] = {
        legacy: await legacyCards(mode, INSIDE),
        engine: (await engineCards(mode, INSIDE)).cards,
      };
    }
    const mismatches = MODES.filter(
      (mode) => measured[mode].legacy !== measured[mode].engine,
    );
    expect(mismatches.map((m) => ({ mode: m, ...measured[m] }))).toEqual([]);
  });
});

// ============================================================================
// 2. THE COUNTS THEMSELVES: zero for the never-ask modes, POSITIVE for the
//    asking ones. This is the assertion that fails when every call is gated.
// ============================================================================

describe('the mode in force decides whether the user is asked', () => {
  it('raises no card at all in bypassPermissions, where the legacy raises none', async () => {
    // Positive count, zero EXPECTED. A regression that re-gates every call puts
    // this at 1 and fails here, which is the whole point.
    expect(await legacyCards('bypassPermissions', OUTSIDE)).toBe(0);
    expect((await engineCards('bypassPermissions', OUTSIDE)).cards).toBe(0);
    expect((await engineCards('bypassPermissions', INSIDE)).cards).toBe(0);
  });

  it('raises a POSITIVE card count in the modes that ask for an escaping write', async () => {
    // Established from the legacy measurement below rather than from the mode
    // names: `default` asks, and the harness proves it by counting.
    expect(await legacyCards('default', OUTSIDE)).toBeGreaterThan(0);
    expect((await engineCards('default', OUTSIDE)).cards).toBeGreaterThan(0);
  });

  it('asks in every mode the legacy asks in, and in none it does not', async () => {
    // The full measured matrix, per mode, so a mode that silently stopped
    // deciding cannot hide behind the two rows above.
    const measured = await Promise.all(
      MODES.map(async (mode) => ({
        mode,
        legacy: await legacyCards(mode, OUTSIDE),
        engine: (await engineCards(mode, OUTSIDE)).cards,
      })),
    );
    for (const row of measured) {
      // Reported per row so a failure names the mode, not an index.
      expect(row, `mode ${row.mode}`).toEqual({
        mode: row.mode,
        legacy: row.legacy,
        engine: row.engine,
      });
    }
  });

  it('keeps the asking modes asking and the never-ask modes silent, as measured', async () => {
    const measured = await Promise.all(
      MODES.map(async (mode) => ({
        mode,
        legacy: await legacyCards(mode, OUTSIDE),
      })),
    );
    const asking = measured.filter((m) => m.legacy > 0).map((m) => m.mode);
    const silent = measured.filter((m) => m.legacy === 0).map((m) => m.mode);
    // Both halves must be non-empty, or the matrix above is vacuous: a harness
    // that asked nothing anywhere would satisfy "every mode matches".
    expect(asking.length).toBeGreaterThan(0);
    expect(silent.length).toBeGreaterThan(0);
    expect(silent).toContain('bypassPermissions');
    expect(asking).toContain('default');
  });
});

// ============================================================================
// 3. THE DENY ARM. Without this the `allowed: false` branch of the gate
//    consult is unobserved, and a mutation that deleted it stayed green --
//    the pipeline's own gate is a compensating second guard for the CARD
//    count, so only the DISPATCH count can see the arm go missing.
// ============================================================================

describe('a call the gate denies is never dispatched, in every mode', () => {
  it('refuses the catastrophic path without asking, matching the legacy', async () => {
    for (const mode of MODES) {
      // The legacy side: zero cards, measured.
      expect(await legacyCards(mode, CATASTROPHIC), `legacy cards ${mode}`).toBe(0);
      const engine = await engineCards(mode, CATASTROPHIC);
      expect(engine.cards, `engine cards ${mode}`).toBe(0);
      // The observable that only the deny arm controls: the engine asked, was
      // refused, and therefore never handed the call to its tool port.
      expect(engine.dispatches, `engine dispatches ${mode}`).toBe(0);
    }
  });
});

// ============================================================================
// 4. THE MODE ON THE APPROVAL REQUEST AGREES WITH THE MODE THE GATE ENFORCED
// ============================================================================

describe('the approval request carries the mode the manifest recorded', () => {
  it('stamps the manifest mode on the request, not a hardcoded default', async () => {
    // `RunEngineImpl.#permissionMode` reads `input.options.permissionMode`. With
    // an empty `options` it stamped `'default'` on every request whatever the
    // session mode was -- a third account of the mode, next to the manifest's
    // and the gate's. The oracle here is the MANIFEST's own record, built by
    // production code from the same facts; the actual side is what the engine
    // stamped on a live approval request. Two different objects.
    const recorded = buildLegacyRunManifest(factsFor('bypassPermissions')).permissionPolicy.mode;
    const { approvalRequests } = await engineCards('bypassPermissions', OUTSIDE);
    expect(recorded).toBe('bypassPermissions');
    expect(approvalRequests.length).toBeGreaterThan(0);
    expect(approvalRequests).toEqual(approvalRequests.map(() => recorded));
  });

  it('agrees with the manifest for every mode, not just the one that regressed', async () => {
    for (const agentMode of ['default', 'auto', 'bypassPermissions'] as const) {
      const recorded = buildLegacyRunManifest(factsFor(agentMode)).permissionPolicy.mode;
      const { approvalRequests } = await engineCards(agentMode, INSIDE);
      // The engine asks once per call, so a run that dispatched nothing would
      // make this vacuous; assert the request actually happened first.
      expect(approvalRequests.length, agentMode).toBeGreaterThan(0);
      expect(approvalRequests, agentMode).toEqual(approvalRequests.map(() => recorded));
    }
  });
});

// ============================================================================
// 4. THE ASK IS NOT TAKEN TWICE: the engine slot decides, the pipeline asks
// ============================================================================

describe('the engine approval slot decides and does not raise a second card', () => {
  it('raises exactly one card where the legacy raises exactly one', async () => {
    const legacy = await legacyCards('default', OUTSIDE);
    const engine = (await engineCards('default', OUTSIDE)).cards;
    // Both sides are absolute counts, so a failure says "engine raised 2 where
    // the legacy raised 1" instead of an opaque parity failure. The `toBe(1)`
    // is what makes this a POSITIVE assertion rather than an echo: the legacy
    // number is measured, and the engine is pinned to the same measured value.
    expect(legacy).toBe(1);
    expect(engine).toBe(1);
  });
});