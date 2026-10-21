/**
 * Goal plan helpers tests (grok-learning pass: goal_planner + goal_next_step).
 *
 * Verifies the next-step mining rules (task checklist preference, section
 * scoping, acceptance-criteria exclusion, completion detection) and the
 * plan write/read round-trip.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  extractNextStep,
  readPlanCapped,
  writeGoalPlan,
  MAX_PLAN_READ_BYTES,
} from '../goal-plan.js';

let TMP = '';

beforeEach(() => {
  TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'goal-plan-test-'));
});

afterEach(() => {
  try {
    fs.rmSync(TMP, { recursive: true, force: true });
  } catch {
    // ignore
  }
});

describe('extractNextStep', () => {
  it('returns the first unchecked checkbox', () => {
    const body = [
      '# Plan',
      '- [x] done item',
      '- [ ] first open',
      '- [ ] second open',
    ].join('\n');
    expect(extractNextStep(body)).toBe('first open');
  });

  it('returns undefined when everything is checked', () => {
    const body = ['- [x] a', '- [X] b'].join('\n');
    expect(extractNextStep(body)).toBeUndefined();
  });

  it('prefers the Task checklist section over other checkboxes', () => {
    const body = [
      '## Objective',
      '- [ ] objective-scoped item',
      '## Task checklist',
      '- [x] done',
      '- [ ] checklist item',
    ].join('\n');
    expect(extractNextStep(body)).toBe('checklist item');
  });

  it('never mines Non-goals / Deviations / Acceptance criteria', () => {
    const body = [
      '## Acceptance criteria',
      '1. criterion one (never mined)',
      '## Non-goals',
      '- [ ] out of scope',
      '## Deviations',
      '- [ ] not a real task',
      '## Task checklist',
      '- [ ] the real next step',
    ].join('\n');
    expect(extractNextStep(body)).toBe('the real next step');
  });

  it('handles no checkboxes at all', () => {
    expect(extractNextStep('just prose')).toBeUndefined();
    expect(extractNextStep('')).toBeUndefined();
  });
});

describe('readPlanCapped', () => {
  it('reads a plan file and returns undefined on missing file', () => {
    const p = path.join(TMP, 'plan.md');
    fs.writeFileSync(p, '# Plan\n- [ ] step\n', 'utf-8');
    expect(readPlanCapped(p)).toContain('step');
    expect(readPlanCapped(path.join(TMP, 'nope.md'))).toBeUndefined();
  });

  it('caps reads at MAX_PLAN_READ_BYTES and drops the trailing partial line', () => {
    const p = path.join(TMP, 'big.md');
    const line = 'x'.repeat(200) + '\n';
    fs.writeFileSync(p, line.repeat(100), 'utf-8'); // 20 KiB total
    const read = readPlanCapped(p);
    expect(read!.length).toBeLessThanOrEqual(MAX_PLAN_READ_BYTES);
    // No half-truncated bullet line leaks through.
    expect(read!.endsWith('\n')).toBe(true);
  });
});

describe('writeGoalPlan', () => {
  it('writes a plan whose first unchecked item mines back', () => {
    const p = path.join(TMP, 'sub', 'plan.md');
    expect(writeGoalPlan(p, 'Migrate auth')).toBe(true);
    expect(fs.existsSync(p)).toBe(true);
    const body = fs.readFileSync(p, 'utf-8');
    expect(body).toContain('## Task checklist');
    expect(extractNextStep(body)).toBe('Migrate auth');
  });

  it('refuses an empty objective', () => {
    expect(writeGoalPlan(path.join(TMP, 'p.md'), '   ')).toBe(false);
  });
});
