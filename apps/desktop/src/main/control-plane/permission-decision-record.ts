/**
 * permission-decision-record.ts — the router's half of the durable decision
 * (plan 587 R2.4).
 *
 * ## Why this is not the router
 *
 * It is a decision about what was DECIDED, and it belongs to the Control Plane.
 * The router is a 3,900-line transport file that deep-imports the agent
 * package, so anything living there is untestable in isolation: importing
 * `router.ts` under vitest drags that whole graph in. Splitting the decision
 * out also means the router keeps exactly one job -- forward -- and cannot grow
 * a second opinion about whether an answer was already given.
 *
 * ## What was wrong
 *
 * `handlePostPermission` whitelisted the verb, forwarded the command to the
 * worker, and answered `{ ok: true }`. For EVERY POST. So a double-click, an
 * SSE reconnect, and a stale renderer all produced the same indistinguishable
 * success, nothing recorded that anyone had decided anything, and the host had
 * no way to learn its answer was late.
 *
 * The worker had a guard (it logged a missing entry and dropped it) and the bot
 * approval card had a real CAS. The router had neither, and the router is where
 * an answer actually enters the system.
 *
 * ## The ordering
 *
 * Record, then deliver. A decision the worker acts on but the store never
 * learned about leaves an audit that claims a question was answered when
 * nothing was recorded -- worse than the answer having been lost.
 */

import { translate, type PermissionSurface } from './permission-vocabulary.js';

/** The bridge call this function makes. The only host capability it needs. */
export type DecisionBridge = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<unknown>;

export type RecordOutcome =
  /** This call is the one that decided it. Deliver. */
  | { readonly status: 'recorded'; readonly recordedDecision: string }
  /** A decision was already on record. Do NOT deliver again. */
  | { readonly status: 'duplicate'; readonly recordedDecision: string | null }
  /**
   * Nothing was recorded.
   *
   * NOT a reason to drop the answer: a tool call waiting on a decision that
   * never arrives is denied by a deadline rather than by a person, which is a
   * worse outcome than a missing audit row. The caller delivers and says the
   * decision was not recorded.
   */
  | { readonly status: 'refused'; readonly reason: string };

/**
 * The action the DURABLE store accepts, per canonical action.
 *
 * The store's vocabulary is the bot card's (`allow` / `always` / `deny`),
 * because that is what the column's CHECK constraint has always allowed. This
 * table is the one place the two are related, it is total, and the `defer` case
 * is unreachable-by-construction here: a defer is not a decision and
 * `recordPermissionDecision` refuses it before it gets this far.
 */
const STORE_DECISION: Readonly<Record<string, 'allow' | 'always' | 'deny'>> = {
  allow: 'allow',
  allow_always: 'always',
  deny: 'deny',
};

/**
 * Record an answer durably, and say which of the three things happened.
 *
 * @param surface - Which legacy vocabulary `decision` came from. The router
 *   passes `'worker_http'`; the bot card path passes `'bot_card'`. Getting this
 *   wrong is how a bot verb starts being executed by the worker path.
 */
export async function recordPermissionDecision(
  dbRequest: DecisionBridge,
  input: {
    readonly surface: PermissionSurface;
    readonly requestId: string;
    readonly sessionId: string;
    readonly decision: string;
  },
): Promise<RecordOutcome> {
  const translated = translate(input.surface, input.decision);
  if (translated === null) {
    // Unknown fails closed. The worker is told a deny, never the raw verb.
    return { status: 'refused', reason: `unknown decision "${input.decision}"` };
  }
  if (translated.action === 'defer') {
    // Nothing to record and nothing to deliver. This is what makes `defer`
    // reachable: the caller answers 200 with a receipt and moves on.
    return { status: 'refused', reason: 'deferred' };
  }

  const storeDecision = STORE_DECISION[translated.action];
  if (storeDecision === undefined) {
    // Unreachable while the table above is total; kept because a widened
    // `PermissionAction` that nobody mapped must fail closed, not slip through
    // as an undefined column value.
    return { status: 'refused', reason: `unmapped action "${translated.action}"` };
  }

  try {
    const result = (await dbRequest('toolApproval:resolve', {
      id: input.requestId,
      decision: storeDecision,
      sessionId: input.sessionId,
    })) as
      | { ok?: boolean; claimed?: boolean; error?: string; row?: { decision?: string | null } }
      | undefined;

    if (result?.ok !== true) {
      return { status: 'refused', reason: result?.error ?? 'no_durable_row' };
    }
    if (result.claimed === true) {
      return { status: 'recorded', recordedDecision: storeDecision };
    }
    // A later answer. The record that is already there is the receipt of
    // record, so it is what the host is told -- a duplicate that contradicts
    // it must not be able to report itself as the decision.
    return { status: 'duplicate', recordedDecision: result.row?.decision ?? null };
  } catch (error) {
    return { status: 'refused', reason: error instanceof Error ? error.message : String(error) };
  }
}
