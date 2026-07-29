/**
 * assertValidApply.test.ts — U8 (Plan 202 §11.1)
 *
 * Verifies the apply-mode × checkpoint matrix encoded in `assertValidApply`.
 * The matrix is the single source of truth for "which apply modes are
 * permitted at which checkpoint" (Plan 202 §5.2). A drift between this
 * test and the production code means either the spec changed (update
 * both) or one of them is wrong.
 *
 * Coverage: every (checkpoint, mode) pair across the 9×6 grid — both
 * "permitted" and "forbidden" — is exercised, so an accidental widening
 * or narrowing of the matrix is caught.
 */

import { describe, it, expect } from 'vitest';
import { assertValidApply, isValidApply } from '../assertValidApply.js';
import { ApplyViolationError, type CheckpointType } from '../types.js';
import type { MailboxApplyMode } from '../../session/db.js';

const ALL_CHECKPOINTS: CheckpointType[] = [
  'before_model_turn',
  'after_model_turn',
  'before_tool_call',
  'after_tool_call',
  'before_file_write',
  'before_shell_command',
  'before_final_answer',
  'on_permission_request',
  'on_error_recovery',
];

const ALL_MODES: MailboxApplyMode[] = [
  'promote_to_user_message',
  'runtime_instruction',
  'tool_guard',
  'permission_context',
  'interrupt_signal',
  'deferred_to_next_turn',
];

/**
 * Ground truth for §5.2. The plan is the source of truth; this object is a
 * direct transcription. If a future PR changes §5.2, both the plan and this
 * table must be updated together.
 */
const PERMITTED_BY_CHECKPOINT: Record<CheckpointType, ReadonlyArray<MailboxApplyMode>> = {
  before_model_turn: [
    'promote_to_user_message',
    'runtime_instruction',
    'interrupt_signal',
  ],
  after_model_turn: [
    'runtime_instruction',
    'interrupt_signal',
    'deferred_to_next_turn',
  ],
  before_tool_call: [
    'tool_guard',
    'interrupt_signal',
    'runtime_instruction',
  ],
  after_tool_call: [
    'runtime_instruction',
    'tool_guard',
    'interrupt_signal',
    'deferred_to_next_turn',
  ],
  before_file_write: [
    'tool_guard',
    'interrupt_signal',
  ],
  before_shell_command: [
    'tool_guard',
    'interrupt_signal',
  ],
  // NOTE: `promote_to_user_message` at `before_final_answer` is special — it
  // triggers a NEW TURN, not a finalisation (Plan 202 §5.2 explicitly).
  before_final_answer: [
    'promote_to_user_message',
    'runtime_instruction',
    'interrupt_signal',
  ],
  on_permission_request: [
    'permission_context',
    'interrupt_signal',
  ],
  on_error_recovery: [
    'runtime_instruction',
    'interrupt_signal',
    'deferred_to_next_turn',
  ],
};

describe('assertValidApply — matrix acceptance', () => {
  for (const checkpoint of ALL_CHECKPOINTS) {
    const permitted = PERMITTED_BY_CHECKPOINT[checkpoint];
    for (const mode of permitted) {
      it(`accepts (${checkpoint}, ${mode})`, () => {
        expect(() => assertValidApply(checkpoint, mode)).not.toThrow();
        expect(isValidApply(checkpoint, mode)).toBe(true);
      });
    }
  }
});

describe('assertValidApply — matrix rejection', () => {
  for (const checkpoint of ALL_CHECKPOINTS) {
    const permitted = new Set(PERMITTED_BY_CHECKPOINT[checkpoint]);
    for (const mode of ALL_MODES) {
      if (permitted.has(mode)) continue;
      it(`rejects (${checkpoint}, ${mode}) with ApplyViolationError`, () => {
        expect(() => assertValidApply(checkpoint, mode)).toThrow(ApplyViolationError);
        try {
          assertValidApply(checkpoint, mode);
        } catch (err) {
          expect(err).toBeInstanceOf(ApplyViolationError);
          const violation = err as ApplyViolationError;
          expect(violation.checkpoint).toBe(checkpoint);
          expect(violation.mode).toBe(mode);
          expect(violation.name).toBe('ApplyViolationError');
          // Message should mention both for log readability.
          expect(violation.message).toContain(checkpoint);
          expect(violation.message).toContain(mode);
        }
      });
    }
  }
});

describe('isValidApply — predicate symmetry', () => {
  it('agrees with assertValidApply on every (checkpoint, mode) pair', () => {
    let permits = 0;
    let rejects = 0;
    for (const checkpoint of ALL_CHECKPOINTS) {
      for (const mode of ALL_MODES) {
        const predicate = isValidApply(checkpoint, mode);
        let throws = false;
        try {
          assertValidApply(checkpoint, mode);
        } catch {
          throws = true;
        }
        expect(predicate).toBe(!throws);
        if (predicate) permits += 1;
        else rejects += 1;
      }
    }
    // Sanity: the matrix has 25 permitted and 29 forbidden pairs (9×6 − 25 = 29).
    // Pin the count so an accidental drop in coverage is loud.
    expect(permits).toBe(25);
    expect(rejects).toBe(29);
  });
});

describe('ApplyViolationError — invariant I4 hint', () => {
  it('names the violated pair in the message', () => {
    // promote_to_user_message is forbidden at every tool-side checkpoint
    // because emitting a user message mid-tool-call would split the
    // tool_use → tool_result pair (I4). Use the canonical case.
    const err = new ApplyViolationError('before_tool_call', 'promote_to_user_message');
    expect(err.message).toContain('before_tool_call');
    expect(err.message).toContain('promote_to_user_message');
    expect(err.message).toContain('Plan 202 §5.2');
  });
});
