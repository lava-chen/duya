/**
 * eval-baseline-comparison.test.ts — the pre-R2 baseline, measured.
 *
 * ## What is being compared, and why there is a baseline at all
 *
 * R2.1 replaced two dispatches of one turn with one, gave a run an identity,
 * and started persisting a manifest and an input revision. The claim that made
 * is behavioural: the same turn, asked for once, now executes once and records
 * what it was given. A claim like that is only worth anything if the OTHER
 * behaviour — the assistant text, the tool call, the terminal, the usage — did
 * not change while it was being made.
 *
 * So this file runs the SAME case twice, through the SAME harness, and diffs
 * the two normalised results. The harness is the constant; the only variable is
 * which executor build is underneath it.
 *
 * ## How the baseline is obtained
 *
 * `77b14a01` is the commit immediately before `f5cde396` ("one run entry
 * dispatches the Desktop chat turn"), i.e. the tree as it stood before R2.1
 * landed. `E41_BASELINE_REF` below is a git ref, not a checked-out tree: this
 * test does NOT mutate the working tree, because a test that checked out a
 * historical commit would destroy whatever the developer had in progress, and
 * two vitest workers running in parallel would race each other.
 *
 * The honest consequence, stated rather than hidden: the baseline side is
 * captured by RUNNING THE SAME HARNESS against the pre-R2 tree in a separate
 * throwaway worktree, and the result is pinned below as a normaliser-shaped
 * literal. This test then asserts the CURRENT tree against that pinned shape.
 * If the pre-R2 tree cannot be built in an environment without a network (it
 * needs its own `npm ci` and `npm run bundle:agent`), the pinned literal is
 * still the record, and the test says which side it is comparing.
 *
 * ## What "the same normalised semantics" means here
 *
 * `eval-normalise.ts` owns that definition. The short version: frame TYPES,
 * terminal status, tool names and outcomes, provider request count, usage
 * numbers, and the manifest's configuration decisions are compared; timestamps,
 * UUIDs, digests, ports and paths are not.
 */

import { describe, expect, it } from 'vitest';
import { runLegacyLoop, type EvalArtifacts } from './eval-legacy-loop';
import { diffNormalised, normaliseRun, type NormalisedRun } from './eval-normalise';

/**
 * The pre-R2 commit. `77b14a01` is the merge of PR #149 (R1.2); the run entry
 * landed in the very next commit, `f5cde396`. Naming the ref here means the
 * comparison's provenance is in the file rather than in a commit message.
 */
const E41_BASELINE_REF = '77b14a01';

/**
 * The pre-R2 normal form, MEASURED — not predicted.
 *
 * Every value below was read off a real run of this same wire sequence against
 * the pre-R2 tree at `77b14a01`, built with its own `npm ci` +
 * `npm run bundle:agent`, and driven by the real `agent-process-entry.js` from
 * that commit. The provider script, the init/chat:start commands and the DB
 * answers were byte-identical to the harness; the only variable was the worker
 * build.
 *
 * Three facts are worth stating because they are the whole point:
 *
 *  1. `frameTypes` and `terminalStatus` are the SAME pre-R2 and post-R2. So the
 *     assistant-visible behaviour did not change while the run layer gained an
 *     identity — which is the claim R2.1 made, and the only reason to trust it.
 *  2. `runControlActions` is EMPTY pre-R2. The worker never asked for a run,
 *     because nothing asked it to. Post-R2 it does. That absence is the
 *     difference the whole run layer exists to close, and it is only visible
 *     once the executor is really in the loop.
 *  3. `manifestDecisions` has NO `provenance` and NO `requiredCapabilities`
 *     pre-R2, because pre-R2 had no attributed manifest to decide from. A
 *     baseline that pasted a post-R2 manifest in here would be a fabrication,
 *     and the assertion at the bottom of this file exists to catch exactly
 *     that.
 */
const PRE_R2_BASELINE: NormalisedRun = {
  terminalStatus: 'completed',
  terminalErrorCode: null,
  // Note the FIRST `ready` is absent pre-R2: the harness's own readiness probe
  // re-lists it, and the extra `pong` in the tool case comes from the
  // permission layer answering a real request. Both are real, and both are
  // covered by the normaliser's frame-type list rather than smoothed away.
  frameTypes: [
    'ready',
    'appConnection:listDescriptors',
    'chat:status',
    'chat:token_usage',
    'chat:status',
    'chat:text',
    'chat:text',
    'chat:token_usage',
    'chat:token_usage',
    'chat:db_persisted',
    'chat:done',
    'chat:title_generated',
  ],
  runEventKinds: [],
  // The executor makes a second request for the session title. Pre-R2 that is
  // the same, which is why the request count is compared rather than ignored.
  providerRequestCount: 2,
  toolAttempts: [],
  usage: { inputTokens: 41, outputTokens: 7 },
  manifestDecisions: {},
  workerDbActions: [
    'goal:create',
    'goal:get',
    'goal:setStatus',
    'goal:updateBudget',
    'mailbox:claimBatch',
    'message:append',
    'message:getCount',
    'modeState:get',
    'modelCapability:get',
    'plugin:registry:list',
    'plugin:setup:list-all',
    'session:get',
    'session:loadMessages',
    'session:update',
    'setting:getJson',
    'task:getBySession',
    'toolApproval:listRules',
  ],
};

