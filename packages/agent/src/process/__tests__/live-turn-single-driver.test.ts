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
 *  2. `engineDrivers === 1` -- EXACTLY ONE `new RunEngineImpl(` exists on the
 *     live `chat:start` path. See "THE ONE PLACE THE PRESCRIPTION WAS WRONG"
 *     below: post-flip it is in `engine-run-driver.ts`, not the entry, so this
 *     count is measured over the PATH rather than over the entry file alone.
 *  3. `legacyDrivers + engineDrivers === 1` -- THE PAIR. This is the whole point
 *     and it survives the inversion unchanged in form: the file's stated reason
 *     for using a count at all is that "a gate which says no loop here is
 *     satisfied by a file with no turn at all". A state with ZERO drivers must
 *     fail, and this sum is what makes it fail. An inversion that dropped it and
 *     asserted only the two counts separately would reintroduce exactly the
 *     vacuity the header argues against.
 *  4. The `emptyModelStream` / `emptyToolDrain` / `runWithEngine`
 *     phantom-removal rows stay at 0 -- those arms are NOT inverted, because the
 *     phantom they describe is genuinely gone and its name must never come back.
 *     `buildEnginePorts` also stays 0 and a NEW arm is added for
 *     `composeLegacyRunPorts`, which is the legitimate composition the driver
 *     now owns. `proposeTerminal` stops being a phantom marker and becomes the
 *     real binding.
 *  5. `still runs the generator` (`const eventGen = agent.streamChat(` and
 *     `for await (const event of eventGen)`) is DELETED rather than inverted.
 *     There is no generator to run, and keeping the row with its count set to
 *     zero would assert that the entry contains a driver it is forbidden to
 *     contain.
 *
 * **THE ONE PLACE THE PRESCRIPTION WAS WRONG**, and how it was resolved
 *
 * Item 2 above said `engineDrivers === 1` "inside the `chat:start` handler rather
 * than reachable only from a helper". The flip put the engine construction in a
 * new module, `engine-run-driver.ts`, so the count taken over
 * `agent-process-entry.ts` ALONE is **0** -- measured, not guessed.
 *
 * That is not a licence to weaken the row, and the fix is NOT to inline 400
 * lines of assembly back into a 5000-line entry. The fix is to measure the PATH
 * (`entry` + the one module it delegates to) and to add a row that keeps the
 * wiring itself under test:
 *
 *  - `engineDrivers === 1` is measured over `entry + engine-run-driver.ts`.
 *  - `legacyDrivers === 0` is measured over the SAME text, so the pair in item 3
 *    is a pair over one body of text and not a subtraction across two scopes.
 *  - A NEW row asserts the entry calls `driveRunWithEngine(` exactly once.
 *    This is what stops the concatenation from becoming a loophole: without it,
 *    deleting the driver's call from the entry would leave `engineDrivers === 1`
 *    reading true for a `chat:start` that constructs no engine at all -- the
 *    precise vacuity this file exists to rule out, reached by a new route.
 *
 * `engine-run-driver.ts` has exactly one importer (the entry), so "the path" is
 * two files by measurement and not by assumption.
 *
 * **WHAT EACH PRESCRIBED ROW ACTUALLY MEASURED**, recorded here so the next
 * reader does not re-derive it or trust the earlier guesses:
 *
 *  - `occurrences(/agent\.streamChat\s*\(/)` in the driver pair -- both
 *    expectations change, the three lines of arithmetic do not.
 *  - `drives no other model stream from this path`: 1 -> 0, and its comment
 *    changed with it, because "a file with no driver at all fails the previous
 *    test" is no longer the reason for expecting 0. The companion
 *    `readModelClient(` arm was PRESCRIBED AS OUT by the original reasoning and
 *    is measured 0 here: that read lives in `run-composition.ts`, a third file
 *    this guard does not measure, so the only true in-scope statement is that
 *    the path composes ports instead of opening a stream of its own.
 *  - `binds no model port that yields nothing`: `emptyModelStream` and
 *    `emptyToolDrain` stayed at 0, but `buildEnginePorts` ALSO stayed at 0 --
 *    the earlier guess of 0 -> 1 was wrong, because the flip did not revive that
 *    builder. What owns the composition now is `composeLegacyRunPorts`, counted
 *    call-shaped at 1 in a new arm of the same row.
 *  - `proposes no terminal from the worker entry`: PRESCRIBED 0 -> 1, MEASURED
 *    differently again. The binding is written as the shorthand
 *    `proposeTerminal: spine.proposeTerminal,`, so the bare token occurs twice
 *    on one line for one binding. Asserting the shorthand asserts the thing
 *    that matters -- the engine's proposal reaches the spine and only the spine
 *    -- where a bare count would assert a number whose meaning is false.
 *  - `the stop press has exactly one cancellation path`: the prescription called
 *    this the one place where "invert the polarity" is wrong, and it was right.
 *    `agent.interrupt()` STILL works and its count is unchanged at 1, because
 *    `beginRun` installs the run's controller into the very field `interrupt()`
 *    fires -- so the engine's `run.signal` and the stop press are the same
 *    controller. What changed is the REASON, so the comment was replaced rather
 *    than kept, and the row was extended to pin `signal: run.signal` as well:
 *    asserting only the call would keep passing if the driver handed the engine a
 *    controller of its own, which is the inert-again failure this row exists to
 *    prevent.
 *  - The hand-off UI state rows survived untouched, re-measured rather than
 *    trusted: three `if (chatInProgress)` guards and two `lastInterruptTime`
 *    writes, the same counts as before the flip.
 *  - The G7/G8 block did NOT go green, and was not expected to. G8's owner list
 *    is still `['agent/DuyaAgent.ts']`: the turn loop itself still lives there
 *    and is still driven by `headless-run-host.ts` and `SubagentTool/runAgent.ts`,
 *    which plan 610 deliberately did NOT delete. The new driver module does not
 *    satisfy the loop predicate either (it drains one stream, not two), which
 *    was measured through the real gate rather than assumed. G7 therefore stays
 *    red, and G7 going green would mean the legacy loop had been removed --
 *    which is a later slice, not this one.
 *
 * ## What this file is
 *
 * The evidence that the phantom run is gone, and that what remains on the live
 * path is the single engine driver. It is a SOURCE-SHAPE guard, and that is a
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
 *  - the number of engine constructions is 1, and
 *  - the number of legacy `agent.streamChat(` calls is 0.
 *
 * The pair is the assertion. A file that deleted the engine driver would fail
 * the first; a file that re-added the legacy driver would fail the second.
 * Neither passes by being empty, which is what makes this stronger than the
 * negative form. The pair only means something while the entry still CALLS the
 * module the engine is counted in, so a third row pins that wiring rather than
 * trusting it.
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
/**
 * The module the entry delegates its turn to. Plan 610 S4c-d2a moved the
 * assembly here; the header's "THE ONE PLACE THE PRESCRIPTION WAS WRONG" says
 * why the driver count is measured across both files.
 */
