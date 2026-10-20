/**
 * packages/cli/src/owned-sessions.ts
 *
 * The sessions a chat surface created, and the ones it may delete on the way
 * out.
 *
 * ## Why this exists
 *
 * A chat surface needs a Host session before it can run anything, so it
 * creates one when it opens. A surface that is opened and closed without a
 * message therefore leaves a row behind: a session with an empty timeline, a
 * placeholder title and nothing to resume. Left alone those rows pile up —
 * one per chat that was opened and closed — and every one of them is a ghost
 * in the session list.
 *
 * The resume picker skips empty sessions (see `listWorkspaceSessions` in
 * `chat.ts`), so a ghost is never offered to the user. This class closes the
 * other half of the problem: the row itself. A surface owns the sessions IT
 * created, and when it closes it deletes the ones that never received a
 * message.
 *
 * A session the user RESUMED is not owned by this process and is never
 * touched — it belongs to whoever created it, empty or not.
 */

import type { SessionId } from '@duya/agent-protocol';
import type { HostSessionHttpClient } from '@duya/host/http-client';

export class OwnedSessions {
  readonly #ids = new Set<SessionId>();
  /** Sessions a turn was started on, whatever the turn went on to do. */
  readonly #used = new Set<SessionId>();

  /** Record a session this process created. */
  own(sessionId: SessionId): void {
    this.#ids.add(sessionId);
  }

  /**
   * Record that a turn was started on a session.
   *
   * The Host does not write the user's message into the timeline: the worker
   * does, when it picks the prompt up. A turn that is cancelled before that
   * happens leaves the session empty even though the user typed something —
   * and an empty session is exactly what this class deletes. So a session a
   * turn was started on is never deleted, empty or not: what the user typed
   * may still be on its way into the timeline.
   */
  markUsed(sessionId: SessionId): void {
    this.#used.add(sessionId);
  }

  /**
   * Delete the owned sessions that never received a message.
   *
   * A session with content is left alone: it is a conversation the user can
   * come back to. A session a turn was started on is left alone for the
   * reason `markUsed` gives. "Empty" is measured with the Host's own
   * timeline count — the same number the session list shows — so this and
   * the resume picker agree on what the word means.
   *
   * Failures are swallowed on purpose: a chat that is closing must not fail
   * because a cleanup request did. The row stays, and the next surface that
   * owns it will try again.
   */
  async releaseEmpty(client: HostSessionHttpClient): Promise<void> {
    for (const sessionId of this.#ids) {
      if (this.#used.has(sessionId)) continue;
      try {
        if (await client.countTimeline(sessionId) > 0) continue;
        await client.delete(sessionId);
      } catch {
        // Leave the row behind rather than failing the exit.
      }
    }
    this.#ids.clear();
    this.#used.clear();
  }
}
