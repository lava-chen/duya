/**
 * The category list is the single source of truth.
 *
 * ## The bug this pins
 *
 * `CheckResult.category` was a hand-written union that included `'database'`,
 * while the text renderer grouped by a SEPARATE, shorter hand-written list
 * that did not. A check whose category was in the union but not in the render
 * list was not rendered badly — it was not rendered AT ALL. It vanished from
 * the report with no trace, which is the worst possible failure for a
 * diagnostic: the reader cannot tell "nothing is wrong" from "this was never
 * checked".
 *
 * The fix is structural, not a patch: the union is DERIVED from the list, so
 * a category that is not listed does not exist and a category that is listed
 * is always rendered.
 */

import { describe, expect, it } from 'vitest';

import {
  DOCTOR_CATEGORIES,
  finalizeDoctorResult,
  renderDoctorPanel,
  renderText,
  type CheckResult,
} from '../src/diagnostics/index.js';

describe('doctor categories', () => {
  it('lists every category the report can carry', () => {
    expect(DOCTOR_CATEGORIES).toEqual([
      'config',
      'runtime',
      'desktop',
      'database',
      'plugin',
      'session',
    ]);
  });

  it('renders a check in the category that used to vanish', () => {
    // The load-bearing case: 'database' was typed but not rendered.
    const checks: CheckResult[] = [{
      id: 'database_readable',
      category: 'database',
      status: 'error',
      message: 'Cannot open the session database',
    }];
    const result = finalizeDoctorResult(checks);

    const text = renderText(result);
    expect(text).toContain('[database]');
    expect(text).toContain('Cannot open the session database');

    const panel = renderDoctorPanel(result).join('\n');
    expect(panel).toContain('[database]');
    expect(panel).toContain('Cannot open the session database');
  });

  it('groups one group per listed category, in the list order', () => {
    // A renderer that iterated its own table could still order the groups
    // differently from the list the type is derived from.
    const checks: CheckResult[] = DOCTOR_CATEGORIES.map((category, index) => ({
      id: `check_${index}`,
      category,
      status: 'ok',
      message: `message ${index}`,
    }));

    const text = renderText(finalizeDoctorResult(checks));
    const order = [...text.matchAll(/^\[(\w+)]$/gm)].map((match) => match[1]);
    expect(order).toEqual([...DOCTOR_CATEGORIES]);
  });

  it('drops no check from either rendering', () => {
    // The invariant behind the bug: every check that was collected is
    // visible somewhere in the report.
    const checks: CheckResult[] = DOCTOR_CATEGORIES.map((category, index) => ({
      id: `check_${index}`,
      category,
      status: 'ok',
      message: `unique message ${index}`,
    }));

    const result = finalizeDoctorResult(checks);
    const text = renderText(result);
    const panel = renderDoctorPanel(result).join('\n');
    for (const check of checks) {
      expect(text, check.id).toContain(check.message);
      expect(panel, check.id).toContain(check.message);
    }
    expect(result.summary.ok).toBe(checks.length);
  });
});
