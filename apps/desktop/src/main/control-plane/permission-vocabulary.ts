/**
 * permission-vocabulary.ts — the ONE place a permission answer is named.
 *
 * ## Why this file exists
 *
 * Three vocabularies answer the same question, and until now nothing related
 * them:
 *
 *   surface         verbs                                    who speaks it
 *   ─────────────── ───────────────────────────────────────  ─────────────────
 *   worker_http     allow | allow_once | allow_for_session  | deny
 *   bot_card        allow | always | deny                   db-handlers.ts:1818
 *   internal        allow | deny | paused                   ToolUseContext.requestPermission
 *   protocol        allow | allow_always | deny | defer     agent-protocol/permission.ts:59
 *
 * The protocol one is the canonical set and the other three are legacy. What
 * was missing is not the mapping — `LEGACY_ACTION_MAP` in the protocol package
 * has had one since it was written — it is that **nothing ever called it**, so
 * the mapping was documentation with a type on it. This module is that
 * function, wired, and it is where the two are argued about.
 *
 * ## The rules this module enforces
 *
 *  1. **Unknown fails closed.** An unrecognised verb is `deny`, never
 *     `allow`. `translate()` returns `null` for "I do not know this" and the
 *     CALLER decides; a helper that silently invented an allow would put the
 *     default in the one place nobody reviews.
 *  2. **`defer` is not authorisation.** It resolves nothing, grants nothing,
 *     and records no decision. The legacy `paused` verb is `defer` — it means
 *     "the request was persisted and the turn stopped", which is NOT the same
 *     fact as "the user denied it". `LEGACY_ACTION_MAP` maps `paused → deny`
 *     and is wrong for exactly that reason: the bot approval card can be
 *     answered an hour later, and recording a denial nobody made poisons the
 *     audit with a decision that never happened.
 *  3. **No silent translation.** Every mapping is a named table row with a
 *     declared scope, and `SURFACES` lists which surface is which. A consumer
 *     that reaches for `translate()` without naming its surface is using the
 *     wrong table.
 */

import {
  isPermissionAction,
  type PermissionAction,
  type PermissionScope,
} from '@duya/agent-protocol';

/**
 * Which legacy vocabulary a verb came from.
 *
 * Named per surface rather than per value because the same verb can mean
 * different things on two surfaces — `always` exists only on `bot_card`, and
 * `allow_for_session` only on `worker_http` — and a single flat union would let
 * a caller pass a bot verb to the worker path's table and get a confident
 * answer computed from the wrong row.
 */
export type PermissionSurface = 'worker_http' | 'bot_card' | 'internal';

/** What a verb turns into, and what it is allowed to do. */
export interface TranslatedDecision {
  readonly action: PermissionAction;
  /**
   * The subject of a lasting grant, when the action carries one.
   *
   * `null` for one-shot answers, for denials, and for `defer`.
   */
  readonly scope: PermissionScope | null;
  /**
   * True when this action must survive the request it was asked about.
   *
   * Only `allow_always`. A caller persisting a grant uses this rather than
   * `action === 'allow_always'` so that adding a fifth action cannot quietly
   * turn into a new grant.
   */
  readonly grants: boolean;
}

interface SurfaceRow {
  readonly surface: PermissionSurface;
  /** Where this table's verbs come from, as a file:line the reader can check. */
  readonly origin: string;
  readonly entries: Readonly<Record<string, TranslatedDecision>>;
}

/** `allow` for the one request that asked. Not a grant. */
const ONE_SHOT_ALLOW: TranslatedDecision = { action: 'allow', scope: null, grants: false };
/** A refusal. Never a grant, and never deferred. */
const DENY: TranslatedDecision = { action: 'deny', scope: null, grants: false };
/**
 * Not a decision.
 *
 * The request stays open, no promise resolves, and no durable row is written.
 * It is here so that "the host has not answered" is a representable value
 * rather than something a caller has to fake with `deny`.
 */
const DEFER: TranslatedDecision = { action: 'defer', scope: null, grants: false };

/**
 * A lasting grant over ONE tool, in the session the request belongs to.
 *
 * Both halves are load-bearing and neither is derivable from the other:
 * `kind: 'tool'` says WHICH tool, and the session is the lifetime the durable
 * row records in its own `(scope_type, scope_id)` columns.
 *
 * `PermissionScope`'s `{ kind: 'session' }` alternative is deliberately NOT
 * used here. The durable table's primary key is
 * `(scope_type, scope_id, tool_name)`: a scope of `session` with no tool would
 * have to mean "allow every tool in this session", which is strictly more than
 * the user answered when they clicked "always allow" on one prompt. A grant
 * wider than the question is how a one-tool consent becomes standing write
 * access.
 */
function toolGrant(toolName: string): { action: 'allow_always'; scope: ToolGrantScope; grants: true } {
  return { action: 'allow_always', scope: { kind: 'tool', toolName }, grants: true };
}

/**
 * A grant whose subject is not known yet.
 *
 * `allow_for_session` and `always` name a lifetime but not a tool, and the
 * caller that owns the request is the only thing that knows which tool was
 * asked about. Rather than bake a guess into the table, the row is a marker
 * and {@link bindGrantScope} completes it with the real tool name.
 */
