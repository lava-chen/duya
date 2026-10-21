/**
 * Plan-mode reminders — template tests (plan 413b).
 *
 * Verifies `renderReminder` wraps inner text in a `<system-reminder>`
 * block (the plan 408 convention shared with AGENTS.md injection) and
 * that each of the four templates carries its key instruction.
 */

import { describe, it, expect } from 'vitest';
import {
  renderReminder,
  fullReminder,
  sparseReminder,
  reentryReminder,
  exitReminder,
} from '../reminders.js';

describe('renderReminder', () => {
  it('wraps inner text in a <system-reminder> block', () => {
    const out = renderReminder('Do a thing');
    expect(out).toContain('<system-reminder>');
    expect(out).toContain('</system-reminder>');
    expect(out).toMatch(/<system-reminder>\nDo a thing\n<\/system-reminder>/);
  });
});

describe('reminder templates', () => {
  const PLAN_PATH = '/home/user/.duya/sessions/sess-1/plan.md';

  it('full reminder points at the plan file and the only-editable rule', () => {
    const text = fullReminder(PLAN_PATH);
    expect(text).toContain('Plan Mode');
    expect(text).toContain(PLAN_PATH);
    expect(text).toContain('ONLY');
    expect(text).toContain('file you are allowed to edit');
    expect(text).toContain('exit_plan_mode');
  });

  it('sparse reminder is a short plan-file restatement', () => {
    const text = sparseReminder();
    expect(text).toContain('Plan mode is still active');
    expect(text).toContain('plan file');
  });

  it('re-entry reminder announces a second entry and the plan path', () => {
    const text = reentryReminder(PLAN_PATH);
    expect(text.toLowerCase()).toContain('plan mode again');
    expect(text).toContain(PLAN_PATH);
  });

  it('exit reminder announces editing is allowed again', () => {
    const text = exitReminder();
    expect(text).toContain('You have exited Plan Mode');
    expect(text).toContain('make edits, run tools, and take actions');
  });

  it('sparse is meaningfully shorter than full (token saving)', () => {
    expect(sparseReminder().length).toBeLessThan(fullReminder(PLAN_PATH).length);
  });
});