const DRIVER = path.join(HERE, '..', 'engine-run-driver.ts');
/**
 * The headless/CLI entry. Plan 610 S4c-d2b flipped it onto the same driver, so
 * it is measured here for the same reason the entry is: a caller that reached
 * the driver twice would assemble two turns for one run.
 */
const HEADLESS = path.join(HERE, '..', 'headless-run-host.ts');
const DUYA = path.join(HERE, '..', '..', 'agent', 'DuyaAgent.ts');

/**
 * Comment-strip. Comments are stripped FIRST because several of the symbols
 * below are named in the comments that document why they were removed or
 * added. Counting naively would report `activeEngineRun: 1` and
 * `emptyModelStream: 1` for a file that contains neither binding -- a false
 * positive that would make this guard look satisfied for the wrong reason,
 * which is the mirror image of the false-negative problem the positive counts
 * exist to avoid.
 *
 * `code()` below re-derives the same stripped text and the tests assert on
 * counts taken from it, so the stripping and the assertion cannot disagree.
 */
function strip(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');
}

const ENTRY_CODE = strip(fs.readFileSync(ENTRY, 'utf8'));
const DRIVER_CODE = strip(fs.readFileSync(DRIVER, 'utf8'));
const HEADLESS_CODE = strip(fs.readFileSync(HEADLESS, 'utf8'));
/**
 * THE LIVE `chat:start` PATH, as one body of text.
 *
 * Driver counts default to this. Rows that are genuinely about the entry's own
 * lifecycle -- constructing and closing the turn pipeline publisher, calling
 * `agent.interrupt()` -- pass `ENTRY_CODE` explicitly, because counting the
 * driver's mentions of those names instead would make the row a claim about
 * code the entry does not own.
 *
 * `CODE` is the text both halves of the driver pair are measured over, so
 * `legacyDrivers + engineDrivers` is a sum over ONE body and not a subtraction
 * across two scopes.
 */
