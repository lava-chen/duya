/**
 * Plan 610 D2: the measured SURFACE the flip has to move, asserted so it cannot
 * drift silently between now and the flip.
 *
 * ## Why this file exists
 *
 * The flip deletes `DuyaAgent.streamChat` as the live path's driver. Every test
 * that drives it therefore has to be migrated, re-pointed, or explicitly
 * retired -- and until someone counts them, "the flip" has no denominator. The
 * previous slices measured the `SessionEnd` and port surfaces; this one measures
 * the DRIVER surface, because it is the one the next slice actually lands on.
 *
 * It is a census rather than a migration tracker: no test here drives the loop,
 * and this file is about which tests do. A count in a commit message is a number
 * nobody can re-check after the next edit; a count in a test is one.
 *
 * ## What counts, and what does not
 *
 * COUNTS: an `it(` block that reaches `<receiver>.streamChat(` directly, or
 * through a helper function whose body reaches it (transitively -- `runLegacy`
 * drives the loop through `collectLegacy`, and a one-level scan misses every
 * harness that wraps the generator).
 *
 * DOES NOT COUNT, and each exclusion was a real miscount first:
 *
 *  - **The provider seam.** `activeClient.streamChat(` and `client.streamChat(`
 *    are what a scripted `@duya/ai` mock SUPPLIES. Every one of them disappears
 *    with nothing to migrate, because the engine has its own `ModelPort`. There
 *    are exactly four such receivers in this package today (three
 *    `activeClient`, one `client`) and none sits in an `it(` block, so the
 *    exclusion is documented rather than load-bearing -- MEASURED, not assumed:
 *    deleting the negative lookahead leaves every row in the table below
 *    unchanged. It is kept because the census is re-run after the flip, when a
 *    provider mock may well reach a loop-driving harness, and a census that
 *    silently widens its own subject mid-plan is worse than one that cannot.
 *  - **A regex literal.** `agent\.streamChat\s*\(` is how
 *    `live-turn-single-driver.test.ts` asserts the driver COUNT. Pinning a shape
 *    and running the loop are different claims; the flip needs to invert the
 *    former and delete the latter.
 *  - **A mention in prose.** Comments are blanked before matching, with offsets
 *    preserved, because this very tree names the driver in the comment above the
 *    rows that count it.
 *
 * ## How to re-derive the number
 *
 * The method is the three steps below and they are stated here so a reader
 * disputing a number can reproduce it rather than trust it:
 *
 *  1. Walk every `.test.ts` under `packages/agent`, recursively. (Written out
 *     rather than as a glob because a `*` / `/` pair inside this comment would
 *     close it, and the block is the only place the method is stated.)
 *  2. Blank line and block comments, preserving every offset.
 *  3. For each `it(`/`test(` block, count it when a comment-free `.streamChat(`
 *     call appears whose receiver is not a client/llm name and whose dot is not
 *     escaped, or when such a call is reachable through a helper whose own body
 *     reaches one, transitively to a fixed point.
 *
 * The expected table below is per FILE rather than a total, because a total
 * alone is satisfiable by the wrong distribution: deleting three tests from one
 * file and adding three to another leaves the sum unchanged and both files wrong.
 */

import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// ============================================================================
// The measured surface, as of plan 610 D2
// ============================================================================

