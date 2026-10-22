/**
 * Host-side implementation of `HostIntegrationApiV1` (plan 621, slice B).
 *
 * ## Reads are the projection, `observeForPr` is the reconcile entry
 *
 * `observeForSession` answers from the `integrations` table and never calls
 * GitHub: a chat panel that polls it must not hammer the network, and the answer
 * it needs is "what did we last see", not "what is true right now". Refreshing
 * is the explicit act, `observeForPr`, which re-reads the PR and writes the new
 * observation over the old one (§4.6, Integration row).
 *
 * ## The observer is injected
 *
 * The actual `gh` call belongs to slice C (`packages/host/src/scm/`). B only
 * names the callback. When it is absent — a Host without `gh`, or a Desktop
 * build that has not wired it yet — the answer is `unknown` with
 * `observedError: 'observer_unavailable'`, never `open`. That value is written
 * down like any other observation, because "we tried and could not look" is
 * exactly as informative as a successful read, and it must not silently expire.
 */

import type {
  HostIntegrationApiV1,
  HostIntegrationRecord,
} from '@duya/agent-protocol';
import type { IntegrationRow, IntegrationStore } from '@duya/data';

/** Reads one PR from the hosting service. Slice C provides the real one. */
export type ObserveIntegrationPr = (repo: string, prNumber: number) => Promise<HostIntegrationRecord>;

/** Reason recorded when the Host has no observer configured at all. */
export const INTEGRATION_OBSERVER_UNAVAILABLE = 'observer_unavailable';

export interface CreateHostIntegrationApiOptions {
  /** The observed projection. Required: without it there is nothing to answer from. */
  readonly store: IntegrationStore;
  /** Slice C's read-only observer; absent leaves every refresh `unknown`. */
  readonly observePr?: ObserveIntegrationPr;
}

export function createHostIntegrationApi(options: CreateHostIntegrationApiOptions): HostIntegrationApiV1 {
  const { store } = options;

  return {
    async observeForSession(sessionId) {
      requireNonEmpty(sessionId, 'sessionId');
      return store.listForSession(sessionId).map(toRecord);
    },

    async observeForPr(repo, prNumber) {
      requireNonEmpty(repo, 'repo');
      requirePrNumber(prNumber);
      const observed = options.observePr === undefined
        ? unavailable(repo, prNumber)
        : await options.observePr(repo, prNumber);
      // The request, not the observer, decides the key: an observer that echoes
      // a different PR must not write its row under this one.
      const record: HostIntegrationRecord = {
        repo,
        prNumber,
        state: observed.state,
        headSha: observed.headSha,
        baseRef: observed.baseRef,
        url: observed.url,
        observedAt: observed.observedAt,
        observedError: observed.observedError,
      };
      if (record.state === 'unknown' && (record.observedError ?? '').trim() === '') {
        // §4.4 pairs the two. An `unknown` without a reason cannot be shown and
        // cannot be acted on, so it is a producer bug rather than a state.
        throw new Error('integration-api: observer reported unknown without observedError');
      }
      store.upsertObservation({
        repo: record.repo,
        prNumber: record.prNumber,
        state: record.state,
        headSha: record.headSha,
        baseRef: record.baseRef,
        url: record.url,
        observedError: record.observedError,
        observedAt: record.observedAt,
      });
      return record;
    },

    async linkSession(repo, prNumber, sessionId) {
      requireNonEmpty(repo, 'repo');
      requirePrNumber(prNumber);
      requireNonEmpty(sessionId, 'sessionId');
      store.linkSession({ repo, prNumber, sessionId });
    },
  };
}

function toRecord(row: IntegrationRow): HostIntegrationRecord {
  return {
    repo: row.repo,
    prNumber: row.pr_number,
    state: row.observed_state,
    headSha: row.observed_head_sha,
    baseRef: row.observed_base_ref,
    url: row.observed_url,
    observedAt: row.observed_at,
    observedError: row.observed_error,
  };
}

function unavailable(repo: string, prNumber: number): HostIntegrationRecord {
  return {
    repo,
    prNumber,
    // Never `open`: we did not look, and saying otherwise fabricates a fact.
    state: 'unknown',
    headSha: null,
    baseRef: null,
    url: null,
    observedAt: Date.now(),
    observedError: INTEGRATION_OBSERVER_UNAVAILABLE,
  };
}

function requireNonEmpty(value: string, field: string): void {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error(`integration-api: ${field} must be a non-empty string`);
  }
}

function requirePrNumber(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error('integration-api: prNumber must be a positive integer');
  }
}
