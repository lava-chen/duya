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
  it('full reminder states the read-only contract and allowed tools', () => {
    const text = fullReminder();
    expect(text).toContain('read-only');
    expect(text).toContain('Do NOT modify, create, or delete any files');
    expect(text).toContain('read, glob, grep');
  });

  it('sparse reminder is a short read-only restatement', () => {
    const text = sparseReminder();
    expect(text.toLowerCase()).toContain('read-only');
    expect(text).toContain('Plan mode is still active');
  });

  it('re-entry reminder announces a second entry into plan mode', () => {
    const text = reentryReminder();
    expect(text.toLowerCase()).toContain('plan mode again');
    expect(text).toContain('read-only');
  });

  it('exit reminder announces editing is allowed again', () => {
    const text = exitReminder();
    expect(text).toContain('You have exited Plan Mode');
    expect(text).toContain('make edits, run tools, and take actions');
  });

  it('sparse is meaningfully shorter than full (token saving)', () => {
    expect(sparseReminder().length).toBeLessThan(fullReminder().length);
  });
});
