/**
 * Plan 600 S2 cutover, stage 1: the live `chat:start` path drives a turn ONCE.
 *
 * ## Plan 610 D3 -- the inversion this file needs AFTER the flip, stated now
 * because the state it guards still has TWO drivers
 *
 * The flip deletes the legacy generator from `agent-process-entry.ts` and makes
 * `RunEngineImpl` the only driver. Doing that WITHOUT editing this file turns it
 * RED, which is correct: the assertion `legacyDrivers === 1` is a claim about the
 * pre-flip state, and post-flip the truth is zero. So this file is not
 * "already correct for the next slice" -- it is a file the flip is expected to
 * break, and the break is the signal that the inversion is still owed.
 *
 * It is deliberately NOT inverted in this slice, because the assertion it would
 * replace describes a state that does not exist yet. Inverting now would make
 * the branch red for a state it does not have.
 *
 * **WHAT THE INVERTED FORM MUST ASSERT**, exactly, so the next slice does not
 * re-derive it:
 *
 *  1. `legacyDrivers === 0` -- the entry no longer names `agent.streamChat(`.
 *  2. `engineDrivers === 1` -- the entry constructs exactly one
 *     `new RunEngineImpl(`, and it is inside the `chat:start` handler rather
 *     than reachable only from a helper.
 *  3. `legacyDrivers + engineDrivers === 1` -- THE PAIR. This is the whole point
 *     and it survives the inversion unchanged in form: the file's stated reason
 *     for using a count at all is that "a gate which says no loop here is
 *     satisfied by a file with no turn at all". A state with ZERO drivers must
 *     fail, and this sum is what makes it fail. An inversion that dropped it and
 *     asserted only the two counts separately would reintroduce exactly the
 *     vacuity the header argues against.
 *  4. The `emptyModelStream` / `emptyToolDrain` / `runWithEngine` /
 *     `proposeTerminal` phantom-removal rows stay as they are. After the flip
 *     they read differently -- `proposeTerminal` and `buildEnginePorts` become
 *     the LEGITIMATE bindings the entry needs, so those two counts must move
 *     from 0 to 1 and `occurrences()` must be re-read rather than assumed. That
 *     is the second mechanical edit, and it is where a naive inversion goes
 *     wrong: a row that says "the entry binds no engine ports" becomes false the
 *     moment the engine drives, and leaving it would pin the PRE-flip shape
 *     under a post-flip name.
 *  5. `still runs the generator` (`const eventGen = agent.streamChat(` and
 *     `for await (const event of eventGen)`) is DELETED rather than inverted.
 *     There is no generator to run, and keeping the row with its count set to
 *     zero would assert that the entry contains a driver it is forbidden to
 *     contain.
 *
 * **WHERE THE CURRENT FORM WOULD HAVE TO CHANGE**, by symbol, so the diff is
 * mechanical:
 *
 *  - `occurrences(/agent\.streamChat\s*\(/)` at the top of
 *    `has exactly one driver, and it is the legacy generator` -- the two
 *    expectations change, the three lines of arithmetic do not.
 *  - `drives no other model stream from this entry`: the count moves 1 -> 0 and
 *    its comment must change with it, because "a file with no driver at all
 *    fails the previous test" is no longer the reason for expecting 0.
 *  - `binds no model port that yields nothing`: the `emptyModelStream` and
 *    `emptyToolDrain` arms stay at 0; the `buildEnginePorts` arm moves 0 -> 1
 *    with a comment saying the entry now OWNS that composition.
 *  - `proposes no terminal from the worker entry`: `proposeTerminal` moves
 *    0 -> 1. Its current comment ("the proposal was logged and discarded")
 *    becomes false and must be replaced, not kept.
 *  - `the stop press has exactly one cancellation path`: `agent.interrupt()` is
 *    the legacy's abort route. After the flip the entry must abort through the
 *    engine's own signal, so this row needs a decision, not a count change --
 *    it is the one place where "invert the polarity" is the wrong move, because
 *    the cancellation MECHANISM changes rather than its side.
 *  - The last two describes (the three `if (chatInProgress)` guards and the two
 *    `lastInterruptTime` writes) are hand-off UI state and are expected to
 *    survive; re-measure rather than trust, since the entry loses ~5000 lines
 *    of loop-adjacent code in the flip.
 *  - The G7/G8 block at the bottom is the one that goes GREEN: `owners` changes
 *    from `['agent/DuyaAgent.ts']` to `[]`, and `sites` from length 1 to 0,
 *    which is the flag the flip exists to turn. It measures the REAL gate module
 *    and needs no edit beyond its expectations.
 *
 * ## What this file is
 *
 * The evidence that the phantom run is gone, and that what remains on the live
 * path is the single legacy driver. It is a SOURCE-SHAPE guard, and that is a
 * deliberate choice rather than a shortcut: the thing being guarded is a
 * composition, the composition lives in a 5000-line subprocess entry that calls
 * `main()` at import time (so it cannot be imported by a test at all), and the
 * property is "how many things start a turn here", which is a fact about the
 * source rather than about a value any test can observe at run time.
 *
 * `boundary-gates.mjs` guards the same file for the same reason with the same
 * technique, so this is the established precedent in this repository rather than
 * a new invention. Where this file differs from that gate is that it asserts a
 * COUNT and not a shape: a gate that says "no loop here" is satisfied by a file
 * with no turn at all, which is a different (and worse) program.
 *
 * ## Why a count, and what makes it non-trivial
 *
 * The property is `exactly one driver`. Asserting `not.toContain` for each
 * candidate would be satisfied by a file where every driver was deleted, and
 * those negative assertions are exactly the ones that proved insensitive to
 * deletion in this repository before. So each count below is read from a real
 * source and compared against a real number:
 *
 *  - the number of engine constructions is 0, and
 *  - the number of legacy `agent.streamChat(` calls is 1.
 *
 * The pair is the assertion. A file that deleted the legacy driver would fail
 * the second; a file that re-added the engine would fail the first. Neither
 * passes by being empty, which is what makes this stronger than the negative
 * form.
 *
 * ## What this file does NOT prove
 *
 * It does not prove the turn WORKS. It cannot: that needs a provider key and an
 * Electron renderer, neither of which exists in this test environment. It does
 * not prove G7/G8 reached zero -- see the last describe block, which measures
 * that directly against the real gate module and records that the answer is
 * still no.
 *
 * It also does not prove the phantom run was HARMLESS while it lived. It was
 * not, and the comment left at the call site says so with the reason.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// The source under test
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ENTRY = path.join(HERE, '..', 'agent-process-entry.ts');
const DUYA = path.join(HERE, '..', '..', 'agent', 'DuyaAgent.ts');
const SOURCE = fs.readFileSync(ENTRY, 'utf8');

/**
 * Count non-comment occurrences of a pattern.
 *
 * Comments are stripped FIRST because both removed symbols are named in the
 * comments that document why they were removed. Counting naively would report
 * `activeEngineRun: 1` and `emptyModelStream: 1` for a file that contains
 * neither binding -- a false positive that would make this guard look satisfied
 * for the wrong reason, which is the mirror image of the false-negative problem
 * the positive counts exist to avoid.
 *
 * `code()` below re-derives the same stripped text and the tests assert on
 * counts taken from it, so the stripping and the assertion cannot disagree.
 */
