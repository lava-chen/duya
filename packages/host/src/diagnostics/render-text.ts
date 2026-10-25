/**
 * packages/host/src/diagnostics/render-text.ts
 *
 * The two human-facing renderings of a doctor report.
 *
 *  - {@link renderText} — the plain-text report the `duya doctor` command
 *    prints. Absolute paths stay: a `chmod 600 "<path>"` hint the user cannot
 *    copy and run is not a hint.
 *  - {@link renderDoctorPanel} — the line array a scrollable panel renders
 *    (the CLI TUI's `/doctor`, and the Desktop's own panel).
 *
 * ## Why both iterate DOCTOR_CATEGORIES
 *
 * The renderer used to group by its own hand-written list of categories,
 * which was SHORTER than the `CheckResult.category` union: a check whose
 * category was in the union but not in the render list was not rendered badly
 * — it was not rendered AT ALL, and vanished from the report without a trace.
 *
 * Both renderers now walk {@link DOCTOR_CATEGORIES}, and the category type is
 * derived from that same list, so the type and the rendering cannot drift
 * apart again.
 *
 * ## Why a panel group can say "not checked"
 *
 * "This Host could not answer" and "this check did not pass" are different
 * claims, and a panel that draws them the same way teaches the reader to
 * treat a missing Host as a broken install. A group whose checks are ALL
 * `skipped` was not verified at all, and says so.
 */

import { DOCTOR_CATEGORIES, type CheckResult, type DoctorResult } from './types.js';

/** The status label each check status renders as. */
const STATUS_LABEL: Record<CheckResult['status'], string> = {
  ok: '[OK]',
  warning: '[WARNING]',
  error: '[ERROR]',
  skipped: '[SKIPPED]',
};

/** The summary line both renderings end with. */
function summaryLine(result: DoctorResult): string {
  return (
    `Summary: ${result.summary.errors} error${result.summary.errors !== 1 ? 's' : ''}, ` +
    `${result.summary.warnings} warning${result.summary.warnings !== 1 ? 's' : ''}, ` +
    `${result.summary.skipped} skipped, ` +
    `${result.summary.ok} ok`
  );
}

/**
 * Render doctor result as human-readable text.
 *
 * Exported so the structured-issue rendering is testable without shelling out
 * to the command; the report shape it consumes is the public `DoctorResult`.
 */
export function renderText(result: DoctorResult): string {
  const lines: string[] = [
    'DUYA Doctor — Read-Only Diagnostic Report',
    '==========================================',
    '',
  ];

  // Group by category. The list is the same constant the category type is
  // derived from, so a category can never be typed but not rendered.
  for (const cat of DOCTOR_CATEGORIES) {
    const catChecks = result.checks.filter((c) => c.category === cat);
    if (catChecks.length === 0) continue;

    lines.push(`[${cat}]`);
    for (const check of catChecks) {
      const prefix = STATUS_LABEL[check.status];
      lines.push(`${prefix.padEnd(12)} ${check.message}`);
      if (check.hint) {
        lines.push(`            → ${check.hint}`);
      }
      // Structured issues exist for support tooling, but the human report is
      // where a user reads the fix, so measured/expected are printed rather
      // than hidden in the JSON view.
      for (const issue of check.issues ?? []) {
        lines.push(`            · ${issue.cause}`);
        if (issue.measured !== undefined) {
          lines.push(`              measured: ${issue.measured}`);
        }
        if (issue.expected !== undefined) {
          lines.push(`              expected: ${issue.expected}`);
        }
        // The hint already prints the same command for migrated checks; showing
        // the remedy twice would make the report worse, not better.
        if (issue.remedy !== check.hint) {
          lines.push(`              fix: ${issue.remedy}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(summaryLine(result));

  return lines.join('\n');
}

/**
 * Render a doctor report as the line array a scrollable panel shows.
 *
 * Grouped by {@link DOCTOR_CATEGORIES}, in the same order the plain-text
 * report uses, so the two never describe the same report differently.
 */
export function renderDoctorPanel(result: DoctorResult): string[] {
  const lines: string[] = ['Duya doctor — read-only diagnostic', ''];

  for (const cat of DOCTOR_CATEGORIES) {
    const catChecks = result.checks.filter((c) => c.category === cat);
    if (catChecks.length === 0) continue;

    // Every check in this group was skipped, so nothing in this group was
    // actually verified. Say that, rather than letting a column of skipped
    // rows read as a column of failures.
    const notChecked = catChecks.every((check) => check.status === 'skipped');
    lines.push(notChecked ? `  [${cat}]  (not checked)` : `  [${cat}]`);

    for (const check of catChecks) {
      const prefix = STATUS_LABEL[check.status];
      lines.push(`    ${prefix.padEnd(11)}${check.message}`);
      if (check.hint) {
        lines.push(`               → ${check.hint}`);
      }
      for (const issue of check.issues ?? []) {
        lines.push(`               · ${issue.cause}`);
        if (issue.measured !== undefined) {
          lines.push(`                 measured: ${issue.measured}`);
        }
        if (issue.expected !== undefined) {
          lines.push(`                 expected: ${issue.expected}`);
        }
        if (issue.remedy !== check.hint) {
          lines.push(`                 fix: ${issue.remedy}`);
        }
      }
    }
    lines.push('');
  }

  lines.push(`  ${summaryLine(result)}`);
  lines.push('');
  lines.push('  Source: the local config and runtime files, and the Host\'s own API.');

  return lines;
}
