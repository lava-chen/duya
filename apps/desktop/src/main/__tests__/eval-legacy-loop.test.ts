/**
 * Plan 587 E4.1 — the real legacy executor, closed loop, with an offline
 * provider.
 *
 * ## Why this file exists
 *
 * Everything the plan built before E4.1 was proven against in-process doubles.
 * `reference-run-closed-loop.test.ts` composes the real router normaliser, the
 * real orchestrator, the real controller, the real ledger, the real
 * translator, the real Control Plane and real SQLite — and then writes the
 * worker's frames itself, from a `FRAMES` constant. That boundary is drawn at
 * the executor, so the one component that actually talks to a model, resolves
 * tools, asks for permission and decides a turn is complete was never in the
 * loop. Every claim about the executor in R2.1–T3.3 was therefore a claim
 * about a seam.
 *
 * This file closes that. The worker is the REAL process
 * (`agent-process-entry.ts`, forked from the same bundle the product forks),
 * driven by the REAL `chat:start` on its REAL stdin, calling the REAL provider
 * adapter against a real loopback HTTP server. Nothing in the run's path is
 * hand-written.
 *
 * ## What is proven here, and what is not
 *
 * Proven by this file: the real executor emits real frames under a real
 * manifest binding; the manifest hash is recomputed and accepted; the run
 * reaches a real durable terminal on real SQLite; usage is the executor's own;
 * a real tool call is attempted and its real result recorded.
 *
 * NOT proven, and not claimed: the Electron renderer/preload boundary, the
 * packaged bundle, and any live provider. Those need a provider key or a
 * packaged Electron and are named in the artifact metadata as `notCovered`.
 */

import { describe, expect, it } from 'vitest';
import { runLegacyLoop, AGENT_BUNDLE, type EvalRunResult } from './eval-legacy-loop';
import { normaliseRun } from './eval-normalise';

jest: {
  // The real worker forks a process, loads a 5 MB bundle and makes HTTP
  // requests. The default 10s vitest timeout is not a budget for that.
}

