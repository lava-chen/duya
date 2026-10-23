/**
 * packages/cli/src/tui/slash/checkout.ts
 *
 * `/checkout` — the checkout this session sits in, as the Host observes it
 * (plan 621 §4.4).
 *
 * ## This command observes; it never acts
 *
 * Everything here is a point-in-time read the Host recomputes from git and
 * from the checkout's owner file. The `reclaimable` verdict the Host reports
 * is an OBSERVATION, not a permission: the Host re-evaluates every §4.5
 * condition at the moment a removal is requested, so a client that cached
 * `reclaimable: true` and acted on it would be acting on a snapshot. This
 * command therefore offers no delete action at all — there is no code path
 * here that could remove a directory.
 *
 * ## "No namespace" and "no checkout" are different answers
 *
 * A Host composed without a checkout provider answers 404
 * `checkout_api_unavailable`. That is not "this session has no checkout" —
 * it is "this Host cannot answer the question". The two are rendered
 * differently, because a panel that said "no checkout" for a Host that simply
 * does not serve the namespace would be reporting a fact it never observed.
 *
 * ## Every value is labelled with when it was observed
 *
 * The Host stamps each observation with `observedAt`. Printing the values
 * without that stamp would present a re-computable reading as a persistent
 * fact, which is exactly the distinction §4.3 draws.
 */

import type { HostCheckoutObserved, HostSessionCheckoutView } from '@duya/agent-protocol';
import type { TuiSlashCommandDef, TuiSlashContext } from './types.js';
import { describeError, hostErrorCode, showPanel } from './shared.js';

const FOOTER = '↑↓ / PgUp / PgDn scroll · Esc close';

/**
 * Who owns the checkout, in the four states the contract distinguishes.
 *
 * "Nobody owns it" and "the owner file could not be read" are different
 * answers: treating an unreadable owner as "unowned" would invite a second
 * session to write in a checkout that may be in active use.
 */
function ownerLine(view: HostSessionCheckoutView, observed: HostCheckoutObserved): string {
  if (observed.ownerUnreadable) return 'unreadable (the owner file exists but could not be read)';
  if (observed.ownerSessionId === null) return 'none';
  if (view.isOwner) return `this session (${observed.ownerSessionId})`;
  return `another session (${observed.ownerSessionId})`;
}

/**
 * The reclaim verdict, always labelled as an observation.
 *
 * `retainReason` is the first condition that refused the reclaim; when the
 * Host reports a refusal without naming one, the panel says `unknown` rather
 * than inventing a reason.
 */
function reclaimLine(observed: HostCheckoutObserved): string {
  if (observed.reclaimable) {
    return 'reclaimable (observation only — the Host re-checks when a removal is requested)';
  }
  return `retained: ${observed.retainReason ?? 'unknown'}`;
}

function observedAtLine(millis: number): string {
  return `as of ${new Date(millis).toLocaleString()}`;
}

function checkoutLines(view: HostSessionCheckoutView): string[] {
  const observed = view.checkout;
  if (observed === null) {
    return [
      '  This session is not inside a checkout.',
      '',
      '  Source: Host checkout observation (GET /v1/checkouts).',
    ];
  }
  return [
    `  root        ${observed.root}`,
    `  cwd         ${observed.cwd}`,
    `  registered  ${observed.registered ? 'yes' : 'no'}`,
    `  worktree    ${observed.worktree}`,
    `  owner       ${ownerLine(view, observed)}`,
    `  locked      ${observed.locked ? 'yes' : 'no'}`,
    `  reclaim     ${reclaimLine(observed)}`,
    `  observed    ${observedAtLine(observed.observedAt)}`,
    '',
    '  Source: Host checkout observation (GET /v1/checkouts), recomputed from git on every read.',
    '  This command observes only. Removing a checkout is a separate, Host-judged action.',
  ];
}

const CHECKOUT_COMMAND: TuiSlashCommandDef = {
  name: 'checkout',
  description: 'Show the checkout this session sits in',
  group: 'Session info',
  async run(ctx: TuiSlashContext) {
    try {
      const view = await ctx.client.observeCheckoutForSession(ctx.session.id);
      showPanel(ctx, 'Checkout', checkoutLines(view), { footer: FOOTER, scrollable: true });
    } catch (error) {
      // A Host without a checkout provider is not a session without a
      // checkout. Say which one it is.
      if (hostErrorCode(error) === 'checkout_api_unavailable') {
        showPanel(ctx, 'Checkout', [
          'This Host does not serve the checkout namespace, so it cannot answer.',
          '',
          '  That is different from "this session has no checkout" — here the',
          '  question was never asked of an authority that could answer it.',
          '',
          '  Source: Host checkout observation (GET /v1/checkouts), 404 checkout_api_unavailable.',
        ], { footer: FOOTER, scrollable: true });
        return { kind: 'handled' };
      }
      showPanel(ctx, 'Checkout', [
        'Could not read the checkout observation.',
        '',
        describeError(error),
        '',
        '  Source: Host checkout observation (GET /v1/checkouts).',
      ], { footer: FOOTER, scrollable: true });
    }
    return { kind: 'handled' };
  },
};

export const CHECKOUT_COMMANDS: readonly TuiSlashCommandDef[] = [CHECKOUT_COMMAND];
