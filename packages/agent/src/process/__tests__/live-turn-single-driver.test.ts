/**
 * Plan 600 S2 cutover, stage 1: the live `chat:start` path drives a turn ONCE.
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
    // ended `failed` on `sawFrame === false` (`run-engine.ts:490`).
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
    expect(engine).toMatch(/for \(let turn = 1; ; turn\+\+\)/);
    expect(engine).toMatch(/const outcome = await this\.#streamModel\(ctx, modelRequest\)/);
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
   */
  async function loadGates() {
    return (await import(
      /* @vite-ignore */ path.join(
        HERE,
        '..',
        '..',
        '..',
        '..',
        '..',
        'scripts',
        'architecture',
        'boundary-gates.mjs',
      )
    )) as typeof import('../../../../scripts/architecture/boundary-gates.mjs');
  }

  it('records that removing the turn loop alone would NOT have cleared the gate', () => {
    // This is the finding that reshaped the stage, so it is asserted rather than
    // only reported.
    //
    // `TURN_LOOP_SHAPE.modelStream` is `/\.streamChat\s*\(/`, and the turn loop
    // calls `runTurnStream`, NOT `.streamChat(`. In `DuyaAgent.ts` that pattern
    // matches the compaction summarizer and the side-question one-shot -- two
    // places that are not the loop at all. So the brief's premise that the
    // `runTurnStream` call leaving `DuyaAgent.ts` takes G7/G8 to zero does not
    // hold, and a cutover built on that premise would have finished the loop
    // removal and still been RED.
    return loadGates().then(({ TURN_LOOP_SHAPE }) => {
      const duya = fs.readFileSync(
        path.join(HERE, '..', '..', 'agent', 'DuyaAgent.ts'),
        'utf8',
      );
      const modelStreamLines = duya
        .split(/\r?\n/)
        .map((line, index) => ({ line, number: index + 1 }))
        .filter(({ line }) => TURN_LOOP_SHAPE.modelStream.test(line))
        .map(({ number }) => number);

      // Two matches, and NEITHER is the turn loop (which is 1795-3300).
      expect(modelStreamLines).toHaveLength(2);
      expect(modelStreamLines.every((n) => n < 1795 || n > 3300)).toBe(true);
    });
  });

  it('names every source file in @duya/agent that still satisfies the loop predicate', () => {
    // G8 is reported per PACKAGE with a list of owning files, and the list has
    // two entries, not one. `agent-process-entry.ts` matches through its own
    // `agent.streamChat(` call -- which this commit KEEPS, because it is the one
    // real driver. So G8 cannot be zeroed by this stage even in principle, and
    // the honest report is the two owners rather than a claim of one.
    return loadGates().then(async ({ isTurnLoopModule, TURN_LOOP_SHAPE }) => {
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
        .filter(({ file }) => isTurnLoopModule(fs.readFileSync(file, 'utf8')))
        .map(({ rel }) => rel)
        .sort();

      expect(owners).toEqual(['agent/DuyaAgent.ts', 'process/agent-process-entry.ts']);

      // Sanity: the predicate really is the conjunction of all three shapes, so
      // this test is measuring the gate and not a weaker local approximation.
      expect(Object.keys(TURN_LOOP_SHAPE).sort()).toEqual([
        'modelStream',
        'repetition',
        'toolExecution',
      ]);
    });
  });
});
