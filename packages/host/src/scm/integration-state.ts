/**
 * integration-state.ts — the Integration state union from plan 621 §4.4.
 *
 * `Integration` is an external projection: GitHub is the authority and Duya
 * only ever stores `observed_*` facts. The union is a closed set on purpose,
 * and `unknown` is a legal terminal value (observation failed); folding it
 * into `open` would turn "we could not ask GitHub" into "nothing is wrong".
 *
 * OWNERSHIP: the wire contract (`HostIntegrationApiV1`) belongs to slice B and
 * lands as `HostIntegrationState` in `@duya/agent-protocol`. Until that file
 * exists, this module is the single definition inside Host — do not redeclare
 * the union next to a consumer. When B merges, delete this file, import the
 * protocol type in `observe.ts`, and re-export it from `scm/index.ts`; the
 * member list must stay identical to §4.4.
 */
export type HostIntegrationState =
  | 'none'
  | 'draft'
  | 'open'
  | 'checks_failing'
  | 'checks_passing'
  | 'review_requested'
  | 'changes_requested'
  | 'approved'
  | 'merged'
  | 'closed_unmerged'
  | 'unknown';