/**
 * `[file, tests in the file, tests that drive the legacy loop]`, repo-root
 * relative.
 *
 * 72 tests across 14 files, out of 5067 tests in the package. The two
 * directories the flip's difficulty is usually attributed to hold very little
 * of it, and the reason matters more than the number:
 *
 *  - `packages/agent-runtime`: **ZERO**. Nothing there drives the loop; the
 *    only occurrences of the symbol are in prose explaining why those tests do
 *    not need it. The engine's own suite is already engine-only.
 *  - `packages/agent/src/process`: **12**, and every one is a TWO-SIDED
 *    comparison. `engine-session-end-parity` drives the legacy precisely so it
 *    can be compared against a real `RunEngineImpl` on the same channel;
 *    `engine-control-command-proof` uses the legacy's reply as the EXPECTED
 *    value for the engine's; `engine-fork-metadata-proof` asserts the legacy
 *    resets a marker so a bound marker cannot reach a legacy turn;
 *    `orchestrator-run-leg` drives the legacy so the orchestrator dispatch can
 *    be compared against the driver route that has to replace it. Migrating
 *    any of them makes a parity test compare the engine with itself, which
 *    keeps the name and drops the claim.
 *
 * The real surface is `packages/agent/tests/**`: 55 tests, and those are
 * ordinary legacy-behaviour tests whose claims survive migration because their
 * subject is the product's behaviour rather than a driver.
 *
 * ## What each file's tests need AT the flip -- not before it
 *
 * Counted here so the next slice does not re-derive it, and deliberately not
 * acted on in this slice: migrating a test off the legacy before the legacy
 * stops driving would make it test the engine while production still uses the
 * loop, which is a green that measures nothing.
 *
 *  - `engine-session-end-parity` (7): NOT MIGRATABLE. Its subject is the
 *    DIFFERENCE between the two drivers on one observation channel. With the
 *    legacy gone the file has to be inverted, not ported -- see the "D3"
 *    section of `live-turn-single-driver.test.ts` for the same reasoning about
 *    the driver count.
 *  - `engine-control-command-proof` (4): NOT MIGRATABLE. The legacy's reply is
 *    the EXPECTED value (`expect(proof.textBlocks[0]).toBe(expected)`); removing
 *    the legacy side makes the engine compare against itself, which passes for
 *    any answer at all.
 *  - `engine-fork-metadata-proof` (1): NOT MIGRATABLE, and the claim becomes
 *    vacuous rather than wrong. It pins that `streamChat` nulls the fork marker
 *    on entry, so a marker bound for an engine run cannot tag a later legacy
 *    turn. With no legacy turn to tag, there is nothing left to assert -- and
 *    the property it was protecting is already covered one row above, where an
 *    engine run with `forked: false` leaves `markerAfterRun` null.
 *  - `packages/agent/tests/**` (55) and `model-leg.test.ts` (5): MIGRATABLE,
 *    row by row, each keeping its claim by re-pointing the harness at a real
 *    `RunEngineImpl` rather than at the generator.
 *  - `orchestrator-run-leg` (1): NOT MIGRATABLE, and for a stronger reason than
 *    the three above. Its legacy call is the EXPECTED side of a claim that the
 *    orchestrator leg behaves the same through the driver route, and after the
 *    flip the ONLY driver is the engine path -- so the comparison has to be
 *    rewritten as "the driver route still dispatches what the legacy
 *    dispatched", pinned on the orchestrator's OWN frames rather than on the
 *    generator. Deleting the legacy arm instead would leave the file asserting
 *    that a routing decision reproduces itself.
 */
const EXPECTED: readonly (readonly [string, number, number])[] = [
  // packages/agent/src/process -- 13, all two-sided comparisons.
  ['packages/agent/src/process/__tests__/engine-session-end-parity.test.ts', 8, 7],
  ['packages/agent/src/process/__tests__/engine-control-command-proof.test.ts', 10, 4],
  ['packages/agent/src/process/__tests__/engine-fork-metadata-proof.test.ts', 12, 1],
  ['packages/agent/src/process/__tests__/orchestrator-run-leg.test.ts', 5, 1],
  // packages/agent/src/agent -- 5, on the legacy's own harness.
  ['packages/agent/src/agent/__tests__/model-leg.test.ts', 19, 5],
  // packages/agent/tests/unit -- 34.
  ['packages/agent/tests/unit/agent/DuyaAgent.plan315.test.ts', 21, 17],
  ['packages/agent/tests/unit/agent/turn-loop-product-behavior.test.ts', 8, 6],
  ['packages/agent/tests/unit/agent/DuyaAgent.plan486.test.ts', 5, 5],
  ['packages/agent/tests/unit/agent/DuyaAgent.omitAgentsMd.test.ts', 2, 2],
  ['packages/agent/tests/unit/agent/DuyaAgent.thinking-replay.test.ts', 2, 2],
  ['packages/agent/tests/unit/agent/nestedInjection.test.ts', 2, 2],
  // packages/agent/tests/integration -- 14.
  ['packages/agent/tests/integration/DuyaAgent.test.ts', 12, 7],
  ['packages/agent/tests/integration/RealTasks.test.ts', 13, 5],
  ['packages/agent/tests/integration/AgentLoop.test.ts', 2, 2],
  // packages/agent/tests/regression -- 7.
  ['packages/agent/tests/regression/streaming-lifecycle.test.ts', 7, 7],
];

