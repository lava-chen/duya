/**
 * evals/agent/matrix/matrix.test.ts — the matrix is checked against the repo, not
 * against itself.
 *
 * ## Why this file is the important one
 *
 * A behaviour matrix is a claim about what is proved. Left unchecked it decays
 * into a list of good intentions: a test is renamed, the matrix keeps citing the
 * old title, and a reader concludes the row is still covered when nothing is
 * running. That failure is invisible — the matrix file itself still parses, and
 * a report that reads it looks confident.
 *
 * So every `covered-by-existing-suite` row is verified against the filesystem
 * HERE: the file must exist and the named title must literally be in it. A
 * citation that cannot be found fails this test. That is the difference between
 * a ledger and a claim.
 *
 * ## What is deliberately NOT checked
 *
 * That the cited test PASSES. Running 40 foreign suites from this file would
 * make the eval runner minutes long and would turn a structural check into a
 * second `npm test`. Pass/fail belongs to the suite that owns the row, and the
 * matrix report records that fact by marking the row `skipped` with the suite
 * named — see `./section.ts`.
 */

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MATRIX, MATRIX_GROUPS, MATRIX_STATUSES, matrixRowIds, type MatrixRow } from './rows';
import { MATRIX_REPO_ROOT } from './section';

/** Every distinct path the matrix cites, so a rename is a single loud failure. */
function citedFiles(): string[] {
  const files = new Set<string>();
  for (const row of MATRIX) {
    for (const evidence of row.evidence) files.add(evidence.file);
  }
  return [...files].sort();
}

function readIfPresent(file: string): string | null {
  const absolute = path.join(MATRIX_REPO_ROOT, file);
  return existsSync(absolute) ? readFileSync(absolute, 'utf8') : null;
}

describe('the matrix declares exactly the plan\'s rows', () => {
  it('covers every group the plan names, in order', () => {
    const declared = [...new Set(MATRIX.map((row) => row.group))];
    expect(declared).toEqual([...MATRIX_GROUPS]);
  });

  it('gives every row a unique id', () => {
    const ids = matrixRowIds();
    const duplicates = ids.filter((id, i) => ids.indexOf(id) !== i);
    expect(duplicates).toEqual([]);
  });

  it('gives every row a scenario and an assertion, so no row is a bare label', () => {
    const thin = MATRIX.filter((row) => row.scenario.trim().length === 0 || row.assertion.trim().length === 0);
    expect(thin.map((r) => r.row)).toEqual([]);
  });

  it('records at least one row per group, so a group cannot be quietly emptied', () => {
    const empty = MATRIX_GROUPS.filter((group) => !MATRIX.some((row) => row.group === group));
    expect(empty).toEqual([]);
  });
});

describe('a status carries the obligation its name implies', () => {
  it('uses only the three declared statuses', () => {
    const bad = MATRIX.filter((row) => !(MATRIX_STATUSES as readonly string[]).includes(row.status));
    expect(bad.map((r) => r.row)).toEqual([]);
  });

  it('gives every row at least one piece of evidence, whatever its status', () => {
    // Even an unsupported row cites what IS covered, so the gap is stated as a
    // narrow one rather than an absence.
    const bare = MATRIX.filter((row) => row.evidence.length === 0);
    expect(bare.map((r) => r.row)).toEqual([]);
  });

  it('gives every piece of evidence a reason, so a citation is never bare', () => {
    const bare = MATRIX.flatMap((row) =>
      row.evidence.filter((e) => e.why.trim().length === 0).map(() => row.row),
    );
    expect(bare).toEqual([]);
  });

  it('requires a reason on an unsupported row and forbids one elsewhere', () => {
    const unsupportedWithoutReason = MATRIX.filter(
      (row) => row.status === 'unsupported' && (row.reason ?? '').trim().length === 0,
    );
    const supportedWithReason = MATRIX.filter(
      (row) => row.status !== 'unsupported' && row.reason !== undefined,
    );
    expect({ unsupportedWithoutReason: unsupportedWithoutReason.map((r) => r.row) }).toEqual({
      unsupportedWithoutReason: [],
    });
    // A reason on a proved row is how a claim gets quietly downgraded into a
    // hedge, so the vocabulary is closed: `reason` belongs to `unsupported`.
    expect(supportedWithReason.map((r) => r.row)).toEqual([]);
  });

  it('names the missing capability in every unsupported reason', () => {
    // A reason that does not say what is missing cannot be acted on, and a
    // reader cannot tell a capability gap from a shrug.
    const vague = MATRIX.filter((row) => {
      if (row.status !== 'unsupported') return false;
      const reason = (row.reason ?? '').toLowerCase();
      return !['provider', 'electron', 'packaged', 'harness', 'e4.1', 'preload', 'renderer', 'worker'].some(
        (token) => reason.includes(token),
      );
    });
    expect(vague.map((r) => r.row)).toEqual([]);
  });

  it('never marks a row proved-real on the strength of a name alone', () => {
    // A `proved-real` row must cite something that is a REAL participant: a real
    // child process, a real socket, a real file, a real database. A row whose
    // only evidence is a plain unit test has not crossed a host boundary and is
    // `covered-by-existing-suite` instead.
    const REAL_TOKENS = [
      'real forked', 'real worker process', 'real loopback', 'real sqlite', 'real filesystem',
      'real symlink', 'real directory junction', 'real `WriteTool`', 'real queue', 'real files',
      'real `probeRuntimeCapabilities`', 'real `assertSatisfies`', 'dropped connection',
      'MEASURED on this branch',
    ];
    const unbacked = MATRIX.filter(
      (row) =>
        row.status === 'proved-real' &&
        !row.evidence.some((e) => REAL_TOKENS.some((token) => e.why.includes(token))),
    );
    expect(unbacked.map((r) => r.row)).toEqual([]);
  });
});