const CODE = `${ENTRY_CODE}\n${DRIVER_CODE}`;

/**
 * The driver is reached from the two PRODUCTION turn entries, and nowhere else.
 *
 * ## Plan 610 S4c-d2b: this count moved from 1 to 2, and the invariant moved too
 *
 * It was 1 because the worker entry was the only production caller. S4c-d2b
 * flipped the SECOND of the plan's three turn call sites -- the headless/CLI
 * path -- onto the same driver, so `headless-run-host.ts` is now the second
 * importer. That is the change this row exists to detect, and it is a change in
 * the tree, not a defect: two ENTRIES driving one driver is the plan's shape,
 * while two DRIVERS of one turn is what this file rules out.
 *
 * So the row was not weakened from `1` to `toBeGreaterThan(0)`. It is now
 * asserted as the exact SET of importers, so a THIRD caller -- a second driver
 * of a third turn, or a helper reaching for the driver from somewhere it has no
 * business owning a turn -- still fails. The single-driver pair in the next
 * describe is untouched and still measures `new RunEngineImpl(` at 1 over the
 * entry plus the driver, which is the property that actually rules out two
 * drivers: two callers of ONE constructor is not two drivers.
 */
const DRIVER_IMPORTERS = ((): readonly string[] => {
  const dir = path.join(HERE, '..');
  const found: string[] = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!e.isFile() || !/\.(ts|tsx)$/.test(e.name)) continue;
    if (e.name === 'engine-run-driver.ts') continue;
    if (strip(fs.readFileSync(path.join(dir, e.name), 'utf8')).includes("'./engine-run-driver.js'"))
      found.push(e.name);
  }
  return found.sort();
})();

function occurrences(pattern: RegExp, text: string = CODE): number {
  return (text.match(new RegExp(pattern.source, 'g')) ?? []).length;
}

// ============================================================================
// 1. The phantom run is gone
// ============================================================================