const DEFER_PENDING_TOOL: TranslatedDecision = {
  action: 'allow_always',
  scope: null,
  grants: true,
};

/** A lasting grant whose tool the caller must supply before it can be applied. */
export const GRANT_PENDING_TOOL: TranslatedDecision = DEFER_PENDING_TOOL;

/**
 * The legacy tables, kept apart on purpose.
 *
 * A single merged `Record<string, TranslatedDecision>` would be smaller and
 * wrong: it would make `always` and `allow_for_session` interchangeable, and
 * they are not — they are the two surfaces' names for the same grant, arriving
 * from two callers with two different trust stories.
 */
const SURFACES: Readonly<Record<PermissionSurface, SurfaceRow>> = {
  worker_http: {
    surface: 'worker_http',
    origin: 'agents/server/router.ts handlePostPermission validDecisions',
    entries: {
      // `allow_once` restates `allow`; both are scoped to the one request.
      allow: ONE_SHOT_ALLOW,
      allow_once: ONE_SHOT_ALLOW,
      // Named for a SESSION, granted over a TOOL. See `toolGrant`.
      allow_for_session: DEFER_PENDING_TOOL,
      deny: DENY,
      // Reachable as of R2.4: a host may answer "not yet". It authorises
      // nothing and closes nothing.
      defer: DEFER,
    },
  },
  bot_card: {
    surface: 'bot_card',
    origin: 'ipc/db-handlers.ts db:toolApproval:resolve',
    entries: {
      allow: ONE_SHOT_ALLOW,
      // `always` is the same grant under the bot card's own name. The durable
      // row it writes (`tool_approval_rules`) is what actually backs it.
      always: DEFER_PENDING_TOOL,
      deny: DENY,
    },
  },
  internal: {
    surface: 'internal',
    origin: 'ToolUseContext.requestPermission return value',
    entries: {
      allow: ONE_SHOT_ALLOW,
      deny: DENY,
      // `paused` is the bot/wake path: the card was persisted and the turn
      // stopped WITHOUT an answer. It is NOT a denial — see rule 2 above.
      paused: DEFER,
    },
  },
};

/**
 * Translate a legacy verb into the protocol vocabulary.
 *
 * @param surface - Which table the verb came from. Required: the same string
 *   means different things on different surfaces, so guessing is how a bot
 *   verb ends up executed by the worker path.
 * @param decision - The verb, from an untrusted wire frame.
 * @returns The translated decision, or `null` when the verb is not one this
 *   surface defines. `null` means "unknown" and the CALLER must fail closed —
 *   this function never guesses.
 */
export function translate(
  surface: PermissionSurface,
  decision: string,
): TranslatedDecision | null {
  const row = SURFACES[surface].entries[decision];
  return row ?? null;
}

/** A lasting grant over exactly one tool. */
export interface ToolGrantScope {
  readonly kind: 'tool';
  readonly toolName: string;
}

/**
 * Complete a pending grant with the tool it is about.
 *
 * The only two `allow_always` rows are {@link GRANT_PENDING_TOOL} markers,
 * because the verb alone does not say which tool the user consented to. A
 * caller that reaches a `grants: true` row with `scope: null` MUST pass the
 * tool name it asked about; passing a different one is how a consent for
 * `Read` becomes a grant for `Write`.
 *
 * @param translated - A decision from {@link translate}.
 * @param toolName - The tool the request was actually about.
 * @returns The decision carrying a concrete, tool-scoped grant, or `null` when
 *   `translated` is not a grant awaiting one (a one-shot answer, a denial, or
 *   `defer`). A tool grant is a distinct type rather than a narrowed
 *   `PermissionScope` so a caller cannot persist a `session` scope by
 *   accident when it meant a tool.
 */
export function bindGrantScope(
  translated: TranslatedDecision,
  toolName: string,
): { readonly action: 'allow_always'; readonly scope: ToolGrantScope; readonly grants: true } | null {
  if (translated.scope !== null || !translated.grants) return null;
  if (toolName === '') return null;
  return { action: 'allow_always', scope: { kind: 'tool', toolName }, grants: true };
}

/** Every verb a surface accepts, for error messages and for the wire whitelist. */
export function acceptedVerbs(surface: PermissionSurface): readonly string[] {
  return Object.keys(SURFACES[surface].entries);
}

/**
 * Narrow a string to the canonical protocol action, without the table.
 *
 * For a frame that is ALREADY protocol-shaped (the runtime's own control
 * surface) rather than a legacy verb. Rejects `paused` and
 * `allow_for_session`: those are surface names, not actions, and accepting
 * them here would re-introduce the second vocabulary at the boundary it was
 * supposed to leave behind.
 */
export function asProtocolAction(value: string): PermissionAction | null {
  return isPermissionAction(value) ? value : null;
}

/** The declared origin of each table, for the drift test and for review. */
export function surfaceOrigins(): Readonly<Record<PermissionSurface, string>> {
  return {
    worker_http: SURFACES.worker_http.origin,
    bot_card: SURFACES.bot_card.origin,
    internal: SURFACES.internal.origin,
  };
}
