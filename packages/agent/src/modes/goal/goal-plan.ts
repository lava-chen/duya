/**
 * Goal plan helpers (grok-learning pass).
 *
 * Mirrors grok's `goal_planner.rs` (plan file) + `goal_next_step.rs`
 * (next-step mining), duya-ized:
 *
 *  - `extractNextStep` — mine the first unchecked `- [ ]` markdown
 *    checkbox from the goal's plan file (grok `first_unchecked_plan_item`).
 *    The mined step is inlined into the per-round continuation so the
 *    model always has a concrete next action instead of re-attacking the
 *    whole objective. Returns `undefined` when there is no plan file, no
 *    unchecked item, or the read fails — the caller falls back to the
 *    generic "keep working" guidance.
 *
 * Design notes (grok goal_next_step.rs):
 *  - reads capped at 8 KiB so a runaway plan cannot blow up the context;
 *  - `## Task checklist` section is preferred; outside it, the whole file
 *    is scanned except `## Non-goals` / `## Deviations`;
 *  - numbered `## Acceptance criteria` are NOT mined (they are the judged
 *    contract, never checked off — mining criterion 1 would repeat a stale
 *    line forever);
 *  - the mined step is plain text in the nudge, never a file pointer.
 *
 * A lightweight planner (`writeGoalPlan`) writes the initial plan file
 * from the objective so `extractNextStep` has something to mine — the
 * model is told to keep the checklist current with `- [x]` as it works.
 */

import * as fs from 'fs';
import * as path from 'path';

/** 8 KiB cap on per-file reads (grok `MAX_READ_BYTES`). */
export const MAX_PLAN_READ_BYTES = 8 * 1024;

/**
 * Read up to `MAX_PLAN_READ_BYTES` from a plan file. Returns undefined on
 * any I/O failure. When the buffer reaches the cap, the trailing
 * potentially-incomplete line is dropped so a bullet spanning the cap
 * boundary cannot leak a half-truncated tail upstream.
 */
export function readPlanCapped(path: string): string | undefined {
  try {
    const stat = fs.statSync(path);
    if (stat.size === 0) return '';
    const fd = fs.openSync(path, 'r');
    const buf = Buffer.alloc(Math.min(stat.size, MAX_PLAN_READ_BYTES));
    const bytes = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    let text = buf.subarray(0, bytes).toString('utf-8');
    // Drop the trailing potentially-incomplete line at the cap boundary:
    // keep everything through the last complete newline so no half-truncated
    // bullet leaks upstream (grok: `buf.truncate(last_nl)` semantics).
    if (stat.size >= MAX_PLAN_READ_BYTES) {
      const lastNl = text.lastIndexOf('\n');
      if (lastNl !== -1) text = text.slice(0, lastNl + 1);
    }
    return text;
  } catch {
    return undefined;
  }
}

/**
 * Mine the first unchecked markdown checkbox from a plan body.
 *
 * Rules (grok `extract_first_unchecked`):
 *  - `- [ ]` / `* [ ]` / `+ [ ]` are candidates; `- [x]` / `- [X]` skipped;
 *  - a `## Task checklist` section restricts mining to its checkboxes;
 *  - `## Non-goals` and `## Deviations` sections are never mined;
 *  - `## Acceptance criteria` numbering is never mined;
 *  - returns undefined when no unchecked item remains.
 * Pure — exhaustively unit-testable.
 */
export function extractNextStep(planBody: string): string | undefined {
  const lines = planBody.split('\n');
  let hasTaskChecklist = false;
  let inTaskChecklist = false;
  let inSkipSection = false;
  const candidates: string[] = [];
  const checklistCandidates: string[] = [];

  for (const raw of lines) {
    const line = raw.trim();
    // Track section scope by markdown headers.
    if (line.startsWith('#')) {
      const heading = line.replace(/^#+\s*/, '').toLowerCase();
      const isTaskChecklist = heading.startsWith('task checklist');
      if (isTaskChecklist) hasTaskChecklist = true;
      inTaskChecklist = isTaskChecklist;
      inSkipSection =
        heading.startsWith('non-goals') || heading.startsWith('deviations');
      continue;
    }
    if (inSkipSection) continue;
    const match = line.match(/^([-*+]\s)\[([ xX])\]\s*(.+)$/);
    if (!match || match[2] !== ' ') continue;
    const step = match[3]!.trim();
    if (!step) continue;
    if (inTaskChecklist) checklistCandidates.push(step);
    else candidates.push(step);
  }
  // Task checklist section wins when present (grok: only its checkboxes are
  // mined); otherwise the whole-file scan (already excluding Non-goals /
  // Deviations via inSkipSection).
  const pool = hasTaskChecklist ? checklistCandidates : candidates;
  return pool[0];
}

/**
 * Write an initial plan file from the objective. The plan is a simple
 * markdown checklist seeded with the objective as the first unchecked
 * item plus a task-checklist header, so `extractNextStep` has content to
 * mine from round one. The model is expected to keep the checklist
 * current (`- [x]` as items complete). Best-effort — a write failure
 * returns false and the goal proceeds without a plan (continuation falls
 * back to the generic guidance).
 */
export function writeGoalPlan(planPath: string, objective: string): boolean {
  const trimmed = objective.trim();
  if (!trimmed) return false;
  const body = [
    '# Goal Plan',
    '',
    `## Objective`,
    trimmed,
    '',
    `## Task checklist`,
    `- [ ] ${trimmed}`,
    '',
  ].join('\n');
  try {
    fs.mkdirSync(path.dirname(planPath), { recursive: true });
    fs.writeFileSync(planPath, body, 'utf-8');
    return true;
  } catch {
    return false;
  }
}