function code(): string {
  return SOURCE.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const CODE = code();

function occurrences(pattern: RegExp, text: string = CODE): number {
  return (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ============================================================================
// 1. The phantom run is gone
// ============================================================================

describe('the live chat:start path no longer runs a phantom engine run', () => {
  it('constructs no run engine at all', () => {
    // The phantom run was `runWithEngine(...)`, which constructed a
    // `RunEngineImpl` and executed it. Both halves are counted, because
    // removing only the constructor would leave a function that builds ports and
    // never runs them -- still a second account of the turn, just a quieter one.
    expect(occurrences(/new RunEngineImpl\s*\(/)).toBe(0);
    expect(occurrences(/\brunWithEngine\b/)).toBe(0);
  });

  it('binds no model port that yields nothing', () => {
    // `openModelStream: () => emptyModelStream()` is what made the run a
    // phantom: the engine asked the provider zero times, saw no frames, and
    // ended `failed` on `sawFrame === false` (`run-engine.ts:584`).
    expect(occurrences(/\bemptyModelStream\b/)).toBe(0);
    expect(occurrences(/\bemptyToolDrain\b/)).toBe(0);
    // And no surviving port builder that could stand in for it.
    expect(occurrences(/\bbuildEnginePorts\b/)).toBe(0);
  });

  it('proposes no terminal from the worker entry', () => {
    // The phantom proposed `failed` once per `chat:start`. `RunSession.settle`
    // is the single writer of a real terminal, so the proposal was logged and
    // discarded -- a second account of a run that never spoke. Counted rather
    // than pattern-matched on the log string, so a renamed log line cannot pass.
    expect(occurrences(/\bproposeTerminal\b/)).toBe(0);
  });
});

// ============================================================================
// 2. Exactly one driver remains
// ============================================================================

describe('the legacy generator is the only driver of a turn on the live path', () => {
  it('has exactly one driver, and it is the legacy generator', () => {
    // THE assertion of this file. Read as a pair, and the pair is why it is not
    // vacuous:
    //
    //   drivers === 1  AND  the one is `agent.streamChat(`
    //
    // Deleting the driver gives 0 and fails. Re-adding any engine gives >= 2 and
    // fails. Only exactly-one-legacy passes.
    const engineDrivers = occurrences(/new RunEngineImpl\s*\(/);
    const legacyDrivers = occurrences(/agent\.streamChat\s*\(/);

    expect(legacyDrivers).toBe(1);
    expect(engineDrivers).toBe(0);
    expect(legacyDrivers + engineDrivers).toBe(1);
  });

  it('drives no other model stream from this entry', () => {
    // `agent.streamChat(` is the only `.streamChat(` left in the file, so no
    // second caller can appear by another route -- a helper that reached the
    // client directly would be caught here. The count is 1 rather than 0
    // because the driver itself matches; a file with no driver at all fails the
    // previous test.
    expect(occurrences(/\.streamChat\s*\(/)).toBe(1);
  });

  it('still runs the generator, rather than merely having removed the engine', () => {
    // The inverse of the phantom removal, and the assertion that catches the
    // worst outcome of this commit: a file where BOTH drivers are gone, which
    // would pass every count above that only checks for absence.
    // It is positive on purpose. The call is still consumed by a `for await`
    // over `eventGen` in the same handler, so the generator is not merely
    // constructed and dropped.
    expect(occurrences(/const eventGen = agent\.streamChat\s*\(/)).toBe(1);
    expect(occurrences(/for await \(const event of eventGen\)/)).toBe(1);
  });
});

// ============================================================================
// 3. Cancellation has exactly one path
// ============================================================================

describe('the stop press has exactly one cancellation path', () => {
  it('calls agent.interrupt() and reaches no run engine', () => {
    // `agent.interrupt()` is the path that WORKS: it fires
    // `this.abortController`, which is the signal `runTurnStream` hands the
    // client, so the in-flight provider request is aborted rather than
    // orphaned.
    //
    // The engine branch it replaced was provably inert: it stopped the phantom
    // run, whose controller no provider request was reading. Two callers, one of
    // which cancelled nothing.
    expect(occurrences(/agent\.interrupt\s*\(\)/)).toBe(1);
    expect(occurrences(/\bactiveEngineRun\b/)).toBe(0);
  });

  it('keeps the guard that stops a run that is not in progress', () => {
    // Removing a path must not remove the surrounding behaviour. Three distinct
    // `if (chatInProgress)` guards exist in this file and all three are counted
    // rather than one, because a count of 1 would be satisfied by any two of
    // them being deleted. `:4345` is the interrupt branch this commit edited;
    // the other two are the re-entrancy guards at `:3672` and the block-reset
    // path, which this commit must not have disturbed.
    //
    // MEASURED, not guessed: the first draft of this assertion expected 1 and
    // the run reported 3, which is what prompted counting all three.
    expect(occurrences(/if \(chatInProgress\)/)).toBe(3);
    // The double-press / idle branch below the in-progress one is what clears
    // the command queue, and it is reached only because that branch still
    // `break`s. Both writes of `lastInterruptTime` are that branch's.
    expect(occurrences(/lastInterruptTime = now;/)).toBe(2);
  });
});

// ============================================================================
// 4. The seams the cutover still needs are intact
// ============================================================================

describe('the seams the next stage binds were not collaterally removed', () => {
  it('still constructs and closes the per-run turn pipeline publisher', () => {
    // `TurnPipelinePublisher` is the handle a `ToolPort` binds to. It is
    // retained deliberately even though nothing publishes into it today: the
    // cutover needs it, and deleting it would remove inventory the next stage
    // would otherwise have to rebuild. It is asserted POSITIVELY (constructed,
    // handed to `streamChat`, closed) so that "the seam is still here" is a
    // measured fact rather than an absence nothing could contradict.
    expect(occurrences(/new TurnPipelinePublisher\(\)/)).toBe(1);
    expect(occurrences(/turnPipelines,/)).toBe(1);
    expect(occurrences(/turnPipelines\.close\(\)/)).toBe(1);
  });

  it('left the engine package itself untouched', () => {
    // The removal is a composition change, not a deletion of the engine. If this
    // ever fails, a later stage started unwiring the runtime rather than the
    // worker, which is the opposite of the staged order this commit follows.
    const engine = fs.readFileSync(
      path.join(HERE, '..', '..', '..', '..', 'agent-runtime', 'src', 'engine', 'run-engine.ts'),
      'utf8',
    );
    // The loop is still the engine's, and still self-contained: the `for` and
    // the unconditional `#streamModel` that made binding the leg a race.
    //
    // The `requestEpoch` argument is part of the pinned call and is NOT
    // incidental: the epoch is what makes a retried request distinguishable
    // from the request it replaced (`run-engine.ts:2193`). An earlier revision
    // of this assertion pinned the two-argument call and had been failing ever
    // since that parameter landed -- it was reading a shape the file stopped
    // having while the property it guards (the engine drives its own model leg,
    // inside its own loop) had not changed.
    // The loop header is pinned as "a `for` over turns starting at one", not as
    // its exact spelling. Plan 610 D1 added a control-command guard to the
    // condition -- `for (let turn = 1; command === null; turn++)`, so a run
    // already answered by the product performs zero iterations -- which is the
    // FIRST time this assertion's subject has legitimately changed. The property
    // it guards is unchanged by that: the loop is still the engine's own, and
    // the `#streamModel` call below is still unconditional within it, so the
    // model leg is still driven from inside the loop rather than unbound and
    // re-bound from outside.
    //
    // This is the same correction the comment below records for the two-argument
    // `#streamModel` call: the pinned SHAPE drifted while the guarded property
    // did not. Widening the pattern to the loop's identity (`turn = 1` and
    // `turn++`) keeps it able to fail -- an engine that deleted its loop, or
    // moved it into a helper, no longer matches.
    expect(engine).toMatch(/for \(let turn = 1;[^)]*; turn\+\+\)/);
    expect(engine).toMatch(
      /const outcome = await this\.#streamModel\(ctx, modelRequest, requestEpoch\)/,
    );
  });
});

// ============================================================================
// 5. What G7/G8 actually measure -- and why this commit does not zero them
// ============================================================================

describe('G7/G8 are measured against the real gate module, not a copy of it', () => {
  /**
   * The real predicates, imported from the gate that runs in CI. A hand-typed
   * copy of these three regexes would drift from the thing it claims to measure,
   * and the drift would be invisible: a regex that stopped matching would make
   * this file's numbers look BETTER, not worse.
   *
   * `stripComments` is imported from the gate's own sibling module, and for the
   * SAME reason. The gate feeds `isTurnLoopModule` STRIPPED text
   * (`boundary-gates.mjs:52`, applied at `:830`), so a walk that hands the
   * predicate raw source measures a different program than the one CI runs.
   * That is not hypothetical: it is what this file did, and it is why the walk
   * below reported `[]` for `agent/DuyaAgent.ts` -- a module G7 names. The
   * predicate's tokeniser skips strings but NOT comments, so prose braces in
   * that module's thousands of lines of documentation unbalanced the block scan
   * and truncated the enclosing loop body, which is precisely the direction that
   * makes a gate untrustworthy.
   */
  async function loadGates() {
    const dir = path.join(HERE, '..', '..', '..', '..', '..', 'scripts', 'architecture');
    const gates = (await import(
      /* @vite-ignore */ path.join(dir, 'boundary-gates.mjs'),
    )) as typeof import('../../../../scripts/architecture/boundary-gates.mjs');
    const strip = (await import(
      /* @vite-ignore */ path.join(dir, 'strip-comments.mjs'),
    )) as typeof import('../../../../scripts/architecture/strip-comments.mjs');
    return { ...gates, stripComments: strip.stripComments };
  }

  it('still reports the turn loop in DuyaAgent.ts, and for the right reason', () => {
    // The claim this test used to make described a predicate the gate no longer
    // has. `TURN_LOOP_SHAPE` is `{ legs: 2 }` (asserted in the next test) and
    // `isTurnLoopModule` is `turnLoopSites(src).length > 0` -- a loop body that
    // drives two `for await` streams to exhaustion. `TURN_LOOP_SHAPE.modelStream`
    // is `undefined`, so the old `.modelStream.test(line)` THREW rather than
    // measuring anything: it was reading a key step A1 had removed, not the loop
    // it was written to watch.
    //
    // What survives of the original intent is the part that was load-bearing: the
    // gate must be RED because the loop EXISTS, never because a marker was
    // deleted. So this measures the real predicate against the real module and
    // requires exactly one loop body carrying both legs.
    //
    // The reported line is MATCHED against the `while` in the same text rather
    // than hard-coded. Pinning a literal would make this file go red the next
    // time anything above the loop is edited -- a failure that says nothing about
    // the property being guarded.
    //
    // The header is matched by its SHAPE -- a `while` whose condition negates an
    // aborted-signal read -- rather than by WHICH expression supplies the
    // controller. That relaxation was forced by plan 610 P4 and is not a
    // weakening: before it, the regex named `this.abortController` literally, and
    // P4 binds the loop's controller once from the run handle that owns it
    // (`beginRun`) instead of re-reading the field, because re-reading would let
    // a second run re-point this loop's cancellation mid-stream. TypeScript
    // refuses the field read here outright (the assignment moved out of this
    // generator, so the narrowing this loop relied on is gone), and the `!`
    // that would satisfy it does not match the old regex either -- so the text
    // could not have stayed. What this row still pins is the whole property:
    // the gate's reported site is the line after a loop gated on an abort signal.
    return loadGates().then(({ turnLoopSites, stripComments }) => {
      const duya = stripComments(fs.readFileSync(DUYA, 'utf8')).text;

      const sites = turnLoopSites(duya);
      expect(sites).toHaveLength(1);
      expect(sites[0].legs).toBe(2);

      const loopLine = duya
        .split(/\r?\n/)
        .findIndex((line) =>
          /^\s*while\s*\(![\w.]+\.signal\.aborted\)/.test(line),
        );
      expect(loopLine).toBeGreaterThan(-1);
      expect(sites[0].line).toBe(loopLine + 1);

      // The loop is still the one calling `runTurnStream` rather than
      // `.streamChat(`. If this ever fails, the gate went quiet for the wrong
      // reason.
      expect(duya).toContain('runTurnStream');
    });
  });

  it('names every source file in @duya/agent that still satisfies the loop predicate', () => {
    // G8 is reported per PACKAGE with a list of owning files, and it is
    // measured here the way the gate measures it: comment-stripped, through the
    // real predicate.
    //
    // The expected list changed, and BOTH halves of that change are load-bearing:
    //
    //  - The owner is `agent/DuyaAgent.ts`, NOT `process/agent-process-entry.ts`.
    //    Under the shipped predicate the entry has ONE `for await` leg (its
    //    `for await (const event of eventGen)`), one short of
    //    `TURN_LOOP_SHAPE.legs`, so it does not satisfy the predicate at all.
    //  - The owner is visible only AFTER stripping. Read raw, the predicate
    //    returns `[]` here -- the discrepancy `loadGates` documents.
    //
    // So this list is a MEASUREMENT of the gate rather than a restatement of what
    // G7 reported when an older predicate was in force, and it moves the day the
    // loop is deleted -- which is the point.
    return loadGates().then(({ isTurnLoopModule, TURN_LOOP_SHAPE, stripComments }) => {
      const isTestPath = (rel: string): boolean =>
        /(?:^|\/)(?:__tests__|tests?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$/.test(rel);

      const walk = (dir: string, out: string[] = []): string[] => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) {
            if (entry.name === 'dist' || entry.name === 'node_modules') continue;
            walk(full, out);
          } else if (/\.(ts|tsx|js|mjs|cjs)$/.test(entry.name)) {
            out.push(full);
          }
        }
        return out;
      };

      // `packages/agent/src` -- the root the gate itself walks, so the relative
      // paths below are the same ones G8 reports as `owners`.
      const agentSrc = path.join(HERE, '..', '..');
      const owners = walk(agentSrc)
        .map((file) => ({ file, rel: path.relative(agentSrc, file).split(path.sep).join('/') }))
        .filter(({ rel }) => !isTestPath(rel))
        .filter(({ file }) =>
          isTurnLoopModule(stripComments(fs.readFileSync(file, 'utf8')).text),
        )
        .map(({ rel }) => rel)
        .sort();

      expect(owners).toEqual(['agent/DuyaAgent.ts']);

      // Sanity: the predicate really is the two-leg loop body and nothing else, so
      // this test is measuring the gate and not a weaker local approximation. A
      // hand-typed copy here would let the two drift apart invisibly.
      expect(Object.keys(TURN_LOOP_SHAPE).sort()).toEqual(['legs']);
    });
  });
});