describe('E4.1 — the real executor, closed loop', () => {
  it(
    'runs the real worker process through a real manifest into a real durable run',
    async () => {
      const run: EvalRunResult = await runLegacyLoop('text-only', {
        prompt: 'Say exactly: EVAL_LOOP_OK',
        script: {
          seed: 'e41-text-only',
          turns: [
            {
              blocks: [{ kind: 'text', text: 'EVAL_LOOP_OK' }],
              stopReason: 'end_turn',
              inputTokens: 41,
              outputTokens: 7,
            },
          ],
        },
        maxTurns: 3,
        timeoutMs: 150_000,
      });

      try {
        const { artifacts, terminalStatus } = run;

        // --- The real executor ran, and it is the real executor ---------------
        //
        // Not an assertion that the right function was called: the frames the
        // run layer consumed came off a real child's stdout, and the assistant
        // text below is the TEXT THE MODEL SENT over the wire. The offline
        // provider only ever wrote `EVAL_LOOP_OK`; nothing in the executor's
        // source contains that string.
        const text = artifacts.transcript.filter(
          (frame): frame is { type: string; content: string } =>
            (frame as { type?: string }).type === 'chat:text'
            && typeof (frame as { content?: unknown }).content === 'string',
        );
        expect(text.map((f) => f.content).join('')).toBe('EVAL_LOOP_OK');

        // The provider was reached over a real socket with the real protocol.
        expect(artifacts.providerRequests.length).toBeGreaterThanOrEqual(1);
        const first = artifacts.providerRequests[0] as Record<string, unknown>;
        expect(first.model).toBe('eval-offline-model');
        // A real request carries the executor's real assembled prompt and tool
        // surface, which only the real adapter builds.
        expect(Number(first.toolCount)).toBeGreaterThan(0);
        expect((first.messageRoles as string[]).length).toBeGreaterThan(0);

        // --- The manifest binding was real and was CHECKED -------------------
        expect(artifacts.manifestHash).toMatch(/^[0-9a-f]{64}$/);
        expect(artifacts.inputRevision).toMatch(/^[0-9a-f]{64}$/);
        const manifest = artifacts.manifest as Record<string, unknown>;
        // R2.1: the Control Plane resolved the model, and the required
        // capability named is the one Desktop chat turns actually need.
        expect((manifest.requiredCapabilities as string[]) ?? []).toContain('streaming');
        expect((manifest.agent as Record<string, unknown>).model).toBe('eval-offline-model');
        // R2.2: provenance is closed and attributed; `unsupported` implies
        // synthesised, so no unattributed value can appear.
        const provenance = manifest.provenance as Record<string, { source: string; synthesised: boolean }>;
        expect(Object.keys(provenance).length).toBeGreaterThan(0);
        for (const entry of Object.values(provenance)) {
          if (entry.source === 'unsupported') expect(entry.synthesised).toBe(true);
        }

        // --- The run reached a real durable terminal on real SQLite ----------
        expect(terminalStatus).toBe('completed');
        expect(artifacts.runEvents.length).toBeGreaterThan(0);

        // --- Usage is the executor's own accumulation, not a copy -----------
        //
        // Compared for EQUALITY against the tokens the offline provider
        // declared, not merely for being non-zero. A mutation that made the
        // provider report a fabricated 4242 passed an earlier
        // `toBeGreaterThan(0)` version of this assertion, which is why it is
        // written this way: the fixture declares the number, the real adapter
        // must extract exactly that number, and any other value means the SSE
        // was parsed wrongly or the run layer accumulated wrongly.
        expect(artifacts.usage.inputTokens).toBe(41);
        expect(artifacts.usage.outputTokens).toBe(7);
        expect(artifacts.usage.frames).toBeGreaterThan(0);

        // --- Redaction actually applied --------------------------------------
        // The load-bearing form of this is in `eval-redaction.test.ts`, which
        // asserts that a KNOWN secret IS changed — a whole-artifact scan
        // cannot distinguish a redaction from a value that was never captured
        // in the first place, and an earlier version of this assertion was
        // vacuous for exactly that reason. What is asserted here is the
        // weaker, but still real, artifact-level property.
        const serialised = JSON.stringify(artifacts);
        expect(serialised).not.toContain('sk-eval-offline-REDACT-ME');
        expect(serialised).not.toMatch(/\bsk-[A-Za-z0-9]{12,}/);

        // --- Metadata is a record, not a decoration --------------------------
        expect(artifacts.metadata.head).toMatch(/^[0-9a-f]{40}$/);
        expect(artifacts.metadata.agentBundle.sha256).toMatch(/^[0-9a-f]{64}$/);
        expect(artifacts.metadata.configuration.providerBaseUrlIsLoopback).toBe(true);
        expect(artifacts.metadata.configuration.sqlitePathIsTemp).toBe(true);
        expect(artifacts.metadata.boundary.realExecutorProcess).toBe(true);
        // The limits are named, not quietly absent.
        expect(artifacts.metadata.boundary.notCovered.join(' ')).toMatch(/Electron renderer/);
      } finally {
        await run.dispose();
      }
    },
    200_000,
  );

  it(
    'a real tool call is attempted by the real executor and recorded with its real result',
    async () => {
      const run: EvalRunResult = await runLegacyLoop('tool-call', {
        prompt: 'Read notes.txt and tell me what it says.',
        workspaceFiles: { 'notes.txt': 'EVAL_TOOL_PAYLOAD' },
        script: {
          seed: 'e41-tool-call',
          turns: [
            {
              blocks: [
                { kind: 'thinking', thinking: 'The file is in the workspace; read it.' },
                {
                  kind: 'tool_use',
                  id: 'toolu_eval_read_1',
                  // The REAL tool name, read off the real registry. An earlier
                  // draft of this case said `Read`, and the executor refused it
                  // with "No such tool available: Read" — which is the tool
                  // boundary working: a fixture that invents a tool name gets
                  // an honest error, not a silent pass.
                  name: 'read',
                  input: { file_path: 'notes.txt' },
                },
              ],
              stopReason: 'tool_use',
              inputTokens: 55,
              outputTokens: 31,
            },
            {
              blocks: [{ kind: 'text', text: 'It says EVAL_TOOL_PAYLOAD.' }],
              stopReason: 'end_turn',
              inputTokens: 88,
              outputTokens: 12,
            },
          ],
        },
        maxTurns: 4,
        timeoutMs: 180_000,
      });

      try {
        const { artifacts } = run;
        const traceTypes = artifacts.protocolTrace.map((entry) => `${entry.channel}:${entry.type}`);

        // The executor made MORE THAN ONE provider request, which can only
        // happen if a tool result was fed back into the conversation. That is
        // the loop, observed rather than asserted.
        expect(artifacts.providerRequests.length).toBeGreaterThanOrEqual(2);

        // A real thinking block came through the real adapter.
        expect(traceTypes.some((t) => t.endsWith('chat:thinking'))).toBe(true);

        // A real tool_use and its real tool_result.
        expect(artifacts.toolAttempts.length).toBe(1);
        const attempt = artifacts.toolAttempts[0]!;
        expect(attempt.name).toBe('read');
        expect(attempt.outcome).toBe('succeeded');
        // The result came from the real Read tool reading the real temp file.
        expect(attempt.resultExcerpt).toContain('EVAL_TOOL_PAYLOAD');
        expect(attempt.error).toBe(false);

        // The run still reached a durable terminal after the tool round trip.
        expect(run.terminalStatus).toBe('completed');
      } finally {
        await run.dispose();
      }
    },
    240_000,
  );

  it(
    'a tampered manifest is refused by the real worker, and the provider is never reached',
    async () => {
      // The positive path first, and in the same file: without it, a refusal
      // assertion passes for the wrong reason whenever the harness is simply
      // broken. Only once the loop is shown to reach the model does a "did not
      // reach the model" mean anything.
      const healthy = await runLegacyLoop('manifest-healthy', {
        prompt: 'This turn must reach the model.',
        script: {
          seed: 'e41-healthy',
          turns: [{ blocks: [{ kind: 'text', text: 'REACHED' }], inputTokens: 5, outputTokens: 3 }],
        },
        maxTurns: 2,
        timeoutMs: 150_000,
      });
      let healthyProviderRequests = 0;
      let healthyText = '';
      try {
        healthyProviderRequests = healthy.artifacts.providerRequests.length;
        healthyText = healthy.artifacts.transcript
          .map((frame) => (frame as { content?: unknown }).content)
          .filter((c): c is string => typeof c === 'string')
          .join('');
        expect(healthyProviderRequests).toBeGreaterThanOrEqual(1);
        expect(healthyText).toContain('REACHED');
      } finally {
        await healthy.dispose();
      }

      // Now the refusal. The harness re-runs the same case with the manifest
      // hash the worker recomputes deliberately mismatched, which is exactly
      // the R2.2 refusal path: the digest a receiver can recompute over what
      // it received is a CHECK, and this is the check firing.
      const refused = await runLegacyLoop('manifest-tampered', {
        prompt: 'This turn must NOT reach the model.',
        script: {
          seed: 'e41-tampered',
          turns: [{ blocks: [{ kind: 'text', text: 'MUST_NOT_APPEAR' }], inputTokens: 5, outputTokens: 3 }],
        },
        maxTurns: 2,
        timeoutMs: 150_000,
        tamperManifestHash: true,
      });
      try {
        // The run layer still recorded the run — a refusal is a NAMED terminal,
        // not a run that silently never answered (R2.2's whole point).
        expect(refused.terminalStatus).toBe('failed');
        const terminal = refused.artifacts.terminal as Record<string, unknown>;
        const error = (terminal.handleResult as Record<string, unknown> | undefined)?.error as
          | Record<string, unknown>
          | undefined;
        // The refusal is NAMED end to end, in the protocol's own vocabulary.
        //
        // Two REAL defects were on this path, and neither was visible to a seam
        // test — because every seam test CONSTRUCTED the frame rather than
        // receiving it from a running worker:
        //
        //   1. the worker sent the refusal on `error:` while every other
        //      `chat:error` in that file, and the `AgentErrorEvent` contract,
        //      use `message:` — so the router's normaliser read an absent field
        //      and substituted 'Unknown error';
        //   2. even with the message, no `code` was sent, so
        //      `classifyErrorCode` fell through to `internal` and the precise
        //      verdict survived only inside a sentence.
        //
        // The harness had a bug of its own here too: it fed the run layer the
        // RAW worker frame instead of the router's normalised one, producing
        // the same `internal / unknown error` symptom for a different reason.
        // Fixed by going through `normalizeAndObserve`, which is the call
        // production makes per frame.
        expect(error?.code).toBe('manifest_mismatch');
        expect(String(error?.message ?? '')).toMatch(/manifest_hash_mismatch/);

        // And the provider was never reached: the refusal happened ABOVE the
        // model call. Counted on the real server, so "never reached" is a
        // measurement rather than an absence in a log.
        expect(refused.artifacts.providerRequests).toHaveLength(0);
        const text = refused.artifacts.transcript
          .map((frame) => (frame as { content?: unknown }).content)
          .filter((c): c is string => typeof c === 'string')
          .join('');
        expect(text).not.toContain('MUST_NOT_APPEAR');

        // The refusal is visible in the protocol trace as the worker's own
        // `chat:error`, naming the code — not a silent hang.
        const errors = refused.artifacts.protocolTrace.filter((e) => e.type === 'chat:error');
        expect(errors.length).toBeGreaterThan(0);
        expect(JSON.stringify(errors)).toMatch(/run refused/);
      } finally {
        await refused.dispose();
      }
    },
    320_000,
  );
});

