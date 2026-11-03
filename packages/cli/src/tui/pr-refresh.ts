/**
 * packages/cli/src/tui/pr-refresh.ts
 *
 * Reading the pull-request badge for a session, and the ONE network call that
 * reading is allowed to make.
 *
 * ## Why the refresh is bounded
 *
 * The Host's projection read never touches the hosting service — it answers
 * "what did we last see". The refresh (`POST /v1/integrations/sync`) is the
 * call that looks again, and it costs a `gh` round trip. A footer that
 * refreshed on every frame would turn a status line into a poll loop, so the
 * refresh happens at most once per session, and only when the projection is
 * empty (a session that already has a pull request is never re-observed).
 *
 * ## `no_checkpoints` is not a spent attempt
 *
 * The sync answers `no_checkpoints` when the session has no checkpoint refs
 * yet and `no_origin_remote` when the repository has no GitHub origin. Both
 * mean "there was nothing to look at", which is different from "we looked and
 * found nothing" — the first can become the second on the next turn, and
 * spending the one attempt on it would leave the badge empty for the rest of
 * the session.
 */

import type { HostIntegrationRecord, HostIntegrationSyncResult } from '@duya/agent-protocol';
import { pickPrBadge, type PrBadge } from './pr-badge.js';

export interface PrRefreshDeps {
  /** The projection read. Never touches the network. */
  readonly read: () => Promise<readonly HostIntegrationRecord[]>;
  /** The explicit refresh. Touches the hosting service. */
  readonly sync: () => Promise<HostIntegrationSyncResult>;
  /** Whether this session already spent its one sync attempt. */
  readonly alreadySynced: () => boolean;
  /** Record that this session spent its attempt. */
  readonly markSynced: () => void;
  /**
   * Whether a sync is allowed right now.
   *
   * False before the session has checkpoint refs: a sync then can only answer
   * "nothing to sync", and it would spend the attempt for nothing.
   */
  readonly allowSync: boolean;
}

/**
 * The badge for a session, or null when the Host knows of no pull request.
 *
 * A failed read throws: the caller decides what a missing badge means, and
 * this function has no opinion about it.
 */
export async function readPrBadge(deps: PrRefreshDeps): Promise<PrBadge | null> {
  let records = await deps.read();
  if (records.length === 0 && deps.allowSync && !deps.alreadySynced()) {
    const result = await deps.sync();
    // `no_checkpoints` and `no_origin_remote` mean the sync could not look
    // YET — that is not a spent attempt, so the next turn tries again.
    if (result.status === 'synced' || result.status === 'observation_failed') {
      deps.markSynced();
    }
    records = await deps.read();
  }
  return pickPrBadge(records);
}