describe('the live chat:start path no longer runs a phantom engine run', () => {
  it('constructs EXACTLY ONE run engine, and no phantom run survives', () => {
    // INVERTED from `constructs no run engine at all`, and not symmetrically:
    // post-flip the engine is the real driver, so its count is 1 and it is
    // asserted positively. The phantom -- `runWithEngine(...)`, which built
    // ports and executed an engine that asked the provider zero times and then
    // ended `failed` on `sawFrame === false` -- stays at 0 under its own name.
    // That arm is NOT inverted even though the engine count moved: a phantom
    // that came back under any name would be a second account of the turn, and
    // the legacy generator being gone does not make a second engine legitimate.
    expect(occurrences(/new RunEngineImpl\s*\(/)).toBe(1);
    expect(occurrences(/\brunWithEngine\b/)).toBe(0);
  });

  it('binds the REAL composition, and still no port that yields nothing', () => {
    // `emptyModelStream` / `emptyToolDrain` are unchanged at 0: the phantom's
    // signature, and its return must never come back.
    expect(occurrences(/\bemptyModelStream\b/)).toBe(0);
    expect(occurrences(/\bemptyToolDrain\b/)).toBe(0);
    // `buildEnginePorts` is the phantom's builder and also stays 0.
    expect(occurrences(/\bbuildEnginePorts\b/)).toBe(0);
    // What replaced it is named here rather than left implied, because a row
    // that only counted absences would be satisfied by a driver with no port
    // composition at all. Call-shaped: the import line carries the name but no
    // `(`. Exactly one, so a driver that ALSO wired a private port set of its
    // own -- a second account of the turn, the exact failure mode this file
    // exists to catch -- cannot hide behind this assertion.
    expect(occurrences(/composeLegacyRunPorts\s*\(/)).toBe(1);
  });

  it('proposes its terminal through the one spine, not a discarded proposal', () => {
    // The phantom proposed `failed` once per `chat:start` into a proposal that
    // was logged and thrown away. The real run proposes through the spine, and
    // the driver hands the engine exactly that one function.
    //
    // Asserted on the SHAPE rather than on a bare `\bproposeTerminal\b` count:
    // the host member is written as the shorthand
    // `proposeTerminal: spine.proposeTerminal,`, so the bare token occurs TWICE
    // on one line for ONE binding. Counting the token would therefore assert a
    // number whose meaning ("two proposals") is false, and it would read as a
    // regression the day someone formatted the property as
    // `proposeTerminal: (c) => c(candidate)`. Pinning the shorthand asserts the
    // thing that matters instead -- that the engine's proposal goes to the
    // spine, and to it alone.
    expect(occurrences(/proposeTerminal: spine\.proposeTerminal,/)).toBe(1);
  });

  it('reaches the engine through exactly one call site per entry, and only the two entries', () => {
    // THE row that keeps the two-file measurement honest.
    //
    // Counting engines over `entry + driver` is only meaningful while the entry
    // actually CALLS the driver. Delete the call and `engineDrivers` still reads
    // 1 -- the constructor is still sitting in a module nobody reaches -- while
    // `chat:start` builds no engine at all. The legacy pair in the next
    // describe would not catch that either: both counts would be consistent and
    // the sum would read 1 for a run with no driver. So the wiring is pinned
    // here, positively, once PER ENTRY.
    expect(occurrences(/driveRunWithEngine\s*\(/, ENTRY_CODE)).toBe(1);
    // And the headless entry drives it exactly once too, for the same reason:
    // a headless channel that called the driver twice would assemble two turns
    // for one run.
    expect(occurrences(/driveRunWithEngine\s*\(/, HEADLESS_CODE)).toBe(1);
    // The exact set, so a THIRD importer fails. See `DRIVER_IMPORTERS` for why
    // the count is a set rather than a number.
    expect(DRIVER_IMPORTERS).toEqual(['agent-process-entry.ts', 'headless-run-host.ts']);
  });
});

// ============================================================================
// 2. Exactly one driver remains
// ============================================================================

describe('the engine is the only driver of a turn on the live path', () => {
  it('has exactly one driver, and it is the engine', () => {
    // THE assertion of this file. Read as a pair, and the pair is why it is not
    // vacuous:
    //
    //   drivers === 1  AND  the one is `new RunEngineImpl(`
    //
    // Deleting the driver gives 0 and fails. Re-adding any legacy generator
    // gives >= 2 and fails. Only exactly-one-engine passes.
    //
    // Both halves are counted over the SAME text (`CODE`), which is the entry
    // plus the module it delegates to -- so the sum below is a sum over one body
    // and not a subtraction across two scopes.
    const engineDrivers = occurrences(/new RunEngineImpl\s*\(/);
    const legacyDrivers = occurrences(/agent\.streamChat\s*\(/);

    expect(legacyDrivers).toBe(0);
    expect(engineDrivers).toBe(1);
    expect(legacyDrivers + engineDrivers).toBe(1);
  });

  it('drives no other model stream from this path', () => {
    // The count is 0 rather than 1 because the driver itself no longer matches:
    // post-flip the path reaches the provider through the engine's own model
    // port, and `.streamChat(` is gone from both files. The PRE-flip reason for
    // expecting 1 -- "the driver itself matches, so a file with no driver fails
    // the previous test" -- is no longer the reason, and the row above is what
    // now rules out an empty path. This row only has to catch a SECOND stream:
    // a helper that reached the client directly by another name.
    expect(occurrences(/\.streamChat\s*\(/)).toBe(0);
    // And the driver does not read the client itself. That read belongs to
    // `composeLegacyRunSources` inside `run-composition.ts`, which derives the
    // engine's model port from `agent.readModelClient()`. Asserting it HERE
    // would be asserting about a third file this row does not measure, so it is
    // asserted in the only direction that is true of these two: the path
    // composes its ports rather than opening a model stream of its own. A
    // direct client read in the driver would be a second model leg -- the same
    // phantom shape, rebuilt.
    expect(occurrences(/readModelClient\s*\(/)).toBe(0);
  });
});

// ============================================================================
// 3. Cancellation has exactly one path
// ============================================================================

describe('the stop press has exactly one cancellation path', () => {
  it('calls agent.interrupt(), and the run it aborts is the engine run', () => {
    // `agent.interrupt()` is the path that WORKS, and it STILL works after the
    // flip -- but the MECHANISM behind it changed, which is why this row needed
    // a decision rather than a count change.
    //
    // PRE-flip: `interrupt()` fired `this.abortController`, the field
    // `streamChat` owned, and that controller's signal is what the provider
    // request was reading. The engine branch this row replaced was provably
    // inert, because the controller it stopped belonged to the phantom run.
    //
    // POST-flip: the driver passes `run.signal` to the engine, and that signal
    // comes from `DuyaAgent.beginRun`, which -- first thing, before any await --
    // does `this.abortController = controller` and returns that controller's
    // signal. So the SAME field `interrupt()` fires is now the field the ENGINE
    // run's signal is derived from. One press, one controller, the one the
    // engine hands to its ports.
    //
    // That chain is a claim about two files, so it is pinned on both ends: the
    // interrupt call here, and `run.signal` in the driver below. Asserting only
    // the call would keep passing if the driver handed the engine a controller
    // of its own, which is the inert-again failure this row exists to prevent.
    expect(occurrences(/agent\.interrupt\s*\(\)/, ENTRY_CODE)).toBe(1);
    expect(occurrences(/signal: run\.signal,/)).toBe(1);
    // The phantom's own abort handle stays gone.
    expect(occurrences(/\bactiveEngineRun\b/)).toBe(0);
  });

  it('keeps the guard that stops a run that is not in progress', () => {
    // Removing a path must not remove the surrounding behaviour. Three distinct
    // `if (chatInProgress)` guards exist in this file and all three are counted
    // rather than one, because a count of 1 would be satisfied by any two of
    // them being deleted. One is the interrupt branch; the other two are the
    // re-entrancy guard and the block-reset path, which this flip must not have
    // disturbed.
    //
    // MEASURED, not guessed: the first draft of this assertion expected 1 and
    // the run reported 3, which is what prompted counting all three. It reads
    // 3 again after the flip.
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
  it('still constructs, hands on, and closes the per-run turn pipeline publisher', () => {
    // `TurnPipelinePublisher` is the handle a `ToolPort` binds to. It is
    // asserted POSITIVELY (constructed, handed on, closed) so that "the seam is
    // still here" is a measured fact rather than an absence nothing could
    // contradict.
    //
    // Construct-and-close are the ENTRY's own lifecycle and are measured there.
    // "Handed on" is where the flip moved the meaning: pre-flip the publisher
    // went into `streamChat`'s options, and `turnPipelines,` counted 1. Post-flip
    // it goes into the driver's request, still as the same shorthand and still
    // exactly once -- and the driver is what binds it to the tool port
    // (`publisher: turnPipelines`). Both ends are counted so that a publisher
    // which was handed on but never bound, or bound without being handed on,
    // fails a row.
    expect(occurrences(/new TurnPipelinePublisher\(\)/, ENTRY_CODE)).toBe(1);
    expect(occurrences(/turnPipelines,/, ENTRY_CODE)).toBe(1);
    expect(occurrences(/turnPipelines\.close\(\)/, ENTRY_CODE)).toBe(1);
    expect(occurrences(/publisher: turnPipelines,/)).toBe(1);
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

  it('reports NO turn loop in DuyaAgent.ts, and would still report one if it came back', () => {
    // Plan 610 S4c-d3 INVERTED this row, and the inversion is the point rather
    // than a concession: the legacy turn generator this test used to require is
    // deleted, and boundary gate G7 is green because of it.
    //
    // The original intent was "the gate must be RED because the loop EXISTS,
    // never because a marker was deleted". The surviving form of that intent is
    // the two halves below:
    //
    //   1. the real predicate reports nothing on the real module, and
    //   2. the SAME predicate, called in the SAME file, still finds a loop when
    //      one is planted.
    //
    // Without (2) this row would pass for the wrong reason -- a predicate that
    // had simply stopped matching anything would satisfy (1) forever. That is the
    // "the gate went quiet for the wrong reason" failure this file was written to
    // catch, and it is why the canary is planted rather than assumed.
    return loadGates().then(({ turnLoopSites, stripComments }) => {
      const duya = stripComments(fs.readFileSync(DUYA, 'utf8')).text;

      // (1) The real module, through the real predicate.
      expect(turnLoopSites(duya)).toEqual([]);

      // (2) NON-VACUITY. A two-leg loop body planted in the same text is found,
      // and the legs are counted. If this ever fails, the gate went quiet for the
      // wrong reason -- the absence in (1) would then be the predicate's, not the
      // module's.
      const canary = [
        'function canary(a: AsyncIterable<unknown>, b: AsyncIterable<unknown>) {',
        '  let go = true;',
        '  while (go) {',
        '    for await (const x of a) { void x; }',
        '    for await (const y of b) { void y; }',
        '  }',
        '}',
      ].join('\n');
      const planted = turnLoopSites(duya + '\n' + canary);
      expect(planted).toHaveLength(1);
      expect(planted[0].legs).toBe(2);

      // The class still owns the SEAM the driver reaches through, so "no loop
      // here" is not "the turn has no owner at all".
      expect(duya).toContain('runTurnStream');
    });
  });

  it('names NO source file in @duya/agent that still satisfies the loop predicate', () => {
    // G8 is reported per PACKAGE with a list of owning files, and it is
    // measured here the way the gate measures it: comment-stripped, through the
    // real predicate.
    //
    // Plan 610 S4c-d3 changed the expected list from `['agent/DuyaAgent.ts']` to
    // `[]`, because that module's turn generator is deleted. The two halves of
    // the ORIGINAL expectation were load-bearing and both still hold:
    //
    //  - the owner was never `process/agent-process-entry.ts`: under the shipped
    //    predicate the entry has ONE `for await` leg, one short of
    //    `TURN_LOOP_SHAPE.legs`, so it does not satisfy the predicate at all.
    //  - the owner is visible only AFTER stripping; read raw, the predicate
    //    returns `[]` for the same reason it returns `[]` now.
    //
    // So this remains a MEASUREMENT of the gate rather than a restatement of what
    // G7 reported under an older predicate, and it is now the assertion that the
    // migration finished: a second turn loop appearing anywhere under
    // `packages/agent/src` turns this red.
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

      expect(owners).toEqual([]);

      // Sanity: the predicate really is the two-leg loop body and nothing else, so
      // this test is measuring the gate and not a weaker local approximation. A
      // hand-typed copy here would let the two drift apart invisibly.
      expect(Object.keys(TURN_LOOP_SHAPE).sort()).toEqual(['legs']);
    });
  });
});