describe('E4.1 — normalisation for the pre-R2 comparison', () => {
  it(
    'collapses only timestamps, random ids and volatile counters',
    async () => {
      const run: EvalRunResult = await runLegacyLoop('normalise', {
        prompt: 'hello',
        script: {
          seed: 'e41-normalise',
          turns: [{ blocks: [{ kind: 'text', text: 'hi' }], inputTokens: 3, outputTokens: 2 }],
        },
        maxTurns: 2,
        timeoutMs: 150_000,
      });

      try {
        const normalised = normaliseRun(run.artifacts);
        // The normal form is a pure function of behaviour: no wall-clock field
        // and no random id survives it.
        const serialised = JSON.stringify(normalised);
        expect(serialised).not.toMatch(/\b1[6-9]\d{11}\b/);
        expect(serialised).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
        // But the behaviour is all still there.
        expect(normalised.terminalStatus).toBe('completed');
        expect(normalised.frameTypes).toContain('chat:text');
        expect(normalised.toolAttempts).toHaveLength(0);
      } finally {
        await run.dispose();
      }
    },
    200_000,
  );
});

describe('E4.1 — the executor bundle the loop forks is the product bundle', () => {
  it('resolves the same path worker-manager.ts prefers', () => {
    // The product prefers the esbuild bundle over the tsc dist for a specific
    // reason (ESM reaching plugin-core `src`). The harness must fork the SAME
    // one, or "the real executor" means a different artifact than production
    // runs.
    expect(AGENT_BUNDLE.replace(/\\/g, '/')).toMatch(
      /packages\/agent\/bundle\/agent-process-entry\.js$/,
    );
  });
});
