/**
 * Plan-mode reminder templates (plan 413b).
 *
 * Covers the `<system-reminder>` wrapper and the key directive in each of the
 * four templates.
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
  it('wraps inner text in a <system-reminder> boundary', () => {
    const out = renderReminder('body');
    expect(out.startsWith('<system-reminder>\n')).toBe(true);
    expect(out.endsWith('\n</system-reminder>')).toBe(true);
    expect(out).toContain('body');
  });
});

describe('plan-mode reminder templates', () => {
  it('full reminder states the read-only contract and tool set', () => {
    const r = fullReminder();
    expect(r).toContain('# Plan Mode Active');
    expect(r).toContain('read-only analysis');
    expect(r).toContain('Do NOT modify, create, or delete any files');
    expect(r).toContain('do NOT execute side-effectful commands');
    expect(r).toContain('Use only read-only tools');
    expect(r).toContain('session_search');
    expect(r).toContain('structured implementation plan');
  });

  it('sparse reminder is a short read-only nudge', () => {
    const r = sparseReminder();
    expect(r).toContain('Plan mode is still active');
    expect(r).toContain('Read-only');
  });

  it('reentry reminder frames a second entry into plan mode', () => {
    const r = reentryReminder();
    expect(r).toContain('## Returning to Plan Mode');
    expect(r).toContain('entering Plan Mode again');
    expect(r).toContain('read-only');
  });

  it('exit reminder announces editable capability', () => {
    const r = exitReminder();
    expect(r).toContain('exited Plan Mode');
    expect(r).toContain('can now make edits');
  });

  it('templates are raw inner text; renderReminder applies the boundary', () => {
    const templates = [
      fullReminder(),
      sparseReminder(),
      reentryReminder(),
      exitReminder(),
    ];
    for (const t of templates) {
      expect(t).not.toContain('<system-reminder>');
    }
  });
});
