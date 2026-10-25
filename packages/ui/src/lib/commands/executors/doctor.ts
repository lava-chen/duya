/**
 * The `/doctor` executor — the Desktop's read-only diagnostic report.
 *
 * The report itself is assembled in the MAIN process: the renderer cannot
 * read the disk, and the facts a diagnostic needs (the plugin registry, the
 * core database, the process itself) all live there. The Desktop IS the
 * Host, so those facts are taken in place rather than over HTTP — which is
 * why `desktop` / `plugin` / `session` are real checks on this surface and
 * not "the desktop could not be reached".
 *
 * ## Rendering
 *
 * A report can run to dozens of checks, so the output is plain text in the
 * shared `CommandResultDialog` rather than a bespoke component.
 *
 * The one rule the rendering has to keep: "this check does not apply here"
 * (skipped) and "this check did not pass" (warning / error) must not look
 * alike. A skipped check is a fact about the environment; a failed check is
 * a fact about the system. They get different marks, and the summary counts
 * them separately.
 */

import type { CommandExecutorFn } from './registry';
import type { CommandContext, CommandResult } from '../types';
import { DOCTOR_CATEGORIES } from '@/contracts/doctor';
import type {
  DoctorCategory,
  DoctorCheck,
  DoctorReport,
  DoctorStatus,
} from '@/contracts/doctor';

/**
 * The categories, in presentation order.
 *
 * The SHARED list, not a local copy: the report the renderer draws is the
 * shared layer's report, and a renderer with its own category table would
 * drop a category the shared layer produced — which is exactly how the
 * original `database` check vanished.
 */
const CATEGORY_ORDER: readonly DoctorCategory[] = DOCTOR_CATEGORIES;

/**
 * The mark for a status.
 *
 * `○` (skipped) is deliberately not a warning mark: it means the check does
 * not apply in this environment, which is not a failure.
 */
const STATUS_MARK: Record<DoctorStatus, string> = {
  ok: '✓',
  warning: '!',
  error: '✕',
  skipped: '○',
};

/** The category a check belongs to, or `undefined` when it is unknown. */
function categoryOf(check: DoctorCheck): DoctorCategory | undefined {
  return CATEGORY_ORDER.includes(check.category) ? check.category : undefined;
}

/**
 * Render a report as the text the command dialog shows.
 *
 * Grouped by category, because the category is the field a reader scans for;
 * the check id is the field a reader searches for. The remedy of a failed
 * check is printed under it — a report that names a problem without saying
 * what to do about it has only moved the work to the reader.
 */
export function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push(`duya ${report.version} · ${report.profile}`);
  lines.push(
    `${report.summary.errors} 错误 · ${report.summary.warnings} 警告 · ` +
      `${report.summary.ok} 通过 · ${report.summary.skipped} 跳过`,
  );

  for (const category of CATEGORY_ORDER) {
    const checks = report.checks.filter((check) => categoryOf(check) === category);
    if (checks.length === 0) continue;
    lines.push('');
    lines.push(`[${category}]`);
    for (const check of checks) {
      lines.push(`${STATUS_MARK[check.status]} ${check.id} · ${check.message}`);
      if (check.hint) lines.push(`  → ${check.hint}`);
      for (const issue of check.issues ?? []) {
        lines.push(`  · ${issue.cause}`);
        if (issue.measured !== undefined) lines.push(`    实测：${issue.measured}`);
        if (issue.expected !== undefined) lines.push(`    期望：${issue.expected}`);
        // The hint already carries the fix for most checks; printing the
        // remedy twice would only make the report longer.
        if (issue.remedy !== check.hint) lines.push(`    修复：${issue.remedy}`);
      }
    }
  }

  return lines.join('\n');
}

export const DOCTOR_EXECUTORS: Record<string, CommandExecutorFn> = {
  /**
   * `/doctor` → the diagnostic report.
   *
   * The report is a read: it never touches the conversation and never
   * touches the disk, so it is safe to run while a turn is streaming.
   */
  doctor: async (ctx: CommandContext): Promise<CommandResult> => {
    const app = ctx.app;
    if (!app) return { type: 'error', message: '/doctor: app bridge unavailable' };
    if (!app.runDoctor) {
      return { type: 'error', message: '/doctor: 诊断通道不可用，请重启应用后再试。' };
    }

    let report: DoctorReport;
    try {
      report = await app.runDoctor();
    } catch (error) {
      return {
        type: 'error',
        message: `/doctor: 诊断失败（${error instanceof Error ? error.message : String(error)}）`,
      };
    }

    return { type: 'text', content: renderDoctorReport(report) };
  },
};