/** Every test in the package, so the census is a proportion and not a total. */
const PACKAGE_TEST_COUNT = 5072;

// ============================================================================
// The census
// ============================================================================

const HERE = path.dirname(fileURLToPath(import.meta.url));
// `__tests__` -> `process` -> `src` -> the package, and the repo root above it.
const PACKAGE_ROOT = path.join(HERE, '..', '..', '..');
const REPO_ROOT = path.join(PACKAGE_ROOT, '..', '..');
/** `packages/`, so the agent-runtime row can walk a SIBLING package. */
const PACKAGES_ROOT = path.join(REPO_ROOT, 'packages');

/**
 * A `.streamChat(` call that drives the LEGACY LOOP.
 *
 * The negative lookahead excludes the provider seam, whose scripted mocks all
 * disappear with the flip; the escaped-dot arm keeps a regex literal
 * (`agent\.streamChat`) out, since that is a SHAPE assertion rather than a
 * driver. Which of the two is load-bearing was measured rather than assumed --
 * see the header's "What counts, and what does not".
 */
const DRIVES_LOOP = /\b(?!.*\b(?:client|Client|llm|LLM|delegating)\b)[A-Za-z_$][\w$]*\\?\.streamChat\s*\(/;

/**
 * Blank comments while PRESERVING every offset.
 *
 * The same technique, and for the same reason, as
 * `engine-session-end-parity.test.ts`'s own `stripComments`: prose in this tree
 * names the driver, so an unblanked scan reports the rows that DESCRIBE the
 * driver as the rows that RUN it.
 */
function blankComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '/' && text[i + 1] === '/') {
      const end = text.indexOf('\n', i);
      const stop = end === -1 ? text.length : end;
      out += ' '.repeat(stop - i);
      i = stop;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      const stop = end === -1 ? text.length : end + 2;
      for (let k = i; k < stop; k++) out += text[k] === '\n' || text[k] === '\r' ? text[k] : ' ';
      i = stop;
      continue;
    }
    out += c;
    i += 1;
  }
  return out;
}

/** True when at least one match is a real CALL rather than a regex literal. */
function drivesLoop(raw: string): boolean {
  const text = blankComments(raw);
  for (const m of text.matchAll(new RegExp(DRIVES_LOOP.source, 'g'))) {
    const dot = m.index + m[0].length - '.streamChat('.length;
    if (text[dot - 1] !== '\\') return true;
  }
  return false;
}

/**
 * A function's body, by brace count, starting AFTER its parameter list.
 *
 * The list is skipped by paren balance because an object-typed parameter puts a
 * brace inside it; angles are counted afterwards because an object-typed RETURN
 * TYPE (`): Promise<{ ... }>`) opens one before the body does. A `;` ends the
 * scan only BEFORE the first brace, since inside a body every statement ends in
 * one -- treating that as the end truncated `drainStream` at its first statement
 * and reported the largest file in the census as driving nothing.
 */
function bodyFrom(src: string, from: number): string {
  let paren = 0;
  for (let i = from; i < src.length; i++) {
    if (src[i] === '(') paren++;
    else if (src[i] === ')') {
      paren--;
      if (paren !== 0) continue;
      let angle = 0;
      let brace = 0;
      let seen = false;
      for (let j = i + 1; j < src.length; j++) {
        const c = src[j];
        if (c === '<' && src[j - 1] !== '=') angle++;
        else if (c === '>' && src[j - 1] !== '=') angle--;
        else if (angle === 0 && c === '{') {
          brace++;
          seen = true;
        } else if (angle === 0 && c === '}') {
          brace--;
          if (seen && brace === 0) return src.slice(i + 1, j + 1);
        } else if (angle === 0 && c === ';' && !seen) {
          return src.slice(i + 1, j);
        }
      }
      break;
    }
  }
  return src.slice(from);
}

