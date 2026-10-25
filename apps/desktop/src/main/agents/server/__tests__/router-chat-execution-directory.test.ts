/**
 * router-chat-execution-directory.test.ts — the chat turn's half of the
 * checkout cursor (plan 621, P1b–P4).
 *
 * A session that has switched checkouts no longer trusts the client's
 * `workingDirectory`: the persisted execution location is the fact. The
 * decision is extracted as `decideChatExecutionDirectory` because it is
 * the part with a contract the renderer and the worker both rely on:
 *
 *   - a session that never switched (revision 0, no row) runs where the
 *     client said — the override must not exist for ordinary sessions;
 *   - a pending transition refuses the run (the handler answers 409);
 *   - a settled cursor pins the run to the PERSISTED directory and stamps
 *     `checkoutExecutionRevision`, so a run assembled before a switch
 *     cannot execute after it.
 *
 * What is deliberately not here: the 409/503 wiring itself. It is three
 * lines of `sendJson` around this decision inside `handlePostChat`; the
 * decision above is the part worth pinning.
 */
import { describe, expect, it } from 'vitest';
import { decideChatExecutionDirectory } from '../router';

describe('decideChatExecutionDirectory', () => {
  it('trusts the client when the session has no persisted cursor', () => {
    expect(decideChatExecutionDirectory(undefined, { mode: 'plan' })).toEqual({ kind: 'client' });
    expect(decideChatExecutionDirectory(null, undefined)).toEqual({ kind: 'client' });
    expect(
      decideChatExecutionDirectory(
        { working_directory: 'C:/repo' },
        { mode: 'plan' },
      ),
    ).toEqual({ kind: 'client' });
    // A zero revision is the "never switched" encoding, not a switch.
    expect(
      decideChatExecutionDirectory(
        { working_directory: 'C:/repo', executionLocation: { revision: 0 } },
        {},
      ),
    ).toEqual({ kind: 'client' });
  });

  it('refuses the run while a transition is pending recovery', () => {
    const decision = decideChatExecutionDirectory(
      { working_directory: 'C:/repo', executionLocation: { revision: 3, pending: { id: 'op-1' } } },
      {},
    );
    expect(decision).toEqual({ kind: 'recover-transition' });
  });

  it('pins a settled cursor to the persisted directory and stamps the revision', () => {
    const options = { mode: 'plan', nested: { keep: true } };
    const decision = decideChatExecutionDirectory(
      { working_directory: 'C:/repo/.duya-worktrees/task-1', executionLocation: { revision: 5, pending: null } },
      options,
    );
    expect(decision).toEqual({
      kind: 'pinned',
      workingDirectory: 'C:/repo/.duya-worktrees/task-1',
      options: { mode: 'plan', nested: { keep: true }, checkoutExecutionRevision: 5 },
    });
    // The caller's options object is not mutated: the run's options are a
    // new object, so a rejected request cannot leave half a stamp behind.
    expect(options).toEqual({ mode: 'plan', nested: { keep: true } });
  });

  it('pins even when the persisted directory is absent, rather than guessing', () => {
    // A row with a revision but no working_directory is a corrupt state the
    // Host refuses to serve as a fact; the decision must not silently fall
    // back to the client cache — it pins to undefined, which the run
    // admission path then rejects, instead of executing somewhere stale.
    const decision = decideChatExecutionDirectory(
      { executionLocation: { revision: 2, pending: null } },
      {},
    );
    expect(decision.kind).toBe('pinned');
    if (decision.kind === 'pinned') {
      expect(decision.workingDirectory).toBeUndefined();
      expect(decision.options.checkoutExecutionRevision).toBe(2);
    }
  });
});