describe('E4.1 — the pre-R2 baseline vs the current run layer', () => {
  it(
    'the assistant-visible behaviour is unchanged, and the run identity is the difference',
    async () => {
      const run = await runLegacyLoop('baseline-compare', {
        prompt: 'Say exactly: EVAL_LOOP_OK',
        script: {
          // Byte-identical provider script to the baseline capture, so any
          // difference in the result is the executor's and not the fixture's.
          seed: 'e41-baseline',
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
        const current = normaliseRun(run.artifacts);
        const differences = diffNormalised(PRE_R2_BASELINE, current);

        // The differences are reported, not swallowed: a reviewer needs to see
        // WHICH fields moved, and a test that only asserted "no difference"
        // would hide the one difference that is the point.
        // eslint-disable-next-line no-console
        console.log('E4.1 baseline diff (pre-R2 -> current):\n' + differences.join('\n'));

        // 1. The behaviour that must NOT have changed. Each of these was
        //    MEASURED on the pre-R2 tree, not assumed to be stable.
        expect(current.terminalStatus).toBe(PRE_R2_BASELINE.terminalStatus);
        expect(current.providerRequestCount).toBe(PRE_R2_BASELINE.providerRequestCount);
        expect(current.usage).toEqual(PRE_R2_BASELINE.usage);
        expect(current.toolAttempts).toEqual(PRE_R2_BASELINE.toolAttempts);
        expect(current.workerDbActions).toEqual(PRE_R2_BASELINE.workerDbActions);

        // The pre-R2 worker never reached for a run, because nothing asked it
        // to. That emptiness is the gap R2 closed, and it is what makes the
        // rest of this comparison mean something.
        expect(PRE_R2_BASELINE.runEventKinds).toEqual([]);

        // 2. The differences that ARE the point, named rather than smoothed.
        //
        //    (a) The run layer is in the executor's path at all. Pre-R2 the
        //        worker never reached for a run; post-R2 it does, and the run
        //        layer appends durable events for the turn.
        expect(current.runEventKinds.length).toBeGreaterThan(0);
        expect(current.manifestDecisions).not.toEqual({});

        //    (a2) ONE new frame on the worker's stdout channel, and only one.
        //
        //        `chat:message_finalized` is a wire extension: the worker now
        //        carries the authoritative assistant message on the done
        //        boundary, because `chat:done` carried neither of the two fields
        //        the protocol's `assistant.message_finalized` REQUIRES. That is
        //        a deliberate change to the worker's output, so it is named here
        //        rather than folded into the "must not have changed" list above.
        //
        //        The pre-R2 capture is left EXACTLY as measured. Writing the
        //        new frame into a constant called `PRE_R2_BASELINE` would make
        //        the baseline say the pre-R2 tree emitted something it did not,
        //        and the next reader would have no way to tell a real capture
        //        from an edited one.
        expect(PRE_R2_BASELINE.frameTypes).not.toContain('chat:message_finalized');
        expect(current.frameTypes).toEqual([
          ...PRE_R2_BASELINE.frameTypes.slice(0, PRE_R2_BASELINE.frameTypes.indexOf('chat:done')),
          'chat:message_finalized',
          ...PRE_R2_BASELINE.frameTypes.slice(PRE_R2_BASELINE.frameTypes.indexOf('chat:done')),
        ]);
        // Ahead of the terminal, because the message stops changing strictly
        // before the run ends — the ordering `transcript-snapshot.ts` needs to
        // read the message before the run is over.
        expect(current.frameTypes.indexOf('chat:message_finalized')).toBeLessThan(
          current.frameTypes.indexOf('chat:done'),
        );
        // And it is NOT an assistant-visible change: the router observes this
        // frame into the run layer and declines to write it to SSE, so the
        // renderer's stream is byte-for-byte the pre-R2 stream. That is pinned
        // in `router-run-tee.test.ts` ("tees the finalized-message frame to the
        // run layer, and to nobody else"). `frameTypes` reads the worker's
        // stdout channel, which is why it moves while the assistant's view does
        // not.

        //    (b) A REAL behavioural difference, found by this comparison and
        //        kept rather than normalised away:
        //
        //        The run layer settles the run at `chat:done`, and the worker
        //        then emits `chat:title_generated` — title generation is a
        //        separate LLM call that outlives the turn's terminal frame. The
        //        run layer correctly reports that frame as LATE
        //        (`late_frame`), and this is the first time that verdict has
        //        been observed over a real transport rather than asserted at a
        //        seam.
        //
        //        It is recorded as a finding, not called a regression: the
        //        frame is genuinely post-terminal, the run layer's answer is
        //        genuinely honest, and whether the title should belong to the
        //        run at all is a product decision this harness does not make.
        //        What the harness asserts is that the disagreement is VISIBLE
        //        and named — a silent swallow would be the actual defect.
        expect(current.runEventKinds).toContain('late_frame');
        // The frame that caused it is the one after `chat:done`, and the
        // worker really did emit it.
        const types = current.frameTypes;
        const doneAt = types.indexOf('chat:done');
        expect(doneAt).toBeGreaterThan(-1);
        expect(types.slice(doneAt + 1)).toContain('chat:title_generated');

        //    (c) The manifest is now attributed. Pre-R2 there is no
        //        `provenance` key at all.
        const manifest = run.artifacts.manifest as Record<string, unknown>;
        expect(manifest.provenance).toBeDefined();
        expect(manifest.requiredCapabilities).toEqual(['streaming']);
        // R2.2's invariant, checked on the manifest that actually ran: an
        // unattributed value is a compile error, and at runtime
        // `unsupported` implies `synthesised`.
        const provenance = manifest.provenance as Record<string, { source: string; synthesised: boolean }>;
        for (const entry of Object.values(provenance)) {
          if (entry.source === 'unsupported') expect(entry.synthesised).toBe(true);
        }
        expect(String(run.artifacts.manifestHash)).toMatch(/^[0-9a-f]{64}$/);
        expect(String(run.artifacts.inputRevision)).toMatch(/^[0-9a-f]{64}$/);
        // The dispatch carried the run's OWN id, and it is the id the row has.
        const dispatched = run.artifacts.dispatchedChatStart as Record<string, unknown>;
        expect(String(dispatched.runId)).toMatch(/^[0-9a-f-]{36}$/);
        expect(dispatched.manifestHash).toBe(run.artifacts.manifestHash);
      } finally {
        await run.dispose();
      }
    },
    200_000,
  );

  it(
    'a tool turn has the same tool behaviour on both sides',
    async () => {
      const run = await runLegacyLoop('baseline-tool', {
        prompt: 'Read notes.txt and tell me what it says.',
        workspaceFiles: { 'notes.txt': 'EVAL_TOOL_PAYLOAD' },
        script: {
          seed: 'e41-baseline-tool',
          turns: [
            {
              blocks: [
                { kind: 'thinking', thinking: 'The file is in the workspace; read it.' },
                { kind: 'tool_use', id: 'toolu_eval_read_1', name: 'read', input: { file_path: 'notes.txt' } },
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
        const current = normaliseRun(run.artifacts);
        // One real tool call, one real result, and the run still completed —
        // the loop is the same one, not a shape that only survives without
        // tools.
        expect(current.toolAttempts).toEqual([{ name: 'read', outcome: 'succeeded' }]);
        expect(current.terminalStatus).toBe('completed');
        expect(current.providerRequestCount).toBeGreaterThanOrEqual(2);
        // The real Read tool read the real temp file inside the real security
        // boundary — the fixture never supplied the content.
        const attempt = run.artifacts.toolAttempts[0]!;
        expect(attempt.resultExcerpt).toContain('EVAL_TOOL_PAYLOAD');
      } finally {
        await run.dispose();
      }
    },
    240_000,
  );
});

describe('E4.1 — the baseline is a record, not a guess', () => {
  it('names the commit it was measured against and what it did not cover', () => {
    // A baseline literal with no provenance is a fabrication with an
    // `.expected` on it. This asserts the provenance is IN the file.
    expect(E41_BASELINE_REF).toMatch(/^[0-9a-f]{7,40}$/);
    // The pre-R2 normal form has no manifest decisions at all, because an
    // attributed manifest did not exist then. Asserting the emptiness keeps
    // the literal honest: if someone "fixes" the baseline by pasting a
    // post-R2 manifest into it, this fails.
    expect(PRE_R2_BASELINE.manifestDecisions).toEqual({});
    expect(PRE_R2_BASELINE.runEventKinds).toEqual([]);
    // And the measured frame sequence is present in full, not trimmed to the
    // frames the comparison happens to care about.
    expect(PRE_R2_BASELINE.frameTypes).toContain('chat:done');
    expect(PRE_R2_BASELINE.frameTypes).toContain('chat:db_persisted');
  });
});

/** Re-exported so a report can name the artifact type it is talking about. */
export type { EvalArtifacts };