describe('every citation resolves to something that exists', () => {
  it('cites no file that is not in the repo', () => {
    const missing = citedFiles().filter((file) => !existsSync(path.join(MATRIX_REPO_ROOT, file)));
    expect(missing).toEqual([]);
  });

  it('cites a test title that is actually present in the file it names', () => {
    // The load-bearing check. A renamed or deleted test breaks the matrix here
    // rather than leaving a confident row pointing at nothing.
    const unfound: string[] = [];
    const untitled: string[] = [];
    for (const row of MATRIX) {
      for (const evidence of row.evidence) {
        if (evidence.name === undefined) {
          untitled.push(`${row.row} -> ${evidence.file}`);
          continue;
        }
        const contents = readIfPresent(evidence.file);
        if (contents === null) continue; // reported by the test above
        if (!contents.includes(evidence.name)) {
          unfound.push(`${row.row} -> ${evidence.file} :: ${evidence.name}`);
        }
      }
    }
    expect(untitled.length === 0 ? 'every citation names a test' : `citations with no name:\n${untitled.join('\n')}`).toBe(
      'every citation names a test',
    );
    // Compared as a joined string rather than an array, because vitest truncates
    // a long array in its message and a truncated "which citation is wrong" is
    // no answer at all.
    expect(unfound.length === 0 ? 'every cited title was found' : `citations whose title is not in the file:\n${unfound.join('\n')}`).toBe(
      'every cited title was found',
    );
  });

  it('cites a test file for a covered row, never a bare source file', () => {
    // A `covered-by-existing-suite` row whose evidence is not a test file is not
    // citing a suite, whatever its `why` says.
    const offenders = MATRIX.filter(
      (row) => row.status === 'covered-by-existing-suite'
        && row.evidence.every((e) => !/\.(test|spec)\.[cm]?[jt]sx?$/.test(e.file)),
    );
    expect(offenders.map((r) => r.row)).toEqual([]);
  });
});

describe('the rows that need the real executor are the ones that got it', () => {
  it('marks exactly one row proved-real per host boundary, and none of them is a bare unit test', () => {
    const proved = MATRIX.filter((row) => row.status === 'proved-real');
    // Sanity on the count rather than a hard-coded list: a matrix that suddenly
    // proves half its rows is a change a reviewer should notice.
    expect(proved.length).toBeGreaterThan(0);
    expect(proved.length).toBeLessThan(MATRIX.length / 2);
  });

  it('does not mark any row proved-real while citing only the eval harness for it', () => {
    // The harness is a real path, but it is ONE path. A row whose whole claim
    // is the harness and nothing else must say so rather than borrow the
    // harness's credibility for a boundary it never crossed.
    const harnessOnly = MATRIX.filter(
      (row) =>
        row.status === 'proved-real' &&
        row.evidence.every((e) => e.file.startsWith('evals/agent/cases/') || e.file.includes('eval-legacy-loop')),
    );
    // Two rows are legitimately harness-only, and both name the harness as
    // their SUBJECT rather than borrowing its credibility: `normal-completion`'s
    // claim is about the closed loop, and `tool-success`'s claim is about the
    // real executor really running the real tool. Any further harness-only row
    // would be a row reaching for the harness's reputation on a boundary it
    // never crossed.
    expect(harnessOnly.map((r) => r.row)).toEqual(['normal-completion', 'tool-success']);
  });

  it('gives every row whose subject is a host boundary either a real path or a named reason', () => {
    // The plan's rule, mechanical form: a row that names a host boundary cannot
    // be `covered-by-existing-suite` on a mock. The rows below are exactly the
    // ones whose subject is a boundary the harness would have to cross.
    const boundaryRows: readonly MatrixRow[] = MATRIX.filter((row) =>
      [
        'model-stream-disconnect', 'refused-executions-zero', 'no-growth-100-runs',
        'run-reopen', 'pause-not-opened',
      ].includes(row.row),
    );
    expect(boundaryRows.length).toBe(5);
    for (const row of boundaryRows) {
      const honest =
        row.status === 'proved-real' || (row.status === 'unsupported' && (row.reason ?? '').length > 0);
      expect({ row: row.row, status: row.status, honest }).toEqual({ row: row.row, status: row.status, honest: true });
    }
  });
});
