/**
 * evals/agent/matrix/section.ts — the matrix, as a section of the eval report.
 *
 * ## The mapping rule, and why it never produces `pass`
 *
 * The eval vocabulary (`pass` / `fail` / `unknown` / `skipped`) describes a check
 * that RAN. Most matrix rows did not run under this runner: they are already
 * owned by another suite, and re-running forty foreign suites from the eval
 * runner would make it minutes long and would turn a report into a second
 * `npm test`. So the honest mapping is:
 *
 *   proved-real               `skipped` — this runner did not execute the row's
 *                             evidence. The proof is named, and `skipped`
 *                             outranks `pass` in `../evaluators/suite.ts`, so
 *                             the row can never be read as a green check.
 *   covered-by-existing-suite `skipped` — same, with the owning suite named.
 *   unsupported               `skipped`, with the reason and the missing
 *                             capability in the detail.
 *
 * Every row therefore lands as `skipped`, and the extended suite exits 2. That
 * is the correct outcome, not a defect: this runner proves the harness cases and
 * nothing else, and a report that said otherwise would be the exact failure the
 * plan warns about. A future slice that runs a row's evidence inside the runner
 * should replace that row's `skipped` with a real `pass`/`fail` — and the
 * verifier in `./matrix.test.ts` will still hold the citation.
 *
 * ## `unknown` is not used here, deliberately
 *
 * `unknown` means "the check ran and the system would not tell me". A row that
 * was never executed is not that; it is `skipped`, which means "reach was not
 * proven". Using `unknown` for a coverage ledger would claim the SYSTEM was
 * uninformative when the truth is that the evaluation did not ask.
 */

import { fileURLToPath } from 'node:url';
import { skipped, type AttributedLayer, type CheckResult } from '../evaluators/layer';
import { MATRIX, MATRIX_GROUPS, type MatrixGroup, type MatrixRow } from './rows';

/** Repo root, resolved from this file (`evals/agent/matrix/` is three levels down). */
export const MATRIX_REPO_ROOT = fileURLToPath(new URL('../../..', import.meta.url));

/** Stable, greppable check id for one row. */
export function matrixCheckId(row: MatrixRow): string {
  return `matrix/${row.group}/${row.row}`;
}

export interface MatrixGroupSummary {
  readonly group: MatrixGroup;
  /** Counts by status, so a reader sees the shape of a group at a glance. */
  readonly provedReal: number;
  readonly coveredByExistingSuite: number;
  readonly unsupported: number;
  readonly rows: readonly {
    readonly row: string;
    readonly status: MatrixRow['status'];
    readonly checkId: string;
    /** The failing layer a non-passing check attributes to. Always `environment`
     *  for a `skipped` check; carried explicitly so the report's `byLayer` tally
     *  and this section cannot disagree. */
    readonly layer: AttributedLayer;
    readonly evidence: readonly { readonly file: string; readonly name?: string }[];
    readonly reason?: string;
    readonly divergence?: string;
  }[];
}

export interface MatrixSection {
  readonly rows: number;
  readonly provedReal: number;
  readonly coveredByExistingSuite: number;
  readonly unsupported: number;
  /** Every group, in the plan's order. */
  readonly groups: readonly MatrixGroupSummary[];
  /**
   * Capabilities the whole matrix does NOT prove, deduped from the unsupported
   * rows. Reported so a reader sees the shape of the gap, not 56 rows to scan.
   */
  readonly unsupportedCapabilities: readonly string[];
}

/**
 * One `CheckResult` per matrix row.
 *
 * `skipped` for all three statuses, deliberately. See the header: this runner did
 * not execute these rows' evidence, and `skipped` is the eval vocabulary's word
 * for exactly that.
 */
export function matrixChecks(): readonly CheckResult[] {
  return MATRIX.map((row) => {
    const id = matrixCheckId(row);
    switch (row.status) {
      case 'proved-real':
        return skipped(
          id,
          'structure',
          `proved on a real path, but not by this runner: ${row.evidence.map((e) => e.file).join(', ')}`,
          row.evidence.map((e) => (e.name === undefined ? e.file : `${e.file} :: ${e.name}`)).join(' | '),
        );
      case 'covered-by-existing-suite':
        return skipped(
          id,
          'structure',
          `already asserted by an existing suite, and deliberately not re-asserted here: ${row.evidence.map((e) => e.file).join(', ')}`,
          row.evidence.map((e) => (e.name === undefined ? e.file : `${e.name}`)).join(' | '),
        );
      case 'unsupported':
        return skipped(
          id,
          'structure',
          `UNSUPPORTED: ${row.reason ?? 'no reason recorded'}`,
          row.evidence.map((e) => e.file).join(' | '),
        );
    }
  });
}

/** The matrix as report data. */
export function matrixSection(): MatrixSection {
  const groups: MatrixGroupSummary[] = MATRIX_GROUPS.map((group) => {
    const rows = MATRIX.filter((row) => row.group === group);
    return {
      group,
      provedReal: rows.filter((r) => r.status === 'proved-real').length,
      coveredByExistingSuite: rows.filter((r) => r.status === 'covered-by-existing-suite').length,
      unsupported: rows.filter((r) => r.status === 'unsupported').length,
      rows: rows.map((row) => ({
        row: row.row,
        status: row.status,
        checkId: matrixCheckId(row),
        layer: 'environment' as const,
        evidence: row.evidence.map((e) =>
          e.name === undefined ? { file: e.file } : { file: e.file, name: e.name },
        ),
        ...(row.reason === undefined ? {} : { reason: row.reason }),
        ...(row.divergence === undefined ? {} : { divergence: row.divergence }),
      })),
    };
  });

  return {
    rows: MATRIX.length,
    provedReal: MATRIX.filter((r) => r.status === 'proved-real').length,
    coveredByExistingSuite: MATRIX.filter((r) => r.status === 'covered-by-existing-suite').length,
    unsupported: MATRIX.filter((r) => r.status === 'unsupported').length,
    groups,
    unsupportedCapabilities: MATRIX.filter((r) => r.status === 'unsupported').map((r) => `${r.group}/${r.row}`),
  };
}

/** A one-line-per-row human rendering, for a terminal. */
export function formatMatrix(section: MatrixSection): string[] {
  const lines: string[] = [];
  for (const group of section.groups) {
    lines.push(
      `  ${group.group}  (proved-real ${group.provedReal} · covered ${group.coveredByExistingSuite} · unsupported ${group.unsupported})`,
    );
    for (const row of group.rows) {
      const mark = row.status === 'proved-real' ? 'R' : row.status === 'unsupported' ? 'U' : 'C';
      lines.push(`    [${mark}] ${row.row.padEnd(28)} ${row.evidence[0]?.file ?? '(none)'}`);
    }
  }
  lines.push(
    `  matrix: ${section.rows} rows — proved-real ${section.provedReal}, covered by an existing suite ${section.coveredByExistingSuite}, unsupported ${section.unsupported}`,
  );
  return lines;
}