/** Helpers that reach the loop, transitively, to a fixed point. */
function drivingHelpers(src: string): Set<string> {
  const bodies = new Map<string, string>();
  for (const m of src.matchAll(/(?:async )?function (\w+)\s*\(/g)) {
    bodies.set(m[1], bodyFrom(src, m.index));
  }
  const helpers = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [name, body] of bodies) {
      if (helpers.has(name)) continue;
      const direct = drivesLoop(body);
      const via = [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(body));
      if (direct || via) {
        helpers.add(name);
        grew = true;
      }
    }
  }
  return helpers;
}

/** `[totalIts, drivingIts]` for one file. */
function censusOf(src: string): [number, number] {
  const lines = src.split(/\r?\n/);
  const starts: number[] = [];
  lines.forEach((line, i) => {
    if (/^\s*(it|test)(\.each)?\(/.test(line)) starts.push(i);
  });
  const helpers = drivingHelpers(src);
  let driving = 0;
  starts.forEach((start, idx) => {
    const body = lines
      .slice(start, idx + 1 < starts.length ? starts[idx + 1] : lines.length)
      .join('\n');
    const direct = drivesLoop(body);
    const via = [...helpers].some((h) => new RegExp(`\\b${h}\\s*\\(`).test(body));
    if (direct || via) driving += 1;
  });
  return [starts.length, driving];
}

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'dist' || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (/\.test\.ts$/.test(entry.name)) out.push(full);
  }
  return out;
}

// ============================================================================
// The measurement
// ============================================================================

describe('the measured driver surface the flip has to move', () => {
  const files = walk(PACKAGE_ROOT);

  it('drives the legacy loop from exactly the counted files, with the counted depth', () => {
    const measured = new Map<string, [number, number]>();
    for (const file of files) {
      const [, driving] = censusOf(fs.readFileSync(file, 'utf8'));
      if (driving === 0) continue;
      const rel = path.relative(REPO_ROOT, file).split(path.sep).join('/');
      measured.set(rel, censusOf(fs.readFileSync(file, 'utf8')));
    }

    const actual = [...measured.entries()].sort(([a], [b]) => a.localeCompare(b));
    const expected = EXPECTED.map(([file]) => file).sort();

    // Both halves, and in this order: a file that GAINED a driver must be
    // reported before a file that lost one, because "the sets differ" is not a
    // diagnosis and which side moved is.
    const added = actual.filter(([f]) => !expected.includes(f)).map(([f]) => f);
    const removed = expected.filter((f) => !actual.some(([a]) => a === f));

    expect({ added, removed }).toEqual({ added: [], removed: [] });
    for (const [file, total, driving] of EXPECTED) {
      expect(measured.get(file), `${file} census`).toEqual([total, driving]);
    }
  });

  it('is 73 tests, which is the number the flip is sized against', () => {
    // Stated on its own so a reader does not have to add the table up, and so a
    // silent change to the total is a red row rather than a diff a reviewer has
    // to notice. The sum is computed from the SAME table the row above pins, so
    // the two cannot disagree. It moved 72 -> 73 at plan 610 P5, by the one
    // row above that is a legacy-vs-driver parity comparison.
    const total = EXPECTED.reduce((n, [, , driving]) => n + driving, 0);
    expect(total).toBe(73);
    // And it is a small fraction of the package, which is the finding: the flip
    // is not "rewrite the agent's tests", it is "move 73 of 5072".
    expect(total).toBeLessThan(PACKAGE_TEST_COUNT / 50);
  });

  it('reaches NOTHING in packages/agent-runtime, which is already engine-only', () => {
    // The premise the flip is usually assumed to need. `packages/agent-runtime`
    // mentions the symbol only in prose explaining why those tests do not drive
    // it, and a single new driver there would mean the engine's own suite had
    // started testing the product's loop -- worth a red row.
    const runtimeFiles = walk(path.join(PACKAGES_ROOT, 'agent-runtime'));
    expect(runtimeFiles.length).toBeGreaterThan(50);
    const drivers = runtimeFiles.filter((f) => censusOf(fs.readFileSync(f, 'utf8'))[1] > 0);
    expect(drivers.map((f) => path.relative(REPO_ROOT, f).split(path.sep).join('/'))).toEqual([]);
  });
});
